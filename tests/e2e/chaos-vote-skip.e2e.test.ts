import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import { CHAOS_CANDIDATE_TEXT } from "../../src/ingestion/command-parser.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  GalleryPublisher,
  PublishInput,
  RevertInput,
} from "../../src/orchestrator/gallery-publisher.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import type { GateResult, RoundSnapshot, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Chat-voted CHAOS ballot option e2e (quick-260711-ly4): `!chaos` submits a
 * single server-composed CHAOS candidate that competes in the NORMAL vote round
 * like !revert/!swapbuild. When CHAOS WINS a democratic vote, the existing
 * 5-minute chaos window activates — no build, no BUILD_IN_PROGRESS — and the
 * in-window random-pick behavior (chaosModePick) runs exactly as before. The old
 * 3-unique-chatter tally threshold is GONE: winning is the ONLY chat path to
 * chaos. Proven against createApp's injected fakes (fake chat/sink,
 * fakeClassifier, fake runner/sandbox, fake publisher, injected chaosRng) — no
 * network, no real git/WSL2.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── fixtures (tier1-commands idioms) ─────────────────────────────────────────

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

function recordingRunner() {
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      return (async function* () {
        yield writeBatch("index.html", "<b>hi</b>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return { runner, specs };
}

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

const approved: GateResult = { decision: "approved", category: null, rationale: "test: approved" };

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

function fakeDonationSource() {
  const tipHandlers: Array<(tip: TipEvent) => void> = [];
  const source: DonationEventSource = {
    onTip(handler) {
      tipHandlers.push(handler);
    },
    onReady() {},
    onDisconnect() {},
  };
  return {
    source,
    emitTip(tip: TipEvent): void {
      for (const handler of tipHandlers) handler(tip);
    },
  };
}

const tip = (over: Partial<TipEvent> = {}): TipEvent => ({
  username: "alice",
  displayName: "Alice",
  amount: 5,
  currency: "USD",
  message: "take the wheel",
  tipId: "tip-1",
  ...over,
});

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

function candidate(
  id: string,
  text: string,
  over: Partial<SuggestionCandidate> = {},
): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
    ...over,
  };
}

function chaosPickRows(app: AppHandle) {
  return listAuditRecords(app.db, { limit: 50, eventType: "chaos_pick" });
}

function chaosActivatedRows(app: AppHandle) {
  return listAuditRecords(app.db, { limit: 50, eventType: "chaos_activated" });
}

function poolChaos(app: AppHandle) {
  return app.pool.list().filter((c) => c.candidate.kind === "chaos");
}

function workspaceRow(app: AppHandle): { generation: number; scaffolded: number } {
  return app.db
    .prepare("SELECT generation, scaffolded FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number };
}

/** Wait for a round to open, vote for the option whose candidate matches, then close it. */
async function voteAndClose(
  app: AppHandle,
  predicate: (c: RoundSnapshot["candidates"][number]["candidate"]) => boolean,
  voterId = "v1",
): Promise<void> {
  await until(() => app.round.snapshot()?.status === "open");
  const snap = app.round.snapshot();
  const opt = snap?.candidates.find((entry) => predicate(entry.candidate));
  if (!opt) throw new Error("target option not drawn into the round");
  app.round.recordVote(voterId, opt.option);
  app.round.closeRound();
}

function setEnv(vars: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function postJson(app: AppHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── 1. `!chaos` pools a single server-composed CHAOS candidate (silent, deduped) ─

describe("chaos e2e: !chaos pools ONE server-composed CHAOS candidate — silent, deduped, no chat text", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "30", // long — no phase end during the test
      EARLY_CLOSE_POOL_SIZE: "5", // high — no round auto-opens at pool size 1-2
    });
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
    });
    chat.say("u1", "ann", "!chaos");
    await until(() => poolChaos(app).length === 1);
    chat.say("u2", "bob", "!chaos"); // a 2nd !chaos — must dedupe to one
    await sleep(200);
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("pools exactly ONE CHAOS candidate: kind 'chaos', the fixed server-composed text, no chat-derived bytes", () => {
    const chaos = poolChaos(app);
    expect(chaos).toHaveLength(1);
    expect(chaos[0]?.candidate.kind).toBe("chaos");
    expect(chaos[0]?.candidate.text).toBe(CHAOS_CANDIDATE_TEXT);
    expect(chaos[0]?.candidate.source).toBe("chat");
  });

  it("posts NO submission ack for the pooled CHAOS candidate (silent, like every pooled ack)", () => {
    expect(sent.some((m) => m.includes("CHAOS") && m.includes("competes"))).toBe(false);
    expect(sent.some((m) => m.toLowerCase().includes("chaos") && m.includes("is in"))).toBe(false);
  });

  it("a second !chaos while one is pooled is a silent no-op (identical-text dedupe caps CHAOS at one)", () => {
    expect(poolChaos(app)).toHaveLength(1);
    // No chaos activation ever happened — no vote round was won.
    expect(chaosActivatedRows(app)).toHaveLength(0);
  });
});

