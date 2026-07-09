import type Database from "better-sqlite3";
import { recordHalt, recordVeto } from "../audit/record.js";
import type {
  HaltContext,
  ReasonTag,
  RecoveryAction,
  StateSnapshot,
} from "../shared/types.js";
import type { StreamModeMachine } from "./stream-mode.js";

export interface HaltDeps {
  db: Database.Database;
  /**
   * Named extension point for plan 01-03: best-effort abort of in-progress
   * work (tree-kill on the active task's process tree), invoked with
   * void-and-catch semantics AFTER the HALTED transition has already taken
   * effect. A hung task can never delay the halt (Pattern 2).
   */
  abortActiveWork?: (frozen: StateSnapshot) => void;
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
  recordHalt(deps.db, { source, priorMode: frozen.mode, reasonTag });

  if (deps.abortActiveWork) {
    try {
      deps.abortActiveWork(frozen);
    } catch {
      // Best-effort only: the halt already took effect. Failures here are the
      // abort hook's problem to log (plan 01-03); they never propagate.
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
