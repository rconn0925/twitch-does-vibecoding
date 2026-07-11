import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import { BUILD_STAGE_CHANGED } from "../../src/orchestrator/build-session.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";

/**
 * Paid-window loop e2e (plan 04-07 Task 3 + CR-03): the demoable paid slice,
 * GREEN, against createApp's injected-fake seams — NO real StreamElements socket,
 * NO real WSL2/query(), no network. A faked tip opens a guaranteed, gated,
 * time-boxed, revocable window; a donor `!build` instruction passes the IDENTICAL
 * gate (PAID-03) AND — CR-03 — actually reaches buildSession.startBuild and runs
 * in the sandbox (mirroring the round-winner path). On completion the still-live
 * window returns to FREE_REIGN_WINDOW so it can drain its NEXT instruction (D-12:
 * one window, multiple sequential builds). A rejected instruction consumes NO
 * window time; a second concurrent tip is denied (D-05); the streamer revoke
 * closes the window and reverts to IDLE.
 *
 * The fakes travel the IDENTICAL composition path the entrypoint's real
 * StreamElements + EventSub + SDK/WSL2 adapters use, so this proves the
 * production wiring without src edits.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (plain objects; no SDK type import) ──────────────
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/** A fast happy-path AgentRunner: the single sandboxed build write → done (quick-0iu). */
function happyRunner(): AgentRunner {
  return {
    run() {
      return (async function* () {
        yield writeBatch("index.html", "<b>hi</b>") as never;
        yield resultSuccess as never;
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

/** Track build titles that reach `done` — proof a task actually built (CR-03). */
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

const tip = (over: Partial<TipEvent> = {}): TipEvent => ({
  username: "alice",
  displayName: "Alice",
  amount: 5, // $5 → 60s window (donation defaults: rate 12, min 30, max 300)
  currency: "USD",
  message: "take the wheel",
  tipId: "tip-1",
  ...over,
});

const approveExceptBanword = (candidate: { text: string }) =>
  candidate.text.includes("banword")
    ? ({ decision: "rejected", category: "harassment", rationale: "test: banned term" } as const)
    : ({ decision: "approved", category: null, rationale: "test: approved" } as const);

interface WindowRow {
  status: string;
}

describe("paid-window loop e2e (tip → window → gated !build → BUILD → drain → revoke)", () => {
  const donation = fakeDonationSource();
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let built: string[];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: approveExceptBanword,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      agentRunner: happyRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    built = trackBuiltTitles(app);
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

    expect(activeWindowRows()).toHaveLength(1);
    const opened = listAuditRecords(app.db, { limit: 20, eventType: "window_opened" });
    expect(opened).toHaveLength(1);

    const openMsg = await until(() => sent.find((m) => m.startsWith("@Alice tipped")));
    expect(openMsg).toContain("free reign for 1:00");
    expect(openMsg).toContain("!build");
  });

  it("(2) CR-03: a gate-passing !build actually BUILDS in the sandbox, then the live window drains back to FREE_REIGN_WINDOW", async () => {
    chat.say("201", "Bob", "!build make a counter app");

    // Honest narration: the build STARTED, so "Locked in — building", not "queued".
    const acceptMsg = await until(() => sent.find((m) => m.startsWith("Locked in")));
    expect(acceptMsg).toContain('building @Bob\'s pick: "make a counter app"');

    // The task genuinely reached buildSession.startBuild and ran to `done`.
    await until(() => built.includes("make a counter app"));
    // pipeline_stage rows prove it went through the real build pipeline.
    const stages = listAuditRecords(app.db, { limit: 50, eventType: "pipeline_stage" });
    expect(stages.some((r) => r.decision === "done")).toBe(true);

    // The window is STILL active, so on completion the machine returns to
    // FREE_REIGN_WINDOW — ready to drain the NEXT instruction (D-12).
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    expect(app.controlWindow.snapshot()).not.toBeNull();
    // The finished task was dequeued (a completed build never lingers).
    expect(app.taskQueue.list()).toHaveLength(0);

    // HIST-01: the driveWindowBuild driver threads the live window's trigger —
    // a donation window persists the changelog row with provenance 'donation'.
    const entry = listBuildHistory(app.db, { limit: 20 }).find(
      (r) => r.title === "make a counter app",
    );
    expect(entry).toBeDefined();
    expect(entry?.provenance).toBe("donation");
    expect(entry?.result).toBe("built");
  });

  it("(3) a REJECTED !build is narrated, NOT built, and consumes no window time (D-12/never-silent)", async () => {
    const before = app.controlWindow.snapshot();
    const endsAtBefore = before?.endsAtMs;
    const builtBefore = built.length;

    chat.say("202", "Carol", "!build banword everyone");

    const rejectMsg = await until(() => sent.find((m) => m.startsWith("Can't build that one")));
    expect(rejectMsg).toContain("@Carol");
    expect(rejectMsg).not.toContain("banword");

    // Give any (erroneous) build a chance to appear, then assert none did.
    await sleep(50);
    expect(built.length).toBe(builtBefore);
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");
    expect(app.controlWindow.snapshot()?.endsAtMs).toBe(endsAtBefore);
  });

  it("(4) a second concurrent tip is DENIED — one window at a time (D-05), never a second window", async () => {
    donation.emitTip(tip({ username: "dan", displayName: "Dan", tipId: "tip-2" }));

    const deniedMsg = await until(() => sent.find((m) => m.includes("already running")));
    expect(deniedMsg).toContain("@Dan");

    expect(activeWindowRows()).toHaveLength(1);
    const denied = listAuditRecords(app.db, { limit: 20, eventType: "window_denied" });
    expect(denied.length).toBeGreaterThanOrEqual(1);
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

describe("paid-window D-12 loop: multiple instructions build SEQUENTIALLY within one window", () => {
  const donation = fakeDonationSource();
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let built: string[];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: approveExceptBanword,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      agentRunner: happyRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    built = trackBuiltTitles(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("two !build instructions in one window both reach startBuild — one at a time, second narrated 'queued'", async () => {
    donation.ready();
    // A big tip → a long window so both builds fit inside its lifetime.
    donation.emitTip(tip({ amount: 20 })); // 20*12=240s window
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");

    // Fire two instructions back-to-back: the first starts a build; the second
    // queues behind it (concurrency-1) and is narrated honestly as "Queued up".
    chat.say("301", "Ann", "!build first idea");
    chat.say("302", "Ben", "!build second idea");

    const queuedMsg = await until(() =>
      sent.find((m) => m.startsWith("Queued up") && m.includes("second idea")),
    );
    expect(queuedMsg).toContain("as soon as the current one wraps");

    // Both instructions genuinely BUILD (sequentially) inside the one window.
    await until(() => built.includes("first idea") && built.includes("second idea"));

    // Window still live, queue fully drained, back to FREE_REIGN_WINDOW.
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    expect(app.controlWindow.snapshot()).not.toBeNull();
    expect(app.taskQueue.list()).toHaveLength(0);
  });
});
