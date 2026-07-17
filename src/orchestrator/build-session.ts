/**
 * BUILD-01 + COMP-02 (in-flight) — the per-task build-session orchestrator.
 *
 * This is the composition-driven lifecycle owner that takes ONE gate-approved
 * QueuedTask and drives it STRAIGHT to the sandboxed build (quick-0iu,
 * streamer decision 2026-07-11 — the research/plan turns are removed):
 *
 *   BUILD_IN_PROGRESS → COMP-02 pre-build re-screen (input = the winning
 *   SUGGESTION text) → build (Fable, sandboxed, in the persistent workspace)
 *   [+ in-flight COMP-02 output re-screen] → done → IDLE
 *
 * Every external touch-point is INJECTED (mirrors RoundManager's constructor
 * deps + enqueueWinner's `EnqueueWinnerDeps` shape): the AgentRunner (SDK
 * query() wrapper), the SandboxAdapter (WSL2 spawn/terminate), COMP-02's
 * pre-bound classify seam, the WorkspaceView (persistent workspace state), and
 * the ProgressSink. vitest injects fakes so NO real WSL2 / query() / network is
 * ever touched here — the real SDK/WSL adapter is constructed only in
 * src/main.ts's guarded entrypoint.
 *
 * Discipline mirrored from Phase 1/2:
 *   - Fail-closed / never-throw (classifier.ts / gate.ts): every agent failure,
 *     model refusal, in-flight COMP-02 rejection, or sandbox error resolves to a
 *     failed/refused stage event and a CLEAN transition back to IDLE — the loop
 *     can never leave BUILD_IN_PROGRESS stuck with no exit (T-03-22).
 *   - DEQUEUE-only (COMP-01 single funnel): the orchestrator calls
 *     taskQueue.remove()/list() ONLY — it never enqueues, never mints a branded
 *     task, and never re-submits candidates (T-03-21, single-funnel checks b/d).
 *   - Concurrency-1 (D3-04): a p-queue serializes builds — the winner from
 *     Phase 2 is the only active build.
 *   - COMP-02 keeps its exact two-point shape: BEFORE the build (the suggestion
 *     text is re-screened — screenBuildPlan, fail-closed) AND during execution
 *     (each Write/Edit output batch is re-screened; a rejected batch aborts
 *     down the SAME narrated compliance-failure path — D3-07).
 *   - Persistent workspace (quick-0iu): builds accumulate in ONE distro dir per
 *     generation — the first `done` build scaffolds, later builds CONTINUE the
 *     same project; the streamer's "New project" console action rotates it.
 */

import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import PQueue from "p-queue";
import type { Logger } from "pino";
import {
  recordBuildHistory,
  recordBuildRefusal,
  recordBuildRetry,
  recordBuildSkip,
  recordComp02Decision,
  recordPipelineStage,
  recordSandboxTeardown,
} from "../audit/record.js";
import type { AbortRegistry } from "../kill-switch/abort.js";
import type { ApprovedContentItem, BuilderFeedSink } from "../overlay/builder-feed.js";
import { BUILD_STAGE_CHANGED } from "../overlay/server.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type {
  BuildNarrator,
  BuildProvenance,
  BuildResult,
  BuildStatusView,
  GateDecision,
  PipelineStage,
  QueuedTask,
  ReasonTag,
} from "../shared/types.js";
import { type Comp02Deps, screenBuildPlan, screenOutputBatch } from "./comp02.js";
import { translate } from "./progress-events.js";
import { buildBuildPrompt } from "./prompt-boundary.js";
import type {
  AgentMessage,
  AgentRunner,
  AgentRunSpec,
  BuildMachineView,
  ProgressSink,
  SandboxAdapter,
  WorkspaceView,
} from "./types.js";

export { BUILD_STAGE_CHANGED };

/**
 * The injected surface the build session drives against. Everything the
 * orchestrator touches is here so vitest never constructs a real
 * query()/WSL2/SQLite (mirrors EnqueueWinnerDeps / RoundManagerDeps).
 */
export interface BuildSessionDeps {
  /** Read-only consumer: list()/remove() ONLY — NEVER a new build-queue write. */
  taskQueue: TaskQueue;
  /** Audit ledger handle (recordPipelineStage + siblings write here, D3-13). */
  db: Database.Database;
  /** State-machine sliver (BUILD_IN_PROGRESS ↔ IDLE, active-task PID). */
  machine: BuildMachineView;
  /** Agent-session abort/teardown registry (BUILD-04 / D3-10). */
  registry: AbortRegistry;
  /** SDK query() wrapper (the sandboxed build turn — the only pipeline turn). */
  agentRunner: AgentRunner;
  /** WSL2 process isolation for the build agent (03-05). */
  sandboxAdapter: SandboxAdapter;
  /**
   * Persistent-workspace state (quick-0iu): dir() is the POSIX-absolute distro
   * path the build turn cds into; scaffolded() picks the scaffold/continue
   * prompt mode; markBuilt() flips on a `done` finalize. Injected — vitest
   * fakes it like every other seam; the real SQLite-backed implementation is
   * constructed in main.ts.
   */
  workspace: WorkspaceView;
  /**
   * COMP-02 pre-bound classify seam (03-04). The SAME `{ classify }` deps drive
   * BOTH screenBuildPlan (pre-write) and screenOutputBatch (in-flight).
   */
  comp02: Comp02Deps;
  /** Translated pipeline-stage sink (chat narration / console / test observer). */
  progress: ProgressSink;
  /**
   * COMP-02 held-for-review routing hook (D-08). When the pre-write plan
   * re-screen returns `held`, the build is NOT run; instead the plan is handed
   * here for the streamer's existing console review flow. Optional — absent in
   * unit tests that only assert the held path ends cleanly.
   */
  onHeldForReview?: (task: QueuedTask, planText: string) => void;
  /**
   * Build-pipeline chat narration (BUILD-03 / D3-08 / D3-09). Optional — absent
   * when no chat pipeline is composed (createApp only builds a Narrator when a
   * chatSource/chatSink pair exists). Every failure/refusal/retry/skip beat goes
   * through here so the show is never silent.
   */
  narrator?: BuildNarrator;
  /**
   * The broadcast /builder feed sink (quick-x7d, widened by quick-nhv).
   * Optional — absent in unit tests that don't assert on the feed. EVERY call
   * site is post-screening by construction: buildStarted carries the
   * already-broadcast gate-approved title, stage() maps onto a fixed caption
   * table, and contentApproved() — now carrying reasoning, tool calls, and
   * full-fidelity diffs — is only reachable AFTER the in-flight COMP-02
   * `screen.proceed` guard (T-x7d-01 structural gate, extended by T-nhv-01).
   */
  builderFeed?: BuilderFeedSink;
  /**
   * WR-07 per-turn watchdog bound (ms); defaults to DEFAULT_TURN_TIMEOUT_MS.
   * Injectable so tests can drive the hung-stream path deterministically without
   * waiting on the production-scale default. The live composition injects
   * BUILD_TURN_TIMEOUT_SECONDS * 1000 (quick-22l, default 900s).
   */
  turnTimeoutMs?: number;
  /**
   * Done-build hook (quick-22l gallery publish seam). Called ONLY when a build
   * finalizes `done` — never on failed/refused/comp02-rejected/aborted/skipped
   * exits. Optional — absent in unit tests that don't assert on it (mirrors
   * onHeldForReview). Invoked inside its own try/catch: a throwing hook can
   * NEVER disturb finalize, the IDLE transition, or the dequeue.
   */
  onBuildDone?: (task: QueuedTask) => void;
  /**
   * Teardown hook (quick-260717-093, D093-2): fired on EVERY non-done settle
   * whose path tears the sandbox down — and the in-distro preview dev server
   * dies with it (live incident 2026-07-16 20:25: a COMP-02 in-flight refusal
   * left the OBS LIVE BUILD slot on "Between builds" indefinitely). EXACTLY
   * four call sites: finalize() when stage !== "done", finalizeAborted(),
   * skipTask(), and the WR-07 watchdog-timeout branch (the sandbox is dead
   * there even though the machine then freezes on a decision). It does NOT
   * fire on a done finalize (onBuildDone owns the done seam) and NOT on the
   * agent-refusal decision freeze (no teardown happened — the server is
   * healthy; it fires later at skipTask). Optional — absent in unit tests that
   * don't assert on it. Invoked inside its own try/catch (the onBuildDone
   * idiom): a throwing hook can NEVER disturb finalize/skip/abort, the
   * dequeue, or the IDLE transition (D093-5).
   */
  onBuildTeardown?: (task: QueuedTask) => void;
  logger?: Logger;
}

