import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords, listBuildHistory } from "../audit/record.js";
import { AbortRegistry } from "../kill-switch/abort.js";
import { type BuilderFeedSink, createBuilderFeed } from "../overlay/builder-feed.js";
import { TaskQueue } from "../queue/task-queue.js";
import type {
  BuildNarrator,
  BuildStatusView,
  GateResult,
  PipelineStage,
  QueuedTask,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";
import {
  type BuildSessionDeps,
  createBuildSession,
  extractApprovedContent,
  extractScreenableText,
} from "./build-session.js";
import type { Comp02Deps } from "./comp02.js";
import { BUILD_SYSTEM_PROMPT_CONTINUE, BUILD_SYSTEM_PROMPT_SCAFFOLD } from "./prompt-boundary.js";
import type {
  AgentMessage,
  AgentRunner,
  AgentRunSpec,
  BuildMachineView,
  ProgressSink,
  SandboxAdapter,
  WorkspaceView,
} from "./types.js";

/**
 * BUILD-01 + COMP-02 (in-flight, D3-07) — the build-session orchestrator drives
 * one QueuedTask STRAIGHT to the sandboxed build (quick-0iu): COMP-02 pre-build
 * re-screen (input = the suggestion text) → build → done, with EVERYTHING
 * injected: fake AgentRunner (scripted SDK-message streams), fake SandboxAdapter,
 * fake WorkspaceView, fake COMP-02 classify, fake machine/registry, real
 * TaskQueue + in-memory db. No real WSL2 / query() / network.
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

function queuedTask(id: string, text: string): QueuedTask {
  const candidate: SuggestionCandidate = {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text,
    submittedAtMs: 1_700_000_000_000,
  };
  // Tests may mint the brand (the single-funnel scan governs src/, not tests).
  return candidate as unknown as QueuedTask;
}

/** A permissive machine sliver — records transitions/active-task without the table. */
function fakeMachine(initial: StreamMode = "IDLE") {
  let mode: StreamMode = initial;
  const transitions: StreamMode[] = [];
  const activeTasks: Array<[string | null, number | null]> = [];
  const machine: BuildMachineView = {
    get mode() {
      return mode;
    },
    transition(next) {
      transitions.push(next);
      mode = next;
    },
    setActiveTask(taskId, pid) {
      activeTasks.push([taskId, pid]);
    },
  };
  return { machine, transitions, activeTasks };
}

type Script = { build?: unknown[] };

/** Fake AgentRunner: every pipeline turn is the single sandboxed build turn (quick-0iu). */
function fakeAgentRunner(script: Script) {
  const calls: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      calls.push(spec);
      const messages = script.build ?? [];
      return (async function* () {
        for (const message of messages) {
          yield message as AgentMessage;
        }
      })();
    },
  };
  return { runner, calls };
}

/** Fake AgentRunner whose build stream throws from run() itself. */
function throwingBuildRunner() {
  const calls: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      calls.push(spec);
      // run() itself throws for the build turn — the orchestrator must catch
      // it and fail closed, never letting it escape startBuild.
      throw new Error("boom: query() blew up mid-build");
    },
  };
  return { runner, calls };
}

/**
 * Fake AgentRunner whose BUILD turn yields a DIFFERENT scripted stream on each
 * successive call. Drives the auto-retry-once path: e.g. [failed] then [ok]
 * proves exactly one retry.
 */
function sequencedBuildRunner(buildSequence: unknown[][]) {
  const calls: AgentRunSpec[] = [];
  let buildIdx = 0;
  const runner: AgentRunner = {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      calls.push(spec);
      const messages = buildSequence[Math.min(buildIdx, buildSequence.length - 1)] ?? [];
      buildIdx += 1;
      return (async function* () {
        for (const message of messages) {
          yield message as AgentMessage;
        }
      })();
    },
  };
  return { runner, calls, buildTurns: () => buildIdx };
}

function fakeSandbox(): SandboxAdapter & { terminate: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as SandboxAdapter & { terminate: ReturnType<typeof vi.fn> };
}

/** Fake persistent-workspace seam (quick-0iu): mutable scaffolded flag + spies. */
function fakeWorkspace(initialScaffolded = false) {
  let scaffolded = initialScaffolded;
  let generation = 1;
  const markBuilt = vi.fn(() => {
    scaffolded = true;
  });
  const newProject = vi.fn(() => {
    generation += 1;
    scaffolded = false;
    return generation;
  });
  const workspace: WorkspaceView = {
    dir: () => `/home/builder/projects/app-${generation}`,
    scaffolded: () => scaffolded,
    markBuilt,
    newProject,
    generation: () => generation,
    activateExisting: (target: number) => {
      generation = target;
      scaffolded = true;
    },
  };
  return { workspace, markBuilt, newProject };
}

/** A BuildNarrator that records every beat (name + title) for assertions. */
function fakeNarrator(): {
  narrator: BuildNarrator;
  calls: Array<[string, string]>;
  names: string[];
} {
  const calls: Array<[string, string]> = [];
  const rec =
    (name: string) =>
    (title: string): void => {
      calls.push([name, title]);
    };
  const narrator: BuildNarrator = {
    buildPickedUp: rec("buildPickedUp"),
    stagePlanning: rec("stagePlanning"),
    stageBuilding: rec("stageBuilding"),
    buildDone: rec("buildDone"),
    buildRefused: rec("buildRefused"),
    buildRetryingOnce: rec("buildRetryingOnce"),
    buildDeciding: rec("buildDeciding"),
    buildRetryChosen: rec("buildRetryChosen"),
    buildSkipped: rec("buildSkipped"),
    comp02Rejected: rec("comp02Rejected"),
    buildHeld: rec("buildHeld"),
    buildVetoed: rec("buildVetoed"),
  };
  return {
    narrator,
    calls,
    get names(): string[] {
      return calls.map((c) => c[0]);
    },
  };
}

/** COMP-02 classify fake keyed by candidate id suffix (-plan vs -output). */
function fakeComp02(byId: (id: string) => GateResult): {
  deps: Comp02Deps;
  classify: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(async (candidate: SuggestionCandidate) => byId(candidate.id));
  return { deps: { classify }, classify };
}

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "ok" };

function capturingSink(): { sink: ProgressSink; views: BuildStatusView[] } {
  const views: BuildStatusView[] = [];
  return { sink: { push: (v) => views.push(v) }, views };
}

// SDK-ish message fixtures (plain objects fed through translate/extractors).
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
/** A reasoning-only assistant message (text blocks, zero tool_use) — quick-nhv. */
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const resultFailed = { type: "result", subtype: "error_max_turns", is_error: true };
const modelRefusal = { subtype: "model_refusal_no_fallback" };

const HAPPY_SCRIPT: Script = {
  build: [writeBatch("app.js", "console.log('hello stream')"), resultSuccess],
};

function stages(views: BuildStatusView[]): PipelineStage[] {
  return views.map((v) => v.stage);
}

