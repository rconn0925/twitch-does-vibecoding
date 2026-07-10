import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/audit/db.js";
import { listAuditRecords } from "../../src/audit/record.js";
import {
  type HistoryPage,
  type HistoryServerHandle,
  startHistoryServer,
} from "../../src/history/server.js";
import { AbortRegistry } from "../../src/kill-switch/abort.js";
import { type BuildSessionDeps, createBuildSession } from "../../src/orchestrator/build-session.js";
import type { Comp02Deps } from "../../src/orchestrator/comp02.js";
import type {
  AgentMessage,
  AgentRunner,
  AgentRunSpec,
  BuildMachineView,
  ProgressSink,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import { TaskQueue } from "../../src/queue/task-queue.js";
import type {
  BuildProvenance,
  GateResult,
  QueuedTask,
  StreamMode,
  SuggestionCandidate,
} from "../../src/shared/types.js";

/**
 * End-to-end vertical slice (HIST-01 / 05-02): a build completing through the
 * REAL build-session finalize() path persists a build_history row, and the
 * read-only history server renders it on /api/history — night-grouped, with the
 * 4-value DB provenance coarsened to the 3-value public projection and every
 * donor/financial/trigger/host field dropped at the wire boundary. Aborted
 * builds (finalizeAborted) NEVER appear.
 *
 * Driven entirely against injected fakes (fake db, fake AgentRunner, fake
 * SandboxAdapter, fake COMP-02, fake machine) — NO live Twitch/StreamElements/
 * WSL2/network. The fakes travel the SAME finalize() path the production
 * orchestrator uses (05-01 wiring), so this proves the slice without src edits.
 */

// ── SDK-ish message fixtures (plain objects; no SDK type import) ─────────────
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

type Script = { research?: unknown[]; plan?: unknown[]; build?: unknown[] };
const HAPPY_SCRIPT: Script = {
  research: [assistantText("research notes about the feature"), resultSuccess],
  plan: [assistantText("1. build a page\n2. wire a button"), resultSuccess],
  build: [writeBatch("app.js", "console.log('hello stream')"), resultSuccess],
};

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "ok" };

function queuedTask(id: string, text: string): QueuedTask {
  const candidate: SuggestionCandidate = {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text,
    submittedAtMs: Date.now(),
  };
  return candidate as unknown as QueuedTask;
}

/** Permissive machine sliver — records transitions/active-task without the table. */
function fakeMachine(initial: StreamMode = "IDLE"): { machine: BuildMachineView } {
  let mode: StreamMode = initial;
  const machine: BuildMachineView = {
    get mode() {
      return mode;
    },
    transition(next) {
      mode = next;
    },
    setActiveTask() {},
  };
  return { machine };
}

/** A machine whose BUILD_IN_PROGRESS transition throws → forces finalize('failed'). */
function throwingBuildModeMachine(): { machine: BuildMachineView } {
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
function haltableMachine(): { machine: BuildMachineView; halt: () => void } {
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
  return {
    machine,
    halt: () => {
      mode = "HALTED";
    },
  };
}

/** Fake AgentRunner: research vs plan vs (sandboxed) build streams by spec shape. */
function fakeAgentRunner(script: Script): AgentRunner {
  return {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      const kind = spec.agent === "research" ? "research" : spec.sandbox ? "build" : "plan";
      const messages = script[kind] ?? [];
      return (async function* () {
        for (const message of messages) yield message as AgentMessage;
      })();
    },
  };
}

/** A runner that flips the machine to HALTED DURING the research turn. */
function haltingResearchRunner(onResearch: () => void): AgentRunner {
  return {
    run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      const kind = spec.agent === "research" ? "research" : spec.sandbox ? "build" : "plan";
      const messages = HAPPY_SCRIPT[kind] ?? [];
      return (async function* () {
        for (const message of messages) {
          yield message as AgentMessage;
          if (kind === "research") onResearch();
        }
      })();
    },
  };
}

const fakeSandbox = (): SandboxAdapter =>
  ({ spawn: () => ({}), terminate: async () => {} }) as unknown as SandboxAdapter;

