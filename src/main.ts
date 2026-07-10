import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { type Logger, pino } from "pino";
import { openDb } from "./audit/db.js";
import { purgeOldAuditRecords } from "./audit/purge.js";
import { recordChaosPick, recordChaosToggled, recordPoolDropped } from "./audit/record.js";
import { pickChaos } from "./chaos/selector.js";
import { CATEGORY_META, isLegalCategory } from "./compliance/categories.js";
import { classifierDepsFromEnv } from "./compliance/classifier.js";
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
import { type ChatMessageSink, createChatSender } from "./ingestion/chat-sender.js";
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
import { type BuildSession, createBuildSession } from "./orchestrator/index.js";
import type {
  AgentRunner,
  DevServerProbe,
  ProgressSink,
  SandboxAdapter,
} from "./orchestrator/types.js";
import { type OverlayServerHandle, startOverlayServer } from "./overlay/server.js";
import { type ChaosPickResult, submitChaosPick } from "./pipeline/chaos.js";
import { submitDuringWindow } from "./pipeline/paid-window.js";
import { enqueueWinner } from "./pipeline/round.js";
import { type SubmitResult, submitCandidate } from "./pipeline/submit.js";
import { createPreviewManager, resolvePreviewDevServerPort } from "./preview/preview-manager.js";
import { type PreviewServerHandle, startPreviewServer } from "./preview/server.js";
import { CandidatePool } from "./queue/pool.js";
import { TaskQueue } from "./queue/task-queue.js";
import {
  HALT_TRIGGERED,
  ROUND_CLOSED,
  ROUND_OPENED,
  WINDOW_CLOSED,
  WINDOW_REVOKED,
} from "./shared/events.js";
import type {
  BuildNarrator,
  ControlWindowSnapshot,
  GateResult,
  HaltContext,
  RoundSnapshot,
  SuggestionCandidate,
} from "./shared/types.js";
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
   * the live Sonnet classifier is wired from ANTHROPIC_API_KEY; with neither,
   * every submission fails closed (D-11).
   */
  fakeClassifier?: FakeClassifier;
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

const DEFAULT_POOL_MAX_SIZE = 50;
const DEFAULT_INTAKE_COOLDOWN_SECONDS = 60;
const DEFAULT_CHAT_SEND_INTERVAL_CAP = 15;
const DEFAULT_CHAT_SEND_INTERVAL_MS = 30_000;

/**
 * Wires the Walking Skeleton: audit db -> state machine -> operator console.
 * Exported factory so the e2e suite can start a real server on an ephemeral
 * port with an in-memory db. pino is operational logging only — the SQLite
 * audit ledger is the compliance record of truth (COMP-05).
 */
