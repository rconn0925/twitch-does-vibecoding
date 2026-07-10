import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import treeKill from "tree-kill";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import type { StateSnapshot } from "../shared/types.js";
import { triggerHalt } from "../state-machine/halt.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import { AbortRegistry, abortActiveWork } from "./abort.js";

vi.mock("tree-kill", () => ({
  default: vi.fn((_pid: number, _signal?: string | number, cb?: (error?: Error) => void) => {
    cb?.();
  }),
}));

const treeKillMock = vi.mocked(treeKill);

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function frozenSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    mode: "BUILD_IN_PROGRESS",
    activeTaskId: null,
    activeTaskPid: null,
    queuedTaskIds: [],
    haltContext: null,
    ...overrides,
  };
}

beforeEach(() => {
  treeKillMock.mockClear();
});

describe("AbortRegistry bookkeeping", () => {
  it("tracks processes and controllers per task and unregister removes them", async () => {
    const registry = new AbortRegistry();
    const acA = new AbortController();
    const acC = new AbortController();
    registry.registerProcess("task-a", 111);
    registry.registerController("task-a", acA);
    registry.registerProcess("task-b", 222);
    registry.registerController("task-c", acC);
    registry.unregister("task-b");

    await abortActiveWork(registry, frozenSnapshot(), fakeLogger());

    expect(acA.signal.aborted).toBe(true);
    expect(acC.signal.aborted).toBe(true);
    expect(treeKillMock).toHaveBeenCalledTimes(1);
    expect(treeKillMock).toHaveBeenCalledWith(111, "SIGKILL", expect.any(Function));
  });

  it("aborts all registered AbortControllers synchronously, before any kill settles", () => {
    const registry = new AbortRegistry();
    const ac = new AbortController();
    registry.registerController("task-a", ac);
    registry.registerProcess("task-a", 111);

    // Deliberately NOT awaited: controllers must already be aborted.
    const pending = abortActiveWork(registry, frozenSnapshot(), fakeLogger());
    expect(ac.signal.aborted).toBe(true);
    return pending;
  });

  it("also tree-kills the frozen snapshot's activeTaskPid when it is not registered", async () => {
    const registry = new AbortRegistry();
    registry.registerProcess("task-a", 111);

    await abortActiveWork(registry, frozenSnapshot({ activeTaskPid: 333 }), fakeLogger());

    expect(treeKillMock).toHaveBeenCalledTimes(2);
    expect(treeKillMock).toHaveBeenCalledWith(111, "SIGKILL", expect.any(Function));
    expect(treeKillMock).toHaveBeenCalledWith(333, "SIGKILL", expect.any(Function));
  });

  it("does not double-kill a pid that is both registered and the frozen activeTaskPid", async () => {
    const registry = new AbortRegistry();
    registry.registerProcess("task-a", 111);

    await abortActiveWork(registry, frozenSnapshot({ activeTaskPid: 111 }), fakeLogger());

    expect(treeKillMock).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox teardown fan-out (BUILD-04)", () => {
  it("invokes every registered sandboxTeardown during abortActiveWork", async () => {
    const registry = new AbortRegistry();
    const teardownA = vi.fn(async () => undefined);
    const teardownB = vi.fn(async () => undefined);
    registry.registerSandboxTeardown("task-a", teardownA);
    registry.registerSandboxTeardown("task-b", teardownB);

    await abortActiveWork(registry, frozenSnapshot(), fakeLogger());

    expect(teardownA).toHaveBeenCalledTimes(1);
    expect(teardownB).toHaveBeenCalledTimes(1);
  });

  it("fires sandboxTeardown alongside controller.abort() + tree-kill on the same task", async () => {
    const registry = new AbortRegistry();
    const ac = new AbortController();
    const teardown = vi.fn(async () => undefined);
    registry.registerController("task-a", ac);
    registry.registerProcess("task-a", 111);
    registry.registerSandboxTeardown("task-a", teardown);

    await abortActiveWork(registry, frozenSnapshot(), fakeLogger());

    expect(ac.signal.aborted).toBe(true);
    expect(treeKillMock).toHaveBeenCalledWith(111, "SIGKILL", expect.any(Function));
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("logs a rejecting teardown and makes the aggregate reject (never swallowed)", async () => {
    const registry = new AbortRegistry();
    const logger = fakeLogger();
    const teardown = vi.fn(async () => {
      throw new Error("wsl --terminate exploded");
    });
    registry.registerSandboxTeardown("task-a", teardown);

    await expect(abortActiveWork(registry, frozenSnapshot(), logger)).rejects.toThrow(
      "wsl --terminate exploded",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("wsl.exe --terminate teardown failed"),
    );
  });

  it("regression: existing controller.abort() + tree-kill behavior is unchanged with no teardowns", async () => {
    const registry = new AbortRegistry();
    const ac = new AbortController();
    registry.registerController("task-a", ac);
    registry.registerProcess("task-a", 111);

    await abortActiveWork(registry, frozenSnapshot(), fakeLogger());

    expect(ac.signal.aborted).toBe(true);
    expect(treeKillMock).toHaveBeenCalledTimes(1);
    expect(treeKillMock).toHaveBeenCalledWith(111, "SIGKILL", expect.any(Function));
  });
});

describe("HALT decoupling (Pattern 2)", () => {
  it("triggerHalt returns synchronously with mode HALTED even when abort hangs forever", () => {
    const machine = new StreamModeMachine();
    const db = openDb(":memory:");
    const hungAbort = (): Promise<void> => new Promise<void>(() => {});

    const start = performance.now();
    triggerHalt(machine, { db, logger: fakeLogger(), abortActiveWork: hungAbort }, "hotkey");
    const durationMs = performance.now() - start;

    expect(machine.mode).toBe("HALTED");
    expect(durationMs).toBeLessThan(100);
    db.close();
  });

  it("triggerHalt's source contains zero awaits — the transition can never block", () => {
    const haltSource = readFileSync(
      fileURLToPath(new URL("../state-machine/halt.ts", import.meta.url)),
      "utf8",
    );
    const start = haltSource.indexOf("export function triggerHalt");
    const end = haltSource.indexOf("export function recover");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const triggerHaltBody = haltSource.slice(start, end);
    expect(triggerHaltBody).not.toMatch(/\bawait\b/);
  });
});

describe("abort failure visibility", () => {
  it("logs tree-kill errors after HALT and never re-throws into the halt path", async () => {
    treeKillMock.mockImplementationOnce(
      (_pid: number, _signal?: unknown, cb?: (error?: Error) => void) => {
        (cb as (error?: Error) => void)?.(new Error("taskkill exploded"));
      },
    );
    const machine = new StreamModeMachine();
    const db = openDb(":memory:");
    const logger = fakeLogger();
    const registry = new AbortRegistry();
    registry.registerProcess("task-a", 111);

    triggerHalt(
      machine,
      { db, logger, abortActiveWork: (frozen) => abortActiveWork(registry, frozen, logger) },
      "console",
    );

    expect(machine.mode).toBe("HALTED");
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("abort attempt failed after HALT"),
      );
    });
    expect(machine.mode).toBe("HALTED");
    db.close();
  });
});
