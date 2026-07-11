import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import {
  AUTO_CYCLE_CHANGED,
  POOL_CHANGED,
  ROUND_CLOSED,
  ROUND_OPENED,
  STATE_CHANGED,
  VOTE_RECORDED,
  WINDOW_CLOSED,
  WINDOW_OPENED,
  WINDOW_REVOKED,
} from "../shared/events.js";
import { isLoopbackHostHeader, isLoopbackOrigin } from "../shared/loopback.js";
import type { BuildStatusView, RoundSnapshot, StreamMode } from "../shared/types.js";

/**
 * Emitted by the OverlayBuildSource whenever the pipeline stage advances
 * (researching → planning → building → done/failed/refused). Stage transitions
 * are low-frequency show beats — a handful per build — so they push IMMEDIATELY
 * like the round lifecycle events, never through the vote-tally debounce
 * (UI-SPEC §Motion & update cadence). Declared here rather than in
 * shared/events.ts so this plan stays inside its own file boundary; the
 * orchestrator (03-06) imports the constant from the overlay contract.
 */
export const BUILD_STAGE_CHANGED = "build:stage-changed" as const;

/**
 * Public OBS overlay server (PRES-01) — a PHYSICALLY separate localhost
 * surface from the operator console (D2-17). Read-only by construction: the
 * only routes that exist are express.static and GET /api/state. There is no
 * express.json(), no POST/PUT/DELETE/PATCH handler of any kind — a mutation
 * route that doesn't exist is the strongest possible control (T-02-20).
 *
 * Push cadence (T-02-22, UI-SPEC motion contract):
 *  - lifecycle events (STATE_CHANGED, ROUND_OPENED, ROUND_CLOSED) push
 *    immediately — they're low-frequency show beats;
 *  - VOTE_RECORDED is debounced at 300ms so a vote flood never flickers the
 *    OBS CEF render. The debounce lives HERE, on the push side — RoundManager
 *    just emits (02-RESEARCH.md Pitfall 3).
 *
 * Every push is the FULL state (full-state-on-connect + full-state diffs):
 * the payload is small, and full snapshots keep the client trivial and
 * OBS-scene-switch-reload safe (D2-18, CLAUDE.md overlay pattern).
 */

/**
 * Public pill vocabulary — the ONLY state words that ever reach the stream
 * (D2-18). Phase 4 performs the one deliberate, final vocabulary extension
 * (04-UI-SPEC §Overlay state model): the set becomes exactly SIX words with
 * the addition of "FREE REIGN" (paid/redemption control window) and "CHAOS"
 * (random-pick mode). No further word may be added without a UI-SPEC amendment.
 */
export type OverlayPill =
  | "STANDBY"
  | "VOTING OPEN"
  | "BUILDING"
  | "ON HOLD"
  | "FREE REIGN"
  | "CHAOS";

