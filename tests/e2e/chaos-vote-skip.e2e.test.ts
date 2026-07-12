import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
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
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Chat-activated chaos mode e2e (quick-rs3): CHAOS_ACTIVATION_VOTES unique
 * !chaos chatters flip a timed vote-skip window — at suggest-window close no
 * vote round opens; one random ALREADY-GATED pool candidate is enqueued through
 * the SAME q5n kind router a voted winner uses. Proven against createApp's
 * injected fakes (fake chat/sink, fakeClassifier, fake runner/sandbox, fake
 * publisher, injected chaosRng) — no network, no real git/WSL2.
 *
 * Phase ends are triggered DETERMINISTICALLY via the quick-l2a pool-full early
 * close (EARLY_CLOSE_POOL_SIZE=2 + a long suggest phase) where possible, and
 * via short real-timer phases where an EMPTY pool must reach a phase end.
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

function workspaceRow(app: AppHandle): { generation: number; scaffolded: number } {
  return app.db
    .prepare("SELECT generation, scaffolded FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number };
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

// ── 1. activation → vote-skip pick → re-entrancy pin → expiry reversion ─────

describe("chaos e2e: 3 unique !chaos activate; window close SKIPS the vote; expiry reverts to democracy", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;
  let pickedText = "";

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "30", // phase ends only via pool-full early close
      EARLY_CLOSE_POOL_SIZE: "2",
      CHAOS_ACTIVATION_VOTES: "3",
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

    // Tally: u1, a DUPE from u1, u2 — then the threshold-th unique chatter u3.
    chat.say("u1", "ann", "!chaos");
    chat.say("u1", "ann", "!chaos"); // dupe — must never advance the count
    chat.say("u2", "bob", "!chaos");
    await until(() => sent.some((m) => m.includes("Chaos votes: 2/3")));
    chat.say("u3", "cal", "!chaos");
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" }).length === 1,
    );
    chat.say("u4", "dee", "!chaos"); // while active — silent no-op

    // Two approved chat suggestions → pool hits EARLY_CLOSE_POOL_SIZE → the
    // suggest window closes NOW → the chaos pick (not a vote round).
    chat.say("s1", "eve", "!suggest build a snake game");
    chat.say("s2", "fay", "!suggest build a tetris clone");
    await until(() => chaosPickRows(app).length === 1);
    pickedText = chaosPickRows(app)[0]?.suggestion_text ?? "";
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    // Give any (incorrect) double-begin/double-pick room to surface.
    await sleep(300);
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("tally narration fires ONLY on count increase: one 1/3 beat, one 2/3 beat, dupes silent", () => {
    const tallyLines = sent.filter((m) => m.startsWith("Chaos votes:"));
    expect(tallyLines).toEqual([
      "Chaos votes: 1/3 — type !chaos to skip the voting.",
      "Chaos votes: 2/3 — type !chaos to skip the voting.",
    ]);
  });

  it("activation: chaos_activated audit row (3 unique chatters) + the activation beat (env-tuned 0:03)", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rationale).toBe("Chaos mode activated by 3 unique chatters");
    expect(sent.some((m) => m.startsWith("CHAOS MODE ACTIVATED — no voting for 0:03"))).toBe(true);
  });

  it("vote-skip: NO vote round opened; ONE pooled candidate was picked, enqueued and built via the winner rail", () => {
    expect(sent.some((m) => m.startsWith("Voting is OPEN"))).toBe(false);
    const rows = chaosPickRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("suggestion"); // kind recorded in decision
    expect(["build a snake game", "build a tetris clone"]).toContain(pickedText);
    expect(sent.some((m) => m.startsWith(`Chaos picked: "${pickedText}"`))).toBe(true);
    // Built through the SAME rail: one agent run, queue drained, pool keeps the loser.
    expect(runner.specs).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.pool.list()).toHaveLength(1);
  });

  it("RE-ENTRANCY PIN: exactly ONE chaos_pick row for the picked window (no double-begin)", () => {
    // The suggest-phase begin beats are silent now (anti-spam, Ross 2026-07-11),
    // so re-entrancy is pinned on the downstream invariant instead: a
    // double-began phase would close twice and emit a SECOND chaos_pick row.
    // Exactly one row proves the #maybeBegin guard held — one begin, one pick,
    // one timer per window — even though the pick synchronously entered
    // BUILD_IN_PROGRESS (STATE_CHANGED mid-hook).
    expect(chaosPickRows(app)).toHaveLength(1);
  });

  it("expiry auto-reverts: chaos_expired row + beat, then the NEXT window close opens a NORMAL vote round", async () => {
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_expired" }).length === 1,
      8_000,
    );
    expect(sent.some((m) => m === "Chaos mode is over — voting is back.")).toBe(true);

    // Democracy is back: pool refills to the early-close cap → a vote round opens.
    chat.say("s3", "gil", "!suggest a drawing board");
    await until(() => sent.some((m) => m.startsWith("Voting is OPEN")));
    expect(app.round.snapshot()?.status).toBe("open");
    expect(chaosPickRows(app)).toHaveLength(1); // no further picks after expiry
    app.round.closeRound();
  }, 15_000);
});

