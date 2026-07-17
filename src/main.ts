import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { type Logger, pino } from "pino";
import { openDb } from "./audit/db.js";
import { purgeOldAuditRecords } from "./audit/purge.js";
import {
  recordAutoCycleToggled,
  recordBuildHistory,
  recordChaosActivated,
  recordChaosExpired,
  recordChaosPick,
  recordChaosToggled,
  recordGalleryPublish,
  recordPoolDropped,
  recordProjectClosed,
  recordRevertOutcome,
  recordSoloPick,
  recordSwapOutcome,
  recordWorkspaceReset,
} from "./audit/record.js";
import { ChaosModeController } from "./chaos/mode.js";
import { pickChaos } from "./chaos/selector.js";
import { CATEGORY_META, isLegalCategory } from "./compliance/categories.js";
import type { ClassifierTransport } from "./compliance/classifier.js";
import { classify, type FakeClassifier, type GateDeps } from "./compliance/gate.js";
import {
  ControlWindow,
  ControlWindowError,
  type OpenWindowRequest,
} from "./control-window/control-window.js";
import {
  cooldownMs,
  loadDonationDurationConfig,
  loadRedemptionDurationConfig,
} from "./control-window/duration.js";
import { type HistoryServerHandle, startHistoryServer } from "./history/server.js";
import { type ChatMessageSink, createChatSender } from "./ingestion/chat-sender.js";
import type { InfoCommandKind } from "./ingestion/command-parser.js";
import {
  connectStreamElements,
  type DonationEventSource,
  type TipEvent,
} from "./ingestion/donation-source.js";
import { createNarrator, type Narrator } from "./ingestion/narration.js";
import {
  isMissingRedemptionScopeError,
  makeRedemptionSource,
  type RedemptionEvent,
  type RedemptionEventSource,
} from "./ingestion/redemption-source.js";
import { createSuggestIntake } from "./ingestion/suggest-intake.js";
import { type ChatEventSource, startTwitchChat } from "./ingestion/twitch-chat.js";
import { AbortRegistry, abortActiveWork } from "./kill-switch/abort.js";
import {
  type HotkeyHandle,
  type KeyEventSource,
  type PanicLogger,
  startHotkeyListener,
} from "./kill-switch/hotkey.js";
import {
  type ConsoleServerHandle,
  type DonationsStatus,
  startConsoleServer,
  type TwitchConnectionStatus,
} from "./operator-console/server.js";
import { isDestructiveIntent } from "./orchestrator/destructive-intent.js";
import { listGalleryIndexEntries } from "./orchestrator/gallery-index.js";
import {
  createGalleryPublisher,
  createProjectRepoStore,
  DEFAULT_GALLERY_OWNER,
  type GalleryPublisher,
  galleryIndexUrl,
  galleryPlayUrl,
  resolveGalleryConfig,
} from "./orchestrator/gallery-publisher.js";
import { type BuildSession, createBuildSession } from "./orchestrator/index.js";
import type {
  AgentRunner,
  DevServerProbe,
  ProgressSink,
  SandboxAdapter,
} from "./orchestrator/types.js";
import { createWorkspaceState } from "./orchestrator/workspace.js";
import { createBuilderFeed } from "./overlay/builder-feed.js";
import {
  type OverlayServerHandle,
  PLAYABLE_CHANGED,
  startOverlayServer,
} from "./overlay/server.js";
import { type ChaosPickResult, submitChaosPick } from "./pipeline/chaos.js";
import { submitDuringWindow } from "./pipeline/paid-window.js";
import { enqueueWinner } from "./pipeline/round.js";
import { type SubmitResult, submitCandidate } from "./pipeline/submit.js";
import { collectBroadcastSafetyWarnings } from "./preflight.js";
import { createDevServerSupervisor } from "./preview/dev-server-supervisor.js";
import { createPreviewManager, resolvePreviewDevServerPort } from "./preview/preview-manager.js";
import { type PreviewServerHandle, startPreviewServer } from "./preview/server.js";
import { CandidatePool } from "./queue/pool.js";
import { TaskQueue } from "./queue/task-queue.js";
import {
  HALT_TRIGGERED,
  ROUND_CLOSED,
  ROUND_OPENED,
  STATE_CHANGED,
  WINDOW_CLOSED,
  WINDOW_OPENED,
  WINDOW_REVOKED,
} from "./shared/events.js";
import type {
  BuildNarrator,
  BuildProvenance,
  ControlWindowSnapshot,
  GateResult,
  HaltContext,
  QueuedTask,
  RoundSnapshot,
  StateSnapshot,
  SuggestionCandidate,
} from "./shared/types.js";
import { AutoCycleScheduler } from "./state-machine/auto-cycle.js";
import { type HaltDeps, triggerHalt } from "./state-machine/halt.js";
import { expireAllPending, expireStale, reviewTtlMs } from "./state-machine/review-queue.js";
import { RoundManager } from "./state-machine/round.js";
import { StreamModeMachine } from "./state-machine/stream-mode.js";

/**
 * Outcome of a completed OAuth code exchange (CR-03): the console callback
 * page must be HONEST about whether chat is now live or a restart is needed.
 */
export interface TwitchAuthCompletion {
  /**
   * True when the fresh token was registered on the RUNNING chat pipeline's
   * auth provider (mid-session re-auth) — no restart needed. False =
   * first-time bootstrap: the token is persisted, but the chat pipeline is
   * composed at boot, so a restart is required to connect chat.
   */
  chatLive: boolean;
}

/** Console-facing OAuth seam — main.ts wires the twitch-auth module behind it. */
export interface TwitchAuthRoutes {
  authorizeUrl(state: string): string;
  complete(code: string): Promise<TwitchAuthCompletion>;
}

export interface CreateAppOptions {
  dbPath: string;
  port: number;
  /**
   * Public OBS overlay port (plan 02-05). Defaults to 0 (ephemeral) so test
   * apps never collide; the npm-run-dev entrypoint passes OVERLAY_PORT
   * (default 4901) — always a SEPARATE surface from the console (D2-17).
   */
  overlayPort?: number;
  /**
   * Test-injected classifier (vitest never talks to the network). When absent,
   * the live plan-billed Sonnet transport (classifierTransport) is used; with
   * neither, every submission fails closed (D-11).
   */
  fakeClassifier?: FakeClassifier;
  /**
   * Plan-billed classifier transport (Sonnet via the Agent SDK query() under
   * src/orchestrator/), built by the entrypoint's guarded dynamic import. Absent
   * in tests (a fakeClassifier is injected instead) and whenever the Agent SDK
   * fails to load — the gate then fails closed on every submission (D-2/D-11).
   */
  classifierTransport?: ClassifierTransport;
  /**
   * Chat seams (plan 02-04): when BOTH are present — injected test fakes or
   * the real twurple adapters built by the entrypoint branch — createApp
   * composes the FULL chat pipeline (sender → narrator → round-event
   * subscriptions → startTwitchChat → reconcile) itself. Test fakes and
   * production adapters share one code path, so plan 02-06's e2e proves the
   * production wiring without src edits.
   */
  chatSource?: ChatEventSource;
  chatSink?: ChatMessageSink;
  /** OAuth route deps passed through to the console server (D2-10). */
  twitchAuth?: TwitchAuthRoutes;
  /**
   * Build-orchestrator seams (plan 03-06): when BOTH agentRunner and
   * sandboxAdapter are present — injected test fakes or the real SDK/WSL2
   * adapters built by the entrypoint branch — createApp composes the full build
   * pipeline (build session → overlay build push → preview surface → winner
   * pickup) itself. Absent = no build engine (round winners sit in the queue);
   * the vote loop keeps running. Fakes and production adapters share one code
   * path, so the build-flow e2e proves the production wiring without src edits.
   */
  agentRunner?: AgentRunner;
  sandboxAdapter?: SandboxAdapter;
  /** Preview reachability probe (03-08); the entrypoint injects the real one. */
  devServerProbe?: DevServerProbe;
  /**
   * App-under-construction preview port (PRES-03). Defaults to 0 (ephemeral);
   * the entrypoint passes PREVIEW_PORT (default 4902) — always a SEPARATE
   * surface from the console + overlay (D3-12).
   */
  previewPort?: number;
  /**
   * Audience-facing build-history changelog port (HIST-01 / 05-02). Defaults to
   * 0 (ephemeral) so parallel test apps never collide; the entrypoint passes
   * HISTORY_PORT (default 4903) — always a SEPARATE surface from the console,
   * overlay, and preview (D-04). The history server is a pure read-over-db
   * surface, so it starts unconditionally (no external adapter needed).
   */
  historyPort?: number;
  /**
   * Paid-influence seams (plan 04-07): injected StreamElements donation source
   * and channel-points redemption source — test fakes (zero network) or the real
   * adapters the entrypoint builds. Both feed the SAME ControlWindow FSM. Absent
   * = that trigger is "unconfigured"; the vote loop keeps running (never a crash).
   */
  donationSource?: DonationEventSource;
  redemptionSource?: RedemptionEventSource;
  /**
   * Deterministic chaos-pick RNG (CHAOS-01) — injected in tests so a random pick
   * is reproducible. Absent = the production `node:crypto.randomInt` uniform pick.
   */
  chaosRng?: (max: number) => number;
  /**
   * Gallery snapshot publisher seam (quick-22l): injected fake in tests, the
   * real host-side git publisher from the entrypoint helper
   * (buildGalleryPublisher). ABSENT → no publishing at all — which is why the
   * fake-runner e2e suites stay inert by default. Only a build that finalizes
   * `done` ever reaches publishNow (build-session's onBuildDone seam).
   */
  galleryPublisher?: GalleryPublisher;
}

export interface AppHandle {
  server: ConsoleServerHandle["server"];
  port: number;
  machine: StreamModeMachine;
  db: Database.Database;
  logger: Logger;
  pool: CandidatePool;
  taskQueue: TaskQueue;
  /** Voting-round lifecycle manager (plans 02-04/02-05 and the e2e suite need it). */
  round: RoundManager;
  /** Public OBS overlay surface — separate server + port from the console (D2-17). */
  overlay: OverlayServerHandle;
  /** Phase 3's orchestrator registers agent-session PIDs/controllers here. */
  registry: AbortRegistry;
  /** Build-session orchestrator (BUILD-01) — present only when composed (agentRunner injected). */
  orchestrator?: BuildSession;
  /** App-under-construction preview surface (PRES-03) — present only when the orchestrator is composed. */
  preview?: PreviewServerHandle;
  /** Audience-facing build-history changelog surface (HIST-01) — always composed (read-over-db). */
  history: HistoryServerHandle;
  /** Paid/redemption control-window FSM (PAID-01/02/03/04) — always composed (04-07). */
  controlWindow: ControlWindow;
  /**
   * Chaos-mode controller (CHAOS-01): the on/off state + streamer toggle, plus
   * `pick()` — a uniform-random selection from the gate-filtered pool routed
   * through the sanctioned chaos funnel. Returns null when not in chaos mode or
   * the pool is empty.
   */
  chaos: {
    enabled(): boolean;
    toggle(): void;
    pick(): ChaosPickResult | null;
  };
  /** Hands-free round cadence scheduler (quick-t5k) — always composed. */
  autoCycle: AutoCycleScheduler;
  close: () => Promise<void>;
}

/** Review-expiry sweep cadence while the process is up (D-07). */
const REVIEW_SWEEP_INTERVAL_MS = 15 * 60_000;
/** Audit-purge cadence while the process is up (D-17). */
const PURGE_INTERVAL_MS = 24 * 3_600_000;

