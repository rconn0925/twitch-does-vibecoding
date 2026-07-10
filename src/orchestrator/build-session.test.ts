import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { AbortRegistry } from "../kill-switch/abort.js";
import { TaskQueue } from "../queue/task-queue.js";
import type {
  BuildStatusView,
  GateResult,
  PipelineStage,
  QueuedTask,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";
import { type BuildSessionDeps, createBuildSession } from "./build-session.js";
import type { Comp02Deps } from "./comp02.js";
import type {
  AgentMessage,
  AgentRunner,
  AgentRunSpec,
  BuildMachineView,
  ProgressSink,
  SandboxAdapter,
} from "./types.js";

/**
 * BUILD-01 + COMP-02 (in-flight, D3-07) — the build-session orchestrator drives
 * one QueuedTask through research→plan→COMP-02→build→done with EVERYTHING
 * injected: fake AgentRunner (scripted SDK-message streams), fake SandboxAdapter,
 * fake COMP-02 classify, fake machine/registry, real TaskQueue + in-memory db.
 * No real WSL2 / query() / network.
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

type Script = { research?: unknown[]; plan?: unknown[]; build?: unknown[] };

/** Fake AgentRunner: research vs plan vs (sandboxed) build streams by spec shape. */
function fakeAgentRunner(script: Script) {
  const calls: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      calls.push(spec);
      const kind = spec.agent === "research" ? "research" : spec.sandbox ? "build" : "plan";
      const messages = script[kind] ?? [];
      return (async function* () {
        for (const message of messages) {
          yield message as AgentMessage;
        }
      })();
    },
  };
  return { runner, calls };
}

/** Fake AgentRunner whose build stream throws mid-turn. */
function throwingBuildRunner(script: Script) {
  const calls: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      calls.push(spec);
      const kind = spec.agent === "research" ? "research" : spec.sandbox ? "build" : "plan";
      if (kind === "build") {
        // run() itself throws for the build turn — the orchestrator must catch
        // it and fail closed, never letting it escape startBuild.
        throw new Error("boom: query() blew up mid-build");
      }
      const messages = script[kind] ?? [];
      return (async function* () {
        for (const message of messages) {
          yield message as AgentMessage;
        }
      })();
    },
  };
  return { runner, calls };
}

function fakeSandbox(): SandboxAdapter & { terminate: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as SandboxAdapter & { terminate: ReturnType<typeof vi.fn> };
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
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const resultFailed = { type: "result", subtype: "error_max_turns", is_error: true };
const modelRefusal = { subtype: "model_refusal_no_fallback" };

const HAPPY_SCRIPT: Script = {
  research: [assistantText("research notes about the feature"), resultSuccess],
  plan: [assistantText("1. build a page\n2. wire a button"), resultSuccess],
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
  onHeldForReview?: (task: QueuedTask, planText: string) => void;
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
    comp02: over.comp02,
    progress: over.progress,
    ...(over.onHeldForReview ? { onHeldForReview: over.onHeldForReview } : {}),
  };
  return { deps, taskQueue };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createBuildSession — full pipeline (BUILD-01)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("drives researching→planning→building→done and transitions BUILD_IN_PROGRESS→IDLE", async () => {
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

    expect(stages(views)).toEqual(["researching", "planning", "building", "done"]);
    expect(transitions).toEqual(["BUILD_IN_PROGRESS", "IDLE"]);
    expect(machine.mode).toBe("IDLE");
    // DEQUEUE-only: the finished task is removed from the queue.
    expect(taskQueue.list()).toHaveLength(0);
    // overlay snapshot collapses after done.
    expect(session.snapshot()).toBeNull();

    // Model policy: research = Sonnet; plan + build = Fable (model undefined);
    // ONLY the build turn is sandboxed.
    const research = calls.find((c) => c.agent === "research");
    const buildCall = calls.find((c) => c.agent === "build" && c.sandbox);
    const planCall = calls.find((c) => c.agent === "build" && !c.sandbox);
    expect(research?.model).toBe("sonnet");
    expect(planCall?.model).toBeUndefined();
    expect(buildCall?.model).toBeUndefined();
    expect(buildCall?.spawnClaudeCodeProcess).toBeTypeOf("function");
    expect(research?.sandbox).toBeUndefined();
  });

  it("audits one pipeline_stage row per stage (D3-13)", async () => {
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
    expect(decisions).toEqual(["building", "done", "planning", "researching"].sort());
  });
});

