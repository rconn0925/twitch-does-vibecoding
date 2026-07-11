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

/**
 * Phase 4 paid-influence + chaos vocabulary (PAID-01/02/03/04, CHAOS-01).
 * Window beats: a paid/redemption control window opened, closed (natural expiry),
 * was revoked by the streamer, or a request was denied (already-active/cooldown —
 * never silent, D-05). Chaos beats: the streamer toggled chaos mode, or a
 * uniform-random pick was made. Emitted immediately (low-frequency show beats,
 * never debounced — 04-UI-SPEC push cadence).
 */
export const WINDOW_OPENED = "window:opened" as const;
export const WINDOW_CLOSED = "window:closed" as const;
export const WINDOW_REVOKED = "window:revoked" as const;
export const WINDOW_DENIED = "window:denied" as const;
export const CHAOS_TOGGLED = "chaos:toggled" as const;
export const CHAOS_PICK = "chaos:pick" as const;

/**
 * Auto-cycle lifecycle beat (quick-t5k, D-04/A2): the scheduler's enabled flag
 * or suggest-phase state changed — toggle, phase begin, phase end, halt park.
 * Low-frequency show beats: consoles/overlays push IMMEDIATELY on it (never
 * the vote-tally debounce).
 */
export const AUTO_CYCLE_CHANGED = "auto-cycle:changed" as const;

/**
 * Emitted by CandidatePool after add/evict/remove (quick-v4e) so the overlay's
 * what's-coming page pushes fresh state. Low-frequency by construction: adds
 * are serialized behind classifier calls (+ the per-user intake cooldown), and
 * removes are round-open/chaos beats — never a per-vote flood.
 */
export const POOL_CHANGED = "pool:changed" as const;

/**
 * Emitted by the BuilderFeed after append/clear (quick-x7d) so the overlay's
 * /builder page pushes fresh state. Low-frequency by construction: batch
 * approvals are serialized behind COMP-02 classifier calls, and stage beats
 * are a handful per build — never a per-token flood.
 */
export const BUILDER_FEED_CHANGED = "builder-feed:changed" as const;

export type AppEvent =
  | typeof STATE_CHANGED
  | typeof HALT_TRIGGERED
  | typeof GATE_DECISION
  | typeof REVIEW_RESOLVED
  | typeof PROJECT_SWITCH_REQUESTED
  | typeof ROUND_OPENED
  | typeof ROUND_CLOSED
  | typeof VOTE_RECORDED
  | typeof WINDOW_OPENED
  | typeof WINDOW_CLOSED
  | typeof WINDOW_REVOKED
  | typeof WINDOW_DENIED
  | typeof CHAOS_TOGGLED
  | typeof CHAOS_PICK
  | typeof AUTO_CYCLE_CHANGED
  | typeof POOL_CHANGED
  | typeof BUILDER_FEED_CHANGED;