function makeDeps(over: {
  task: QueuedTask;
  db: Database.Database;
  machine: BuildMachineView;
  agentRunner: AgentRunner;
  sandboxAdapter: SandboxAdapter;
  comp02: Comp02Deps;
  progress: ProgressSink;
  registry?: AbortRegistry;
  workspace?: WorkspaceView;
  onHeldForReview?: (task: QueuedTask, planText: string) => void;
  narrator?: BuildNarrator;
  builderFeed?: BuilderFeedSink;
  onBuildDone?: (task: QueuedTask) => void;
  turnTimeoutMs?: number;
}): { deps: BuildSessionDeps; taskQueue: TaskQueue } {
  const taskQueue = new TaskQueue();
  taskQueue.enqueue(over.task);
  const deps: BuildSessionDeps = {
    taskQueue,
    db: over.db,
    machine: over.machine,
    registry: over.registry ?? new AbortRegistry(),
    agentRunner: over.agentRunner,
    sandboxAdapter: over.sandboxAdapter,
    workspace: over.workspace ?? fakeWorkspace().workspace,
    comp02: over.comp02,
    progress: over.progress,
    ...(over.onHeldForReview ? { onHeldForReview: over.onHeldForReview } : {}),
    ...(over.narrator ? { narrator: over.narrator } : {}),
    ...(over.builderFeed ? { builderFeed: over.builderFeed } : {}),
    ...(over.onBuildDone ? { onBuildDone: over.onBuildDone } : {}),
    ...(over.turnTimeoutMs !== undefined ? { turnTimeoutMs: over.turnTimeoutMs } : {}),
  };
  return { deps, taskQueue };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createBuildSession — straight-to-build pipeline (BUILD-01, quick-0iu)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("drives building→done and transitions BUILD_IN_PROGRESS→IDLE — no research/plan stages", async () => {
    const { machine, transitions } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const sandbox = fakeSandbox();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-1", "make a clicker");
    const { deps, taskQueue } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox,
      comp02,
      progress: sink,
    });

    const session = createBuildSession(deps);
    await session.startBuild(task);

    expect(stages(views)).toEqual(["building", "done"]);
    expect(transitions).toEqual(["BUILD_IN_PROGRESS", "IDLE"]);
    expect(machine.mode).toBe("IDLE");
    // DEQUEUE-only: the finished task is removed from the queue.
    expect(taskQueue.list()).toHaveLength(0);
    // overlay snapshot collapses after done.
    expect(session.snapshot()).toBeNull();

    // EXACTLY ONE agent turn ran — the sandboxed build turn. Model policy is
    // structural: the spec carries NO model key at all (Fable session default).
    expect(calls).toHaveLength(1);
    const spec = calls[0];
    expect(spec?.agent).toBe("build");
    expect(spec && "model" in spec).toBe(false);
    expect(spec?.sandbox).toBeDefined();
    expect(spec?.spawnClaudeCodeProcess).toBeTypeOf("function");
    expect(spec?.workspaceDir).toBe("/home/builder/projects/app-1");
    // SAND-04: the suggestion text travels ONLY as delimited chat-sourced DATA.
    expect(spec?.userPrompt).toContain(
      '<task_description source="chat">\nmake a clicker\n</task_description>',
    );
    expect(spec?.systemPrompt).toBe(BUILD_SYSTEM_PROMPT_SCAFFOLD);
    expect(spec?.systemPrompt).not.toContain("make a clicker");
  });

  it("audits one pipeline_stage row per stage (D3-13) — building + done only", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-audit", "make a timer");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task);

    const rows = listAuditRecords(db, { limit: 50, eventType: "pipeline_stage" });
    const decisions = rows.map((r) => r.decision).sort();
    expect(decisions).toEqual(["building", "done"].sort());
  });
});

describe("createBuildSession — COMP-02 pre-build suggestion re-screen (D3-06)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("an APPROVED screen runs the build: one spec with agent 'build', no model key, workspaceDir, delimited suggestion", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02, classify } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-ok", "make a snake game");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });

    await createBuildSession(deps).startBuild(task);

    // The pre-build screen received the SUGGESTION text (there is no plan).
    const planCall = classify.mock.calls.find(([c]) => c.id.endsWith("-plan"));
    expect(planCall?.[0].text).toBe("make a snake game");
    // The fake runner received EXACTLY ONE spec — the sandboxed build turn.
    expect(calls).toHaveLength(1);
    const spec = calls[0];
    expect(spec?.agent).toBe("build");
    expect(spec && "model" in spec).toBe(false);
    expect(spec?.sandbox).toBeDefined();
    expect(spec?.workspaceDir).toBe("/home/builder/projects/app-1");
    expect(spec?.userPrompt).toContain('<task_description source="chat">');
    expect(spec?.userPrompt).toContain("make a snake game");
    expect(stages(views)).toEqual(["building", "done"]);
  });

  it("a REJECTED screen ends refused with comp02Rejected narrated and the AgentRunner NEVER invoked", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const task = queuedTask("task-2", "do something risky");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });

    await createBuildSession(deps).startBuild(task);

    // The pre-build screen rejection is the ONLY stage emit — terminal refused.
    expect(stages(views)).toEqual(["refused"]);
    // The AgentRunner was NEVER invoked (zero specs).
    expect(calls).toHaveLength(0);
    expect(narr.names).toContain("comp02Rejected");
    expect(machine.mode).toBe("IDLE");
    const comp02Rows = listAuditRecords(db, { limit: 10, eventType: "comp02_decision" });
    expect(comp02Rows[0]?.decision).toBe("rejected");
  });

  it("a HELD screen narrates buildHeld, routes (task, task.text) to the review hook, and NEVER invokes the runner", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "held-for-review", category: "gambling", rationale: "escalate" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const onHeldForReview = vi.fn();
    const task = queuedTask("task-3", "borderline idea");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
      onHeldForReview,
    });

    await createBuildSession(deps).startBuild(task);

    expect(onHeldForReview).toHaveBeenCalledTimes(1);
    expect(onHeldForReview.mock.calls[0]?.[0]).toBe(task);
    // The hook receives the SUGGESTION text (no plan exists anymore).
    expect(onHeldForReview.mock.calls[0]?.[1]).toBe("borderline idea");
    expect(narr.names).toContain("buildHeld");
    expect(stages(views)).toEqual(["refused"]);
    // The AgentRunner was NEVER invoked (zero specs).
    expect(calls).toHaveLength(0);
    expect(machine.mode).toBe("IDLE");
    const comp02Rows = listAuditRecords(db, { limit: 10, eventType: "comp02_decision" });
    expect(comp02Rows[0]?.decision).toBe("held-for-review");
  });
});

describe("createBuildSession — scaffold/continue persistent workspace (quick-0iu)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("an unscaffolded workspace gets the SCAFFOLD system prompt and a done build calls markBuilt()", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const ws = fakeWorkspace(false);
    const task = queuedTask("task-scaffold", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);

    expect(calls[0]?.systemPrompt).toBe(BUILD_SYSTEM_PROMPT_SCAFFOLD);
    expect(ws.markBuilt).toHaveBeenCalledTimes(1);
  });

  it("a scaffolded workspace gets the CONTINUE system prompt", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const ws = fakeWorkspace(true);
    const task = queuedTask("task-continue", "make the background red");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);

    expect(calls[0]?.systemPrompt).toBe(BUILD_SYSTEM_PROMPT_CONTINUE);
    // The suggestion text stays delimited DATA in continue mode too (SAND-04).
    expect(calls[0]?.userPrompt).toContain(
      '<task_description source="chat">\nmake the background red\n</task_description>',
    );
  });

  it("a FAILED build never calls markBuilt() — the next attempt scaffolds again", async () => {
    const { machine } = fakeMachine();
    const seq = sequencedBuildRunner([[resultFailed], [resultFailed]]);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const ws = fakeWorkspace(false);
    const task = queuedTask("task-nofail-flip", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: seq.runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);

    expect(ws.markBuilt).not.toHaveBeenCalled();
    // Both attempts (initial + auto-retry) stayed in scaffold mode.
    expect(seq.calls.every((c) => c.systemPrompt === BUILD_SYSTEM_PROMPT_SCAFFOLD)).toBe(true);
  });
});

