import treeKill from "tree-kill";
import type { StateSnapshot } from "../shared/types.js";
import type { PanicLogger } from "./hotkey.js";

/**
 * Best-effort abort of in-progress work (Pattern 2, COMP-04).
 *
 * The state machine flips to HALTED BEFORE anything here runs, and
 * triggerHalt never awaits this module — a genuinely hung task can never
 * delay the operator's feedback that the halt took (Success Criterion 3).
 *
 * Phase 3's orchestrator registers agent-session PIDs and AbortControllers
 * into this exact registry.
 */

interface RegistryEntry {
  pid?: number;
  controller?: AbortController;
}

/** Per-task registry of abortable work: OS processes and in-process controllers. */
export class AbortRegistry {
  #entries = new Map<string, RegistryEntry>();

  registerProcess(taskId: string, pid: number): void {
    const entry = this.#entries.get(taskId) ?? {};
    entry.pid = pid;
    this.#entries.set(taskId, entry);
  }

  registerController(taskId: string, ac: AbortController): void {
    const entry = this.#entries.get(taskId) ?? {};
    entry.controller = ac;
    this.#entries.set(taskId, entry);
  }

  unregister(taskId: string): void {
    this.#entries.delete(taskId);
  }

  /** Read-only view for abortActiveWork. */
  list(): ReadonlyArray<Readonly<RegistryEntry>> {
    return [...this.#entries.values()];
  }
}

/** tree-kill wrapped in a promise; SIGKILL -> `taskkill /pid X /T /F` on Windows. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, "SIGKILL", (err?: Error) => (err ? reject(err) : resolve()));
  });
}

/**
 * Aborts every registered controller synchronously (cooperative, in-process),
 * then force-kills every registered process tree — plus the frozen snapshot's
 * activeTaskPid as defense-in-depth, since plain child.kill() never reaches
 * Windows process-tree descendants (RESEARCH.md tree-kill row).
 *
 * Resolves when every kill callback settles; REJECTS if any kill failed so
 * the caller (triggerHalt's fire-and-forget .catch) logs the failure loudly.
 * NEVER awaited by triggerHalt.
 */
export function abortActiveWork(
  registry: AbortRegistry,
  frozen: StateSnapshot,
  logger: PanicLogger,
): Promise<void> {
  const entries = registry.list();

  // 1) Cooperative aborts, synchronously — an aborting controller can't block a kill.
  for (const entry of entries) {
    try {
      entry.controller?.abort();
    } catch (err) {
      logger.error({ err }, "AbortController.abort() threw — continuing with process kills");
    }
  }

  // 2) Forced process-tree kills, deduped.
  const pids = new Set<number>();
  for (const entry of entries) {
    if (typeof entry.pid === "number") {
      pids.add(entry.pid);
    }
  }
  if (typeof frozen.activeTaskPid === "number") {
    pids.add(frozen.activeTaskPid);
  }

  return Promise.allSettled([...pids].map((pid) => killTree(pid))).then((results) => {
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const failure of failures) {
      logger.error({ err: failure.reason }, "tree-kill failed for a registered process");
    }
    if (failures.length > 0) {
      throw failures[0]?.reason instanceof Error
        ? failures[0].reason
        : new Error("tree-kill failed");
    }
  });
}
