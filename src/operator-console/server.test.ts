import http from "node:http";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { CandidatePool } from "../queue/pool.js";
import { TaskQueue } from "../queue/task-queue.js";
import type { BuildStatusView } from "../shared/types.js";
import { RoundManager } from "../state-machine/round.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
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
