/**
 * Shared type vocabulary for Twitch Does Vibecoding.
 *
 * These are the contracts plans 01-02..01-05 implement against — do not rename
 * without updating all five Phase 1 plans.
 */

/** The six stream modes. HALTED is reachable synchronously from every state (D-02). */
export type StreamMode =
  | "IDLE"
  | "VOTING_ROUND"
  | "BUILD_IN_PROGRESS"
  | "FREE_REIGN_WINDOW"
  | "CHAOS_MODE"
  | "HALTED";

/** Where a candidate instruction originated. All sources funnel through ONE gate (COMP-01). */
export type CandidateSource = "chat" | "channel_points" | "donation" | "chaos" | "operator";

/**
 * D-15: "project-switch" is a first-class instruction type, distinct from a normal
 * suggestion. The switch mechanics land in Phases 2 (chat consensus vote) and 4
 * (large-donation grant); Phase 1 only defines the vocabulary.
 */
export type CandidateKind = "suggestion" | "project-switch";

/** The normalized candidate shape every ingestion path (current or future) reduces to. */
export interface SuggestionCandidate {
  id: string;
  source: CandidateSource;
  kind: CandidateKind;
  twitchUsername: string | null;
  text: string;
  submittedAtMs: number;
}

/** D-08: honest three-state gate vocabulary — viewers see "held for streamer review". */
export type GateDecision = "approved" | "rejected" | "held-for-review";

/**
 * The 15-value taxonomy union (13 ToS categories + prompt-injection-attempt +
 * feasibility) is finalized in plan 01-02's src/compliance/categories.ts.
 * TODO(01-02): narrow this alias to the categories.ts union once it exists.
 */
export type GateCategory = string;

export interface GateResult {
  decision: GateDecision;
  category: GateCategory | null;
  rationale: string;
}

declare const QueuedTaskBrand: unique symbol;

/**
 * A candidate that has provably passed through the compliance gate (COMP-01).
 *
 * The `as QueuedTask` brand assertion is only permitted inside
 * src/compliance/gate.ts — enforced by tests/invariants/single-funnel.test.ts
 * (plan 01-04). No other module may construct this type.
 */
export type QueuedTask = SuggestionCandidate & { readonly [QueuedTaskBrand]: true };

/** D-18: optional one-tap reason tags on vetoes/halts — never blocking. */
export type ReasonTag = "tos-risk" | "boring" | "too-big" | "gut-feeling" | "other";

/** D-04: triage-then-choose recovery from HALTED. Nothing auto-resumes. */
export type RecoveryAction = "resume" | "discard-and-resume" | "reset-to-idle";

/** Context frozen at the moment of a halt, for the D-04 triage view. */
export interface HaltContext {
  source: "hotkey" | "console";
  reasonTag: ReasonTag | null;
  frozen: StateSnapshot;
}

/** Point-in-time view of the state machine — pushed to the operator console over ws. */
export interface StateSnapshot {
  mode: StreamMode;
  activeTaskId: string | null;
  activeTaskPid: number | null;
  queuedTaskIds: string[];
  haltContext: HaltContext | null;
}

/** Lifecycle status of a voting round row (Phase 2). 'discarded' = halted then dropped (D2-16). */
export type RoundStatus = "open" | "closed" | "discarded";

/** One numbered voting option in a round: the pooled candidate plus its live vote count. */
export interface RoundCandidate {
  /** 1-based option number, matching chat's `!vote N`. */
  option: number;
  candidate: SuggestionCandidate;
  result: GateResult;
  votes: number;
}

/**
 * Point-in-time view of a voting round — pushed to console/overlay surfaces.
 *
 * Votes are keyed by Twitch numeric user id (EventSub chatterId), NEVER by
 * display name — display names are mutable/spoofable (D2-15, RESEARCH.md
 * Pitfall 2). One vote per viewer per round; a revote overwrites.
 */
export interface RoundSnapshot {
  roundId: number;
  status: RoundStatus;
  /** True while a halt has frozen the round timer (D2-16). */
  frozen: boolean;
  candidates: RoundCandidate[];
  openedAtMs: number;
  endsAtMs: number;
  /** Persisted remaining time while frozen; null when the timer is live. */
  remainingMs: number | null;
  winnerOption: number | null;
  tiebreak: boolean;
  totalVotes: number;
  /**
   * True only when a closed round's winner actually reached the build queue
   * (WR-02 broadcast honesty, D2-18): the funnel can refuse a winner
   * (halted, or stale → re-classification), and narration must not announce
   * "Queued for the build" for a build that never queued. Always false
   * while the round is open.
   */
  winnerQueued: boolean;
}