/** Env-knob idiom (review-queue.ts pattern): positive number or the default. */
function envPositive(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * quick-t8k swap-name normalization: the sanitizeRepoName transform MINUS the
 * dated fallback — lowercase, non-[a-z0-9] runs → "-", trim hyphens, cap 80.
 * An all-symbol name normalizes to "" (unresolvable), never a dated slug.
 * Pure + exported for the resolution-precedence tests.
 */
export function normalizeSwapName(text: string): string {
  let slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (slug.length > 80) {
    slug = slug.slice(0, 80).replaceAll(/-+$/g, "");
  }
  return slug;
}

/** One project_repos row as the swap resolver consumes it. */
export interface SwapTargetRow {
  generation: number;
  repo_name: string;
}

/**
 * quick-t8k swap resolution over ALL project_repos rows. Deterministic
 * precedence: exact > prefix > substring (case-insensitive against
 * repo_name). Within the winning tier, prefer NON-current matches (swapping
 * away is the intent — checker INFO b); ties break to the HIGHEST generation
 * (most recent wins). Returns the current-generation row ONLY when it is the
 * exclusive match at the winning tier (the caller narrates the honest
 * already-current line), and null when nothing matches. Pure + exported.
 */
export function resolveSwapTarget(
  rows: SwapTargetRow[],
  needle: string,
  currentGeneration: number,
): SwapTargetRow | null {
  if (needle.length === 0) return null;
  const tiers: Array<(name: string) => boolean> = [
    (name) => name === needle,
    (name) => name.startsWith(needle),
    (name) => name.includes(needle),
  ];
  for (const matchesTier of tiers) {
    const hits = rows.filter((row) => matchesTier(row.repo_name.toLowerCase()));
    if (hits.length === 0) continue;
    const nonCurrent = hits.filter((row) => row.generation !== currentGeneration);
    const pool = nonCurrent.length > 0 ? nonCurrent : hits;
    return pool.reduce((best, row) => (row.generation > best.generation ? row : best));
  }
  return null;
}

/**
 * D2-13 bounded pool, re-capped at 5 (quick-l2a user amendment): the pool, the
 * early-close threshold, and the vote-option draw all align at 5 by default —
 * a full pool becomes exactly one full vote round. Kept as SEPARATE knobs
 * (POOL_MAX_SIZE / EARLY_CLOSE_POOL_SIZE / ROUND_MAX_OPTIONS) so they can
 * diverge later.
 */
const DEFAULT_POOL_MAX_SIZE = 5;
/**
 * WR-07 (quick-22l): the single sandboxed build turn's watchdog budget in
 * seconds — env-tunable via BUILD_TURN_TIMEOUT_SECONDS. Default 900 (15 min):
 * the old hardcoded 5-min bound aborted a live, progressing build. Re-check at
 * the Phase 5 dry run (WR-07 judgment item). The fail-closed abort path in
 * build-session.ts is unchanged — only the budget is injected here.
 */
const DEFAULT_BUILD_TURN_TIMEOUT_SECONDS = 900;
const DEFAULT_INTAKE_COOLDOWN_SECONDS = 60;
const DEFAULT_CHAT_SEND_INTERVAL_CAP = 15;
const DEFAULT_CHAT_SEND_INTERVAL_MS = 30_000;
/** quick-t5k D-01: suggestion-collection window between voting rounds. */
const DEFAULT_SUGGEST_PHASE_SECONDS = 40;
/**
 * quick-l2a: pool size that ends an active suggest phase early — voting starts
 * the moment this many approved suggestions are pooled, through the SAME
 * eligibility-checked phase-end path as timer expiry. A named knob of its own
 * (EARLY_CLOSE_POOL_SIZE) even though it defaults equal to POOL_MAX_SIZE and
 * ROUND_MAX_OPTIONS — the three can diverge later.
 */
const DEFAULT_EARLY_CLOSE_POOL_SIZE = 5;
/** VOTE_QUEUE_MAX amendment: pause new rounds when this many vote winners wait. */
const DEFAULT_VOTE_QUEUE_MAX = 10;
/**
 * quick-t8k: global per-command cooldown for the tier-2 info commands
 * (!projects/!current/!repo/!help). One reply per command per window;
 * suppressed repeats are SILENT (D2-15). Env knob INFO_COMMAND_COOLDOWN_SECONDS.
 */
const DEFAULT_INFO_COMMAND_COOLDOWN_SECONDS = 30;
/** quick-rs3: how long an activated chaos window lasts before auto-revert. */
const DEFAULT_CHAOS_MODE_DURATION_SECONDS = 300;

/**
 * Wires the Walking Skeleton: audit db -> state machine -> operator console.
 * Exported factory so the e2e suite can start a real server on an ephemeral
 * port with an in-memory db. pino is operational logging only — the SQLite
 * audit ledger is the compliance record of truth (COMP-05).
 */
export async function createApp(opts: CreateAppOptions): Promise<AppHandle> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

  // Broadcast-safety preflight (security review #8): warn LOUDLY at boot if any
  // test/tuning knob that is unsafe on air is still active. Warn-only — never
  // blocks boot (a streamer may want a non-default value).
  for (const w of collectBroadcastSafetyWarnings(process.env)) {
    logger.warn({ knob: w.key, value: w.value }, "BROADCAST-SAFETY: %s — %s", w.key, w.message);
  }

  if (opts.dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  }
  const db = openDb(opts.dbPath);
  const machine = new StreamModeMachine();
  const registry = new AbortRegistry();
  // quick-0iu: ONE persistent-workspace state for the whole app — the SAME
  // WorkspaceView is wired into the build session (scaffold/continue + dir)
  // AND the operator console ("New project" rotation). SQLite-backed so the
  // generation/scaffolded state survives a mid-stream crash.
  const workspace = createWorkspaceState(db);
  // Bounded pool (D2-13): past POOL_MAX_SIZE the oldest candidate drops with
  // an audit row — memory stays bounded under a !suggest flood.
  const pool = new CandidatePool({
    maxSize: envPositive(process.env.POOL_MAX_SIZE, DEFAULT_POOL_MAX_SIZE),
    onEvict: (item) =>
      recordPoolDropped(db, { candidate: item.candidate, streamMode: machine.mode }),
  });
  const taskQueue = new TaskQueue();
  // Pre-classification intake limits (D2-11 — closes T-01-11).
  const intakeCooldownSeconds = envPositive(
    process.env.INTAKE_COOLDOWN_SECONDS,
    DEFAULT_INTAKE_COOLDOWN_SECONDS,
  );
  const intake = createSuggestIntake({
    pool,
    cooldownMs: intakeCooldownSeconds * 1_000,
    maxPooledPerUser: envPositive(process.env.INTAKE_MAX_POOLED_PER_USER, 1),
  });

  // Session-start hygiene, BEFORE the console accepts a single request:
  // D-07 clean slate (every leftover pending review expires as
  // expired-unreviewed, one audit row each) + D-17 rolling audit purge.
  const expired = expireAllPending(db, machine.mode);
  const purged = purgeOldAuditRecords(db);
  logger.info({ expired, purged }, "session-start hygiene: review expiry + audit purge");

  // While the process is up: sweep review TTL expiries and re-purge daily.
  // unref'd so neither timer keeps the event loop alive on shutdown.
  const reviewSweepTimer = setInterval(() => {
    const swept = expireStale(db, reviewTtlMs(), machine.mode);
    if (swept > 0) logger.info({ swept }, "review TTL sweep expired pending items (D-07)");
  }, REVIEW_SWEEP_INTERVAL_MS);
  reviewSweepTimer.unref();
  const purgeTimer = setInterval(() => {
    purgeOldAuditRecords(db);
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  // Build-orchestrator handles, declared early so the HALT_TRIGGERED handler and
  // the console-server late-binding closures below can capture them before the
  // orchestrator is composed further down (only when an agentRunner is injected).
  let orchestrator: BuildSession | undefined;
  let preview: PreviewServerHandle | undefined;
  // The build-event narrator, assigned inside the chat-pipeline block below (only
  // when a chatSource/chatSink pair exists). Absent → build beats are silent-safe.
  let buildNarrator: BuildNarrator | undefined;
  // CR-03/WR-01: late-bound build triggers for paid-window instructions and chaos
  // picks — assigned in the orchestrator composition block below (only when a
  // build engine is composed). They mirror onWinnerQueued: synchronously enter
  // BUILD_IN_PROGRESS and hand the queued task to buildSession.startBuild, then on
  // completion return to the originating mode to drain the next instruction/pick
  // (D-12). Each returns true when a build actually STARTED (vs merely queued
  // behind an in-flight build), so narration stays honest. Null until a build
  // engine exists → the task sits queued (the pre-04 degraded behavior).
  let driveWindowBuild: ((taskId: string) => boolean) | null = null;
  let driveChaosBuild: ((taskId: string) => boolean) | null = null;
  // quick-t8k late-bound preview re-root seam (the windowNarrator idiom): the
  // default is a SILENT no-op until the preview dev-server supervisor composes
  // (only when a method-bearing sandbox adapter exists). Invoked at every
  // generation change — console new-project, project-switch rotation, and
  // swap activation.
  let reRootPreview: () => void = () => {};

  // ── Playable-link state (quick-260716-g8p) ────────────────────────────────
  // ONE resolved gallery owner for every URL surface (quick-1ki note: never
  // duplicate URL construction) — the chat info commands and the post-publish
  // announce both read this. Public data, not a credential.
  const galleryOwner = (process.env.GALLERY_GITHUB_OWNER ?? "").trim() || DEFAULT_GALLERY_OWNER;
  // The just-published build's playable Pages URL, or null. Set by the
  // announce path (build block below) after a CONFIRMED publish; cleared the
  // moment the NEXT build starts so a stale link never rides into that
  // build's done beat. An OBS reconnect just resends the current truth.
  let playableUrl: string | null = null;
  const playableEvents = new EventEmitter();
  machine.on(STATE_CHANGED, () => {
    if (machine.mode === "BUILD_IN_PROGRESS" && playableUrl !== null) {
      playableUrl = null;
      playableEvents.emit(PLAYABLE_CHANGED);
    }
  });

  // ── Chat-voted chaos mode controller (quick-260711-ly4, RS3-01..RS3-05) ──
  // A timed vote-skip window opened when the server-composed CHAOS ballot option
  // WINS a normal vote round — DISTINCT from the console CHAOS_MODE machine
  // toggle below: this mode never transitions the machine (the suggest cycle
  // keeps running; only the vote round is skipped at window close). State is
  // IN-MEMORY ONLY, deliberately unpersisted — a process that crashes mid-chaos
  // reboots into democratic mode, the safe default for a live show. Composed
  // BEFORE the HALT_TRIGGERED handler below: the boot-restore path (a frozen
  // round) force-transitions to HALTED during composition, and that handler
  // clears chaos. onActivated narrates the chaos-wins beat through the
  // late-bound windowNarrator (silent-safe until the chat block assigns it); the
  // audit row is written in the drainVoteQueue chaos arm, where the winning
  // candidate's task id is in scope.
  const chaosModeDurationMs =
    envPositive(process.env.CHAOS_MODE_DURATION_SECONDS, DEFAULT_CHAOS_MODE_DURATION_SECONDS) *
    1_000;
  const chaosMode = new ChaosModeController({
    durationMs: chaosModeDurationMs,
    onActivated: () => {
      windowNarrator?.chaosActivated(chaosModeDurationMs);
    },
    onExpired: () => {
      // db.open guard mirrors auditIfOpen (WR-05 shutdown drain) — the unref'd
      // expiry timer must never write against a closed db.
      if (db.open) recordChaosExpired(db, { streamMode: machine.mode });
      windowNarrator?.chaosExpired();
    },
    logger,
  });

  machine.on(HALT_TRIGGERED, (...args) => {
    const ctx = args[0] as HaltContext;
    logger.warn(
      { source: ctx.source, priorMode: ctx.frozen.mode, reasonTag: ctx.reasonTag },
      "HALT triggered",
    );
    // D3-10: a halt that froze an in-flight build is a veto-abort — narrate it on
    // chat (the honest word stays on the console; the overlay stays coarse/amber).
    // The abortActiveWork fan-out (registered controller + sandboxTeardown) runs
    // decoupled from this line; HALTED is already reached (Phase 1 D-02).
    if (ctx.frozen.mode === "BUILD_IN_PROGRESS") {
      const building = orchestrator?.snapshot();
      if (building) buildNarrator?.buildVetoed(building.title);
    }
    // quick-rs3 (RS3-04): chaos never survives a halt — tally AND active
    // window die here; recovery restores DEMOCRATIC mode. (chaosMode is
    // composed just above, so even the boot-restore forced HALT is safe.)
    chaosMode.clear();
  });

  // Compliance-gate deps: injected fake in tests; live plan-billed Sonnet
  // transport (Agent SDK query() via `claude login`) otherwise; neither ->
  // classify() fails closed (D-11).
  const classifierTransport = opts.fakeClassifier ? null : (opts.classifierTransport ?? null);
  if (!opts.fakeClassifier && !classifierTransport) {
    logger.warn(
      "COMPLIANCE CLASSIFIER UNAVAILABLE — no plan-billed transport wired; the gate will FAIL CLOSED on every submission until `claude login` / plan credentials are available",
    );
  }
  const gateDeps: GateDeps = {
    db,
    logger,
    streamModeProvider: () => machine.mode,
    ...(opts.fakeClassifier ? { fakeClassifier: opts.fakeClassifier } : {}),
    ...(classifierTransport ? { classifier: { transport: classifierTransport, logger } } : {}),
  };

  // Shared re-classification path (D2-05): a stale pool winner OR a stale chaos
  // pick re-enters the ONE funnel (submitCandidate) instead of riding an aged
  // approval. Reused by the round funnel and the chaos controller below.
  const resubmit = (candidate: SuggestionCandidate): SubmitResult =>
    submitCandidate(
      { db, mode: () => machine.mode, pool, classify: (cand) => classify(gateDeps, cand), logger },
      candidate,
    );

  // Voting rounds (CHAT-02). The injected wrapper is RoundManager's ONLY
  // bridge to the build queue (COMP-01): it maps the manager's third callback
  // argument — the winner's PERSISTED round_candidates.pooled_at_ms — onto
  // ApprovedCandidate.addedAtMs, which is what makes the D2-05 staleness
  // branch operational in production. Stale winners re-enter submitCandidate
  // for full re-classification instead of riding their old approval.
  // Assigned once the build orchestrator is composed below (only when an
  // agentRunner is injected). Fired SYNCHRONOUSLY from inside closeRound while
  // the machine is still VOTING_ROUND, so the VOTING_ROUND→BUILD_IN_PROGRESS
  // transition is legal (IDLE→BUILD_IN_PROGRESS is not — stream-mode.ts D-02)
  // and closeRound's own "if VOTING_ROUND → IDLE" step is skipped.
  let onWinnerQueued: ((taskId: string) => void) | null = null;
  const round = new RoundManager({
    db,
    machine,
    pool,
    logger,
    enqueueWinner: (candidate, result, pooledAtMs) => {
      const outcome = enqueueWinner(
        {
          taskQueue,
          db,
          mode: () => machine.mode,
          resubmit,
          logger,
        },
        { candidate, result, addedAtMs: pooledAtMs },
      );
      if (outcome.queued) onWinnerQueued?.(candidate.id);
      return outcome;
    },
  });
  // D2-14 ordering contract: restore persisted round state BEFORE any surface
  // (console route, chat listener) can accept input. A round that expired
  // during downtime closes here; a frozen round waits for triage.
  round.restore();
  // 02-03 flagged gap (Rule 2): restore() rebuilds the round but the fresh
  // StreamModeMachine stays IDLE, and recordVote() requires VOTING_ROUND —
  // chat votes on a restored round would be silently refused. Re-enter
  // VOTING_ROUND for a live (non-frozen) restored round via the machine's
  // own transition API; a frozen round stays put for recovery triage.
  {
    const restored = round.snapshot();
    if (restored?.status === "open" && restored.frozen) {
      // CR-01: a frozen round means the streamer halted mid-round and the
      // process died before triage finished. The halt context itself is not
      // persisted, so RE-ENTER HALTED at boot with a synthesized context
      // whose frozen.mode is VOTING_ROUND — the D-04 triage view renders and
      // BOTH exits work exactly as they do for a live halt: Resume →
      // HALTED→VOTING_ROUND (the frozen remainder re-arms), Reset to Idle →
      // HALTED→IDLE (discard: row → 'discarded' with an audit row,
      // candidates repooled, votes kept in the ledger). A restart must never
      // silently un-halt a stream the streamer explicitly halted (D-04:
      // nothing auto-resumes — the streamer decides).
      const bootHaltContext: HaltContext = {
        // The original halt's source is unknown after a restart; the console
        // is the surface where triage happens, so it is the least-wrong tag.
        source: "console",
        reasonTag: null,
        frozen: {
          mode: "VOTING_ROUND",
          activeTaskId: null,
          activeTaskPid: null,
          queuedTaskIds: [],
          haltContext: null,
        },
      };
      machine.forceTransition("HALTED", bootHaltContext);
      logger.warn(
        { roundId: restored.roundId },
        "frozen round restored at boot — re-entering HALTED for recovery triage (resume or discard)",
      );
    } else if (restored?.status === "open" && !restored.frozen && machine.mode === "IDLE") {
      machine.transition("VOTING_ROUND");
      logger.info(
        { roundId: restored.roundId },
        "restored round is live — stream mode re-entered VOTING_ROUND",
      );
    }
  }

  // ── Control-window FSM (Phase 4 PAID-01/02/03/04) ──────────────────────
  // ONE FSM backs both donation and channel-points windows (D-03). The paid
  // funnel (submitDuringWindow, 04-06) is INJECTED — control-window.ts never
  // imports the gate or the queue directly (T-04-09, the paid side of the D-08
  // separation). restore() runs at startup BEFORE any donation/redemption
  // listener accepts events (mirrors round.restore()): a window whose deadline
  // passed during downtime closes as expired; a live one re-arms for the exact
  // REMAINDER (crash-safe, PAID-04).
  const controlWindow = new ControlWindow({
    db,
    machine,
    submitDuringWindow: (candidate) =>
      submitDuringWindow(
        { taskQueue, classify: (c) => classify(gateDeps, c), mode: () => machine.mode, logger },
        candidate,
      ),
    donationConfig: loadDonationDurationConfig(),
    redemptionConfig: loadRedemptionDurationConfig(),
    cooldownMs: cooldownMs(),
    logger,
  });
  controlWindow.restore();
  // IN-01: a window restored LIVE on boot needs its "30 seconds left" beat
  // re-armed. The narrator isn't composed until the chat block below, so capture
  // the restored window here and arm the beat there once windowNarrator exists.
  const restoredWindow = controlWindow.snapshot();

  // The show narrator is composed inside the chat block below (only when a
  // chatSource/chatSink pair exists). Window/chaos beats route through it when
  // present; absent → silent-safe (mirrors buildNarrator).
  let windowNarrator: Narrator | undefined;

  // Donation-feed health for the console pill (04-RESEARCH OQ1 — never silent).
  let donationsStatus: DonationsStatus = "unconfigured";

  // 30-seconds-left beat (windows ≥ 60s). One window at a time → one timer,
  // unref'd so it never keeps the process alive.
  let windowThirtyTimer: NodeJS.Timeout | null = null;
  const clearWindowThirtyBeat = (): void => {
    if (windowThirtyTimer !== null) {
      clearTimeout(windowThirtyTimer);
      windowThirtyTimer = null;
    }
  };
  const armWindowThirtyBeat = (donor: string, durationMs: number): void => {
    clearWindowThirtyBeat();
    if (durationMs >= 60_000) {
      windowThirtyTimer = setTimeout(() => {
        windowThirtyTimer = null;
        windowNarrator?.window30sLeft(donor);
      }, durationMs - 30_000);
      windowThirtyTimer.unref();
    }
  };

  // Window lifecycle narration: natural expiry / streamer revoke (never silent).
  // A DIRECT open's WINDOW_OPENED is narrated at the open() call site instead
  // (it needs the amount/reward the coarse snapshot deliberately drops), so it
  // is NOT re-narrated here — avoiding a double beat.
  controlWindow.on(WINDOW_CLOSED, (...args) => {
    clearWindowThirtyBeat();
    const snap = args[0] as ControlWindowSnapshot;
    windowNarrator?.windowExpired(snap.donorDisplayName);
  });
  controlWindow.on(WINDOW_REVOKED, (...args) => {
    clearWindowThirtyBeat();
    // quick-260716-h73: a PENDING discard (console revoke of a banked window,
    // or the halt-recovery discard — which fires on the recover-to-IDLE beat by
    // design) carries the pending snapshot; narrate the honest cancelled beat.
    // An active-window revoke keeps its existing line. clearWindowThirtyBeat
    // stays unconditional above (a pending never armed one — harmless).
    const snap = args[0] as ControlWindowSnapshot | undefined;
    if (snap?.pending) windowNarrator?.windowPendingCancelled(snap.donorDisplayName);
    else windowNarrator?.windowRevoked();
  });
  // quick-260716-h73: a PROMOTED open (a banked window opening on the return
  // to IDLE) is narrated HERE — the FSM emits WINDOW_OPENED with a second arg
  // { fromPending: true } as the discriminator; direct open() keeps its
  // single-arg emit, so this handler no-ops for it (no double beat). This
  // subscription sits AFTER controlWindow.restore() above (IN-01 precedent):
  // a boot-restore promotion emits before it exists, so it cannot narrate or
  // double-arm the 30s beat alongside the restoredWindow re-arm block below —
  // exactly one 30s timer is ever live (armWindowThirtyBeat clears first, and
  // only ONE arm site runs per open).
  controlWindow.on(WINDOW_OPENED, (...args) => {
    const meta = args[1] as { fromPending?: boolean } | undefined;
    if (meta?.fromPending !== true) return; // direct opens narrate at the call site
    const snap = args[0] as ControlWindowSnapshot;
    windowNarrator?.windowOpenedFromPending(snap.donorDisplayName, snap.durationMs);
    armWindowThirtyBeat(snap.donorDisplayName, snap.durationMs);
  });

  // Map a validated donation/redemption event → a normalized OpenWindowRequest →
  // controlWindow.open(). A ControlWindowError (already-active / cooldown /
  // not-idle) narrates the denial and returns — never silent (D-05). This
  // mapping lives HERE at the composition root so control-window.ts stays free
  // of ingestion imports.
  const openWindowFromDonation = (tip: TipEvent): void => {
    const request: OpenWindowRequest = {
      trigger: "donation",
      donorIdentifier: tip.username,
      donorDisplayName: tip.displayName,
      amountOrCost: tip.amount,
      currency: tip.currency,
    };
    try {
      const snap = controlWindow.open(request);
      // quick-260716-h73: a BANKED window (machine was busy) narrates the
      // pending beat and arms NOTHING — the 30s beat belongs to the promoted
      // open (the WINDOW_OPENED { fromPending: true } handler above).
      if (snap.pending) {
        windowNarrator?.windowPendingDonation(
          tip.displayName,
          `${tip.amount.toFixed(2)} ${tip.currency.toUpperCase()}`,
          snap.durationMs,
        );
        return;
      }
      // WR-02: narrate the ACTUAL currency (ISO code), never a hardcoded "$".
      windowNarrator?.windowOpenedDonation(
        tip.displayName,
        `${tip.amount.toFixed(2)} ${tip.currency.toUpperCase()}`,
        snap.durationMs,
      );
      armWindowThirtyBeat(tip.displayName, snap.durationMs);
    } catch (err) {
      if (err instanceof ControlWindowError) {
        // CR-01: narrate the TRUE reason — a not-idle denial is not a
        // "window already running" (no window is live; a round/build is).
        if (err.reason === "cooldown") windowNarrator?.windowDeniedCooldown(tip.displayName);
        else if (err.reason === "not-idle") windowNarrator?.windowDeniedNotIdle(tip.displayName);
        else if (err.reason === "window-pending")
          windowNarrator?.windowDeniedPending(tip.displayName);
        else windowNarrator?.windowDeniedActive(tip.displayName);
        return;
      }
      throw err;
    }
  };
  const openWindowFromRedemption = (redemption: RedemptionEvent): void => {
    const request: OpenWindowRequest = {
      trigger: "channel_points",
      donorIdentifier: redemption.user_id,
      donorDisplayName: redemption.user_name,
      amountOrCost: redemption.reward.cost,
    };
    try {
      const snap = controlWindow.open(request);
      // quick-260716-h73: banked redemption → pending beat, no 30s arm (see
      // openWindowFromDonation).
      if (snap.pending) {
        windowNarrator?.windowPendingChannelPoints(
          redemption.user_name,
          redemption.reward.title,
          snap.durationMs,
        );
        return;
      }
      windowNarrator?.windowOpenedChannelPoints(
        redemption.user_name,
        redemption.reward.title,
        snap.durationMs,
      );
      armWindowThirtyBeat(redemption.user_name, snap.durationMs);
    } catch (err) {
      if (err instanceof ControlWindowError) {
        // CR-01: honest not-idle copy (see openWindowFromDonation).
        if (err.reason === "cooldown") windowNarrator?.windowDeniedCooldown(redemption.user_name);
        else if (err.reason === "not-idle")
          windowNarrator?.windowDeniedNotIdle(redemption.user_name);
        else if (err.reason === "window-pending")
          windowNarrator?.windowDeniedPending(redemption.user_name);
        else windowNarrator?.windowDeniedActive(redemption.user_name);
        return;
      }
      throw err;
    }
  };

  // ── Chaos mode (CHAOS-01, D-05 precedence, D-08 separation) ─────────────
  // toggle() drives IDLE↔CHAOS_MODE (InvalidTransitionError bubbles to the
  // console route's 409 when precedence forbids the flip). pick() pulls a
  // uniform selection from the gate-filtered pool and routes it through the
  // SANCTIONED chaos funnel (submitChaosPick, 04-06) — never a direct enqueue
  // here. The chaos side references RNG (pickChaos) but no payment event; the
  // paid side above references payment but no RNG (D-08).
  let chaosOn = false;
  const chaos = {
    enabled: (): boolean => chaosOn,
    toggle: (): void => {
      if (!chaosOn) {
        machine.transition("CHAOS_MODE");
        chaosOn = true;
      } else {
        machine.transition("IDLE");
        chaosOn = false;
      }
      recordChaosToggled(db, { enabled: chaosOn, streamMode: machine.mode });
      if (chaosOn) {
        windowNarrator?.chaosOn();
        // WR-01: chaos mode now has a REAL production trigger. On toggle-ON, if
        // the filtered pool is non-empty, pick immediately to kick off the loop
        // (an empty pool picks nothing — no spin). `chaos` is initialized by the
        // time toggle is ever called, so the self-reference is safe.
        chaos.pick();
      } else windowNarrator?.chaosOff();
    },
    pick: (): ChaosPickResult | null => {
      if (machine.mode !== "CHAOS_MODE") return null;
      // quick-q5n: a chaos "random build" must be a buildable prompt — routing
      // verbs (project-switch/revert) are vote-only, so filter them out here
      // (selector.ts untouched, preserving the paid↔chaos source-scan invariant).
      //
      // TWO-CALL-SITE DOCTRINE (quick-rs3): THIS console-toggle site KEEPS the
      // kind === "suggestion" filter because its picks bypass the kind router
      // (submitChaosPick → driveChaosBuild → raw startBuild — a routing verb
      // here would reach the build agent as prompt text). The chat-activated
      // site (chaosModePick below) has NO kind filter because its picks route
      // through drainVoteQueue's kind router, where every kind executes
      // correctly. Rule: kind-filter exactly when the consumer is the raw
      // build agent; no filter when the consumer is the kind router.
      const picked = pickChaos(
        pool.list().filter((c) => c.candidate.kind === "suggestion"),
        opts.chaosRng,
      );
      if (picked === null) return null; // empty pool → no pick, never a busy-loop
      const result = submitChaosPick(
        { taskQueue, mode: () => machine.mode, resubmit, logger },
        picked,
      );
      if (result.queued) {
        // Consume the pick from the pool so the loop drains and never re-picks
        // the same candidate forever (progress guarantee for the D-12-style loop).
        pool.remove(picked.candidate.id);
        recordChaosPick(db, {
          taskId: picked.candidate.id,
          title: picked.candidate.text,
          streamMode: machine.mode,
        });
        windowNarrator?.chaosPick(picked.candidate.text);
        // CR-03/WR-01: actually BUILD the pick (mirrors the winner path). A no-op
        // until a build engine is composed.
        driveChaosBuild?.(picked.candidate.id);
      }
      return result;
    },
  };

  // ── Chat-voted chaos mode closures (quick-260711-ly4, RS3-01..RS3-05) ────
  // The ChaosModeController itself is composed EARLY (above the HALT handler —
  // the boot-restore path can force HALTED mid-composition); the vote-skip pick
  // closure lives here where resubmit/pool/enqueueWinner are in scope. The
  // !chaos dispatch is now the shared submission path in twitch-chat.ts (a
  // server-composed CHAOS candidate competing in the vote); the window opens via
  // chaosMode.activate() in the drainVoteQueue chaos arm when it WINS.

  // The vote-skip pick closure (AutoCycleScheduler's chaosModePick dep). Runs
  // BEHIND the scheduler's eligibility check, so HALT parking and FREE REIGN
  // precedence come free. Returns:
  //   null    — chaos window not live (or halted) → democratic phase end;
  //   "empty" — chaos owns the phase end, nothing eligible → window restarts;
  //   "picked"— one pooled candidate entered the queue via the SAME sanctioned
  //             winner funnel a voted win uses (enqueueWinner → onWinnerQueued
  //             → drainVoteQueue's kind router) — zero new routing code.
  const chaosModePick = (): "picked" | "empty" | null => {
    const chaosSnapshot = chaosMode.snapshot();
    if (chaosSnapshot === null || chaosSnapshot.endsAtMs <= Date.now()) return null;
    if (machine.mode === "HALTED") return null; // belt-and-braces — enqueueWinner also refuses
    // PAYMENT↔CHANCE ALLOWLIST (T-rs3-05): written as an ALLOWLIST (chat |
    // operator) so no payment token ever needs to appear near the chaos path —
    // a paid-source candidate can never be chaos-picked, and the
    // paid-chaos-separation source scan stays structurally green.
    const eligible = pool
      .list()
      .filter((c) => c.candidate.source === "chat" || c.candidate.source === "operator");
    // NO kind filter here — see the two-call-site doctrine at chaos.pick()
    // above: these picks ride drainVoteQueue's kind router, where a
    // project-switch ships-then-rotates gated on confirmed publish and a
    // revert reverts. Randomness stays injectable (opts.chaosRng, CHAOS-01).
    const picked = pickChaos(eligible, opts.chaosRng);
    if (picked === null) return "empty"; // chaos owns the phase end; window restarts
    const outcome = enqueueWinner(
      { taskQueue, db, mode: () => machine.mode, resubmit, logger },
      picked,
    );
    if (outcome.queued) {
      pool.remove(picked.candidate.id);
      recordChaosPick(db, {
        taskId: picked.candidate.id,
        title: picked.candidate.text,
        kind: picked.candidate.kind,
        streamMode: machine.mode,
      });
      windowNarrator?.chaosModePicked(picked.candidate.text);
      // PROVENANCE ACK (checker INFO 1 — NOT a T-05-03 mis-attribution, do not
      // "fix"): a chaos-picked suggestion's build_history provenance reads
      // "vote" because drainVoteQueue's default arm hardcodes
      // startBuild(head, "vote") — inherent to riding the SAME winner rail a
      // voted win rides. The TRUE origin is the chaos_pick audit row above
      // (candidate id + kind in `decision`).
      onWinnerQueued?.(picked.candidate.id);
    } else if (outcome.reason === "stale-reclassified") {
      // Pitfall 3 / D2-05: a stale pick re-entered the full gate via resubmit —
      // narrated, never a silent re-roll.
      windowNarrator?.chaosPickRecheck();
    }
    // outcome "halted" → nothing: the halt itself is already narrated.
    return "picked";
  };

  // The single-suggestion auto-build hook (AutoCycleScheduler's soloPick dep,
  // quick-260711-ly4). Consulted at phase end on the DEMOCRATIC path
  // (chaosModePick returned null) ONLY when the pool holds EXACTLY ONE candidate
  // — a 1-option vote is meaningless, so that lone candidate is built directly
  // through the SAME sanctioned winner funnel a voted/chaos win uses
  // (enqueueWinner → onWinnerQueued → drainVoteQueue's kind router — zero new
  // routing). Precedence stays FREE REIGN > CHAOS > (democratic: solo-if-1 /
  // vote-if-2+). Returns:
  //   "empty" — nothing eligible to build (defensive; the scheduler only calls
  //             this at pool size 1) → the window restarts;
  //   "picked"— the lone candidate entered the queue via the winner funnel.
  const soloPick = (): "picked" | "empty" | null => {
    if (machine.mode === "HALTED") return "empty"; // belt-and-braces — enqueueWinner also refuses
    const pooled = pool.list();
    if (pooled.length !== 1) return "empty"; // defensive — the scheduler only calls at size 1
    const solo = pooled[0];
    if (solo === undefined) return "empty";
    // quick-260711-ly4: a LONE CHAOS candidate must NEVER auto-activate
    // unopposed — chaos only ever opens by WINNING a real multi-option vote.
    // Excluding it here makes a pool holding only the CHAOS option behave as
    // empty: the window restarts (stillCollecting) until a real idea joins,
    // then they compete in a normal round.
    if (solo.candidate.kind === "chaos") return "empty";
    // Source ALLOWLIST parity with the chaos path (T-rs3-05): a pool candidate is
    // always chat/operator by construction, but only enqueue chat/operator so no
    // payment token can ever appear near this path (source scan stays clean). This
    // is the democratic path, NOT a chance/paid window — safety-and-parity only.
    if (solo.candidate.source !== "chat" && solo.candidate.source !== "operator") return "empty";
    const outcome = enqueueWinner(
      { taskQueue, db, mode: () => machine.mode, resubmit, logger },
      solo,
    );
    if (outcome.queued) {
      pool.remove(solo.candidate.id);
      recordSoloPick(db, {
        taskId: solo.candidate.id,
        title: solo.candidate.text,
        kind: solo.candidate.kind,
        streamMode: machine.mode,
      });
      windowNarrator?.soloPicked(solo.candidate.text);
      // PROVENANCE ACK (same as the chaos path): a solo-built suggestion's
      // build_history provenance reads "vote" because drainVoteQueue's default
      // arm hardcodes startBuild(head, "vote") — inherent to riding the SAME
      // winner rail. The TRUE origin is the solo_pick audit row above.
      onWinnerQueued?.(solo.candidate.id);
    } else if (outcome.reason === "stale-reclassified") {
      // D2-05: a stale lone pick re-entered the full gate via resubmit —
      // narrated (neutral recheck copy, never mis-attributed to chaos), never a
      // silent re-roll.
      windowNarrator?.soloPickRecheck();
    }
    // outcome "halted" → nothing: the halt itself is already narrated.
    return "picked";
  };

  // ── Auto-cycle scheduler (quick-t5k D-01..D-04, A1) ─────────────────────
  // Hands-free [suggest → vote → enqueue → suggest] cadence. Composed here so
  // both the console (toggle route/pill) and the overlay (suggestPhase
  // guidance) receive its seams below; start() is called at the END of
  // composition so a boot into HALTED or a restored VOTING_ROUND parks it
  // correctly. Narration is late-bound through windowNarrator (silent-safe
  // when no chat pipeline is composed — the existing idiom).
  const suggestPhaseSeconds = envPositive(
    process.env.SUGGEST_PHASE_SECONDS,
    DEFAULT_SUGGEST_PHASE_SECONDS,
  );
  // D-04 strict-string (SE_ACCEPT_TEST_EVENTS comment style, inverted default):
  // auto-cycle is ON at boot unless the EXACT trimmed string "false" — any
  // other value (including "0"/"FALSE"/blank) leaves it enabled.
  const autoRoundEnabled = (process.env.AUTO_ROUND_ENABLED ?? "").trim() !== "false";
  // quick-260716-fdl strict-string (the AUTO_ROUND_ENABLED idiom above): the
  // vote WAITS for an in-progress build by default — only the EXACT trimmed
  // string "false" restores voting-while-building pipelining (VOTE_QUEUE_MAX
  // then governs, as before).
  const voteWaitsForBuild = (process.env.VOTE_WAITS_FOR_BUILD ?? "").trim() !== "false";
  const voteQueueMax = envPositive(process.env.VOTE_QUEUE_MAX, DEFAULT_VOTE_QUEUE_MAX);
  // Vote-origin tasks came through the pool/round loop ("chat"/"operator" —
  // dev submits included). Window instructions carry their window's trigger
  // ("donation"/"channel_points" — see routeWindowInstruction below), so a
  // dead-window leftover at the queue head is identifiable: the drain skips
  // it rather than mislabelling its build_history provenance as 'vote'
  // (checker residual note); the streamer can veto it via /api/tasks/:id/veto.
  const isVoteOrigin = (task: QueuedTask): boolean =>
    task.source === "chat" || task.source === "operator";
  // VOTE_QUEUE_MAX amendment: the count includes a currently-building vote task
  // (it stays queued until finalize dequeues it) — a deliberate conservative
  // off-by-one. Manual round starts are NOT capped (operator override).
  const isVoteQueueFull = (): boolean =>
    taskQueue.list().filter(isVoteOrigin).length >= voteQueueMax;
  const autoCycle = new AutoCycleScheduler({
    machine,
    round: { snapshot: () => round.snapshot(), on: (event, handler) => round.on(event, handler) },
    startRound: (initiator) => round.startRound(initiator),
    isControlWindowLive: () => {
      // quick-260716-h73: a PENDING window makes the scheduler ineligible too —
      // the promoted window must deterministically beat the parked/next vote
      // round. TWO mechanisms make the race deterministic: (1) this predicate —
      // #isEligible AND #resumeFromWait both consult it, exactly the way chaos
      // is consulted, so "pending exists" parks the cadence; (2) subscription
      // order — ControlWindow's STATE_CHANGED handler (constructed above) runs
      // BEFORE this scheduler's, so on the BUILD→IDLE transition the promote
      // has already landed and the mode is FREE_REIGN_WINDOW by the time the
      // scheduler re-checks.
      const s = controlWindow.snapshot();
      return (s !== null && s.endsAtMs > Date.now()) || controlWindow.pendingSnapshot() !== null;
    },
    isChaosOn: () => chaos.enabled(),
    isVoteQueueFull,
    // quick-260716-fdl: default ON — the suggest phase ending mid-build parks
    // the vote until the machine returns to IDLE (keyed off machine.mode, so
    // decision-pending freezes inherit the right semantics for free).
    voteWaitsForBuild,
    // quick-rs3: the chat-activated vote-skip hook — consulted at phase end
    // AFTER the eligibility check above (FREE REIGN > CHAOS, HALT parks all).
    chaosModePick,
    // quick-260711-ly4: the single-suggestion auto-build hook — consulted ONLY
    // on the democratic path (chaosModePick returned null) when startRound
    // throws pool-too-small with EXACTLY ONE pooled candidate: build it directly
    // instead of opening a meaningless 1-option vote.
    soloPick,
    // quick-l2a pool-full early close: the pool sliver + threshold. The pool
    // is approved-only by construction (CandidatePool.add throws, COMP-01);
    // the scheduler funnels the close through its own #onPhaseEnd, so the
    // compliance gate and halt parking are untouched.
    pool: {
      size: () => pool.list().length,
      on: (event, handler) => pool.on(event, handler),
    },
    earlyCloseSize: Math.floor(
      envPositive(process.env.EARLY_CLOSE_POOL_SIZE, DEFAULT_EARLY_CLOSE_POOL_SIZE),
    ),
    suggestPhaseMs: suggestPhaseSeconds * 1_000,
    enabledAtBoot: autoRoundEnabled,
    narrate: {
      suggestionsOpen: (s) => windowNarrator?.suggestionsOpen(s),
      stillCollecting: (s) => windowNarrator?.stillCollecting(s),
      buildQueueFull: () => windowNarrator?.buildQueueFull(),
      waitingForBuild: () => windowNarrator?.waitingForBuild(),
    },
    onToggled: (enabled) => recordAutoCycleToggled(db, { enabled, streamMode: machine.mode }),
    logger,
  });
  // Resume the cadence when a control window fully closes (quick-rs3 Rule-3
  // fix, pre-existing stall): ControlWindow.revoke()/#expire() transition
  // FREE_REIGN_WINDOW→IDLE BEFORE nulling their #window, so the scheduler's
  // STATE_CHANGED resume check still sees a live window at that instant and
  // stays parked (a revoked window's endsAtMs is still in the future). These
  // events fire AFTER the window is cleared; start() is idempotent (the
  // "already in a phase" guard + full eligibility re-check make it a safe poke).
  controlWindow.on(WINDOW_CLOSED, () => autoCycle.start());
  controlWindow.on(WINDOW_REVOKED, () => autoCycle.start());

  // ── Chat pipeline composition (plan 02-04) ─────────────────────────────
  // Runs whenever a chatSource/chatSink pair exists — injected fakes and the
  // entrypoint's real twurple adapters take the IDENTICAL path.
  let twitchStatus: TwitchConnectionStatus = "unauthorized";
  let chatHandle: { stop(): void } | null = null;
  const chatSource = opts.chatSource;
  const chatSink = opts.chatSink;
  if (chatSource && chatSink) {
    twitchStatus = "disconnected"; // until the EventSub socket reports ready
    const broadcasterUserId = process.env.TWITCH_BROADCASTER_USER_ID ?? "broadcaster";

    // (1) The single rate-budgeted sender — the ONLY path to chat (D2-08).
    const sender = createChatSender({
      sink: chatSink,
      broadcasterId: broadcasterUserId,
      logger,
      intervalCap: envPositive(process.env.CHAT_SEND_INTERVAL_CAP, DEFAULT_CHAT_SEND_INTERVAL_CAP),
      intervalMs: envPositive(process.env.CHAT_SEND_INTERVAL_MS, DEFAULT_CHAT_SEND_INTERVAL_MS),
    });
    // (2) Show narration in exact UI-SPEC copy (CHAT-05). The same narrator
    // carries the build-pipeline beats (BUILD-03/D3-08/D3-09) — expose it to the
    // orchestrator + the veto-abort handler above via buildNarrator.
    const narrator = createNarrator({ sender, logger, cooldownSeconds: intakeCooldownSeconds });
    buildNarrator = narrator;
    // Expose the same narrator to the window/chaos beats composed above.
    windowNarrator = narrator;
    // IN-01: re-arm the "30s left" beat for a window restored live on boot, using
    // the REMAINING time (never the full duration). Only when >30s actually
    // remain — a window already inside its final 30s missed the beat honestly.
    if (restoredWindow) {
      const remaining = restoredWindow.endsAtMs - Date.now();
      if (remaining > 30_000) {
        clearWindowThirtyBeat();
        windowThirtyTimer = setTimeout(() => {
          windowThirtyTimer = null;
          narrator.window30sLeft(restoredWindow.donorDisplayName);
        }, remaining - 30_000);
        windowThirtyTimer.unref();
      }
    }
    // (3) Chat hears transitions only: round open + close/winner (D2-07).
    round.on(ROUND_OPENED, (...args) => {
      narrator.roundOpened(args[0] as RoundSnapshot);
    });
    round.on(ROUND_CLOSED, (...args) => {
      narrator.roundClosed(args[0] as RoundSnapshot);
    });

    // (4) COMP-03 feedback hook — wraps the classify that the CHAT-path
    // submitCandidate binding uses (classifyThenPush pattern). The narrator
    // receives ONLY viewer-safe CATEGORY_META labels: never the suggestion
    // text, never the classifier rationale (T-02-17). Approvals get NO chat
    // message — silence until the idea appears in a round (D2-07 budget).
    //
    // WR-03: the fail-closed outage line goes through narrator.error(),
    // which bypasses the coalesce buffer — during a classifier outage every
    // accepted !suggest would enqueue an IDENTICAL line (N users → N
    // messages queued at 15/30s, minutes of repeats). Throttle it: at most
    // one backed-up notice per OUTAGE_NOTICE_MIN_INTERVAL_MS.
    const OUTAGE_NOTICE_MIN_INTERVAL_MS = 30_000;
    let lastOutageNoticeAtMs = 0;
    const classifyThenNotify = async (candidate: SuggestionCandidate): Promise<GateResult> => {
      const result = await classify(gateDeps, candidate);
      const viewer = candidate.twitchUsername ?? "viewer";
      if (result.decision === "rejected") {
        if (result.category === "feasibility") {
          narrator.feedback("trim", viewer);
        } else if (result.category !== null && isLegalCategory(result.category)) {
          narrator.feedback("rejected", viewer, CATEGORY_META[result.category].label);
        } else {
          // Fail-closed rejection (classifier unavailable, D-11): the honest
          // UI-SPEC error line — no fake category, no internal codes.
          const now = Date.now();
          if (now - lastOutageNoticeAtMs >= OUTAGE_NOTICE_MIN_INTERVAL_MS) {
            lastOutageNoticeAtMs = now;
            narrator.error(
              "Suggestion check is backed up — hold your ideas for a minute, votes still count.",
            );
          }
        }
      } else if (result.decision === "held-for-review") {
        narrator.feedback("held", viewer);
      } else if (result.decision === "approved" && candidate.source === "chat") {
        // quick-q5n: routing verbs get a pooled confirmation (they're invisible
        // until a round opens). Approved plain suggestions stay silent (D2-15).
        if (candidate.kind === "project-switch") narrator.feedback("pooled-build", viewer);
        else if (candidate.kind === "revert") narrator.feedback("pooled-revert", viewer);
        else if (candidate.kind === "swap") narrator.feedback("pooled-swap", viewer);
      }
      return result;
    };

    // (5) D2-14 reconciliation on every EventSub (re)connect: compare the
    // in-memory tally against the round_votes ledger and re-sync from SQLite
    // (RoundManager.restore() rebuilds candidates + tally from the ledger).
    const reconcile = (): void => {
      const mem = round.snapshot();
      const openRow = db
        .prepare("SELECT id FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1")
        .get() as { id: number } | undefined;
      if (!openRow) {
        if (mem) {
          logger.warn(
            { roundId: mem.roundId },
            "reconcile: in-memory round has no open SQLite row — leaving memory authoritative",
          );
        }
        return;
      }
      if (!mem || mem.roundId !== openRow.id) {
        logger.warn(
          { dbRoundId: openRow.id, memRoundId: mem?.roundId ?? null },
          "reconcile: SQLite has an open round the in-memory state lacks — restoring from the ledger",
        );
        round.restore();
        return;
      }
      const rows = db
        .prepare(
          "SELECT option_index, COUNT(*) AS votes FROM round_votes WHERE round_id = ? GROUP BY option_index",
        )
        .all(openRow.id) as { option_index: number; votes: number }[];
      const ledger = new Map(rows.map((row) => [row.option_index, row.votes]));
      const diverged = mem.candidates.some(
        (entry) => (ledger.get(entry.option) ?? 0) !== entry.votes,
      );
      if (diverged) {
        logger.warn(
          {
            roundId: mem.roundId,
            ledger: Object.fromEntries(ledger),
            memory: Object.fromEntries(mem.candidates.map((c) => [c.option, c.votes])),
          },
          "reconcile: tally divergence — re-syncing in-memory tally from the round_votes ledger (D2-14)",
        );
        round.restore();
        return;
      }
      logger.info({ roundId: mem.roundId }, "reconcile: in-memory round matches the vote ledger");
    };

    // (5a-t8k) Tier-2 instant info commands (quick-t8k): read-only replies
    // composed from project_repos.repo_name slugs + a PUBLIC owner string ONLY
    // — never from GateResult, donor data, or raw candidate text (T-t8k-03).
    // Global per-command cooldown (INFO_COMMAND_COOLDOWN_SECONDS, default 30):
    // one reply per command per window, suppressed repeats SILENT (D2-15);
    // silent while HALTED. Zero funnel contact by construction — the dispatch
    // returns before intake/classify (twitch-chat.ts), and this closure only
    // ever runs a prepared read-only SELECT.
    const infoCooldownMs =
      envPositive(
        process.env.INFO_COMMAND_COOLDOWN_SECONDS,
        DEFAULT_INFO_COMMAND_COOLDOWN_SECONDS,
      ) * 1_000;
    // quick-260716-g8p: the owner is resolved ONCE at createApp scope
    // (galleryOwner) — shared with the post-publish playable announce.
    const infoRepoRowsStmt = db.prepare(
      "SELECT generation, repo_name FROM project_repos ORDER BY generation DESC",
    );
    const infoLastSentAtMs = new Map<InfoCommandKind, number>();
    const infoCommand = (kind: InfoCommandKind): void => {
      if (machine.mode === "HALTED") return; // no info chatter while halted (D-02)
      const now = Date.now();
      if (now - (infoLastSentAtMs.get(kind) ?? 0) < infoCooldownMs) return; // silent (D2-15)
      infoLastSentAtMs.set(kind, now);
      const rows = infoRepoRowsStmt.all() as Array<{ generation: number; repo_name: string }>;
      const urlOf = (name: string): string => `https://github.com/${galleryOwner}/${name}`;
      // quick-1ki: the PLAYABLE GitHub Pages URL for a repo — the shared
      // gallery-publisher helper (quick-260716-g8p: the SINGLE URL point),
      // lowercased owner + post-gate repo slug only.
      const playUrlOf = (name: string): string => galleryPlayUrl(galleryOwner, name);
      if (kind === "projects") {
        narrator.infoProjects(rows.map((r) => ({ name: r.repo_name, url: urlOf(r.repo_name) })));
        return;
      }
      if (kind === "apps") {
        // quick-1ki: the gallery index site — config-derived URL only.
        narrator.infoApps(galleryIndexUrl(galleryOwner));
        return;
      }
      if (kind === "current" || kind === "repo") {
        const current = rows.find((r) => r.generation === workspace.generation()) ?? null;
        if (kind === "current") {
          narrator.infoCurrent(
            current
              ? {
                  name: current.repo_name,
                  url: urlOf(current.repo_name),
                  playUrl: playUrlOf(current.repo_name),
                }
              : null,
          );
        } else {
          narrator.infoRepo(current ? urlOf(current.repo_name) : null);
        }
        return;
      }
      narrator.infoHelp();
    };

    // (5b) D-11 open-window routing: while a control window is ACTIVE, ANY
    // chatter's `!build <text>` OR `!suggest <text>` routes through the ONE
    // funnel (controlWindow.submitInstruction → submitDuringWindow → gate →
    // queue) — there is NO donor-identity gate (an open sponsored slot) and NO
    // direct enqueue here (single-funnel invariant, T-04-23).
    //
    // quick-260711-raz (donor privilege directive): !suggest and !build are
    // ALIASES during a window — both consumed by this interceptor under the
    // exact same `controlWindow.snapshot() !== null` check, so NO intake state
    // (suggestion cooldown / per-user pooled cap) is ever touched in-window:
    // the message never reaches startTwitchChat's parser → intake.check path.
    // The compliance gate is NEVER skipped (submitDuringWindow classifies every
    // byte). Outside a window both commands fall through to the normal parser →
    // intake → classify → pool path unchanged. This is wired as a THIN wrapper
    // over the existing chatSource so main.ts adds no second EventSub
    // subscription — the interceptor delegates every non-matching message to
    // startTwitchChat's own handler.
    const BUILD_COMMAND = /^!build\s+(.+)$/i;
    // Same regex shape as command-parser.ts's !suggest match — the two must
    // agree so an in-window !suggest is consumed by the interceptor iff the
    // parser would have accepted it outside one.
    const SUGGEST_COMMAND = /^!suggest\s+(.+)$/i;
    const routeWindowInstruction = async (displayName: string, text: string): Promise<void> => {
      const candidate: SuggestionCandidate = {
        id: randomUUID(),
        // quick-t5k: carry the WINDOW'S trigger as the candidate source
        // ("donation" | "channel_points" — the CandidateSource values minted
        // for exactly this path) instead of "chat". Two wins: the gate_decision
        // audit row becomes filterable by influence path (record.ts doctrine),
        // and drainVoteQueue can tell a dead-window leftover from a vote winner
        // (it skips non-vote-origin heads rather than building them with a
        // mislabelled 'vote' provenance).
        source: controlWindow.snapshot()?.trigger ?? "donation",
        kind: "suggestion",
        twitchUsername: displayName,
        text,
        submittedAtMs: Date.now(),
      };
      const result = await controlWindow.submitInstruction(candidate);
      if (result.queued) {
        // CR-03: only claim "building" when a build ACTUALLY starts. If a build is
        // already in progress (this instruction queues behind it, D-12) or no
        // build engine is composed, narrate the honest "queued" beat instead.
        const started = driveWindowBuild?.(candidate.id) ?? false;
        if (started) narrator.instructionAccepted(displayName, text);
        else narrator.instructionQueued(displayName, text);
      } else if (result.reason === "rejected") {
        // The paid funnel returns only a typed reason (no category) — narrate the
        // never-silent rejection with the generic viewer-safe label. Window time
        // is NOT consumed (D-12); the window stays open.
        narrator.instructionRejected(displayName);
      } else if (result.reason === "held") {
        narrator.instructionHeld(displayName);
      }
      // reason "halted" → the halt itself is already narrated (D-02); no beat.
    };
    const buildAwareChatSource: ChatEventSource = {
      ...chatSource,
      onChannelChatMessage: (bId, uId, handler) =>
        chatSource.onChannelChatMessage(bId, uId, (event) => {
          const trimmed = event.messageText.trim();
          const match = BUILD_COMMAND.exec(trimmed) ?? SUGGEST_COMMAND.exec(trimmed);
          if (match?.[1]) {
            // Inside an active window (D-11): the window funnel consumes the
            // token — !build byte-identical to the pre-q5n behavior (safety
            // invariant #4), !suggest an alias of it (quick-260711-raz).
            // Outside a window: fall through to the parser → intake →
            // classify → pool path, where !build is a kind-tagged
            // project-switch candidate and !suggest a plain suggestion for
            // the next vote.
            if (controlWindow.snapshot() !== null) {
              void routeWindowInstruction(event.chatterDisplayName, match[1]);
              return;
            }
          }
          handler(event);
        }),
    };

    // (6) The listener: !suggest -> intake -> submitCandidate (the ONLY
    // intake path, COMP-01), !vote -> the round ledger, !build -> the window
    // funnel (via buildAwareChatSource above).
    chatHandle = startTwitchChat({
      source: buildAwareChatSource,
      broadcasterUserId,
      intake,
      submit: (candidate) =>
        submitCandidate(
          { db, mode: () => machine.mode, pool, classify: classifyThenNotify, logger },
          candidate,
        ),
      round,
      // quick-260711-ly4: !chaos rides the shared submission path (a
      // server-composed CHAOS candidate). This seam only reports whether a chaos
      // window is ALREADY live, so a !chaos during the window is a silent no-op.
      chaosActive: () => {
        const s = chaosMode.snapshot();
        return s !== null && s.endsAtMs > Date.now();
      },
      // quick-t8k: tier-2 info commands (read-only, cooldown-gated, HALTED-silent).
      infoCommand,
      narrator,
      reconcile,
      logger,
    });

    // (7) createApp-owned connection-health handlers feed the console pill.
    chatSource.onUserSocketReady(() => {
      twitchStatus = "connected";
    });
    chatSource.onUserSocketDisconnect(() => {
      twitchStatus = "disconnected";
    });
  }

  // ── Donation + redemption ingestion (PAID-01/02) ────────────────────────
  // Both triggers feed the SAME controlWindow FSM. Injected fakes travel the
  // IDENTICAL path as the entrypoint's real StreamElements socket + the
  // redemption subscription on the SINGLE EventSubWsListener (never a second
  // session). Absent = that trigger stays "unconfigured" and the app still
  // boots — a missing tip feed never crashes the show (T-04-25).
  const donationSource = opts.donationSource;
  if (donationSource) {
    donationsStatus = "reconnecting"; // until the socket reports ready
    donationSource.onReady(() => {
      donationsStatus = "connected";
    });
    donationSource.onDisconnect(() => {
      donationsStatus = "reconnecting";
    });
    donationSource.onTip((tip) => {
      openWindowFromDonation(tip);
    });
  }
  const redemptionSource = opts.redemptionSource;
  if (redemptionSource) {
    redemptionSource.onRedemption((redemption) => {
      openWindowFromRedemption(redemption);
    });
  }

  const console_ = await startConsoleServer({
    machine,
    db,
    port: opts.port,
    pool,
    taskQueue,
    round,
    classify: (candidate) => classify(gateDeps, candidate),
    // WR-02: the console Halt button gets the SAME abort hook as the panic
    // hotkey — both kill paths must be genuinely equivalent (D-01), so a
    // console-initiated halt also force-kills registered agent process trees.
    abortActiveWork: (frozen) => abortActiveWork(registry, frozen, logger),
    ...(opts.twitchAuth ? { twitchAuth: opts.twitchAuth } : {}),
    twitchStatus: () => twitchStatus,
    // BUILD-03 / D3-09 build-decision hooks + status source. Late-binding
    // closures over `orchestrator` (composed below only when an agentRunner is
    // injected) — a no-op / null until then, mirroring twitchStatus's pattern.
    retryBuild: (taskId) => orchestrator?.retryBuild(taskId),
    skipTask: (taskId, reasonTag) => orchestrator?.skipTask(taskId, reasonTag),
    buildStatus: () => orchestrator?.snapshot() ?? null,
    // PAID-04 / CHAOS-01 seams (04-05): the honest full-detail window snapshot +
    // single-click Revoke, the chaos on/off state + toggle, and the donation-feed
    // health pill — all backed by the real FSM/controller composed above.
    controlWindow: {
      // quick-260716-h73: the console (and ONLY the console) also sees a banked
      // pending window — active wins when both exist. The Revoke route's
      // snapshot-gate now passes for a pending too; revoke() cancels either.
      // The overlay source seam, intake interceptor, and drainVoteQueue keep
      // consulting controlWindow.snapshot() directly (active-only): a pending
      // window grants no chat privileges and never reaches the public wire.
      snapshot: () => controlWindow.snapshot() ?? controlWindow.pendingSnapshot(),
      revoke: () => controlWindow.revoke(),
      // Console push hook: WINDOW_PENDING banks and pending discards happen
      // WITHOUT a mode change — the server subscribes so the panel stays live.
      on: (event, handler) => controlWindow.on(event, handler),
    },
    chaos: { enabled: () => chaos.enabled(), toggle: () => chaos.toggle() },
    // quick-t5k D-04: the auto-cycle pause/resume seam — POST
    // /api/auto-cycle/toggle + the round-panel pill, mirroring the chaos seam.
    autoCycle: {
      snapshot: () => autoCycle.snapshot(),
      toggle: () => autoCycle.toggle(),
      on: (event, handler) => autoCycle.on(event, handler),
    },
    donationsStatus: () => donationsStatus,
    // quick-0iu: the streamer's "New project" workspace-rotation seam — a
    // THIN wrapper (spread + one override) over the SAME WorkspaceView the
    // build session consumes below: the console rotation also re-roots the
    // preview dev server (quick-t8k). The build session keeps the UNWRAPPED
    // instance; reRootPreview is late-bound (no-op until the supervisor
    // composes in the orchestrator block).
    workspace: {
      ...workspace,
      newProject: (): number => {
        const generation = workspace.newProject();
        reRootPreview();
        return generation;
      },
    },
    logger,
  });
  logger.info(
    { port: console_.port, dbPath: opts.dbPath },
    "operator console listening at http://127.0.0.1:%d",
    console_.port,
  );

  // ── Builder-view feed (quick-x7d) ──────────────────────────────────────
  // ONE instance, created unconditionally: the /builder page must exist and
  // show its standing-by state even when no orchestrator is composed. The
  // same instance is both the build session's sink and the overlay's source.
  const builderFeed = createBuilderFeed();

  // ── Build orchestrator composition (plan 03-06) ────────────────────────
  // Composed whenever an agentRunner + sandboxAdapter pair exists (injected
  // fakes in tests, real SDK/WSL2 adapters from the entrypoint) — both take the
  // IDENTICAL path. The build session IS the OverlayBuildSource (snapshot +
  // BUILD_STAGE_CHANGED), so the overlay build panel updates live.
  if (opts.agentRunner && opts.sandboxAdapter) {
    // Presentational sink: the session owns overlay + audit; this narrates/logs
    // stage transitions (full chat narration polish lands in 03-09).
    const progress: ProgressSink = {
      push: (view) => logger.info({ taskId: view.taskId, stage: view.stage }, "build stage"),
    };
    // quick-260711-hak: the real per-project publisher needs the app db (for the
    // ProjectRepoStore), so it is built HERE from the db createApp owns — not at
    // the entrypoint. A test-injected fake takes precedence; without a token
    // resolveGalleryConfig returns null and buildGalleryPublisher yields
    // undefined (publishing stays inert), preserving the injected-fake seam.
    const galleryPublisher = opts.galleryPublisher ?? buildGalleryPublisher(db, logger);

    // ── Playable-link announce (quick-260716-g8p) ─────────────────────────
    // Fired ONLY from onBuildDone below, AFTER publishNow resolved a CONFIRMED
    // outcome (published | no-changes). Scope note: the shipThenRotate / swap
    // "final snapshot" publishes deliberately do NOT announce — they ship the
    // OUTGOING project mid-transition; the !current / !apps info commands
    // already cover those links. The durable project_repos row is the ONLY
    // repo-name source for the URL (prepared once; post-gate slug, never chat
    // text). FULL try/catch that only ever logger.error's — the T-hak-03
    // idiom: finalize already returned when this runs; nothing here can delay
    // or fail it, and a failed poll/send logs loudly and drops.
    const playableRepoStmt = db.prepare(
      "SELECT repo_name FROM project_repos WHERE generation = @generation",
    );
    const announcePlayable = async (generation: number, taskId: string): Promise<void> => {
      try {
        if (!db.open) return;
        const row = playableRepoStmt.get({ generation }) as { repo_name: string } | undefined;
        // No row = nothing was ever published for this generation (the
        // EMPTY-01 no-changes skip) — no link exists, return silently.
        if (!row) return;
        // Pages-build-aware gate: a first publish takes ~40-60s to go live.
        // Fake publishers without the method announce immediately —
        // deterministic in e2e.
        const status = galleryPublisher?.awaitPagesBuilt
          ? await galleryPublisher.awaitPagesBuilt(row.repo_name)
          : "built";
        const url = galleryPlayUrl(galleryOwner, row.repo_name);
        // Guard the overlay push: machine.mode === BUILD_IN_PROGRESS means a
        // NEW build already started and the STATE_CHANGED clear won the race —
        // a stale link must not ride into that build's done beat.
        if (machine.mode !== "BUILD_IN_PROGRESS") {
          playableUrl = url;
          playableEvents.emit(PLAYABLE_CHANGED);
        }
        // The chat beat posts either way (late-bound narrator idiom;
        // silent-safe when no chat pipeline is composed).
        windowNarrator?.buildPlayable(url, status === "built");
      } catch (err) {
        logger.error(
          { err, taskId, generation },
          "playable-link announce failed — show loop unaffected (T-hak-03 idiom)",
        );
      }
    };

    const buildSession = createBuildSession({
      taskQueue,
      db,
      machine,
      registry,
      agentRunner: opts.agentRunner,
      sandboxAdapter: opts.sandboxAdapter,
      // quick-0iu persistent workspace: scaffold/continue mode + the distro
      // dir the sandboxed build turn cds into.
      workspace,
      // COMP-02's classify is the SAME app gate, pre-bound to gateDeps (03-04) —
      // drives BOTH the pre-build suggestion re-screen and the in-flight output re-screen.
      comp02: { classify: (candidate) => classify(gateDeps, candidate) },
      progress,
      // WR-03 / D-08: routing a held plan into the console review queue is
      // DEFERRED. Interim behavior is explicit and never silent — the build
      // session narrates the held beat + audits it (comp02_decision:
      // held-for-review + pipeline_stage: refused), and this hook logs an audited
      // warning. TODO(D-08): re-queue the held plan into the streamer review flow
      // instead of dropping it after audit+narration.
      onHeldForReview: (task) =>
        logger.warn(
          { taskId: task.id },
          "COMP-02 held the build plan — audited + narrated; D-08 console review-queue routing deferred (TODO)",
        ),
      // Build-pipeline chat narration (BUILD-03/D3-08/D3-09); absent when no chat
      // pipeline is composed — the build still runs, just without chat beats.
      ...(buildNarrator ? { narrator: buildNarrator } : {}),
      // quick-x7d: the broadcast /builder feed sink — every call site inside
      // the session is post-screening by construction (T-x7d-01).
      builderFeed,
      // WR-07 (quick-22l): the live build turn's env-tunable watchdog budget
      // (default 900s). build-session.ts's DEFAULT_TURN_TIMEOUT_MS stays the
      // deps-absent fallback for tests/non-build turns.
      turnTimeoutMs:
        envPositive(process.env.BUILD_TURN_TIMEOUT_SECONDS, DEFAULT_BUILD_TURN_TIMEOUT_SECONDS) *
        1_000,
      // quick-22l gallery publish: fires ONLY on a `done` finalize (the seam is
      // inside finalize's done branch). Fire-and-forget — a slow/failed publish
      // can never block the show loop; ONE audit row per attempt
      // (published / no-changes / failed, T-22l-06). The generation is read
      // SYNCHRONOUSLY while the machine is still BUILD_IN_PROGRESS, so a
      // console "New project" rotation cannot race it. task.text is the
      // gate-APPROVED title (D-03) — the same string build_history records.
      onBuildDone: (task) => {
        if (!galleryPublisher) return;
        const generation = workspace.generation();
        void galleryPublisher
          .publishNow({ generation, title: task.text, taskId: task.id })
          .then((result) => {
            // db.open guard mirrors auditIfOpen (WR-05 shutdown drain).
            if (db.open) {
              recordGalleryPublish(db, {
                taskId: task.id,
                generation,
                status: result.status,
                commitHash: result.commitHash,
                detail: result.detail,
                streamMode: machine.mode,
              });
            }
            // quick-260716-g8p: announce the playable link ONLY on a CONFIRMED
            // publish — a 'failed' publish NEVER posts a link (T-g8p-05).
            // Fire-and-forget: finalize returned long ago; announcePlayable
            // owns its errors (T-hak-03).
            if (result.status === "published" || result.status === "no-changes") {
              void announcePlayable(generation, task.id);
            }
          })
          .catch((err) =>
            logger.error(
              { err, taskId: task.id },
              "gallery publish hook failed — show loop unaffected",
            ),
          );
      },
      logger,
    });
    orchestrator = buildSession;

    /**
     * quick-260716-rll SAVE-AND-CLOSE: a gate-approved winner whose text asks
     * to wipe/reset the whole app is intercepted at dispatch (see
     * dispatchBuild below) and resolved here instead of built. Live incident
     * 2026-07-16 ~19:41 (audit 885-891); Ross's verbatim directive: "in the
     * future any commands to delete the repo should just save and close the
     * project. then viewers just see the default overlay screen."
     *
     * Steps in EXACTLY this order — remove → rotate → audit → narrate →
     * transition (the STATE_CHANGED→IDLE drain is setImmediate-deferred, so
     * the queue is already clean when it fires):
     *  (a) remove the head FIRST (the runChaosWinner/runRevertWinner idiom —
     *      startBuild's finalize normally owns the dequeue; an intercepted
     *      task must never linger at the queue head);
     *  (b) rotate via the EXISTING console new-project flow (locked decision
     *      3) — "save" is already true from the last done-build publish, so
     *      no new publish step exists. An UNSCAFFOLDED canvas skips the
     *      rotation (double-rotation guard — also covers a wipe-intent
     *      project-switch arriving after shipThenRotate already rotated);
     *  (c) audit project_closed — never silent (T-rll-03);
     *  (d) narrate the calm amber beat;
     *  (e) guarded return to IDLE — ending at IDLE is what makes ALL THREE
     *      existing completion continuations (drain-next / window-return /
     *      chaos-repick) work with ZERO edits.
     */
    const saveAndCloseProject = (task: QueuedTask): void => {
      taskQueue.remove(task.id);
      const closed = workspace.generation();
      let fresh = closed;
      if (workspace.scaffolded()) {
        fresh = workspace.newProject();
        // A rotation is a generation change — re-root the preview dev server
        // at the fresh dir (fire-and-forget; supervisor fail-opens).
        reRootPreview();
      }
      if (db.open) {
        recordProjectClosed(db, {
          taskId: task.id,
          closedGeneration: closed,
          freshGeneration: fresh,
          streamMode: machine.mode,
        });
      }
      windowNarrator?.projectClosed();
      if (machine.mode === "BUILD_IN_PROGRESS") {
        try {
          // Guarded (finalize()'s idiom): a halt that landed mid-close leaves
          // the machine HALTED — never fight the kill switch.
          machine.transition("IDLE");
        } catch (err) {
          logger.error({ err, taskId: task.id }, "failed to return to IDLE after a save-and-close");
        }
      }
      logger.warn(
        { taskId: task.id, closedGeneration: closed, freshGeneration: fresh },
        "wipe-intent winner intercepted — project saved-and-closed, never handed to the build agent",
      );
    };

    /**
     * quick-260716-rll: the ONE build-dispatch convergence point (locked
     * decision 2). Every path that hands a queued task to the build agent —
     * vote winner, solo pick, chaos pick (chat or console), and paid
     * free-reign instruction — routes through this wrapper, so the
     * destructive-intent check structurally cannot be bypassed.
     *
     * STRUCTURAL INVARIANT (enforced by tests/e2e/save-and-close.e2e.test.ts
     * gate A): `buildSession.startBuild` has exactly ONE call site — this
     * wrapper.
     */
    const dispatchBuild = async (task: QueuedTask, provenance: BuildProvenance): Promise<void> => {
      if (isDestructiveIntent(task.text)) {
        saveAndCloseProject(task);
        return;
      }
      await buildSession.startBuild(task, provenance);
    };

    /**
     * quick-q5n LOCKED USER DECISION: a project-switch winner commits and
     * pushes the CURRENT project FIRST, and rotates the workspace ONLY on a
     * confirmed publish outcome (published | no-changes). A failed final push
     * keeps the current project active — amber-narrated, audited, never a
     * silent rotate. publishNow ALREADY returns Promise<PublishResult> and
     * NEVER rejects (T-hak-03); the post-DONE call site (onBuildDone) merely
     * fire-and-forgets that promise — this router AWAITS the same promise and
     * branches on result.status, so the never-throw-into-the-build-pipeline
     * contract is untouched for both call sites.
     */
    const shipThenRotate = async (head: QueuedTask): Promise<void> => {
      // (i) No active project: nothing to ship, nothing to rotate — the
      // current fresh generation scaffolds (build-session computes the mode).
      if (!workspace.scaffolded()) {
        await dispatchBuild(head, "vote");
        return;
      }
      // (ii) Active project ⇒ require a CONFIRMABLE push. No publisher = the
      // push can never be confirmed ⇒ treat as ship failure without any exec.
      const generation = workspace.generation();
      let shipped: { status: "published" | "no-changes" | "failed" } | null = null;
      if (galleryPublisher) {
        windowNarrator?.newProjectShipping(head.text);
        // Server-composed title (deliberate): if this generation somehow never
        // published before, the publisher names the new repo from this title, so
        // the slug degrades to a sane `app-N-final-snapshot`; on the normal
        // continue path it is just the commit message.
        const result = await galleryPublisher.publishNow({
          generation,
          title: `app-${generation} final snapshot`,
          taskId: head.id,
        });
        shipped = result;
        if (db.open) {
          recordGalleryPublish(db, {
            taskId: head.id,
            generation,
            status: result.status,
            commitHash: result.commitHash,
            detail: result.detail,
            streamMode: machine.mode,
          });
        }
      }
      // (iii) Confirmed ship: published, or no-changes (everything already
      // pushed — a confirmed-current remote counts as shipped) ⇒ rotate, then
      // build the fresh empty generation (scaffold mode computes on its own).
      if (shipped && (shipped.status === "published" || shipped.status === "no-changes")) {
        const rotated = workspace.newProject();
        if (db.open) {
          recordWorkspaceReset(db, {
            generation: rotated,
            streamMode: machine.mode,
            initiator: "chat-vote",
          });
        }
        // quick-t8k: a rotation is a generation change — re-root the preview
        // dev server at the fresh dir (fire-and-forget; supervisor fail-opens).
        reRootPreview();
        // quick-260716-rll: dispatchBuild's unscaffolded-skip guard means a
        // wipe-intent !build ships the outgoing app above (a bonus save) and
        // never pays for a wasteful second rotation here.
        await dispatchBuild(head, "vote");
        return;
      }
      // (iv) Ship FAILED (or no publisher): DO NOT rotate, DO NOT startBuild.
      // Resolves like a failed build: task removed, amber regroup line
      // (D2-18), audited, back to IDLE — never a dead round, never a silent
      // rotate. When no publisher is configured, step (ii) never ran — write
      // the failed audit row HERE (the "audited" behavior contract governs).
      taskQueue.remove(head.id);
      windowNarrator?.newProjectShipFailed();
      if (!galleryPublisher && db.open) {
        recordGalleryPublish(db, {
          taskId: head.id,
          generation,
          status: "failed",
          commitHash: null,
          detail: "gallery publisher not configured — cannot confirm a push, rotation withheld",
          streamMode: machine.mode,
        });
      }
      logger.error(
        { taskId: head.id, generation },
        "project-switch ship failed — rotation withheld, current project stays active (locked decision)",
      );
      try {
        // Guarded (finalize()'s idiom): a halt that landed mid-ship leaves the
        // machine HALTED — never fight the kill switch.
        if (machine.mode === "BUILD_IN_PROGRESS") machine.transition("IDLE");
      } catch (err) {
        logger.error({ err }, "failed to return to IDLE after a failed project-switch ship");
      }
    };

    /**
     * quick-q5n revert winner: a HOST-side mirror git-revert + republish —
     * never an agent build. The task is removed FIRST (finalize never runs
     * for a revert, so nothing else dequeues it; removing before the await
     * also stops drain re-entry from re-picking it). In ALL outcomes the
     * machine returns to IDLE (guarded) and the drain continues — never a
     * dead round.
     */
    const runRevertWinner = async (head: QueuedTask): Promise<void> => {
      taskQueue.remove(head.id);
      const generation = workspace.generation();
      const outcome = galleryPublisher
        ? await galleryPublisher.revertLast({ generation, taskId: head.id })
        : {
            status: "failed" as const,
            commitHash: null,
            detail: "gallery publisher not configured",
          };
      // Narrator may be absent when no chat pipeline is composed — optional calls.
      if (outcome.status === "reverted") {
        windowNarrator?.revertApplied();
        if (db.open) {
          recordBuildHistory(db, {
            taskId: head.id,
            title: head.text,
            provenance: "vote",
            result: "reverted",
          });
        }
      } else if (outcome.status === "nothing-to-revert") {
        windowNarrator?.revertNothing();
      } else {
        windowNarrator?.revertFailed();
      }
      if (db.open) {
        recordRevertOutcome(db, {
          taskId: head.id,
          status: outcome.status,
          detail: outcome.detail,
          streamMode: machine.mode,
        });
      }
      try {
        // Guarded: a halt that landed mid-revert leaves the machine HALTED.
        if (machine.mode === "BUILD_IN_PROGRESS") machine.transition("IDLE");
      } catch (err) {
        logger.error({ err }, "failed to return to IDLE after a revert winner");
      }
    };

    /**
     * quick-t8k swap winner: the no-build portfolio-swap arm. Head removed
     * FIRST (the runRevertWinner idiom), the target resolved over ALL
     * project_repos rows, then the LOCKED confirmed-push gate (mirror of
     * shipThenRotate ii–iv): activateExisting runs ONLY after publishNow
     * resolves published|no-changes. Every failure branch is amber-narrated,
     * audited (recordSwapOutcome), and returns the machine to IDLE (guarded)
     * — never a dead round, never a silent activation.
     */
    const runSwapWinner = async (head: QueuedTask): Promise<void> => {
      taskQueue.remove(head.id);
      const current = workspace.generation();

      // (b) Resolve the gate-approved name reference against the durable
      // per-project routing table. Prepared read-only SELECT; normalized
      // in-memory matching only — chat text never reaches exec/SQL (T-t8k-01).
      const rows = db
        .prepare("SELECT generation, repo_name FROM project_repos")
        .all() as SwapTargetRow[];
      const target = resolveSwapTarget(rows, normalizeSwapName(head.text), current);
      const backToIdle = (): void => {
        try {
          // Guarded (finalize()'s idiom): a halt that landed mid-swap leaves
          // the machine HALTED — never fight the kill switch.
          if (machine.mode === "BUILD_IN_PROGRESS") machine.transition("IDLE");
        } catch (err) {
          logger.error({ err }, "failed to return to IDLE after a swap winner");
        }
      };
      if (target === null) {
        windowNarrator?.swapUnresolved();
        if (db.open) {
          recordSwapOutcome(db, {
            taskId: head.id,
            fromGeneration: current,
            toGeneration: null,
            repoName: null,
            status: "unresolved",
            detail: "no project matched the requested name",
            streamMode: machine.mode,
          });
        }
        backToIdle();
        return;
      }
      if (target.generation === current) {
        // Resolution ran over ALL rows, so "current" is detected honestly —
        // then rejected with its OWN line, never a misleading not-found
        // (checker INFO b).
        windowNarrator?.swapAlreadyCurrent();
        if (db.open) {
          recordSwapOutcome(db, {
            taskId: head.id,
            fromGeneration: current,
            toGeneration: target.generation,
            repoName: target.repo_name,
            status: "already-current",
            detail: "requested project is already on screen",
            streamMode: machine.mode,
          });
        }
        backToIdle();
        return;
      }

      // (c) Ship gate — mirror of shipThenRotate ii–iv (LOCKED): an ACTIVE
      // project requires a CONFIRMABLE push before the pointer may move. No
      // publisher = unconfirmable = ship failure (audited HERE). An
      // unscaffolded fresh generation has nothing to ship — abandoned in
      // place (archive-by-construction), proceed.
      if (workspace.scaffolded()) {
        let shipped: { status: "published" | "no-changes" | "failed" } | null = null;
        if (galleryPublisher) {
          const result = await galleryPublisher.publishNow({
            generation: current,
            title: `app-${current} final snapshot`,
            taskId: head.id,
          });
          shipped = result;
          if (db.open) {
            recordGalleryPublish(db, {
              taskId: head.id,
              generation: current,
              status: result.status,
              commitHash: result.commitHash,
              detail: result.detail,
              streamMode: machine.mode,
            });
          }
        }
        if (!shipped || (shipped.status !== "published" && shipped.status !== "no-changes")) {
          windowNarrator?.swapShipFailed();
          if (!galleryPublisher && db.open) {
            recordGalleryPublish(db, {
              taskId: head.id,
              generation: current,
              status: "failed",
              commitHash: null,
              detail:
                "gallery publisher not configured — cannot confirm a push, swap activation withheld",
              streamMode: machine.mode,
            });
          }
          if (db.open) {
            recordSwapOutcome(db, {
              taskId: head.id,
              fromGeneration: current,
              toGeneration: target.generation,
              repoName: target.repo_name,
              status: "ship-failed",
              detail: "final publish did not confirm — swap activation withheld",
              streamMode: machine.mode,
            });
          }
          logger.error(
            { taskId: head.id, generation: current, target: target.generation },
            "swap ship failed — activation withheld, current project stays active (locked decision)",
          );
          backToIdle();
          return;
        }
      }

      // (d) Activate: validated pointer-only move; repo binding REUSED (the
      // target generation's project_repos row routes future publishes through
      // continueRepo — no new repo is ever created for a swap).
      workspace.activateExisting(target.generation);
      if (db.open) {
        recordSwapOutcome(db, {
          taskId: head.id,
          fromGeneration: current,
          toGeneration: target.generation,
          repoName: target.repo_name,
          status: "activated",
          detail: null,
          streamMode: machine.mode,
        });
      }
      windowNarrator?.swapActivated(target.repo_name);
      reRootPreview();
      backToIdle();
    };

    /**
     * quick-260711-ly4 chaos winner: THE ONE DEVIATION from revert/swap. A
     * CHAOS ballot option that WINS a vote round does NOT build and must NOT
     * hold BUILD_IN_PROGRESS — it instantly flips on the 5-minute chaos window,
     * then the auto-cycle keeps running (chaosModePick owns phase ends for the
     * duration). Head removed FIRST (the runRevertWinner idiom — nothing else
     * dequeues it). activate() opens the window (→ onActivated narrates the
     * chaos-wins beat); a truthful "activated by vote win" audit row is written
     * HERE, where the winning candidate's task id is in scope. NO state
     * transition: the caller stays IDLE (deferred drain) or lets closeRound's
     * own VOTING_ROUND→IDLE step run (synchronous close), so the democratic
     * cadence continues uninterrupted.
     */
    const runChaosWinner = (head: QueuedTask): void => {
      taskQueue.remove(head.id);
      chaosMode.activate();
      if (db.open) {
        recordChaosActivated(db, { taskId: head.id, streamMode: machine.mode });
      }
    };

    // ── drainVoteQueue — the ONE vote-winner build starter (quick-t5k A1) ──
    // Every path a queued winner can start on funnels through this helper, and
    // it only EVER starts the FIFO queue head — never a caller-supplied task id
    // (BLOCKER-1 fix: a previously-stranded winner builds before a fresh one).
    // Returns true when a build actually STARTED. Refuses (false) when:
    //  - a build is already running (its completion continuation drains next);
    //  - a control window is live or chaos is on (driveWindowBuild /
    //    driveChaosBuild own those drains — T-t5k-04);
    //  - no vote-origin task is queued. A non-vote-origin head (a paid
    //    instruction left over from a dead window) is SKIPPED, not built:
    //    building it here would mislabel its build_history provenance as
    //    'vote' (checker residual note) — it stays queued for streamer veto.
    const drainVoteQueue = (): boolean => {
      if (machine.mode === "BUILD_IN_PROGRESS") return false;
      const liveWindow = controlWindow.snapshot();
      if (liveWindow !== null && liveWindow.endsAtMs > Date.now()) return false;
      // NOTE (quick-rs3): this guard refers to the OLD console CHAOS_MODE
      // machine toggle and stays untouched — chat-activated chaos never
      // transitions the machine (the suggest cycle keeps running), so its
      // picks DRAIN THROUGH here like any voted winner; the two systems
      // cannot interfere.
      if (chaos.enabled()) return false;
      const head = taskQueue.list().find(isVoteOrigin);
      if (!head) return false;
      // quick-260711-ly4: a CHAOS winner NEVER builds — handle it BEFORE the
      // BUILD_IN_PROGRESS prologue. It flips on the chaos window (activate) and
      // leaves the machine where it is (VOTING_ROUND → closeRound's own
      // VOTING_ROUND→IDLE step runs; IDLE → stays IDLE), so the auto-cycle keeps
      // going. Then drain the NEXT queued winner immediately when already IDLE.
      // Returns false: no build STARTED (callers ignore the return).
      if (head.kind === "chaos") {
        runChaosWinner(head);
        if (machine.mode === "IDLE") drainVoteQueue();
        return false;
      }
      try {
        if (machine.mode === "VOTING_ROUND" || machine.mode === "IDLE") {
          // VOTING_ROUND → BUILD_IN_PROGRESS: the synchronous close path (as
          // today). IDLE → BUILD_IN_PROGRESS: the Task-1 table addition — a
          // queued winner starting after the previous build returned to IDLE.
          machine.transition("BUILD_IN_PROGRESS");
        } else {
          return false; // FREE_REIGN_WINDOW / CHAOS_MODE / HALTED — not ours
        }
      } catch (err) {
        logger.error(
          { err, taskId: head.id },
          "failed to enter BUILD_IN_PROGRESS for a queued vote winner",
        );
        return false;
      }
      void (async () => {
        // quick-q5n kind router: the winner's kind decides execution. The
        // synchronous prologue above already entered BUILD_IN_PROGRESS — the
        // mutual exclusion that stops a concurrent round/console rotation
        // racing this block (console POST /api/workspace/new-project 409s
        // mid-build; the state machine itself is untouched, invariant #3).
        switch (head.kind) {
          case "project-switch":
            await shipThenRotate(head);
            break;
          case "revert":
            await runRevertWinner(head);
            break;
          case "swap":
            // quick-t8k: portfolio swap — ship-gated activate-existing, no build.
            await runSwapWinner(head);
            break;
          default:
            // "suggestion" — unchanged. HIST-01: a round winner's provenance
            // is always the normal vote loop.
            await dispatchBuild(head, "vote");
            break;
        }
        // Completion continuation (driveChaosBuild's shape): drain the NEXT
        // queued winner — for ALL three arms. This continuation is never
        // "from HALTED" — a halt leaves the machine HALTED, so the mode check
        // below refuses.
        if (machine.mode === "IDLE") drainVoteQueue();
      })();
      return true;
    };

    // (a) The winner→build trigger (see enqueueWinner wrapper above): fired
    // synchronously from inside closeRound. Starts the queue HEAD — when the
    // round owned the mode (VOTING_ROUND) this starts a build synchronously as
    // today; mode BUILD_IN_PROGRESS → the fresh winner stays queued (concurrent
    // close mid-build); mode IDLE (the round's background build finished
    // mid-vote — the routine 20s-vote/multi-minute-build case) → drains
    // immediately instead of stranding the winner forever (BLOCKER-1).
    onWinnerQueued = () => {
      drainVoteQueue();
    };

    // (b) Build/mode returns to IDLE → drain the next queued winner. SKIP when
    // the PREVIOUS mode was HALTED (reconciliation point 6 / Warning-3: exiting
    // a kill-switch halt never auto-starts a build — queued work resumes at the
    // next round close or manual start). Deferred one tick: finalize()
    // transitions to IDLE BEFORE dequeuing the finished task, so a synchronous
    // drain here would see the finished task still at the queue head and
    // rebuild it.
    let prevDrainMode: StateSnapshot["mode"] = machine.mode;
    machine.on(STATE_CHANGED, (...args) => {
      const snap = args[0] as StateSnapshot;
      const prev = prevDrainMode;
      prevDrainMode = snap.mode;
      if (snap.mode !== "IDLE" || prev === "HALTED") return;
      setImmediate(() => {
        if (machine.mode === "IDLE") drainVoteQueue();
      });
    });

    // (c) Composition-time drain: covers boot with a restored non-empty queue
    // (a no-op today — TaskQueue is in-memory — but harmless and future-proof).
    drainVoteQueue();

    // CR-03: the paid-window build trigger. A queued paid instruction enters
    // BUILD_IN_PROGRESS and runs in the sandbox exactly like a round winner. On
    // completion, if the window is STILL live it returns to FREE_REIGN_WINDOW and
    // drains the NEXT queued instruction (D-12: one window, multiple sequential
    // builds); otherwise it stays IDLE. A build already running → the instruction
    // waits in the queue (returns false = "not started", narrated as "queued").
    driveWindowBuild = (taskId) => {
      if (machine.mode === "BUILD_IN_PROGRESS") return false;
      const task = taskQueue.list().find((t) => t.id === taskId);
      if (!task) return false;
      try {
        if (machine.mode === "FREE_REIGN_WINDOW") machine.transition("BUILD_IN_PROGRESS");
      } catch (err) {
        logger.error(
          { err, taskId },
          "failed to enter BUILD_IN_PROGRESS for a paid-window instruction",
        );
        return false;
      }
      // HIST-01: the changelog provenance is the live window's trigger
      // (donation | channel_points), read off the current snapshot BEFORE the
      // build starts. Fall back to 'donation' only if no snapshot is present.
      const windowProvenance = controlWindow.snapshot()?.trigger ?? "donation";
      void (async () => {
        await dispatchBuild(task, windowProvenance);
        // IDLE = terminal; still BUILD_IN_PROGRESS = decision-pending (streamer
        // owns the next step); HALTED = kill switch owns it.
        if (machine.mode !== "IDLE") return;
        const snap = controlWindow.snapshot();
        if (snap !== null && snap.endsAtMs > Date.now()) {
          try {
            machine.transition("FREE_REIGN_WINDOW");
          } catch (err) {
            logger.error({ err }, "failed to return to FREE_REIGN_WINDOW after a paid build");
            return;
          }
          const next = taskQueue.list()[0];
          if (next) driveWindowBuild?.(next.id);
        }
        // else: the window expired/revoked during the build → stay IDLE.
      })();
      return true;
    };

    // WR-01/CR-03: the chaos build trigger. A queued chaos pick builds like a
    // winner; on completion, if chaos is STILL enabled it returns to CHAOS_MODE
    // and picks the next pool entry (draining the pool one at a time). An empty
    // pool picks nothing — never a busy-loop.
    driveChaosBuild = (taskId) => {
      if (machine.mode === "BUILD_IN_PROGRESS") return false;
      const task = taskQueue.list().find((t) => t.id === taskId);
      if (!task) return false;
      try {
        if (machine.mode === "CHAOS_MODE") machine.transition("BUILD_IN_PROGRESS");
      } catch (err) {
        logger.error({ err, taskId }, "failed to enter BUILD_IN_PROGRESS for a chaos pick");
        return false;
      }
      void (async () => {
        // HIST-01: a chaos pick's provenance is always 'chaos'.
        await dispatchBuild(task, "chaos");
        if (machine.mode !== "IDLE") return;
        if (!chaosOn) return; // chaos turned off during the build → stay IDLE
        try {
          machine.transition("CHAOS_MODE");
        } catch (err) {
          logger.error({ err }, "failed to return to CHAOS_MODE after a chaos build");
          return;
        }
        chaos.pick(); // next pick; null (no build) when the pool is now empty
      })();
      return true;
    };

    // App-under-construction preview surface (PRES-03) — a THIRD isolated
    // localhost surface. Ephemeral port 0 in tests; the entrypoint passes
    // PREVIEW_PORT. The real probe is injected by the entrypoint; a default
    // manager supplies the framed dev-server URL.
    const previewManager = createPreviewManager({
      port: resolvePreviewDevServerPort(process.env.PREVIEW_DEV_SERVER_PORT),
    });
    preview = await startPreviewServer({
      probe: opts.devServerProbe ?? previewManager,
      devServerUrl: previewManager.devServerUrl,
      port: opts.previewPort ?? 0,
      logger,
    });
    logger.info(
      { port: preview.port },
      "app-under-construction preview listening at http://127.0.0.1:%d — add as OBS browser source",
      preview.port,
    );

    // quick-t8k: the orchestrator OWNS the in-distro preview dev server. The
    // supervisor stops+starts it via the EXISTING sandbox adapter exec seam
    // (end-anchored pkill by port — never wsl --terminate) and health-checks
    // through the SAME probe the preview page uses. Every failure path
    // fail-opens to the standing-by state — a supervisor error can never
    // crash the app. Deliberately NOT torn down in close(): leaving the
    // server serving across host restarts is availability by design (the
    // 260711 outage was the server DYING, not living too long).
    const settleRaw = Number.parseInt(process.env.PREVIEW_DEV_SERVER_SETTLE_MS ?? "", 10);
    const devServerSupervisor = createDevServerSupervisor({
      adapter: opts.sandboxAdapter,
      port: previewManager.port,
      workspaceDir: () => workspace.dir(),
      probeReachable: () => (opts.devServerProbe ?? previewManager).reachable(),
      logger,
      // Test knob: PREVIEW_DEV_SERVER_SETTLE_MS=0 makes reroot cycles
      // deterministic-fast in e2e; unset/invalid → the supervisor default.
      ...(Number.isFinite(settleRaw) && settleRaw >= 0 ? { settleMs: settleRaw } : {}),
    });
    // The late-bound seam declared above — swap activation (runSwapWinner),
    // project-switch rotation (shipThenRotate), and the console new-project
    // wrapper all fire it. fire-and-forget: reroot() never rejects.
    reRootPreview = () => void devServerSupervisor.reroot();
    // Boot start: root the preview server at the ACTIVE generation dir with
    // zero manual steps (OPERATIONS.md §11 retires the manual launch).
    void devServerSupervisor.reroot();
  }

  // quick-260716-ko2: the persistent play-link routing lookup. Identical SQL
  // to the announce path's playableRepoStmt — that one lives inside the
  // build-engine composition block and is out of scope here; the durable
  // project_repos row stays the ONLY repo-name source either way (post-gate
  // sanitizeRepoName slug, never chat text).
  const overlayPlayRepoStmt = db.prepare(
    "SELECT repo_name FROM project_repos WHERE generation = @generation",
  );

  // Public OBS overlay (PRES-01) — a physically separate read-only surface,
  // never the console's app/port (D2-17). Ephemeral port 0 by default so
  // parallel test apps never collide; the entrypoint passes OVERLAY_PORT.
  const overlay = await startOverlayServer({
    machine,
    round,
    taskQueue,
    port: opts.overlayPort ?? 0,
    ...(orchestrator ? { build: orchestrator } : {}),
    // Coarse public projection of an active window (T-04-13): donor display name
    // + absolute deadline ONLY — the amount→duration mapping never crosses onto
    // the broadcast wire. The overlay re-narrows again defensively.
    controlWindow: {
      snapshot: () => {
        const snap = controlWindow.snapshot();
        return snap === null
          ? null
          : { donorDisplayName: snap.donorDisplayName, endsAtMs: snap.endsAtMs };
      },
      on: (event, handler) => controlWindow.on(event, handler),
    },
    // quick-rs3 chat-chaos badge source: the controller's {endsAtMs}|null
    // snapshot + CHAOS_MODE_CHANGED beats. The server re-narrows defensively.
    chaosMode: {
      snapshot: () => chaosMode.snapshot(),
      on: (event, handler) => chaosMode.on(event, handler),
    },
    // quick-260716-g8p: the just-published build's playable Pages URL — set by
    // the announce path on publish-confirm, cleared on the next build start.
    // The server re-narrows to exactly {url} defensively.
    playable: {
      snapshot: () => (playableUrl === null ? null : { url: playableUrl }),
      on: (event, handler) => playableEvents.on(event, handler),
    },
    // quick-260716-ko2: the PERSISTENT active-generation play link — PULL-based
    // (OverlayPlayUrlSource), recomputed inside buildOverlayState on every
    // push/connect, so a project switch/swap/rotation flips the URL on the
    // next state push with ZERO new event plumbing. Composed through the ONE
    // URL-construction point (galleryPlayUrl — never duplicated, quick-1ki/g8p
    // doctrine). One prepared indexed SELECT per push (synchronous µs-scale,
    // T-ko2-03 accepted); try/catch fail-closed keeps a DB error off the
    // broadcast path — the line simply stays absent.
    playUrl: {
      current: () => {
        try {
          if (!db.open) return null;
          const row = overlayPlayRepoStmt.get({ generation: workspace.generation() }) as
            | { repo_name: string }
            | undefined;
          return row ? galleryPlayUrl(galleryOwner, row.repo_name) : null;
        } catch (err) {
          logger.error({ err }, "playUrl lookup failed — phase-banner play line stays absent");
          return null;
        }
      },
    },
    // quick-t5k A2: the suggestion-phase guidance countdown source. The server
    // re-narrows to suggestPhase:{endsAtMs} — the enabled flag stays private.
    autoCycle: {
      snapshot: () => autoCycle.snapshot(),
      on: (event, handler) => autoCycle.on(event, handler),
    },
    // quick-v4e what's-coming page: CandidatePool structurally satisfies
    // OverlayPoolSource (list() + EventEmitter.on); the server re-narrows each
    // item to {text, username} display fields only — GateResult never crosses
    // the wire. queueDisplayMax mirrors the scheduler's VOTE_QUEUE_MAX cap.
    pool,
    queueDisplayMax: voteQueueMax,
    // quick-x7d builder view: the SAME feed instance the build session sinks
    // into. The server re-narrows each line to {kind, text} display fields.
    builderFeed,
    logger,
  });
  logger.info(
    { port: overlay.port },
    "public overlay listening at http://127.0.0.1:%d — add as OBS browser source at 1920x1080",
    overlay.port,
  );
  logger.info(
    { port: overlay.port },
    "what's-coming page at http://127.0.0.1:%d/queue — optional OBS browser source",
    overlay.port,
  );
  logger.info(
    { port: overlay.port },
    "builder view at http://127.0.0.1:%d/builder — OBS browser source for THE AI slot",
    overlay.port,
  );

  // Audience-facing build-history changelog (HIST-01) — a FOURTH read-only,
  // loopback-bound surface. Unlike the overlay/preview it holds no orchestrator
  // connection: it reads build_history over the SAME db (pure read-over-db), so
  // it is safe to start unconditionally, including in tests against the in-memory
  // db. Ephemeral port 0 by default; the entrypoint passes HISTORY_PORT.
  const history = await startHistoryServer({
    db,
    port: opts.historyPort ?? 0,
    logger,
  });
  logger.info(
    { port: history.port },
    "build history changelog listening at http://127.0.0.1:%d — open in a browser tab or OBS source",
    history.port,
  );

  // Auto-cycle ignition — LAST, after restore/halt re-entry and every server is
  // up (quick-t5k D-04): a boot into HALTED or a restored VOTING_ROUND parks
  // the scheduler correctly; a clean IDLE boot begins the first 40s suggestion
  // window right here — zero console clicks.
  autoCycle.start();
  logger.info(
    { enabled: autoRoundEnabled, suggestPhaseSeconds, voteQueueMax, voteWaitsForBuild },
    "auto-cycle scheduler started (enabled=%s)",
    autoRoundEnabled,
  );

  return {
    server: console_.server,
    port: console_.port,
    machine,
    db,
    logger,
    pool,
    taskQueue,
    round,
    overlay,
    registry,
    controlWindow,
    chaos,
    autoCycle,
    history,
    ...(orchestrator ? { orchestrator } : {}),
    ...(preview ? { preview } : {}),
    close: async () => {
      // WR-05: cancel the armed round timer FIRST — otherwise a pending
      // closeRound() could fire after db.close() below and crash the
      // process from inside a setTimeout callback.
      round.dispose();
      // Same WR-05 symmetry: a pending suggest-phase timer must never fire
      // startRound against a closed db.
      autoCycle.dispose();
      // quick-rs3: cancel the chaos expiry timer BEFORE db.close() (the
      // onExpired hook writes an audit row — WR-05 symmetry).
      chaosMode.dispose();
      // Cancel the window expiry + 30s-left timers BEFORE db.close() (WR-05
      // symmetry): a pending window timer must never fire against a closed db.
      clearWindowThirtyBeat();
      controlWindow.dispose();
      clearInterval(reviewSweepTimer);
      clearInterval(purgeTimer);
      chatHandle?.stop();
      // Tear the build orchestrator down BEFORE db.close(): abort any in-flight
      // build + unregister so no agent turn can touch a closed db (03-06).
      await orchestrator?.close();
      await preview?.close();
      // Tear down the read-only history surface BEFORE db.close() so no in-flight
      // GET /api/history read can touch a closed db.
      await history.close();
      await overlay.close();
      await console_.close();
      db.close();
    },
  };
}

/** Shape of the uiohook-napi module surface armPanicHotkey needs. */
export interface UiohookModule {
  uIOhook: KeyEventSource;
  UiohookKey: Record<string, number>;
}

export interface ArmPanicHotkeyArgs {
  machine: StreamModeMachine;
  haltDeps: HaltDeps;
  logger: PanicLogger;
  /** PANIC_HOTKEY key name; defaults to the env var, then F13. */
  key?: string | undefined;
  /** Injected in tests. The default is the ONLY place uiohook-napi is imported. */
  loadUiohook?: () => Promise<UiohookModule>;
}

/**
 * Arms the global panic hotkey (D-01): double-tap PANIC_HOTKEY within 2s ->
 * triggerHalt(..., "hotkey"). The native import is guarded — a missing/broken
 * uiohook-napi prebuilt degrades to a loud error and the process keeps running,
 * because the operator console's Halt button must survive hotkey-layer failure
 * (T-01-15). Fallback library if the prebuilt never loads on this machine:
 * node-global-key-listener (RESEARCH.md Environment Availability) — decide
 * post-checkpoint, do not install preemptively.
 */
export async function armPanicHotkey(args: ArmPanicHotkeyArgs): Promise<HotkeyHandle | null> {
  const load =
    args.loadUiohook ?? (async () => (await import("uiohook-napi")) as unknown as UiohookModule);
  try {
    const { uIOhook, UiohookKey } = await load();
    const handle = startHotkeyListener({
      key: args.key ?? process.env.PANIC_HOTKEY,
      onPanic: () => {
        if (args.machine.mode === "HALTED") {
          // Already halted: never re-force the transition — that would overwrite
          // the frozen pre-halt snapshot the D-04 triage view depends on.
          args.logger.info({}, "panic hotkey pressed while already HALTED — ignored");
          return;
        }
        triggerHalt(args.machine, args.haltDeps, "hotkey");
      },
      logger: args.logger,
      hook: uIOhook,
      keyMap: UiohookKey,
    });
    args.logger.info(
      { key: handle.key },
      "panic hotkey armed: %s (double-tap within 2s)",
      handle.key,
    );
    return handle;
  } catch (err) {
    args.logger.error(
      { err },
      "PANIC HOTKEY UNAVAILABLE — console Halt button is the only kill path",
    );
    return null;
  }
}

/** The chat/auth options the entrypoint branch feeds into createApp. */
interface TwitchAppOptions {
  chatSource?: ChatEventSource;
  chatSink?: ChatMessageSink;
  twitchAuth?: TwitchAuthRoutes;
  /** Channel-points redemption source (PAID-02) — rides the SAME EventSub listener. */
  redemptionSource?: RedemptionEventSource;
}

/**
 * Entrypoint-only twurple adapter construction (armPanicHotkey pattern):
 * dynamic imports inside a try/catch, so vitest never loads twurple and a
 * broken/missing Twitch setup degrades to a loud log — console + overlay
 * keep running (graceful degradation). This helper builds REAL adapters and
 * option objects ONLY; all composition (sender, narrator, subscriptions,
 * startTwitchChat, reconcile) lives inside createApp.
 */
async function buildTwitchAdapters(logger: Logger): Promise<TwitchAppOptions> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.warn(
      "TWITCH DISABLED — set TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET to enable chat ingestion",
    );
    return {};
  }
  const consolePort = Number(process.env.CONSOLE_PORT ?? 4900);
  const redirectUri =
    process.env.TWITCH_REDIRECT_URI ?? `http://localhost:${consolePort}/auth/callback`;
  const tokenPath = process.env.TWITCH_TOKEN_PATH ?? "./data/twitch-token.json";
  try {
    const auth = await import("./ingestion/twitch-auth.js");
    const authDeps = { clientId, clientSecret, tokenPath, logger };

    // CR-03: the auth-complete path must reach the LIVE provider once the
    // chat pipeline composes — otherwise a mid-session re-auth registers
    // the fresh token on a throwaway provider and chat stays dead until a
    // restart. Set when (and only when) the full adapters are returned.
    let liveChatProvider: ReturnType<typeof auth.createAuthProvider> = null;
    const twitchAuth: TwitchAuthRoutes = {
      authorizeUrl: (state) => auth.buildAuthorizeUrl({ clientId, redirectUri, state }),
      complete: async (code) => {
        await auth.completeAuthorization(
          authDeps,
          code,
          redirectUri,
          liveChatProvider ?? undefined,
        );
        if (liveChatProvider) {
          logger.info(
            "Twitch re-authorization registered on the running chat pipeline — no restart needed",
          );
          return { chatLive: true };
        }
        logger.warn(
          "Twitch authorized and token persisted — RESTART the app to connect chat (the pipeline composes at boot)",
        );
        return { chatLive: false };
      },
    };

    const provider = auth.createAuthProvider(authDeps);
    if (!provider) {
      logger.warn(
        "TWITCH DISABLED — no token; authorize at http://127.0.0.1:%d/auth/start",
        consolePort,
      );
      return { twitchAuth }; // /auth/start still works — re-auth path stays open
    }
    const broadcasterUserId = process.env.TWITCH_BROADCASTER_USER_ID;
    if (!broadcasterUserId) {
      logger.warn("TWITCH DISABLED — set TWITCH_BROADCASTER_USER_ID (numeric Twitch user id)");
      return { twitchAuth };
    }

    const { ApiClient } = await import("@twurple/api");
    const { EventSubWsListener } = await import("@twurple/eventsub-ws");
    const apiClient = new ApiClient({ authProvider: provider });
    const listener = new EventSubWsListener({ apiClient });

    // Thin arrow-function adapters behind the two seam interfaces — the only
    // twurple-touching code outside src/ingestion/twitch-auth.ts.
    const chatSource: ChatEventSource = {
      onChannelChatMessage: (broadcasterId, userId, handler) =>
        listener.onChannelChatMessage(broadcasterId, userId, (event) =>
          handler({
            chatterId: event.chatterId,
            chatterDisplayName: event.chatterDisplayName,
            messageText: event.messageText,
          }),
        ),
      onUserSocketReady: (handler) =>
        listener.onUserSocketReady((userId, sessionId) => handler(userId, sessionId)),
      onUserSocketDisconnect: (handler) =>
        listener.onUserSocketDisconnect((userId, error) => handler(userId, error)),
      start: () => listener.start(),
      stop: () => listener.stop(),
    };
    // ApiClient.chat structurally satisfies ChatMessageSink — passing it
    // directly keeps the sanctioned send call inside chat-sender.ts only.
    const chatSink: ChatMessageSink = apiClient.chat;

    // Channel-points redemptions (PAID-02) ride the SAME `listener` — NEVER a
    // second EventSubWsListener. makeRedemptionSource owns the zod validation +
    // fail-closed dispatch; here we only forward twurple's typed event into its
    // handleRaw as the snake_case shape the schema expects. The subscription
    // needs channel:read:redemptions (added to TWITCH_SCOPES in 04-02); if the
    // broadcaster hasn't re-authorized, it degrades LOUDLY (missing-scope) and
    // chat/voting/builds keep running — never a silent failure.
    const redemptionSource = makeRedemptionSource(logger);
    try {
      listener.onChannelRedemptionAdd(broadcasterUserId, (event) => {
        redemptionSource.handleRaw({
          id: event.id,
          broadcaster_user_id: event.broadcasterId,
          user_id: event.userId,
          user_login: event.userName,
          user_name: event.userDisplayName,
          user_input: event.input,
          status: event.status,
          reward: { id: event.rewardId, title: event.rewardTitle, cost: event.rewardCost },
          redeemed_at: event.redemptionDate.toISOString(),
        });
      });
    } catch (err) {
      if (isMissingRedemptionScopeError(err)) {
        logger.warn(
          "TWITCH missing channel:read:redemptions — channel-points windows disabled; re-authorize at http://127.0.0.1:%d/auth/start",
          consolePort,
        );
      } else {
        logger.error(
          { err },
          "channel-points redemption subscription failed — points-triggered windows disabled",
        );
      }
    }

    // The chat pipeline will compose over THIS provider — a later
    // /auth/callback registers its fresh token here, live (CR-03).
    liveChatProvider = provider;
    return { chatSource, chatSink, twitchAuth, redemptionSource };
  } catch (err) {
    logger.error(
      { err },
      "TWITCH UNAVAILABLE — chat ingestion disabled; console + overlay keep running",
    );
    return {};
  }
}

