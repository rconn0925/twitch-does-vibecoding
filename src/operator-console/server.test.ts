import http from "node:http";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { CandidatePool } from "../queue/pool.js";
import { TaskQueue } from "../queue/task-queue.js";
import type { BuildStatusView, ControlWindowSnapshot } from "../shared/types.js";
import { RoundManager } from "../state-machine/round.js";
import { InvalidTransitionError, StreamModeMachine } from "../state-machine/stream-mode.js";
import { type ConsoleServerDeps, type ConsoleServerHandle, startConsoleServer } from "./server.js";

/**
 * BUILD-03 / D3-09 console routes: POST /api/tasks/:id/retry and /skip mirror the
 * veto route exactly — zod-validated, they call the injected orchestrator hooks
 * and pushState(), and they INHERIT the uniform CSRF (Origin+Content-Type) +
 * DNS-rebinding loopback-Host middleware with NO new middleware (T-03-25). The
 * build-status source feeds the console decision surface (decisionPending).
 *
 * Real HTTP server on an ephemeral port; every seam injected — no network, no
 * real orchestrator/WSL2/query().
 */

let handle: ConsoleServerHandle | null = null;
let db: Database.Database | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  db?.close();
  db = null;
});

async function startServer(extra: Partial<ConsoleServerDeps> = {}): Promise<ConsoleServerHandle> {
  db = openDb(":memory:");
  const machine = new StreamModeMachine();
  const pool = new CandidatePool();
  const round = new RoundManager({
    db,
    machine,
    pool,
    enqueueWinner: () => ({ queued: true }),
  });
  handle = await startConsoleServer({
    machine,
    db,
    port: 0,
    pool,
    taskQueue: new TaskQueue(),
    round,
    classify: () => Promise.resolve({ decision: "approved", category: null, rationale: "ok" }),
    ...extra,
  });
  return handle;
}