describe("createBuildSession — in-flight COMP-02 output re-screen (D3-07)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("re-screens each Write/Edit output batch DURING building (spy sees the batch text)", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02, classify } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-4", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });

    await createBuildSession(deps).startBuild(task);

    // screenOutputBatch was invoked with the -output candidate carrying the
    // Write batch's own text — DURING the building stage (before done).
    const outputCall = classify.mock.calls.find(([c]) => c.id.endsWith("-output"));
    expect(outputCall).toBeDefined();
    expect(outputCall?.[0].text).toContain("console.log('hello stream')");
    expect(stages(views)).toEqual(["building", "done"]);
  });

  it("a REJECTED output batch aborts the build (abort + sandbox teardown), never reaching done", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      build: [writeBatch("evil.js", "leak the secrets"), resultSuccess],
    });
    const sandbox = fakeSandbox();
    const registry = new AbortRegistry();
    const controllerSpy = vi.spyOn(registry, "registerController");
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-output")
        ? { decision: "rejected", category: "malware", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const task = queuedTask("task-5", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      registry,
      agentRunner: runner,
      sandboxAdapter: sandbox,
      comp02,
      progress: sink,
    });

    await createBuildSession(deps).startBuild(task);

    // Never reached done; the compliance-failure stage was narrated.
    expect(stages(views)).toEqual(["building", "refused"]);
    expect(stages(views)).not.toContain("done");
    // The build's AbortController was aborted + the sandbox was torn down.
    const controller = controllerSpy.mock.calls[0]?.[1];
    expect(controller?.signal.aborted).toBe(true);
    expect(sandbox.terminate).toHaveBeenCalled();
    expect(machine.mode).toBe("IDLE");
    // Audit: the sandbox teardown row was written (BUILD-04 / D3-07).
    const teardown = listAuditRecords(db, { limit: 10, eventType: "sandbox_teardown" });
    expect(teardown).toHaveLength(1);
  });

  it("a BROKEN sandbox (throwing terminate) still finalizes to IDLE — degrades, never crashes (T-03-23)", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      build: [writeBatch("evil.js", "leak the secrets"), resultSuccess],
    });
    const sandbox = {
      spawn: vi.fn(),
      terminate: vi.fn(async () => {
        throw new Error("wsl.exe --terminate blew up");
      }),
    } as unknown as SandboxAdapter;
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-output")
        ? { decision: "rejected", category: "malware", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const task = queuedTask("task-broken", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox,
      comp02,
      progress: sink,
    });

    await expect(createBuildSession(deps).startBuild(task)).resolves.toBeUndefined();
    expect(stages(views).at(-1)).toBe("refused");
    expect(machine.mode).toBe("IDLE");
  });
});

describe("createBuildSession — fail-closed / never-throw (T-03-22)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("a model refusal maps to `refused` (D3-08), narrates, and freezes a streamer decision — never silent, never auto-IDLE", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({ build: [modelRefusal] });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const task = queuedTask("task-6", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });

    const session = createBuildSession(deps);
    await session.startBuild(task);

    // Refusal is a first-class narrated event, NOT an error, and it surfaces a
    // decision (the machine stays BUILD_IN_PROGRESS — never a silent auto-IDLE).
    expect(stages(views)).toEqual(["building", "refused"]);
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(session.snapshot()?.stage).toBe("refused");
    expect(narr.names).toContain("buildRefused");
    // Never auto-retried a refusal.
    expect(narr.names).not.toContain("buildRetryingOnce");
    const refusals = listAuditRecords(db, { limit: 10, eventType: "build_refused" });
    expect(refusals).toHaveLength(1);
    expect(listAuditRecords(db, { limit: 10, eventType: "build_retry" })).toHaveLength(0);
  });

  it("a transient build failure auto-retries EXACTLY ONCE, then freezes a retry/skip decision", async () => {
    const { machine } = fakeMachine();
    // Build turn fails on both attempts → after the single auto-retry, decide.
    const seq = sequencedBuildRunner([[resultFailed], [resultFailed]]);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const task = queuedTask("task-7", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: seq.runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });
    await createBuildSession(deps).startBuild(task);

    // Exactly two build turns ran (1 initial + 1 auto-retry) — not three.
    expect(seq.buildTurns()).toBe(2);
    expect(stages(views).at(-1)).toBe("failed");
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(narr.names).toEqual(expect.arrayContaining(["buildRetryingOnce", "buildDeciding"]));
    expect(listAuditRecords(db, { limit: 10, eventType: "build_retry" })).toHaveLength(1);
  });

  it("a transient build failure that succeeds on the auto-retry reaches done (retry recovers)", async () => {
    const { machine } = fakeMachine();
    const seq = sequencedBuildRunner([
      [resultFailed],
      [writeBatch("app.js", "console.log('ok')"), resultSuccess],
    ]);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-7b", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: seq.runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task);

    expect(seq.buildTurns()).toBe(2);
    expect(stages(views).at(-1)).toBe("done");
    expect(machine.mode).toBe("IDLE");
    expect(listAuditRecords(db, { limit: 10, eventType: "build_retry" })).toHaveLength(1);
  });

  it("a THROWN agent error resolves to `failed`, auto-retries once, then decides — never escapes startBuild", async () => {
    const { machine } = fakeMachine();
    const { runner } = throwingBuildRunner();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-8", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    // Must resolve, never reject.
    await expect(createBuildSession(deps).startBuild(task)).resolves.toBeUndefined();
    expect(stages(views).at(-1)).toBe("failed");
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
  });

  it("refuses to build while HALTED (belt-and-suspenders)", async () => {
    const { machine } = fakeMachine("HALTED");
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-9", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task);
    expect(calls).toHaveLength(0);
    expect(views).toHaveLength(0);
    expect(machine.mode).toBe("HALTED");
  });
});