/** The build-orchestrator adapters the entrypoint branch feeds into createApp. */
interface OrchestratorAppOptions {
  agentRunner?: AgentRunner;
  sandboxAdapter?: SandboxAdapter;
  devServerProbe?: DevServerProbe;
}

/**
 * Entrypoint-only build-orchestrator adapter construction (armPanicHotkey /
 * buildTwitchAdapters pattern): dynamic imports inside a try/catch so vitest
 * never loads the real SDK/WSL2 layer and a missing/broken sandbox or Agent SDK
 * degrades to a LOUD log — console + overlay + the vote loop keep running
 * (graceful degradation; never crash the process). Only when BOTH the real
 * AgentRunner AND the WSL2 SandboxAdapter build does createApp compose the build
 * engine — so a broken sandbox never runs a build unsandboxed (T-03-23).
 */
async function buildOrchestratorAdapters(logger: Logger): Promise<OrchestratorAppOptions> {
  try {
    const { createSdkAgentRunner } = await import("./orchestrator/sdk-runner.js");
    const { createSandboxAdapter } = await import("./orchestrator/sandbox-process.js");
    const { createPreviewManager: makePreview, openTcpConnection } = await import(
      "./preview/preview-manager.js"
    );
    const agentRunner = createSdkAgentRunner();
    const sandboxAdapter = createSandboxAdapter({ logger });
    const devServerProbe = makePreview({
      port: resolvePreviewDevServerPort(process.env.PREVIEW_DEV_SERVER_PORT),
      connect: openTcpConnection,
    });
    logger.info("BUILD ENGINE ARMED — real SDK AgentRunner + WSL2 sandbox adapter");
    return { agentRunner, sandboxAdapter, devServerProbe };
  } catch (err) {
    logger.error(
      { err },
      "BUILD ENGINE UNAVAILABLE — SDK/WSL2 adapter failed to load; console + overlay + vote loop keep running",
    );
    return {};
  }
}

