/**
 * Prefilter — cheap fast-fail ahead of the Sonnet classifier call.
 *
 * Normalizes the input (NFKC, strip zero-width/confusable characters,
 * hyphens to spaces, collapse whitespace, lowercase) and matches a
 * maintained regex list against both the normalized text and a fully
 * whitespace-stripped ("compact") form of it.
 *
 * This layer only exists to save API calls on obvious junk. It is NOT the
 * safety net: anything it misses still hits the Sonnet classifier.
 */

import { z } from "zod";
import type { GateCategory } from "./categories.js";
import { TAXONOMY_CATEGORIES } from "./categories.js";

/** Output type for the prefilter check. */
type PrefilterResult =
  | { rejected: false }
  | { rejected: true; category: GateCategory; rationale: string };

/**
 * Normalize text for pattern matching:
 * 1. NFKC (folds fullwidth/compatibility forms to ASCII)
 * 2. Strip zero-width characters (U+200B–U+200D, U+FEFF) and the U+0261
 *    homoglyph confusable (Latin small script g)
 * 3. Replace hyphens/dashes (ASCII hyphen-minus, U+2010–U+2015, U+2212)
 *    with a SPACE so multi-word patterns still match hyphenated forms
 *    ("view-bot" → "view bot", "ddos-tool" → "ddos tool")
 * 4. Collapse whitespace runs to a single space, trim, lowercase
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍﻿ɡ]/g, "")
    .replace(/[-‐-―−]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A prefilter pattern: regex plus the rejection it produces on match. */
interface PrefilterPattern {
  pattern: RegExp;
  category: GateCategory;
  rationale: string;
}

/**
 * Patterns matched against the NORMALIZED text (word boundaries intact).
 */
const NORMALIZED_PATTERNS: readonly PrefilterPattern[] = [
  // ─── Prompt-injection triggers ───────────────────────────────────────
  {
    pattern:
      /ignore\s+(all|any|your|all\s+previous|all\s+prior|all\s+earlier)?\s*(instructions|rules|directions|guidelines|prompts|commands)\b/,
    category: "prompt-injection-attempt",
    rationale: "Contains instruction to ignore system instructions — potential prompt injection",
  },
  {
    pattern: /disregard\s+(your\s+)?(rules|instructions|guidelines|safety)\b/,
    category: "prompt-injection-attempt",
    rationale: "Contains instruction to disregard safety rules — potential prompt injection",
  },
  {
    // Grouped alternation: the verb list must be parenthesized so bare
    // "show"/"reveal"/"print" in benign text ("show a snake game") does
    // not match. The verb must target a system prompt/instructions noun.
    pattern:
      /\b(reveal|print|show|output|display)\s+((your|the)\s+)?system\s+(prompt|prompts|instructions|rules|message)\b|\b(reveal|print|show|output|display)\s+your\s+(prompt|prompts|instructions|rules)\b/,
    category: "prompt-injection-attempt",
    rationale: "Attempts to extract system prompt — prompt injection",
  },
  {
    pattern: /you\s+are\s+now\s+(in\s+)?(developer\s+)?mode\b/,
    category: "prompt-injection-attempt",
    rationale: "Activates developer mode — common prompt injection pattern",
  },
  // ─── Malware / abuse keywords ────────────────────────────────────────
  {
    pattern: /\bkey\s*logger\b/,
    category: "spam-malware",
    rationale: "Requests malware (keylogger) — prohibited under spam/malware policy",
  },
  {
    pattern: /\b(ddos|distributed\s+denial\s+of\s+service)\b/,
    category: "spam-malware",
    rationale: "Requests DDoS tooling — prohibited under spam/malware policy",
  },
  {
    pattern: /\b(view\s*bot(ting)?|auto\s*(follow|like|watch)\s*bot)\b/,
    category: "spam-malware",
    rationale: "Requests view-bot or automation spam tool — prohibited under spam policy",
  },
  {
    pattern: /\b(phishing|phish\s*(page|kit|site))\b/,
    category: "spam-malware",
    rationale: "Requests phishing tooling — prohibited under spam/malware policy",
  },
  {
    pattern:
      /\b(credential\s*(stealer|harvester|harvest)|password\s*(stealer|grabber|harvester)|token\s*grabber)\b/,
    category: "spam-malware",
    rationale: "Requests credential-harvesting tooling — prohibited under spam/malware policy",
  },
];

/**
 * Patterns matched against the COMPACT form (all non-alphanumerics removed),
 * which catches spacing obfuscation like "k e y l o g g e r".
 *
 * Word boundaries do not exist in compact text, so only high-distinctiveness
 * strings belong here. Deliberately excluded (false-positive risk once
 * boundaries vanish): bare "ddos" ("add dos and don'ts" → "adddos…") and
 * "viewbot" ("review bot" → "reviewbot"). The Sonnet classifier remains the
 * safety net for anything this list skips.
 */
const COMPACT_PATTERNS: readonly PrefilterPattern[] = [
  {
    pattern: /keylogger/,
    category: "spam-malware",
    rationale: "Requests malware (keylogger) — prohibited under spam/malware policy",
  },
  {
    pattern: /ddos(tool|attack|bot|er)/,
    category: "spam-malware",
    rationale: "Requests DDoS tooling — prohibited under spam/malware policy",
  },
  {
    pattern: /phishing(page|kit|site)?/,
    category: "spam-malware",
    rationale: "Requests phishing tooling — prohibited under spam/malware policy",
  },
  {
    pattern: /credential(stealer|harvester)|password(stealer|grabber|harvester)|tokengrabber/,
    category: "spam-malware",
    rationale: "Requests credential-harvesting tooling — prohibited under spam/malware policy",
  },
];

/**
 * Check suggestion text against the prefilter.
 *
 * Returns { rejected: false } if no pattern matched — the text still goes to
 * the Sonnet classifier. Returns a rejection if a known-bad pattern is found.
 */
export function prefilterCheck(text: string): PrefilterResult {
  const norm = normalize(text);

  for (const { pattern, category, rationale } of NORMALIZED_PATTERNS) {
    if (pattern.test(norm)) {
      return { rejected: true, category, rationale };
    }
  }

  // Compact form: strip everything non-alphanumeric to defeat spacing and
  // punctuation obfuscation ("k e y l o g g e r", "k.e.y.l.o.g.g.e.r").
  const compact = norm.replace(/[^a-z0-9]/g, "");
  for (const { pattern, category, rationale } of COMPACT_PATTERNS) {
    if (pattern.test(compact)) {
      return { rejected: true, category, rationale };
    }
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
