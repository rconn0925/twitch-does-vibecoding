import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import express from "express";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  listAuditRecords,
  recordHalt,
  recordReviewResolution,
  recordVeto,
} from "../audit/record.js";
import { submitCandidate } from "../pipeline/submit.js";
import type { CandidatePool } from "../queue/pool.js";
import type { TaskQueue } from "../queue/task-queue.js";
import { ROUND_CLOSED, ROUND_OPENED, STATE_CHANGED, VOTE_RECORDED } from "../shared/events.js";
import type {
  GateResult,
  RoundSnapshot,
  StateSnapshot,
  SuggestionCandidate,
} from "../shared/types.js";
import { recover, triggerHalt } from "../state-machine/halt.js";
import {
  approve,
  getReview,
  listPending,
  type ReviewItem,
  reject,
} from "../state-machine/review-queue.js";
import { type RoundManager, RoundStartError } from "../state-machine/round.js";
import { InvalidTransitionError, type StreamModeMachine } from "../state-machine/stream-mode.js";

export interface ConsoleServerDeps {
  machine: StreamModeMachine;
  db: Database.Database;
  port: number;
  pool: CandidatePool;
  taskQueue: TaskQueue;
  /** Voting-round lifecycle — POST /api/round/start is its only console-side caller (D2-01). */
  round: RoundManager;
  /** The compliance gate, pre-bound with its own deps (COMP-01 single funnel). */
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
  /**
   * Best-effort abort of in-flight work, invoked by triggerHalt AFTER the
   * HALTED transition has taken effect (WR-02): the console Halt button must
   * be a full kill path symmetric with the hotkey — both force-kill
   * registered agent process trees, not just flip state.
   */
  abortActiveWork?: (frozen: StateSnapshot) => Promise<void>;
  logger?: Logger;
}

export interface ConsoleServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** The full console state pushed over ws and returned by GET /api/state. */
export interface ConsoleState extends StateSnapshot {
  pool: ReturnType<CandidatePool["list"]>;
  queue: SuggestionCandidate[];
  pendingReviewCount: number;
  review: ReviewItem[];
  /** Current voting round, or null when none is open (plan 02-03). */
  round: RoundSnapshot | null;
}

// zod v4 validation at every untrusted boundary (ASVS V5): terse 400s, never stack traces.
const ReasonTagSchema = z.enum(["tos-risk", "boring", "too-big", "gut-feeling", "other"]);

const HaltBodySchema = z.object({ reasonTag: ReasonTagSchema.optional() }).strict();

const ResolveBodySchema = z.object({ reasonTag: ReasonTagSchema.optional() }).strict();

const RecoverBodySchema = z
  .object({
    action: z.enum(["resume", "discard-and-resume", "reset-to-idle"]),
    reasonTag: ReasonTagSchema.optional(),
  })
  .strict();

const ReviewIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const TaskIdParamsSchema = z.object({ id: z.string().min(1).max(200) });

// Round start carries no parameters — a strict empty object rejects smuggled keys.
const RoundStartBodySchema = z.object({}).strict();

const DevSubmitBodySchema = z
  .object({
    username: z.string().min(1).max(100),
    text: z.string().min(1).max(2000),
    kind: z.enum(["suggestion", "project-switch"]).optional(),
  })
  .strict();

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().min(1).max(64).optional(),
  decision: z.string().min(1).max(64).optional(),
});

/**
 * Localhost-only operator console: static UI + JSON API + ws state push.
 *
 * The explicit "127.0.0.1" listen host is this surface's ONLY access control
 * (T-01-01) — no auth exists here, so binding to 0.0.0.0 would hand the
 * kill switch to the network. Never change the host argument.
 */
