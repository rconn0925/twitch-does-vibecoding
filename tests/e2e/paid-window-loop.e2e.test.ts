import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";

/**
 * Paid-window loop e2e (plan 04-07 Task 3): the demoable paid slice, GREEN,
 * against createApp's injected-fake seams — NO real StreamElements socket / no
 * network. A faked tip opens a guaranteed, gated, time-boxed, revocable window;
 * a donor `!build` instruction passes the IDENTICAL gate every other candidate
 * clears (PAID-03); a rejected instruction is narrated and consumes NO window
 * time (never-silent, D-12); a second concurrent tip is denied (one at a time,
 * D-05); the streamer revoke closes the window and reverts to IDLE.
 *
 * The fakes travel the IDENTICAL composition path the entrypoint's real
 * StreamElements + EventSub adapters use (04-07 wiring), so this proves the
 * production wiring without src edits.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

function fakeDonationSource() {
  const tipHandlers: Array<(tip: TipEvent) => void> = [];
  const readyHandlers: Array<() => void> = [];
  const disconnectHandlers: Array<() => void> = [];
  const source: DonationEventSource = {
    onTip(handler) {
      tipHandlers.push(handler);
    },
    onReady(handler) {
      readyHandlers.push(handler);
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler);
    },
  };
  return {
    source,
    emitTip(tip: TipEvent): void {
      for (const handler of tipHandlers) handler(tip);
    },
    ready(): void {
      for (const handler of readyHandlers) handler();
    },
    disconnect(): void {
      for (const handler of disconnectHandlers) handler();
    },
  };
}

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

const tip = (over: Partial<TipEvent> = {}): TipEvent => ({
  username: "alice",
  displayName: "Alice",
  amount: 5, // $5 → 60s window (donation defaults: rate 12, min 30, max 300)
  currency: "USD",
  message: "take the wheel",
  tipId: "tip-1",
  ...over,
});

interface WindowRow {
  status: string;
}

describe("paid-window loop e2e (tip → window → gated !build → queue → revoke)", () => {
  const donation = fakeDonationSource();
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (candidate) =>
        candidate.text.includes("banword")
          ? { decision: "rejected", category: "harassment", rationale: "test: banned term" }
          : { decision: "approved", category: null, rationale: "test: approved" },
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function activeWindowRows(): WindowRow[] {
    return app.db
      .prepare("SELECT status FROM control_windows WHERE status = 'active'")
      .all() as WindowRow[];
  }

  it("(1) a faked $5 tip opens a FREE_REIGN_WINDOW — durable row + window_opened audit + narration", async () => {
    donation.ready();
    donation.emitTip(tip());

    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");
    const snap = app.controlWindow.snapshot();
    expect(snap).not.toBeNull();
    expect(snap?.donorDisplayName).toBe("Alice");
    expect(snap?.trigger).toBe("donation");

    // Exactly one durable active window row (PAID-04 crash-safe ledger).
    expect(activeWindowRows()).toHaveLength(1);
    // window_opened audit row (never silent, COMP-05).
    const opened = listAuditRecords(app.db, { limit: 20, eventType: "window_opened" });
    expect(opened).toHaveLength(1);

    // Donation-flavoured open narration (trigger-appropriate — "tipped", never a
    // channel-points "redeemed").
    const openMsg = await until(() => sent.find((m) => m.startsWith("@Alice tipped")));
    expect(openMsg).toContain("free reign for 1:00");
    expect(openMsg).toContain("!build");
  });

  it("(2) a donor !build that PASSES the gate lands exactly one QueuedTask via the funnel (PAID-03)", async () => {
    chat.say("201", "Bob", "!build make a counter app");

    await until(() => app.taskQueue.list().length === 1);
    const queued = app.taskQueue.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe("make a counter app");

    const acceptMsg = await until(() => sent.find((m) => m.startsWith("Locked in")));
    expect(acceptMsg).toContain('building @Bob\'s pick: "make a counter app"');

    // The window is STILL active — an accepted build never closes it early.
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");
  });

  it("(3) a REJECTED !build is narrated, NOT enqueued, and consumes no window time (D-12/never-silent)", async () => {
    const before = app.controlWindow.snapshot();
    expect(before).not.toBeNull();
    const endsAtBefore = before?.endsAtMs;

    chat.say("202", "Carol", "!build banword everyone");

    const rejectMsg = await until(() => sent.find((m) => m.startsWith("Can't build that one")));
    expect(rejectMsg).toContain("@Carol");
    // Never leaks the raw instruction text.
    expect(rejectMsg).not.toContain("banword");

    // Not enqueued: the queue is unchanged from step (2).
    expect(app.taskQueue.list()).toHaveLength(1);
    // Window time is NOT consumed — endsAtMs is unchanged, still active.
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");
    expect(app.controlWindow.snapshot()?.endsAtMs).toBe(endsAtBefore);
  });

  it("(4) a second concurrent tip is DENIED — one window at a time (D-05), never a second window", async () => {
    donation.emitTip(tip({ username: "dan", displayName: "Dan", tipId: "tip-2" }));

    const deniedMsg = await until(() => sent.find((m) => m.includes("already running")));
    expect(deniedMsg).toContain("@Dan");

    // Still exactly ONE active window; a window_denied row was written.
    expect(activeWindowRows()).toHaveLength(1);
    const denied = listAuditRecords(app.db, { limit: 20, eventType: "window_denied" });
    expect(denied.length).toBeGreaterThanOrEqual(1);
    // The original window (Alice) is untouched.
    expect(app.controlWindow.snapshot()?.donorDisplayName).toBe("Alice");
  });

  it("(5) the streamer revoke closes the window, reverts to IDLE, and audits window_revoked", async () => {
    app.controlWindow.revoke();

    expect(app.machine.mode).toBe("IDLE");
    expect(app.controlWindow.snapshot()).toBeNull();
    expect(activeWindowRows()).toHaveLength(0);
    const revoked = listAuditRecords(app.db, { limit: 20, eventType: "window_revoked" });
    expect(revoked.length).toBeGreaterThanOrEqual(1);

    const revokeMsg = await until(() => sent.find((m) => m.startsWith("Streamer's call")));
    expect(revokeMsg).toContain("closed early");
  });
});