describe("createBuildSession — streamer retry/skip decision (BUILD-03 / D3-09)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** Drive a build to a decision-pending `refused` freeze and return the handle. */
  async function freezeRefused(narr = fakeNarrator()) {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({ build: [modelRefusal] });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-decide", "make a page");
    const { deps, taskQueue } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });
    const session = createBuildSession(deps);
    await session.startBuild(task);
    return { session, machine, views, task, taskQueue, narr };
  }

  it("skipTask drops the frozen build, returns to IDLE, dequeues, and audits recordBuildSkip", async () => {
    const { session, machine, task, taskQueue, narr } = await freezeRefused();
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");

    session.skipTask(task.id, "gut-feeling");

    expect(machine.mode).toBe("IDLE");
    // Overlay collapses (no active build).
    expect(session.snapshot()).toBeNull();
    // DEQUEUE-only clean exit.
    expect(taskQueue.list()).toHaveLength(0);
    expect(narr.names).toContain("buildSkipped");
    const skips = listAuditRecords(db, { limit: 10, eventType: "build_skip" });
    expect(skips).toHaveLength(1);
    expect(skips[0]?.rationale).toContain("gut-feeling");
  });

  it("retryBuild re-runs the build from the suggestion text WITHOUT re-screening and can reach done", async () => {
    const { machine } = fakeMachine();
    const seq = sequencedBuildRunner([
      [modelRefusal],
      [writeBatch("app.js", "console.log('ok')"), resultSuccess],
    ]);
    const { deps: comp02, classify } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const task = queuedTask("task-retry", "make a page");
    const { deps, taskQueue } = makeDeps({
      task,
      db,
      machine,
      agentRunner: seq.runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });
    const session = createBuildSession(deps);
    await session.startBuild(task);
    // Frozen on the refusal.
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(session.snapshot()?.stage).toBe("refused");
    const preScreensBeforeRetry = classify.mock.calls.filter(([c]) =>
      c.id.endsWith("-plan"),
    ).length;

    session.retryBuild(task.id);
    // The retry re-runs the build turn asynchronously through the p-queue.
    await vi.waitFor(() => expect(machine.mode).toBe("IDLE"));

    expect(stages(views).at(-1)).toBe("done");
    expect(taskQueue.list()).toHaveLength(0);
    expect(narr.names).toContain("buildRetryChosen");
    // Retry re-runs the build WITHOUT a second pre-build screen (same as the
    // old approved-plan retry semantics).
    expect(classify.mock.calls.filter(([c]) => c.id.endsWith("-plan"))).toHaveLength(
      preScreensBeforeRetry,
    );
    // A streamer-chosen retry writes a build_retry row.
    expect(
      listAuditRecords(db, { limit: 10, eventType: "build_retry" }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("retryBuild/skipTask are no-ops for a non-matching or absent decision", async () => {
    const { session, machine } = await freezeRefused();
    session.skipTask("some-other-id");
    session.retryBuild("some-other-id");
    // Still frozen — nothing resolved the wrong task.
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(session.snapshot()?.stage).toBe("refused");
    // Now resolve properly to leave a clean machine.
    const taskId = session.snapshot()?.taskId ?? "";
    session.skipTask(taskId);
    expect(machine.mode).toBe("IDLE");
  });

  it("a COMP-02 compliance rejection NEVER auto-retries and drops straight to IDLE", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const narr = fakeNarrator();
    const task = queuedTask("task-comp", "risky idea");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      narrator: narr.narrator,
    });
    await createBuildSession(deps).startBuild(task);

    expect(stages(views).at(-1)).toBe("refused");
    expect(machine.mode).toBe("IDLE");
    expect(narr.names).toContain("comp02Rejected");
    expect(narr.names).not.toContain("buildRetryingOnce");
    expect(listAuditRecords(db, { limit: 10, eventType: "build_retry" })).toHaveLength(0);
  });
});

describe("createBuildSession — concurrency-1 (D3-04)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("serializes two builds — the second never interleaves with the first", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const t1 = queuedTask("task-a", "first");
    const t2 = queuedTask("task-b", "second");
    const taskQueue = new TaskQueue();
    taskQueue.enqueue(t1);
    taskQueue.enqueue(t2);
    const deps: BuildSessionDeps = {
      taskQueue,
      db,
      machine,
      registry: new AbortRegistry(),
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      workspace: fakeWorkspace().workspace,
      comp02,
      progress: sink,
    };
    const session = createBuildSession(deps);

    await Promise.all([session.startBuild(t1), session.startBuild(t2)]);

    // All of task-a's stages (building, done) precede all of task-b's.
    const order = views.map((v) => v.taskId);
    expect(order).toEqual(["task-a", "task-a", "task-b", "task-b"]);
    expect(machine.mode).toBe("IDLE");
  });
});

describe("createBuildSession — provenance → build_history (HIST-01, 05-01)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** A machine whose transition to BUILD_IN_PROGRESS throws — forces the outer
   *  fail-closed catch (which finalizes with stage 'failed'). */
  function throwingBuildModeMachine() {
    let mode: StreamMode = "IDLE";
    const machine: BuildMachineView = {
      get mode() {
        return mode;
      },
      transition(next) {
        if (next === "BUILD_IN_PROGRESS") throw new Error("boom: cannot enter build mode");
        mode = next;
      },
      setActiveTask() {},
    };
    return { machine };
  }

  /** A machine + a halt() that flips it to HALTED (simulating a mid-build veto). */
  function haltableMachine() {
    let mode: StreamMode = "IDLE";
    const machine: BuildMachineView = {
      get mode() {
        return mode;
      },
      transition(next) {
        mode = next;
      },
      setActiveTask() {},
    };
    return { machine, halt: () => (mode = "HALTED") };
  }

  /** A runner that flips the machine to HALTED DURING the build turn's stream
   *  (quick-0iu: the research turn no longer exists — the mid-build veto now
   *  fires from within the surviving sandboxed build stream). */
  function haltingBuildRunner(onBuild: () => void): AgentRunner {
    return {
      run(): AsyncIterable<AgentMessage> {
        const messages = HAPPY_SCRIPT.build ?? [];
        return (async function* () {
          for (const message of messages) {
            yield message as AgentMessage;
            onBuild();
          }
        })();
      },
    };
  }

  it("finalize(done) writes exactly one build_history row: result 'built', stored provenance, gate-approved title", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-1", "make a leaderboard");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "vote");

    const rows = listBuildHistory(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("built");
    expect(rows[0]?.provenance).toBe("vote");
    // title is the gate-approved QueuedTask.text ONLY (D-03).
    expect(rows[0]?.title).toBe("make a leaderboard");
    expect(rows[0]?.taskId).toBe("task-hist-1");
  });

  it("stores provenance per-startBuild — a 'donation' build records provenance 'donation'", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-2", "donor pick");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "donation");
    expect(listBuildHistory(db, { limit: 10 })[0]?.provenance).toBe("donation");
  });

  it("stores provenance per-startBuild — a 'channel_points' build records provenance 'channel_points'", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-3", "redeemer pick");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "channel_points");
    expect(listBuildHistory(db, { limit: 10 })[0]?.provenance).toBe("channel_points");
  });

  it("defaults provenance to 'vote' when startBuild is called without one (overlay.js parity)", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-4", "default pick");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task);
    expect(listBuildHistory(db, { limit: 10 })[0]?.provenance).toBe("vote");
  });

  it("maps a COMP-02 pre-build rejection to a build_history row with result 'refused'", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-5", "risky idea");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "chaos");
    const rows = listBuildHistory(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("refused");
    expect(rows[0]?.provenance).toBe("chaos");
  });

  it("maps the fail-closed catch to a build_history row with result 'failed'", async () => {
    const { machine } = throwingBuildModeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-6", "boom");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "vote");
    const rows = listBuildHistory(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("failed");
  });

  it("finalizeAborted writes ZERO build_history rows — an abort is neither success nor narrated failure (CR-01)", async () => {
    const { machine, halt } = haltableMachine();
    const runner = haltingBuildRunner(halt);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-7", "vetoed mid-build");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    await createBuildSession(deps).startBuild(task, "vote");
    // The abort path fired (a teardown row exists) but NO changelog row was
    // written — and no stage "done" was ever emitted.
    expect(machine.mode).toBe("HALTED");
    expect(listAuditRecords(db, { limit: 10, eventType: "sandbox_teardown" })).toHaveLength(1);
    expect(listBuildHistory(db, { limit: 10 })).toHaveLength(0);
  });

  it("finalize on a CLOSED ledger is a no-throw no-op (auditIfOpen guard, WR-05)", async () => {
    const { machine } = throwingBuildModeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hist-8", "shutdown drain");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });
    const session = createBuildSession(deps);
    db.close(); // simulate shutdown BEFORE the fail-closed finalize runs
    await expect(session.startBuild(task, "vote")).resolves.toBeUndefined();
  });
});

