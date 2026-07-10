import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openDb } from "../../src/audit/db.js";
import { toQueuedTask } from "../../src/compliance/gate.js";
import { createApp } from "../../src/main.js";
import type { SuggestionCandidate } from "../../src/shared/types.js";
import { insertHeld } from "../../src/state-machine/review-queue.js";

/**
 * Console flows e2e (plan 01-04): review queue, veto, triage recovery, dev
 * submission, and session-start hygiene — all against a real HTTP server with
 * a deps-injected fake classifier (no network, ever, in vitest).
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

let app: AppHandle | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const APPROVE_ALL = () =>
  ({ decision: "approved", category: null, rationale: "test: approved" }) as const;

const HOLD_ALL = () =>
  ({ decision: "held-for-review", category: "gambling", rationale: "test: gray zone" }) as const;

async function startApp(
  fakeClassifier: Parameters<typeof createApp>[0]["fakeClassifier"] = APPROVE_ALL,
): Promise<AppHandle> {
  app = await createApp({ dbPath: ":memory:", port: 0, fakeClassifier });
  return app;
}

function baseUrl(handle: AppHandle): string {
  return `http://127.0.0.1:${handle.port}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Poll `fn` until it returns a defined value or the timeout elapses. */
async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(25);
  }
}

interface StateBody {
  mode: string;
  haltContext: { frozen: { mode: string; queuedTaskIds: string[] } } | null;
  pool: Array<{ candidate: SuggestionCandidate }>;
  queue: SuggestionCandidate[];
  pendingReviewCount: number;
}

interface ReviewItemBody {
  id: number;
  text: string;
  twitchUsername: string | null;
  category: string;
  rationale: string;
}

interface AuditRow {
  id: number;
  event_type: string;
  decision: string | null;
  category: string | null;
  suggestion_text: string | null;
  stream_mode: string;
  task_id: string | null;
}

async function getState(handle: AppHandle): Promise<StateBody> {
  const res = await fetch(`${baseUrl(handle)}/api/state`);
  expect(res.status).toBe(200);
  return (await res.json()) as StateBody;
}

async function getReviewList(handle: AppHandle): Promise<ReviewItemBody[]> {
  const res = await fetch(`${baseUrl(handle)}/api/review`);
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewItemBody[];
}

