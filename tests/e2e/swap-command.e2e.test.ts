import { setTimeout as sleep } from "node:timers/promises";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import { openDb } from "../../src/audit/db.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp, normalizeSwapName, resolveSwapTarget } from "../../src/main.js";
import {
  createGalleryPublisher,
  createProjectRepoStore,
  type GalleryExec,
  type GalleryFs,
  type GalleryPublisher,
  type PublishInput,
  type PublishResult,
} from "../../src/orchestrator/gallery-publisher.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";

/**
 * !swapbuild e2e (quick-t8k): a chat-voted kind "swap" candidate rides the ONE
 * funnel into the mixed vote; the kind router's swap arm SHIPS the current
 * project (LOCKED confirmed-push gate: published|no-changes) and only then
 * activates the EXISTING target generation — repo binding REUSED, pointer-only
 * move, monotonic top_generation so a later new-project can never collide.
 * Every failure branch is amber-narrated, audited, head-removed — never a
 * dead round.
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

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

function recordingPublisher(behavior?: { ship?: (input: PublishInput) => PublishResult }) {
  const publishCalls: PublishInput[] = [];
  const publisher: GalleryPublisher = {
    publishNow(input) {
      publishCalls.push(input);
      return Promise.resolve(
        behavior?.ship?.(input) ?? { status: "published", commitHash: "fakehash", detail: "ok" },
      );
    },
    revertLast() {
      return Promise.resolve({ status: "failed", commitHash: null, detail: "unused" });
    },
  };
  return { publisher, publishCalls };
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

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

function workspaceRow(app: AppHandle): {
  generation: number;
  scaffolded: number;
  top_generation: number;
} {
  return app.db
    .prepare("SELECT generation, scaffolded, top_generation FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number; top_generation: number };
}

/**
 * Seed a three-generation shipped portfolio the durable way (crash-restore
 * path): pointer at generation 3, high-water 3, three project_repos rows.
 */
function seedPortfolio(app: AppHandle): void {
  const now = Date.now();
  app.db
    .prepare(
      "UPDATE workspace_state SET generation = 3, top_generation = 3, scaffolded = 1, updated_at_ms = ? WHERE id = 1",
    )
    .run(now);
  const ins = app.db.prepare(
    "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)",
  );
  ins.run(1, "snake-game", now);
  ins.run(2, "dark-theme", now);
  ins.run(3, "counter-app", now);
}

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

// ── 1. happy path: gate → pool → vote → ship → activate → monotonic rotation ─

