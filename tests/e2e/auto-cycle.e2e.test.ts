import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import { BUILD_STAGE_CHANGED } from "../../src/orchestrator/build-session.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import type { OverlayState } from "../../src/overlay/server.js";
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Auto-cycle + drainVoteQueue e2e (quick-t5k Task 3), against injected fakes —
 * NO network, NO real WSL2/query(). Covers:
 *  (a) A1 mid-build cadence: a round closing while a build runs queues its
 *      winner WITHOUT touching the running build; the overlay nextUp shows it;
 *      the scheduler's suggest window stays armed.
 *  (b) the drain trio: (i) build completion drains the queue head via
 *      IDLE→BUILD_IN_PROGRESS; (ii) BLOCKER-1 regression — a concurrent round
 *      closing AFTER its background build finished (mode already IDLE) drains
 *      immediately, nothing strands; (iii) WARNING-3 — recovery out of HALTED
 *      never auto-starts a queued build; the next round close drains the HEAD
 *      first (FIFO preserved).
 *  (c) POST /api/auto-cycle/toggle: 200 + state flip + chaos-mirrored CSRF.
 *  (d) manual /api/round/start works while auto-cycle is paused.
 *  (+) VOTE_QUEUE_MAX amendment: manual start still works at cap; a queued
 *      winner is never dropped by the cap.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (chaos-mode e2e pattern) ─────────────────────────
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/**
 * A gated runner (quick-0iu: there is ONE sandboxed build turn per pipeline —
 * no research/plan turns exist): every build turn awaits its own release gate,
 * so tests can hold a build in BUILD_IN_PROGRESS while rounds open/close
 * around it.
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
    /** Wait for the next sandboxed build turn to arm its gate, then release it. */
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

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

