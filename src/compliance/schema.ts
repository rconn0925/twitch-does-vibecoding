/**
 * Zod v4 schema for the compliance classifier's JSON output.
 *
 * This schema is used in two places (belt-and-suspenders):
 * 1. z.toJSONSchema(GateDecisionSchema) → sent to the Anthropic API as the
 *    Structured Output JSON schema constraint.
 * 2. Re-parsed from the raw API response text to validate the model's output
 *    before it reaches any business logic.
 *
 * Refinement rules:
 *   - approved ⇒ category must be null (approved suggestions carry no category)
 *   - held-for-review ⇒ category must be one of ESCALATE_ELIGIBLE (D-12)
 *   - rejected ⇒ category must be a valid GateCategory
 *   - "classifier-unavailable" is NOT a legal classifier output (internal-only)
 */

import { z } from "zod";
import { ESCALATE_ELIGIBLE, TAXONOMY_CATEGORIES } from "./categories.js";

/** The three allowed decisions. */
const DECISIONS = ["approved", "rejected", "held-for-review"] as const;

/** All categories the classifier schema may reference (taxonomy only; classifier-unavailable rejected by refine). */
const CLASSIFIER_CATEGORIES = [...TAXONOMY_CATEGORIES] as const;

/**
 * Structural shape only (enums + field types, NO cross-field refines).
 *
 * The classifier parses raw model output against this shape FIRST so it can
 * apply D-12 coercion (held-for-review + non-escalate category → rejected)
 * before the strict refined schema would reject that pairing outright.
 * The coerced value is then re-validated through GateDecisionSchema.
 */
export const GateDecisionShapeSchema = z.object({
  decision: z.enum(DECISIONS).describe("One of: approved, rejected, held-for-review"),
  category: z
    .enum(CLASSIFIER_CATEGORIES as unknown as [string, ...string[]])
    .nullable()
    .describe(
      "The taxonomy category, or null for approved decisions. 'classifier-unavailable' is rejected by schema refine.",
    ),
  rationale: z
    .string()
    .max(500)
    .describe(
      "One-sentence explanation. For approved: why it's safe. For rejected: the specific concern. For held-for-review: what needs streamer review.",
    ),
});

export const GateDecisionSchema = GateDecisionShapeSchema
  .refine(
    (data) => {
      if (data.decision === "approved" && data.category !== null) return false;
      if (data.decision !== "approved" && data.category === null) return false;
      return true;
    },
    {
      message: "approved must have null category; rejected/held-for-review must have a category",
      path: ["category"],
    },
  )
  .refine(
    (data) => {
      if (data.decision === "held-for-review" && data.category !== null) {
        if (!(ESCALATE_ELIGIBLE as readonly string[]).includes(data.category)) return false;
      }
      return true;
    },
    {
      message: "held-for-review requires an escalate-eligible category",
      path: ["category"],
    },
  )
  .refine(
    (data) => {
      if (data.category !== null) {
        // classifier-unavailable is internal-only, never a legal classifier output
        if (!(TAXONOMY_CATEGORIES as readonly string[]).includes(data.category)) return false;
      }
      return true;
    },
    {
      message: "non-null category must be one of the taxonomy categories",
      path: ["category"],
    },
  );

/** Type-level inference from the schema. */
export type ClassifierDecision = z.infer<typeof GateDecisionSchema>;

/**
 * The JSON Schema object sent to the Anthropic API via output_config.format.
 *
 * Uses zod v4's native toJSONSchema() — NOT the SDK's zod output-format helper
 * (known zod-v4 incompatibility, RESEARCH.md Pitfall 1).
 */
export function getGateDecisionJsonSchema(): object {
  return z.toJSONSchema(GateDecisionSchema);
}