describe("createBuildSession — onBuildDone done-seam (quick-22l)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** A machine + a halt() that flips it to HALTED (simulating a mid-build veto). */
  function haltableMachine() {
    let mode: StreamMode = "IDLE";
    const machine: BuildMachineView = {
      get mode() {
        return mode;
      },
      transition(next) {
        mode = next;
      },
      setActiveTask() {},
    };
    return { machine, halt: () => (mode = "HALTED") };
  }

  /** A runner that flips the machine to HALTED DURING the build turn's stream. */
  function haltingBuildRunner(onBuild: () => void): AgentRunner {
    return {
      run(): AsyncIterable<AgentMessage> {
        const messages = HAPPY_SCRIPT.build ?? [];
        return (async function* () {
          for (const message of messages) {
            yield message as AgentMessage;
            onBuild();
          }
        })();
      },
    };
  }

  /** A runner whose stream NEVER yields — drives the WR-07 watchdog path. */
  function hangingRunner(): AgentRunner {
    return {
      run(): AsyncIterable<AgentMessage> {
        return (async function* () {
          await new Promise<never>(() => {});
          yield undefined as never;
        })();
      },
    };
  }

  function hookedDeps(over: {
    task: QueuedTask;
    machine: BuildMachineView;
    agentRunner: AgentRunner;
    comp02: Comp02Deps;
    onBuildDone: (task: QueuedTask) => void;
    turnTimeoutMs?: number;
  }) {
    const { sink } = capturingSink();
    return makeDeps({
      task: over.task,
      db,
      machine: over.machine,
      agentRunner: over.agentRunner,
      sandboxAdapter: fakeSandbox(),
      comp02: over.comp02,
      progress: sink,
      onBuildDone: over.onBuildDone,
      ...(over.turnTimeoutMs !== undefined ? { turnTimeoutMs: over.turnTimeoutMs } : {}),
    });
  }

  it("finalize(task, 'done') calls onBuildDone exactly once with the task", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-1", "make a counter");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner(HAPPY_SCRIPT).runner,
      comp02,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);

    expect(onBuildDone).toHaveBeenCalledTimes(1);
    expect(onBuildDone).toHaveBeenCalledWith(task);
  });

  it("onBuildDone absent → a done build finalizes without error (optional dep)", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const task = queuedTask("task-hook-2", "make a counter");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: fakeAgentRunner(HAPPY_SCRIPT).runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
    });

    await expect(createBuildSession(deps).startBuild(task)).resolves.toBeUndefined();
    expect(machine.mode).toBe("IDLE");
  });

  it("NOT called on a failed build (enterDecision after auto-retry exhausts)", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-3", "boom");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner({ build: [resultFailed] }).runner,
      comp02,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);
    expect(machine.mode).toBe("BUILD_IN_PROGRESS"); // decision pending
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("NOT called on a model refusal (enterDecision 'refused')", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-4", "nope");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner({ build: [modelRefusal] }).runner,
      comp02,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("NOT called on an in-flight COMP-02 rejection (finalize 'refused')", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-output")
        ? { decision: "rejected", category: "malware", rationale: "no" }
        : APPROVED,
    );
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-5", "make a page");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner({ build: [writeBatch("evil.js", "leak"), resultSuccess] })
        .runner,
      comp02,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);
    expect(machine.mode).toBe("IDLE"); // finalize("refused") ran
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("NOT called on a WR-07 watchdog timeout (hung stream → decision pending)", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-6", "hang forever");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: hangingRunner(),
      comp02,
      onBuildDone,
      turnTimeoutMs: 20,
    });

    await createBuildSession(deps).startBuild(task);
    expect(machine.mode).toBe("BUILD_IN_PROGRESS"); // decision pending
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("NOT called on finalizeAborted (halt/veto mid-build)", async () => {
    const { machine, halt } = haltableMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-7", "vetoed mid-build");
    const { deps } = hookedDeps({
      task,
      machine,
      agentRunner: haltingBuildRunner(halt),
      comp02,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);
    expect(machine.mode).toBe("HALTED");
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("NOT called on skipTask (streamer skips a refused build)", async () => {
    const { machine } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn();
    const task = queuedTask("task-hook-8", "skip me");
    const { deps, taskQueue } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner({ build: [modelRefusal] }).runner,
      comp02,
      onBuildDone,
    });

    const session = createBuildSession(deps);
    await session.startBuild(task);
    session.skipTask(task.id);

    expect(machine.mode).toBe("IDLE");
    expect(taskQueue.list()).toHaveLength(0);
    expect(onBuildDone).not.toHaveBeenCalled();
  });

  it("a THROWING onBuildDone never breaks finalize: IDLE reached, task dequeued, build_history row lands", async () => {
    const { machine, transitions } = fakeMachine();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const onBuildDone = vi.fn(() => {
      throw new Error("publisher hook blew up");
    });
    const task = queuedTask("task-hook-9", "make a counter");
    const { deps, taskQueue } = hookedDeps({
      task,
      machine,
      agentRunner: fakeAgentRunner(HAPPY_SCRIPT).runner,
      comp02,
      onBuildDone,
    });

    await expect(createBuildSession(deps).startBuild(task, "vote")).resolves.toBeUndefined();

    expect(onBuildDone).toHaveBeenCalledTimes(1);
    expect(machine.mode).toBe("IDLE");
    expect(transitions).toContain("IDLE");
    expect(taskQueue.list()).toHaveLength(0);
    const rows = listBuildHistory(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("built");
  });
});