/**
 * Entrypoint-only classifier-transport construction (buildOrchestratorAdapters
 * pattern): a guarded dynamic import so vitest never loads the real Agent SDK
 * and a missing/broken SDK degrades to a LOUD log + a fail-closed gate rather
 * than a crash. Billing is Claude-plan credits via `claude login` —
 * ANTHROPIC_API_KEY stays UNSET on the streaming machine (CLAUDE.md "What NOT to
 * Use"). Absent transport → the gate fails closed on every submission (D-2/D-11).
 */
async function buildClassifierTransport(logger: Logger): Promise<ClassifierTransport | undefined> {
  try {
    const { createClassifierTransport } = await import("./orchestrator/classifier-runner.js");
    logger.info("COMPLIANCE CLASSIFIER ARMED — plan-billed Sonnet transport (Agent SDK query())");
    return createClassifierTransport();
  } catch (err) {
    logger.error(
      { err },
      "COMPLIANCE CLASSIFIER UNAVAILABLE — Agent SDK failed to load; the gate will FAIL CLOSED on every submission until `claude login` / plan credentials are available",
    );
    return undefined;
  }
}

/**
 * Entrypoint-only StreamElements donation adapter (buildTwitchAdapters pattern):
 * connectStreamElements dynamically imports socket.io-client, so vitest never
 * opens a real socket. Guarded behind STREAMELEMENTS_JWT presence — an absent
 * JWT degrades to "donations unconfigured" (the expected pre-setup state), a
 * broken socket to a LOUD error; the vote loop keeps running either way
 * (T-04-25). The JWT is a server-side secret — it is passed through and NEVER
 * logged (T-04-22, mirrors twitch-auth token discipline).
 */