describe("swap e2e: winner ships current (confirmed), activates existing generation, next new-project allocates ABOVE the high-water mark", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const pub = recordingPublisher();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let swapWinnerId = "";

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
    seedPortfolio(app);

    chat.say("1", "ann", '!swapbuild "snake-game"');
    chat.say("2", "bob", "!suggest filler idea one");
    await until(() => app.pool.list().length === 2);
    swapWinnerId = voteKindToVictory(app, "swap");
    await until(
      () =>
        listAuditRecords(app.db, { limit: 10, eventType: "swap_activated" }).length === 1 &&
        app.machine.mode === "IDLE",
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("an approved chat swap got the pooled-swap confirmation beat (coalesced flush)", async () => {
    await until(() => sent.some((m) => m.includes("@ann PROJECT SWAP request is in")));
  });

  it("the swap candidate pooled as kind 'swap' through the ONE funnel (gate_decision row exists)", () => {
    const rows = listAuditRecords(app.db, { limit: 20, eventType: "gate_decision" });
    expect(rows.some((r) => r.suggestion_text === "snake-game" && r.decision === "approved")).toBe(
      true,
    );
  });

  it("LOCKED ordering: the ship publish carried the PRE-swap generation + server-composed title", () => {
    expect(pub.publishCalls[0]).toEqual({
      generation: 3,
      title: "app-3 final snapshot",
      taskId: swapWinnerId,
    });
  });

  it("activation is a pointer-only move: generation 1, scaffolded 1, top_generation UNTOUCHED at 3", () => {
    expect(workspaceRow(app)).toEqual({ generation: 1, scaffolded: 1, top_generation: 3 });
  });

  it("no agent build ran for the swap (no-build arm) and the head left the queue", () => {
    expect(runner.specs).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("narrates the landed beat with the resolved repo slug as the only dynamic token", async () => {
    await until(() => sent.some((m) => m.includes('SWAP complete — "snake-game"')));
  });

  it("audits swap_activated with from/to generations + repo name", () => {
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "swap_activated" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_id).toBe(swapWinnerId);
    expect(rows[0]?.rationale).toContain("snake-game");
  });

  it("POST-SWAP NEW-REPO PIN: a project-switch winner after the backward swap allocates generation 4 (NEVER 2) and publishes with the fresh generation", async () => {
    chat.say("3", "cal", "!build brand new idea");
    chat.say("4", "dee", "!suggest filler idea two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(
      () =>
        workspaceRow(app).generation === 4 &&
        runner.specs.length === 1 &&
        app.machine.mode === "IDLE",
    );

    // Both columns advanced together — the high-water mark moved to 4.
    expect(workspaceRow(app)).toMatchObject({ generation: 4, top_generation: 4 });
    // The switch build scaffolds the FRESH dir — never app-2's debris.
    expect(runner.specs[0]?.workspaceDir).toBe("/home/builder/projects/app-4");
    // Its ship ran against the swapped-to generation 1; the post-build publish
    // carries generation 4 (store.lookup(4) === null → NEW repo rule).
    expect(pub.publishCalls[1]).toMatchObject({ generation: 1, title: "app-1 final snapshot" });
    await until(() => pub.publishCalls.length === 3);
    expect(pub.publishCalls[2]?.generation).toBe(4);
    expect(pub.publishCalls[2]?.title).toBe("brand new idea");
  });
});

// ── 2. LOCKED confirmed-push gate: both orderings pinned ────────────────────

describe("swap e2e: a FAILED ship never activates; no-changes DOES activate", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let shipMode: PublishResult["status"] = "failed";
  let pub: ReturnType<typeof recordingPublisher>;
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let failedWinnerId = "";

  beforeAll(async () => {
    pub = recordingPublisher({
      ship: () => ({ status: shipMode, commitHash: null, detail: "test: ship outcome" }),
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
    seedPortfolio(app);

    chat.say("1", "ann", "!swapbuild snake-game");
    chat.say("2", "bob", "!suggest failure filler one");
    await until(() => app.pool.list().length === 2);
    failedWinnerId = voteKindToVictory(app, "swap");
    await until(() => sent.some((m) => m.includes("Couldn't wrap up the current project")));
    await until(() => app.machine.mode === "IDLE");
  });

  afterAll(async () => {
    await app.close();
  });

  it("ship failed → generation pointer UNCHANGED, no activation, scaffolded untouched", () => {
    expect(workspaceRow(app)).toEqual({ generation: 3, scaffolded: 1, top_generation: 3 });
    expect(listAuditRecords(app.db, { limit: 10, eventType: "swap_activated" })).toHaveLength(0);
  });

  it("head removed, amber beat (no red wording), audit ship-failed row, machine IDLE — never a dead round", () => {
    expect(app.taskQueue.list()).toHaveLength(0);
    const line = sent.find((m) => m.includes("Couldn't wrap up the current project"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/error|alarm|crash|panic|fatal|broken/i);
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "swap_failed" });
    expect(rows.some((r) => r.task_id === failedWinnerId && r.decision === "ship-failed")).toBe(
      true,
    );
    expect(app.machine.mode).toBe("IDLE");
  });

  it("{ status: 'no-changes' } DOES activate — an already-pushed remote counts as confirmed", async () => {
    shipMode = "no-changes";
    chat.say("3", "cal", '!swapbuild "dark-theme"');
    chat.say("4", "dee", "!suggest failure filler two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "swap");
    await until(() => workspaceRow(app).generation === 2);
    expect(workspaceRow(app)).toEqual({ generation: 2, scaffolded: 1, top_generation: 3 });
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "swap_activated" });
    expect(rows).toHaveLength(1);
    await until(() => app.machine.mode === "IDLE");
  });
});

// ── 3. failed-head idiom: unresolvable + exclusively-current ────────────────

describe("swap e2e: unresolvable name and already-current target are honest amber failures — no activation, next round opens", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let pub: ReturnType<typeof recordingPublisher>;
  let app: AppHandle;

  beforeAll(async () => {
    pub = recordingPublisher();
    const runner = recordingRunner();
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
    seedPortfolio(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("unresolvable name → swapUnresolved amber, audit 'unresolved', NO ship, NO activation, IDLE", async () => {
    chat.say("1", "ann", "!swapbuild zz-totally-unknown");
    chat.say("2", "bob", "!suggest unresolved filler");
    await until(() => app.pool.list().length === 2);
    const winnerId = voteKindToVictory(app, "swap");
    await until(() => sent.some((m) => m.includes("Couldn't find that project by name")));
    await until(() => app.machine.mode === "IDLE");

    expect(pub.publishCalls).toHaveLength(0);
    expect(workspaceRow(app)).toMatchObject({ generation: 3 });
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "swap_failed" });
    expect(rows.some((r) => r.task_id === winnerId && r.decision === "unresolved")).toBe(true);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("a swap naming the CURRENT project → its own DISTINCT honest amber line, audit 'already-current'", async () => {
    chat.say("3", "cal", '!swapbuild "counter-app"');
    chat.say("4", "dee", "!suggest current filler");
    await until(() => app.pool.list().length === 2);
    const winnerId = voteKindToVictory(app, "swap");
    await until(() => sent.some((m) => m.includes("That's the project already on screen")));
    await until(() => app.machine.mode === "IDLE");

    // Never the misleading "couldn't find it" copy for a current-project swap.
    const line = sent.find((m) => m.includes("That's the project already on screen"));
    expect(line).not.toContain("Couldn't find");
    expect(pub.publishCalls).toHaveLength(0);
    expect(workspaceRow(app)).toMatchObject({ generation: 3 });
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "swap_failed" });
    expect(rows.some((r) => r.task_id === winnerId && r.decision === "already-current")).toBe(
      true,
    );
  });

  it("the loop is never dead-rounded: a fresh round can open after both failures", async () => {
    chat.say("5", "eve", "!suggest another idea");
    chat.say("6", "fay", "!suggest yet another idea");
    await until(() => app.pool.list().length >= 2);
    const snap = app.round.startRound();
    expect(snap.status).toBe("open");
    app.round.closeRound();
  });
});

