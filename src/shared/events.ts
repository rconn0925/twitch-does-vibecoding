/**
 * Internal event bus vocabulary. Every emitter/listener MUST use these constants —
 * never string literals — so the vocabulary stays greppable and typo-proof.
 */

/** Emitted by StreamModeMachine on every mode change (normal or forced). */
export const STATE_CHANGED = "state:changed" as const;

/** Emitted when a halt fires (hotkey or console), after the HALTED transition. */
export const HALT_TRIGGERED = "halt:triggered" as const;

/** Emitted per compliance-gate decision (plan 01-02). */
export const GATE_DECISION = "gate:decision" as const;

/** Emitted when a held-for-review item is approved/rejected/expired (plan 01-05). */
export const REVIEW_RESOLVED = "review:resolved" as const;

/**
 * D-15 vocabulary placeholder: a project-switch instruction was requested.
 * Mechanics land in Phase 2 (chat consensus vote) and Phase 4 (donation grant).
 */
export const PROJECT_SWITCH_REQUESTED = "project-switch:requested" as const;

/** Emitted by RoundManager when a voting round opens, with its RoundSnapshot (plan 02-01). */
export const ROUND_OPENED = "round:opened" as const;

/** Emitted by RoundManager when a round closes or is discarded, with the final RoundSnapshot. */
export const ROUND_CLOSED = "round:closed" as const;

/** Emitted per durable vote write — AFTER the SQLite upsert commits (D2-14). */
export const VOTE_RECORDED = "round:vote-recorded" as const;

export type AppEvent =
  | typeof STATE_CHANGED
  | typeof HALT_TRIGGERED
  | typeof GATE_DECISION
  | typeof REVIEW_RESOLVED
  | typeof PROJECT_SWITCH_REQUESTED
  | typeof ROUND_OPENED
  | typeof ROUND_CLOSED
  | typeof VOTE_RECORDED;