// ── 2. CHAOS wins a vote → activates the window; NEVER builds; in-window pick + expiry ─

describe("chaos e2e: CHAOS wins a democratic vote → the 5-min window activates (no build), then in-window random picks, then expiry", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "30", // phase ends only via pool-full early close
      EARLY_CLOSE_POOL_SIZE: "2",
      CHAOS_MODE_DURATION_SECONDS: "3",
    });
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    // Pool [CHAOS, suggestion] → early close opens a round with BOTH options.
    chat.say("u1", "ann", "!chaos");
    chat.say("s1", "eve", "!suggest build a snake game");
    // CHAOS wins the vote.
    await voteAndClose(app, (c) => c.kind === "chaos");
    await until(() => chaosActivatedRows(app).length === 1);
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("activation is a DEMOCRATIC win: one chaos_activated row (decision 'activated', truthful rationale) + the chaos-wins beat", () => {
    const rows = chaosActivatedRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("activated");
    expect(rows[0]?.rationale).toBe("Chaos mode activated by winning a democratic vote round");
    expect(rows[0]?.source).toBe("chaos");
    expect(sent.some((m) => m.startsWith("Chat voted CHAOS — 0:03 of mayhem!"))).toBe(true);
  });

  it("the CHAOS winner NEVER builds and NEVER holds BUILD_IN_PROGRESS — the machine stays on the democratic cadence", async () => {
    // No agent run was started by the chaos win itself.
    expect(runner.specs).toHaveLength(0);
    // The machine returned to the democratic cadence (never parked in a build).
    await until(() => app.machine.mode === "IDLE" || app.machine.mode === "BUILD_IN_PROGRESS");
    expect(app.machine.mode).not.toBe("CHAOS_MODE");
  });

  it("during the active window a fresh phase end RANDOM-PICKS one pooled idea and builds it (chaosModePick preserved)", async () => {
    // Two chat candidates → early close ends the phase → chaosModePick owns it.
    chat.say("a1", "amy", "!suggest a drawing board");
    chat.say("a2", "ben", "!suggest a calculator");
    await until(() => chaosPickRows(app).length === 1, 5_000);
    const pick = chaosPickRows(app)[0];
    expect(pick?.decision).toBe("suggestion"); // kind recorded in decision
    expect(["a drawing board", "a calculator"]).toContain(pick?.suggestion_text);
    // The in-window pick DID build (rode the winner rail) — exactly one agent run.
    await until(() => runner.specs.length === 1);
    expect(sent.some((m) => m.startsWith(`Chaos picked: "${pick?.suggestion_text}"`))).toBe(true);
  });

  it("expiry auto-reverts to democracy: a chaos_expired row + beat, then a NORMAL vote round opens again", async () => {
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_expired" }).length === 1,
      8_000,
    );
    expect(sent.some((m) => m === "Chaos mode is over — voting is back.")).toBe(true);
    // Democracy is back: a NORMAL vote round opens again. "Voting is OPEN" is
    // NEVER sent during an active chaos window (chaosModePick owns phase ends),
    // so its appearance is a clean post-expiry democracy signal.
    const picksBefore = chaosPickRows(app).length;
    chat.say("d1", "gil", "!suggest a stopwatch");
    chat.say("d2", "hal", "!suggest a todo list");
    await until(() => sent.some((m) => m.startsWith("Voting is OPEN")), 6_000);
    expect(chaosPickRows(app)).toHaveLength(picksBefore); // no further picks after expiry
    const openRound = app.round.snapshot();
    if (openRound?.status === "open") app.round.closeRound();
  }, 15_000);
});

// ── 3. a SUGGESTION winning the same ballot leaves chaos un-activated ─────────

describe("chaos e2e: when a suggestion beats CHAOS on the ballot, the chaos window NEVER activates", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "30",
      EARLY_CLOSE_POOL_SIZE: "2",
      CHAOS_MODE_DURATION_SECONDS: "60",
    });
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    chat.say("u1", "ann", "!chaos");
    chat.say("s1", "eve", "!suggest build a snake game");
    await voteAndClose(app, (c) => c.kind === "suggestion");
    await until(() => runner.specs.length === 1); // the suggestion built
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("the suggestion built as a normal vote winner — and chaos was NEVER activated", () => {
    expect(runner.specs).toHaveLength(1);
    expect(chaosActivatedRows(app)).toHaveLength(0);
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(sent.some((m) => m.startsWith("Chat voted CHAOS"))).toBe(false);
  });
});

