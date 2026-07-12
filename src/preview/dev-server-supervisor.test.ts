import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter } from "../orchestrator/types.js";
import { createDevServerSupervisor } from "./dev-server-supervisor.js";

/**
 * quick-t8k orchestrator-owned preview dev-server supervisor. The reroot cycle
 * is stop → start(workspaceDir()) → settle → probe → ONE retry → fail-open.
 * reroot() NEVER rejects and NEVER throws into any caller — a supervisor
 * failure can only ever log loudly (the preview page's standing-by state
 * covers the broadcast surface). The wsl distro-terminate teardown is NEVER
 * involved (that is the halt path's tool).
 */

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeAdapter(opts: { failStart?: boolean } = {}) {
  const events: string[] = [];
  const adapter: SandboxAdapter = {
    spawn: () => ({}) as never,
    terminate: async () => {
      events.push("terminate");
    },
    async stopPreviewDevServer(port: number) {
      events.push(`stop:${port}`);
    },
    async startPreviewDevServer(dir: string, port: number) {
      events.push(`start:${dir}:${port}`);
      if (opts.failStart) throw new Error("wsl start failed");
    },
  };
  return { adapter, events };
}

describe("createDevServerSupervisor — reroot cycle", () => {
  it("stops THEN starts, rooted at the CURRENT workspaceDir() at call time", async () => {
    const { adapter, events } = fakeAdapter();
    let dir = "/home/builder/projects/app-1";
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => dir,
      probeReachable: async () => true,
      logger: fakeLogger(),
      settleMs: 0,
    });

    await supervisor.reroot();
    expect(events).toEqual(["stop:5555", "start:/home/builder/projects/app-1:5555"]);

    dir = "/home/builder/projects/app-4";
    await supervisor.reroot();
    expect(events.slice(2)).toEqual(["stop:5555", "start:/home/builder/projects/app-4:5555"]);
  });

  it("probe false → exactly ONE stop/start retry; still false → loud error and RESOLVE (fail-open)", async () => {
    const { adapter, events } = fakeAdapter();
    const logger = fakeLogger();
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: async () => false,
      logger,
      settleMs: 0,
    });

    await expect(supervisor.reroot()).resolves.toBeUndefined();
    // Exactly TWO cycles: the original attempt + one retry — never a spin.
    expect(events.filter((e) => e.startsWith("stop:"))).toHaveLength(2);
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it("probe false then true → the retry succeeds, no error logged", async () => {
    const { adapter, events } = fakeAdapter();
    const logger = fakeLogger();
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-2",
      probeReachable: probe,
      logger,
      settleMs: 0,
    });

    await supervisor.reroot();
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a start rejection resolves (fail-open) with a loud error — NEVER a throw into the caller", async () => {
    const { adapter } = fakeAdapter({ failStart: true });
    const logger = fakeLogger();
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: async () => true,
      logger,
      settleMs: 0,
    });

    await expect(supervisor.reroot()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("a throwing probe resolves too (fail-open, never rejects)", async () => {
    const { adapter } = fakeAdapter();
    const logger = fakeLogger();
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: async () => {
        throw new Error("probe blew up");
      },
      logger,
      settleMs: 0,
    });
    await expect(supervisor.reroot()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("NEVER calls terminate() — the distro teardown is the halt path's tool, not the supervisor's", async () => {
    const { adapter, events } = fakeAdapter();
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: async () => false, // even the retry/fail path
      logger: fakeLogger(),
      settleMs: 0,
    });
    await supervisor.reroot();
    expect(events).not.toContain("terminate");
  });

  it("an adapter without the optional methods → ONE warn, silent no-op on every reroot", async () => {
    const adapter: SandboxAdapter = {
      spawn: () => ({}) as never,
      terminate: async () => {},
    };
    const logger = fakeLogger();
    const probe = vi.fn(async () => true);
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: probe,
      logger,
      settleMs: 0,
    });
    await supervisor.reroot();
    await supervisor.reroot();
    expect(logger.warn).toHaveBeenCalledTimes(1); // warn ONCE, not per reroot
    expect(logger.error).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("overlapping reroots serialize strictly one-after-another (the publisher chain idiom)", async () => {
    const events: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const adapter: SandboxAdapter = {
      spawn: () => ({}) as never,
      terminate: async () => {},
      async stopPreviewDevServer() {
        events.push("stop");
      },
      async startPreviewDevServer() {
        events.push("start");
        if (gate.release === null) {
          // FIRST start blocks until released — the second reroot must wait.
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
      },
    };
    const supervisor = createDevServerSupervisor({
      adapter,
      port: 5555,
      workspaceDir: () => "/home/builder/projects/app-1",
      probeReachable: async () => true,
      logger: fakeLogger(),
      settleMs: 0,
    });

    const first = supervisor.reroot();
    const second = supervisor.reroot();
    await sleep(20);
    // The second reroot has NOT begun while the first start is in flight.
    expect(events).toEqual(["stop", "start"]);
    gate.release?.();
    await first;
    await second;
    expect(events).toEqual(["stop", "start", "stop", "start"]);
  });
});
