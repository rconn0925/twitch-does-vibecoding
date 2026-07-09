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