// ── 4. a LONE CHAOS candidate NEVER auto-activates unopposed (soloPick excludes it) ─

describe("chaos e2e: a lone CHAOS candidate restarts the window forever — it never auto-builds or auto-activates (soloPick excludes chaos)", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "0.3", // short — repeated phase ends with a lone candidate
      EARLY_CLOSE_POOL_SIZE: "5", // high — only the phase timer ends the window
      CHAOS_MODE_DURATION_SECONDS: "60",
    });
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    chat.say("u1", "ann", "!chaos");
    await until(() => poolChaos(app).length === 1);
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("across several phase ends the lone CHAOS candidate never activates, never builds, never opens a round", async () => {
    await sleep(1_500); // ~5 phase-ends at SUGGEST_PHASE_SECONDS=0.3
    expect(chaosActivatedRows(app)).toHaveLength(0);
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(runner.specs).toHaveLength(0);
    expect(sent.some((m) => m.startsWith("Voting is OPEN"))).toBe(false);
    // The candidate is still pooled, waiting for a real idea to compete against.
    expect(poolChaos(app)).toHaveLength(1);
  }, 10_000);

  it("once a real idea joins, they compete in a NORMAL vote round (CHAOS only activates by winning)", async () => {
    chat.say("s1", "eve", "!suggest a paint app");
    // With 2 pooled candidates a normal round opens (soloPick no longer applies).
    await until(() => app.round.snapshot()?.status === "open", 5_000);
    const snap = app.round.snapshot();
    expect(snap?.candidates.some((c) => c.candidate.kind === "chaos")).toBe(true);
    expect(snap?.candidates.some((c) => c.candidate.kind === "suggestion")).toBe(true);
    expect(chaosActivatedRows(app)).toHaveLength(0); // still not activated — the vote decides
    app.round.closeRound();
  }, 10_000);
});

// ── 5. paid-source exclusion + FREE REIGN > CHAOS + HALT clears the window ────

describe("chaos e2e: paid candidates are never chaos-pickable; FREE REIGN outranks CHAOS; HALT clears the window", () => {
  const chat = fakeChatSource();
  const donation = fakeDonationSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "2", // short enough for repeated in-window phase ends
      EARLY_CLOSE_POOL_SIZE: "2", // the ballot opens deterministically at pool size 2
      CHAOS_MODE_DURATION_SECONDS: "60",
    });
    // A build engine is present (production always composes one — it is what
    // wires the drainVoteQueue chaos arm that activate()s a CHAOS winner). rng
    // FORCED to index 0 so only the source allowlist can explain a paid
    // candidate never being picked.
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chaosRng: () => 0,
    });
    // Activate chaos by WINNING a ballot: pool [CHAOS, filler] → vote CHAOS.
    chat.say("u1", "ann", "!chaos");
    chat.say("f1", "bob", "!suggest a filler idea");
    await voteAndClose(app, (c) => c.kind === "chaos");
    await until(() => chaosActivatedRows(app).length === 1);
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("a pool holding ONLY a paid-source candidate behaves as empty: the donation candidate is NEVER chaos-picked", async () => {
    app.pool.add(candidate("paid-1", "a tipped idea", { source: "donation" }), approved);
    await sleep(4_500); // ~2 in-window (2s) phase ends against the paid-only pool
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(app.pool.list().map((c) => c.candidate.id)).toContain("paid-1");
  }, 10_000);

  it("with rng FORCED at index 0, the pick lands on the allowlisted chat candidate — never the paid one", async () => {
    app.pool.add(candidate("chat-1", "a chat idea"), approved);
    await until(() => chaosPickRows(app).length === 1, 6_000);
    expect(chaosPickRows(app)[0]?.task_id).toBe("chat-1");
    expect(app.pool.list().map((c) => c.candidate.id)).toContain("paid-1"); // untouched
  }, 10_000);

  it("FREE REIGN outranks CHAOS: no pick fires while a control window is live; chaos resumes after revoke", async () => {
    const picksBefore = chaosPickRows(app).length;
    donation.emitTip(tip()); // $5 → a control window; machine → FREE_REIGN_WINDOW
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    app.pool.add(candidate("frozen-1", "an eligible idea"), approved);
    await sleep(1_200); // phase deadlines pass while the window is live — parked
    expect(chaosPickRows(app)).toHaveLength(picksBefore);

    app.controlWindow.revoke();
    await until(() => app.machine.mode === "IDLE");
    await until(() => chaosPickRows(app).length === picksBefore + 1, 6_000);
  }, 12_000);

  it("HALT clears the chaos window: no pick fires while HALTED; recovery restores DEMOCRATIC mode", async () => {
    const haltRes = await postJson(app, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    const picksAtHalt = chaosPickRows(app).length;

    app.pool.add(candidate("halted-1", "an idea during halt"), approved);
    await sleep(700);
    expect(chaosPickRows(app)).toHaveLength(picksAtHalt); // no pick while HALTED

    const recoverRes = await postJson(app, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).not.toBe("HALTED"); // recovered off the kill switch

    // The pre-halt window was cleared: the democratic cadence resumes and a
    // NORMAL vote round opens (a "Voting is OPEN" beat is NEVER sent while a
    // chaos window is live, since chaosModePick owns every phase end) — so its
    // appearance proves chaos never resurrected after the halt.
    app.pool.add(candidate("demo-1", "democratic idea"), approved);
    app.pool.add(candidate("demo-2", "another idea"), approved);
    await until(() => sent.some((m) => m.startsWith("Voting is OPEN")), 6_000);
    expect(chaosPickRows(app)).toHaveLength(picksAtHalt); // still no new picks
    const openRound = app.round.snapshot();
    if (openRound?.status === "open") app.round.closeRound();
  }, 15_000);
});