async function buildDonationAdapter(logger: Logger): Promise<DonationEventSource | undefined> {
  const jwt = process.env.STREAMELEMENTS_JWT;
  if (!jwt) {
    logger.warn(
      "DONATIONS DISABLED — set STREAMELEMENTS_JWT to enable tip-triggered control windows",
    );
    return undefined;
  }
  // Opt-in smoke-test flag: ONLY the exact string "true" enables it — any other
  // value (including "1"/"TRUE") is OFF. Simulated SE dashboard events open REAL
  // control windows; NEVER enable during a broadcast (T-sfl-02).
  const acceptTestEvents = process.env.SE_ACCEPT_TEST_EVENTS === "true";
  if (acceptTestEvents) {
    // Belt-and-braces with the adapter-level warning (the tested guarantee).
    logger.warn(
      "TEST MODE: SE_ACCEPT_TEST_EVENTS=true — simulated StreamElements events will open real control windows — NEVER enable during a broadcast",
    );
  }
  try {
    const source = await connectStreamElements(jwt, logger, { acceptTestEvents });
    logger.info("DONATIONS ARMED — StreamElements realtime socket connecting");
    return source;
  } catch (err) {
    logger.error(
      { err },
      "DONATIONS UNAVAILABLE — StreamElements socket failed to open; the vote loop keeps running",
    );
    return undefined;
  }
}

