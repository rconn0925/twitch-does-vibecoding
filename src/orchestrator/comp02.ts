/**
 * COMP-02 — the second compliance pass (D3-06 pre-write plan re-screen +
 * D3-07 in-flight output re-screen).
 *
 * An approved-but-vague suggestion must not yield non-compliant output: the
 * build agent's OWN generated plan text (and, during execution, its output
 * batches) are routed back through the SAME Phase 1 gate BEFORE any code is
 * written. This is a second CALL to the single funnel — never a parallel
 * classifier, never the new-candidate intake path, never the branded-task
 * constructor. `deps.classify` is the app's gate classify() PRE-BOUND to the
 * shared gateDeps in main.ts (mirrors the enqueueWinner direct-classify
 * precedent in src/pipeline/round.ts), so the single-funnel invariant holds:
 * classify() is already an allowed path and needs no allowlist edit.
 *
 * Never throws. classify() is itself structurally fail-closed, but a defensive
 * try/catch here guarantees COMP-02 resolves a rejected/fail-closed outcome
 * even if a future injected classify were to reject — the caller narrates and
 * aborts the build rather than letting an uncaught rejection stall a
 * BUILD_IN_PROGRESS with no exit path.
 */

import type { GateResult, SuggestionCandidate } from "../shared/types.js";

export interface Comp02Deps {
  /**
   * The app's gate classify(), PRE-BOUND to the shared gateDeps in main.ts.
   * This is the SAME single funnel Phase 1 uses — COMP-02 is a second call to
   * it, not a fresh gate. Injected so tests drive it with a deterministic fake.
   */
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
}

/**
 * The decision COMP-02 hands its caller (the 03-06 build session):
 * - `approved`        → `{ proceed: true }`                              (build proceeds)
 * - `rejected`        → `{ proceed: false, disposition: "rejected", category }` (caller narrates + aborts)
 * - `held-for-review` → `{ proceed: false, disposition: "held", category, rationale }`
 *                       (caller PARKS the build for the console review queue,
 *                       D-08 / quick-260717-2gr — the category + rationale ride
 *                       along so the review card can show WHY it was flagged)
 *
 * The held arm's `category` is non-null by D-12 (held ⇒ escalate-eligible
 * category); the mapping falls back defensively ("gut-feeling"/"") rather than
 * ever throwing on a malformed result.
 *
 * The audit row is written by classify() itself (gate.ts's audit() call) —
 * COMP-02 only maps the decision, it does not re-audit.
 */
export type Comp02Outcome =
  | { proceed: true }
  | { proceed: false; disposition: "rejected"; category: string | null }
  | { proceed: false; disposition: "held"; category: string; rationale: string };

/**
 * Fail-closed sentinel category, mirroring gate.ts's FAIL_CLOSED — a classify()
 * that cannot answer means NO (D-11).
 */
const FAIL_CLOSED: Comp02Outcome = {
  proceed: false,
  disposition: "rejected",
  category: "classifier-unavailable",
};

/**
 * The single shared candidate-construction seam for both re-screen entry points.
 * `source: "orchestrator"` gives the audit trail a distinct value (03-RESEARCH
 * Q2 / D3-06); the text is the build agent's OWN generated output, carried
 * byte-for-byte and NEVER raw chat text re-fed.
 */
function planCandidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "orchestrator",
    kind: "suggestion",
    twitchUsername: null,
    text,
    submittedAtMs: Date.now(),
  };
}

/** Run one re-screen through the pre-bound funnel and map the decision. */
async function screen(deps: Comp02Deps, candidate: SuggestionCandidate): Promise<Comp02Outcome> {
  let result: GateResult;
  try {
    result = await deps.classify(candidate);
  } catch {
    // Defensive: classify() is structurally fail-closed, but never let a
    // rejection escape COMP-02 and stall the build session.
    return FAIL_CLOSED;
  }

  switch (result.decision) {
    case "approved":
      return { proceed: true };
    case "held-for-review":
      return {
        proceed: false,
        disposition: "held",
        // D-12 guarantees a non-null escalate category on the live gate;
        // fall back defensively rather than ever throwing (fail-closed spirit).
        category: result.category ?? "gut-feeling",
        rationale: typeof result.rationale === "string" ? result.rationale : "",
      };
    default:
      return { proceed: false, disposition: "rejected", category: result.category };
  }
}

/**
 * COMP-02 pre-write pass: re-screen the build agent's generated plan text before
 * any code is written (D3-06).
 */
export function screenBuildPlan(
  deps: Comp02Deps,
  args: { taskId: string; planText: string },
): Promise<Comp02Outcome> {
  return screen(deps, planCandidate(`${args.taskId}-plan`, args.planText));
}

/**
 * COMP-02 in-flight pass: re-screen an output batch during execution (D3-07).
 * Cadence (per Write/Edit batch or every 60s of building, whichever first) is
 * the orchestrator's call in 03-06; this only performs one screen.
 */
export function screenOutputBatch(
  deps: Comp02Deps,
  args: { taskId: string; outputText: string },
): Promise<Comp02Outcome> {
  return screen(deps, planCandidate(`${args.taskId}-output`, args.outputText));
}