// ── 6. in-window picks ride the UNCHANGED q5n kind router ─────────────────────

describe("chaos e2e: in-window picks ride the q5n kind router — ship-gate holds for project-switch; revert reverts", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;
  let rngIndex = 0;
  const publishCalls: PublishInput[] = [];
  const revertCalls: RevertInput[] = [];
  const publisher: GalleryPublisher = {
    publishNow(input) {
      publishCalls.push(input);
      return Promise.resolve({ status: "failed", commitHash: null, detail: "remote rejected" });
    },
    revertLast(input) {
      revertCalls.push(input);
      return Promise.resolve({ status: "reverted", commitHash: "revhash", detail: "ok" });
    },
  };

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "30",
      EARLY_CLOSE_POOL_SIZE: "2",
      CHAOS_MODE_DURATION_SECONDS: "60",
    });
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
      chaosRng: (max) => Math.min(rngIndex, max - 1),
    });

    // DEMOCRATIC prologue: scaffold generation 1 via a normal voted build so the
    // workspace holds an ACTIVE project (the ship gate has something to ship).
    chat.say("s1", "ann", "!suggest make a counter app");
    chat.say("s2", "bob", "!suggest a filler idea");
    await voteAndClose(app, (c) => c.text === "make a counter app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    await until(() => workspaceRow(app).scaffolded === 1);

    // Activate chaos by WINNING a ballot: pool [CHAOS, filler] → vote CHAOS.
    chat.say("c1", "cal", "!chaos");
    chat.say("g1", "guy", "!suggest gate filler");
    await voteAndClose(app, (c) => c.kind === "chaos");
    await until(() => chaosActivatedRows(app).length === 1);
  }, 20_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("a chaos-picked PROJECT-SWITCH with a failing publisher NEVER rotates (confirmed-push gate holds identically)", async () => {
    const generationBefore = workspaceRow(app).generation;
    rngIndex = 0; // eligible order: [project-switch, filler] → pick the switch
    chat.say("b1", "dee", "!build make a snake game");
    chat.say("f2", "eve", "!suggest filler two");

    await until(() => chaosPickRows(app).length === 1, 5_000);
    expect(chaosPickRows(app)[0]?.decision).toBe("project-switch");
    await until(() => sent.some((m) => m.startsWith("Couldn't ship the current project")), 5_000);
    await until(() => app.machine.mode === "IDLE");
    expect(workspaceRow(app).generation).toBe(generationBefore); // NO rotation
    expect(runner.specs).toHaveLength(1); // no new build (still the prologue's)
    expect(publishCalls.some((c) => c.title === "app-1 final snapshot")).toBe(true);
  }, 10_000);

  it("a chaos-picked REVERT runs the revert path (revert_outcome row, build_history 'reverted') — never an agent build", async () => {
    rngIndex = 1; // eligible order: [filler two, revert] → pick the revert
    chat.say("r1", "fay", "!revert");
    await until(() => chaosPickRows(app).length === 2, 5_000);
    expect(chaosPickRows(app)[0]?.decision).toBe("revert"); // newest-first

    await until(() => revertCalls.length === 1, 5_000);
    await until(() => app.machine.mode === "IDLE");
    const outcomes = listAuditRecords(app.db, { limit: 10, eventType: "revert_outcome" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.decision).toBe("reverted");
    const history = listBuildHistory(app.db, { limit: 10 });
    expect(history.some((h) => h.result === "reverted" && h.provenance === "vote")).toBe(true);
    expect(runner.specs).toHaveLength(1); // a revert never reaches the agent runner
  }, 10_000);
});