function fakeChatSource(): ChatEventSource {
  return {
    onChannelChatMessage() {
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

/** Track every build START (stage building — quick-0iu) and completion (done), in order. */
function trackBuilds(app: AppHandle): { started: string[]; done: string[] } {
  const started: string[] = [];
  const done: string[] = [];
  const orch = app.orchestrator;
  if (!orch) throw new Error("orchestrator was not composed");
  orch.on(BUILD_STAGE_CHANGED, () => {
    const snap = orch.snapshot();
    if (!snap) return;
    if (snap.stage === "building" && started[started.length - 1] !== snap.title) {
      started.push(snap.title);
    }
    if (snap.stage === "done") done.push(snap.title);
  });
  return { started, done };
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

function baseUrl(app: AppHandle): string {
  return `http://127.0.0.1:${app.port}`;
}
async function postJson(app: AppHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl(app)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeApp(runner: AgentRunner) {
  const { sink } = capturingSink();
  return createApp({
    dbPath: ":memory:",
    port: 0,
    fakeClassifier: () => approved,
    chatSource: fakeChatSource(),
    chatSink: sink,
    agentRunner: runner,
    sandboxAdapter: fakeSandbox(),
    devServerProbe: fakeProbe,
  });
}

describe("(a) A1 mid-build cadence + (b.i) completion drain", () => {
  const gated = gatedRunner();
  let app: AppHandle;
  let builds: { started: string[]; done: string[] };

  beforeAll(async () => {
    app = await makeApp(gated.runner);
    builds = trackBuilds(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("a voting round completing mid-build enqueues the winner WITHOUT touching the running build; the cadence never waits", async () => {
    app.pool.add(candidate("w1", "first winner"), approved);
    app.pool.add(candidate("l1", "loser one"), approved);

    // Round 1 (owned): winner starts building through drainVoteQueue.
    app.round.startRound();
    app.round.recordVote("u1", 1);
    app.round.closeRound();
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");
    await until(() => app.orchestrator?.snapshot()?.stage === "building");
    expect(app.orchestrator?.snapshot()?.title).toBe("first winner");

    // Concurrent round (A1): opens under BUILD_IN_PROGRESS, closes mid-build.
    app.pool.add(candidate("w2", "second winner"), approved);
    app.pool.add(candidate("f2", "filler two"), approved); // losers drop now — round needs 2
    app.round.startRound();
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS"); // no mode transition
    const drawn = app.round.snapshot()?.candidates ?? [];
    const w2Option = drawn.find((c) => c.candidate.id === "w2")?.option;
    if (w2Option === undefined) throw new Error("w2 was not drawn into the round");
    expect(app.round.recordVote("u1", w2Option)).toBe(true); // votes count mid-build
    app.round.closeRound();

    // Winner queued FIFO behind the (still running, untouched) build.
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(app.orchestrator?.snapshot()?.title).toBe("first winner");
    expect(app.taskQueue.list().map((t) => t.text)).toEqual(["first winner", "second winner"]);

    // Viewer-visible pending queue (A1): the overlay nextUp strip, in order.
    const overlayState = (await (
      await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`)
    ).json()) as OverlayState;
    expect(overlayState.nextUp).toEqual(["first winner", "second winner"]);

    // The scheduler's suggest window is armed (cadence continues hands-free).
    expect(app.autoCycle.snapshot().enabled).toBe(true);
    expect(app.autoCycle.snapshot().phase).toBe("suggest");
  });

  it("(b.i) build completion (mode → IDLE) drains the head-of-queue winner via IDLE→BUILD_IN_PROGRESS", async () => {
    await gated.releaseNext(); // finish "first winner"
    await until(() => builds.done.includes("first winner"));
    // The completion drain starts the queued winner without any manual action.
    await until(() => app.orchestrator?.snapshot()?.title === "second winner");
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");

    await gated.releaseNext(); // finish "second winner"
    await until(() => builds.done.includes("second winner"));
    await until(() => app.machine.mode === "IDLE");
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(builds.started).toEqual(["first winner", "second winner"]);
  });
});

describe("(b.ii) BLOCKER-1 regression: build finishes MID-VOTE — the concurrent round closes at IDLE and drains immediately", () => {
  const gated = gatedRunner();
  let app: AppHandle;
  let builds: { started: string[]; done: string[] };

  beforeAll(async () => {
    app = await makeApp(gated.runner);
    builds = trackBuilds(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("the winner still drains the moment the round closes — nothing strands", async () => {
    app.pool.add(candidate("w1", "first winner"), approved);
    app.pool.add(candidate("l1", "loser one"), approved);
    app.round.startRound();
    app.round.recordVote("u1", 1);
    app.round.closeRound();
    await until(() => app.orchestrator?.snapshot()?.stage === "building");

    // Concurrent round opens mid-build...
    app.pool.add(candidate("w2", "second winner"), approved);
    app.pool.add(candidate("f2", "filler two"), approved); // losers drop now — round needs 2
    app.round.startRound();
    const drawn = app.round.snapshot()?.candidates ?? [];
    const w2Option = drawn.find((c) => c.candidate.id === "w2")?.option;
    if (w2Option === undefined) throw new Error("w2 was not drawn into the round");
    app.round.recordVote("u1", w2Option);

    // ...and the build finishes MID-VOTE: the routine 20s-vote/long-build case.
    await gated.releaseNext();
    await until(() => builds.done.includes("first winner"));
    await until(() => app.machine.mode === "IDLE");
    expect(app.round.snapshot()?.status).toBe("open"); // round still live at IDLE

    // Close at IDLE: the winner must drain IMMEDIATELY (was: stranded forever).
    app.round.closeRound();
    await until(() => app.orchestrator?.snapshot()?.title === "second winner");
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");

    await gated.releaseNext();
    await until(() => builds.done.includes("second winner"));
    await until(() => app.machine.mode === "IDLE");
    expect(app.taskQueue.list()).toHaveLength(0);
  });
});

describe("(b.iii) WARNING-3: recovery out of HALTED never auto-builds; the next round close drains the HEAD (FIFO)", () => {
  const gated = gatedRunner();
  let app: AppHandle;
  let builds: { started: string[]; done: string[] };

  beforeAll(async () => {
    app = await makeApp(gated.runner);
    builds = trackBuilds(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("halt with a queued winner → recover to IDLE → NO build starts; the next close builds the stranded head before the fresh winner", async () => {
    // Round 1: "first winner" builds (gated, held in BUILD_IN_PROGRESS).
    app.pool.add(candidate("w1", "first winner"), approved);
    app.pool.add(candidate("l1", "loser one"), approved);
    app.round.startRound();
    app.round.recordVote("u1", 1);
    app.round.closeRound();
    await until(() => app.orchestrator?.snapshot()?.stage === "building");

    // Concurrent round 2: "second winner" queues behind the running build.
    app.pool.add(candidate("w2", "second winner"), approved);
    app.pool.add(candidate("f2", "filler two"), approved); // losers drop now — round needs 2
    app.round.startRound();
    const drawn2 = app.round.snapshot()?.candidates ?? [];
    const w2Option = drawn2.find((c) => c.candidate.id === "w2")?.option;
    if (w2Option === undefined) throw new Error("w2 was not drawn into the round");
    app.round.recordVote("u1", w2Option);
    app.round.closeRound();
    expect(app.taskQueue.list().map((t) => t.text)).toEqual(["first winner", "second winner"]);

    // HALT mid-build, then release the gate so the aborted turn unwinds.
    const haltRes = await postJson(app, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    await gated.releaseNext();
    await until(() => app.orchestrator?.snapshot() === null && app.taskQueue.list().length === 1);
    expect(app.taskQueue.list().map((t) => t.text)).toEqual(["second winner"]);

    // Recover to IDLE: the drain is SKIPPED (from HALTED) — no build starts.
    const recoverRes = await postJson(app, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).toBe("IDLE");
    await sleep(120); // give any (incorrect) deferred drain room to fire
    expect(app.machine.mode).toBe("IDLE");
    expect(app.orchestrator?.snapshot()).toBeNull();
    expect(app.taskQueue.list().map((t) => t.text)).toEqual(["second winner"]);
    expect(builds.started).toEqual(["first winner"]); // nothing new started

    // Next round close drains the HEAD (the stranded winner), FIFO — the
    // fresh winner waits its turn behind it.
    app.pool.add(candidate("w3", "third winner"), approved);
    app.pool.add(candidate("f3", "filler three"), approved); // losers drop now — round needs 2
    app.round.startRound();
    const drawn3 = app.round.snapshot()?.candidates ?? [];
    const w3Option = drawn3.find((c) => c.candidate.id === "w3")?.option;
    if (w3Option === undefined) throw new Error("w3 was not drawn into the round");
    app.round.recordVote("u1", w3Option);
    app.round.closeRound();

    await until(() => app.orchestrator?.snapshot()?.title === "second winner");
    expect(app.taskQueue.list().map((t) => t.text)).toEqual(["second winner", "third winner"]);

    await gated.releaseNext(); // finish "second winner"
    await until(() => builds.done.includes("second winner"));
    await until(() => app.orchestrator?.snapshot()?.title === "third winner");
    await gated.releaseNext(); // finish "third winner"
    await until(() => builds.done.includes("third winner"));
    await until(() => app.machine.mode === "IDLE");
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(builds.started).toEqual(["first winner", "second winner", "third winner"]);
  });
});

describe("(c)+(d) console toggle route + manual start while paused", () => {
  let app: AppHandle;

  beforeAll(async () => {
    // No build engine — the route/pause behavior needs no orchestrator.
    const { sink } = capturingSink();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: fakeChatSource(),
      chatSink: sink,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("(c) POST /api/auto-cycle/toggle flips the state (200) and writes an auto_cycle_toggled audit row", async () => {
    expect(app.autoCycle.snapshot().enabled).toBe(true); // default-on boot

    const off = await postJson(app, "/api/auto-cycle/toggle", {});
    expect(off.status).toBe(200);
    expect((await off.json()) as { autoCycle: boolean }).toEqual({ autoCycle: false });

    const state = (await (await fetch(`${baseUrl(app)}/api/state`)).json()) as {
      autoCycle: { enabled: boolean; phase: string | null };
    };
    expect(state.autoCycle).toEqual({ enabled: false, phase: null });

    const rows = listAuditRecords(app.db, { limit: 10, eventType: "auto_cycle_toggled" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.decision).toBe("disabled");
  });

  it("(c) CSRF posture mirrors the chaos toggle: a foreign Origin is refused with 403", async () => {
    const res = await fetch(`${baseUrl(app)}/api/auto-cycle/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("(d) manual POST /api/round/start still works while auto-cycle is paused", async () => {
    expect(app.autoCycle.snapshot().enabled).toBe(false); // paused by (c)
    app.pool.add(candidate("m1", "manual one"), approved);
    app.pool.add(candidate("m2", "manual two"), approved);

    const res = await postJson(app, "/api/round/start", {});
    expect(res.status).toBe(200);
    expect(app.machine.mode).toBe("VOTING_ROUND");
    app.round.closeRound(); // zero votes → first-wins; winner queues (no engine)
    expect(app.taskQueue.list()).toHaveLength(1);
  });
});

describe("VOTE_QUEUE_MAX amendment: the cap never blocks manual starts and never drops a winner", () => {
  const savedCap = process.env.VOTE_QUEUE_MAX;
  let app: AppHandle;

  beforeAll(async () => {
    process.env.VOTE_QUEUE_MAX = "1";
    const { sink } = capturingSink();
    // No build engine: queued winners sit in the queue, so the cap is reachable.
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: fakeChatSource(),
      chatSink: sink,
    });
  });
  afterAll(async () => {
    if (savedCap === undefined) delete process.env.VOTE_QUEUE_MAX;
    else process.env.VOTE_QUEUE_MAX = savedCap;
    await app.close();
  });

  it("manual round start works AT the cap, and its winner enqueues past the cap (never dropped)", async () => {
    // Fill the queue to the cap (1) with a first manual round.
    app.pool.add(candidate("q1", "capped winner"), approved);
    app.pool.add(candidate("q2", "second idea"), approved);
    const first = await postJson(app, "/api/round/start", {});
    expect(first.status).toBe(200);
    app.round.recordVote("u1", 1);
    app.round.closeRound();
    expect(app.taskQueue.list()).toHaveLength(1); // at cap

    // Manual start is EXEMPT from the cap (operator override).
    app.pool.add(candidate("q3", "third idea"), approved);
    app.pool.add(candidate("q4", "fourth idea"), approved); // losers drop now — round needs 2
    const second = await postJson(app, "/api/round/start", {});
    expect(second.status).toBe(200);

    // Its winner enqueues even past the cap — a voted winner is never dropped.
    app.round.recordVote("u1", 1);
    app.round.closeRound();
    expect(app.taskQueue.list()).toHaveLength(2);
  });
});
