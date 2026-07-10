import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { type Logger, pino } from "pino";
import { openDb } from "./audit/db.js";
import { purgeOldAuditRecords } from "./audit/purge.js";
import { classifierDepsFromEnv } from "./compliance/classifier.js";
import { classify, type FakeClassifier, type GateDeps } from "./compliance/gate.js";
import { AbortRegistry, abortActiveWork } from "./kill-switch/abort.js";
import {
  type HotkeyHandle,
  type KeyEventSource,
  type PanicLogger,
  startHotkeyListener,
} from "./kill-switch/hotkey.js";
import { type ConsoleServerHandle, startConsoleServer } from "./operator-console/server.js";
import { enqueueWinner } from "./pipeline/round.js";
import { submitCandidate } from "./pipeline/submit.js";
import { CandidatePool } from "./queue/pool.js";
import { TaskQueue } from "./queue/task-queue.js";
import { HALT_TRIGGERED } from "./shared/events.js";
import type { HaltContext } from "./shared/types.js";
import { type HaltDeps, triggerHalt } from "./state-machine/halt.js";
import { expireAllPending, expireStale, reviewTtlMs } from "./state-machine/review-queue.js";
import { RoundManager } from "./state-machine/round.js";
import { StreamModeMachine } from "./state-machine/stream-mode.js";

export interface CreateAppOptions {
  dbPath: string;
  port: number;
  /**
   * Test-injected classifier (vitest never talks to the network). When absent,
   * the live Sonnet classifier is wired from ANTHROPIC_API_KEY; with neither,
   * every submission fails closed (D-11).
   */
  fakeClassifier?: FakeClassifier;
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
  /** Phase 3's orchestrator registers agent-session PIDs/controllers here. */
  registry: AbortRegistry;
  close: () => Promise<void>;
}

/** Review-expiry sweep cadence while the process is up (D-07). */
const REVIEW_SWEEP_INTERVAL_MS = 15 * 60_000;
/** Audit-purge cadence while the process is up (D-17). */
const PURGE_INTERVAL_MS = 24 * 3_600_000;

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
  const pool = new CandidatePool();
  const taskQueue = new TaskQueue();

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

  machine.on(HALT_TRIGGERED, (...args) => {
    const ctx = args[0] as HaltContext;
    logger.warn(
      { source: ctx.source, priorMode: ctx.frozen.mode, reasonTag: ctx.reasonTag },
      "HALT triggered",
    );
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

  // Voting rounds (CHAT-02). The injected wrapper is RoundManager's ONLY
  // bridge to the build queue (COMP-01): it maps the manager's third callback
  // argument — the winner's PERSISTED round_candidates.pooled_at_ms — onto
  // ApprovedCandidate.addedAtMs, which is what makes the D2-05 staleness
  // branch operational in production. Stale winners re-enter submitCandidate
  // for full re-classification instead of riding their old approval.
  const round = new RoundManager({
    db,
    machine,
    pool,
    logger,
    enqueueWinner: (candidate, result, pooledAtMs) =>
      enqueueWinner(
        {
          taskQueue,
          db,
          mode: () => machine.mode,
          resubmit: (c) =>
            submitCandidate(
              {
                db,
                mode: () => machine.mode,
                pool,
                classify: (cand) => classify(gateDeps, cand),
                logger,
              },
              c,
            ),
          logger,
        },
        { candidate, result, addedAtMs: pooledAtMs },
      ),
  });
  // D2-14 ordering contract: restore persisted round state BEFORE any surface
  // (console route, future chat listener) can accept input. A round that
  // expired during downtime closes here; a frozen round waits for triage.
  round.restore();

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
    logger,
  });
  logger.info(
    { port: console_.port, dbPath: opts.dbPath },
    "operator console listening at http://127.0.0.1:%d",
    console_.port,
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
    registry,
    close: async () => {
      clearInterval(reviewSweepTimer);
      clearInterval(purgeTimer);
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

// Run-as-entrypoint branch (npm run dev): tsx executes this file directly.
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.CONSOLE_PORT ?? 4900);
  const dbPath = process.env.AUDIT_DB_PATH ?? "./data/audit.db";
  createApp({ dbPath, port })
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
