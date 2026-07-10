/**
 * Compliance classifier — plan-billed Sonnet classification via an INJECTED
 * transport, with a retry budget and a fail-closed error path (D-11,
 * RESEARCH.md Pitfall 3).
 *
 * This module imports NO Anthropic SDK (single-funnel (c) / SAND-04): the
 * plan-billed `query()` call lives in src/orchestrator/classifier-runner.ts and
 * is handed in as a `ClassifierTransport`. This layer owns the safety envelope
 * around that transport — the retry budget + backoff, tolerant JSON extraction
 * of the model's raw text, zod shape parse → D-12 coercion → refined
 * re-validation, and the fail-closed sentinel. ANY parse/validation/transport
 * failure resolves (never throws) to CLASSIFIER_UNAVAILABLE_DECISION — the gate
 * fails CLOSED, never open.
 */

import type { Logger } from "pino";
import type { SuggestionCandidate } from "../shared/types.js";
import { ESCALATE_ELIGIBLE } from "./categories.js";
import type { ClassifierDecision } from "./schema.js";
import { GateDecisionSchema, GateDecisionShapeSchema } from "./schema.js";

/**
 * The compliance↔orchestrator seam: candidate text in → the model's raw
 * assistant text out. Implemented by createClassifierTransport() under
 * src/orchestrator/ (the plan-billed query() runner); tests inject a fake that
 * returns canned JSON strings or throws. Keeping this an injected function is
 * what keeps the Anthropic SDK out of src/compliance/ and out of the test graph.
 */
export type ClassifierTransport = (candidateText: string) => Promise<string>;

/** Dependency injection shape — keeps tests offline and deterministic. */
export interface ClassifierDeps {
  /** Plan-billed classification transport (Sonnet via the Agent SDK query()). */
  transport: ClassifierTransport;
  /** Override max retries from GATE_MAX_RETRIES env; defaults to 2. */
  maxRetries?: number;
  logger?: Logger;
}

/** Fail-closed sentinel decision. */
const CLASSIFIER_UNAVAILABLE_DECISION: ClassifierDecision = {
  decision: "rejected",
  category: "classifier-unavailable",
  rationale:
    "Classifier unavailable — auto-rejected (fail-closed). Viewer feedback: try again shortly.",
};

/**
 * Tolerant extraction of the model's JSON object from raw assistant text.
 *
 * `query()` has no native json_schema enforcement (unlike messages.parse), so
 * the model's text may carry ```json code fences or surrounding prose. Slicing
 * from the first `{` to the last `}` strips both, then JSON.parse runs. ANY
 * failure throws and is caught by the classifier's fail-closed/backoff path —
 * there is no fail-open branch.
 */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in classifier output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Classify a candidate via the injected Sonnet transport with a retry budget.
 *
 * STRUCTURALLY fail-closed: any unrecovered error resolves (never rejects)
 * to { rejected, classifier-unavailable } — never approved, never held.
 */
export async function classifyWithSonnet(
  deps: ClassifierDeps,
  candidate: SuggestionCandidate,
): Promise<ClassifierDecision> {
  const { transport, maxRetries = envInt("GATE_MAX_RETRIES", 2), logger } = deps;
  const maxAttempts = 1 + maxRetries;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Plan-billed transport: candidate text in → raw model text out. The
      // untrusted candidate text travels ONLY here (as user content); it never
      // touches the fixed system prompt owned by the orchestrator runner.
      const raw = await transport(candidate.text);
      const parsed = extractJsonObject(raw);

      // Belt-and-suspenders re-parse, in two steps:
      // 1. Shape parse (enums/types only, no cross-field refines) so a model
      //    response pairing held-for-review with a non-escalate category is
      //    seen as structurally valid and can be coerced, not retried.
      const shape = GateDecisionShapeSchema.safeParse(parsed);
      if (!shape.success) {
        throw new Error(
          `model output failed schema validation: ${shape.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        );
      }

      // 2. D-12 coercion: never trust the model's escalation choice. Any
      //    held-for-review outside the escalate-eligible set → rejected with
      //    the same category.
      let result = shape.data;
      if (
        result.decision === "held-for-review" &&
        result.category !== null &&
        !(ESCALATE_ELIGIBLE as readonly string[]).includes(result.category)
      ) {
        result = {
          decision: "rejected",
          category: result.category,
          rationale: `Held-for-review with non-escalate category "${result.category}" — coerced to rejected (D-12)`,
        };
      }

      // 3. Full refined-schema validation of the (possibly coerced) result.
      const validation = GateDecisionSchema.safeParse(result);
      if (!validation.success) {
        throw new Error(
          `decision failed refined schema validation: ${validation.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        );
      }

      return validation.data;
    } catch (err) {
      const isLastAttempt = attempt >= maxAttempts;
      logger?.error(
        { attempt, maxAttempts, error: err instanceof Error ? err.message : String(err) },
        `classifier attempt ${attempt}/${maxAttempts} failed`,
      );

      if (isLastAttempt) {
        // Fail-closed: RESOLVE, never throw (D-11, Pitfall 3). No backoff on
        // the final attempt — return immediately.
        return CLASSIFIER_UNAVAILABLE_DECISION;
      }

      // Backoff before retry
      await backoff(attempt - 1);
    }
  }

  // Should never reach here (the loop above returns on last attempt),
  // but TypeScript needs an explicit return.
  return CLASSIFIER_UNAVAILABLE_DECISION;
}

/** Read a non-negative integer from env with a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Backoff schedule: 500ms after the first failed attempt, 1500ms after each
 * subsequent one (RESEARCH.md Open Questions (RESOLVED) 2 — total waiting
 * stays under the 8s budget). Fake-timer-friendly setTimeout.
 */
const BACKOFF_MS = [500, 1500] as const;

function backoff(attempt: number): Promise<void> {
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}