// ── 4. resolution precedence (pure) ─────────────────────────────────────────

describe("swap resolution: normalizeSwapName + resolveSwapTarget precedence table", () => {
  const row = (generation: number, repo_name: string) => ({ generation, repo_name });

  it("normalizeSwapName mirrors sanitizeRepoName minus the dated fallback", () => {
    expect(normalizeSwapName("Snake Game!")).toBe("snake-game");
    expect(normalizeSwapName("  SNAKE__game  ")).toBe("snake-game");
    expect(normalizeSwapName("!!!")).toBe(""); // empty — NO dated fallback
    expect(normalizeSwapName(`${"x".repeat(85)}`)).toBe("x".repeat(80));
  });

  it("exact beats prefix beats substring", () => {
    const rows = [row(1, "snake"), row(2, "snake-game"), row(3, "my-snake")];
    expect(resolveSwapTarget(rows, "snake", 9)).toEqual(row(1, "snake"));
    expect(resolveSwapTarget([row(2, "snake-game"), row(3, "my-snake")], "snake", 9)).toEqual(
      row(2, "snake-game"),
    );
    expect(resolveSwapTarget([row(3, "my-snake")], "snake", 9)).toEqual(row(3, "my-snake"));
  });

  it("multiple matches at the winning tier → HIGHEST generation wins", () => {
    const rows = [row(1, "snake-one"), row(4, "snake-two"), row(2, "snake-three")];
    expect(resolveSwapTarget(rows, "snake", 9)).toEqual(row(4, "snake-two"));
  });

  it("prefers a NON-current match when the current generation ties the winning tier", () => {
    const rows = [row(1, "snake-game"), row(3, "snake-game-two")];
    // Current gen 3 also prefix-matches "snake" — the older non-current wins.
    expect(resolveSwapTarget(rows, "snake", 3)).toEqual(row(1, "snake-game"));
  });

  it("an exclusively-current match resolves TO the current row (caller rejects it honestly)", () => {
    const rows = [row(3, "counter-app")];
    expect(resolveSwapTarget(rows, "counter-app", 3)).toEqual(row(3, "counter-app"));
  });

  it("no match at all → null; empty needle → null", () => {
    expect(resolveSwapTarget([row(1, "snake-game")], "zzz", 9)).toBeNull();
    expect(resolveSwapTarget([row(1, "snake-game")], "", 9)).toBeNull();
  });
});

// ── 5. repo binding REUSED at the real-publisher level ──────────────────────

