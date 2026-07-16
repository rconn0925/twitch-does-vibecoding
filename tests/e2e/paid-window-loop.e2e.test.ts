import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/audit/db.js";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import { insertWindow } from "../../src/control-window/persistence.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import { BUILD_STAGE_CHANGED } from "../../src/orchestrator/build-session.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";

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

// ── quick-260716-h73 helpers (auto-cycle e2e idioms) ─────────────────────────

const approved: GateResult = { decision: "approved", category: null, rationale: "test: approved" };

function voteCandidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
  };
}

/**
 * A gated runner (the auto-cycle e2e idiom): every build turn awaits its own
 * release gate, so tests can hold a build in BUILD_IN_PROGRESS while tips
 * arrive and the scheduler parks around it.
 */
function gatedRunner() {
  const gates: Array<() => void> = [];
  const runner: AgentRunner = {
    run() {
      return (async function* () {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        yield writeBatch("index.html", "<b>hi</b>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return {
    runner,
    releaseNext: async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (gates.length === 0) {
        if (Date.now() > deadline) throw new Error("releaseNext(): no gated build turn arrived");
        await sleep(20);
      }
      gates.shift()?.();
    },
  };
}

async function postJson(app: AppHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${app.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Vote the given candidate id to victory in the currently-open round. */
function voteFor(app: AppHandle, candidateId: string): void {
  const drawn = app.round.snapshot()?.candidates ?? [];
  const option = drawn.find((c) => c.candidate.id === candidateId)?.option;
  if (option === undefined) throw new Error(`${candidateId} was not drawn into the round`);
  app.round.recordVote("voter-1", option);
}

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

// ── quick-260716-h73: the pending free-reign window (banked mid-busy) ─────────

describe("quick-260716-h73 THE RACE: a mid-build tip banks, beats the parked vote, and the owed vote survives", () => {
  const donation = fakeDonationSource();
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const gated = gatedRunner();
  let app: AppHandle;
  const ENV_KEYS = [
    "SUGGEST_PHASE_SECONDS",
    "DONATION_WINDOW_RATE_PER_UNIT",
    "DONATION_WINDOW_MIN_SECONDS",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Real-time friendly knobs: 1s suggest phases (the park happens fast) and a
    // $1→1s donation mapping (the promoted window expires in ~2s). The mapping
    // FORMULA itself is the untouched D-04 linear/floor/cap math.
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.SUGGEST_PHASE_SECONDS = "1";
    process.env.DONATION_WINDOW_RATE_PER_UNIT = "1";
    process.env.DONATION_WINDOW_MIN_SECONDS = "1";
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: approveExceptBanword,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await app.close();
  });

  it("bank mid-build → build finishes → the window opens on the SAME BUILD→IDLE beat, before ANY vote round; expiry resumes the owed vote", async () => {
    donation.ready();

    // Build 1 via a vote round; the gated runner holds it in BUILD_IN_PROGRESS.
    app.pool.add(voteCandidate("w1", "gated build one"), approved);
    app.pool.add(voteCandidate("l1", "filler one"), approved);
    app.round.startRound();
    voteFor(app, "w1");
    app.round.closeRound();
    await until(() => app.orchestrator?.snapshot()?.stage === "building");
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");

    // VOTE_WAITS_FOR_BUILD default ON: the 1s suggest phase expires mid-build
    // and the scheduler parks in waitingForBuild (the fdl park).
    await until(() => app.autoCycle.snapshot().phase === "waiting", 10_000);

    // The OWED vote's candidates wait in the pool.
    app.pool.add(voteCandidate("w2", "owed vote a"), approved);
    app.pool.add(voteCandidate("l2", "owed vote b"), approved);

    // THE TIP mid-build: banked (not denied) — audited + narrated immediately.
    donation.emitTip(tip({ username: "pat", displayName: "Pat", amount: 2, tipId: "tip-race" }));
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS"); // machine untouched
    expect(app.controlWindow.snapshot()).toBeNull(); // active-only: pending grants nothing
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_pending" })).toHaveLength(1);
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_denied" })).toHaveLength(0);
    const bankMsg = await until(() => sent.find((m) => m.startsWith("@Pat tipped")));
    expect(bankMsg).toContain("window granted");
    expect(app.round.snapshot()).toBeNull(); // no round while parked

    // Let MORE than the banked duration (2s) elapse before the build finishes:
    // if promote (wrongly) kept the provisional bank-time deadline, the window
    // would open already-expired. The full-duration rewrite is what survives this.
    await sleep(2_100);
    const roundsBefore = listAuditRecords(app.db, { limit: 50, eventType: "round_opened" }).length;

    // Build reaches terminal → BUILD→IDLE → the window opens on that SAME beat.
    await gated.releaseNext();
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW", 10_000);

    // THE RACE, decided: no vote round opened between IDLE and FREE_REIGN_WINDOW.
    expect(app.round.snapshot()).toBeNull();
    expect(listAuditRecords(app.db, { limit: 50, eventType: "round_opened" })).toHaveLength(
      roundsBefore,
    );
    // The scheduler is still parked THROUGH the window (pending→live handoff).
    expect(app.autoCycle.snapshot().phase).toBe("waiting");

    const live = app.controlWindow.snapshot();
    expect(live?.donorDisplayName).toBe("Pat");
    // FULL paid duration from OPEN (2s clock starts now, not at bank).
    expect((live?.endsAtMs ?? 0) - Date.now()).toBeGreaterThan(1_000);
    const row = app.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as WindowRow;
    expect(row.status).toBe("active");
    const openMsg = await until(() => sent.find((m) => m.includes("window is OPEN")));
    expect(openMsg).toContain("@Pat");

    // The window expires naturally (~2s) → the PARKED vote resumes through the
    // normal #maybeBegin funnel: the owed round opens with the waiting pool.
    await until(() => app.round.snapshot()?.status === "open", 15_000);
    const resumedIds = (app.round.snapshot()?.candidates ?? []).map((c) => c.candidate.id);
    expect(resumedIds).toContain("w2");
    expect(app.autoCycle.snapshot().phase).not.toBe("waiting");
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_expired" })).toHaveLength(1);
  });
});

describe("quick-260716-h73 banked during a VOTING_ROUND + one-slot denial + the IDENTICAL gate funnel", () => {
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

  it("a tip mid-round banks; a SECOND tip is denied window-pending; the round's winner builds; the window opens before any new round", async () => {
    donation.ready();
    app.pool.add(voteCandidate("w1", "round winner build"), approved);
    app.pool.add(voteCandidate("l1", "round filler"), approved);
    app.round.startRound();
    expect(app.machine.mode).toBe("VOTING_ROUND");

    // Tip 1 mid-round → banks.
    donation.emitTip(tip({ username: "erin", displayName: "Erin", tipId: "tip-round" }));
    expect(app.machine.mode).toBe("VOTING_ROUND");
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_pending" })).toHaveLength(1);
    const bankMsg = await until(() => sent.find((m) => m.startsWith("@Erin tipped")));
    expect(bankMsg).toContain("window granted");

    // Tip 2 while one is pending → denied (one slot), never silent.
    donation.emitTip(tip({ username: "frank", displayName: "Frank", tipId: "tip-second" }));
    const deniedMsg = await until(() => sent.find((m) => m.includes("already lined up")));
    expect(deniedMsg).toContain("@Frank");
    const denied = listAuditRecords(app.db, { limit: 10, eventType: "window_denied" });
    expect(denied.some((r) => r.category === "window-pending")).toBe(true);
    // The first pending is unaffected.
    const pendingRows = app.db
      .prepare("SELECT status FROM control_windows WHERE status = 'pending'")
      .all() as WindowRow[];
    expect(pendingRows).toHaveLength(1);

    // The round closes → its winner builds FIRST (VOTING_ROUND→BUILD, no IDLE
    // gap) → finalize returns to IDLE → the window opens BEFORE any new round.
    voteFor(app, "w1");
    app.round.closeRound();
    await until(() => built.includes("round winner build"));
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    expect(app.controlWindow.snapshot()?.donorDisplayName).toBe("Erin");
    expect(app.round.snapshot()).toBeNull();
    await until(() => sent.find((m) => m.includes("window is OPEN") && m.includes("@Erin")));
  });

  it("an in-window instruction after the PROMOTED open still routes through the IDENTICAL gate funnel", async () => {
    // Rejected: the gate screens every byte — narrated, never built (D-12).
    const builtBefore = built.length;
    chat.say("501", "Gina", "!build banword everything");
    const rejectMsg = await until(() => sent.find((m) => m.startsWith("Can't build that one")));
    expect(rejectMsg).toContain("@Gina");
    await sleep(50);
    expect(built.length).toBe(builtBefore);
    expect(app.controlWindow.snapshot()).not.toBeNull(); // window unharmed

    // Approved: builds in the sandbox with the promoted window's provenance.
    chat.say("502", "Hank", "!build a pending window build");
    await until(() => built.includes("a pending window build"));
    const entry = listBuildHistory(app.db, { limit: 20 }).find(
      (r) => r.title === "a pending window build",
    );
    expect(entry?.provenance).toBe("donation"); // threaded from the PROMOTED window
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");

    // Cleanup: revoke the window (the console primitive works on promoted windows).
    app.controlWindow.revoke();
    expect(app.machine.mode).toBe("IDLE");
  });
});

describe("quick-260716-h73 HALT while PENDING: recover-to-IDLE discards — a window never auto-opens out of a halt", () => {
  const donation = fakeDonationSource();
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const gated = gatedRunner();
  let app: AppHandle;

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: approveExceptBanword,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("tip banks mid-build → HALT → recover to IDLE: pending discarded (audit + cancelled beat), machine IDLE, cadence resumes", async () => {
    donation.ready();
    app.pool.add(voteCandidate("w1", "halted build"), approved);
    app.pool.add(voteCandidate("l1", "halt filler"), approved);
    app.round.startRound();
    voteFor(app, "w1");
    app.round.closeRound();
    await until(() => app.orchestrator?.snapshot()?.stage === "building");

    donation.emitTip(tip({ username: "iva", displayName: "Iva", tipId: "tip-halt" }));
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_pending" })).toHaveLength(1);

    // HALT mid-build (kill switch outranks money), release the aborted turn.
    const haltRes = await postJson(app, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    await gated.releaseNext();
    await until(() => app.orchestrator?.snapshot() === null);

    // Recover to IDLE: the pending is DISCARDED — never opened.
    const recoverRes = await postJson(app, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).toBe("IDLE");
    expect(app.controlWindow.snapshot()).toBeNull();
    const row = app.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as WindowRow;
    expect(row.status).toBe("revoked");
    expect(
      listAuditRecords(app.db, { limit: 10, eventType: "window_revoked" }).length,
    ).toBeGreaterThanOrEqual(1);
    const cancelMsg = await until(() =>
      sent.find((m) => m.includes("pending window was cancelled")),
    );
    expect(cancelMsg).toContain("@Iva");

    // The window NEVER opens out of the halt; the auto-cycle cadence resumes.
    await sleep(120);
    expect(app.machine.mode).toBe("IDLE");
    expect(listAuditRecords(app.db, { limit: 10, eventType: "window_opened" })).toHaveLength(0);
    await until(() => app.autoCycle.snapshot().phase === "suggest");
  });
});

describe("quick-260716-h73 crash restore: a banked pending row survives a restart", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "h73-restore-"));
    const dbPath = path.join(tempDir, "audit.db");
    // Simulate the crash: a previous session banked a window and died mid-build.
    const seed = openDb(dbPath);
    insertWindow(seed, {
      trigger: "donation",
      donorIdentifier: "riley",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: Date.now() - 300_000, // banked 5 minutes ago — provisional deadline long dead
      endsAtMs: Date.now() - 240_000,
      status: "pending",
    });
    seed.close();

    app = await createApp({
      dbPath,
      port: 0,
      fakeClassifier: approveExceptBanword,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: happyRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("boot into IDLE promotes the banked row with the FULL duration from restore-time — no boot double-narration", async () => {
    // restore() opened it during createApp — machine reflects the live window.
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");
    const snap = app.controlWindow.snapshot();
    expect(snap?.donorDisplayName).toBe("riley");
    // FULL 60s from restore-time — the dead provisional deadline is irrelevant.
    expect((snap?.endsAtMs ?? 0) - Date.now()).toBeGreaterThan(55_000);
    const row = app.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as WindowRow;
    expect(row.status).toBe("active");
    // Never lost, never double: no pending rows remain.
    expect(
      app.db.prepare("SELECT COUNT(*) AS n FROM control_windows WHERE status = 'pending'").get(),
    ).toEqual({ n: 0 });

    // A boot-restore promotion emits WINDOW_OPENED BEFORE the composition root
    // subscribes its fromPending handler — so no promoted-open chat beat fires
    // at boot (the restoredWindow block owns the 30s re-arm; exactly one 30s
    // timer path is live — the amendment's no-double-narrate/no-double-arm rail).
    await sleep(120);
    expect(sent.some((m) => m.includes("window is OPEN"))).toBe(false);
  });
});
