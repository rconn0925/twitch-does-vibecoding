import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { DonationEventSource, TipEvent } from "../../src/ingestion/donation-source.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";
import { allMatches, collectFiles, stripComments } from "../invariants/scan-helpers.js";

/**
 * Wipe-intent save-and-close e2e (quick-260716-rll). Live incident 2026-07-16
 * ~19:41 (audit 885-891): "I want you to delete the whole app" passed the gate
 * (correctly), was solo-picked, and only an unrelated infra failure stopped the
 * build agent from wiping the VOIDFARER workspace.
 *
 * Proven here: a gate-approved destructive-intent winner NEVER reaches the
 * build agent on ANY dispatch path — vote/solo, paid free-reign window, chaos
 * — because every path converges on the ONE dispatchBuild wrapper. Instead the
 * system saves-and-closes: the workspace rotates via the EXISTING new-project
 * flow (repos are never removed anywhere in src/ — structural gate B), a calm
 * amber beat lands in chat, a project_closed audit row is written, and the
 * show loop continues on the default overlay state (playUrl null → the PLAY IT
 * line hides, quick-ko2).
 *
 * Harness mirrors tier1-commands.e2e.test.ts: injected fakes travel the
 * IDENTICAL createApp composition path production uses.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

/** The verbatim live-incident text (audit ids 885-891). */
const INCIDENT_TEXT = "I want you to delete the whole app";

const PROJECT_CLOSED_BEAT =
  "Project saved to the gallery and closed — fresh canvas! Keep the ideas coming.";

// ── fixtures (tier1 / paid-window idioms) ────────────────────────────────────

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/** A fast happy-path runner that RECORDS every spec it consumes (spy on startBuild). */
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
  const readyHandlers: Array<() => void> = [];
  const source: DonationEventSource = {
    onTip(handler) {
      tipHandlers.push(handler);
    },
    onReady(handler) {
      readyHandlers.push(handler);
    },
    onDisconnect() {},
  };
  return {
    source,
    emitTip(tipEvent: TipEvent): void {
      for (const handler of tipHandlers) handler(tipEvent);
    },
    ready(): void {
      for (const handler of readyHandlers) handler();
    },
  };
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

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
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

/** Current durable workspace row — the rotation observable (no spy needed). */
function workspaceRow(app: AppHandle): { generation: number; scaffolded: number } {
  return app.db
    .prepare("SELECT generation, scaffolded FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number };
}

function projectClosedRows(app: AppHandle) {
  return listAuditRecords(app.db, { limit: 50, eventType: "project_closed" });
}

/** The PERSISTENT phase-banner play link on the public wire (quick-260716-ko2). */
async function fetchPlayUrl(app: AppHandle): Promise<string | null> {
  const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
  const state = (await res.json()) as { playUrl: string | null };
  return state.playUrl ?? null;
}

function seedRepoRow(app: AppHandle, generation: number, repoName: string): void {
  app.db
    .prepare(
      "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (@generation, @repoName, 1)",
    )
    .run({ generation, repoName });
}

/** Vote the pooled candidate whose text matches to victory in a manual round. */
function voteTextToVictory(app: AppHandle, text: string): string {
  app.round.startRound();
  const snap = app.round.snapshot();
  const entry = snap?.candidates.find((c) => c.candidate.text === text);
  if (!entry) throw new Error(`no pooled candidate with text ${JSON.stringify(text)}`);
  app.round.recordVote("voter-1", entry.option);
  const winnerId = entry.candidate.id;
  app.round.closeRound();
  return winnerId;
}

/** Pool 2 suggestions via chat and drive the first to a DONE build (scaffolds gen 1). */
async function driveFirstBuildDone(
  app: AppHandle,
  chat: ReturnType<typeof fakeChatSource>,
  specs: AgentRunSpec[],
): Promise<void> {
  chat.say("100", "seeder", "!suggest make a counter app");
  chat.say("101", "filler0", "!suggest seed filler idea");
  await until(() => app.pool.list().length === 2);
  voteTextToVictory(app, "make a counter app");
  await until(() => specs.length === 1 && app.machine.mode === "IDLE");
  await until(() => workspaceRow(app).scaffolded === 1);
}

function poolCandidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
  };
}

// ── 1+2+5. the incident shape (solo pick) + loop continues + control build ──

