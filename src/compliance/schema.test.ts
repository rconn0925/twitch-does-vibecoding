/**
 * Tests for categories.ts and schema.ts — GREEN within this plan.
 *
 * No dependency on gate.ts. These tests verify the taxonomy count, the
 * escalate-eligible set, and the zod schema's refinement rules.
 */

import { describe, expect, it } from "vitest";
import {
  CATEGORY_META,
  CLASSIFIER_UNAVAILABLE,
  ESCALATE_ELIGIBLE,
  isEscalateCategory,
  isLegalCategory,
  TAXONOMY_CATEGORIES,
} from "./categories.js";
import { GateDecisionSchema } from "./schema.js";

describe("TAXONOMY_CATEGORIES", () => {
  it("has exactly 15 entries", () => {
    expect(TAXONOMY_CATEGORIES).toHaveLength(15);
  });

  it("includes all 13 ToS categories from COMPLIANCE.md plus 2 extensions", () => {
    const expected = [
      "hateful-conduct",
      "harassment",
      "sexual-content",
      "violence-threats",
      "self-harm",
      "illegal-activity",
      "gambling",
      "privacy-doxxing",
      "impersonation-synthetic-media",
      "spam-malware",
      "ip-infringement",
      "misinformation",
      "unsafe-build-target",
      "prompt-injection-attempt",
      "feasibility",
    ];
    expect(Array.from(TAXONOMY_CATEGORIES)).toEqual(expected);
  });

  it("has CATEGORY_META for every category", () => {
    for (const cat of TAXONOMY_CATEGORIES) {
      expect(CATEGORY_META[cat]).toBeDefined();
      expect(CATEGORY_META[cat].label).toBeTypeOf("string");
      expect(CATEGORY_META[cat].disposition).oneOf(["block", "escalate-eligible"]);
    }
  });
});

describe("ESCALATE_ELIGIBLE", () => {
  it("has exactly 3 entries", () => {
    expect(ESCALATE_ELIGIBLE).toHaveLength(3);
  });

  it("is exactly gambling, ip-infringement, misinformation", () => {
    expect(ESCALATE_ELIGIBLE).toEqual(["gambling", "ip-infringement", "misinformation"]);
  });

  it("isEscalateCategory returns true for escalate categories, false for others", () => {
    expect(isEscalateCategory("gambling")).toBe(true);
    expect(isEscalateCategory("ip-infringement")).toBe(true);
    expect(isEscalateCategory("misinformation")).toBe(true);
    expect(isEscalateCategory("spam-malware")).toBe(false);
    expect(isEscalateCategory("hateful-conduct")).toBe(false);
  });

  it("isLegalCategory returns true for taxonomy categories only", () => {
    for (const cat of TAXONOMY_CATEGORIES) {
      expect(isLegalCategory(cat)).toBe(true);
    }
    expect(isLegalCategory(CLASSIFIER_UNAVAILABLE)).toBe(false);
  });
});

describe("GateDecisionSchema (zod v4)", () => {
  it("accepts an approved decision with null category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "approved",
      category: null,
      rationale: "Safe build — no policy concerns",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a rejected decision with a valid category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "rejected",
      category: "spam-malware",
      rationale: "Requests malware functionality",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a held-for-review with an escalate-eligible category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "held-for-review",
      category: "gambling",
      rationale: "Simulated gambling — needs streamer judgment",
    });
    expect(result.success).toBe(true);
  });

  it("rejects held-for-review with a non-escalate category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "held-for-review",
      category: "spam-malware",
      rationale: "This should not be allowed — spam is not escalate-eligible",
    });
    expect(result.success).toBe(false);
  });

  it("rejects approved with a non-null category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "approved",
      category: "gambling",
      rationale: "Should not approve with a category",
    });
    expect(result.success).toBe(false);
  });

  it("rejects rejected with null category", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "rejected",
      category: null,
      rationale: "Must have a category when rejected",
    });
    expect(result.success).toBe(false);
  });

  it("rejects category 'classifier-unavailable' (internal-only sentinel)", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "rejected",
      category: CLASSIFIER_UNAVAILABLE,
      rationale: "Should not allow classifier-unavailable in classifier output",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown categories", () => {
    const result = GateDecisionSchema.safeParse({
      decision: "rejected",
      category: "totally-made-up",
      rationale: "Should reject invalid categories",
    } as { decision: string; category: string | null; rationale: string });
    expect(result.success).toBe(false);
  });

  it("rejects rationales longer than 500 characters", () => {
    const longRationale = "a".repeat(501);
    const result = GateDecisionSchema.safeParse({
      decision: "rejected",
      category: "spam-malware",
      rationale: longRationale,
    });
    expect(result.success).toBe(false);
  });
});
