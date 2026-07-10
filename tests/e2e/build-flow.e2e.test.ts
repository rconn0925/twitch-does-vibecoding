import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/main.js";
import { translate } from "../../src/orchestrator/progress-events.js";

/**
 * MVP e2e-first (plan 03-02 Task 3): the FAILING/PENDING happy-path spec the
 * phase drives toward. It encodes the target observable slice:
 *
 *   QueuedTask picked up → machine enters BUILD_IN_PROGRESS → stages emit
 *   researching → planning → (COMP-02 approves the plan) → building → done →
 *   machine returns to IDLE; the overlay reflects the current pipeline stage.
 *
 * Authored against createApp's injected-fake seams (fake AgentRunner, fake
 * SandboxAdapter, fakeClassifier) — NO real WSL2 / query() / network. The
 * end-to-end wiring does not exist yet, so the slice steps are `it.todo` by
 * design; they go green when these plans land:
 *   - 03-06 — core orchestrator: consume QueuedTask, drive research→plan→build,
 *             BUILD_IN_PROGRESS↔IDLE, push stages to overlay (extends
 *             CreateAppOptions with the orchestrator fakes so no src edits are
 *             needed here later — mirrors how 02-06 proved chat wiring).
 *   - 03-04 — COMP-02 plan re-screen inserted before the build write.
 *   - 03-09 — failure/refusal/veto: narrated retry/skip, clean abort.
 *
 * This suite must NOT falsely pass before the slice exists: everything below
 * the fixture-contract check is todo, so `npm test` reports it as todo, never
 * an accidental green.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

/**
 * The raw SDK message stream the fake AgentRunner will emit in 03-06, modeling
 * one clean build: research subagent → plan step → build subagent → success.
 * Plain objects fed to translate() (which takes `unknown`) — no SDK type import,
 * keeping raw SDK shapes out of this non-orchestrator file.
 */
const PIPELINE_FIXTURES: unknown[] = [
  { hook_event_name: "SubagentStart", agent_type: "research" },
  { type: "system", subtype: "task_progress", subagent_type: "plan" },
  { hook_event_name: "SubagentStart", agent_type: "build" },
  { type: "result", subtype: "success", is_error: false },
];

describe("build-flow e2e (MVP happy path) — drives 03-06/03-09", () => {
  let app: AppHandle;

  beforeAll(async () => {
    // Boot the real composition on an ephemeral port with an in-memory db and
    // an injected classifier — the identical seam 03-06 extends to accept the
    // orchestrator fakes. Proves the harness is authored against createApp.
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => ({ decision: "approved", category: null, rationale: "test: approved" }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("encodes the observable stage sequence the fake AgentRunner emits (research→plan→build→done)", () => {
    const stages = PIPELINE_FIXTURES.map((m) => translate(m)).filter((s) => s !== null);
    expect(stages).toEqual(["researching", "planning", "building", "done"]);
  });

  it("boots the full app harness the orchestrator slice plugs into (createApp injected-fake seam)", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    expect(res.status).toBe(200);
  });

  // ── The end-to-end slice — PENDING until 03-04/03-06/03-09 land ─────────────
  it.todo("consumes a QueuedTask and transitions the machine to BUILD_IN_PROGRESS (03-06)");
  it.todo("emits researching → planning pipeline stages to the progress sink (03-06)");
  it.todo("COMP-02 re-screens the generated plan and approves BEFORE any build write (03-04)");
  it.todo("emits building → done and returns the machine to IDLE (03-06)");
  it.todo("overlay GET /api/state reflects the current pipeline stage (PRES-02/04)");
  it.todo("a refused/failed build narrates a retry/skip decision, never silent (BUILD-03, 03-09)");
});