describe("save-and-close e2e: the SOLO-PICKED incident text never reaches the agent; the loop continues", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;
  let playUrlBeforeClose: string | null = null;

  beforeAll(async () => {
    // Short real-timer suggest phases drive the solo path (solo-auto-build idiom).
    restoreEnv = setEnv({ SUGGEST_PHASE_SECONDS: "0.3" });
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

    // Gen 1 becomes an ACTIVE project via the solo path: exactly one pooled
    // suggestion is built directly at the next 0.3s phase end.
    chat.say("1", "seeder", "!suggest make a counter app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE", 15_000);
    await until(() => workspaceRow(app).scaffolded === 1);

    // The active generation has a published repo → the PLAY IT line is up.
    seedRepoRow(app, 1, "counter-app");
    playUrlBeforeClose = await fetchPlayUrl(app);

    // THE INCIDENT (audit 885-891): the delete-intent suggestion is the ONLY
    // pool entry — the next phase end solo-picks it and it "wins" unopposed.
    chat.say("2", "wiper", `!suggest ${INCIDENT_TEXT}`);
    await until(() => projectClosedRows(app).length === 1, 15_000);
    await until(() => app.machine.mode === "IDLE");
  }, 30_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("Test 1: the agent runner is NEVER invoked for the wipe intent — no spec ever carries the incident text", () => {
    expect(runner.specs).toHaveLength(1); // the seeder build only
    for (const spec of runner.specs) {
      expect(spec.userPrompt).not.toContain(INCIDENT_TEXT);
    }
  });

  it("Test 1: the intercepted task LEFT the queue (nothing lingers at the head)", () => {
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("Test 1: the workspace rotated by EXACTLY one generation to a fresh (unscaffolded) canvas", () => {
    expect(workspaceRow(app)).toEqual({ generation: 2, scaffolded: 0 });
  });

  it("Test 1: a project_closed audit row exists, linked to the solo-picked winner (never silent)", () => {
    const soloRows = listAuditRecords(app.db, { limit: 50, eventType: "solo_pick" });
    const incidentPick = soloRows.find((r) => r.suggestion_text === INCIDENT_TEXT);
    expect(incidentPick).toBeDefined();

    const closed = projectClosedRows(app);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.decision).toBe("saved-and-closed");
    expect(closed[0]?.task_id).toBe(incidentPick?.task_id);
    // Server-composed rationale: generation integers only, never chat text.
    expect(closed[0]?.suggestion_text).toBeNull();
    expect(closed[0]?.rationale).toContain("generation 1");
    expect(closed[0]?.rationale).toContain("fresh generation 2");
    expect(closed[0]?.rationale).not.toContain(INCIDENT_TEXT);
  });

  it("Test 1: chat received the calm projectClosed beat (exact copy)", () => {
    expect(sent).toContain(PROJECT_CLOSED_BEAT);
  });

  it("Test 1: default overlay state after the close — playUrl flipped non-null → null (PLAY IT hidden, quick-ko2)", async () => {
    expect(playUrlBeforeClose).toBe("https://twitchvibecodes.github.io/counter-app/");
    expect(await fetchPlayUrl(app)).toBeNull();
  });

  it("Test 2: the loop CONTINUES — the next normal suggestion builds on the fresh canvas (drain continuation alive)", async () => {
    chat.say("3", "nextfan", "!suggest add a footer");
    await until(() => runner.specs.length === 2 && app.machine.mode === "IDLE", 15_000);
    expect(runner.specs[1]?.workspaceDir).toBe("/home/builder/projects/app-2");
    expect(runner.specs[1]?.userPrompt).toContain("add a footer");
  });

  it("Test 5 (control): the non-destructive seeder suggestion built exactly as before", () => {
    expect(runner.specs[0]?.workspaceDir).toBe("/home/builder/projects/app-1");
    expect(runner.specs[0]?.userPrompt).toContain("make a counter app");
  });
});

// ── 3. paid free-reign window path ───────────────────────────────────────────

describe("save-and-close e2e: a wipe-intent FREE-REIGN instruction never builds; the window survives and drains on", () => {
  const chat = fakeChatSource();
  const donation = fakeDonationSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;

  beforeAll(async () => {
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
    });
    await driveFirstBuildDone(app, chat, runner.specs);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("the in-window wipe instruction is intercepted: no agent run, rotation + audit + beat, window still live", async () => {
    donation.ready();
    donation.emitTip(tip());
    expect(app.machine.mode).toBe("FREE_REIGN_WINDOW");

    chat.say("201", "Bob", `!build ${INCIDENT_TEXT}`);
    await until(() => projectClosedRows(app).length === 1);

    // No agent run for the wipe intent (only the seeder build ever ran).
    expect(runner.specs).toHaveLength(1);
    // Rotation happened (gen 1 was scaffolded), the queue is clean.
    expect(workspaceRow(app)).toEqual({ generation: 2, scaffolded: 0 });
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(sent).toContain(PROJECT_CLOSED_BEAT);

    // driveWindowBuild's continuation is INTACT: the machine returned to
    // FREE_REIGN_WINDOW while the window is still live.
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    const snap = app.controlWindow.snapshot();
    expect(snap).not.toBeNull();
    expect((snap?.endsAtMs ?? 0) > Date.now()).toBe(true);
  });

  it("a FOLLOW-UP normal window instruction still builds (the window loop is alive)", async () => {
    chat.say("202", "Carol", "!build add a dark mode");
    await until(() => runner.specs.length === 2);
    expect(runner.specs[1]?.userPrompt).toContain("add a dark mode");
    await until(() => app.machine.mode === "FREE_REIGN_WINDOW");
    // Cleanup: the console revoke primitive closes the window.
    app.controlWindow.revoke();
    expect(app.machine.mode).toBe("IDLE");
  });
});

// ── 4. chaos path ────────────────────────────────────────────────────────────

describe("save-and-close e2e: a wipe-intent CHAOS pick never builds; the chaos loop survives", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;

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
      chaosRng: () => 0, // always the first pool entry
    });
    await driveFirstBuildDone(app, chat, runner.specs);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("the chaos-picked wipe intent is intercepted: no agent run, rotation + audit + beat, chaos re-pick continuation intact", async () => {
    // Clear the leftover filler so the wipe intent is the deterministic rng(0)
    // pick, then flip the console chaos toggle → immediate pick.
    for (const entry of app.pool.list()) app.pool.remove(entry.candidate.id);
    app.pool.add(poolCandidate("wipe-1", INCIDENT_TEXT), approved);
    app.chaos.toggle();

    await until(() => projectClosedRows(app).length === 1);
    // The pick itself is audited (true-origin record) but never built.
    const picks = listAuditRecords(app.db, { limit: 10, eventType: "chaos_pick" });
    expect(picks.some((r) => r.suggestion_text === INCIDENT_TEXT)).toBe(true);
    expect(runner.specs).toHaveLength(1); // seeder only
    expect(workspaceRow(app)).toEqual({ generation: 2, scaffolded: 0 });
    expect(sent).toContain(PROJECT_CLOSED_BEAT);

    // driveChaosBuild's continuation is INTACT: chaos is still on, so the
    // machine returned to CHAOS_MODE and re-picked (empty pool → no-op).
    await until(() => app.machine.mode === "CHAOS_MODE");
    expect(app.taskQueue.list()).toHaveLength(0);

    // Cleanup: toggle chaos off → back to IDLE.
    app.chaos.toggle();
    await until(() => app.machine.mode === "IDLE");
  });
});

