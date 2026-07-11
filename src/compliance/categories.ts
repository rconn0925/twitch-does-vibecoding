/**
 * The 15-value GateCategory union: 13 Twitch-ToS categories from COMPLIANCE.md
 * + prompt-injection-attempt + feasibility (RESEARCH.md Pitfall 4 extensions).
 *
 * This module is the single source of truth for what the compliance gate knows.
 * Plan 01-05's gate.ts imports here — never duplicate the category list.
 */

export const TAXONOMY_CATEGORIES = [
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
  // RETIRED from the classifier prompt (2026-07-11 streamer decision, quick
  // 260711-0ms): the gate judges ToS/CG risk ONLY — feasibility is no longer
  // offered to the model. Kept in the union for schema/audit back-compat and
  // the dormant main.ts feasibility branch. Do NOT remove.
  "feasibility",
] as const;

/** Every legal category the classifier schema may emit. */
export type GateCategory = (typeof TAXONOMY_CATEGORIES)[number];

/**
 * D-12: the only categories whose classifier output may be held-for-review.
 * Gambling (simulated-play-money ambiguity), IP (parody vs infringement),
 * misinformation (satire vs harm) — all need human judgment.
 */
export const ESCALATE_ELIGIBLE = ["gambling", "ip-infringement", "misinformation"] as const;

export type EscalateCategory = (typeof ESCALATE_ELIGIBLE)[number];

/** Per-category metadata: viewer-safe label + disposition for the classifier prompt. */
export const CATEGORY_META: Record<
  GateCategory,
  { label: string; disposition: "block" | "escalate-eligible" }
> = {
  "hateful-conduct": {
    label: "Hateful conduct",
    disposition: "block",
  },
  harassment: {
    label: "Harassment",
    disposition: "block",
  },
  "sexual-content": {
    label: "Sexual content",
    disposition: "block",
  },
  "violence-threats": {
    label: "Violence or threats",
    disposition: "block",
  },
  "self-harm": {
    label: "Self-harm or dangerous acts",
    disposition: "block",
  },
  "illegal-activity": {
    label: "Illegal activity",
    disposition: "block",
  },
  gambling: {
    label: "Unlicensed gambling / betting mechanics",
    disposition: "escalate-eligible",
  },
  "privacy-doxxing": {
    label: "Privacy violations / doxxing",
    disposition: "block",
  },
  "impersonation-synthetic-media": {
    label: "Impersonation / synthetic media",
    disposition: "block",
  },
  "spam-malware": {
    label: "Spam, malware, or phishing",
    disposition: "block",
  },
  "ip-infringement": {
    label: "IP infringement",
    disposition: "escalate-eligible",
  },
  misinformation: {
    label: "Harmful misinformation",
    disposition: "escalate-eligible",
  },
  "unsafe-build-target": {
    label: "Unsafe build target (requires secrets, destructive access, or external deployment)",
    disposition: "block",
  },
  "prompt-injection-attempt": {
    label: "Prompt injection attempt",
    disposition: "block",
  },
  // RETIRED category (2026-07-11): no longer in CLASSIFIER_SYSTEM_PROMPT; the
  // classifier never emits it in the retuned policy. Metadata retained for
  // audit back-compat with historical rows and the dormant main.ts branch.
  feasibility: {
    label: "Too big for a live build",
    disposition: "block",
  },
};

/** Internal fail-closed category — never emitted by the classifier schema, only injected on error. */
export const CLASSIFIER_UNAVAILABLE: "classifier-unavailable" = "classifier-unavailable";

/** Is this category one the classifier may legally return (excludes the internal fail-closed sentinel)? */
export function isLegalCategory(cat: string): cat is GateCategory {
  return (TAXONOMY_CATEGORIES as readonly string[]).includes(cat);
}

/** Is this category eligible for escalation to the review queue (D-12)? */
export function isEscalateCategory(cat: string): cat is EscalateCategory {
  return (ESCALATE_ELIGIBLE as readonly string[]).includes(cat);
}
