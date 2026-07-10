import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/audit/db.js";
import {
  type ConsoleServerDeps,
  type ConsoleServerHandle,
  startConsoleServer,
} from "../../src/operator-console/server.js";
import { CandidatePool } from "../../src/queue/pool.js";
import { TaskQueue } from "../../src/queue/task-queue.js";
import { RoundManager } from "../../src/state-machine/round.js";
import { StreamModeMachine } from "../../src/state-machine/stream-mode.js";

/**
 * OAuth bootstrap routes (plan 02-04 Task 3, T-02-16): the GET /auth/callback
 * route writes credentials, so the single-use expiring state nonce is its
 * whole login-CSRF defense — these tests pin that behavior with an injected
 * fake twitchAuth (zero network under vitest).
 */

let handle: ConsoleServerHandle | null = null;
let db: Database.Database | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  db?.close();
  db = null;
});

function fakeTwitchAuth() {
  const completed: string[] = [];
  return {
    completed,
    auth: {
      authorizeUrl: (state: string) =>
        `https://id.twitch.tv/oauth2/authorize?client_id=x&state=${state}`,
      complete: (code: string): Promise<void> => {
        completed.push(code);
        return Promise.resolve();
      },
    },
  };
}

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

/** Run /auth/start and return the state nonce Twitch would echo back. */
async function startAuth(server: ConsoleServerHandle): Promise<string> {
  const res = await fetch(`${base(server)}/auth/start`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const nonce = new URL(location).searchParams.get("state") ?? "";
  expect(nonce).toMatch(/^[0-9a-f]{64}$/); // crypto.randomBytes(32) hex
  return nonce;
}

describe("OAuth bootstrap routes (GET /auth/start, GET /auth/callback)", () => {
  it("returns 503 with the configured-hint copy when twitchAuth is absent", async () => {
    const server = await startServer();
    const start = await fetch(`${base(server)}/auth/start`, { redirect: "manual" });
    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({
      error: "Twitch auth not configured — set TWITCH_CLIENT_ID/SECRET",
    });
    const callback = await fetch(`${base(server)}/auth/callback?code=x&state=y`);
    expect(callback.status).toBe(503);
  });

  it("happy path: start redirects with a nonce; callback with that nonce completes", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    const nonce = await startAuth(server);

    const res = await fetch(`${base(server)}/auth/callback?code=the-code&state=${nonce}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Twitch authorized — you can close this tab");
    expect(completed).toEqual(["the-code"]);
  });

  it("a wrong state returns 403 and never calls complete()", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    await startAuth(server);

    const res = await fetch(`${base(server)}/auth/callback?code=x&state=${"f".repeat(64)}`);
    expect(res.status).toBe(403);
    expect(completed).toEqual([]);
  });

  it("a callback before any /auth/start returns 403 (no stored nonce)", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    const res = await fetch(`${base(server)}/auth/callback?code=x&state=${"a".repeat(64)}`);
    expect(res.status).toBe(403);
    expect(completed).toEqual([]);
  });

  it("missing code or state returns 400 and never calls complete()", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    await startAuth(server);
    expect((await fetch(`${base(server)}/auth/callback?state=abc`)).status).toBe(400);
    expect((await fetch(`${base(server)}/auth/callback?code=abc`)).status).toBe(400);
    expect(completed).toEqual([]);
  });

  it("the nonce is single use: a reused state after success returns 403", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    const nonce = await startAuth(server);

    const first = await fetch(`${base(server)}/auth/callback?code=one&state=${nonce}`);
    expect(first.status).toBe(200);
    const replay = await fetch(`${base(server)}/auth/callback?code=two&state=${nonce}`);
    expect(replay.status).toBe(403);
    expect(completed).toEqual(["one"]);
  });

  it("a second /auth/start invalidates the first nonce (single-slot)", async () => {
    const { auth, completed } = fakeTwitchAuth();
    const server = await startServer({ twitchAuth: auth });
    const firstNonce = await startAuth(server);
    const secondNonce = await startAuth(server);
    expect(firstNonce).not.toBe(secondNonce);

    const stale = await fetch(`${base(server)}/auth/callback?code=x&state=${firstNonce}`);
    expect(stale.status).toBe(403);
    const fresh = await fetch(`${base(server)}/auth/callback?code=y&state=${secondNonce}`);
    expect(fresh.status).toBe(200);
    expect(completed).toEqual(["y"]);
  });

  it("a failing code exchange returns a terse 400, never a stack trace", async () => {
    const server = await startServer({
      twitchAuth: {
        authorizeUrl: (state: string) => `https://id.twitch.tv/oauth2/authorize?state=${state}`,
        complete: () => Promise.reject(new Error("twitch said no")),
      },
    });
    const nonce = await startAuth(server);
    const res = await fetch(`${base(server)}/auth/callback?code=x&state=${nonce}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "authorization failed" });
  });
});

describe("console state twitch key", () => {
  it("GET /api/state reports the injected twitchStatus", async () => {
    const server = await startServer({ twitchStatus: () => "connected" });
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      twitch: string;
    };
    expect(state.twitch).toBe("connected");
  });

  it("GET /api/state defaults to unauthorized without a twitchStatus dep", async () => {
    const server = await startServer();
    const state = (await (await fetch(`${base(server)}/api/state`)).json()) as {
      twitch: string;
    };
    expect(state.twitch).toBe("unauthorized");
  });
});