describe("createBuildSession — /builder feed taps (quick-x7d)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("(a) STRUCTURAL GATE: a COMP-02-rejected batch contributes ZERO feed bytes — path and content absent from the serialized wire", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      build: [writeBatch("sandbox/evil.txt", "FORBIDDEN-PAYLOAD"), resultSuccess],
    });
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-output")
        ? { decision: "rejected", category: "malware", rationale: "no" }
        : APPROVED,
    );
    const { sink } = capturingSink();
    const feed = createBuilderFeed();
    const task = queuedTask("task-feed-a", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    // The rejected batch's path + content are unreachable on the wire by
    // control flow — assert on the SERIALIZED shape, the exact bytes ws sends.
    const wire = JSON.stringify(feed.list());
    expect(wire).not.toContain("evil.txt");
    expect(wire).not.toContain("FORBIDDEN-PAYLOAD");
    // The narrated compliance-failure path still lands its amber caption.
    expect(feed.list().at(-1)).toEqual({ kind: "stage-warn", text: "Skipping this one" });
  });

  it("(a2) STRUCTURAL GATE (reasoning): a COMP-02-rejected reasoning-only message contributes ZERO wire bytes", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      build: [assistantText("FORBIDDEN-REASONING"), resultSuccess],
    });
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-output")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const feed = createBuilderFeed();
    const task = queuedTask("task-feed-a2", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    // The rejected reasoning text never reaches the serialized wire — same
    // control-flow gate as a rejected Write batch (T-nhv-01).
    const wire = JSON.stringify(feed.list());
    expect(wire).not.toContain("FORBIDDEN-REASONING");
    // The build aborted down the existing compliance-rejected path.
    expect(stages(views).at(-1)).toBe("refused");
    expect(feed.list().at(-1)).toEqual({ kind: "stage-warn", text: "Skipping this one" });
  });

  it("(b) an APPROVED Write batch lands 'Writing <path>' plus the FULL diff (old 200-char snippet cap is gone)", async () => {
    const { machine } = fakeMachine();
    // >200 chars and >3 lines — would have been truncated by the old snippet cap.
    const fullContent = Array.from(
      { length: 8 },
      (_, i) => `const line${i} = "${"x".repeat(40)}";`,
    ).join("\n");
    expect(fullContent.length).toBeGreaterThan(200);
    const { runner } = fakeAgentRunner({
      build: [writeBatch("sandbox/app.js", fullContent), resultSuccess],
    });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const feed = createBuilderFeed();
    const task = queuedTask("task-feed-b", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    const lines = feed.list();
    expect(lines).toContainEqual({ kind: "activity", text: "Writing sandbox/app.js" });
    // FULL fidelity: the diff carries every byte of the approved content.
    expect(lines).toContainEqual({ kind: "diff", text: fullContent });
    // The full happy-path shape around it: title → building beat → done caption.
    expect(lines[0]).toEqual({ kind: "title", text: "NOW BUILDING: make a page" });
    expect(lines.at(-1)).toEqual({ kind: "stage", text: "Live on screen now" });
  });

  it("(c) closed-vocabulary wire: raw SDK tokens never cross; MultiEdit reads 'Editing <path>'; Bash lands as a tool-call", async () => {
    const { machine } = fakeMachine();
    const mixedBatch = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "MultiEdit",
            input: {
              file_path: "styles.css",
              edits: [{ old_string: "a", new_string: "body { color: blue }" }],
            },
          },
          { type: "tool_use", name: "Bash", input: { command: "npm install" } },
        ],
      },
    };
    const { runner } = fakeAgentRunner({
      build: [mixedBatch, resultSuccess],
    });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const feed = createBuilderFeed();
    const task = queuedTask("task-feed-c", "style the page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    const lines = feed.list();
    // Edit-family tools still map to the fixed verb — never the raw tool name.
    expect(lines).toContainEqual({ kind: "activity", text: "Editing styles.css" });
    // A non-write tool_use lands as a screened tool-call line (name + primary arg).
    expect(lines).toContainEqual({ kind: "tool-call", text: "Bash(npm install)" });
    const wire = JSON.stringify(lines);
    for (const forbidden of [
      "tool_use",
      "file_path",
      "new_string",
      "MultiEdit",
      "NotebookEdit",
      "input",
    ]) {
      expect(wire, `raw token "${forbidden}" must never reach the feed wire`).not.toContain(
        forbidden,
      );
    }
  });

  it("screening ORDER: classify resolves BEFORE the feed receives the content, and reasoning-only triggers exactly one -output screen", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      build: [assistantText("I will add the button now"), resultSuccess],
    });
    const order: string[] = [];
    const classify = vi.fn(async (candidate: SuggestionCandidate) => {
      if (candidate.id.endsWith("-output")) order.push("screen");
      return APPROVED;
    });
    const { sink } = capturingSink();
    const inner = createBuilderFeed();
    // A wrapped feed records when the sink receives content (post-guard call).
    const feed: BuilderFeedSink = {
      buildStarted: (title) => inner.buildStarted(title),
      stage: (stage) => inner.stage(stage),
      contentApproved: (items) => {
        if (items.length > 0) order.push("feed");
        inner.contentApproved(items);
      },
    };
    const task = queuedTask("task-feed-order", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02: { classify },
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    // classify (the screen) strictly precedes the feed tap — the structural gate.
    expect(order).toEqual(["screen", "feed"]);
    // A reasoning-only message triggered exactly ONE in-flight -output screen.
    const outputScreens = classify.mock.calls.filter(([c]) => c.id.endsWith("-output"));
    expect(outputScreens).toHaveLength(1);
    expect(outputScreens[0]?.[0].text).toContain("I will add the button now");
    // The approved reasoning reached the wire.
    expect(inner.list()).toContainEqual({ kind: "reasoning", text: "I will add the button now" });
  });

  it("screened SUPERSET (T-nhv-07): every displayed byte appeared verbatim in the classify() input", async () => {
    const { machine } = fakeMachine();
    const mixedMessage = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Wiring the click handler next" },
          { type: "tool_use", name: "Bash", input: { command: "npm install canvas-confetti" } },
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "src/button.js", content: "export const clicks = 0;" },
          },
        ],
      },
    };
    const { runner } = fakeAgentRunner({ build: [mixedMessage, resultSuccess] });
    const screened: string[] = [];
    const classify = vi.fn(async (candidate: SuggestionCandidate) => {
      if (candidate.id.endsWith("-output")) screened.push(candidate.text);
      return APPROVED;
    });
    const { sink } = capturingSink();
    const captured: Array<
      | { type: "reasoning"; text: string }
      | { type: "tool-call"; tool: string; arg: string }
      | { type: "file-change"; verb: "Writing" | "Editing"; path: string; text: string }
    > = [];
    const inner = createBuilderFeed();
    const feed: BuilderFeedSink = {
      buildStarted: (title) => inner.buildStarted(title),
      stage: (stage) => inner.stage(stage),
      contentApproved: (items) => {
        captured.push(...items);
        inner.contentApproved(items);
      },
    };
    const task = queuedTask("task-feed-superset", "confetti button");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02: { classify },
      progress: sink,
      builderFeed: feed,
    });

    await createBuildSession(deps).startBuild(task);

    const screenedText = screened.join("\n");
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const item of captured) {
      if (item.type === "reasoning") {
        expect(screenedText).toContain(item.text);
      } else if (item.type === "tool-call") {
        // The shared primaryArg helper guarantees: displayed arg ⊆ screened text.
        expect(screenedText).toContain(item.tool);
        expect(screenedText).toContain(item.arg);
      } else {
        expect(screenedText).toContain(item.path);
        expect(screenedText).toContain(item.text);
      }
    }
  });

  it("(d) abort semantics: no 'Live on screen now' ever; lines freeze, then the NEXT build clears them", async () => {
    // Halt DURING the first build's sandboxed build turn (the finalizeAborted
    // pattern), then run a clean second build to prove clear-on-next-start.
    let mode: StreamMode = "IDLE";
    const machine: BuildMachineView = {
      get mode() {
        return mode;
      },
      transition(next) {
        mode = next;
      },
      setActiveTask() {},
    };
    let halted = false;
    const runner: AgentRunner = {
      run(): AsyncIterable<AgentMessage> {
        const messages = HAPPY_SCRIPT.build ?? [];
        return (async function* () {
          for (const message of messages) {
            yield message as AgentMessage;
            if (!halted) {
              halted = true;
              mode = "HALTED"; // streamer veto mid-build (first build only)
            }
          }
        })();
      },
    };
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const feed = createBuilderFeed();
    const task1 = queuedTask("task-feed-d1", "vetoed build");
    const { deps } = makeDeps({
      task: task1,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      builderFeed: feed,
    });
    const session = createBuildSession(deps);
    await session.startBuild(task1);

    // The aborted build's feed just STOPPED: frozen lines, no false BUILT IT.
    expect(mode).toBe("HALTED");
    const frozen = feed.list();
    expect(frozen.length).toBeGreaterThanOrEqual(2); // title + building beat
    expect(frozen[0]).toEqual({ kind: "title", text: "NOW BUILDING: vetoed build" });
    expect(JSON.stringify(frozen)).not.toContain("Live on screen now");

    // The NEXT build clears the killed build's lines (T-x7d-05).
    mode = "IDLE"; // streamer recovered from the halt
    const task2 = queuedTask("task-feed-d2", "fresh build");
    deps.taskQueue.enqueue(task2);
    await session.startBuild(task2);
    const next = feed.list();
    expect(next[0]).toEqual({ kind: "title", text: "NOW BUILDING: fresh build" });
    expect(JSON.stringify(next)).not.toContain("vetoed build");
  });
});

