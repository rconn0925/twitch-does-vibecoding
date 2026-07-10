import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Chaos-mode e2e (plan 04-07 Task 3), GREEN, against injected fakes — NO
 * network. Toggling chaos on swaps the SELECTION strategy: the next task is a
 * uniform-random pick from the ALREADY gate-filtered pool, enqueued through the
 * sanctioned chaos funnel with NO vote round (CHAOS-01). Voting is refused while
 * chaos is on (D-05 precedence); toggling off reverts to the vote loop. The pick
 * is deterministic under the injected rng.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

function fakeChatSource() {
  const messageHandlers: ((e: ChatMessageEvent) => void)[] = [];
  const source: ChatEventSource = {
    onChannelChatMessage(_broadcasterId, _userId, handler) {
      messageHandlers.push(handler);
      return {};
    },
    onUserSocketReady() {
      return {};
    },
    onUserSocketDisconnect() {
      return {};
    },
    start() {},
    stop() {},
  };
  return { source };
}

function capturingSink() {
  const sent: string[] = [];
  const sink: ChatMessageSink = {
    sendChatMessage(_broadcasterId: string, text: string): Promise<unknown> {
      sent.push(text);
      return Promise.resolve({});
    },
  };
  return { sent, sink };
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

const approved: GateResult = { decision: "approved", category: null, rationale: "test: approved" };

function candidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
  };
}

describe("chaos-mode e2e (toggle → random pick → queue, no vote; voting refused while on)", () => {
  const { sent, sink } = capturingSink();
  let app: AppHandle;

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: fakeChatSource().source,
      chatSink: sink,
      // Deterministic pick: always index 0 (the first pooled candidate).
      chaosRng: () => 0,
    });
    // Seed two ALREADY-approved candidates directly into the pool.
    app.pool.add(candidate("cand-1", "make a snake game"), approved);
    app.pool.add(candidate("cand-2", "make a todo list"), approved);
  });

  afterAll(async () => {
    await app.close();
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${app.port}`;
  }
  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("(1) POST /api/chaos/toggle enters CHAOS_MODE — chaos_toggled audit + narration", async () => {
    const res = await postJson("/api/chaos/toggle", {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { chaos: boolean }).toEqual({ chaos: true });

    expect(app.machine.mode).toBe("CHAOS_MODE");
    const toggled = listAuditRecords(app.db, { limit: 20, eventType: "chaos_toggled" });
    expect(toggled.length).toBeGreaterThanOrEqual(1);

    const onMsg = await until(() => sent.find((m) => m.startsWith("CHAOS MODE ON")));
    // Copy-separation: chaos copy never mentions money/points/tips.
    expect(onMsg).not.toMatch(/money|tip|donation|points|pay/i);
  });

  it("(2) Start Round is REFUSED while chaos is on (D-05 precedence, 409)", async () => {
    const res = await postJson("/api/round/start", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("not-idle");
    // No round was opened.
    expect(app.round.snapshot()).toBeNull();
  });

  it("(3) a chaos pick enqueues a random pool entry with NO vote round (CHAOS-01)", async () => {
    const result = app.chaos.pick();
    expect(result).toEqual({ queued: true });

    // Deterministic under rng=()=>0: the FIRST pooled candidate.
    const queue = app.taskQueue.list();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe("make a snake game");
    // No vote round ran — the pick bypassed voting entirely.
    expect(app.round.snapshot()).toBeNull();

    const picked = listAuditRecords(app.db, { limit: 20, eventType: "chaos_pick" });
    expect(picked).toHaveLength(1);

    const pickMsg = await until(() => sent.find((m) => m.startsWith("Chaos pick:")));
    expect(pickMsg).toContain('"make a snake game"');
  });

  it("(4) toggling chaos off reverts to the vote loop (IDLE) + narration", async () => {
    const res = await postJson("/api/chaos/toggle", {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { chaos: boolean }).toEqual({ chaos: false });

    expect(app.machine.mode).toBe("IDLE");
    const offMsg = await until(() => sent.find((m) => m === "Chaos mode off — voting is back."));
    expect(offMsg).toBeDefined();
  });
});
