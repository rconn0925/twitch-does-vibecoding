import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { type Comp02Deps, screenBuildPlan, screenOutputBatch } from "./comp02.js";

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "fine for stream" };
const REJECTED: GateResult = {
  decision: "rejected",
  category: "hate",
  rationale: "hateful content — rejected",
};
const HELD: GateResult = {
  decision: "held-for-review",
  category: "self-harm-adjacent",
  rationale: "streamer should eyeball this",
};

/**
 * A recording fake for the PRE-BOUND classify() the orchestrator injects. It is
 * the SAME single funnel Phase 1 uses (gate.ts classify), captured here so the
 * tests can both drive its result and assert the candidate COMP-02 built.
 */
function makeDeps(impl: (candidate: SuggestionCandidate) => Promise<GateResult>): {
  deps: Comp02Deps;
  classify: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(impl);
  return { deps: { classify }, classify };
}

// Deliberately unicode-heavy + double-spaced: the text-identity assertions must
// catch any re-derivation/normalization of the plan text (it is the build
// agent's OWN generated plan — screened byte-for-byte, never mutated).
const PLAN_TEXT = "Build a snake game — with emoji \u{1F40D} and  double  spaces";

describe("screenBuildPlan (src/orchestrator/comp02.ts — COMP-02 second compliance pass)", () => {
  it("maps an approved gate result to { proceed: true }", async () => {
    const { deps } = makeDeps(async () => APPROVED);

    const outcome = await screenBuildPlan(deps, { taskId: "task-1", planText: PLAN_TEXT });

    expect(outcome).toEqual({ proceed: true });
  });

  it("maps a rejected gate result to a non-proceeding rejected outcome carrying the category", async () => {
    const { deps } = makeDeps(async () => REJECTED);

    const outcome = await screenBuildPlan(deps, { taskId: "task-1", planText: PLAN_TEXT });

    expect(outcome).toEqual({ proceed: false, disposition: "rejected", category: "hate" });
  });

  it("maps a held-for-review gate result to a non-proceeding held outcome (routes to console review queue)", async () => {
    const { deps } = makeDeps(async () => HELD);

    const outcome = await screenBuildPlan(deps, { taskId: "task-1", planText: PLAN_TEXT });

    expect(outcome).toEqual({ proceed: false, disposition: "held" });
  });

  it("passes classify() a candidate with source 'orchestrator' and the plan text byte-identical, never mutated", async () => {
    const { deps, classify } = makeDeps(async () => APPROVED);

    await screenBuildPlan(deps, { taskId: "task-42", planText: PLAN_TEXT });

    expect(classify).toHaveBeenCalledTimes(1);
    const candidate = classify.mock.calls[0]?.[0] as SuggestionCandidate;
    expect(candidate.source).toBe("orchestrator");
    expect(candidate.kind).toBe("suggestion");
    expect(candidate.twitchUsername).toBeNull();
    expect(candidate.id).toBe("task-42-plan");
    // The build agent's OWN plan — screened byte-for-byte, never re-derived.
    expect(candidate.text).toBe(PLAN_TEXT);
  });

  it("resolves a throwing classify() to a rejected/fail-closed outcome — never throws out of COMP-02", async () => {
    const { deps } = makeDeps(async () => {
      throw new Error("classifier exploded");
    });

    const outcome = await screenBuildPlan(deps, { taskId: "task-1", planText: PLAN_TEXT });

    expect(outcome).toEqual({
      proceed: false,
      disposition: "rejected",
      category: "classifier-unavailable",
    });
  });
});

describe("screenOutputBatch (src/orchestrator/comp02.ts — D3-07 in-flight re-screen)", () => {
  it("reuses the same call shape: approved output proceeds", async () => {
    const { deps } = makeDeps(async () => APPROVED);

    const outcome = await screenOutputBatch(deps, { taskId: "task-1", outputText: "some diff" });

    expect(outcome).toEqual({ proceed: true });
  });

  it("passes the output text byte-identical with source 'orchestrator' and a distinct candidate id", async () => {
    const { deps, classify } = makeDeps(async () => APPROVED);
    const OUTPUT = "wrote src/game.ts — added the \u{1F40D} sprite";

    await screenOutputBatch(deps, { taskId: "task-7", outputText: OUTPUT });

    const candidate = classify.mock.calls[0]?.[0] as SuggestionCandidate;
    expect(candidate.source).toBe("orchestrator");
    expect(candidate.text).toBe(OUTPUT);
    expect(candidate.id).toBe("task-7-output");
  });

  it("resolves a throwing classify() to a rejected/fail-closed outcome", async () => {
    const { deps } = makeDeps(async () => {
      throw new Error("boom");
    });

    const outcome = await screenOutputBatch(deps, { taskId: "task-1", outputText: "x" });

    expect(outcome).toEqual({
      proceed: false,
      disposition: "rejected",
      category: "classifier-unavailable",
    });
  });
});

describe("COMP-02 single-funnel discipline (source scan)", () => {
  it("never references submitCandidate / toQueuedTask / .enqueue( — it is a second classify() call, not a new funnel", () => {
    const src = readFileSync(fileURLToPath(new URL("./comp02.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/submitCandidate/);
    expect(src).not.toMatch(/toQueuedTask/);
    expect(src).not.toMatch(/\.enqueue\(/);
  });
});