/** The orchestrator handle the composition root wires (also the OverlayBuildSource seam). */
export interface BuildSession {
  /**
   * Serialize one build through the p-queue (concurrency-1). Resolves when the
   * build reaches a terminal stage (done) OR a decision-pending freeze
   * (failed/refused awaiting the streamer's retry/skip); NEVER rejects — a
   * failure is a stage event, not a thrown error (fail-closed).
   *
   * `provenance` (HIST-01) records HOW this build was selected — threaded from
   * the trigger site (vote | donation | channel_points | chaos) and stored on the
   * active session so finalize() persists it to build_history. Defaults to
   * 'vote' (the normal loop), matching overlay.js's `bs.source ?? "vote"`.
   */
  startBuild(task: QueuedTask, provenance?: BuildProvenance): Promise<void>;
  /**
   * BUILD-03 / D3-09: the streamer chose RETRY for a failed/refused build.
   * Re-runs the sandboxed build turn from the suggestion text (WITHOUT
   * re-screening — same semantics as the old approved-plan retry). No-op
   * unless `taskId` matches the decision-pending build.
   */
  retryBuild(taskId: string): void;
  /**
   * BUILD-03 / D3-09: the streamer chose SKIP for a failed/refused build (or a
   * routine drop). Audits recordBuildSkip, collapses the overlay, returns to
   * IDLE, and dequeues. No-op unless `taskId` matches the decision-pending build.
   */
  skipTask(taskId: string, reasonTag?: ReasonTag | null): void;
  /** OverlayBuildSource: the live build status, or null when no build is active. */
  snapshot(): BuildStatusView | null;
  /** OverlayBuildSource: BUILD_STAGE_CHANGED subscription (overlay push). */
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** Teardown: abort any in-flight build + unregister, before db.close() (AppHandle.close). */
  close(): Promise<void>;
}

/** Tool names whose output is re-screened in-flight (D3-07). */
const WRITE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * WR-07 per-turn watchdog bound. If an agent `query()` stream stalls without
 * yielding AND without honoring the abort signal, this timeout aborts the
 * controller and resolves the turn as `failed`, so a hung stream can never pin
 * the pipeline open in BUILD_IN_PROGRESS live on stream (T-03-22). Generous by
 * default (real build turns are minutes-scale); injectable so tests never wait
 * on it. NOTE (quick-0iu): this is a PER-TURN bound — the sandboxed build turn
 * already had the full budget to itself before the research/plan turns were
 * removed. NOTE (quick-22l): this constant is now only the deps-absent FALLBACK
 * (tests and any future non-build turn) — the live composition in main.ts
 * injects turnTimeoutMs from BUILD_TURN_TIMEOUT_SECONDS (default 900s), because
 * the old 5-min bound aborted a live, progressing build.
 */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * WR-05 bound on how long close() waits for an aborted in-flight pipeline to
 * drain before proceeding to db.close(). Short so a stream that ignores the
 * abort can never hang shutdown live on stream; the auditIfOpen guard covers the
 * rare case where the pipeline resumes after this bound elapses.
 */
