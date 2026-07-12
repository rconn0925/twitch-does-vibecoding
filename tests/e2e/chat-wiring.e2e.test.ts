import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";

/**
 * createApp chat composition e2e (plan 02-04 Task 4): a fake ChatEventSource
 * and a capturing ChatMessageSink injected through CreateAppOptions exercise
 * the EXACT production pipeline — sender, narrator, round-event
 * subscriptions, startTwitchChat, reconcile — with zero twurple/network.
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

interface StateBody {
  mode: string;
  twitch: string;
  pool: unknown[];
  round: {
    status: string;
    totalVotes: number;
    candidates: Array<{ option: number; votes: number }>;
  } | null;
}

async function getState(handle: AppHandle): Promise<StateBody> {
  const res = await fetch(`${baseUrl(handle)}/api/state`);
  return (await res.json()) as StateBody;
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

describe("createApp chat composition (fake source + capturing sink)", () => {
  it("!suggest via chat reaches the pool; round open is narrated; !vote mutates the tally", async () => {
    const chat = fakeChatSource();
    const { sent, sink } = capturingSink();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: APPROVE_ALL,
      chatSource: chat.source,
      chatSink: sink,
    });

    // Two viewers suggest through the REAL listener -> intake -> submitCandidate.
    chat.say("101", "alice", "!suggest build a snake game");
    chat.say("102", "bob", "!suggest build a pomodoro timer");
    await until(async () => {
      const state = await getState(app as AppHandle);
      return state.pool.length === 2 ? true : undefined;
    });

    // Streamer starts a round from the console; chat hears the UI-SPEC beat.
    const started = await postJson(`${baseUrl(app)}/api/round/start`, {});
    expect(started.status).toBe(200);
    const openMessage = await until(async () =>
      sent.find((message) => message.startsWith("Voting is OPEN")),
    );
    expect(openMessage).toContain("!vote 1 or 2");
    // quick-q5n kind-aware round-open wording: suggestions render as TWEAK:.
    expect(openMessage).toContain("[1] TWEAK: build a snake game");
    expect(openMessage).toContain("[2] TWEAK: build a pomodoro timer");

    // A chat vote lands in the round ledger, keyed by chatterId.
    chat.say("103", "carol", "!vote 1");
    const state = await until(async () => {
      const current = await getState(app as AppHandle);
      return current.round?.totalVotes === 1 ? current : undefined;
    });
    expect(state.round?.candidates[0]?.votes).toBe(1);
  });

  it("WR-03: a burst of fail-closed rejections sends at most ONE backed-up notice per throttle window", async () => {
    const chat = fakeChatSource();
    const { sent, sink } = capturingSink();
    // D-11 fail-closed shape: rejected with NO category (classifier down).
    const FAIL_CLOSED = () =>
      ({ decision: "rejected", category: null, rationale: "classifier unavailable" }) as const;
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: FAIL_CLOSED,
      chatSource: chat.source,
      chatSink: sink,
    });

    // Five DISTINCT users burst !suggest during the outage — the per-user
    // cooldown lets every one of them through, so without the throttle each
    // would enqueue an identical "backed up" line.
    for (let i = 0; i < 5; i++) {
      chat.say(String(200 + i), `viewer${i}`, `!suggest idea number ${i}`);
    }
    await until(async () =>
      sent.some((m) => m.startsWith("Suggestion check is backed up")) ? true : undefined,
    );
    // Give the sender queue a beat: any (wrong) duplicates would drain now.
    await sleep(150);
    expect(sent.filter((m) => m.startsWith("Suggestion check is backed up"))).toHaveLength(1);
  });

  it("twitch status follows the socket: disconnected until ready, connected after", async () => {
    const chat = fakeChatSource();
    const { sink } = capturingSink();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: APPROVE_ALL,
      chatSource: chat.source,
      chatSink: sink,
    });
    expect((await getState(app)).twitch).toBe("disconnected");
    chat.ready();
    expect((await getState(app)).twitch).toBe("connected");
    chat.disconnect();
    expect((await getState(app)).twitch).toBe("disconnected");
  });

  it("without a chatSource/chatSink pair the app runs degraded as unauthorized", async () => {
    app = await createApp({ dbPath: ":memory:", port: 0, fakeClassifier: APPROVE_ALL });
    expect((await getState(app)).twitch).toBe("unauthorized");
  });

  it("twitchAuth passes through to the console OAuth routes", async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: APPROVE_ALL,
      twitchAuth: {
        authorizeUrl: (state) => `https://id.twitch.tv/oauth2/authorize?state=${state}`,
        complete: () => Promise.resolve({ chatLive: false }),
      },
    });
    const res = await fetch(`${baseUrl(app)}/auth/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });
});

describe("restored-round vote acceptance (02-03 flagged gap, D2-14)", () => {
  it("after a crash-restart mid-round, chat votes on the restored round are accepted", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "chat-restore-"));
    const dbPath = path.join(tempDir, "audit.db");

    // Session 1: two suggestions via chat, round opened, one vote recorded.
    let chat = fakeChatSource();
    let sink = capturingSink().sink;
    app = await createApp({
      dbPath,
      port: 0,
      fakeClassifier: APPROVE_ALL,
      chatSource: chat.source,
      chatSink: sink,
    });
    chat.say("101", "alice", "!suggest build a snake game");
    chat.say("102", "bob", "!suggest build a pomodoro timer");
    await until(async () =>
      (await getState(app as AppHandle)).pool.length === 2 ? true : undefined,
    );
    expect((await postJson(`${baseUrl(app)}/api/round/start`, {})).status).toBe(200);
    chat.say("103", "carol", "!vote 1");
    await until(async () =>
      (await getState(app as AppHandle)).round?.totalVotes === 1 ? true : undefined,
    );

    // "Crash": close mid-round; the rounds row stays 'open' in SQLite.
    await app.close();
    app = null;

    // Session 2: restore() rebuilds the round AND the machine re-enters
    // VOTING_ROUND, so recordVote() accepts chat votes again.
    chat = fakeChatSource();
    sink = capturingSink().sink;
    app = await createApp({
      dbPath,
      port: 0,
      fakeClassifier: APPROVE_ALL,
      chatSource: chat.source,
      chatSink: sink,
    });
    expect(app.machine.mode).toBe("VOTING_ROUND");
    const restored = await getState(app);
    expect(restored.round?.status).toBe("open");
    expect(restored.round?.totalVotes).toBe(1);

    chat.say("200", "erin", "!vote 2");
    const after = await until(async () => {
      const current = await getState(app as AppHandle);
      return current.round?.totalVotes === 2 ? current : undefined;
    });
    expect(after.round?.candidates[1]?.votes).toBe(1);
    expect(after.mode).toBe("VOTING_ROUND");

    // A reconnect after the restore reconciles cleanly against the ledger.
    chat.ready();
    const reconciled = await getState(app);
    expect(reconciled.round?.totalVotes).toBe(2);
  });
});
