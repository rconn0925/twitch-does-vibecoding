import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import { createApp } from "../../src/main.js";
import { translate } from "../../src/orchestrator/progress-events.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import { BUILD_STAGE_CHANGED } from "../../src/overlay/server.js";
import type { PipelineStage } from "../../src/shared/types.js";

/**
 * MVP e2e (plan 03-06, reshaped by quick-0iu straight-to-build): the FULL
 * happy-path slice, GREEN.
 *
 *   pooled winner → funnel → machine enters BUILD_IN_PROGRESS → COMP-02
 *   re-screens the winning SUGGESTION text and approves → the SINGLE sandboxed
 *   build turn runs → building → done → machine returns to IDLE; the overlay
 *   reflects the live stage; a refused build narrates `refused` and never
 *   silently stalls. No research/plan turns exist anymore.
 *
 * Driven against createApp's injected-fake seams (fake AgentRunner, fake
 * SandboxAdapter, fake DevServerProbe, fakeClassifier) — NO real WSL2 / query()
 * / network. The fakes travel the IDENTICAL composition path the entrypoint's
 * real SDK/WSL2 adapters use (03-06 wiring), so this proves the production wiring
 * without src edits.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (plain objects; no SDK type import) ──────────────
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const modelRefusal = { subtype: "model_refusal_no_fallback" };

const PIPELINE_FIXTURES: unknown[] = [
  { hook_event_name: "SubagentStart", agent_type: "build" },
  { type: "result", subtype: "success", is_error: false },
];

/** A fake AgentRunner whose single sandboxed BUILD turn blocks on a gate the test releases. */
function gatedHappyRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let specsConsumed = 0;
  const runner: AgentRunner = {
    run() {
      specsConsumed += 1;
      return (async function* () {
        // The one sandboxed build turn — pause so the test can observe `building`.
        await gate;
        yield writeBatch("index.html", "<button id=b>count: 0</button>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return { runner, release: () => release(), specsConsumed: () => specsConsumed };
}

/** A fake AgentRunner whose BUILD turn refuses (model refusal). */
function refusingRunner(): AgentRunner {
  return {
    run() {
      return (async function* () {
        yield modelRefusal as never;
      })();
    },
  };
}

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

/** Seed two approved candidates, open a round, vote option 1, and close it. */
function drivePooledWinner(app: AppHandle): void {
  app.pool.add(
    {
      id: "cand-1",
      source: "chat",
      kind: "suggestion",
      twitchUsername: "a",
      text: "make a counter app",
      submittedAtMs: Date.now(),
    },
    approved,
  );
  app.pool.add(
    {
      id: "cand-2",
      source: "chat",
      kind: "suggestion",
      twitchUsername: "b",
      text: "make a todo list",
      submittedAtMs: Date.now(),
    },
    approved,
  );
  app.round.startRound();
  app.round.recordVote("voter-1", 1);
  app.round.closeRound();
}

async function fetchBuildStage(port: number): Promise<PipelineStage | null> {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  const state = (await res.json()) as {
    buildStatus: { stage: PipelineStage; title: string } | null;
  };
  return state.buildStatus?.stage ?? null;
}

describe("build-flow e2e (MVP happy path) — 03-06 GREEN", () => {
  let app: AppHandle;
  const stagesSeen: PipelineStage[] = [];
  let midMachineMode = "";
  let midBuildStage: PipelineStage | null = null;
  let midBuildTitle: string | undefined;
  let classifyIdsAtGate: string[] = [];
  let finalMachineMode = "";

  const recordedIds: string[] = [];
  /** (id, text, runner-specs-consumed-at-call) per classify call. */
  const recordedCalls: Array<{ id: string; text: string; specsAtCall: number }> = [];
  let gated: ReturnType<typeof gatedHappyRunner>;

  beforeAll(async () => {
    gated = gatedHappyRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (c) => {
        recordedIds.push(c.id);
        recordedCalls.push({ id: c.id, text: c.text, specsAtCall: gated.specsConsumed() });
        return { decision: "approved", category: null, rationale: "test: approved" };
      },
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed — agentRunner wiring is broken");
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) stagesSeen.push(snap.stage);
    });

    // Fire the winner → the winner hook synchronously enters BUILD_IN_PROGRESS.
    drivePooledWinner(app);
    midMachineMode = app.machine.mode;

    // The build turn blocks on the gate: observe the live `building` stage on
    // the OVERLAY surface (buildStatus is an overlay field, not the console's).
    await waitUntil(() => stagesSeen.includes("building"));
    midBuildStage = await fetchBuildStage(app.overlay.port);
    const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
    const state = (await res.json()) as { buildStatus: { title: string } | null };
    midBuildTitle = state.buildStatus?.title;
    classifyIdsAtGate = [...recordedIds];

    // Release the build → run to done → back to IDLE.
    gated.release();
    await waitUntil(() => app.machine.mode === "IDLE");
    finalMachineMode = app.machine.mode;
  });

  afterAll(async () => {
    await app.close();
  });

  it("encodes the observable stage sequence the fake AgentRunner emits (build→done)", () => {
    const stages = PIPELINE_FIXTURES.map((m) => translate(m)).filter((s) => s !== null);
    expect(stages).toEqual(["building", "done"]);
  });

  it("boots the full app harness the orchestrator slice plugs into (createApp injected-fake seam)", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    expect(res.status).toBe(200);
  });

  it("consumes a QueuedTask and transitions the machine to BUILD_IN_PROGRESS (03-06)", () => {
    expect(midMachineMode).toBe("BUILD_IN_PROGRESS");
  });

  it("goes STRAIGHT to build: the FIRST stage seen is 'building' — no researching/planning ever emits", () => {
    expect(stagesSeen[0]).toBe("building");
    expect(stagesSeen).not.toContain("researching");
    expect(stagesSeen).not.toContain("planning");
  });

  it("COMP-02 re-screens the winning SUGGESTION text BEFORE any runner spec is consumed (03-04 / quick-0iu)", () => {
    // The pre-build re-screen ran (a `-plan` candidate hit the gate) with the
    // raw suggestion text as input, BEFORE the AgentRunner consumed any spec —
    // and no `-output` in-flight re-screen had happened yet at the gate.
    const preScreen = recordedCalls.find((c) => c.id.endsWith("-plan"));
    expect(preScreen).toBeDefined();
    expect(preScreen?.text).toBe("make a counter app");
    expect(preScreen?.specsAtCall).toBe(0);
    expect(classifyIdsAtGate.some((id) => id.endsWith("-plan"))).toBe(true);
    expect(classifyIdsAtGate.some((id) => id.endsWith("-output"))).toBe(false);
    const rows = listAuditRecords(app.db, { limit: 20, eventType: "comp02_decision" });
    expect(rows.some((r) => r.decision === "approved")).toBe(true);
  });

  it("emits building → done and returns the machine to IDLE (03-06)", () => {
    expect(stagesSeen).toEqual(["building", "done"]);
    expect(finalMachineMode).toBe("IDLE");
  });

  it("overlay GET /api/state reflects the current pipeline stage (PRES-02/04)", () => {
    expect(midBuildStage).toBe("building");
    expect(midBuildTitle).toBe("make a counter app");
  });

  it("persists a build_history row with provenance 'vote' — the onWinnerQueued driver threads it (HIST-01)", () => {
    const rows = listBuildHistory(app.db, { limit: 20 });
    const entry = rows.find((r) => r.title === "make a counter app");
    expect(entry).toBeDefined();
    expect(entry?.provenance).toBe("vote");
    expect(entry?.result).toBe("built");
  });
});

describe("build-flow e2e (refusal) — never silent, freezes a decision (BUILD-03 / D3-09)", () => {
  it("a refused build emits `refused`, freezes a streamer decision (BUILD_IN_PROGRESS), and skip returns to IDLE", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => ({ decision: "approved", category: null, rationale: "ok" }),
      agentRunner: refusingRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed");
    const seen: PipelineStage[] = [];
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) seen.push(snap.stage);
    });

    drivePooledWinner(app);
    // D3-09: a refusal is NEVER a silent auto-IDLE — it freezes a retry/skip
    // decision with the machine still BUILD_IN_PROGRESS.
    await waitUntil(() => seen.includes("refused"));

    expect(seen.at(-1)).toBe("refused");
    expect(seen).not.toContain("done");
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");
    // Audit: the refusal is a first-class recorded event (D3-08), never silent.
    const rows = listAuditRecords(app.db, { limit: 20, eventType: "build_refused" });
    expect(rows.length).toBeGreaterThan(0);

    // The streamer resolves the frozen build via skip → clean return to IDLE.
    orch.skipTask(orch.snapshot()?.taskId ?? "");
    await waitUntil(() => app.machine.mode === "IDLE");
    expect(orch.snapshot()).toBeNull();

    await app.close();
  });
});
