import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import { createApp } from "../../src/main.js";
import type {
  GalleryPublisher,
  PublishInput,
  PublishResult,
} from "../../src/orchestrator/gallery-publisher.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import type { CandidateKind, GateResult, SuggestionCandidate } from "../../src/shared/types.js";

/**
 * Double-build-execution regression (quick-260716-t1n). Live incidents
 * 2026-07-16 (tasks 6bb0528e and 12dff1cb): finalize() transitioned
 * BUILD_IN_PROGRESS→IDLE BEFORE dequeuing, the fdl AutoCycleScheduler's
 * undeferred STATE_CHANGED handler resumed a parked vote SYNCHRONOUSLY inside
 * that emit, and with a 1-candidate pool the chain
 *   #resumeFromWait → soloPick → enqueueWinner → onWinnerQueued → drainVoteQueue
 * ran inside transition("IDLE") while the finished task was still queue head —
 * the drain captured and RE-EXECUTED it (double build, double build_history
 * row, an extra workspace generation burned per project-switch win).
 *
 * THE LIVE FINGERPRINT reproduced here: auto-cycle (fdl default-on), a suggest
 * phase ends mid-build so the scheduler parks (`waiting`), EXACTLY ONE pooled
 * approved candidate awaits the resume, then the running build is driven to
 * `done`. Pinned:
 *  - Test 1: the finished task gets exactly ONE 'building' stage row and ONE
 *    build_history row; the NEXT build started is the solo winner — never the
 *    finished head.
 *  - Test 3 (kind matrix): same fingerprint with a plain 'suggestion' head
 *    (Test 1) and a 'project-switch' head — exactly ONE workspace_reset per
 *    win (each live double-run burned an extra generation).
 *  - Test 4: history-uniqueness sweep — no task_id ever holds >1
 *    build_history row with result='built'.
 *
 * Harness mirrors solo-auto-build / auto-cycle e2e: injected fakes through the
 * IDENTICAL createApp composition path — no network, no real WSL2/query().
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish fixtures (auto-cycle e2e idiom) ──────────────────────────────────

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/**
 * A gated AND recording runner: every sandboxed build turn records its spec
 * then awaits its own release gate, so tests can hold a build in
 * BUILD_IN_PROGRESS while the fdl scheduler parks around it — and afterwards
 * assert exactly WHICH task each successive build turn carried.
 */
function gatedRecordingRunner() {
  const specs: AgentRunSpec[] = [];
  const gates: Array<() => void> = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
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
    specs,
    armed: (): number => gates.length,
    release: (): void => {
      gates.shift()?.();
    },
    /** Wait for the next gated build turn to arm, then release it. */
    releaseNext: async (timeoutMs = 8_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
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

const approved: GateResult = { decision: "approved", category: null, rationale: "test: approved" };

function candidate(
  id: string,
  text: string,
  kind: CandidateKind = "suggestion",
): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind,
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
  };
}

/** An always-published fake publisher (build-flow idiom) — enables shipThenRotate's rotate arm. */
function publishingPublisher(): { publisher: GalleryPublisher; calls: PublishInput[] } {
  const calls: PublishInput[] = [];
  const publisher: GalleryPublisher = {
    revertLast: () =>
      Promise.resolve({ status: "failed", commitHash: null, detail: "unused in this suite" }),
    publishNow(input) {
      calls.push(input);
      return Promise.resolve({
        status: "published",
        commitHash: "fakehash",
        detail: "test",
      } satisfies PublishResult);
    },
  };
  return { publisher, calls };
}

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

/** Open a manual round, vote the given pooled candidate to victory, close. */
function voteToVictory(app: AppHandle, candidateId: string): void {
  app.round.startRound();
  const entry = app.round.snapshot()?.candidates.find((c) => c.candidate.id === candidateId);
  if (!entry) throw new Error(`candidate ${candidateId} was not drawn into the round`);
  app.round.recordVote("voter-1", entry.option);
  app.round.closeRound();
}

/** All pipeline_stage 'building' audit rows for one task — the double-run ground truth. */
function buildingRows(app: AppHandle, taskId: string) {
  return listAuditRecords(app.db, {
    limit: 500,
    eventType: "pipeline_stage",
    decision: "building",
  }).filter((r) => r.task_id === taskId);
}

