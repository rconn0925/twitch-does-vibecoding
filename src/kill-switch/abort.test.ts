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