/** The full overlay state, pushed on connect and on every change. */
export interface OverlayState {
  pill: OverlayPill;
  round: RoundSnapshot | null;
  /** First 3 queued task texts, untruncated — the client truncates (UI-SPEC). */
  nextUp: string[];
  /**
   * The live build's status (PRES-02/04), or null when no build is active.
   * The pill stays "BUILDING" across the whole pipeline (PILL_BY_MODE
   * unchanged); this field carries the fine-grained researching→planning→build
   * →done/failed/refused stage the overlay stepper renders. `title` is the one
   * chat-derived string on the build panel — rendered textContent-only, 80-char
   * truncated client-side (T-03-15).
   */
  buildStatus: BuildStatusView | null;
  /**
   * The COARSE public projection of an active paid/redemption control window
   * (PAID-01/02, D-11), or null when no window is active. This is the ENTIRE
   * broadcast surface for a window — donor display name + absolute deadline,
   * and NOTHING else. No amount, currency, message text, or trigger type ever
   * crosses onto the public wire (T-04-13 Information-Disclosure mitigation,
   * 04-UI-SPEC narrow-public-projection). The amount→duration mapping is the
   * console's and audit ledger's job; the overlay stays deliberately coarse.
   *
   * The donor display name is attacker-controlled (StreamElements displayName /
   * EventSub user_name) — rendered textContent-only, 24-char truncated
   * client-side (T-04-12). The client computes the countdown from `endsAtMs`
   * on its 1s tick (the server never streams timer frames).
   */
  controlWindow: { donorDisplayName: string; endsAtMs: number } | null;
  /**
   * The auto-cycle suggestion-phase guidance countdown source (quick-t5k A2),
   * or null when no suggestion phase is running. The ONLY field is the
   * absolute phase deadline — the client ticks the countdown itself on its 1s
   * tick (the server never streams per-second frames), and the scheduler's
   * enabled flag is console detail that never crosses the broadcast wire.
   */
  suggestPhase: { endsAtMs: number } | null;
  /**
   * The approved-suggestion pool awaiting the next vote round (quick-v4e,
   * the what's-coming page). DISPLAY FIELDS ONLY — this projection is the
   * narrowing EXEMPLAR (per the STATE.md residual about RoundSnapshot
   * over-projection; do NOT copy that pattern): never GateResult, never
   * rationale/category/decision, never addedAtMs. `username` is the
   * candidate's twitchUsername — already what RoundSnapshot exposes for vote
   * candidates, so this field carries no MORE than the main overlay's wire.
   * The source is CandidatePool, whose add() throws for any non-approved
   * result (COMP-01) — approved-only by construction (T-v4e-02).
   */
  pool: { text: string; username: string | null }[];
  /**
   * The FULL build queue in FIFO order — the first `queueDisplayMax` task
   * texts (quick-v4e). Same source and semantics as `nextUp`, just a larger
   * slice for the what's-coming page; position numbers are client-rendered.
   * Texts only: no task ids, no vote provenance, nothing else crosses the
   * wire (T-v4e-01 display-fields-only).
   */
  queue: string[];
}

/**
 * Structural seams (hotkey.ts KeyEventSource pattern): the overlay needs only
 * these slivers of StreamModeMachine / RoundManager / TaskQueue, so tests
 * inject plain fakes and never construct the SQLite-backed real things.
 */