function fakeComp02(byId: (id: string) => GateResult): Comp02Deps {
  return { classify: async (candidate: SuggestionCandidate) => byId(candidate.id) };
}

const nullSink: ProgressSink = { push: () => {} };

function makeDeps(over: {
  task: QueuedTask;
  db: Database.Database;
  machine: BuildMachineView;
  agentRunner: AgentRunner;
  comp02: Comp02Deps;
}): BuildSessionDeps {
  const taskQueue = new TaskQueue();
  taskQueue.enqueue(over.task);
  return {
    taskQueue,
    db: over.db,
    machine: over.machine,
    registry: new AbortRegistry(),
    agentRunner: over.agentRunner,
    sandboxAdapter: fakeSandbox(),
    comp02: over.comp02,
    progress: nullSink,
  };
}

/** Drive one build to completion through the REAL finalize() path. */
async function driveBuild(
  db: Database.Database,
  args: {
    taskId: string;
    title: string;
    provenance: BuildProvenance;
    result: "built" | "failed" | "refused";
  },
): Promise<void> {
  const task = queuedTask(args.taskId, args.title);
  let machine: BuildMachineView;
  let comp02: Comp02Deps;
  if (args.result === "failed") {
    machine = throwingBuildModeMachine().machine;
    comp02 = fakeComp02(() => APPROVED);
  } else if (args.result === "refused") {
    machine = fakeMachine().machine;
    // COMP-02 rejects the generated plan → finalize('refused').
    comp02 = fakeComp02((id) =>
      id.endsWith("-plan")
        ? { decision: "rejected", category: "tos-risk", rationale: "no" }
        : APPROVED,
    );
  } else {
    machine = fakeMachine().machine;
    comp02 = fakeComp02(() => APPROVED);
  }
  const deps = makeDeps({ task, db, machine, agentRunner: fakeAgentRunner(HAPPY_SCRIPT), comp02 });
  await createBuildSession(deps).startBuild(task, args.provenance);
}

/** Drive a build that is VETOED mid-research → finalizeAborted (zero rows). */
async function driveAborted(
  db: Database.Database,
  args: { taskId: string; title: string },
): Promise<void> {
  const task = queuedTask(args.taskId, args.title);
  const { machine, halt } = haltableMachine();
  const deps = makeDeps({
    task,
    db,
    machine,
    agentRunner: haltingResearchRunner(halt),
    comp02: fakeComp02(() => APPROVED),
  });
  await createBuildSession(deps).startBuild(task, "vote");
}

/** Insert a build_history row with an EXPLICIT created_at_ms (multi-night seed). */
function seedNight(
  db: Database.Database,
  row: { taskId: string; title: string; provenance: BuildProvenance; createdAtMs: number },
): void {
  db.prepare(
    `INSERT INTO build_history (task_id, title, provenance, result, created_at_ms)
     VALUES (@taskId, @title, @provenance, 'built', @createdAtMs)`,
  ).run(row);
}

async function getPage(port: number, query = ""): Promise<HistoryPage> {
  const res = await fetch(`http://127.0.0.1:${port}/api/history${query}`);
  return (await res.json()) as HistoryPage;
}