export async function createApp(opts: CreateAppOptions): Promise<AppHandle> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

  if (opts.dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  }
  const db = openDb(opts.dbPath);
  const machine = new StreamModeMachine();
  const registry = new AbortRegistry();
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
  const intake = createSuggestIntake({ pool, cooldownMs: intakeCooldownSeconds * 1_000 });

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
  });

  // Compliance-gate deps: injected fake in tests; live Sonnet from
  // ANTHROPIC_API_KEY otherwise; neither -> classify() fails closed (D-11).
  const classifierDeps = opts.fakeClassifier ? null : classifierDepsFromEnv(logger);
  if (!opts.fakeClassifier && !classifierDeps) {
    logger.warn(
      "ANTHROPIC_API_KEY not set — the compliance gate will fail closed on every submission",
    );
  }
  const gateDeps: GateDeps = {
    db,
    logger,
    streamModeProvider: () => machine.mode,
    ...(opts.fakeClassifier ? { fakeClassifier: opts.fakeClassifier } : {}),
    ...(classifierDeps ? { classifier: classifierDeps } : {}),
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
  // WINDOW_OPENED is narrated at the open() call site instead (it needs the
  // amount/reward the coarse snapshot deliberately drops), so it is NOT
  // re-narrated here — avoiding a double beat.
  controlWindow.on(WINDOW_CLOSED, (...args) => {
    clearWindowThirtyBeat();
    const snap = args[0] as ControlWindowSnapshot;
    windowNarrator?.windowExpired(snap.donorDisplayName);
  });
  controlWindow.on(WINDOW_REVOKED, () => {
    clearWindowThirtyBeat();
    windowNarrator?.windowRevoked();
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
      if (chaosOn) windowNarrator?.chaosOn();
      else windowNarrator?.chaosOff();
    },
    pick: (): ChaosPickResult | null => {
      if (machine.mode !== "CHAOS_MODE") return null;
      const picked = pickChaos(pool.list(), opts.chaosRng);
      if (picked === null) return null;
      const result = submitChaosPick(
        { taskQueue, mode: () => machine.mode, resubmit, logger },
        picked,
      );
      if (result.queued) {
        recordChaosPick(db, {
          taskId: picked.candidate.id,
          title: picked.candidate.text,
          streamMode: machine.mode,
        });
        windowNarrator?.chaosPick(picked.candidate.text);
      }
      return result;
    },
  };

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

    // (5b) D-11 open-window routing: while a control window is ACTIVE, ANY
    // chatter's `!build <text>` routes through the ONE funnel
    // (controlWindow.submitInstruction → submitDuringWindow → gate → queue) —
    // there is NO donor-identity gate (an open sponsored slot) and NO direct
    // enqueue here (single-funnel invariant, T-04-23). Parsed like !suggest;
    // outside a window it is silently ignored (no chat noise, D2-15). This is
    // wired as a THIN wrapper over the existing chatSource so main.ts adds no
    // second EventSub subscription — the interceptor delegates every non-!build
    // message to startTwitchChat's own handler.
    const BUILD_COMMAND = /^!build\s+(.+)$/i;
    const routeWindowInstruction = async (displayName: string, text: string): Promise<void> => {
      const candidate: SuggestionCandidate = {
        id: randomUUID(),
        source: "chat",
        kind: "suggestion",
        twitchUsername: displayName,
        text,
        submittedAtMs: Date.now(),
      };
      const result = await controlWindow.submitInstruction(candidate);
      if (result.queued) {
        narrator.instructionAccepted(displayName, text);
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
          const match = BUILD_COMMAND.exec(event.messageText.trim());
          if (match?.[1]) {
            // Only meaningful during an active window (D-11). Consume the token
            // either way so it never falls through to the !suggest/!vote path.
            if (controlWindow.snapshot() !== null) {
              void routeWindowInstruction(event.chatterDisplayName, match[1]);
            }
            return;
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
      snapshot: () => controlWindow.snapshot(),
      revoke: () => controlWindow.revoke(),
    },
    chaos: { enabled: () => chaos.enabled(), toggle: () => chaos.toggle() },
    donationsStatus: () => donationsStatus,
    logger,
  });
  logger.info(
    { port: console_.port, dbPath: opts.dbPath },
    "operator console listening at http://127.0.0.1:%d",
    console_.port,
  );

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
    const buildSession = createBuildSession({
      taskQueue,
      db,
      machine,
      registry,
      agentRunner: opts.agentRunner,
      sandboxAdapter: opts.sandboxAdapter,
      // COMP-02's classify is the SAME app gate, pre-bound to gateDeps (03-04) —
      // drives BOTH the pre-write plan re-screen and the in-flight output re-screen.
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
      logger,
    });
    orchestrator = buildSession;
    // The winner→build trigger (see enqueueWinner wrapper above): synchronously
    // enter BUILD_IN_PROGRESS while still VOTING_ROUND, then start the pipeline.
    onWinnerQueued = (taskId) => {
      const task = taskQueue.list().find((t) => t.id === taskId);
      if (!task) return;
      try {
        if (machine.mode === "VOTING_ROUND") machine.transition("BUILD_IN_PROGRESS");
      } catch (err) {
        logger.error({ err, taskId }, "failed to enter BUILD_IN_PROGRESS for the round winner");
      }
      void buildSession.startBuild(task);
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
  }

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
    logger,
  });
  logger.info(
    { port: overlay.port },
    "public overlay listening at http://127.0.0.1:%d — add as OBS browser source at 1920x1080",
    overlay.port,
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
    ...(orchestrator ? { orchestrator } : {}),
    ...(preview ? { preview } : {}),
    close: async () => {
      // WR-05: cancel the armed round timer FIRST — otherwise a pending
      // closeRound() could fire after db.close() below and crash the
      // process from inside a setTimeout callback.
      round.dispose();
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
  try {
    const source = await connectStreamElements(jwt, logger);
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

// Run-as-entrypoint branch (npm run dev): tsx executes this file directly.
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.CONSOLE_PORT ?? 4900);
  const overlayPort = Number(process.env.OVERLAY_PORT ?? 4901);
  const previewPort = Number(process.env.PREVIEW_PORT ?? 4902);
  const dbPath = process.env.AUDIT_DB_PATH ?? "./data/audit.db";
  const bootLogger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  // Entrypoint-only: build real twurple + build-orchestrator adapters (guarded
  // dynamic imports), then hand them to createApp — which owns ALL composition.
  Promise.all([
    buildTwitchAdapters(bootLogger),
    buildOrchestratorAdapters(bootLogger),
    buildDonationAdapter(bootLogger),
  ])
    .then(([twitchOpts, orchestratorOpts, donationSource]) =>
      createApp({
        dbPath,
        port,
        overlayPort,
        previewPort,
        ...twitchOpts,
        ...orchestratorOpts,
        ...(donationSource ? { donationSource } : {}),
      }),
    )
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
