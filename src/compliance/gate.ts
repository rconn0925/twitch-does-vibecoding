/**
 * The compliance gate — COMP-01's single chokepoint.
 *
 * classify() is the ONLY route from a SuggestionCandidate to a gate decision:
 * prefilter fast-fail → Sonnet classifier (or an injected fake in tests) →
 * D-12 belt-and-suspenders escalation check → audit → return.
 *
 * toQueuedTask() is the ONLY sanctioned QueuedTask constructor in the
 * codebase. Nothing may enqueue a build task except through classify() +
 * toQueuedTask() (COMP-01 single funnel).
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { recordGateDecision } from "../audit/record.js";
import type { GateResult, QueuedTask, StreamMode, SuggestionCandidate } from "../shared/types.js";
import { isEscalateCategory } from "./categories.js";
import type { ClassifierDeps } from "./classifier.js";
import { classifyWithSonnet } from "./classifier.js";
import { prefilterCheck } from "./prefilter.js";
import type { ClassifierDecision } from "./schema.js";

/**
 * Injected classifier for offline, deterministic tests. May be sync or async,
 * may throw — a throwing fake exercises the gate's fail-closed path.
 */
export type FakeClassifier = (
  candidate: SuggestionCandidate,
) => ClassifierDecision | Promise<ClassifierDecision>;

export interface GateDeps {
  /**
   * Audit ledger handle. When present, EVERY decision is written to audit_log
   * before classify() returns (COMP-05, D-16). Optional ONLY so unit tests can
   * run without a database — all production wiring must pass a db.
   */
  db?: Database.Database;
  /** Test-injected classifier; takes priority over `classifier` when present. */
  fakeClassifier?: FakeClassifier;
  /** Live Sonnet classifier deps (anthropic client, model, retry budget). */
  classifier?: ClassifierDeps;
  /** Injectable prefilter (defaults to the real prefilterCheck). */
  prefilter?: typeof prefilterCheck;
  logger?: Logger;
  /** Current stream mode, recorded on every audit row. Defaults to "IDLE" when unwired. */
  streamModeProvider?: () => StreamMode;
}

/** Fail-closed sentinel: no classifier answer means NO (D-11). */
const FAIL_CLOSED: GateResult = {
  decision: "rejected",
  category: "classifier-unavailable",
  rationale:
    "Classifier unavailable — auto-rejected (fail-closed). Viewer feedback: try again shortly.",
};

/**
 * Classify a candidate: prefilter → classifier → D-12 guard → audit → return.
 *
 * Returns exactly one of approved / rejected(category) / held-for-review
 * (D-08). Never throws: any classifier error resolves to the fail-closed
 * rejected/classifier-unavailable result.
 */
export async function classify(
  deps: GateDeps,
  candidate: SuggestionCandidate,
): Promise<GateResult> {
  const prefilter = deps.prefilter ?? prefilterCheck;

  // 1. Cheap fast-fail on obvious junk — saves a metered Sonnet call.
  const pre = prefilter(candidate.text);
  if (pre.rejected) {
    const result: GateResult = {
      decision: "rejected",
      category: pre.category,
      rationale: pre.rationale,
    };
    audit(deps, candidate, result);
    return result;
  }

  // 2. Classifier (injected fake in tests, live Sonnet in production).
  let result: GateResult;
  try {
    if (deps.fakeClassifier) {
      result = await deps.fakeClassifier(candidate);
    } else if (deps.classifier) {
      // classifyWithSonnet is itself structurally fail-closed (never throws).
      result = await classifyWithSonnet(deps.classifier, candidate);
    } else {
      // No classifier wired at all — fail closed rather than approve blind.
      deps.logger?.error(
        { candidateId: candidate.id },
        "classify() called with no classifier wired — failing closed",
      );
      result = FAIL_CLOSED;
    }
  } catch (err) {
    deps.logger?.error({ err, candidateId: candidate.id }, "classifier threw — failing closed");
    result = FAIL_CLOSED;
  }

  // 3. D-12 belt-and-suspenders at the gate: never trust an escalation outside
  //    the escalate-eligible set. classifier.ts already coerces live output;
  //    this guards injected fakes and future classifier implementations.
  if (
    result.decision === "held-for-review" &&
    (result.category === null || !isEscalateCategory(result.category))
  ) {
    result = {
      decision: "rejected",
      // A held decision with no category is malformed — map to the internal
      // fail-closed sentinel so the rejected row still carries a category.
      category: result.category ?? "classifier-unavailable",
      rationale: "Held-for-review outside the escalate-eligible set — coerced to rejected (D-12)",
    };
  }

  // 4. Audit before return — every decision path lands exactly one row.
  audit(deps, candidate, result);
  return result;
}

/**
 * Convert an APPROVED gate result into the branded QueuedTask.
 *
 * Throws for rejected and held-for-review results: the brand must be
 * unreachable for anything the gate did not approve.
 */
export function toQueuedTask(candidate: SuggestionCandidate, result: GateResult): QueuedTask {
  if (result.decision !== "approved") {
    throw new Error(
      `toQueuedTask requires an approved gate result, got "${result.decision}" — COMP-01 single funnel`,
    );
  }
  // single-funnel invariant — enforced by tests/invariants/single-funnel.test.ts
  return { ...candidate } as QueuedTask;
}

/** Write the decision to the audit ledger (COMP-05) — one row per classify(). */
function audit(deps: GateDeps, candidate: SuggestionCandidate, result: GateResult): void {
  if (!deps.db) return;
  recordGateDecision(deps.db, {
    candidate,
    decision: result.decision,
    category: result.category,
    rationale: result.rationale,
    streamMode: deps.streamModeProvider?.() ?? "IDLE",
  });
}
