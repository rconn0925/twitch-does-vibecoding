/**
 * Destructive-intent matcher (quick-260716-rll).
 *
 * Live incident 2026-07-16 ~19:41 (audit ids 885-891): the gate-APPROVED
 * suggestion "I want you to delete the whole app" was solo-picked and headed
 * for the build agent — only an unrelated infra failure stopped it from wiping
 * the VOIDFARER workspace. The compliance gate is CORRECT to approve such text
 * (nothing ToS-violating about it); interception is a SHOW-POLICY concern that
 * lives here, at the build-dispatch seam, never in src/compliance/** (locked
 * decision 1 — the Sonnet classifier surface stays byte-untouched).
 *
 * Policy (asymmetric by design):
 *  - false NEGATIVES fall through to a normal build — today's behavior;
 *  - false POSITIVES save-and-close the project — non-destructive and
 *    recoverable (the gallery repo stays published; chat can build anew).
 *
 * Mechanics: a destructive VERB must reach a whole-project TARGET across a
 *   BOUNDED connector gap of determiners/quantifiers only. An arbitrary noun
 *   between verb and target breaks the bridge ("add a reset button to the
 *   app" never matches), and a possessive target is the OWNER of something,
 *   not the object ("remove the app's dark mode" never matches). Fixed
 *   alternations + a bounded word-class gap keep matching linear and total —
 *   no user-controlled pattern construction, never throws (T-rll-01).
 *
 * This module is a PURE text predicate: no imports from pipeline/gate/queue
 * modules, no state, no I/O.
 */

const VERBS = "delete|wipe|erase|remove|destroy|nuke|reset|clear";

/**
 * Whole-project targets. Possessive negative lookahead: "the app's dark mode"
 * talks about something the app OWNS — never the app itself.
 */
const TARGETS = "app|application|repo|repository|project|codebase|workspace|everything";

/**
 * The ONLY words allowed between verb and target: determiners, possessive
 * pronouns, and whole-ness quantifiers. Anything else (a noun, an adjective
 * like "red"/"second") breaks the bridge.
 */
const CONNECTORS = "the|this|that|it|its|my|our|your|whole|entire|current|all|of";

/** e.g. "delete the whole app", "remove the entire repository", "erase everything". */
const TARGETED_WIPE = new RegExp(
  `\\b(?:${VERBS})\\b(?:\\s+(?:${CONNECTORS})\\b)*\\s+(?:${TARGETS})\\b(?!['’]s)`,
  "i",
);

/** Explicit total-phrase forms: "clear it all", "wipe all of it". */
const IT_ALL_WIPE = new RegExp(
  `\\b(?:${VERBS})\\b(?:\\s+(?:${CONNECTORS})\\b)*\\s+(?:it\\s+all|all\\s+of\\s+it)\\b`,
  "i",
);

/**
 * True when gate-approved text asks to wipe/erase/reset the whole app, repo,
 * or project. Deterministic, total, case-insensitive, never throws.
 */
export function isDestructiveIntent(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  try {
    return TARGETED_WIPE.test(text) || IT_ALL_WIPE.test(text);
  } catch {
    // Total by contract: any unexpected engine failure means "no interception"
    // — the false-negative side of the policy, never a crash in the show loop.
    return false;
  }
}