export function startConsoleServer(deps: ConsoleServerDeps): Promise<ConsoleServerHandle> {
  const { machine, db, pool, taskQueue, logger } = deps;
  const app = express();

  // ── CSRF defense (CR-01) ────────────────────────────────────────────
  // Binding to 127.0.0.1 does NOT stop a malicious page in the streamer's
  // browser: it runs on the same host, and cross-origin "simple" requests
  // (auto-submitting HTML forms, text/plain fetch bodies) are sent WITHOUT
  // a CORS preflight. Two independent checks guard every state-changing
  // request, uniformly across ALL routes — never rely on a body "happening
  // to be required" as CSRF protection:
  //
  //  1. Origin/Host agreement: browsers attach Origin to every cross-origin
  //     request and to all non-GET requests. A present Origin must exactly
  //     match this server's own origin (derived from the Host header).
  //     Same-origin console fetches always pass; any other page is refused
  //     before a handler runs.
  //  2. Content-Type must be application/json: a JSON-typed POST is never a
  //     "simple" request, so a cross-origin attempt is preflighted — and
  //     this server never answers CORS preflights, so the browser refuses
  //     to send it. This also closes the empty-body loophole: a text/plain
  //     body that express.json() ignored used to reach HaltBodySchema as
  //     `{}` and validate.
  //
  // Non-browser clients (curl, Node fetch, the e2e suite) send no Origin
  // and already set Content-Type: application/json — both checks pass.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const origin = req.get("origin");
    const host = req.get("host");
    if (origin !== undefined && (host === undefined || origin !== `http://${host}`)) {
      res.status(403).json({ error: "cross-origin request refused" });
      return;
    }
    if (!req.is("application/json")) {
      res.status(403).json({ error: "state-changing requests must be application/json" });
      return;
    }
    next();
  });

  app.use(express.json());

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir));

  /** Compose the extended console state: machine snapshot + pool + queue + review. */
  function buildState(): ConsoleState {
    const review = listPending(db);
    return {
      ...machine.snapshot(),
      pool: pool.list(),
      queue: taskQueue.list(),
      pendingReviewCount: review.length,
      review,
      round: deps.round.snapshot(),
    };
  }

  const server = createServer(app);

  // Full-state-on-connect, then push on every change (OBS overlay pattern from CLAUDE.md).
  //
  // WR-01: cross-origin WebSocket handshakes are NOT subject to CORS and need
  // no preflight, so without this check any page in the streamer's browser
  // could read the full console state — including attacker-authored
  // suggestion text, usernames, and review rationales. Browsers always send
  // Origin on a ws handshake: a present-but-foreign Origin is dropped at
  // upgrade time (401). Non-browser clients (no Origin header) are allowed —
  // they sit outside the in-browser exfiltration threat model that loopback
  // binding cannot stop.
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
      info.origin === undefined || info.origin === `http://${info.req.headers.host}`,
  });

  function pushState(): void {
    const payload = JSON.stringify(buildState());
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(buildState()));
  });
  machine.on(STATE_CHANGED, () => {
    pushState();
  });
  // Round lifecycle pushes stay synchronous per-event: this is an
  // operator-frequency surface, not the overlay — the 300ms vote-tally
  // debounce is the overlay's concern (plan 02-05).
  for (const roundEvent of [ROUND_OPENED, ROUND_CLOSED, VOTE_RECORDED]) {
    deps.round.on(roundEvent, () => {
      pushState();
    });
  }

  /**
   * Wrap the gate so a ws snapshot lands AFTER background routing settles:
   * submit.ts routes in a microtask right after classify resolves; the
   * macrotask timer below runs after that, so the pushed state already
   * reflects the pool/review_queue write (D-10 async-on-submission).
   */
  const classifyThenPush = async (candidate: SuggestionCandidate): Promise<GateResult> => {
    try {
      return await deps.classify(candidate);
    } finally {
      setTimeout(pushState, 0);
    }
  };

  app.get("/api/state", (_req, res) => {
    res.json(buildState());
  });

  app.post("/api/halt", (req, res) => {
    const parsed = HaltBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid halt request body" });
      return;
    }
    const reasonTag = parsed.data.reasonTag ?? null;

    if (machine.mode === "HALTED") {
      // Already halted: the D-18 reason-tag follow-up lands here. Record the tag
      // as its own append-only row but do NOT re-force the transition — that
      // would overwrite the frozen pre-halt snapshot the D-04 triage view needs.
      recordHalt(db, { source: "console", priorMode: "HALTED", reasonTag });
      const frozen: StateSnapshot = machine.snapshot().haltContext?.frozen ?? machine.snapshot();
      res.json(frozen);
      return;
    }

    // WR-02: identical HaltDeps to the hotkey path — the console halt must
    // also abort registered in-flight work, not only flip the state machine.
    const frozen = triggerHalt(
      machine,
      {
        db,
        ...(logger ? { logger } : {}),
        ...(deps.abortActiveWork ? { abortActiveWork: deps.abortActiveWork } : {}),
      },
      "console",
      reasonTag,
    );
    res.json(frozen);
  });

  // D2-01 streamer-triggered rounds: the console Start Round button is the
  // ONLY round-open path. Preconditions (IDLE + pool >= 2) live in
  // RoundManager.startRound(); RoundStartError maps to a terse 409 with a
  // machine-readable reason — never a stack trace (T-01-03 discipline).
  app.post("/api/round/start", (req, res) => {
    const parsed = RoundStartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid round start request body" });
      return;
    }
    try {
      const snap = deps.round.startRound();
      pushState();
      res.json(snap);
    } catch (err) {
      if (err instanceof RoundStartError) {
        res.status(409).json({ error: err.message, reason: err.reason });
        return;
      }
      throw err;
    }
  });

  // D-04 triage-then-choose: exactly three recovery actions, streamer-picked.
  app.post("/api/recover", (req, res) => {
    const parsed = RecoverBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid recovery action" });
      return;
    }
    if (machine.mode !== "HALTED") {
      res.status(409).json({ error: "not halted — nothing to recover from" });
      return;
    }
    try {
      recover(
        machine,
        { db, ...(logger ? { logger } : {}) },
        parsed.data.action,
        parsed.data.reasonTag ?? null,
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Message wording feeds the UI-SPEC "Can't transition to X from Y" copy.
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json(buildState());
  });

  // Needs Review (D-05): pending escalations, oldest first.
  app.get("/api/review", (_req, res) => {
    res.json(listPending(db));
  });

  app.post("/api/review/:id/approve", (req, res) => {
    const params = ReviewIdParamsSchema.safeParse(req.params);
    const body = ResolveBodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "invalid review approval request" });
      return;
    }
    try {
      // D-06: approval re-enters the ORIGINAL candidate into the pool.
      approve(db, { pool, streamMode: machine.mode }, params.data.id);
    } catch {
      const row = getReview(db, params.data.id);
      res.status(row ? 409 : 404).json({ error: "review item is not pending" });
      return;
    }
    pushState();
    res.json({ ok: true });
  });

  app.post("/api/review/:id/reject", (req, res) => {
    const params = ReviewIdParamsSchema.safeParse(req.params);
    const body = ResolveBodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "invalid review rejection request" });
      return;
    }
    const reasonTag = body.data.reasonTag ?? null;
    try {
      reject(db, params.data.id, machine.mode, reasonTag);
    } catch {
      // D-18 follow-up path: the reject already took effect on the first click;
      // a second POST carrying only the tag appends a tag row instead of failing.
      const row = getReview(db, params.data.id);
      if (row && row.status !== "pending" && reasonTag) {
        recordReviewResolution(db, {
          reviewId: row.id,
          resolution: row.status === "approved" ? "approved" : "rejected",
          suggestionText: row.text,
          twitchUsername: row.twitchUsername,
          streamMode: machine.mode,
          reasonTag,
        });
        res.json({ ok: true, tagged: true });
        return;
      }
      res.status(row ? 409 : 404).json({ error: "review item is not pending" });
      return;
    }
    pushState();
    res.json({ ok: true });
  });

  // Per-task veto (D-18, COMP-04/COMP-05): removes the task and records the
  // triggering input. A follow-up POST with only a reasonTag (task already
  // gone) appends the optional tag row — tagging never blocks, never 404s.
  app.post("/api/tasks/:id/veto", (req, res) => {
    const params = TaskIdParamsSchema.safeParse(req.params);
    const body = ResolveBodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: "invalid veto request" });
      return;
    }
    const reasonTag = body.data.reasonTag ?? null;
    const removed = taskQueue.remove(params.data.id);
    if (removed) {
      recordVeto(db, {
        taskId: removed.id,
        suggestionText: removed.text,
        twitchUsername: removed.twitchUsername,
        reasonTag,
        streamMode: machine.mode,
      });
      pushState();
      res.json({ removed: true });
      return;
    }
    if (reasonTag) {
      recordVeto(db, {
        taskId: params.data.id,
        suggestionText: null,
        twitchUsername: null,
        reasonTag,
        streamMode: machine.mode,
      });
      res.json({ removed: false, tagged: true });
      return;
    }
    res.status(404).json({ error: "task not found" });
  });

  // Dev-only submission form backend: drives the full live slice (type text →
  // gate classifies → pool / review / rejected-with-audit) before Phase 2
  // ingestion exists. This route is the PATTERN Phase 2 chat ingestion
  // replaces: build a SuggestionCandidate, call submitCandidate — NEVER the
  // task queue directly (COMP-01; T-01-18).
  app.post("/api/dev/submit", (req, res) => {
    const parsed = DevSubmitBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid submission" });
      return;
    }
    const candidate: SuggestionCandidate = {
      id: randomUUID(),
      source: "operator",
      kind: parsed.data.kind ?? "suggestion",
      twitchUsername: parsed.data.username,
      text: parsed.data.text,
      submittedAtMs: Date.now(),
    };
    const result = submitCandidate(
      {
        db,
        mode: () => machine.mode,
        pool,
        classify: classifyThenPush,
        ...(logger ? { logger } : {}),
      },
      candidate,
    );
    if (!result.accepted) {
      // D-02 surfaced over HTTP: intake is refused while HALTED (audit row
      // already written by submitCandidate).
      res.status(409).json({ reason: result.reason });
      return;
    }
    res.status(202).json({ id: result.id });
  });

  // Audit page (COMP-05): every filter decision and veto with the triggering
  // input, filterable by event type and decision.
  app.get("/api/audit", (req, res) => {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid audit query" });
      return;
    }
    res.json(
      listAuditRecords(db, {
        limit: parsed.data.limit,
        ...(parsed.data.eventType !== undefined ? { eventType: parsed.data.eventType } : {}),
        ...(parsed.data.decision !== undefined ? { decision: parsed.data.decision } : {}),
      }),
    );
  });

  // Terse error boundary: invalid JSON bodies and unexpected errors must never
  // leak a stack trace to the response (T-01-03).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status: unknown }).status) || 500
          : 500;
      logger?.error({ err }, "console request failed");
      res.status(status >= 400 && status < 500 ? 400 : 500).json({ error: "request failed" });
    },
  );

  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