describe("build-history e2e — completed build persists and renders on /api/history (HIST-01)", () => {
  let db: Database.Database;
  let handle: HistoryServerHandle;

  beforeEach(async () => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    if (handle) await handle.close();
    db.close();
  });

  it("renders every completed build once, coarsens provenance, maps results, and never leaks the abort", async () => {
    // Drive one build per provenance × the honest result vocabulary through the
    // REAL finalize() path (all land in today's stream-night).
    await driveBuild(db, {
      taskId: "b-vote",
      title: "vote winner build",
      provenance: "vote",
      result: "built",
    });
    await driveBuild(db, {
      taskId: "b-don",
      title: "sponsored window build",
      provenance: "donation",
      result: "built",
    });
    await driveBuild(db, {
      taskId: "b-cp",
      title: "points redeem build",
      provenance: "channel_points",
      result: "built",
    });
    await driveBuild(db, {
      taskId: "b-chaos",
      title: "chaos pick build",
      provenance: "chaos",
      result: "built",
    });
    await driveBuild(db, {
      taskId: "b-fail",
      title: "failed build",
      provenance: "vote",
      result: "failed",
    });
    await driveBuild(db, {
      taskId: "b-ref",
      title: "refused build",
      provenance: "chaos",
      result: "refused",
    });
    // A vetoed build must write ZERO build_history rows (CR-01).
    await driveAborted(db, { taskId: "b-abort", title: "vetoed mid-build" });

    // Sanity: the abort DID fire its teardown but wrote no changelog row.
    expect(
      listAuditRecords(db, { limit: 10, eventType: "sandbox_teardown" }).length,
    ).toBeGreaterThan(0);

    handle = await startHistoryServer({ db, port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/history`);
    const raw = await res.text();
    const page = JSON.parse(raw) as HistoryPage;

    // (5) All completed builds land in one stream-night (today), reverse-chrono.
    expect(page.nights).toHaveLength(1);
    const entries = page.nights[0]?.entries ?? [];
    const byTitle = new Map(entries.map((e) => [e.title, e]));

    // (1) Each completed build appears exactly once; (2) the abort never appears.
    expect(entries).toHaveLength(6);
    expect(byTitle.has("vetoed mid-build")).toBe(false);
    expect(page.nights[0]?.entryCountLabel).toBe("6 builds");

    // (3) donation & channel_points both surface as 'paid'; vote/chaos pass through.
    expect(byTitle.get("vote winner build")?.provenance).toBe("vote");
    expect(byTitle.get("sponsored window build")?.provenance).toBe("paid");
    expect(byTitle.get("points redeem build")?.provenance).toBe("paid");
    expect(byTitle.get("chaos pick build")?.provenance).toBe("chaos");

    // (4) results map done→built, failed→failed, refused→refused.
    expect(byTitle.get("vote winner build")?.result).toBe("built");
    expect(byTitle.get("failed build")?.result).toBe("failed");
    expect(byTitle.get("refused build")?.result).toBe("refused");

    // (6) the serialized wire leaks no donor/financial/trigger/host detail.
    expect(raw).not.toContain("donation");
    expect(raw).not.toContain("channel_points");
    for (const forbidden of [
      "b-don",
      "b-cp",
      "taskId",
      "task_id",
      "createdAtMs",
      "created_at_ms",
      "rationale",
      "category",
    ]) {
      expect(raw, `wire must not leak "${forbidden}"`).not.toContain(forbidden);
    }
    // Every entry carries EXACTLY the four coarse public fields (no buildId — IN-01).
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["provenance", "result", "timeLabel", "title"].sort(),
      );
      expect(["vote", "paid", "chaos"]).toContain(entry.provenance);
    }
  });

  it("paginates multi-night history: 10 nights per page, hasOlder, ?before= cursor", async () => {
    // Seed 12 distinct stream-nights (one build each), strictly older than "now"
    // so the buckets are deterministic regardless of the run date.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = 1; i <= 12; i++) {
      // i days ago at local noon → a clean, distinct calendar-day bucket.
      const ms = startOfToday.getTime() - i * dayMs + 12 * 60 * 60 * 1000;
      seedNight(db, {
        taskId: `seed-${i}`,
        title: `night ${i}`,
        provenance: "vote",
        createdAtMs: ms,
      });
    }
    handle = await startHistoryServer({ db, port: 0 });

    const first = await getPage(handle.port);
    expect(first.nights).toHaveLength(10);
    expect(first.hasOlder).toBe(true);

    const oldestLoaded = first.nights.at(-1)?.nightKey;
    expect(oldestLoaded).toBeDefined();

    const second = await getPage(handle.port, `?before=${oldestLoaded}`);
    expect(second.nights).toHaveLength(2);
    expect(second.hasOlder).toBe(false);
    // The second page is strictly older than the first page's oldest night.
    const firstKeys = new Set(first.nights.map((n) => n.nightKey));
    for (const night of second.nights) expect(firstKeys.has(night.nightKey)).toBe(false);
  });
});
