import type Database from "better-sqlite3";
import { recordHalt, recordVeto } from "../audit/record.js";
import type { HaltContext, ReasonTag, RecoveryAction, StateSnapshot } from "../shared/types.js";
import type { StreamModeMachine } from "./stream-mode.js";

export interface HaltDeps {
  db: Database.Database;
  /** Operational logger for abort-failure visibility. pino's Logger satisfies this. */
  logger?: { error(obj: unknown, msg?: string, ...args: unknown[]): void };
  /**
   * Best-effort abort of in-progress work (src/kill-switch/abort.ts:
   * synchronous AbortController aborts + tree-kill SIGKILL per process tree),
   * invoked fire-and-forget AFTER the HALTED transition has already taken
   * effect. A hung task can never delay the halt (Pattern 2).
   */
  abortActiveWork?: (frozen: StateSnapshot) => Promise<void>;
}

/**
 * The kill switch. SYNCHRONOUS by design (D-02, Success Criterion 3):
 * snapshot -> forceTransition -> recordHalt -> return. Nothing here is
 * awaited; the state machine reports HALTED before any abort work begins.
 */
export function triggerHalt(
  machine: StreamModeMachine,
  deps: HaltDeps,
  source: "hotkey" | "console",
  reasonTag: ReasonTag | null = null,
): StateSnapshot {
  const frozen = machine.snapshot();
  const ctx: HaltContext = { source, reasonTag, frozen };
  machine.forceTransition("HALTED", ctx);
  // WR-04: the machine is already HALTED — an audit-ledger write failure must
  // NEVER unwind or block the kill switch. The state change is the safety
  // action; the missing halt row degrades to a loudly-logged incident
  // (COMP-05 gap made visible) instead of an uncaught exception surfacing as
  // a 500 on the single most safety-critical endpoint.
  try {
    recordHalt(deps.db, { source, priorMode: frozen.mode, reasonTag });
  } catch (err) {
    deps.logger?.error(
      { err },
      "HALT audit write FAILED — halt still in effect, ledger is missing this halt row",
    );
  }

  if (deps.abortActiveWork) {
    // Fire-and-forget (Pattern 2): the state is already HALTED regardless of
    // whether the target dies gracefully. Nothing here may ever be waited on.
    try {
      void deps.abortActiveWork(frozen).catch((err: unknown) => {
        deps.logger?.error({ err }, "abort attempt failed after HALT — task may still be running");
      });
    } catch (err) {
      deps.logger?.error({ err }, "abort attempt failed after HALT — task may still be running");
    }
  }
  return frozen;
}

/**
 * D-04 triage-then-choose recovery. The streamer explicitly picks one of the
 * three actions from the HALTED console view — nothing auto-resumes.
 */
export function recover(
  machine: StreamModeMachine,
  deps: HaltDeps,
  action: RecoveryAction,
  reasonTag: ReasonTag | null = null,
): void {
  if (machine.mode !== "HALTED") {
    throw new Error(`recover() requires mode HALTED, but mode is ${machine.mode}`);
  }
  const ctx = machine.snapshot().haltContext;
  if (!ctx) {
    throw new Error("recover() found no halt context on a HALTED machine — this is a bug");
  }
  const frozen = ctx.frozen;

  switch (action) {
    case "resume":
      machine.recoverTo(frozen.mode);
      return;
    case "discard-and-resume": {
      recordVeto(deps.db, {
        taskId: frozen.activeTaskId,
        suggestionText: null,
        twitchUsername: null,
        reasonTag,
        streamMode: frozen.mode,
      });
      machine.setActiveTask(null, null);
      machine.recoverTo(frozen.mode === "BUILD_IN_PROGRESS" ? "IDLE" : frozen.mode);
      return;
    }
    case "reset-to-idle":
      machine.recoverTo("IDLE");
      return;
  }
}