/**
 * Per-project gallery publisher construction (quick-260711-hak). Built INSIDE
 * createApp from the app db — the ProjectRepoStore needs the durable
 * project_repos table. Disabled (GALLERY_PUBLISH_ENABLED=false OR no
 * GALLERY_GITHUB_TOKEN) → a loud warn + undefined, so createApp composes no
 * publisher and done builds simply don't snapshot. NOTE (v1 decision): publishNow
 * is NOT wired to any timer — per-build commits ARE the cadence; the exported
 * publishNow seam is the future manual-use hook.
 */
function buildGalleryPublisher(
  db: Database.Database,
  logger: Logger,
): GalleryPublisher | undefined {
  const config = resolveGalleryConfig(process.env);
  if (!config) {
    logger.warn(
      "GALLERY PUBLISHING DISABLED — set GALLERY_GITHUB_TOKEN to enable per-project post-build snapshots (owner defaults to TwitchVibecodes)",
    );
    return undefined;
  }
  logger.info(
    { owner: config.owner },
    "GALLERY PUBLISHER ARMED — done builds push one public repo per project under %s via host-side git/gh",
    config.owner,
  );
  return createGalleryPublisher({
    config,
    store: createProjectRepoStore(db),
    // quick-1ki: each confirmed publish also regenerates + pushes the public
    // gallery index site to <owner-lowercased>.github.io (same chain).
    indexEntries: () => listGalleryIndexEntries(db),
    logger,
  });
}

