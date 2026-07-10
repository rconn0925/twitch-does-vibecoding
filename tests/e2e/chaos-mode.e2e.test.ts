import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import { BUILD_STAGE_CHANGED } from "../../src/orchestrator/build-session.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Chaos-mode e2e (plan 04-07 Task 3 + WR-01/CR-03), GREEN, against injected
 * fakes — NO network, NO real WSL2/query(). Toggling chaos ON now has a REAL
 * production trigger (WR-01): it picks a uniform-random entry from the already
 * gate-filtered pool and — CR-03 — actually BUILDS it in the sandbox through the
 * sanctioned chaos funnel, then picks the NEXT while chaos is still enabled,
 * draining the pool one build at a time. An empty pool picks nothing (never a
 * busy-loop). Voting is refused while chaos is on (D-05 precedence); toggling off
 * reverts to the vote loop. The pick is deterministic under the injected rng.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (plain objects; no SDK type import) ──────────────
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/** A fast happy-path AgentRunner: research → plan → sandboxed build write → done. */
function happyRunner(): AgentRunner {
  return {
    run(spec) {
      const sandboxed = spec.sandbox !== undefined;
      return (async function* () {
        if (spec.agent === "research") {
          yield assistantText("research notes") as never;
          yield resultSuccess as never;
        } else if (spec.agent === "build" && !sandboxed) {
          yield assistantText("Build plan: make a small page.") as never;
          yield resultSuccess as never;
        } else {
          yield writeBatch("index.html", "<b>hi</b>") as never;
          yield resultSuccess as never;
        }
      })();
    },
  };
}

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

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

function trackBuiltTitles(app: AppHandle): string[] {
  const built: string[] = [];
  const orch = app.orchestrator;
  if (!orch) throw new Error("orchestrator was not composed — build engine wiring is broken");
  orch.on(BUILD_STAGE_CHANGED, () => {
    const snap = orch.snapshot();
    if (snap?.stage === "done") built.push(snap.title);
  });
  return built;
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

describe("chaos-mode e2e (toggle → auto-pick → BUILD → re-pick → drain; voting refused while on)", () => {
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let built: string[];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: fakeChatSource().source,
      chatSink: sink,
      agentRunner: happyRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      // Deterministic pick: always index 0 of the (draining) pool.
      chaosRng: () => 0,
    });
    built = trackBuiltTitles(app);
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

  it("(1) WR-01/CR-03: toggling chaos ON auto-picks and BUILDS the pool one at a time, draining it", async () => {
    const res = await postJson("/api/chaos/toggle", {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { chaos: boolean }).toEqual({ chaos: true });

    const toggled = listAuditRecords(app.db, { limit: 20, eventType: "chaos_toggled" });
    expect(toggled.length).toBeGreaterThanOrEqual(1);

    const onMsg = await until(() => sent.find((m) => m.startsWith("CHAOS MODE ON")));
    // Copy-separation: chaos copy never mentions money/points/tips.
    expect(onMsg).not.toMatch(/money|tip|donation|points|pay/i);

    // The production trigger drives real builds: BOTH pooled candidates build,
    // sequentially, with NO vote round — deterministic order under rng=()=>0.
    await until(() => built.length === 2);
    expect(built).toEqual(["make a snake game", "make a todo list"]);
    expect(app.round.snapshot()).toBeNull(); // no vote round ran

    // Exactly two chaos_pick audit rows — one per built pick (never silent).
    const picked = listAuditRecords(app.db, { limit: 20, eventType: "chaos_pick" });
    expect(picked).toHaveLength(2);
  });

  it("(2) with the pool drained, chaos does NOT spin — stays in CHAOS_MODE, idle", async () => {
    // The loop ended by picking from an empty pool (no build). Give it room to
    // (incorrectly) spin, then assert it did not: still exactly two builds.
    await sleep(80);
    expect(built.length).toBe(2);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.machine.mode).toBe("CHAOS_MODE");
    // A manual pick on the empty pool is a null no-op (never a busy-loop).
    expect(app.chaos.pick()).toBeNull();
  });

  it("(3) Start Round is REFUSED while chaos is on (D-05 precedence, 409)", async () => {
    const res = await postJson("/api/round/start", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("not-idle");
    expect(app.round.snapshot()).toBeNull();
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

describe("chaos-mode e2e: toggling ON with an EMPTY pool picks nothing (no spin, WR-01)", () => {
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let built: string[];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: fakeChatSource().source,
      chatSink: sink,
      agentRunner: happyRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chaosRng: () => 0,
    });
    built = trackBuiltTitles(app);
    // Deliberately DO NOT seed the pool.
  });

  afterAll(async () => {
    await app.close();
  });

  it("stays CHAOS_MODE with no picks and no builds when the pool is empty", async () => {
    app.chaos.toggle(); // toggle on directly
    await until(() => sent.some((m) => m.startsWith("CHAOS MODE ON")));

    await sleep(80);
    expect(built).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.machine.mode).toBe("CHAOS_MODE");
    const picked = listAuditRecords(app.db, { limit: 20, eventType: "chaos_pick" });
    expect(picked).toHaveLength(0);
  });
});
