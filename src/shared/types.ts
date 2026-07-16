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
 *
 * quick-q5n: "project-switch" is now LIVE as chat's `!build <idea>` new-project
 * intent, and "revert" is the chat-voted undo-last-change intent (`!revert` /
 * `!undo`). A revert candidate carries ONLY the fixed server-composed
 * REVERT_REQUEST_TEXT (command-parser.ts) — never chat-derived free text.
 *
 * quick-t8k: "swap" is the chat-voted portfolio swap (`!swapbuild <name>`).
 * Its text is a gate-screened project-NAME reference — chat-derived, so it
 * rides the ONE funnel like all tier-1 text; resolution against
 * project_repos.repo_name happens at drain time in the kind router.
 *
 * quick-260711-ly4: "chaos" is the chat-voted CHAOS ballot option (`!chaos`).
 * A single server-composed CHAOS candidate (fixed CHAOS_CANDIDATE_TEXT, zero
 * chat-derived bytes) competes in the normal vote round like revert/swap. When
 * it WINS, the drain-time kind router activates the timed chaos window (5 min
 * of random picks) INSTEAD of building — the one deviation from revert/swap
 * (see main.ts drainVoteQueue). Winning is the ONLY chat path to chaos.
 */
export type CandidateKind = "suggestion" | "project-switch" | "revert" | "swap" | "chaos";

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
 * Phase 4 paid-influence control window (PAID-01/02/03/04, D-03/D-11/D-12).
 *
 * ONE ControlWindow FSM backs both donation and channel-points windows; they
 * differ only in `trigger`. A window is an OPEN sponsored slot (D-11) — any
 * gate-compliant chatter submission during the window bypasses the vote; it is
 * never private donor control. The window runs its FULL amount-proportional
 * duration (D-12) — `endsAtMs` is absolute and crash-safe.
 */
export type WindowTrigger = "donation" | "channel_points";

/** Lifecycle status of a control_windows row. 'active' → 'expired' | 'revoked'. */
export type WindowStatus = "active" | "expired" | "revoked";

/**
 * CONSOLE-side view of an active control window (the honest, full-detail
 * projection). `amountLabel` is the human-readable amount→duration mapping text
 * (e.g. "$5.00 -> 1:00 window (capped at 5:00)") shown to the streamer only —
 * it is deliberately DISTINCT from the coarse public OverlayState.controlWindow
 * projection (04-04: donorDisplayName + endsAtMs only), so no donation amount
 * ever reaches the broadcast wire (T-04-03 Information-Disclosure mitigation).
 */
export interface ControlWindowSnapshot {
  donorDisplayName: string;
  trigger: WindowTrigger;
  /** Console-only honest mapping text, e.g. "$5.00 -> 1:00 window (capped at 5:00)". */
  amountLabel: string;
  durationMs: number;
  /** ABSOLUTE close time (Date.now()-based) — single source of truth, crash-safe (D-06/D-12). */
  endsAtMs: number;
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
  /**
   * How the current build was selected — drives the overlay provenance chip
   * (04-UI-SPEC, PAID-01/02/CHAOS-01). Fixed vocabulary, never free text:
   * "vote" (normal loop), "donation"/"channel_points" (a paid/redemption control
   * window), or "chaos" (a random pick). Optional so existing Phase 3 producers
   * (which predate paid/chaos) stay valid; Wave 2/4 supplies it and treats an
   * absent value as "vote".
   */
  source?: "vote" | "donation" | "channel_points" | "chaos";
  /**
   * Display-only attribution (quick-260716-g8p): the suggester's
   * twitchUsername — ALREADY public on the pool wire ({text, username}) — so
   * the NOW BUILDING panel can credit the idea. SERVER-NULLED for paid-window
   * builds (donation | channel_points): the T-04-13 coarse public projection
   * has never carried WHO issued a paid-window instruction, and this field
   * must not widen it (T-g8p-01). Also null for operator-injected tasks.
   * Optional so legacy producers/fakes stay valid; absent renders no line.
   */
  suggestedBy?: string | null;
}

/**
 * Phase 5 build-history changelog vocabulary (HIST-01, D-01/D-03).
 *
 * BuildProvenance mirrors BuildStatusView.source's fixed set (the overlay
 * provenance chip) — how a completed build was selected. It is threaded
 * EXPLICITLY from each build-trigger site into startBuild()/finalize(), never
 * mode-inferred (T-05-03 mis-attribution mitigation).
 */
export type BuildProvenance = "vote" | "donation" | "channel_points" | "chaos";

/**
 * The honest terminal outcome of a COMPLETED build, 1:1 with the pipeline's
 * terminal stage (done->built, failed->failed, refused->refused). An aborted /
 * vetoed build is NEITHER — it produces no build_history row at all (CR-01).
 *
 * quick-q5n adds "reverted": a chat-voted rollback of the last mirror commit
 * (no agent build ran — the host-side gallery publisher applied a git revert
 * and re-synced the workspace).
 */
export type BuildResult = "built" | "refused" | "failed" | "reverted";

/**
 * One durable, append-only changelog entry (a build_history row). `title` is the
 * gate-APPROVED QueuedTask.text ONLY (D-03) — raw pre-gate suggestion text never
 * reaches this shape. `createdAtMs` is the completion timestamp; the stream-night
 * grouping key is derived from it on read (D-02), so there is no session column.
 */
export interface BuildHistoryRow {
  id: number;
  taskId: string;
  title: string;
  provenance: BuildProvenance;
  result: BuildResult;
  createdAtMs: number;
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
  /** COMP-02 HELD the plan for streamer review — distinct from rejected (WR-03/D-08). */
  buildHeld(title: string): void;
  /** A streamer veto aborted an in-flight build (D3-10). */
  buildVetoed(title: string): void;
}