/** Test 4 sweep: task_ids holding MORE than one build_history row with result 'built'. */
function doubleBuiltTaskIds(app: AppHandle): string[] {
  const counts = new Map<string, number>();
  for (const row of listBuildHistory(app.db, { limit: 500 })) {
    if (row.result !== "built") continue;
    counts.set(row.taskId, (counts.get(row.taskId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

/**
 * Release every remaining gated build turn until the app is fully quiet
 * (IDLE, empty queue, no armed gate) so both the broken (extra re-run build)
 * and fixed (solo winner only) shapes reach a stable end state for the
 * assertions. Bounded — never spins forever.
 */
async function settleAllBuilds(
  app: AppHandle,
  gated: ReturnType<typeof gatedRecordingRunner>,
  maxReleases = 6,
): Promise<void> {
  for (let i = 0; i < maxReleases; i++) {
    const deadline = Date.now() + 3_000;
    while (gated.armed() === 0) {
      if (app.machine.mode === "IDLE" && app.taskQueue.list().length === 0) {
        // Give any deferred drain room to arm another turn before declaring quiet.
        await sleep(200);
        if (gated.armed() === 0) return;
        break;
      }
      if (Date.now() > deadline) return; // decision-pending or stuck — assertions decide
      await sleep(20);
    }
    if (gated.armed() > 0) gated.release();
    await sleep(20);
  }
}

// ── Test 1 + Test 4: THE LIVE FINGERPRINT (plain 'suggestion' head) ──────────

describe("double-build regression: parked fdl vote + pool-of-1 + build done (live fingerprint, kind=suggestion)", () => {
  const FIRST_ID = "first-1";
  const FIRST_TEXT = "build the first task";
  const SOLO_ID = "solo-1";
  const SOLO_TEXT = "the solo winner idea";
  let gated: ReturnType<typeof gatedRecordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({ SUGGEST_PHASE_SECONDS: "0.3" }); // short real-timer phases
    gated = gatedRecordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    // Round: FIRST wins and starts building — held open by the gate.
    app.pool.add(candidate(FIRST_ID, FIRST_TEXT), approved);
    app.pool.add(candidate("filler-1", "filler idea one"), approved);
    voteToVictory(app, FIRST_ID);
    await until(() => gated.specs.length === 1);
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");

    // The 0.3s suggest phase ends MID-BUILD → the fdl scheduler parks the vote.
    await until(() => app.autoCycle.snapshot().phase === "waiting", 10_000);

    // EXACTLY ONE pooled approved candidate awaits the resume (pool-of-1).
    app.pool.add(candidate(SOLO_ID, SOLO_TEXT), approved);

    // Drive the running build to done: finalize's BUILD→IDLE emit fires the
    // synchronous #resumeFromWait → soloPick → onWinnerQueued → drainVoteQueue
    // chain — the exact 3ms window from the live audit rows (955/1039).
    gated.release();
    await until(() => listBuildHistory(app.db, { limit: 50 }).some((h) => h.taskId === FIRST_ID));
    // The next build turn spawns: the solo winner when fixed; the finished
    // head re-captured when broken.
    await until(() => gated.specs.length >= 2, 10_000);

    await settleAllBuilds(app, gated);
  }, 40_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("Test 1: the finished task re-enters 'building' exactly ONCE — one pipeline_stage building row", () => {
    expect(buildingRows(app, FIRST_ID)).toHaveLength(1);
  });

  it("Test 1: the finished task has exactly ONE build_history row", () => {
    const rows = listBuildHistory(app.db, { limit: 100 }).filter((h) => h.taskId === FIRST_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("built");
  });

  it("Test 1: the NEXT build started is the solo-picked winner — NOT the finished task", () => {
    const second = gated.specs[1];
    expect(second?.userPrompt).toContain(SOLO_TEXT);
    expect(second?.userPrompt).not.toContain(FIRST_TEXT);
    // The solo winner itself built exactly once and the loop ended clean.
    expect(buildingRows(app, SOLO_ID)).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("Test 4: history uniqueness — no task_id has more than one build_history row with result 'built'", () => {
    expect(doubleBuiltTaskIds(app)).toEqual([]);
  });
});

// ── Test 3 + Test 4: KIND MATRIX ('project-switch' head burns generations) ──

describe("double-build regression: the same fingerprint with a project-switch head (one workspace_reset per win)", () => {
  const SEED_ID = "seed-1";
  const SWITCH_ID = "switch-1";
  const SWITCH_TEXT = "start a brand new game";
  const SOLO_ID = "solo-2";
  const SOLO_TEXT = "another solo winner idea";
  let gated: ReturnType<typeof gatedRecordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({ SUGGEST_PHASE_SECONDS: "0.3" });
    gated = gatedRecordingRunner();
    const { publisher } = publishingPublisher();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });

    // Seed: a plain suggestion builds to done so gen 1 is an ACTIVE project —
    // the project-switch win must actually ship+rotate (the live shape).
    app.pool.add(candidate(SEED_ID, "seed the canvas app"), approved);
    app.pool.add(candidate("filler-2", "filler idea two"), approved);
    voteToVictory(app, SEED_ID);
    await gated.releaseNext();
    await until(() => listBuildHistory(app.db, { limit: 50 }).some((h) => h.taskId === SEED_ID));
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);

    // The project-switch winner: ship gen 1 → rotate (workspace_reset #1) → build.
    app.pool.add(candidate(SWITCH_ID, SWITCH_TEXT, "project-switch"), approved);
    app.pool.add(candidate("filler-3", "filler idea three"), approved);
    voteToVictory(app, SWITCH_ID);
    await until(() => gated.specs.length === 2, 10_000);

    // Suggest phase ends mid-build → parked; pool-of-1 awaits the resume.
    await until(() => app.autoCycle.snapshot().phase === "waiting", 10_000);
    app.pool.add(candidate(SOLO_ID, SOLO_TEXT), approved);

    // done → the synchronous resume chain fires inside the IDLE emit.
    gated.release();
    await until(() => listBuildHistory(app.db, { limit: 50 }).some((h) => h.taskId === SWITCH_ID));
    await until(() => gated.specs.length >= 3, 10_000);

    await settleAllBuilds(app, gated);
  }, 40_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("Test 3: exactly ONE workspace_reset row for the project-switch win — no extra generation burned", () => {
    const resets = listAuditRecords(app.db, { limit: 100, eventType: "workspace_reset" });
    expect(resets).toHaveLength(1);
  });

  it("Test 3: the project-switch task built exactly once (one 'building' row, one history row)", () => {
    expect(buildingRows(app, SWITCH_ID)).toHaveLength(1);
    expect(
      listBuildHistory(app.db, { limit: 100 }).filter((h) => h.taskId === SWITCH_ID),
    ).toHaveLength(1);
  });

  it("Test 3: the build AFTER the project-switch win is the solo winner — never the finished head", () => {
    const third = gated.specs[2];
    expect(third?.userPrompt).toContain(SOLO_TEXT);
    expect(third?.userPrompt).not.toContain(SWITCH_TEXT);
  });

  it("Test 4: history uniqueness sweep across the whole scenario", () => {
    expect(doubleBuiltTaskIds(app)).toEqual([]);
  });
});