// ── 2. paid-source exclusion (allowlist) + empty-eligible-pool restart ──────

describe("chaos e2e: paid-source candidates are NEVER chaos-pickable; empty eligible pool restarts the window", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "0.3", // short real-timer phases — empty pool must reach phase ends
      CHAOS_ACTIVATION_VOTES: "3",
      CHAOS_MODE_DURATION_SECONDS: "30",
    });
    // NO build engine: a queued pick would just sit — irrelevant here. The rng
    // is FORCED to index 0 — the paid candidate's position in the unfiltered
    // pool — so only the allowlist can explain it never being picked.
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      chaosRng: () => 0,
    });

    chat.say("u1", "ann", "!chaos");
    chat.say("u2", "bob", "!chaos");
    chat.say("u3", "cal", "!chaos");
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" }).length === 1,
    );
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("an EMPTY pool at chaos phase ends is safe: no pick, no round, no queue (window keeps cycling)", async () => {
    // stillCollecting is silent now (anti-spam, Ross 2026-07-11), so we let
    // several 0.3s chaos phase-ends fire against the empty pool by TIME rather
    // than by counting restart beats, then assert the empty branch neither
    // picked nor opened a round. Chaos stays active (30s) across these ends, so
    // the window kept restarting throughout.
    await sleep(1_500); // ~5 phase-ends at SUGGEST_PHASE_SECONDS=0.3
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(sent.some((m) => m.startsWith("Voting is OPEN"))).toBe(false);
    expect(app.taskQueue.list()).toHaveLength(0);
  }, 10_000);

  it("a pool holding ONLY a paid-source candidate behaves as empty: the donation candidate is never picked", async () => {
    app.pool.add(candidate("paid-1", "a tipped idea", { source: "donation" }), approved);
    // Let several 0.3s chaos phase-ends fire against the paid-only pool (beats are
    // silent now — anti-spam — so wait on TIME, not the stillCollecting beat).
    await sleep(1_500); // ~5 phase-ends at SUGGEST_PHASE_SECONDS=0.3
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.pool.list().map((c) => c.candidate.id)).toContain("paid-1");
  }, 10_000);

  it("with rng FORCED at the paid index, the pick lands on the allowlisted neighbor instead", async () => {
    // Unfiltered pool order: [paid-1 (index 0 — the forced rng target), chat-1].
    app.pool.add(candidate("chat-1", "a chat idea"), approved);
    await until(() => chaosPickRows(app).length === 1, 5_000);
    const row = chaosPickRows(app)[0];
    expect(row?.task_id).toBe("chat-1");
    expect(row?.suggestion_text).toBe("a chat idea");
    // The paid candidate is untouched — still pooled, never queued.
    expect(app.pool.list().map((c) => c.candidate.id)).toContain("paid-1");
    expect(app.taskQueue.list().map((t) => t.id)).toEqual(["chat-1"]);
  }, 10_000);
});

