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
 *
 * WSL2 caveat (BUILD-04): tree-kill on a sandboxed build's `wsl.exe` wrapper PID
 * does NOT reliably reach the Linux process tree inside the distro
 * (microsoft/WSL#12159, nodejs/node#18431). So a sandboxed build ALSO registers
 * a `sandboxTeardown` primitive that runs `wsl.exe --terminate <distro>` — total
 * and safe under D3-04's concurrency-1 lock — fired alongside (not instead of)
 * the existing controller.abort() + tree-kill fan-out.
 */

interface RegistryEntry {
  pid?: number;
  controller?: AbortController;
  /**
   * Reliable, total WSL2 sandbox teardown (`wsl.exe --terminate <distro>`),
   * required because tree-kill on the wsl.exe wrapper PID is insufficient. Runs
   * in the same fire-and-forget Promise.allSettled fan-out as the tree-kills.
   */
  sandboxTeardown?: () => Promise<void>;
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

  /**
   * Register the WSL2-specific total teardown for a sandboxed build (BUILD-04).
   * Same get-or-create idiom as registerProcess/registerController; the callback
   * (`wsl.exe --terminate <distro>`) is invoked in abortActiveWork's fan-out.
   */
  registerSandboxTeardown(taskId: string, fn: () => Promise<void>): void {
    const entry = this.#entries.get(taskId) ?? {};
    entry.sandboxTeardown = fn;
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
 * Windows process-tree descendants (RESEARCH.md tree-kill row) — and runs every
 * registered WSL2 sandboxTeardown (`wsl.exe --terminate <distro>`) in the SAME
 * fan-out, because tree-kill on the wsl.exe wrapper PID is insufficient
 * (BUILD-04, RESEARCH.md §g).
 *
 * Resolves when every kill AND teardown promise settles; REJECTS if any of them
 * failed so the caller (triggerHalt's fire-and-forget .catch) logs the failure
 * loudly. NEVER awaited by triggerHalt — the HALTED transition is fully
 * decoupled from teardown success (Phase 1 D-02).
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

  const kills: Array<{ what: string; promise: Promise<void> }> = [...pids].map((pid) => ({
    what: "tree-kill failed for a registered process",
    promise: killTree(pid),
  }));

  // 3) WSL2 sandbox teardowns — added to the SAME fire-and-forget fan-out, since
  //    tree-kill on the wsl.exe wrapper PID does not reach the Linux tree.
  for (const entry of entries) {
    if (entry.sandboxTeardown) {
      kills.push({
        what: "wsl.exe --terminate teardown failed for a sandboxed build",
        promise: entry.sandboxTeardown(),
      });
    }
  }

  return Promise.allSettled(kills.map((k) => k.promise)).then((results) => {
    const failures: PromiseRejectedResult[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failures.push(result);
        logger.error({ err: result.reason }, kills[i]?.what ?? "abort primitive failed");
      }
    });
    if (failures.length > 0) {
      throw failures[0]?.reason instanceof Error
        ? failures[0].reason
        : new Error("abort primitive failed");
    }
  });
}