describe("createBuildSession — COMP-02 pre-write re-screen (D3-06)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("a REJECTED plan aborts before the build query() runs and returns to IDLE", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
    const task = queuedTask("task-2", "do something risky");
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

    expect(stages(views)).toEqual(["researching", "planning", "refused"]);
    // No build turn ran (no sandboxed agent call).
    expect(calls.some((c) => c.agent === "build" && c.sandbox)).toBe(false);
    expect(machine.mode).toBe("IDLE");
    const comp02Rows = listAuditRecords(db, { limit: 10, eventType: "comp02_decision" });
    expect(comp02Rows[0]?.decision).toBe("rejected");
  });

  it("a HELD plan routes to the review hook and never builds", async () => {
    const { machine } = fakeMachine();
    const { runner, calls } = fakeAgentRunner(HAPPY_SCRIPT);
    const { deps: comp02 } = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "held-for-review", category: "self-harm", rationale: "escalate" }
        : APPROVED,
    );
    const { sink, views } = capturingSink();
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
      onHeldForReview,
    });

    await createBuildSession(deps).startBuild(task);

    expect(onHeldForReview).toHaveBeenCalledTimes(1);
    expect(onHeldForReview.mock.calls[0]?.[0]).toBe(task);
    expect(stages(views)).toEqual(["researching", "planning", "refused"]);
    expect(calls.some((c) => c.agent === "build" && c.sandbox)).toBe(false);
    expect(machine.mode).toBe("IDLE");
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
    expect(stages(views)).toEqual(["researching", "planning", "building", "done"]);
  });

  it("a REJECTED output batch aborts the build (abort + sandbox teardown), never reaching done", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({
      ...HAPPY_SCRIPT,
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
    expect(stages(views)).toEqual(["researching", "planning", "building", "refused"]);
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
});

describe("createBuildSession — fail-closed / never-throw (T-03-22)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("a model refusal maps to `refused` and returns to IDLE", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({ ...HAPPY_SCRIPT, build: [modelRefusal] });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-6", "make a page");
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
    expect(stages(views).at(-1)).toBe("refused");
    expect(machine.mode).toBe("IDLE");
    const refusals = listAuditRecords(db, { limit: 10, eventType: "build_refused" });
    expect(refusals).toHaveLength(1);
  });

  it("a build turn that emits a failure result maps to `failed`", async () => {
    const { machine } = fakeMachine();
    const { runner } = fakeAgentRunner({ ...HAPPY_SCRIPT, build: [resultFailed] });
    const { deps: comp02 } = fakeComp02(() => APPROVED);
    const { sink, views } = capturingSink();
    const task = queuedTask("task-7", "make a page");
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
    expect(stages(views).at(-1)).toBe("failed");
    expect(machine.mode).toBe("IDLE");
  });

  it("a THROWN agent error resolves to `failed` and never escapes startBuild", async () => {
    const { machine } = fakeMachine();
    const { runner } = throwingBuildRunner(HAPPY_SCRIPT);
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
    expect(machine.mode).toBe("IDLE");
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
      comp02,
      progress: sink,
    };
    const session = createBuildSession(deps);

    await Promise.all([session.startBuild(t1), session.startBuild(t2)]);

    // All of task-a's stages precede all of task-b's (no interleave).
    const order = views.map((v) => v.taskId);
    expect(order).toEqual([
      "task-a",
      "task-a",
      "task-a",
      "task-a",
      "task-b",
      "task-b",
      "task-b",
      "task-b",
    ]);
    expect(machine.mode).toBe("IDLE");
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