// ── 6. already-fresh canvas: no rotation, but NEVER silent ───────────────────

describe("save-and-close e2e: wipe intent on an UNSCAFFOLDED canvas — no rotation, beat + audit still fire", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let winnerId = "";

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
    });

    // NOTHING has built yet — gen 1 is a fresh, unscaffolded canvas.
    chat.say("1", "wiper", `!suggest ${INCIDENT_TEXT}`);
    chat.say("2", "filler", "!suggest fresh filler idea");
    await until(() => app.pool.list().length === 2);
    winnerId = voteTextToVictory(app, INCIDENT_TEXT);
    await until(() => projectClosedRows(app).length === 1);
    await until(() => app.machine.mode === "IDLE");
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("NO rotation: the generation is unchanged (double-rotation guard) and no agent ever ran", () => {
    expect(workspaceRow(app)).toEqual({ generation: 1, scaffolded: 0 });
    expect(runner.specs).toHaveLength(0);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("the interception is STILL audited (closed === fresh generation) and narrated — never silent", () => {
    const closed = projectClosedRows(app);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.task_id).toBe(winnerId);
    expect(closed[0]?.rationale).toContain("generation 1");
    expect(closed[0]?.rationale).toContain("fresh generation 1");
    expect(sent).toContain(PROJECT_CLOSED_BEAT);
  });
});

// ── structural gates ─────────────────────────────────────────────────────────

describe("save-and-close structural gates (quick-260716-rll)", () => {
  const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

  it("GATE A: buildSession.startBuild( has EXACTLY ONE call site in src/main.ts — the dispatchBuild funnel", () => {
    const mainPath = path.join(SRC_ROOT, "main.ts");
    const stripped = stripComments(readFileSync(mainPath, "utf8"));
    const calls = stripped.match(/buildSession\.startBuild\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // All five former call sites route through the one wrapper.
    const dispatches = stripped.match(/await dispatchBuild\(/g) ?? [];
    expect(dispatches).toHaveLength(5);
  });

  it("GATE B: zero repo-removal call patterns anywhere under src/ (repos are never torn down)", () => {
    const files = collectFiles(SRC_ROOT);
    const patterns = [
      /gh\s+repo\s+delete/i,
      /-X\s*["']?DELETE/i,
      /method\s*:\s*["']DELETE["']/i,
    ];
    for (const pattern of patterns) {
      const hits = allMatches(files, pattern);
      expect(
        [...hits.entries()].map(([file, locs]) => `${file}: ${locs.join(", ")}`),
        `repo-removal pattern ${pattern} found in src/`,
      ).toEqual([]);
    }
  });
});