// ── 3. FREE REIGN > CHAOS + HALT clears chaos ────────────────────────────────

describe("chaos e2e: a live free-reign window defers picks; HALT clears tally AND window; recovery is democratic", () => {
  const chat = fakeChatSource();
  const donation = fakeDonationSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "0.3",
      CHAOS_ACTIVATION_VOTES: "3",
      CHAOS_MODE_DURATION_SECONDS: "60",
    });
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      chaosRng: () => 0,
    });

    chat.say("u1", "ann", "!chaos");
    chat.say("u2", "bob", "!chaos");
    chat.say("u3", "cal", "!chaos");
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" }).length === 1,
    );
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("FREE REIGN outranks CHAOS: no pick fires while the window is live; chaos resumes after revoke", async () => {
    donation.emitTip(tip()); // $5 → a 60s window; machine → FREE_REIGN_WINDOW
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    app.pool.add(candidate("chaos-target", "an eligible idea"), approved);

    // Several phase deadlines pass while the window is live — the scheduler is
    // parked (isControlWindowLive sits BEFORE the pick hook): no pick fires.
    await sleep(900);
    expect(chaosPickRows(app)).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);

    // The window closes (streamer revoke) → the cycle resumes → the still-live
    // chaos window picks at the next phase end.
    app.controlWindow.revoke();
    await until(() => app.machine.mode === "IDLE");
    await until(() => chaosPickRows(app).length === 1, 5_000);
    expect(chaosPickRows(app)[0]?.task_id).toBe("chaos-target");
  }, 10_000);

  it("HALT clears chaos (tally AND window): no pick fires while HALTED; recovery restores DEMOCRATIC mode", async () => {
    const haltRes = await postJson(app, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");

    // !chaos while HALTED is a no-op — no tally beats, no activation.
    const tallyBefore = sent.filter((m) => m.startsWith("Chaos votes:")).length;
    chat.say("h1", "hal", "!chaos");
    chat.say("h2", "ivy", "!chaos");
    chat.say("h3", "joe", "!chaos");
    await sleep(150);
    expect(sent.filter((m) => m.startsWith("Chaos votes:")).length).toBe(tallyBefore);
    expect(listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" })).toHaveLength(1);

    // No pick can fire while HALTED, even with an eligible pool.
    app.pool.add(candidate("halted-1", "an idea during halt"), approved);
    await sleep(700);
    expect(chaosPickRows(app)).toHaveLength(1); // unchanged from the pre-halt pick

    // Recovery: DEMOCRATIC mode — the cleared chaos window never resurrects.
    const recoverRes = await postJson(app, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).toBe("IDLE");

    // The pre-halt window (60s) would still be live had HALT not cleared it —
    // a fresh !chaos vote gets a FRESH 1/3 tally beat (not "already-active"
    // silence, not a resumed count): both the window AND the tally died.
    chat.say("u1", "ann", "!chaos"); // same chatter as the pre-halt tally
    await until(
      () =>
        sent.filter((m) => m === "Chaos votes: 1/3 — type !chaos to skip the voting.").length >= 2,
    );

    // And the next phase end with a 2-candidate pool opens a NORMAL vote round.
    app.pool.add(candidate("d1", "democratic idea"), approved);
    await until(() => sent.some((m) => m.startsWith("Voting is OPEN")), 5_000);
    expect(chaosPickRows(app)).toHaveLength(1); // still just the pre-halt pick
    app.round.closeRound();
  }, 15_000);
});

// ── 4. kind routing through the UNCHANGED q5n router ─────────────────────────