async function getAudit(handle: AppHandle, query = "limit=200"): Promise<AuditRow[]> {
  const res = await fetch(`${baseUrl(handle)}/api/audit?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AuditRow[];
}

describe("dev submission slice (e2e)", () => {
  it("POST /api/dev/submit with an approving classifier lands the candidate in the pool", async () => {
    const handle = await startApp(APPROVE_ALL);
    const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, {
      username: "tester",
      text: "add a dark-mode toggle",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBeTruthy();

    const pooled = await until(async () => {
      const state = await getState(handle);
      return state.pool.find((p) => p.candidate.id === body.id);
    });
    expect(pooled.candidate.text).toBe("add a dark-mode toggle");
    expect(pooled.candidate.twitchUsername).toBe("tester");
    expect(pooled.candidate.source).toBe("operator");
  });

  it("a held-for-review stub lands the item in the pending review list instead", async () => {
    const handle = await startApp(HOLD_ALL);
    const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, {
      username: "tester",
      text: "make a slot machine simulator with play money",
    });
    expect(res.status).toBe(202);

    const item = await until(async () => {
      const list = await getReviewList(handle);
      return list.find((r) => r.text === "make a slot machine simulator with play money");
    });
    expect(item.category).toBe("gambling");
    const state = await getState(handle);
    expect(state.pendingReviewCount).toBe(1);
    expect(state.pool).toHaveLength(0);
  });

  it("rejects malformed submit bodies with 400", async () => {
    const handle = await startApp();
    const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, { username: "", text: "" });
    expect(res.status).toBe(400);
  });

  it("D-02: while HALTED, dev submit is refused with 409 and one submission_refused audit row", async () => {
    const handle = await startApp(APPROVE_ALL);
    const haltRes = await postJson(`${baseUrl(handle)}/api/halt`, {});
    expect(haltRes.status).toBe(200);

    const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, {
      username: "tester",
      text: "add a dark-mode toggle",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("halted");

    const refused = await getAudit(handle, "limit=50&eventType=submission_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.suggestion_text).toBe("add a dark-mode toggle");
    expect(refused[0]?.stream_mode).toBe("HALTED");

    const state = await getState(handle);
    expect(state.pool).toHaveLength(0);
    expect(state.pendingReviewCount).toBe(0);
  });
});

describe("review resolution (e2e, D-05/D-06)", () => {
  async function submitHeld(handle: AppHandle): Promise<ReviewItemBody> {
    const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, {
      username: "grayzone",
      text: "make a slot machine simulator with play money",
    });
    expect(res.status).toBe(202);
    return until(async () => (await getReviewList(handle))[0]);
  }

  it("approve moves the item out of pending and into the pool, with a review_resolved audit row and an untouched original gate_decision row", async () => {
    const handle = await startApp(HOLD_ALL);
    const item = await submitHeld(handle);

    const gateRowsBefore = await getAudit(handle, "limit=50&eventType=gate_decision");
    expect(gateRowsBefore).toHaveLength(1);
    const originalRow = gateRowsBefore[0];

    const approveRes = await postJson(`${baseUrl(handle)}/api/review/${item.id}/approve`, {});
    expect(approveRes.status).toBe(200);

    expect(await getReviewList(handle)).toHaveLength(0);
    const state = await getState(handle);
    expect(state.pool.some((p) => p.candidate.text === item.text)).toBe(true);

    const resolved = await getAudit(handle, "limit=50&eventType=review_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.decision).toBe("approved");

    // D-06: the ORIGINAL gate_decision row is byte-identical after resolution.
    const gateRowsAfter = await getAudit(handle, "limit=50&eventType=gate_decision");
    expect(gateRowsAfter).toHaveLength(1);
    expect(gateRowsAfter[0]).toEqual(originalRow);
  });

  it("reject resolves the item without pooling it and records the optional reason tag", async () => {
    const handle = await startApp(HOLD_ALL);
    const item = await submitHeld(handle);

    const rejectRes = await postJson(`${baseUrl(handle)}/api/review/${item.id}/reject`, {
      reasonTag: "boring",
    });
    expect(rejectRes.status).toBe(200);

    expect(await getReviewList(handle)).toHaveLength(0);
    expect((await getState(handle)).pool).toHaveLength(0);

    const resolved = await getAudit(handle, "limit=50&eventType=review_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.decision).toBe("rejected");
    expect(resolved[0]?.category).toBe("boring");
  });

  it("returns 404 for an unknown review id and 400 for an invalid reason tag", async () => {
    const handle = await startApp(HOLD_ALL);
    const missing = await postJson(`${baseUrl(handle)}/api/review/9999/reject`, {});
    expect(missing.status).toBe(404);

    const item = await submitHeld(handle);
    const badTag = await postJson(`${baseUrl(handle)}/api/review/${item.id}/reject`, {
      reasonTag: "not-a-tag",
    });
    expect(badTag.status).toBe(400);
  });
});

describe("task veto (e2e, D-18 / COMP-05)", () => {
  function makeCandidate(text: string): SuggestionCandidate {
    return {
      id: `task-${Math.random().toString(36).slice(2)}`,
      source: "operator",
      kind: "suggestion",
      twitchUsername: "queuer",
      text,
      submittedAtMs: Date.now(),
    };
  }

  it("veto removes the task and writes a veto audit row carrying the triggering input and reason tag", async () => {
    const handle = await startApp();
    const candidate = makeCandidate("build a giant thing");
    // Tests enqueue through the sanctioned funnel: toQueuedTask on an approved result.
    handle.taskQueue.enqueue(
      toQueuedTask(candidate, { decision: "approved", category: null, rationale: "test" }),
    );
    expect((await getState(handle)).queue).toHaveLength(1);

    const res = await postJson(`${baseUrl(handle)}/api/tasks/${candidate.id}/veto`, {
      reasonTag: "too-big",
    });
    expect(res.status).toBe(200);

    expect((await getState(handle)).queue).toHaveLength(0);
    const vetoes = await getAudit(handle, "limit=50&eventType=veto");
    expect(vetoes).toHaveLength(1);
    expect(vetoes[0]?.suggestion_text).toBe("build a giant thing");
    expect(vetoes[0]?.category).toBe("too-big");
    expect(vetoes[0]?.task_id).toBe(candidate.id);
  });

  it("a follow-up veto POST with only a reason tag records a tag row instead of 404ing (D-18)", async () => {
    const handle = await startApp();
    const candidate = makeCandidate("already vetoed");
    handle.taskQueue.enqueue(
      toQueuedTask(candidate, { decision: "approved", category: null, rationale: "test" }),
    );
    // First click: veto without a tag (the UI acts immediately, tag comes later).
    const first = await postJson(`${baseUrl(handle)}/api/tasks/${candidate.id}/veto`, {});
    expect(first.status).toBe(200);
    // Follow-up one-tap tag: same endpoint, task already gone.
    const followUp = await postJson(`${baseUrl(handle)}/api/tasks/${candidate.id}/veto`, {
      reasonTag: "gut-feeling",
    });
    expect(followUp.status).toBe(200);

    const vetoes = await getAudit(handle, "limit=50&eventType=veto");
    expect(vetoes).toHaveLength(2);
    expect(vetoes.some((v) => v.category === "gut-feeling")).toBe(true);

    // No tag + no such task -> 404.
    const missing = await postJson(`${baseUrl(handle)}/api/tasks/nope/veto`, {});
    expect(missing.status).toBe(404);
  });
});

describe("halt triage + recovery (e2e, D-04)", () => {
  it("halt freezes prior state; recover reset-to-idle returns to IDLE; invalid actions 400", async () => {
    const handle = await startApp();
    const haltRes = await postJson(`${baseUrl(handle)}/api/halt`, {});
    expect(haltRes.status).toBe(200);

    const state = await getState(handle);
    expect(state.mode).toBe("HALTED");
    expect(state.haltContext?.frozen.mode).toBe("IDLE");
    expect(Array.isArray(state.haltContext?.frozen.queuedTaskIds)).toBe(true);

    const invalid = await postJson(`${baseUrl(handle)}/api/recover`, { action: "warp-speed" });
    expect(invalid.status).toBe(400);

    const recoverRes = await postJson(`${baseUrl(handle)}/api/recover`, {
      action: "reset-to-idle",
    });
    expect(recoverRes.status).toBe(200);
    expect((await getState(handle)).mode).toBe("IDLE");
  });

  it("recover outside HALTED is refused with 409", async () => {
    const handle = await startApp();
    const res = await postJson(`${baseUrl(handle)}/api/recover`, { action: "resume" });
    expect(res.status).toBe(409);
  });
});

describe("ws state channel origin check (WR-01)", () => {
  it("drops a handshake carrying a foreign Origin at upgrade time", async () => {
    const handle = await startApp();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
        headers: { origin: "http://evil.example" },
      });
      socket.on("open", () => {
        socket.terminate();
        reject(new Error("cross-origin ws handshake was accepted"));
      });
      socket.on("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        socket.terminate();
        resolve();
      });
      socket.on("error", () => resolve());
    });
  });

  it("accepts the console page's own same-origin handshake and pushes full state", async () => {
    const handle = await startApp();
    const state = await new Promise<{ mode: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
        headers: { origin: `http://127.0.0.1:${handle.port}` },
      });
      socket.on("message", (data) => {
        socket.terminate();
        resolve(JSON.parse(String(data)) as { mode: string });
      });
      socket.on("error", reject);
    });
    expect(state.mode).toBe("IDLE");
  });

  it("accepts a non-browser client (no Origin header)", async () => {
    const handle = await startApp();
    const state = await new Promise<{ mode: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`);
      socket.on("message", (data) => {
        socket.terminate();
        resolve(JSON.parse(String(data)) as { mode: string });
      });
      socket.on("error", reject);
    });
    expect(state.mode).toBe("IDLE");
  });
});

describe("DNS-rebinding defense (CR-02)", () => {
  /**
   * Raw HTTP request with an attacker-controlled Host header — fetch()
   * forbids overriding Host, but a DNS-rebound browser sends exactly this
   * shape: the TCP connection lands on 127.0.0.1 while Host (and Origin)
   * carry the attacker's own name, so Origin and Host AGREE.
   */
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

  it("refuses a rebound GET — Host names a foreign host even though the socket reaches 127.0.0.1", async () => {
    const handle = await startApp();
    const res = await rawRequest(handle.port, {
      method: "GET",
      path: "/api/state",
      headers: { host: `attacker.example:${handle.port}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden host");
  });

  it("refuses a rebound state-changing POST whose Origin and Host AGREE (the self-referential-check bypass)", async () => {
    const handle = await startApp();
    const res = await rawRequest(handle.port, {
      method: "POST",
      path: "/api/halt",
      headers: {
        host: `attacker.example:${handle.port}`,
        origin: `http://attacker.example:${handle.port}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    // The kill switch did NOT fire from off-machine: mode is unchanged.
    const state = (await (await fetch(`${baseUrl(handle)}/api/state`)).json()) as {
      mode: string;
    };
    expect(state.mode).toBe("IDLE");
  });

  it("drops a ws handshake whose Host and Origin are rebound to a foreign name", async () => {
    const handle = await startApp();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
        headers: {
          host: `attacker.example:${handle.port}`,
          origin: `http://attacker.example:${handle.port}`,
        },
      });
      socket.on("open", () => {
        socket.terminate();
        reject(new Error("rebound ws handshake was accepted"));
      });
      socket.on("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        socket.terminate();
        resolve();
      });
      socket.on("error", () => resolve());
    });
  });

  it("still accepts localhost as a loopback alias", async () => {
    const handle = await startApp();
    const res = await rawRequest(handle.port, {
      method: "GET",
      path: "/api/state",
      headers: { host: `localhost:${handle.port}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("session-start hygiene (D-07 + D-17)", () => {
  it("createApp expires pre-existing pending reviews and purges expired-retention audit rows at boot", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "console-flows-"));
    const dbPath = path.join(tempDir, "audit.db");

    // Simulate a previous session: one pending review row + one 200-day-old audit row.
    const seed = openDb(dbPath);
    insertHeld(
      seed,
      {
        id: "leftover-1",
        source: "chat",
        kind: "suggestion",
        twitchUsername: "sleeper",
        text: "left over from last stream",
        submittedAtMs: Date.now() - 1000,
      },
      { decision: "held-for-review", category: "gambling", rationale: "seeded" },
    );
    seed
      .prepare(
        `INSERT INTO audit_log
           (created_at_ms, event_type, source, twitch_username, suggestion_text,
            decision, category, rationale, stream_mode, task_id)
         VALUES (?, 'gate_decision', 'chat', NULL, 'ancient row', 'rejected',
                 'spam-malware', 'seeded old row', 'IDLE', NULL)`,
      )
      .run(Date.now() - 200 * 24 * 3_600_000);
    seed.close();

    const handle = await createApp({ dbPath, port: 0 });
    app = handle;

    // D-07 clean slate: the leftover pending item was expired-unreviewed at boot...
    expect(await getReviewList(handle)).toHaveLength(0);
    const expired = await getAudit(handle, "limit=50&eventType=review_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.decision).toBe("expired-unreviewed");
    expect(expired[0]?.suggestion_text).toBe("left over from last stream");

    // ...and D-17: the 200-day-old audit row was purged at boot.
    const all = await getAudit(handle, "limit=200");
    expect(all.some((r) => r.suggestion_text === "ancient row")).toBe(false);
  });
});

describe("round crash restore (e2e, D2-14)", () => {
  it("a restart mid-round restores the open round with its tally before the console serves", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "round-restore-"));
    const dbPath = path.join(tempDir, "audit.db");

    // Session 1: pool two approved candidates, open a round, record one vote.
    let handle = await createApp({ dbPath, port: 0, fakeClassifier: APPROVE_ALL });
    app = handle;
    for (const text of ["build a snake game", "build a pomodoro timer"]) {
      const res = await postJson(`${baseUrl(handle)}/api/dev/submit`, { username: "tester", text });
      expect(res.status).toBe(202);
    }
    await until(async () => ((await getState(handle)).pool.length === 2 ? true : undefined));
    const started = await postJson(`${baseUrl(handle)}/api/round/start`, {});
    expect(started.status).toBe(200);
    expect(handle.round.recordVote("100123", 1)).toBe(true);

    // "Crash": stop the process mid-round — the rounds row stays 'open' in SQLite.
    await handle.close();
    app = null;

    // Session 2: createApp calls round.restore() BEFORE the console listens
    // (D2-14 ordering), so the very first GET /api/state shows the round.
    handle = await createApp({ dbPath, port: 0, fakeClassifier: APPROVE_ALL });
    app = handle;
    const res = await fetch(`${baseUrl(handle)}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      round: {
        status: string;
        totalVotes: number;
        endsAtMs: number;
        candidates: Array<{ option: number; votes: number }>;
      } | null;
    };
    expect(state.round?.status).toBe("open");
    expect(state.round?.totalVotes).toBe(1);
    expect(state.round?.candidates[0]?.votes).toBe(1);
    // The restored countdown is live, not expired: remaining time survives the restart.
    expect(state.round ? state.round.endsAtMs : 0).toBeGreaterThan(Date.now());
  });
});
