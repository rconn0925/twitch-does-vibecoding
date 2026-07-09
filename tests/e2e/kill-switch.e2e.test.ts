import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/audit/db.js";
import { listAuditRecords } from "../../src/audit/record.js";
import { AbortRegistry, abortActiveWork } from "../../src/kill-switch/abort.js";
import { triggerHalt } from "../../src/state-machine/halt.js";
import { StreamModeMachine } from "../../src/state-machine/stream-mode.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/hung-process.cjs", import.meta.url));

/** Liveness probe: signal 0 throws (ESRCH) once the process is gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let childPid: number | undefined;

// No orphaned fixtures, ever: kill by pid unconditionally after each test.
afterEach(() => {
  if (childPid !== undefined) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // already dead — the desired end state
    }
    childPid = undefined;
  }
});

/** Spawn the signal-ignoring fixture and wait until its traps are installed. */
async function spawnHungProcess(): Promise<number> {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  childPid = child.pid ?? undefined;
  if (childPid === undefined) {
    throw new Error("failed to spawn hung-process fixture");
  }
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("hung-process fixture exited before ready")));
  });
  // detach the pipe so the parent's event loop doesn't hold on to the child
  child.stdout.destroy();
  child.unref();
  return childPid;
}

describe("kill switch vs. hung process (e2e, real processes)", () => {
  it("HALTED in <100ms, signal-ignoring process tree dead within 5s, halt audited with source hotkey", {
    timeout: 10_000,
  }, async () => {
    const pid = await spawnHungProcess();
    expect(isAlive(pid)).toBe(true);

    const db = openDb(":memory:");
    const machine = new StreamModeMachine();
    machine.transition("VOTING_ROUND");
    machine.transition("BUILD_IN_PROGRESS");
    machine.setActiveTask("hung-task", pid);

    const registry = new AbortRegistry();
    registry.registerProcess("hung-task", pid);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // (a) the HALTED transition is instantaneous, decoupled from the kill
    const start = performance.now();
    triggerHalt(
      machine,
      {
        db,
        logger,
        abortActiveWork: (frozen) => abortActiveWork(registry, frozen, logger),
      },
      "hotkey", // same call path the panic hotkey uses (COMP-04/COMP-05)
    );
    const haltDurationMs = performance.now() - start;
    expect(machine.mode).toBe("HALTED");
    expect(haltDurationMs).toBeLessThan(100);

    // (b) the hung, signal-ignoring process is force-killed within 5 seconds
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await sleep(100);
    }
    expect(isAlive(pid)).toBe(false);

    // (c) the halt is in the audit ledger with source "hotkey" (COMP-05)
    const rows = listAuditRecords(db, { limit: 10, eventType: "halt" });
    expect(rows.some((r) => r.source === "hotkey")).toBe(true);

    db.close();
  });
});
