import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";

/**
 * Tier-2 instant info commands e2e (quick-t8k): !projects / !current / !repo /
 * !help / !commands reply instantly from chat with NO gate call, NO vote, NO
 * state change — one reply per command per INFO_COMMAND_COOLDOWN_SECONDS
 * window (default 30, per-command independent windows), silent while HALTED.
 *
 * !projects lists ONLY post-gate public data: project_repos.repo_name slugs +
 * their github.com links — never raw chat/prompt text (T-t8k-03).
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

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
  return {
    source,
    say(chatterId: string, displayName: string, messageText: string): void {
      for (const handler of messageHandlers) {
        handler({ chatterId, chatterDisplayName: displayName, messageText });
      }
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

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

const HOSTILE_PROMPT = "EVIL RAW PROMPT do dangerous things xss<script>";

describe("info commands e2e: instant replies, per-command cooldown, post-gate data only, HALTED silence", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const classified: string[] = [];
  let app: AppHandle;

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (c) => {
        classified.push(c.text);
        return approved;
      },
      chatSource: chat.source,
      chatSink: sink,
      // NO build engine on purpose: info commands must work regardless — they
      // read project_repos + workspace_state over the app db only.
    });
    // Seed the durable per-project routing table (the publisher's store) the
    // way real publishes would have: two shipped generations.
    const now = Date.now();
    app.db
      .prepare("INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)")
      .run(1, "snake-game", now);
    app.db
      .prepare("INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)")
      .run(2, "dark-theme", now);
    // Pool one HOSTILE (but gate-approved) raw prompt — it must never surface
    // in any info reply (info replies are post-gate repo slugs ONLY).
    chat.say("66", "hostile_user", `!suggest ${HOSTILE_PROMPT}`);
    await until(() => app.pool.list().length === 1);
  });

  afterAll(async () => {
    await app.close();
  });

  it("!projects replies instantly with repo slugs + github links, most-recent generation first", async () => {
    chat.say("1", "asker", "!projects");
    const reply = await until(() => sent.find((m) => m.startsWith("Projects so far:")));
    expect(reply).toBe(
      "Projects so far: dark-theme — https://github.com/TwitchVibecodes/dark-theme | snake-game — https://github.com/TwitchVibecodes/snake-game",
    );
  });

  it("a second !projects inside the cooldown window is a SILENT no-op — exactly ONE reply", async () => {
    chat.say("2", "asker2", "!projects");
    await sleep(150);
    expect(sent.filter((m) => m.startsWith("Projects so far:"))).toHaveLength(1);
  });

  it("!current inside the same window still replies — per-command windows are independent", async () => {
    chat.say("3", "asker3", "!current");
    const reply = await until(() => sent.find((m) => m.startsWith("On screen now:")));
    // Active generation is 1 → snake-game.
    expect(reply).toBe("On screen now: snake-game — https://github.com/TwitchVibecodes/snake-game");
  });

  it("!repo replies with just the current link", async () => {
    chat.say("4", "asker4", "!repo");
    const reply = await until(() => sent.find((m) => m.startsWith("Current project repo:")));
    expect(reply).toBe("Current project repo: https://github.com/TwitchVibecodes/snake-game");
  });

  it("!commands replies with the how-to-interact help copy (alias of !help)", async () => {
    chat.say("5", "asker5", "!commands");
    const reply = await until(() => sent.find((m) => m.startsWith("How it works:")));
    // Explains the interaction model + points to the on-screen list (Ross 2026-07-12).
    expect(reply).toContain("!suggest");
    expect(reply).toContain("!build");
    expect(reply).toContain("!vote");
    expect(reply).toContain("COMMANDS panel");
  });

  it("ZERO funnel contact: info commands never reached the classifier, pool, or queue", () => {
    // Only the seeded hostile !suggest was ever classified.
    expect(classified).toEqual([HOSTILE_PROMPT]);
    expect(app.pool.list()).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("the hostile raw prompt NEVER appears in any info reply (post-gate slugs only)", () => {
    for (const message of sent) {
      expect(message).not.toContain("EVIL RAW PROMPT");
      expect(message).not.toContain("<script>");
    }
  });
});

describe("info commands e2e: silent while HALTED (fresh per-command windows)", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
    });
    app.db
      .prepare("INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)")
      .run(1, "snake-game", Date.now());
  });

  afterAll(async () => {
    await app.close();
  });

  it("no info command replies while the machine is HALTED — no window is charged either", async () => {
    const haltRes = await fetch(`http://127.0.0.1:${app.port}/api/halt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    const before = sent.length;
    chat.say("1", "asker", "!projects");
    chat.say("2", "asker2", "!help");
    await sleep(150);
    expect(sent.length).toBe(before);
  });
});