describe("swap repo reuse: the REAL publisher never scaffolds for a generation with a project_repos row", () => {
  function galleryHarness() {
    const calls: string[][] = [];
    const exec: GalleryExec = async (_file, args) => {
      calls.push([_file, ...args]);
      if (args.includes("--porcelain")) return { stdout: " M index.html\n" };
      if (args.includes("rev-parse")) return { stdout: "abc123\n" };
      if (args.includes("rev-list")) return { stdout: "2\n" };
      return { stdout: "" };
    };
    const fsx: GalleryFs = {
      rm: async () => {},
      cp: async () => {},
      mkdir: async () => ({}),
      access: async () => {}, // every mirror already has .git
      readdir: async () => ["index.html"],
    };
    const db = openDb(":memory:");
    const store = createProjectRepoStore(db);
    store.record(1, "snake-game");
    store.record(2, "dark-theme");
    store.record(3, "counter-app");
    const publisher = createGalleryPublisher({
      config: {
        owner: "TwitchVibecodes",
        token: "test-token",
        mirrorRootDir: "data/test-mirror",
        workspaceRootUnc: "\\\\wsl.localhost\\test\\home\\builder\\projects",
      },
      store,
      exec,
      fsx,
      logger: pino({ level: "silent" }),
    });
    return { calls, publisher, db };
  }

  it("post-swap publish on the swapped-to generation runs ZERO `gh repo create` calls (binding reused)", async () => {
    const { calls, publisher, db } = galleryHarness();
    const result = await publisher.publishNow({
      generation: 1,
      title: "app-1 final snapshot",
      taskId: "t-1",
    });
    expect(result.status).toBe("published");
    expect(calls.some((c) => c[0] === "gh" && c.includes("create"))).toBe(false);
    db.close();
  });

  it("a FRESH high-water generation (no row) scaffolds a NEW repo and never touches the old ones", async () => {
    const { calls, publisher, db } = galleryHarness();
    const result = await publisher.publishNow({
      generation: 4,
      title: "brand new idea",
      taskId: "t-2",
    });
    expect(result.status).toBe("published");
    const creates = calls.filter((c) => c[0] === "gh" && c.includes("create"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("TwitchVibecodes/brand-new-idea");
    expect(creates[0]?.join(" ")).not.toContain("snake-game");
    expect(creates[0]?.join(" ")).not.toContain("dark-theme");
    expect(creates[0]?.join(" ")).not.toContain("counter-app");
    db.close();
  });
});

// ── 6. separation pins: chaos console pick + paid window + gate-before-pool ─

describe("swap separation pins: chaos console pick excludes swap; paid-window !swapbuild pools; rejected swap never pools", () => {
  it("chaos console pick (raw build agent consumer) still excludes kind 'swap' from a mixed pool", async () => {
    const runner = recordingRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chaosRng: () => 0, // always the FIRST entry of whatever list it is given
    });
    try {
      app.pool.add(
        {
          id: "sw-1",
          source: "chat",
          kind: "swap",
          twitchUsername: "a",
          text: "snake-game",
          submittedAtMs: Date.now(),
        },
        approved,
      );
      app.pool.add(
        {
          id: "sg-1",
          source: "chat",
          kind: "suggestion",
          twitchUsername: "b",
          text: "add a dark theme",
          submittedAtMs: Date.now(),
        },
        approved,
      );
      app.chaos.toggle();
      await until(
        () => listAuditRecords(app.db, { limit: 10, eventType: "chaos_pick" }).length > 0,
      );
      const picks = listAuditRecords(app.db, { limit: 10, eventType: "chaos_pick" });
      expect(picks[0]?.suggestion_text).toBe("add a dark theme");
      expect(app.pool.list().map((c) => c.candidate.id)).toContain("sw-1");
      await until(() => runner.specs.length === 1);
      app.chaos.toggle();
      await until(() => app.machine.mode === "IDLE");
    } finally {
      await app.close();
    }
  });

  it("during a FREE-REIGN window, !swapbuild is NOT consumed by the interceptor — it pools for the next vote", async () => {
    const chat = fakeChatSource();
    const donation = fakeDonationSource();
    const { sink } = capturingSink();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      donationSource: donation.source,
    });
    try {
      donation.emitTip({
        username: "alice",
        displayName: "Alice",
        amount: 5,
        currency: "USD",
        message: "take the wheel",
        tipId: "tip-1",
      });
      expect(app.controlWindow.snapshot()).not.toBeNull();

      chat.say("10", "windowfan", "!swapbuild snake-game");
      await until(() => app.pool.list().length === 1);
      const pooled = app.pool.list()[0];
      expect(pooled?.candidate.kind).toBe("swap");
      expect(pooled?.candidate.text).toBe("snake-game");
      // The queue did NOT grow — a swap never bypasses the vote via a window.
      expect(app.taskQueue.list()).toHaveLength(0);
      app.controlWindow.revoke();
    } finally {
      await app.close();
    }
  });

  it("gate-before-pool: a REJECTED swap never pools (single funnel holds for kind 'swap')", async () => {
    const chat = fakeChatSource();
    const { sink } = capturingSink();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (c) =>
        c.text.includes("banword")
          ? { decision: "rejected" as const, category: "harassment", rationale: "test: banned" }
          : approved,
      chatSource: chat.source,
      chatSink: sink,
    });
    try {
      chat.say("1", "ann", "!swapbuild banword project");
      // The gate ran (one gate_decision row) but the rejected swap never pooled.
      await until(
        () => listAuditRecords(app.db, { limit: 5, eventType: "gate_decision" }).length === 1,
      );
      const rows = listAuditRecords(app.db, { limit: 5, eventType: "gate_decision" });
      expect(rows[0]?.decision).toBe("rejected");
      expect(app.pool.list()).toHaveLength(0);
      expect(app.taskQueue.list()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