describe("createBuildSession — distro workspace lifecycle (BL-01 / HI-01 / HI-03)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** A sandbox fake that ALSO implements the new optional ensure/probe methods. */
  function fakeSandboxWithDir(over?: {
    ensureWorkspaceDir?: (dir: string) => Promise<void>;
    workspaceHasFiles?: (dir: string) => Promise<boolean>;
  }) {
    const ensureWorkspaceDir = vi.fn(over?.ensureWorkspaceDir ?? (async () => {}));
    const spawn = vi.fn();
    const terminate = vi.fn(async () => {});
    const adapter = {
      spawn,
      terminate,
      ensureWorkspaceDir,
      ...(over?.workspaceHasFiles ? { workspaceHasFiles: vi.fn(over.workspaceHasFiles) } : {}),
    } as unknown as SandboxAdapter;
    return { adapter, ensureWorkspaceDir, spawn };
  }

  /** A runner that yields each message after a fixed delay (models steady progress). */
  function intervalRunner(messages: unknown[], delayMs: number): AgentRunner {
    return {
      run(): AsyncIterable<AgentMessage> {
        return (async function* () {
          for (const message of messages) {
            await new Promise((r) => setTimeout(r, delayMs));
            yield message as AgentMessage;
          }
        })();
      },
    };
  }

  /** A runner whose stream NEVER yields — a genuinely stalled (silent) stream. */
  function silentRunner(): AgentRunner {
    return {
      run(): AsyncIterable<AgentMessage> {
        return (async function* () {
          await new Promise<never>(() => {});
          yield undefined as never;
        })();
      },
    };
  }

  it("(BL-01) a rejecting ensureWorkspaceDir fails the build CLOSED: failed decision, NO spawn/agent turn/publish", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const narr = fakeNarrator();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const onBuildDone = vi.fn();
    const sandbox = fakeSandboxWithDir({
      ensureWorkspaceDir: async () => {
        throw new Error("mkdir -p failed: read-only distro");
      },
    });
    const task = queuedTask("task-bl01", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      narrator: narr.narrator,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);

    expect(sandbox.ensureWorkspaceDir).toHaveBeenCalledWith("/home/builder/projects/app-1");
    // Failed CLOSED: the agent turn NEVER ran — no spawn, no publish, no shared dir.
    expect(calls).toHaveLength(0);
    expect(onBuildDone).not.toHaveBeenCalled();
    // Same route as the watchdog: narrated deciding + a frozen `failed` decision.
    expect(stages(views)).toEqual(["building", "failed"]);
    expect(machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(narr.names).toContain("buildDeciding");
    const teardown = listAuditRecords(db, { limit: 10, eventType: "sandbox_teardown" });
    expect(teardown).toHaveLength(1);
    expect(teardown[0]?.rationale).toContain("BL-01");
  });

  it("(BL-01) ensureWorkspaceDir is awaited BEFORE the agent runner's first turn", async () => {
    const { machine } = fakeMachine();
    const order: string[] = [];
    const runner: AgentRunner = {
      run(): AsyncIterable<AgentMessage> {
        order.push("run");
        return (async function* () {
          for (const m of HAPPY_SCRIPT.build ?? []) yield m as AgentMessage;
        })();
      },
    };
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const sandbox = fakeSandboxWithDir({
      ensureWorkspaceDir: async () => {
        order.push("ensure");
      },
    });
    const task = queuedTask("task-bl01-order", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
    });

    await createBuildSession(deps).startBuild(task);
    expect(order[0]).toBe("ensure");
    expect(order).toContain("run");
    expect(order.indexOf("ensure")).toBeLessThan(order.indexOf("run"));
  });

  it("(HI-01) workspaceHasFiles=true with scaffolded()=false yields CONTINUE mode (never scaffold over debris)", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const ws = fakeWorkspace(false);
    const sandbox = fakeSandboxWithDir({ workspaceHasFiles: async () => true });
    const task = queuedTask("task-hi01-continue", "add a button");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);
    expect(calls[0]?.systemPrompt).toBe(BUILD_SYSTEM_PROMPT_CONTINUE);
  });

  it("(HI-01) scaffolded()=false + an EMPTY dir yields SCAFFOLD mode", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink } = capturingSink();
    const ws = fakeWorkspace(false);
    const sandbox = fakeSandboxWithDir({ workspaceHasFiles: async () => false });
    const task = queuedTask("task-hi01-scaffold", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);
    expect(calls[0]?.systemPrompt).toBe(BUILD_SYSTEM_PROMPT_SCAFFOLD);
  });

  it("(HI-03) a steadily-yielding build past turnTimeoutMs is NOT killed — the stall timer re-arms on activity", async () => {
    const { machine } = fakeMachine();
    // 4 messages, 12ms apart → ~48ms total, well past the 30ms bound; but each
    // gap (12ms) is under it, so a re-arming stall timer never fires. A one-shot
    // timer would have aborted at 30ms.
    const runner = intervalRunner(
      [writeBatch("a.js", "x"), writeBatch("b.js", "y"), writeBatch("c.js", "z"), resultSuccess],
      12,
    );
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const sandbox = fakeSandboxWithDir();
    const task = queuedTask("task-hi03-healthy", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      turnTimeoutMs: 30,
    });

    await createBuildSession(deps).startBuild(task);
    expect(stages(views).at(-1)).toBe("done");
    expect(machine.mode).toBe("IDLE");
  });

  it("(HI-03) a silent (no-activity) stream trips the stall watchdog → narrated failed decision, no destructive reset", async () => {
    const { machine } = fakeMachine();
    const narr = fakeNarrator();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const sandbox = fakeSandboxWithDir();
    const ws = fakeWorkspace(false);
    const task = queuedTask("task-hi03-stall", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: silentRunner(),
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      narrator: narr.narrator,
      workspace: ws.workspace,
      turnTimeoutMs: 20,
    });

    await createBuildSession(deps).startBuild(task);
    expect(stages(views).at(-1)).toBe("failed");
    expect(machine.mode).toBe("BUILD_IN_PROGRESS"); // decision pending, not IDLE
    expect(narr.names).toContain("buildDeciding");
    // Non-destructive: the stall path never rotates/resets the workspace.
    expect(ws.newProject).not.toHaveBeenCalled();
  });
});