// Run-as-entrypoint branch (npm run dev): tsx executes this file directly.
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.CONSOLE_PORT ?? 4900);
  const overlayPort = Number(process.env.OVERLAY_PORT ?? 4901);
  const previewPort = Number(process.env.PREVIEW_PORT ?? 4902);
  const historyPort = Number(process.env.HISTORY_PORT ?? 4903);
  const dbPath = process.env.AUDIT_DB_PATH ?? "./data/audit.db";
  const bootLogger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  // Entrypoint-only: build real twurple + build-orchestrator adapters (guarded
  // dynamic imports), then hand them to createApp — which owns ALL composition.
  Promise.all([
    buildTwitchAdapters(bootLogger),
    buildOrchestratorAdapters(bootLogger),
    buildDonationAdapter(bootLogger),
    buildClassifierTransport(bootLogger),
  ])
    .then(([twitchOpts, orchestratorOpts, donationSource, classifierTransport]) => {
      // quick-260711-hak: the gallery publisher is now composed INSIDE createApp
      // from the app db (the ProjectRepoStore needs it) — no entrypoint build.
      return createApp({
        dbPath,
        port,
        overlayPort,
        previewPort,
        historyPort,
        ...twitchOpts,
        ...orchestratorOpts,
        ...(donationSource ? { donationSource } : {}),
        ...(classifierTransport ? { classifierTransport } : {}),
      });
    })
    .then((app) =>
      // Entrypoint-only: this is the sole call path that loads the native
      // uiohook module. Test runs (vitest) never reach this branch.
      armPanicHotkey({
        machine: app.machine,
        haltDeps: {
          db: app.db,
          logger: app.logger,
          abortActiveWork: (frozen) => abortActiveWork(app.registry, frozen, app.logger),
        },
        logger: app.logger,
      }),
    )
    .catch((err: unknown) => {
      // Startup failure: log and exit loudly — a silent half-started safety spine
      // is worse than no process at all.
      pino().fatal({ err }, "failed to start");
      process.exit(1);
    });
}
