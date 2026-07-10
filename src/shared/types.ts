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

/**
 * Where a candidate instruction originated. All sources funnel through ONE gate (COMP-01).
 *
 * "orchestrator" (Phase 3, 03-RESEARCH.md Open Question 2 / D3-06) is the source
 * for COMP-02's build-plan re-screen: the build agent's OWN generated plan text
 * routed back through classify() before any code is written. It's a distinct,
 * clearer audit-trail value than reusing "operator" — audit_log.source has no
 * CHECK constraint, so adding it is schema-safe.
 */
export type CandidateSource =
  | "chat"
  | "channel_points"
  | "donation"
  | "chaos"
  | "operator"
  | "orchestrator";

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

/**
 * The small, stable public status vocabulary for the build pipeline (BUILD-02,
 * D3-08, PRES-04). This is the ONLY set of words that ever crosses from the
 * orchestrator into the overlay/console/chat/audit surfaces — raw Agent SDK
 * message/hook types never leak past src/orchestrator/progress-events.ts, the
 * fixed translation table (the PILL_BY_MODE analog).
 *
 * "refused" is a first-class narrated event (a mid-build model refusal), NOT an
 * error — kept distinct from "failed" so the show narrates it honestly (D3-08).
 */
export type PipelineStage =
  | "queued"
  | "researching"
  | "planning"
  | "building"
  | "done"
  | "failed"
  | "refused";

/**
 * Overlay/console-facing view of a build's current status (PRES-02/04). `title`
 * is the chat-derived task text; it is rendered textContent-only downstream
 * (dom-safety invariant) and never interpolated into any instruction.
 */
export interface BuildStatusView {
  taskId: string;
  title: string;
  stage: PipelineStage;
}

/**
 * Build-pipeline chat-narration surface (BUILD-03 / D3-08 / D3-09). Every method
 * is a single TRANSITION beat (one message per transition — never per-token /
 * per-file churn, which belongs to the overlay + preview), so a build failure is
 * NEVER silent dead air. The Narrator (src/ingestion/narration.ts) implements
 * these; the build session (src/orchestrator/build-session.ts) calls them.
 * `title` is the chat-derived task text — the narrator truncates it to 60 chars.
 */
export interface BuildNarrator {
  /** Build picked up → researching (03-UI-SPEC "Build picked up"). */
  buildPickedUp(title: string): void;
  /** Stage → planning. */
  stagePlanning(title: string): void;
  /** Stage → building. */
  stageBuilding(title: string): void;
  /** Build done — live on screen. */
  buildDone(title: string): void;
  /** Mid-build model refusal (D3-08, first-class narrated event, never an error). */
  buildRefused(title: string): void;
  /** A transient build failure — auto-retrying once (D3-09). */
  buildRetryingOnce(title: string): void;
  /** Retry used up — the streamer is calling retry or skip (D3-09). */
  buildDeciding(title: string): void;
  /** The streamer chose retry. */
  buildRetryChosen(title: string): void;
  /** The streamer chose skip. */
  buildSkipped(title: string): void;
  /** COMP-02 rejected the plan/output — can't build that one (D3-06/D3-07). */
  comp02Rejected(title: string): void;
  /** A streamer veto aborted an in-flight build (D3-10). */
  buildVetoed(title: string): void;
}