describe("createBuildSession — EMPTY-01 done-guard (no phantom done for an empty workspace)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** Sandbox fake with a scripted committable-files probe. */
  function fakeSandboxWithProbe(results: Array<boolean | Error>) {
    let i = 0;
    const workspaceHasCommittableFiles = vi.fn(async () => {
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r ?? true;
    });
    const adapter = {
      spawn: vi.fn(),
      terminate: vi.fn(async () => {}),
      workspaceHasCommittableFiles,
    } as unknown as SandboxAdapter;
    return { adapter, workspaceHasCommittableFiles };
  }

  it("ok turn + EMPTY workspace → auto-retry once, then a narrated failed decision; NEVER done/markBuilt/onBuildDone", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const narr = fakeNarrator();
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const onBuildDone = vi.fn();
    const ws = fakeWorkspace(false);
    const sandbox = fakeSandboxWithProbe([false]);
    const task = queuedTask("task-empty01", "make a page");
    const { deps, taskQueue } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      narrator: narr.narrator,
      onBuildDone,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);

    // Two build attempts ran (auto-retry once), then the decision froze.
    expect(calls).toHaveLength(2);
    expect(stages(views).at(-1)).toBe("failed");
    expect(stages(views)).not.toContain("done");
    expect(machine.mode).toBe("BUILD_IN_PROGRESS"); // decision pending
    expect(onBuildDone).not.toHaveBeenCalled();
    expect(ws.markBuilt).not.toHaveBeenCalled();
    expect(taskQueue.list()).toHaveLength(1); // still queued for retry/skip
    expect(narr.names).toContain("buildRetryingOnce");
    expect(narr.names).toContain("buildDeciding");
    const retries = listAuditRecords(db, { limit: 10, eventType: "build_retry" });
    expect(retries).toHaveLength(1);
    expect(retries[0]?.rationale).toContain("EMPTY-01");
  });

  it("empty on the first attempt, output on the retry → done finalizes normally", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const onBuildDone = vi.fn();
    const ws = fakeWorkspace(false);
    const sandbox = fakeSandboxWithProbe([false, true]);
    const task = queuedTask("task-empty01-recover", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      onBuildDone,
      workspace: ws.workspace,
    });

    await createBuildSession(deps).startBuild(task);

    expect(stages(views).at(-1)).toBe("done");
    expect(machine.mode).toBe("IDLE");
    expect(onBuildDone).toHaveBeenCalledTimes(1);
    expect(ws.markBuilt).toHaveBeenCalledTimes(1);
  });

  it("a THROWING probe fails toward done — a flaky probe never fails a good live build", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const onBuildDone = vi.fn();
    const sandbox = fakeSandboxWithProbe([new Error("wsl probe hiccup")]);
    const task = queuedTask("task-empty01-flaky", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: sandbox.adapter,
      comp02,
      progress: sink,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);

    expect(stages(views).at(-1)).toBe("done");
    expect(onBuildDone).toHaveBeenCalledTimes(1);
  });

  it("adapter WITHOUT the probe (legacy fakes) → guard skipped, done finalizes as before", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const onBuildDone = vi.fn();
    const task = queuedTask("task-empty01-legacy", "make a page");
    const { deps } = makeDeps({
      task,
      db,
      machine,
      agentRunner: runner,
      sandboxAdapter: fakeSandbox(),
      comp02,
      progress: sink,
      onBuildDone,
    });

    await createBuildSession(deps).startBuild(task);

    expect(stages(views).at(-1)).toBe("done");
    expect(onBuildDone).toHaveBeenCalledTimes(1);
  });
});

describe("extractScreenableText / extractApprovedContent — containment-boundary narrowers (quick-nhv)", () => {
  const toolUseMessage = (blocks: unknown[]) => ({
    type: "assistant",
    message: { content: blocks },
  });

  it("extractScreenableText includes the WR-02 NotebookEdit keys (notebook_path + new_source)", () => {
    const msg = toolUseMessage([
      {
        type: "tool_use",
        name: "NotebookEdit",
        input: { notebook_path: "analysis.ipynb", new_source: "print('cells')" },
      },
    ]);
    const screened = extractScreenableText(msg);
    expect(screened).toContain("analysis.ipynb");
    expect(screened).toContain("print('cells')");
  });

  it("extractScreenableText includes ALL edits[].new_string, not just the first", () => {
    const msg = toolUseMessage([
      {
        type: "tool_use",
        name: "MultiEdit",
        input: {
          file_path: "app.js",
          edits: [
            { old_string: "a", new_string: "FIRST-EDIT" },
            { old_string: "b", new_string: "SECOND-EDIT" },
          ],
        },
      },
    ]);
    const screened = extractScreenableText(msg);
    expect(screened).toContain("FIRST-EDIT");
    expect(screened).toContain("SECOND-EDIT");
  });

  it("extractScreenableText returns null for non-screenable messages (result frames, empty content)", () => {
    expect(extractScreenableText({ type: "result", subtype: "success" })).toBeNull();
    expect(extractScreenableText(toolUseMessage([]))).toBeNull();
    expect(extractScreenableText(null)).toBeNull();
  });

  it("extractApprovedContent joins ALL MultiEdit new_strings with \\n (full-fidelity diff)", () => {
    const items = extractApprovedContent(
      toolUseMessage([
        {
          type: "tool_use",
          name: "MultiEdit",
          input: {
            file_path: "app.js",
            edits: [
              { old_string: "a", new_string: "FIRST-EDIT" },
              { old_string: "b", new_string: "SECOND-EDIT" },
            ],
          },
        },
      ]),
    );
    expect(items).toEqual([
      { type: "file-change", verb: "Editing", path: "app.js", text: "FIRST-EDIT\nSECOND-EDIT" },
    ]);
  });

  it("extractApprovedContent maps NotebookEdit to an Editing file-change with the notebook keys", () => {
    const items = extractApprovedContent(
      toolUseMessage([
        {
          type: "tool_use",
          name: "NotebookEdit",
          input: { notebook_path: "analysis.ipynb", new_source: "print('cells')" },
        },
      ]),
    );
    expect(items).toEqual([
      {
        type: "file-change",
        verb: "Editing",
        path: "analysis.ipynb",
        text: "print('cells')",
      },
    ]);
  });

  it("extractApprovedContent SKIPS a write block with no string path entirely (fail closed)", () => {
    const items = extractApprovedContent(
      toolUseMessage([
        { type: "tool_use", name: "Write", input: { content: "orphan content, no path" } },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]),
    );
    // The pathless Write vanished; the Bash tool-call survived.
    expect(items).toEqual([{ type: "tool-call", tool: "Bash", arg: "ls" }]);
  });
});

describe("createBuildSession — source discipline (single funnel)", () => {
  it("references no .enqueue / toQueuedTask / submitCandidate", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./build-session.ts", import.meta.url)), "utf8");
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/\.enqueue\(/);
    expect(stripped).not.toMatch(/toQueuedTask/);
    expect(stripped).not.toMatch(/submitCandidate/);
  });
});