export interface OverlayModeSource {
  readonly mode: StreamMode;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface OverlayRoundSource {
  snapshot(): RoundSnapshot | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface OverlayQueueSource {
  list(): readonly { text: string }[];
}

/**
 * The build-status sliver the overlay needs (mirrors OverlayRoundSource): a
 * point-in-time snapshot plus a BUILD_STAGE_CHANGED subscription. The
 * orchestrator (03-06) feeds this seam; tests inject a plain fake. snapshot()
 * returns null whenever no build is active.
 */
export interface OverlayBuildSource {
  snapshot(): BuildStatusView | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * A no-op build source: no build ever active, no stage events. Used until the
 * orchestrator (03-06) feeds a real OverlayBuildSource — the composition root
 * (main.ts) can wire the overlay before the build engine exists, and the panel
 * simply stays absent (buildStatus === null).
 */
const NULL_BUILD_SOURCE: OverlayBuildSource = {
  snapshot: () => null,
  on: () => {},
};

/**
 * The control-window sliver the overlay needs (mirrors OverlayBuildSource): a
 * point-in-time snapshot plus WINDOW_OPENED/WINDOW_CLOSED/WINDOW_REVOKED
 * subscriptions. `snapshot()` returns the ALREADY-COARSE public projection —
 * donor display name + absolute deadline only — or null when no window is
 * active. The Phase 4 window engine (04-01..04-03) feeds this seam; tests
 * inject a plain fake. The server re-projects the snapshot down to exactly
 * {donorDisplayName,endsAtMs} regardless (defence-in-depth), so even a source
 * that leaked richer fields could never push donor financials onto the wire.
 */
export interface OverlayControlWindowSource {
  snapshot(): { donorDisplayName: string; endsAtMs: number } | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * A no-op control-window source: no window ever active, no lifecycle events.
 * Used until the Phase 4 window engine feeds a real OverlayControlWindowSource —
 * the composition root (main.ts) can wire the overlay before the window engine
 * exists, and the banner simply stays absent (controlWindow === null).
 */
const NULL_CONTROL_WINDOW_SOURCE: OverlayControlWindowSource = {
  snapshot: () => null,
  on: () => {},
};

/**
 * The auto-cycle sliver the overlay needs (mirrors OverlayBuildSource): the
 * scheduler snapshot plus an AUTO_CYCLE_CHANGED subscription. The source may
 * carry richer fields (the console sees `enabled`); buildOverlayState narrows
 * the wire shape down to suggestPhase:{endsAtMs} only (quick-t5k A2).
 */
export interface OverlayAutoCycleSource {
  snapshot(): { phase: "suggest" | null; phaseEndsAtMs: number | null };
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * A no-op auto-cycle source: no suggestion phase ever active, no events.
 * Mirrors NULL_BUILD_SOURCE — the composition root can wire the overlay
 * without a scheduler and the guidance simply stays absent (suggestPhase null).
 */
const NULL_AUTO_CYCLE_SOURCE: OverlayAutoCycleSource = {
  snapshot: () => ({ phase: null, phaseEndsAtMs: null }),
  on: () => {},
};

/**
 * The candidate-pool sliver the overlay needs (mirrors OverlayQueueSource plus
 * the .on subscription of OverlayBuildSource). The real CandidatePool's list()
 * returns richer ApprovedCandidate items (GateResult, addedAtMs) — the server
 * re-projects each item down to exactly {text, username} in buildOverlayState
 * (T-v4e-01 defence-in-depth), so a richer source can never leak extra keys.
 */
export interface OverlayPoolSource {
  list(): readonly { candidate: { text: string; twitchUsername: string | null } }[];
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * A no-op pool source: empty pool, no change events. Mirrors NULL_BUILD_SOURCE —
 * the composition root can wire the overlay without a pool and the what's-coming
 * page simply shows its quiet empty state (pool: []).
 */
const NULL_POOL_SOURCE: OverlayPoolSource = {
  list: () => [],
  on: () => {},
};

/**
 * Default cap on the what's-coming page's full-queue projection. Tied to
 * VOTE_QUEUE_MAX (main.ts DEFAULT_VOTE_QUEUE_MAX = 10): the scheduler parks
 * at that many queued vote winners, so 10 covers the whole queue on stream.
 */
const DEFAULT_QUEUE_DISPLAY_MAX = 10;

export interface OverlayServerDeps {
  machine: OverlayModeSource;
  round: OverlayRoundSource;
  taskQueue: OverlayQueueSource;
  /** Optional until 03-06 wires the orchestrator; defaults to no build active. */
  build?: OverlayBuildSource;
  /** Optional until Phase 4 wires the window engine; defaults to no window active. */
  controlWindow?: OverlayControlWindowSource;
  /** Optional until quick-t5k wires the scheduler; defaults to no phase active. */
  autoCycle?: OverlayAutoCycleSource;
  /** Optional (quick-v4e what's-coming page); defaults to an empty pool. */
  pool?: OverlayPoolSource;
  /** Cap on the full-queue projection; defaults to 10 (VOTE_QUEUE_MAX). */
  queueDisplayMax?: number;
  port: number;
  /** Tally push debounce; defaults to the UI-SPEC 300ms. */
  debounceMs?: number;
  logger?: Logger;
}

export interface OverlayServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_TALLY_DEBOUNCE_MS = 300;

/**
 * Internal mode → public pill wording. The internal word "HALTED" is mapped
 * FROM here and never emitted: the broadcast surface says "ON HOLD" — honest,
 * non-alarming, never red (D2-18, T-02-21). Phase 4 makes FREE_REIGN_WINDOW /
 * CHAOS_MODE reachable and maps them to the two new words "FREE REIGN" /
 * "CHAOS" (04-UI-SPEC §Overlay state model, the one-time final vocabulary
 * extension), replacing their Phase 2 STANDBY placeholders.
 */
const PILL_BY_MODE: Record<StreamMode, OverlayPill> = {
  IDLE: "STANDBY",
  VOTING_ROUND: "VOTING OPEN",
  BUILD_IN_PROGRESS: "BUILDING",
  FREE_REIGN_WINDOW: "FREE REIGN",
  CHAOS_MODE: "CHAOS",
  HALTED: "ON HOLD",
};

/**
 * Start the read-only overlay server. Same bootstrap/teardown shape as the
 * operator console (its verified precedent), minus everything that mutates.
 *
 * The explicit "127.0.0.1" listen host is deliberate: the overlay is reachable
 * by the local OBS browser source only (D2-17). Never change the host argument.
 */
export function startOverlayServer(deps: OverlayServerDeps): Promise<OverlayServerHandle> {
  const { machine, round, taskQueue, logger } = deps;
  const build = deps.build ?? NULL_BUILD_SOURCE;
  const controlWindow = deps.controlWindow ?? NULL_CONTROL_WINDOW_SOURCE;
  const autoCycle = deps.autoCycle ?? NULL_AUTO_CYCLE_SOURCE;
  const poolSource = deps.pool ?? NULL_POOL_SOURCE;
  const queueDisplayMax = deps.queueDisplayMax ?? DEFAULT_QUEUE_DISPLAY_MAX;
  const app = express();

  // ── DNS-rebinding defense (CR-02, shared with the console) ──────────
  // FIRST middleware, all methods: the Host header must name a loopback
  // host. A remote page whose DNS is rebound to 127.0.0.1 would otherwise
  // read overlay state (round candidates, queue titles) from off-machine.
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.get("host"))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir));

  /** Compose the public overlay state — round + build snapshots + queue titles ONLY (T-02-21). */
  function buildOverlayState(): OverlayState {
    // Re-project the window snapshot down to EXACTLY the two public fields.
    // Even if the underlying source returned a richer object (amount, message,
    // trigger), this explicit narrowing guarantees only donorDisplayName +
    // endsAtMs ever reach the wire (T-04-13 coarse-surface, defence-in-depth).
    const cw = controlWindow.snapshot();
    // Explicit narrowing (quick-t5k A2): only the phase deadline crosses the
    // wire — never the scheduler's enabled flag or any richer field.
    const ac = autoCycle.snapshot();
    return {
      pill: PILL_BY_MODE[machine.mode],
      round: round.snapshot(),
      buildStatus: build.snapshot(),
      controlWindow:
        cw === null ? null : { donorDisplayName: cw.donorDisplayName, endsAtMs: cw.endsAtMs },
      suggestPhase:
        ac.phase === "suggest" && ac.phaseEndsAtMs !== null ? { endsAtMs: ac.phaseEndsAtMs } : null,
      nextUp: taskQueue
        .list()
        .slice(0, 3)
        .map((task) => task.text),
      // Explicit narrowing (T-v4e-01, the controlWindow re-projection idiom):
      // even a richer pool source (the real CandidatePool carries GateResult
      // and addedAtMs) can never leak extra keys — only {text, username}
      // display fields are ever constructed for the wire.
      pool: poolSource
        .list()
        .map((item) => ({ text: item.candidate.text, username: item.candidate.twitchUsername })),
      // Full queue projection for the what's-coming page: texts only, FIFO,
      // capped at queueDisplayMax (VOTE_QUEUE_MAX) — same source as nextUp.
      queue: taskQueue
        .list()
        .slice(0, queueDisplayMax)
        .map((task) => task.text),
    };
  }

  // The what's-coming page (quick-v4e) — a second OBS browser-source URL on
  // this SAME read-only server. GET only; the Host-allowlist middleware above
  // is app-level FIRST middleware, so /queue inherits the CR-02 DNS-rebinding
  // posture automatically.
  app.get("/queue", (_req, res) => {
    res.sendFile(path.join(publicDir, "queue.html"));
  });

  app.get("/api/state", (_req, res) => {
    res.json(buildOverlayState());
  });

  const server = createServer(app);

  // WR-01 Origin check shared with the console: a foreign browser page must
  // not read overlay state over ws (handshakes bypass CORS). Non-browser
  // clients (no Origin) and the same-origin OBS CEF page are accepted.
  // CR-02: the Host header must ALSO be a loopback host — a DNS-rebound
  // page's Origin and Host agree with each other, so a self-referential
  // comparison alone would validate the attacker against themselves.
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
      isLoopbackHostHeader(info.req.headers.host) &&
      (info.origin === undefined ||
        (isLoopbackOrigin(info.origin) && info.origin === `http://${info.req.headers.host}`)),
  });

  function pushState(roundOverride?: RoundSnapshot): void {
    const state = buildOverlayState();
    if (roundOverride !== undefined) {
      state.round = roundOverride;
    }
    const payload = JSON.stringify(state);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(buildOverlayState()));
  });

  // Low-frequency lifecycle events push immediately. These pushes carry the
  // EVENT's own snapshot: RoundManager nulls its live round BEFORE emitting
  // ROUND_CLOSED, so snapshot() would drop the closed round (winnerOption and
  // final tally) that the client's 8-second winner beat renders from.
  machine.on(STATE_CHANGED, () => {
    pushState();
  });
  for (const roundEvent of [ROUND_OPENED, ROUND_CLOSED]) {
    round.on(roundEvent, (...args) => {
      pushState(args[0] as RoundSnapshot | undefined);
    });
  }

  // Build-stage transitions are low-frequency show beats (a handful per build)
  // → push IMMEDIATELY, exactly like ROUND_OPENED/ROUND_CLOSED and never via
  // the vote-tally debounce. buildOverlayState() re-reads the source's current
  // snapshot, which the orchestrator advances BEFORE emitting (so the "done"
  // stage that drives the client's 8s BUILT IT beat is always in the push).
  build.on(BUILD_STAGE_CHANGED, () => {
    pushState();
  });

  // Control-window lifecycle beats (open / natural expiry / streamer revoke)
  // are low-frequency show beats → push IMMEDIATELY, exactly like ROUND_OPENED
  // and BUILD_STAGE_CHANGED, never through the vote-tally debounce (04-UI-SPEC
  // push cadence). Each push re-reads the coarse snapshot: WINDOW_OPENED carries
  // the new {donorDisplayName,endsAtMs}; WINDOW_CLOSED/WINDOW_REVOKED collapse
  // the banner silently (controlWindow: null) — no error text, no red, ever
  // (T-04-14). Chaos toggles ride STATE_CHANGED above (mode → CHAOS pill).
  for (const windowEvent of [WINDOW_OPENED, WINDOW_CLOSED, WINDOW_REVOKED]) {
    controlWindow.on(windowEvent, () => {
      pushState();
    });
  }

  // Auto-cycle phase transitions are lifecycle beats (a handful per cycle) →
  // push IMMEDIATELY, exactly like ROUND_OPENED — never the vote-tally
  // debounce (quick-t5k A2: the countdown itself ticks client-side).
  autoCycle.on(AUTO_CYCLE_CHANGED, () => {
    pushState();
  });

  // Pool changes push IMMEDIATELY like the lifecycle events: adds are
  // rate-limited by classifier latency + the per-user intake cooldown, and
  // removes are round-open/chaos beats — never the vote-tally debounce
  // (T-v4e-06 accepted: worst burst is a handful of small localhost frames).
  poolSource.on(POOL_CHANGED, () => {
    pushState();
  });

  // High-frequency tally events collapse into one push per debounce window:
  // the first vote arms ONE unref'd timer; every vote inside the window rides
  // the same pending push (max one tally push per 300ms under any flood).
  const debounceMs = deps.debounceMs ?? DEFAULT_TALLY_DEBOUNCE_MS;
  let tallyTimer: NodeJS.Timeout | null = null;
  round.on(VOTE_RECORDED, () => {
    if (tallyTimer !== null) return;
    tallyTimer = setTimeout(() => {
      tallyTimer = null;
      pushState();
    }, debounceMs);
    tallyTimer.unref();
  });

  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      logger?.info(
        { port: boundPort },
        "public overlay listening at http://127.0.0.1:%d",
        boundPort,
      );
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            if (tallyTimer !== null) {
              clearTimeout(tallyTimer);
              tallyTimer = null;
            }
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
