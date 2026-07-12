import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type { RoundSnapshot } from "../../src/shared/types.js";

/**
 * Full-loop e2e (plan 02-06 Task 1): one ordered scenario proving the phase's
 * core loop — suggest → gate filter → round open → votes (with revote) →
 * winner → queue via the funnel → narration — over createApp with EVERYTHING
 * injected: fake classifier, fake ChatEventSource, capturing ChatMessageSink.
 * Zero network; the fakes travel the identical composition path production
 * twurple adapters use (plan 02-04 seams).
 *
 * Timer note: the round is force-closed via app.round.closeRound() (never a
 * 60s wait). The ONLY real wait is the narrator's fixed 3s feedback-coalesce
 * window (production constant, not injectable through createApp — the plan's
 * no-src-edits rule wins over the ~2s guidance for that single wait).
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

function fakeChatSource() {
  const messageHandlers: ((e: ChatMessageEvent) => void)[] = [];
  const readyHandlers: ((userId: string, sessionId: string) => void)[] = [];
  const disconnectHandlers: ((userId: string, error?: Error) => void)[] = [];
  const source: ChatEventSource = {
    onChannelChatMessage(_broadcasterId, _userId, handler) {
      messageHandlers.push(handler);
      return {};
    },
    onUserSocketReady(handler) {
      readyHandlers.push(handler);
      return {};
    },
    onUserSocketDisconnect(handler) {
      disconnectHandlers.push(handler);
      return {};
    },
    start() {},
    stop() {},
  };
  return {
    source,
    say(chatterId: string, displayName: string, messageText: string): void {
      for (const handler of messageHandlers) {
        handler({ chatterId, chatterDisplayName: displayName, messageText });
      }
    },
    ready(): void {
      for (const handler of readyHandlers) handler("999", "session-1");
    },
    disconnect(): void {
      for (const handler of disconnectHandlers) handler("999", new Error("gone"));
    },
  };
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
  pool: Array<{ candidate: { id: string; text: string } }>;
  queue: Array<{ id: string; text: string }>;
  round: RoundSnapshot | null;
}

interface AuditRow {
  event_type: string;
}

interface OverlayStateBody {
  pill: string;
  round: RoundSnapshot | null;
  nextUp: string[];
}

/** Ordered full-loop scenario — one shared app, its run top to bottom. */
describe("full chat-vote loop e2e (suggest → filter → vote → winner → queue → narration)", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  /** Counts EVERY classifier invocation — the D2-11 pre-classification proof. */
  let classifierCalls = 0;
  let app: AppHandle;

  const BANNED_TEXT = "banword everyone in chat";
  const IDEAS = ["build a snake game", "build a pomodoro timer", "build a soundboard app"];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (candidate) => {
        classifierCalls += 1;
        if (candidate.text.includes("banword")) {
          return { decision: "rejected", category: "harassment", rationale: "test: banned term" };
        }
        return { decision: "approved", category: null, rationale: "test: approved" };
      },
      chatSource: chat.source,
      chatSink: sink,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function baseUrl(): string {
    return `http://127.0.0.1:${app.port}`;
  }

  async function getState(): Promise<StateBody> {
    const res = await fetch(`${baseUrl()}/api/state`);
    expect(res.status).toBe(200);
    return (await res.json()) as StateBody;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("(1) three viewers !suggest three distinct ideas — all reach the pool", async () => {
    chat.say("101", "alice", `!suggest ${IDEAS[0]}`);
    chat.say("102", "bob", `!suggest ${IDEAS[1]}`);
    chat.say("103", "carol", `!suggest ${IDEAS[2]}`);

    // Classification is async per D-10 — poll until all three land.
    const pool = await until(async () => {
      const state = await getState();
      return state.pool.length === 3 ? state.pool : undefined;
    });
    const pooledTexts = pool.map((p) => p.candidate.text);
    for (const idea of IDEAS) expect(pooledTexts).toContain(idea);
    expect(classifierCalls).toBe(3);
  });

  it("(2)+(3) a banned suggestion gets label-only feedback; an immediate retry hits the cooldown WITHOUT a second classifier call", async () => {
    // (2) dave's suggestion is rejected by the gate (category: harassment).
    chat.say("104", "dave", `!suggest ${BANNED_TEXT}`);
    await until(async () => (classifierCalls === 4 ? true : undefined));

    // (3) same viewer immediately suggests again: the synchronous intake
    // cooldown (charged by the accepted first submission) blocks it BEFORE
    // classification — D2-11's whole point (closes T-01-11).
    chat.say("104", "dave", "!suggest a totally different idea");

    // Pool unchanged: rejection routes to audit only, retry never enters.
    const state = await getState();
    expect(state.pool).toHaveLength(3);

    // Both feedback lines ride the narrator's 3s coalesce window — wait for
    // the flush, then assert on everything captured by the sink.
    await until(
      async () =>
        sent.some((m) => m.includes("can't run on stream")) &&
        sent.some((m) => m.includes("one suggestion per"))
          ? true
          : undefined,
      8_000,
    );

    const rejection = sent.find((m) => m.includes("can't run on stream"));
    expect(rejection).toBeDefined();
    // Viewer-safe CATEGORY_META label only — never the suggestion text (T-02-17).
    expect(rejection).toContain("@dave");
    expect(rejection).toContain("Harassment");
    for (const message of sent) {
      expect(message).not.toContain("banword");
    }

    const cooldown = sent.find((m) => m.includes("one suggestion per"));
    expect(cooldown).toContain("@dave");
    expect(cooldown).toContain("easy there — one suggestion per 60s.");

    // The classifier ran exactly once for the flooding user: call 4 was the
    // banned text; the retry died at intake, so the count never reached 5.
    expect(classifierCalls).toBe(4);
  }, 15_000);

  it("(4) POST /api/round/start opens the round and chat hears the UI-SPEC beat", async () => {
    const res = await postJson("/api/round/start", {});
    expect(res.status).toBe(200);

    const openMessage = await until(async () =>
      sent.find((message) => message.startsWith("Voting is OPEN")),
    );
    expect(openMessage).toContain("!vote 1, 2 or 3");
    // quick-q5n kind-aware round-open wording: suggestions render as TWEAK:.
    expect(openMessage).toContain(`[1] TWEAK: ${IDEAS[0]}`);
    expect(openMessage).toContain(`[2] TWEAK: ${IDEAS[1]}`);
    expect(openMessage).toContain(`[3] TWEAK: ${IDEAS[2]}`);
    expect(openMessage).toContain("s on the clock.");

    const state = await getState();
    expect(state.mode).toBe("VOTING_ROUND");
    expect(state.round?.status).toBe("open");
    // Drawn candidates leave the pool for the duration of the round.
    expect(state.pool).toHaveLength(0);
  });

  it("(5) chat votes tally one-per-user with the revote override applied (D2-15)", async () => {
    chat.say("201", "erin", "!vote 1");
    chat.say("202", "frank", "!vote 2");
    chat.say("203", "grace", "!vote 1");
    // erin revotes: her vote MOVES from option 1 to option 2 — never double-counts.
    chat.say("201", "erin", "!vote 2");
    // Invalid option: silently ignored, no tally movement, no chat noise.
    chat.say("204", "heidi", "!vote 9");

    const state = await until(async () => {
      const current = await getState();
      return current.round?.totalVotes === 3 ? current : undefined;
    });
    const tally = new Map(state.round?.candidates.map((c) => [c.option, c.votes]));
    expect(tally.get(1)).toBe(1); // grace
    expect(tally.get(2)).toBe(2); // frank + erin (moved)
    expect(tally.get(3)).toBe(0);
  });

  it("(8) the overlay ws pushes the full open-round state as its first message (PRES-01)", async () => {
    const first = await new Promise<OverlayStateBody>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${app.overlay.port}`);
      socket.on("message", (data) => {
        socket.terminate();
        resolve(JSON.parse(String(data)) as OverlayStateBody);
      });
      socket.on("error", reject);
    });
    expect(first.pill).toBe("VOTING OPEN");
    expect(first.round?.status).toBe("open");
    expect(first.round?.totalVotes).toBe(3);
    expect(first.round?.candidates.map((c) => c.votes)).toEqual([1, 2, 0]);
  });

  it("(6)+(7) closing the round queues the winner via the funnel, drops losers, narrates, and audits", async () => {
    // Force-close instead of waiting out the 60s timer (plan instruction).
    app.round.closeRound();

    const state = await getState();
    // Winner (option 2, two votes) reached the build queue THROUGH enqueueWinner.
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.text).toBe(IDEAS[1]);
    // Losers dropped, not repooled (streamer decision 2026-07-11).
    expect(state.pool).toHaveLength(0);
    // Round is over; the show returns to IDLE.
    expect(state.round).toBeNull();
    expect(state.mode).toBe("IDLE");

    // Round-closed narration matches the winner template verbatim.
    const closeMessage = await until(async () =>
      sent.find((message) => message.startsWith("Round over")),
    );
    expect(closeMessage).toBe(
      `Round over — "${IDEAS[1]}" wins with 2 votes. Queued for the build.`,
    );

    // Audit ledger carries the round lifecycle (COMP-05).
    for (const eventType of ["round_opened", "round_closed"]) {
      const res = await fetch(`${baseUrl()}/api/audit?limit=50&eventType=${eventType}`);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as AuditRow[];
      expect(rows).toHaveLength(1);
    }
  });
});