function base(server: ConsoleServerHandle): string {
  return `http://127.0.0.1:${server.port}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Raw HTTP request so we can forge Host/Origin/Content-Type (fetch forbids it). */
function rawRequest(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("console retry/skip routes (BUILD-03 / D3-09)", () => {
  it("POST /api/tasks/:id/retry calls the injected retryBuild hook and returns ok", async () => {
    const retryBuild = vi.fn();
    const server = await startServer({ retryBuild });
    const res = await postJson(`${base(server)}/api/tasks/task-42/retry`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(retryBuild).toHaveBeenCalledExactlyOnceWith("task-42");
  });

  it("POST /api/tasks/:id/skip calls skipTask with the optional reason tag", async () => {
    const skipTask = vi.fn();
    const server = await startServer({ skipTask });
    const res = await postJson(`${base(server)}/api/tasks/task-7/skip`, { reasonTag: "too-big" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(skipTask).toHaveBeenCalledExactlyOnceWith("task-7", "too-big");
  });

  it("skip with no reason tag passes null (routine pacing decision, no friction)", async () => {
    const skipTask = vi.fn();
    const server = await startServer({ skipTask });
    const res = await postJson(`${base(server)}/api/tasks/task-8/skip`, {});
    expect(res.status).toBe(200);
    expect(skipTask).toHaveBeenCalledExactlyOnceWith("task-8", null);
  });

  it("rejects an invalid reason tag with 400 (zod-validated, same as veto)", async () => {
    const skipTask = vi.fn();
    const server = await startServer({ skipTask });
    const res = await postJson(`${base(server)}/api/tasks/task-9/skip`, { reasonTag: "not-a-tag" });
    expect(res.status).toBe(400);
    expect(skipTask).not.toHaveBeenCalled();
  });

  it("no-ops cleanly (200) when no build engine is composed (hooks absent)", async () => {
    const server = await startServer();
    const retry = await postJson(`${base(server)}/api/tasks/x/retry`, {});
    const skip = await postJson(`${base(server)}/api/tasks/x/skip`, {});
    expect(retry.status).toBe(200);
    expect(skip.status).toBe(200);
  });
});

describe("retry/skip inherit the shared CSRF + DNS-rebinding middleware (T-03-25)", () => {
  it("refuses a forged cross-origin retry POST (Origin mismatch) — the hook never fires", async () => {
    const retryBuild = vi.fn();
    const server = await startServer({ retryBuild });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/tasks/task-1/retry",
      headers: {
        host: `127.0.0.1:${server.port}`,
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(retryBuild).not.toHaveBeenCalled();
  });

  it("refuses a skip POST that isn't application/json (the empty-body CSRF loophole)", async () => {
    const skipTask = vi.fn();
    const server = await startServer({ skipTask });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/tasks/task-1/skip",
      headers: { host: `127.0.0.1:${server.port}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(skipTask).not.toHaveBeenCalled();
  });

  it("refuses a DNS-rebound retry POST whose Host names a foreign host", async () => {
    const retryBuild = vi.fn();
    const server = await startServer({ retryBuild });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/tasks/task-1/retry",
      headers: {
        host: `attacker.example:${server.port}`,
        origin: `http://attacker.example:${server.port}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden host");
    expect(retryBuild).not.toHaveBeenCalled();
  });
});

describe("console build-status state (PRES-02/04 + D3-09)", () => {
  it("GET /api/state carries the live build + decision-pending flag from the injected source", async () => {
    let view: BuildStatusView | null = { taskId: "t1", title: "make a counter", stage: "building" };
    const server = await startServer({ buildStatus: () => view });

    let state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      build: { taskId: string; title: string; stage: string; decisionPending: boolean } | null;
    };
    expect(state.build).toEqual({
      taskId: "t1",
      title: "make a counter",
      stage: "building",
      decisionPending: false,
    });

    // A failed/refused stage flips decisionPending → the console shows retry/skip.
    view = { taskId: "t1", title: "make a counter", stage: "refused" };
    state = (await (await fetch(`${base(server)}/api/state`)).json()) as typeof state;
    expect(state.build?.decisionPending).toBe(true);

    // No active build → null (overlay/console panels collapse).
    view = null;
    state = (await (await fetch(`${base(server)}/api/state`)).json()) as typeof state;
    expect(state.build).toBeNull();
  });

  it("build is null when no build-status source is injected", async () => {
    const server = await startServer();
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as { build: unknown };
    expect(state.build).toBeNull();
  });
});

const ACTIVE_WINDOW: ControlWindowSnapshot = {
  donorDisplayName: "GenerousGamer",
  trigger: "donation",
  amountLabel: "$5.00 -> 1:00 window (capped at 5:00)",
  durationMs: 60_000,
  endsAtMs: Date.now() + 60_000,
};

/** A control-window seam fake: starts active, revoke() flips snapshot to null. */
function fakeControlWindow(initial: ControlWindowSnapshot | null = ACTIVE_WINDOW) {
  let current = initial;
  return {
    snapshot: () => current,
    revoke: vi.fn(() => {
      current = null;
    }),
  };
}

describe("console control-window revoke route (PAID-04 / D-03)", () => {
  it("POST /api/control-window/revoke revokes an active window, writes a window_revoked audit row, and returns the now-null snapshot", async () => {
    const controlWindow = fakeControlWindow();
    const server = await startServer({ controlWindow });

    const res = await postJson(`${base(server)}/api/control-window/revoke`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, controlWindow: null });
    expect(controlWindow.revoke).toHaveBeenCalledOnce();

    // Never-silent: the revoke landed a window_revoked ledger row with the donor.
    const audit = (await (
      await fetch(`${base(server)}/api/audit?eventType=window_revoked`)
    ).json()) as Array<{ event_type: string; source: string; twitch_username: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event_type: "window_revoked",
      source: "donation",
      twitch_username: "GenerousGamer",
    });

    // The push reflects the collapsed window (full-state-on-connect / diffs).
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      controlWindow: unknown;
    };
    expect(state.controlWindow).toBeNull();
  });

  it("returns 409 no-window when no window is active (nothing to revoke)", async () => {
    const controlWindow = fakeControlWindow(null);
    const server = await startServer({ controlWindow });
    const res = await postJson(`${base(server)}/api/control-window/revoke`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "no-window" });
    expect(controlWindow.revoke).not.toHaveBeenCalled();
  });

  it("acknowledges the optional D-18 reason-tag follow-up without failing (window already closed)", async () => {
    const controlWindow = fakeControlWindow(null);
    const server = await startServer({ controlWindow });
    const res = await postJson(`${base(server)}/api/control-window/revoke`, {
      reasonTag: "tos-risk",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false, tagged: true });
  });

  it("no-ops to 409 when no control-window seam is composed", async () => {
    const server = await startServer();
    const res = await postJson(`${base(server)}/api/control-window/revoke`, {});
    expect(res.status).toBe(409);
  });
});

describe("console chaos-mode toggle route (CHAOS-01 / D-05)", () => {
  it("POST /api/chaos/toggle flips chaos state via the injected seam and returns it", async () => {
    let on = false;
    const chaos = { enabled: () => on, toggle: vi.fn(() => (on = !on)) };
    const server = await startServer({ chaos });

    const res = await postJson(`${base(server)}/api/chaos/toggle`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chaos: true });
    expect(chaos.toggle).toHaveBeenCalledOnce();

    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as { chaos: boolean };
    expect(state.chaos).toBe(true);
  });

  it("maps a precedence InvalidTransitionError to a terse 409 (window active / not IDLE)", async () => {
    const chaos = {
      enabled: () => false,
      toggle: vi.fn(() => {
        throw new InvalidTransitionError("FREE_REIGN_WINDOW", "CHAOS_MODE");
      }),
    };
    const server = await startServer({ chaos });
    const res = await postJson(`${base(server)}/api/chaos/toggle`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("not-togglable");
  });

  it("no-ops cleanly to 200 when no chaos seam is composed", async () => {
    const server = await startServer();
    const res = await postJson(`${base(server)}/api/chaos/toggle`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chaos: false });
  });
});

describe("Phase 4 routes inherit the shared CSRF + DNS-rebinding middleware (T-04-15)", () => {
  it("refuses a forged cross-origin revoke POST (Origin mismatch) — revoke never fires", async () => {
    const controlWindow = fakeControlWindow();
    const server = await startServer({ controlWindow });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/control-window/revoke",
      headers: {
        host: `127.0.0.1:${server.port}`,
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(controlWindow.revoke).not.toHaveBeenCalled();
  });

  it("refuses a chaos-toggle POST that isn't application/json (empty-body CSRF loophole)", async () => {
    const chaos = { enabled: () => false, toggle: vi.fn() };
    const server = await startServer({ chaos });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/chaos/toggle",
      headers: { host: `127.0.0.1:${server.port}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(chaos.toggle).not.toHaveBeenCalled();
  });

  it("refuses a DNS-rebound revoke POST whose Host names a foreign host", async () => {
    const controlWindow = fakeControlWindow();
    const server = await startServer({ controlWindow });
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/api/control-window/revoke",
      headers: {
        host: `attacker.example:${server.port}`,
        origin: `http://attacker.example:${server.port}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden host");
    expect(controlWindow.revoke).not.toHaveBeenCalled();
  });
});

describe("console Phase 4 state fields (window / chaos / donations / missing-scope)", () => {
  it("GET /api/state carries controlWindow, chaos, donations, and the Twitch missing-scope status", async () => {
    const server = await startServer({
      controlWindow: fakeControlWindow(),
      chaos: { enabled: () => true, toggle: vi.fn() },
      donationsStatus: () => "reconnecting",
      twitchStatus: () => "missing-scope",
    });
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      controlWindow: ControlWindowSnapshot | null;
      chaos: boolean;
      donations: string;
      twitch: string;
    };
    expect(state.controlWindow).toMatchObject({
      donorDisplayName: "GenerousGamer",
      trigger: "donation",
      amountLabel: "$5.00 -> 1:00 window (capped at 5:00)",
    });
    expect(state.chaos).toBe(true);
    expect(state.donations).toBe("reconnecting");
    expect(state.twitch).toBe("missing-scope");
  });

  it("defaults to no window / chaos off / donations unconfigured when no seams are injected", async () => {
    const server = await startServer();
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      controlWindow: unknown;
      chaos: boolean;
      donations: string;
    };
    expect(state.controlWindow).toBeNull();
    expect(state.chaos).toBe(false);
    expect(state.donations).toBe("unconfigured");
  });
});
