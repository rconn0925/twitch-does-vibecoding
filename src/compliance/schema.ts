/**
 * Zod v4 schema for the compliance classifier's JSON output.
 *
 * The gate now bills via the plan-billed Agent SDK `query()` transport, which
 * has no native JSON-schema output constraint, so this schema's sole role is the
 * belt-and-suspenders re-parse: the classifier extracts JSON from the model's
 * raw text and validates it against GateDecisionSchema BEFORE it reaches any
 * business logic. Any parse/validation failure fails CLOSED.
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

export const GateDecisionSchema = GateDecisionShapeSchema.refine(
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
