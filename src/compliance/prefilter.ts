/**
 * Prefilter — cheap fast-fail before the Sonnet classifier call.
 *
 * Normalizes the input (NFKC, strip zero-width chars, collapse whitespace)
 * and runs a maintained regex list against it. Anything it misses still
 * hits the classifier; this is purely a cost-saving layer.
 *
 * Import: uses z.toJSONSchema(GateDecisionSchema) — no zodOutputFormat.
 */

import { z } from "zod";
import type { GateCategory } from "./categories.js";
import { TAXONOMY_CATEGORIES } from "./categories.js";
import { GateDecisionSchema } from "./schema.js";

/** Output type for the prefilter check. */
type PrefilterResult =
  | { rejected: false }
  | { rejected: true; category: GateCategory; rationale: string };

/**
 * Pre-computed normalization: NFKC + strip zero-width/homoglyph confusables
 * (U+200B–U+200D, U+FEFF, U+0261 Latin small L with tail) + collapse runs of
 * whitespace to single space + lowercase.
 *
 * Used by both the public check() and the tests.
 */
export function normalize(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip zero-width and confusables
      .replace(/[​-‍﻿ɡ]/g, "")
      // Collapse whitespace runs and lowercase
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/**
 * Check suggestion text against the prefilter.
 *
 * Returns { rejected: false } if no pattern matched — the text still hits
 * the Sonnet classifier. Returns a rejection if a known-bad pattern is found.
 */
export function prefilterCheck(text: string): PrefilterResult {
  const norm = normalize(text);

  // ─── Prompt injection triggers ─────────────────────────────────────
  // These catch direct instructions to bypass safety rules.
  if (
    /ignore\s+(all|any|your|all\s+previous|all\s+prior|all\s+earlier)?\s*(instructions|rules|directions|guidelines|prompts|commands)\b/.test(
      norm,
    )
  ) {
    return {
      rejected: true,
      category: "prompt-injection-attempt",
      rationale: "Contains instruction to ignore system instructions — potential prompt injection",
    };
  }
  if (
    /disregard\s+(your\s+)?(rules|instructions|guidelines|safety)\b/.test(norm)
  ) {
    return {
      rejected: true,
      category: "prompt-injection-attempt",
      rationale: "Contains instruction to disregard safety rules — potential prompt injection",
    };
  }
  if (
    /reveal|print|show|output|display\s+(your\s+)?(system\s+)?(prompt|instructions|rules|system\s+message|core\s+directive)\b/.test(
      norm,
    )
  ) {
    return {
      rejected: true,
      category: "prompt-injection-attempt",
      rationale: "Attempts to extract system prompt — prompt injection",
    };
  }
  if (/you\s+are\s+now\s+(?:in\s+)?(?:developer\s+)?mode\b/.test(norm)) {
    return {
      rejected: true,
      category: "prompt-injection-attempt",
      rationale: "Activates developer mode — common prompt injection pattern",
    };
  }

  // ─── Malware / abuse keywords ──────────────────────────────────────
  // After normalization, these catch obvious malware requests.
  if (/\b(key\s*logger|keylogger|key\s*logger\s*tool)\b/.test(norm)) {
    return {
      rejected: true,
      category: "spam-malware",
      rationale: "Requests malware (keylogger) — prohibited under spam/malware policy",
    };
  }
  if (/\b(ddos|distributed\s+denial\s+of\s+service|ddos\s+tool|ddos\s+attack|ddos\s+bot)\b/.test(norm)) {
    return {
      rejected: true,
      category: "spam-malware",
      rationale: "Requests DDoS tooling — prohibited under spam/malware policy",
    };
  }
  if (/\b(view\s*bot(ting)?|viewbot|auto\s*(follow|like|watch)\s*bot)\b/.test(norm)) {
    return {
      rejected: true,
      category: "spam-malware",
      rationale: "Requests view-bot or automation spam tool — prohibited under spam policy",
    };
  }
  if (/\b(phishing|phish\s*page|phish\s*kit)\b/.test(norm)) {
    return {
      rejected: true,
      category: "spam-malware",
      rationale: "Requests phishing tooling — prohibited under spam/malware policy",
    };
  }
  if (
    /\b(credential\s*(stealer|harvest)|password\s*(stealer|grabber|harvester)|token\s*grabber)\b/.test(
      norm,
    )
  ) {
    return {
      rejected: true,
      category: "spam-malware",
      rationale: "Requests credential-harvesting tooling — prohibited under spam/malware policy",
    };
  }

  // No pattern matched — pass through to the Sonnet classifier.
  return { rejected: false };
}

/**
 * Zod schema for prefilter rejection responses — used to validate the
 * prefilterCheck return shape in tests (belt-and-suspenders).
 */
export const PrefilterRejectionSchema = z
  .object({
    rejected: z.literal(true),
    category: z.enum(TAXONOMY_CATEGORIES as unknown as [string, ...string[]]),
    rationale: z.string(),
  })
  .strict();

/** Zod schema for the "pass" result. */
export const PrefilterPassSchema = z
  .object({
    rejected: z.literal(false),
  })
  .strict();

/** Validate a prefilter result against its schema. Returns true if valid. */
export function validatePrefilterResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { rejected?: boolean; category?: string; rationale?: string };
  if (r.rejected === false) return PrefilterPassSchema.safeParse(r).success;
  if (r.rejected === true) return PrefilterRejectionSchema.safeParse(r).success;
  return false;
}