const CLOSE_DRAIN_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Content blocks of an assistant SDK message, or [] for any other shape. */
function contentBlocks(message: unknown): Record<string, unknown>[] {
  const m = asRecord(message);
  if (m?.type !== "assistant") return [];
  const inner = asRecord(m.message);
  if (!inner || !Array.isArray(inner.content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const block of inner.content) {
    const b = asRecord(block);
    if (b) blocks.push(b);
  }
  return blocks;
}

/**
 * Pull the assistant's generated text out of a message (used to assemble the
 * research summary and the build plan). Returns null for any non-text message.
 * A structural narrower — the orchestrator is the SDK-shape containment
 * boundary, so this narrowing is allowed here (translate() owns stage mapping).
 */
export function extractAssistantText(message: unknown): string | null {
  const texts: string[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * The ONLY primary-arg extraction in this module (T-nhv-07). Returns the first
 * string value among the priority-ordered input keys, else "" — NEVER a JSON
 * dump of the raw input. BOTH extractScreenableText and extractApprovedContent
 * call this single helper, so any byte the feed can display as a tool-call arg
 * was, by construction, part of the text classify() screened — the
 * screened-superset guarantee holds structurally, not by parallel-maintained
 * key lists.
 */
function primaryArg(input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return "";
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "prompt",
    "description",
    "query",
  ]) {
    const value = rec[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Extract EVERYTHING screenable from one assistant message — the in-flight
 * COMP-02 instrumentation point (D3-07, widened by quick-nhv). Covers:
 *  - assistant text blocks (reasoning prose),
 *  - every tool_use's name + primaryArg(input) (the shared helper — T-nhv-07),
 *  - full Write/Edit content: file_path/content/new_string, the WR-02
 *    NotebookEdit keys (notebook_path/new_source), and ALL edits[].new_string.
 * Returns the concatenated text for re-screening, or null when the message
 * carries nothing screenable. Consequence (by design): reasoning-only messages
 * are screened too — a non-compliant reasoning batch aborts the build exactly
 * like a non-compliant Write batch.
 */
export function extractScreenableText(message: unknown): string | null {
  const parts: string[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    parts.push(block.name);
    const arg = primaryArg(block.input);
    if (arg.length > 0) parts.push(arg);
    if (!WRITE_EDIT_TOOLS.has(block.name)) continue;
    const input = asRecord(block.input);
    if (!input) continue;
    if (typeof input.file_path === "string") parts.push(input.file_path);
    if (typeof input.content === "string") parts.push(input.content);
    if (typeof input.new_string === "string") parts.push(input.new_string);
    // WR-02: NotebookEdit uses `notebook_path`/`new_source` (NOT
    // file_path/content/new_string). Without these its written text yields no
    // batch → the D3-07 in-flight COMP-02 re-screen would silently skip it.
    if (typeof input.notebook_path === "string") parts.push(input.notebook_path);
    if (typeof input.new_source === "string") parts.push(input.new_source);
    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        const e = asRecord(edit);
        if (e && typeof e.new_string === "string") parts.push(e.new_string);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Narrow an APPROVED assistant message down to the /builder feed's display
 * union (quick-nhv). Pure + exported for tests. Shape narrowing lives HERE
 * because build-session.ts is the declared SDK-shape containment boundary —
 * builder-feed.ts stays SDK-free. Raw SDK STRUCTURE (tool_use/input/block
 * keys) never crosses; tool NAMES cross deliberately as screened display data
 * (T-nhv-02):
 *  - text blocks → reasoning items;
 *  - Write/Edit-family tool_use → file-change items with the fixed verbs
 *    (Write → "Writing"; Edit/MultiEdit/NotebookEdit → "Editing"), full text =
 *    content | new_string | new_source | ALL edits' new_string joined "\n";
 *    a block with no string path is skipped entirely (fail closed);
 *  - every OTHER tool_use → a tool-call item whose arg comes from the SAME
 *    primaryArg helper the screen used (T-nhv-07 subset guarantee).
 */
export function extractApprovedContent(message: unknown): ApprovedContentItem[] {
  const items: ApprovedContentItem[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      items.push({ type: "reasoning", text: block.text });
      continue;
    }
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (!WRITE_EDIT_TOOLS.has(block.name)) {
      items.push({ type: "tool-call", tool: block.name, arg: primaryArg(block.input) });
      continue;
    }
    const input = asRecord(block.input);
    if (!input) continue;
    const path =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : null;
    if (path === null) continue; // no string path → skip entirely (fail closed)
    const verb = block.name === "Write" ? ("Writing" as const) : ("Editing" as const);
    let text = "";
    if (typeof input.content === "string") {
      text = input.content;
    } else if (typeof input.new_string === "string") {
      text = input.new_string;
    } else if (typeof input.new_source === "string") {
      text = input.new_source;
    } else if (Array.isArray(input.edits)) {
      const editTexts: string[] = [];
      for (const edit of input.edits) {
        const e = asRecord(edit);
        if (e && typeof e.new_string === "string") editTexts.push(e.new_string);
      }
      text = editTexts.join("\n");
    }
    items.push({ type: "file-change", verb, path, text });
  }
  return items;
}

/** Per-turn consumption outcome (turn-level, NOT the whole pipeline). */
type TurnOutcome = "ok" | "refused" | "failed" | "compliance-rejected";

interface TurnResult {
  text: string;
  outcome: TurnOutcome;
  /**
   * WR-07: true when the per-turn watchdog fired (a hung/stalled stream). The
   * caller routes this as a narrated `failed` decision — NOT as a silent
   * external abort — even though the watchdog also aborted the controller.
   */
  timedOut?: boolean;
}

/** Map a COMP-02 outcome disposition onto the gate decision vocabulary for audit. */
function comp02Decision(disposition: "rejected" | "held"): GateDecision {
  return disposition === "held" ? "held-for-review" : "rejected";
}

/** Construct the per-task build session. Export a factory from index.ts. */
export function createBuildSession(deps: BuildSessionDeps): BuildSession {
  const queue = new PQueue({ concurrency: 1 });
  const emitter = new EventEmitter();
  let current: BuildStatusView | null = null;
  let active: { task: QueuedTask; ac: AbortController } | null = null;
  /**
   * HIST-01: how the ACTIVE build was selected (vote | donation | channel_points
   * | chaos). Threaded in via startBuild() and read at finalize() to tag the
   * build_history row. A single slot is safe: builds are strictly sequential
   * under BUILD_IN_PROGRESS (concurrency-1), incl. D-12 multi-build windows, so
   * only one build is ever active. A streamer retry keeps the original value
   * (never reset except at the start of a fresh pipeline).
   */
  let currentProvenance: BuildProvenance = "vote";
  /**
   * A build frozen on a `failed`/`refused` decision awaiting the streamer's
   * retry/skip (D3-09). While set, the machine stays BUILD_IN_PROGRESS, the task
   * stays queued, and the overlay renders the frozen (amber) stage. `planText`
   * is the suggestion text to retry the build from (quick-0iu: there is no plan
   * anymore — the field name is kept so the retry seam is unchanged); null only
   * on a legacy pre-build failure shape (defensive, no live producer).
   */
  let pending: { task: QueuedTask; planText: string | null; reason: "failed" | "refused" } | null =
    null;

  const streamMode = () => deps.machine.mode;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  /**
   * WR-05: the in-flight pipeline promise. close() aborts the controller AND
   * awaits this so a resumed abort path can never write to a closed db.
   */
  let running: Promise<void> | null = null;

  /**
   * WR-05: append a ledger row ONLY while the db handle is still open. During
   * shutdown the resumed abort path can reach here AFTER db.close(); a guarded
   * no-op keeps teardown from throwing on a closed better-sqlite3 handle (which
   * otherwise cascades into an unhandled rejection on the winner build path).
   */
  function auditIfOpen(write: () => void): void {
    if (!deps.db.open) {
      deps.logger?.warn("skipping audit write — db is closed (shutdown teardown, WR-05)");
      return;
    }
    write();
  }

  /** Emit one pipeline stage: audit row → overlay push → progress sink. */
  function emitStage(task: QueuedTask, stage: PipelineStage, summary?: string): void {
    // quick-260716-g8p: ACTIVATES the previously-dormant `source` field — the
    // client's FREE REIGN / CHAOS PICK provenance-chip logic has existed since
    // Phase 4 but never received it. `currentProvenance` is threaded explicitly
    // per T-05-03 (never mode-inferred), set at the top of runPipeline before
    // any emitStage, and preserved across a streamer retry — no ordering hazard.
    // suggestedBy is the vote/chaos suggester's twitchUsername ONLY: a paid
    // (donation | channel_points) build nulls it so the coarse T-04-13 public
    // projection is never widened (T-g8p-01 — the wire has never carried who
    // issued a paid-window instruction).
    const paid = currentProvenance === "donation" || currentProvenance === "channel_points";
    const view: BuildStatusView = {
      taskId: task.id,
      title: task.text,
      stage,
      source: currentProvenance,
      suggestedBy: paid ? null : task.twitchUsername,
    };
    auditIfOpen(() =>
      recordPipelineStage(deps.db, {
        taskId: task.id,
        stage,
        streamMode: streamMode(),
        summary: summary ?? null,
      }),
    );
    current = view;
    emitter.emit(BUILD_STAGE_CHANGED);
    deps.progress.push(view);
    // /builder feed (quick-x7d): one fixed-caption beat per stage transition.
    // This single line covers building plus the terminal done/failed/refused
    // beats from finalize()/enterDecision() and the retry path's "building"
    // re-emit. finalizeAborted() never reaches here — an aborted build's feed
    // simply stops (no false "BUILT IT", T-x7d-05).
    deps.builderFeed?.stage(stage);
  }

  /** Enter BUILD_IN_PROGRESS (idempotent — the winner hook may have entered it already). */
  function enterBuildMode(task: QueuedTask): void {
    if (deps.machine.mode !== "BUILD_IN_PROGRESS") {
      deps.machine.transition("BUILD_IN_PROGRESS");
    }
    deps.machine.setActiveTask(task.id, null);
  }

  /**
   * Map a terminal pipeline stage onto the honest build_history result vocabulary
   * (HIST-01, T-05-02): done→built, and failed/refused pass through 1:1.
   */
  function mapStageToResult(stage: "done" | "failed" | "refused"): BuildResult {
    return stage === "done" ? "built" : stage;
  }

  /**
   * quick-260717-093 (D093-2/D093-5): fire the optional teardown hook — the
   * preview dev-server resurrection seam. Wrapped in its own try/catch (the
   * onBuildDone idiom): a throwing hook can NEVER disturb the caller's
   * dequeue, emit ordering, or the IDLE transition. Every call site sits at
   * the END of its function, after the dequeue + guarded transition.
   */
  function fireTeardownHook(task: QueuedTask): void {
    try {
      deps.onBuildTeardown?.(task);
    } catch (err) {
      deps.logger?.error(
        { err, taskId: task.id },
        "onBuildTeardown hook threw — preview resurrection skipped, teardown continues untouched",
      );
    }
  }

  /**
   * Terminal exit: emit the terminal stage, drop the overlay snapshot,
   * unregister + DEQUEUE the finished task, THEN return to IDLE. Legal
   * BUILD_IN_PROGRESS→IDLE transition; never leaves the machine stuck
   * (T-03-22). Dequeue-before-transition is load-bearing (quick-260716-t1n):
   * STATE_CHANGED subscribers run synchronously inside transition("IDLE"),
   * and any drain they reach must never find the finished task still queued.
   */
  function finalize(
    task: QueuedTask,
    stage: "done" | "failed" | "refused",
    summary?: string,
  ): void {
    emitStage(task, stage, summary);
    // Persistent workspace (quick-0iu): ONLY a `done` build makes the current
    // generation an existing project (future turns run in continue mode). A
    // failed/refused/aborted build never flips it — if nothing was ever built
    // in this generation, the next attempt scaffolds again.
    if (stage === "done") {
      deps.workspace.markBuilt();
      // quick-22l gallery publish seam: fire the done-hook HERE — the ONLY
      // correct done seam (finalizeAborted/enterDecision/skipTask are the
      // failure/abort paths and never reach this branch). Called synchronously
      // while the machine is still BUILD_IN_PROGRESS, so a workspace rotation
      // (console 409s mid-build) cannot race the caller's workspace.generation()
      // read. Own try/catch: a publisher callback error must NEVER disturb
      // finalize, the IDLE transition, or the dequeue (T-22l-04).
      try {
        deps.onBuildDone?.(task);
      } catch (err) {
        deps.logger?.error(
          { err, taskId: task.id },
          "onBuildDone hook threw — publish skipped, finalize continues untouched",
        );
      }
    }
    // HIST-01: a COMPLETED build persists exactly ONE append-only changelog row,
    // carrying the gate-APPROVED task.text (D-03), the stored provenance, and the
    // honest terminal result. Read currentProvenance BEFORE `active = null` and
    // guard with auditIfOpen (same shutdown-drain guard as the pipeline_stage
    // write). NOTE: finalizeAborted() deliberately does NOT do this — an abort is
    // neither a success nor a narrated failure and must never become a row (CR-01).
    auditIfOpen(() =>
      recordBuildHistory(deps.db, {
        taskId: task.id,
        title: task.text,
        provenance: currentProvenance,
        result: mapStageToResult(stage),
      }),
    );
    current = null;
    active = null;
    // ORDERING INVARIANT (quick-260716-t1n): a task is never discoverable in
    // the queue once its terminal record is written / the machine leaves
    // BUILD_IN_PROGRESS — dequeue MUST precede the IDLE transition because
    // STATE_CHANGED handlers run synchronously inside transition() (live
    // incident 2026-07-16: the fdl scheduler's in-emit resume chained into
    // drainVoteQueue and re-executed the still-queued finished head).
    deps.registry.unregister(task.id);
    deps.taskQueue.remove(task.id);
    try {
      if (deps.machine.mode === "BUILD_IN_PROGRESS") {
        deps.machine.transition("IDLE");
      }
      deps.machine.setActiveTask(null, null);
    } catch (err) {
      deps.logger?.error({ err, taskId: task.id }, "failed to return machine to IDLE after build");
    }
    // quick-260717-093 (D093-2 a): every NON-done finalize — refused (COMP-02
    // in-flight/pre-build), failed (unexpected pipeline error) — settled a
    // build whose path may have torn the sandbox (and the dev server) down.
    // Never on done: onBuildDone owns that seam.
    if (stage !== "done") {
      fireTeardownHook(task);
    }
  }

  /**
   * CR-01 terminal-abort path for a build the streamer HALTED / vetoed / a
   * shutdown killed. It is NEITHER a success NOR a narrated failure:
   *   - it writes a `sandbox_teardown` audit row, NOT `pipeline_stage: done`, so
   *     the compliance ledger never records a force-killed build as completed;
   *   - it collapses the overlay build panel by clearing `current` and emitting
   *     BUILD_STAGE_CHANGED WITHOUT ever pushing a `done` stage — so the public
   *     broadcast never fires the "BUILT IT" celebration for a killed build;
   *   - it returns to IDLE ONLY when the machine is NOT HALTED (during a halt the
   *     kill switch owns the HALTED state — leave it there);
   *   - it dequeues and unregisters (clean exit, never leaves BUILD_IN_PROGRESS
   *     stuck, T-03-22).
   * The kill-switch path (abortActiveWork) owns the actual process teardown + the
   * buildVetoed chat beat; this only makes the terminal record honest.
   */
  function finalizeAborted(task: QueuedTask): void {
    auditIfOpen(() =>
      recordSandboxTeardown(deps.db, {
        taskId: task.id,
        streamMode: streamMode(),
        rationale:
          "build aborted (streamer halt/veto/shutdown) — terminal teardown, NOT a completion (CR-01)",
      }),
    );
    // Collapse the overlay panel WITHOUT a `done` beat: null the snapshot, then
    // emit so the overlay re-reads snapshot()=null (panel hides) — never stage=done.
    current = null;
    active = null;
    // ORDERING INVARIANT (quick-260716-t1n): dequeue + unregister BEFORE ANY
    // emit — the queue is clean before BUILD_STAGE_CHANGED and before the IDLE
    // transition below, because STATE_CHANGED handlers run synchronously
    // inside transition() and must never find the aborted task still queued.
    deps.registry.unregister(task.id);
    deps.taskQueue.remove(task.id);
    emitter.emit(BUILD_STAGE_CHANGED);
    try {
      // Leave HALTED alone — the kill switch owns it. Only return to IDLE for a
      // non-halt abort (e.g. shutdown), mirroring finalize()'s guarded transition.
      if (deps.machine.mode === "BUILD_IN_PROGRESS") {
        deps.machine.transition("IDLE");
      }
      deps.machine.setActiveTask(null, null);
    } catch (err) {
      deps.logger?.error(
        { err, taskId: task.id },
        "failed to return machine to IDLE after aborted build",
      );
    }
    // quick-260717-093 (D093-2 b): a halt/veto/shutdown abort tore the sandbox
    // down — resurrect the preview dev server. main.ts's handler guards
    // HALTED (the machine is frozen; the preview may stay dark until the
    // recovery reroot).
    fireTeardownHook(task);
  }

  /**
   * Consume one agent turn's message stream: collect generated text, watch for
   * a model refusal / failure result, and (build turn only) re-screen each
   * Write/Edit output batch through COMP-02. Never throws.
   */
  async function consumeTurn(
    task: QueuedTask,
    stream: AsyncIterable<AgentMessage>,
    ac: AbortController,
    inFlightScreen: boolean,
  ): Promise<TurnResult> {
    const texts: string[] = [];
    let outcome: TurnOutcome = "ok";
    let timedOut = false;

    // HI-03: a per-turn STALL/idle watchdog. The timer is RE-ARMED on every
    // yielded message (activity resets the clock), so a healthy, steadily-
    // progressing build is never killed — only a stream with NO activity for
    // turnTimeoutMs trips it. On trip it aborts the controller and wins the race
    // below, resolving the turn as `failed` so the pipeline can never stay
    // pinned in BUILD_IN_PROGRESS on a hung stream. NO workspace reset happens
    // on abort — the stall timer is the whole HI-03 fix (non-destructive).
    let watchdog: NodeJS.Timeout | undefined;
    let resolveWatchdog: (() => void) | undefined;
    const watchdogFired = new Promise<void>((resolve) => {
      resolveWatchdog = resolve;
    });
    // A single, stable fire closure — re-armed timers all share it.
    const fire = (): void => {
      timedOut = true;
      ac.abort();
      resolveWatchdog?.();
    };
    const armWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(fire, turnTimeoutMs);
      watchdog.unref?.();
    };
    armWatchdog();

    const consume = (async (): Promise<void> => {
      try {
        for await (const message of stream) {
          if (ac.signal.aborted) break;
          // Activity — re-arm the stall timer so a progressing build survives.
          armWatchdog();

          const text = extractAssistantText(message);
          if (text !== null) texts.push(text);

          // In-flight COMP-02 (D3-07, widened by quick-nhv): re-screen every
          // screenable message — reasoning prose, tool names/args, and full
          // Write/Edit content — through the SAME single-funnel entry point.
          if (inFlightScreen) {
            const batch = extractScreenableText(message);
            if (batch !== null) {
              const screen = await screenOutputBatch(deps.comp02, {
                taskId: task.id,
                outputText: batch,
              });
              recordComp02Decision(deps.db, {
                taskId: task.id,
                decision: screen.proceed ? "approved" : comp02Decision(screen.disposition),
                category: screen.proceed ? null : "category" in screen ? screen.category : null,
                rationale: "COMP-02 in-flight output re-screen (D3-07)",
                streamMode: streamMode(),
              });
              if (!screen.proceed) {
                outcome = "compliance-rejected";
                break;
              }
              // T-x7d-01 STRUCTURAL GATE (extended by T-nhv-01): this call sits
              // strictly AFTER the `!screen.proceed → break` guard above — the
              // rejected branch breaks out before this line executes, so a
              // rejected (or never-screened) message's reasoning, tool args,
              // paths, and content are unreachable on the /builder broadcast
              // feed by CONTROL FLOW, not convention.
              deps.builderFeed?.contentApproved(extractApprovedContent(message));
            }
          }

          const stage = translate(message);
          if (stage === "refused") {
            outcome = "refused";
            break;
          }
          if (stage === "failed") {
            outcome = "failed";
            break;
          }
          if (stage === "done") {
            // A turn-level success result ends this turn (not necessarily the
            // whole pipeline — the caller decides what the next stage is).
            break;
          }
        }
      } catch (err) {
        deps.logger?.error({ err, taskId: task.id }, "agent turn threw — failing closed");
        outcome = "failed";
      }
    })();

    try {
      await Promise.race([consume, watchdogFired]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    if (timedOut) {
      deps.logger?.error(
        { taskId: task.id, turnTimeoutMs },
        "agent turn exceeded the per-turn watchdog — aborting + failing the turn (WR-07)",
      );
      outcome = "failed";
    }
    return { text: texts.join("\n").trim(), outcome, timedOut };
  }

  /** Run one agent turn via the injected runner. Never throws (fail-closed). */
  function runTurn(
    spec: AgentRunSpec,
    task: QueuedTask,
    ac: AbortController,
    inFlight: boolean,
  ): Promise<TurnResult> {
    let stream: AsyncIterable<AgentMessage>;
    try {
      stream = deps.agentRunner.run(spec);
    } catch (err) {
      deps.logger?.error({ err, taskId: task.id }, "agentRunner.run() threw — failing closed");
      return Promise.resolve({ text: "", outcome: "failed" });
    }
    return consumeTurn(task, stream, ac, inFlight);
  }

  /** Abort + total sandbox teardown for an in-flight COMP-02 rejection (D3-07). */
  async function abortForCompliance(task: QueuedTask, ac: AbortController): Promise<void> {
    ac.abort();
    try {
      await deps.sandboxAdapter.terminate();
    } catch (err) {
      deps.logger?.error(
        { err, taskId: task.id },
        "sandbox teardown failed during compliance abort",
      );
    }
    recordSandboxTeardown(deps.db, {
      taskId: task.id,
      streamMode: streamMode(),
      rationale: "in-flight COMP-02 rejected an output batch — build aborted (D3-07)",
    });
  }

  /** True while a halt/veto has aborted the current turn — the kill-switch path owns cleanup. */
  function abortedNow(ac: AbortController): boolean {
    return ac.signal.aborted || deps.machine.mode === "HALTED";
  }

  /** Register the fresh AbortController + WSL2 teardown for one build attempt. */
  function registerAbort(taskId: string, ac: AbortController): void {
    deps.registry.registerController(taskId, ac);
    deps.registry.registerSandboxTeardown(taskId, () => deps.sandboxAdapter.terminate());
  }

  /**
   * Freeze the build on a `failed`/`refused` decision (D3-09): emit the terminal
   * stage (overlay stepper freezes at the current step, amber caption), keep the
   * machine in BUILD_IN_PROGRESS and the task in the queue, and park a pending
   * decision for the streamer's retryBuild/skipTask. NEVER silent — the caller
   * has already narrated the failure/refusal beat. `planText` is always the
   * suggestion text now (quick-0iu — the retry re-runs the build from it).
   */
  function enterDecision(
    task: QueuedTask,
    planText: string | null,
    reason: "failed" | "refused",
    summary?: string,
  ): void {
    emitStage(task, reason, summary);
    active = null;
    pending = { task, planText, reason };
  }

  /**
   * Run ONE sandboxed build attempt (+ in-flight COMP-02) and route its outcome:
   *   - aborted (halt/veto)       → quiet finalize (kill-switch owns teardown + the buildVetoed beat)
   *   - in-flight COMP-02 reject  → abort + teardown + comp02Rejected beat → drop (never auto-retry)
   *   - refused                   → buildRefused beat → decision pending (D3-08)
   *   - failed + allowAutoRetry   → buildRetryingOnce beat → ONE more attempt (D3-09)
   *   - failed + no retry left    → buildDeciding beat → decision pending
   *   - ok                        → buildDone beat → finalize done
   */
  async function runBuildAttempt(
    task: QueuedTask,
    taskText: string,
    ac: AbortController,
    allowAutoRetry: boolean,
  ): Promise<void> {
    emitStage(task, "building");
    // BL-01: the distro workspace dir MUST exist before the build turn spawns.
    // A rejection fails the build CLOSED — the SAME narrated-decision route as
    // the watchdog path — never proceeding to spawn and never silently falling
    // back to a shared dir / weakened isolation.
    try {
      await deps.sandboxAdapter.ensureWorkspaceDir?.(deps.workspace.dir());
    } catch (err) {
      deps.logger?.error(
        { err, taskId: task.id },
        "workspace dir ensure failed — build failed closed (BL-01)",
      );
      auditIfOpen(() =>
        recordSandboxTeardown(deps.db, {
          taskId: task.id,
          streamMode: streamMode(),
          rationale: "workspace dir ensure failed — build failed closed (BL-01)",
        }),
      );
      deps.narrator?.buildDeciding(task.text);
      enterDecision(task, taskText, "failed");
      return;
    }
    // Scaffold vs. continue is computed FRESH per attempt (quick-0iu): a prior
    // `done` build in this generation flips future attempts to continue mode.
    // HI-01: a NON-EMPTY dir also forces continue even without a prior `done`
    // (never scaffold over debris). A probe error resolves to hasFiles=true —
    // never assert "empty" when unsure. This composes with forced rotation: a
    // rotated-to new generation has a fresh empty dir → scaffold. The build
    // model is explicitly pinned to Fable in assembleSandboxedBuildOptions
    // (BUILD_MODEL env override, default claude-fable-5); AgentRunSpec has no
    // model field — the pipeline structurally cannot request an override.
    const hasFiles = deps.sandboxAdapter.workspaceHasFiles
      ? await deps.sandboxAdapter.workspaceHasFiles(deps.workspace.dir()).catch(() => true)
      : false;
    const mode = deps.workspace.scaffolded() || hasFiles ? "continue" : "scaffold";
    const build = buildBuildPrompt(taskText, mode);
    const buildTurn = await runTurn(
      {
        agent: "build",
        systemPrompt: build.systemPrompt,
        userPrompt: build.userPrompt,
        workspaceDir: deps.workspace.dir(),
        sandbox: deps.sandboxAdapter,
        spawnClaudeCodeProcess: (opts) => deps.sandboxAdapter.spawn(opts),
        abortController: ac,
      },
      task,
      ac,
      true,
    );

    // A streamer halt/veto/shutdown aborted this turn mid-stream (NOT the WR-07
    // watchdog): take the terminal-abort path — collapse the panel WITHOUT a
    // `done` beat and write a teardown row, NOT a `done` completion (CR-01). The
    // kill-switch path (abortActiveWork) owns process teardown + the buildVetoed
    // beat.
    if (abortedNow(ac) && !buildTurn.timedOut) {
      finalizeAborted(task);
      return;
    }
    // WR-07: a hung build stream tripped the watchdog. Tear down the sandbox so
    // the WSL2 distro can't linger, then surface a narrated retry/skip decision
    // (never silent, never auto-retry on the already-aborted controller).
    if (buildTurn.timedOut) {
      try {
        await deps.sandboxAdapter.terminate();
      } catch (err) {
        deps.logger?.error(
          { err, taskId: task.id },
          "sandbox teardown failed after per-turn watchdog timeout",
        );
      }
      auditIfOpen(() =>
        recordSandboxTeardown(deps.db, {
          taskId: task.id,
          streamMode: streamMode(),
          rationale: "per-turn watchdog timeout — hung build stream torn down (WR-07)",
        }),
      );
      deps.narrator?.buildDeciding(task.text);
      enterDecision(task, taskText, "failed");
      // quick-260717-093 (D093-2 d): the watchdog branch above just ran
      // terminate() — the sandbox (and the dev server with it) is literally
      // dead, and the machine now freezes on a decision for possibly minutes.
      // Per design intent "ANY build teardown that kills the sandbox", the
      // hook fires even though enterDecision is not terminal.
      fireTeardownHook(task);
      return;
    }

    if (buildTurn.outcome === "compliance-rejected") {
      await abortForCompliance(task, ac);
      deps.narrator?.comp02Rejected(task.text);
      finalize(task, "refused", "in-flight COMP-02 rejected an output batch (D3-07)");
      return;
    }
    if (buildTurn.outcome === "refused") {
      recordBuildRefusal(deps.db, {
        taskId: task.id,
        streamMode: streamMode(),
        rationale: "the build agent refused the build turn (D3-08)",
      });
      deps.narrator?.buildRefused(task.text);
      enterDecision(task, taskText, "refused");
      return;
    }
    if (buildTurn.outcome === "failed") {
      if (allowAutoRetry) {
        // D3-09: a transient/tooling build failure auto-retries AT MOST ONCE.
        recordBuildRetry(deps.db, {
          taskId: task.id,
          streamMode: streamMode(),
          rationale: "auto-retry once on a transient build failure (D3-09)",
        });
        deps.narrator?.buildRetryingOnce(task.text);
        await runBuildAttempt(task, taskText, ac, false);
        return;
      }
      deps.narrator?.buildDeciding(task.text);
      enterDecision(task, taskText, "failed");
      return;
    }
    // EMPTY-01: an "ok" turn is only `done` if the workspace actually holds
    // committable output. Root-cause context: a permission-denied Write storm
    // once ended as result:success with ZERO files — finalize then markBuilt()
    // + published an EMPTY public repo. Probe (when the adapter provides it;
    // fakes without it skip the guard) and route an empty "success" down the
    // SAME transient-failure path as a failed turn: auto-retry once, then a
    // narrated retry/skip decision. A probe error resolves true (fail toward
    // done — a flaky probe must never fail a good live build; the publisher's
    // own preflight still prevents an empty repo).
    const hasOutput = deps.sandboxAdapter.workspaceHasCommittableFiles
      ? await deps.sandboxAdapter
          .workspaceHasCommittableFiles(deps.workspace.dir())
          .catch(() => true)
      : true;
    if (!hasOutput) {
      deps.logger?.error(
        { taskId: task.id, dir: deps.workspace.dir() },
        "build turn reported success but the workspace has no committable files — done withheld (EMPTY-01)",
      );
      if (allowAutoRetry) {
        recordBuildRetry(deps.db, {
          taskId: task.id,
          streamMode: streamMode(),
          rationale:
            "build turn succeeded with an EMPTY workspace — auto-retry once (EMPTY-01/D3-09)",
        });
        deps.narrator?.buildRetryingOnce(task.text);
        await runBuildAttempt(task, taskText, ac, false);
        return;
      }
      deps.narrator?.buildDeciding(task.text);
      enterDecision(
        task,
        taskText,
        "failed",
        "build turn succeeded but wrote no committable files (EMPTY-01)",
      );
      return;
    }
    // ok → done.
    deps.narrator?.buildDone(task.text);
    finalize(task, "done");
  }

  /** The full per-task pipeline. Wrapped so it can never throw out of the p-queue. */
  async function runPipeline(task: QueuedTask, provenance: BuildProvenance): Promise<void> {
    // HIST-01: pin the provenance for this build so finalize() records it. Set
    // here (inside the concurrency-1 pipeline) rather than in startBuild so a
    // second queued startBuild can never overwrite the running build's value.
    currentProvenance = provenance;
    const ac = new AbortController();
    active = { task, ac };
    try {
      // /builder feed (quick-x7d): announce the fresh build FIRST — this also
      // CLEARS the previous build's lines (T-x7d-05: a killed build's lines
      // never leak forward). task.text is the SAME gate-approved string the
      // overlay build panel already broadcasts (80-char-truncated in the feed).
      deps.builderFeed?.buildStarted(task.text);
      enterBuildMode(task);
      registerAbort(task.id, ac);
      deps.narrator?.buildPickedUp(task.text);

      // 1) COMP-02 pre-build re-screen (D3-06) — IMMEDIATELY, before ANY agent
      //    turn. The input is the winning SUGGESTION text: there is no plan
      //    anymore (quick-0iu straight-to-build). The compliance export keeps
      //    its `planText` parameter name — src/compliance/** and comp02.ts are
      //    untouched (requirement 2); only this call site adapted.
      const screen = await screenBuildPlan(deps.comp02, { taskId: task.id, planText: task.text });
      recordComp02Decision(deps.db, {
        taskId: task.id,
        decision: screen.proceed ? "approved" : comp02Decision(screen.disposition),
        category: screen.proceed ? null : "category" in screen ? screen.category : null,
        rationale: "COMP-02 pre-build suggestion re-screen (D3-06)",
        streamMode: streamMode(),
      });
      if (!screen.proceed) {
        // A compliance failure NEVER auto-retries (D3-09). rejected → narrate +
        // drop; held → route to console review (D-08). Both end cleanly WITHOUT
        // running the build query() and WITHOUT a retry/skip decision — the
        // AgentRunner is NEVER invoked on either path.
        if (screen.disposition === "held") {
          // WR-03: never silent. Narrate the held outcome (distinct from a hard
          // rejection) so chat hears why the build stopped, hand the suggestion
          // to the review-routing hook, and audit it (comp02_decision:
          // held-for-review + pipeline_stage: refused below). D-08 console
          // review-queue *routing* is still deferred — the hook currently logs
          // an audited warning rather than re-queuing; the drop is explicit +
          // narrated, not a silent stub.
          deps.narrator?.buildHeld(task.text);
          deps.onHeldForReview?.(task, task.text);
          return finalize(
            task,
            "refused",
            "COMP-02 held the suggestion for streamer review (D-08 routing deferred; held audited + narrated)",
          );
        }
        deps.narrator?.comp02Rejected(task.text);
        return finalize(
          task,
          "refused",
          "COMP-02 rejected the suggestion before any code was written (D3-06)",
        );
      }

      // A veto/halt landing DURING the screen await must never spawn a build
      // turn — abort still routes through finalizeAborted, no stage "done".
      if (abortedNow(ac)) return finalizeAborted(task);

      // 2) Build (Fable — explicitly pinned, SANDBOXED, persistent workspace) +
      //    in-flight COMP-02 (D3-07), auto-retrying a transient failure at most
      //    once (D3-09).
      deps.narrator?.stageBuilding(task.text);
      await runBuildAttempt(task, task.text, ac, true);
    } catch (err) {
      deps.logger?.error({ err, taskId: task.id }, "build pipeline error — failing closed to IDLE");
      finalize(task, "failed", "unexpected build-pipeline error (fail-closed)");
    }
  }

  /**
   * WR-05: enqueue work AND publish the resulting promise as `running` so
   * close() can await the in-flight pipeline. Without this, an aborted pipeline
   * resumes on a later tick (after main.ts already returned from close()) and its
   * teardown could race db.close().
   */
  function track(fn: () => Promise<void>): Promise<void> {
    const p = (queue.add(fn) as Promise<void>).finally(() => {
      if (running === p) running = null;
    });
    running = p;
    return p;
  }

  return {
    startBuild(task: QueuedTask, provenance: BuildProvenance = "vote"): Promise<void> {
      if (deps.machine.mode === "HALTED") {
        deps.logger?.warn(
          { taskId: task.id },
          "build refused — stream is HALTED, nothing builds while halted",
        );
        return Promise.resolve();
      }
      return track(() => runPipeline(task, provenance));
    },

    retryBuild(taskId: string): void {
      const p = pending;
      if (!p || p.task.id !== taskId) return;
      if (deps.machine.mode === "HALTED") return;
      pending = null;
      recordBuildRetry(deps.db, {
        taskId,
        streamMode: streamMode(),
        rationale: "streamer chose retry from the console (D3-09)",
      });
      deps.narrator?.buildRetryChosen(p.task.text);
      if (p.planText === null) {
        // Defensive dead code (quick-0iu): no live path parks a null planText
        // anymore — enterDecision always receives the suggestion text. Kept so
        // a legacy/unexpected shape still re-runs the whole pipeline safely.
        // Preserve the original provenance across the streamer's retry (HIST-01).
        void track(() => runPipeline(p.task, currentProvenance));
        return;
      }
      // Re-run the build from the suggestion text WITHOUT re-screening — the
      // same semantics as the old approved-plan retry (UI-SPEC: "Retry runs the
      // build again"). The streamer explicitly chose retry, so no further
      // auto-retry — a second failure surfaces the decision again.
      const ac = new AbortController();
      active = { task: p.task, ac };
      registerAbort(taskId, ac);
      const planText = p.planText;
      void track(() => {
        deps.narrator?.stageBuilding(p.task.text);
        return runBuildAttempt(p.task, planText, ac, false);
      });
    },

    skipTask(taskId: string, reasonTag?: ReasonTag | null): void {
      const p = pending;
      if (!p || p.task.id !== taskId) return;
      pending = null;
      recordBuildSkip(deps.db, {
        taskId,
        streamMode: streamMode(),
        rationale: reasonTag
          ? `streamer skipped a failed/refused build (${reasonTag}) (D3-09)`
          : "streamer skipped a failed/refused build (D3-09)",
      });
      deps.narrator?.buildSkipped(p.task.text);
      // Collapse the overlay panel, return to IDLE, dequeue (T-03-22 clean exit).
      current = null;
      active = null;
      // ORDERING INVARIANT (quick-260716-t1n): a skipped task is never
      // discoverable in the queue once the machine leaves BUILD_IN_PROGRESS —
      // dequeue MUST precede the IDLE transition because STATE_CHANGED
      // handlers run synchronously inside it.
      deps.registry.unregister(taskId);
      deps.taskQueue.remove(taskId);
      try {
        if (deps.machine.mode === "BUILD_IN_PROGRESS") {
          deps.machine.transition("IDLE");
        }
        deps.machine.setActiveTask(null, null);
      } catch (err) {
        deps.logger?.error({ err, taskId }, "failed to return machine to IDLE after skip");
      }
      // snapshot() is now null → the overlay build panel collapses.
      emitter.emit(BUILD_STAGE_CHANGED);
      // quick-260717-093 (D093-2 c): the skip settles a failed/refused build
      // whose teardown killed the dev server (watchdog terminate, halt-path
      // teardown) — resurrect it now that the decision resolved.
      fireTeardownHook(p.task);
    },

    snapshot(): BuildStatusView | null {
      return current;
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    async close(): Promise<void> {
      queue.clear();
      pending = null;
      const inFlight = active;
      if (inFlight) {
        inFlight.ac.abort();
        try {
          await deps.sandboxAdapter.terminate();
        } catch (err) {
          deps.logger?.error({ err }, "sandbox teardown failed during orchestrator close");
        }
        deps.registry.unregister(inFlight.task.id);
        active = null;
      }
      // WR-05: drain the aborted pipeline HERE — before main.ts calls db.close()
      // — so its resumed teardown (finalizeAborted/finalize → recordPipelineStage)
      // runs while the db is still open and cannot leak an unhandled rejection.
      // Bounded so a stream that ignores the abort can never hang shutdown; the
      // auditIfOpen guard is the belt-and-suspenders if the drain times out and
      // the pipeline resumes after db.close().
      const draining = running;
      if (draining) {
        await Promise.race([
          draining.catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, CLOSE_DRAIN_MS);
            t.unref?.();
          }),
        ]);
      }
    },
  };
}
