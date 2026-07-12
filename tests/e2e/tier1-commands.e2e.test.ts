import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import { REVERT_REQUEST_TEXT } from "../../src/ingestion/command-parser.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  GalleryPublisher,
  PublishInput,
  PublishResult,
  RevertInput,
  RevertResult,
} from "../../src/orchestrator/gallery-publisher.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import { POOL_CHANGED } from "../../src/shared/events.js";

/**
 * Tier-1 voted commands e2e (quick-q5n): !build / !revert compete in the SAME
 * vote round as !suggest, and the kind router at build-queue drain executes the
 * winner: suggestion → continue (unchanged), project-switch → ship-then-rotate
 * (LOCKED USER DECISION: rotation ONLY on a confirmed publish outcome),
 * revert → host-side mirror rollback (never an agent build).
 *
 * Driven against createApp's injected-fake seams (fake chat source/sink, fake
 * classifier, fake AgentRunner/SandboxAdapter, fake GalleryPublisher recording
 * publishNow/revertLast) — no network, no real git. The fakes travel the
 * IDENTICAL composition path production uses.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── fixtures (build-flow / paid-window idioms) ────────────────────────────────

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/** A fast happy-path runner that RECORDS every spec it consumes (spy on startBuild). */
function recordingRunner(seq?: string[]) {
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      seq?.push(`run:${spec.workspaceDir}`);
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

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

/** A recording GalleryPublisher whose ship/revert outcomes are switchable per test. */
function recordingPublisher(behavior?: {
  ship?: (input: PublishInput) => PublishResult;
  revert?: (input: RevertInput) => RevertResult;
}) {
  const publishCalls: PublishInput[] = [];
  const revertCalls: RevertInput[] = [];
  const seq: string[] = [];
  const publisher: GalleryPublisher = {
    publishNow(input) {
      publishCalls.push(input);
      seq.push(`publish:gen-${input.generation}:${input.title}`);
      return Promise.resolve(
        behavior?.ship?.(input) ?? { status: "published", commitHash: "fakehash", detail: "ok" },
      );
    },
    revertLast(input) {
      revertCalls.push(input);
      seq.push(`revert:gen-${input.generation}`);
      return Promise.resolve(
        behavior?.revert?.(input) ?? { status: "reverted", commitHash: "revhash", detail: "ok" },
      );
    },
  };
  return { publisher, publishCalls, revertCalls, seq };
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

/** Current durable workspace row — the rotation observable (no spy needed). */
function workspaceRow(app: AppHandle): { generation: number; scaffolded: number } {
  return app.db
    .prepare("SELECT generation, scaffolded FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number };
}

/** Open a round, vote the option whose candidate has `kind` to victory, close. */
function voteKindToVictory(app: AppHandle, kind: string): string {
  app.round.startRound();
  const snap = app.round.snapshot();
  const entry = snap?.candidates.find((c) => c.candidate.kind === kind);
  if (!entry) throw new Error(`no pooled candidate of kind ${kind} in the round`);
  app.round.recordVote("voter-1", entry.option);
  const winnerId = entry.candidate.id;
  app.round.closeRound();
  return winnerId;
}

/**
 * Pool one suggestion via chat (plus a filler — startRound needs ≥2, D2-04)
 * and drive it to a DONE build (scaffolds gen 1).
 */
async function driveFirstBuildDone(
  app: AppHandle,
  chat: ReturnType<typeof fakeChatSource>,
  specs: AgentRunSpec[],
): Promise<void> {
  chat.say("100", "seeder", "!suggest make a counter app");
  chat.say("101", "filler0", "!suggest seed filler idea");
  await until(() => app.pool.list().length === 2);
  voteKindToVictory(app, "suggestion");
  await until(() => specs.length === 1 && app.machine.mode === "IDLE");
  await until(() => workspaceRow(app).scaffolded === 1);
}

// ── 1. mixed round + revert winner routes host-side ─────────────────────────

describe("tier-1 e2e: mixed round — NEW/TWEAK/REVERT compete in ONE vote; revert winner never builds", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const pub = recordingPublisher();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let revertWinnerId = "";

  beforeAll(async () => {
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
      galleryPublisher: pub.publisher,
    });

    chat.say("1", "ann", "!suggest add a dark theme");
    chat.say("2", "bob", "!build make a snake game");
    chat.say("3", "cal", "!revert");
    await until(() => app.pool.list().length === 3);

    revertWinnerId = voteKindToVictory(app, "revert");
    await until(() => pub.revertCalls.length === 1 && app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("all three kinds landed in ONE pool and ONE round", () => {
    // The round-open chat line shows the mixed NEW / TWEAK / REVERT wording.
    const open = sent.find((m) => m.startsWith("Voting is OPEN"));
    expect(open).toBeDefined();
    expect(open).toContain("TWEAK: add a dark theme");
    expect(open).toContain("NEW: make a snake game");
    expect(open).toContain("REVERT the last change");
  });

  it("the revert winner is REMOVED from the queue and never reaches startBuild", () => {
    expect(runner.specs).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("revertLast received the current generation + the winner's taskId", () => {
    expect(pub.revertCalls).toEqual([{ generation: 1, taskId: revertWinnerId }]);
  });

  it("narrates revertApplied and writes the build_history row (result 'reverted', provenance 'vote', fixed title)", async () => {
    await until(() => sent.some((m) => m.includes("Rolled back the last change")));
    const rows = listBuildHistory(app.db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: revertWinnerId,
      title: REVERT_REQUEST_TEXT,
      provenance: "vote",
      result: "reverted",
    });
    const audit = listAuditRecords(app.db, { limit: 10, eventType: "revert_outcome" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decision).toBe("reverted");
    expect(audit[0]?.task_id).toBe(revertWinnerId);
  });

  it("the loop is never dead-rounded: machine is IDLE and a fresh round can open", async () => {
    expect(app.machine.mode).toBe("IDLE");
    chat.say("4", "dee", "!suggest another idea");
    chat.say("5", "eve", "!suggest yet another idea");
    await until(() => app.pool.list().length >= 2);
    const snap = app.round.startRound();
    expect(snap.status).toBe("open");
    app.round.closeRound();
  });
});

// ── 2. ship-success ordering (LOCKED DECISION: ship strictly BEFORE rotate) ──

describe("tier-1 e2e: project-switch winner ships the current app FIRST, rotates ONLY on confirmed publish", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let pub: ReturnType<typeof recordingPublisher>;
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let switchWinnerId = "";

  beforeAll(async () => {
    pub = recordingPublisher();
    runner = recordingRunner(undefined);
    // Share ONE ordering sequence between publisher and runner.
    const origRun = runner.runner.run.bind(runner.runner);
    runner.runner.run = (spec) => {
      pub.seq.push(`run:${spec.workspaceDir}`);
      return origRun(spec);
    };
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: pub.publisher,
    });

    // Generation 1 becomes an ACTIVE project (scaffolded via a done build).
    await driveFirstBuildDone(app, chat, runner.specs);
    await until(() => pub.publishCalls.length === 1); // onBuildDone publish, gen 1

    // The chat-voted NEW PROJECT (plus a filler — startRound needs ≥2).
    chat.say("2", "bob", "!build make a snake game");
    chat.say("3", "cal", "!suggest tweak filler one");
    await until(() => app.pool.list().length === 2);
    switchWinnerId = voteKindToVictory(app, "project-switch");
    // Ship (publish #2) → rotate → scaffold build (run #2) → done → onBuildDone (publish #3).
    await until(() => pub.publishCalls.length === 3 && app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("the FIRST build of a fresh app runs in scaffold mode (tweak-with-no-project default, proven not changed)", () => {
    expect(runner.specs[0]?.workspaceDir).toBe("/home/builder/projects/app-1");
    expect(runner.specs[0]?.systemPrompt).toContain("scaffold the project from scratch");
  });

  it("AWAITED ship call carries the PRE-rotation generation and the server-composed title", () => {
    expect(pub.publishCalls[1]).toEqual({
      generation: 1,
      title: "app-1 final snapshot",
      taskId: switchWinnerId,
    });
  });

  it("ordering: publishNow (gen 1) strictly BEFORE startBuild in the rotated gen-2 workspace (invariant #5)", () => {
    const shipIdx = pub.seq.indexOf("publish:gen-1:app-1 final snapshot");
    const buildIdx = pub.seq.indexOf("run:/home/builder/projects/app-2");
    expect(shipIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(shipIdx);
  });

  it("rotated: workspace generation is 2 and the switch build scaffolded the fresh dir", () => {
    expect(workspaceRow(app).generation).toBe(2);
    expect(runner.specs[1]?.workspaceDir).toBe("/home/builder/projects/app-2");
    expect(runner.specs[1]?.systemPrompt).toContain("scaffold the project from scratch");
  });

  it("audits the chat-vote rotation (recordWorkspaceReset initiator 'chat-vote')", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "workspace_reset" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rationale).toBe("Chat voted a new project — workspace rotated to generation 2");
  });

  it("narrates the ship beat before rotating", () => {
    expect(
      sent.some((m) =>
        m.includes('Chat voted NEW PROJECT: "make a snake game" — shipping the current app'),
      ),
    ).toBe(true);
  });

  it("REGRESSION GUARD (locked decision #2): the new project's first done build publishes with the NEW generation — new builds get new repositories", () => {
    expect(pub.publishCalls[2]?.generation).toBe(2);
    expect(pub.publishCalls[2]?.title).toBe("make a snake game");
  });

  it("audits every publish attempt (gallery_publish rows for onBuildDone + ship + onBuildDone)", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" });
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.task_id === switchWinnerId && r.decision === "published")).toBe(true);
  });
});

// ── 3. ship-failure gates rotation (LOCKED DECISION) ────────────────────────

describe("tier-1 e2e: a FAILED final publish never rotates — amber narration, audit, no dead round", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let shipMode: PublishResult["status"] = "failed";
  let pub: ReturnType<typeof recordingPublisher>;
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let failedWinnerId = "";

  beforeAll(async () => {
    pub = recordingPublisher({
      ship: (input) =>
        input.title.includes("final snapshot")
          ? { status: shipMode, commitHash: null, detail: "test: ship outcome" }
          : { status: "published", commitHash: "hash", detail: "ok" },
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
      galleryPublisher: pub.publisher,
    });
    await driveFirstBuildDone(app, chat, runner.specs);

    chat.say("2", "bob", "!build brand new thing");
    chat.say("30", "fill1", "!suggest failure filler one");
    await until(() => app.pool.list().length === 2);
    failedWinnerId = voteKindToVictory(app, "project-switch");
    await until(() =>
      sent.some((m) => m.includes("Couldn't ship the current project to the gallery")),
    );
    await until(() => app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("rotation NOT invoked: workspace generation stays 1 (newProject zero calls)", () => {
    expect(workspaceRow(app).generation).toBe(1);
  });

  it("NO startBuild for the failed switch — only the seeder build ever ran", () => {
    expect(runner.specs).toHaveLength(1);
  });

  it("the head was removed from the queue (resolves like a failed build)", () => {
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("audited: a gallery_publish 'failed' row exists for the switch task", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" });
    expect(rows.some((r) => r.task_id === failedWinnerId && r.decision === "failed")).toBe(true);
  });

  it("amber narration (D2-18): the ship-failed line carries no red/alarm wording", () => {
    const line = sent.find((m) => m.includes("Couldn't ship the current project"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/error|alarm|crash|panic|fatal|broken/i);
  });

  it("{ status: 'no-changes' } DOES rotate — an already-pushed remote counts as confirmed", async () => {
    shipMode = "no-changes";
    chat.say("3", "cal", "!build a second new thing");
    chat.say("31", "fill2", "!suggest failure filler two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => workspaceRow(app).generation === 2);
    await until(() => runner.specs.length === 2 && app.machine.mode === "IDLE");
    expect(runner.specs[1]?.workspaceDir).toBe("/home/builder/projects/app-2");
  });
});

// ── 4. no publisher configured: switch + revert both degrade gracefully ─────

describe("tier-1 e2e: NO galleryPublisher — cannot confirm a push ⇒ never rotate; revert narrates failure", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let switchWinnerId = "";

  beforeAll(async () => {
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
      // no galleryPublisher; GALLERY_GITHUB_TOKEN unset in tests → none composes
    });
    await driveFirstBuildDone(app, chat, runner.specs);

    chat.say("2", "bob", "!build new thing");
    chat.say("40", "fill3", "!suggest nopub filler one");
    await until(() => app.pool.list().length === 2);
    switchWinnerId = voteKindToVictory(app, "project-switch");
    await until(() =>
      sent.some((m) => m.includes("Couldn't ship the current project to the gallery")),
    );
    await until(() => app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("same failure branch: no rotation, no startBuild, head removed, IDLE", () => {
    expect(workspaceRow(app).generation).toBe(1);
    expect(runner.specs).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.machine.mode).toBe("IDLE");
  });

  it("the no-publisher path writes its OWN failed gallery_publish audit row (checker note)", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" });
    expect(rows.some((r) => r.task_id === switchWinnerId && r.decision === "failed")).toBe(true);
  });

  it("a revert winner with no publisher narrates revertFailed and returns to IDLE (graceful)", async () => {
    chat.say("3", "cal", "!revert");
    chat.say("41", "fill4", "!suggest nopub filler two");
    await until(() => app.pool.list().length === 2);
    const revertId = voteKindToVictory(app, "revert");
    await until(() => sent.some((m) => m.includes("Couldn't roll back cleanly")));
    await until(() => app.machine.mode === "IDLE");
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "revert_outcome" });
    expect(rows[0]?.decision).toBe("failed");
    expect(rows[0]?.task_id).toBe(revertId);
    expect(rows[0]?.rationale).toContain("not configured");
    // No build_history row for a failed revert.
    expect(listBuildHistory(app.db, { limit: 10 }).some((r) => r.result === "reverted")).toBe(
      false,
    );
  });
});

// ── 5. revert with no history: graceful nothing-to-revert ───────────────────

describe("tier-1 e2e: revert winner with nothing to revert — narrated, audited, loop continues", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let pub: ReturnType<typeof recordingPublisher>;
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;

  beforeAll(async () => {
    pub = recordingPublisher({
      revert: () => ({
        status: "nothing-to-revert",
        commitHash: null,
        detail: "no repo has published yet",
      }),
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
      galleryPublisher: pub.publisher,
    });

    chat.say("1", "ann", "!revert");
    chat.say("50", "fill5", "!suggest nothing filler one");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "revert");
    await until(() => pub.revertCalls.length === 1 && app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("narrates revertNothing, writes NO build_history row, audits nothing-to-revert", async () => {
    await until(() => sent.some((m) => m.includes("Nothing to revert")));
    expect(listBuildHistory(app.db, { limit: 10 })).toHaveLength(0);
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "revert_outcome" });
    expect(rows[0]?.decision).toBe("nothing-to-revert");
  });

  it("the next round can open (never a dead round)", async () => {
    chat.say("2", "bob", "!suggest another idea");
    chat.say("51", "fill6", "!suggest nothing filler two");
    await until(() => app.pool.list().length >= 2);
    const snap = app.round.startRound();
    expect(snap.status).toBe("open");
    app.round.closeRound();
  });
});

// ── 6. free-reign byte-compat + gate-before-pool ─────────────────────────────

describe("tier-1 e2e: in-window !build is byte-compatible; outside-window !build pools (kind project-switch)", () => {
  const chat = fakeChatSource();
  const donation = fakeDonationSource();
  const { sent, sink } = capturingSink();
  let app: AppHandle;
  const seq: string[] = [];

  beforeAll(async () => {
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (c) => {
        seq.push(`classify:${c.text}`);
        return approved;
      },
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
      // deliberately NO build engine: the window instruction queues (narrated
      // honestly) and the pool path needs no orchestrator.
    });
    app.pool.on(POOL_CHANGED, () => {
      seq.push("pool");
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("INSIDE an active window: !build routes through the window funnel — queue grows, pool does NOT", async () => {
    donation.emitTip(tip());
    expect(app.controlWindow.snapshot()).not.toBeNull();

    chat.say("10", "donorfan", "!build x inside the window");
    await until(() => app.taskQueue.list().length === 1);
    expect(app.pool.list()).toHaveLength(0);
    // CR-03 honesty: no build engine composed → the "queued" beat, never "building".
    await until(() => sent.some((m) => m.includes("Queued up @donorfan's pick")));
  });

  it("AFTER the window closes: the SAME !build shape pools a kind 'project-switch' candidate", async () => {
    app.controlWindow.revoke();
    expect(app.controlWindow.snapshot()).toBeNull();

    chat.say("11", "viewer2", "!build y outside the window");
    await until(() => app.pool.list().length === 1);
    const pooled = app.pool.list()[0];
    expect(pooled?.candidate.kind).toBe("project-switch");
    expect(pooled?.candidate.text).toBe("y outside the window");
    expect(pooled?.candidate.source).toBe("chat");
    // The queue did NOT grow — outside a window !build never bypasses the vote.
    expect(app.taskQueue.list()).toHaveLength(1); // still just the window task
  });

  it("gate-before-pool: the !build candidate was classified BEFORE it entered the pool (single funnel)", () => {
    const classifyIdx = seq.indexOf("classify:y outside the window");
    const poolIdx = seq.lastIndexOf("pool");
    expect(classifyIdx).toBeGreaterThanOrEqual(0);
    expect(poolIdx).toBeGreaterThan(classifyIdx);
  });
});

// ── 7. chaos never picks a routing verb ─────────────────────────────────────

describe("tier-1 e2e: chaos pick only ever selects kind 'suggestion' from a mixed pool", () => {
  let app: AppHandle;
  let runner: ReturnType<typeof recordingRunner>;

  beforeAll(async () => {
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chaosRng: () => 0, // always the FIRST entry of whatever list it is given
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("with a revert + project-switch pooled BEFORE a suggestion, rng(0) still picks the suggestion", async () => {
    // Mixed pool: routing verbs first — an unfiltered pickChaos(rng=0) would
    // select the revert. The kind guard must exclude both routing verbs.
    app.pool.add(
      {
        id: "rv-1",
        source: "chat",
        kind: "revert",
        twitchUsername: "a",
        text: REVERT_REQUEST_TEXT,
        submittedAtMs: Date.now(),
      },
      approved,
    );
    app.pool.add(
      {
        id: "ps-1",
        source: "chat",
        kind: "project-switch",
        twitchUsername: "b",
        text: "make a snake game",
        submittedAtMs: Date.now(),
      },
      approved,
    );
    app.pool.add(
      {
        id: "sg-1",
        source: "chat",
        kind: "suggestion",
        twitchUsername: "c",
        text: "add a dark theme",
        submittedAtMs: Date.now(),
      },
      approved,
    );

    app.chaos.toggle(); // ON → immediate pick
    await until(() => listAuditRecords(app.db, { limit: 10, eventType: "chaos_pick" }).length > 0);
    const picks = listAuditRecords(app.db, { limit: 10, eventType: "chaos_pick" });
    expect(picks).toHaveLength(1);
    expect(picks[0]?.suggestion_text).toBe("add a dark theme");
    // The routing verbs are still pooled (never consumed by chaos).
    const remaining = app.pool.list().map((c) => c.candidate.id);
    expect(remaining).toContain("rv-1");
    expect(remaining).toContain("ps-1");
    expect(remaining).not.toContain("sg-1");

    await until(() => runner.specs.length === 1);
    app.chaos.toggle(); // OFF — back to IDLE for a clean close
    await until(() => app.machine.mode === "IDLE");
  });
});