describe("chaos e2e: picks ride the q5n kind router — ship-gate holds for project-switch; revert reverts", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;
  let rngIndex = 0;
  const publishCalls: PublishInput[] = [];
  const revertCalls: RevertInput[] = [];
  // A publisher whose SHIP always fails (the confirmed-push gate must hold) and
  // whose REVERT succeeds.
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
      CHAOS_ACTIVATION_VOTES: "1", // env-tunable threshold: a single !chaos activates
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

    // DEMOCRATIC prologue: scaffold generation 1 via a normal voted build so
    // the workspace holds an ACTIVE project (the ship gate has something to ship).
    chat.say("s1", "ann", "!suggest make a counter app");
    chat.say("s2", "bob", "!suggest a filler idea");
    await until(() => app.round.snapshot()?.status === "open"); // early close opened the round
    const snap = app.round.snapshot();
    const counter = snap?.candidates.find((c) => c.candidate.text === "make a counter app");
    if (!counter) throw new Error("counter candidate not drawn");
    app.round.recordVote("v1", counter.option);
    app.round.closeRound();
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    await until(() => workspaceRow(app).scaffolded === 1);

    // A single !chaos activates (threshold knob = 1).
    chat.say("u1", "cal", "!chaos");
    await until(
      () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_activated" }).length === 1,
    );
  }, 15_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("a chaos-picked PROJECT-SWITCH with a failing publisher NEVER rotates (confirmed-push gate holds identically)", async () => {
    const generationBefore = workspaceRow(app).generation;
    rngIndex = 0; // eligible order: [project-switch, filler] → pick the switch
    chat.say("b1", "dee", "!build make a snake game");
    chat.say("f1", "eve", "!suggest filler two");

    await until(() => chaosPickRows(app).length === 1, 5_000);
    expect(chaosPickRows(app)[0]?.decision).toBe("project-switch");
    // The ship attempt ran and FAILED → rotation withheld.
    await until(() => sent.some((m) => m.startsWith("Couldn't ship the current project")), 5_000);
    await until(() => app.machine.mode === "IDLE");
    expect(workspaceRow(app).generation).toBe(generationBefore); // NO rotation
    expect(runner.specs).toHaveLength(1); // no new build started (still the prologue's)
    // The SHIP attempt (title "app-1 final snapshot") ran, failed, and was audited.
    expect(publishCalls.some((c) => c.title === "app-1 final snapshot")).toBe(true);
    const pickTaskId = chaosPickRows(app)[0]?.task_id;
    const failedPublish = listAuditRecords(app.db, { limit: 20, eventType: "gallery_publish" });
    expect(failedPublish.some((r) => r.decision === "failed" && r.task_id === pickTaskId)).toBe(
      true,
    );
  }, 10_000);

  it("a chaos-picked REVERT runs the revert path (revert_outcome row, build_history 'reverted') — never an agent build", async () => {
    rngIndex = 1; // eligible order: [filler two, revert] → pick the revert
    chat.say("r1", "fay", "!revert");
    await until(() => chaosPickRows(app).length === 2, 5_000);
    const revertPick = chaosPickRows(app)[0]; // newest-first
    expect(revertPick?.decision).toBe("revert");

    await until(() => revertCalls.length === 1, 5_000);
    await until(() => app.machine.mode === "IDLE");
    const outcomes = listAuditRecords(app.db, { limit: 10, eventType: "revert_outcome" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.decision).toBe("reverted");
    const history = listBuildHistory(app.db, { limit: 10 });
    // PROVENANCE ACK (checker INFO 1): the chaos-picked revert rides the SAME
    // winner rail, so build_history provenance reads "vote" — the true origin
    // is the chaos_pick row (kind in `decision`).
    expect(history.some((h) => h.result === "reverted" && h.provenance === "vote")).toBe(true);
    expect(runner.specs).toHaveLength(1); // a revert never reaches the agent runner
  }, 10_000);
});
