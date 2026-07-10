import { describe, expect, it } from "vitest";
import {
  createPreviewManager,
  DEFAULT_PREVIEW_DEV_SERVER_PORT,
  resolvePreviewDevServerPort,
} from "./preview-manager.js";

/**
 * Preview-manager behavior (03-08, PRES-03 / D3-12): the injected DevServerProbe
 * that answers "is the sandboxed dev server up?" — fail-closed, no real network.
 * The real TCP probe (openTcpConnection) is NOT exercised here; tests inject a
 * fake `connect` so no socket is ever opened.
 */

describe("preview-manager (DevServerProbe seam)", () => {
  it("reachable() returns the injected probe's value (true)", async () => {
    const manager = createPreviewManager({ port: 5555, connect: async () => true });
    expect(await manager.reachable()).toBe(true);
  });

  it("reachable() returns the injected probe's value (false)", async () => {
    const manager = createPreviewManager({ port: 5555, connect: async () => false });
    expect(await manager.reachable()).toBe(false);
  });

  it("fails closed: a rejecting probe resolves to false, never throws", async () => {
    const manager = createPreviewManager({
      port: 5555,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(manager.reachable()).resolves.toBe(false);
  });

  it("fails closed: a synchronously-throwing probe resolves to false", async () => {
    const manager = createPreviewManager({
      port: 5555,
      connect: () => {
        throw new Error("boom");
      },
    });
    await expect(manager.reachable()).resolves.toBe(false);
  });

  it("passes the configured port and timeout through to the probe", async () => {
    const calls: Array<[number, number]> = [];
    const manager = createPreviewManager({
      port: 6001,
      timeoutMs: 250,
      connect: async (port, timeoutMs) => {
        calls.push([port, timeoutMs]);
        return true;
      },
    });
    await manager.reachable();
    expect(calls).toEqual([[6001, 250]]);
  });

  it("exposes a loopback dev-server URL built from the fixed port and nothing else", () => {
    const manager = createPreviewManager({ port: 5555, connect: async () => true });
    expect(manager.devServerUrl).toBe("http://localhost:5555");
    expect(manager.port).toBe(5555);
  });

  it("defaults to the SANDBOX-SETUP dev-server port (5555) when none is given", () => {
    const manager = createPreviewManager({ connect: async () => true });
    expect(manager.port).toBe(DEFAULT_PREVIEW_DEV_SERVER_PORT);
    expect(manager.devServerUrl).toBe("http://localhost:5555");
  });

  it("re-probes on every call (stateless across a distro teardown+relaunch)", async () => {
    let up = false;
    const manager = createPreviewManager({ port: 5555, connect: async () => up });
    expect(await manager.reachable()).toBe(false); // torn down
    up = true;
    expect(await manager.reachable()).toBe(true); // relaunched, port re-established
    up = false;
    expect(await manager.reachable()).toBe(false); // torn down again
  });
});

describe("resolvePreviewDevServerPort", () => {
  it("returns the parsed port for a valid value", () => {
    expect(resolvePreviewDevServerPort("6123")).toBe(6123);
  });

  it("falls back to 5555 for undefined, non-numeric, or out-of-range values", () => {
    expect(resolvePreviewDevServerPort(undefined)).toBe(5555);
    expect(resolvePreviewDevServerPort("not-a-port")).toBe(5555);
    expect(resolvePreviewDevServerPort("0")).toBe(5555);
    expect(resolvePreviewDevServerPort("-1")).toBe(5555);
    expect(resolvePreviewDevServerPort("70000")).toBe(5555);
  });
});
