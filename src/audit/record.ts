import type Database from "better-sqlite3";
import type {
  BuildHistoryRow,
  BuildProvenance,
  BuildResult,
  GateCategory,
  GateDecision,
  PipelineStage,
  ReasonTag,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";

/**
 * Append-only write helpers for the audit ledger (COMP-05, D-16).
 *
 * This module exposes INSERT and SELECT only — the ledger is the compliance
 * record of truth and past rows are never mutated (Repudiation mitigation
 * T-01-02). See src/audit/db.ts for the retention/purge provenance note.
 */

export interface AuditRecord {
  id: number;
  created_at_ms: number;
  event_type: string;
  source: string;
  twitch_username: string | null;
  suggestion_text: string | null;
  decision: string | null;
  category: string | null;
  rationale: string | null;
  stream_mode: string;
  task_id: string | null;
}

const INSERT_SQL = `
  INSERT INTO audit_log
    (created_at_ms, event_type, source, twitch_username, suggestion_text,
     decision, category, rationale, stream_mode, task_id)
  VALUES
    (@createdAtMs, @eventType, @source, @twitchUsername, @suggestionText,
     @decision, @category, @rationale, @streamMode, @taskId)
`;

interface InsertRow {
  createdAtMs: number;
  eventType: string;
  source: string;
  twitchUsername: string | null;
  suggestionText: string | null;
  decision: string | null;
  category: string | null;
  rationale: string | null;
  streamMode: string;
  taskId: string | null;
}

function insert(db: Database.Database, row: InsertRow): void {
  db.prepare(INSERT_SQL).run(row);
}

/** One row per halt (D-16): who triggered it, from what mode, optionally why (D-18). */
export function recordHalt(
  db: Database.Database,
  args: { source: "hotkey" | "console"; priorMode: StreamMode; reasonTag: ReasonTag | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "halt",
    source: args.source,
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: args.reasonTag,
    rationale: null,
    streamMode: args.priorMode,
    taskId: null,
  });
}

/** One row per operator veto of a queued/in-progress task. */
export function recordVeto(
  db: Database.Database,
  args: {
    taskId: string | null;
    suggestionText: string | null;
    twitchUsername: string | null;
    reasonTag: ReasonTag | null;
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "veto",
    source: "operator",
    twitchUsername: args.twitchUsername,
    suggestionText: args.suggestionText,
    decision: null,
    category: args.reasonTag,
    rationale: null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per compliance-gate decision, with the full picture (D-16). */
export function recordGateDecision(
  db: Database.Database,
  args: {
    candidate: SuggestionCandidate;
    decision: GateDecision;
    category: GateCategory | null;
    rationale: string;
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "gate_decision",
    source: args.candidate.source,
    twitchUsername: args.candidate.twitchUsername,
    suggestionText: args.candidate.text,
    decision: args.decision,
    category: args.category,
    rationale: args.rationale,
    streamMode: args.streamMode,
    taskId: null,
  });
}

/**
 * One row per D-02 intake refusal while HALTED — refusals are compliance
 * events too (COMP-05): the ledger shows what was turned away and when.
 */
export function recordSubmissionRefused(
  db: Database.Database,
  args: { candidate: SuggestionCandidate; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "submission_refused",
    source: args.candidate.source,
    twitchUsername: args.candidate.twitchUsername,
    suggestionText: args.candidate.text,
    decision: null,
    category: null,
    rationale: "Intake refused while stream is halted (D-02)",
    streamMode: args.streamMode,
    taskId: null,
  });
}

/**
 * One NEW row per review-queue resolution — the original held-for-review
 * decision row stays exactly as written (two-table split, RESEARCH.md Pitfall 5).
 * D-07 expiries land as 'review_expired'; streamer approve/reject as 'review_resolved'.
 */
export function recordReviewResolution(
  db: Database.Database,
  args: {
    reviewId: number;
    resolution: "approved" | "rejected" | "expired-unreviewed";
    suggestionText: string | null;
    twitchUsername: string | null;
    streamMode: StreamMode;
    /** Optional one-tap reason tag on destructive resolutions (D-18). */
    reasonTag?: ReasonTag | null;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: args.resolution === "expired-unreviewed" ? "review_expired" : "review_resolved",
    source: "operator",
    twitchUsername: args.twitchUsername,
    suggestionText: args.suggestionText,
    decision: args.resolution,
    category: args.reasonTag ?? null,
    rationale: null,
    streamMode: args.streamMode,
    taskId: String(args.reviewId),
  });
}

/**
 * One row per voting-round open (D2-01/COMP-05). Round lifecycle narration is
 * audit-ledger data; the vote ledger itself lives in the round_votes table.
 * `initiator` (quick-t5k) distinguishes auto-cycle opens from operator opens in
 * the free-text rationale — NO schema change (audit_log has no CHECK constraint).
 */
export function recordRoundOpened(
  db: Database.Database,
  args: {
    roundId: number;
    candidateCount: number;
    durationMs: number;
    streamMode: StreamMode;
    initiator: "auto" | "operator";
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "round_opened",
    source: "operator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: `Round opened with ${args.candidateCount} candidates, ${args.durationMs}ms duration, initiated by ${args.initiator}`,
    streamMode: args.streamMode,
    taskId: String(args.roundId),
  });
}

/**
 * One row per auto-cycle TOGGLE (quick-t5k D-04): the streamer paused/resumed
 * the hands-free round cadence. Mirrors recordChaosToggled's shape/idiom.
 */
export function recordAutoCycleToggled(
  db: Database.Database,
  args: { enabled: boolean; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "auto_cycle_toggled",
    source: "operator",
    twitchUsername: null,
    suggestionText: null,
    decision: args.enabled ? "enabled" : "disabled",
    category: null,
    rationale: `Auto-cycle ${args.enabled ? "enabled" : "disabled"}`,
    streamMode: args.streamMode,
    taskId: null,
  });
}

/**
 * One row per round close/discard, with the votes-summary JSON in the
 * rationale column (COMP-05: the ledger shows how each winner was chosen).
 */
export function recordRoundClosed(
  db: Database.Database,
  args: {
    roundId: number;
    winnerText: string | null;
    winnerOption: number | null;
    /** JSON string of the per-option tally, stored verbatim in rationale. */
    tallySummary: string;
    tiebreak: boolean;
    streamMode: StreamMode;
    /** True when this close is a recovery-triage discard, not a normal close (D2-16). */
    discarded?: boolean;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "round_closed",
    source: "operator",
    twitchUsername: null,
    suggestionText: args.winnerText,
    decision: args.discarded
      ? "discarded"
      : args.winnerOption === null
        ? "no-winner"
        : `winner-option-${args.winnerOption}`,
    category: args.tiebreak ? "tiebreak" : null,
    rationale: args.tallySummary,
    streamMode: args.streamMode,
    taskId: String(args.roundId),
  });
}

/**
 * One row per bounded-pool oldest-drop (D2-13) — a dropped suggestion is a
 * compliance-relevant disappearance and must be visible in the ledger.
 */
export function recordPoolDropped(
  db: Database.Database,
  args: { candidate: SuggestionCandidate; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "pool_dropped",
    source: "chat",
    twitchUsername: args.candidate.twitchUsername,
    suggestionText: args.candidate.text,
    decision: null,
    category: null,
    rationale: "Pool at capacity — oldest candidate dropped (D2-13)",
    streamMode: args.streamMode,
    taskId: null,
  });
}

// ── Phase 3: build-pipeline audit events (D3-13) ────────────────────────────
// Every pipeline-stage transition, COMP-02 decision, refusal, retry, skip, and
// sandbox teardown appends ONE row, all carrying source "orchestrator" and the
// task id. No schema column changes — audit_log has no CHECK constraints, so the
// new event_type/source values are schema-safe additions (only schema.sql's
// descriptive comment is extended). Each mirrors recordGateDecision's
// arg-object → insert() shape.

/** One row per pipeline-stage transition (BUILD-02, PRES-04): the stage in `decision`. */
export function recordPipelineStage(
  db: Database.Database,
  args: {
    taskId: string;
    stage: PipelineStage;
    streamMode: StreamMode;
    /** Optional SDK progress summary — display only, never parsed downstream. */
    summary?: string | null;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "pipeline_stage",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: args.stage,
    category: null,
    rationale: args.summary ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per COMP-02 build-plan re-screen decision (D3-06): re-uses the gate vocabulary. */
export function recordComp02Decision(
  db: Database.Database,
  args: {
    taskId: string;
    decision: GateDecision;
    category: GateCategory | null;
    rationale: string;
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "comp02_decision",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: args.decision,
    category: args.category,
    rationale: args.rationale,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per mid-build model refusal (D3-08): a first-class narrated event, not an error. */
export function recordBuildRefusal(
  db: Database.Database,
  args: { taskId: string; streamMode: StreamMode; rationale?: string | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "build_refused",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: args.rationale ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per build retry (D3-09): auto-retry-once, or streamer-chosen retry. */
export function recordBuildRetry(
  db: Database.Database,
  args: { taskId: string; streamMode: StreamMode; rationale?: string | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "build_retry",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: args.rationale ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per build skip (D3-09): the never-silent failure path chose skip. */
export function recordBuildSkip(
  db: Database.Database,
  args: { taskId: string; streamMode: StreamMode; rationale?: string | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "build_skip",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: args.rationale ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

/** One row per sandbox teardown (BUILD-04 / D3-10): the wsl --terminate abort primitive fired. */
export function recordSandboxTeardown(
  db: Database.Database,
  args: { taskId: string; streamMode: StreamMode; rationale?: string | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "sandbox_teardown",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: args.rationale ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

// ── Phase 4: paid-window + chaos lifecycle audit events (PAID-04, COMP-05) ───
// Every control-window beat (open/expire/revoke/deny) and every chaos beat
// (toggle/pick) appends ONE row — the never-silent doctrine carried from Phases
// 2/3. Window events carry source = the trigger ("donation" | "channel_points")
// so the ledger is filterable by influence path; chaos events carry "chaos"
// (picks) or "operator" (the streamer toggling the mode). No schema/CHECK change:
// audit_log has no CHECK constraint, so these new event_type/source values are
// schema-safe additions. Each mirrors recordRoundOpened's arg-object → insert()
// shape. The durable ledger itself lives in the control_windows table (schema.sql).

/** Trigger for a control window — donation tip or channel-points redemption (D-03). */
type WindowTriggerArg = "donation" | "channel_points";

/**
 * One row per paid/redemption window OPEN (PAID-04). The rationale carries the
 * human-readable amount→duration mapping text (D-04) so the ledger shows exactly
 * how much control the money/points bought.
 */
export function recordWindowOpened(
  db: Database.Database,
  args: {
    trigger: WindowTriggerArg;
    donorIdentifier: string;
    amountOrCost: number;
    durationMs: number;
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "window_opened",
    source: args.trigger,
    twitchUsername: args.donorIdentifier,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: `Amount/cost ${args.amountOrCost} -> ${args.durationMs}ms window`,
    streamMode: args.streamMode,
    taskId: null,
  });
}

/** One row per window natural EXPIRY (D-12: the full amount-proportional duration elapsed). */
export function recordWindowExpired(
  db: Database.Database,
  args: { trigger: WindowTriggerArg; donorIdentifier: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "window_expired",
    source: args.trigger,
    twitchUsername: args.donorIdentifier,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: "Window reached ends_at_ms — reverting to the normal loop (D-12)",
    streamMode: args.streamMode,
    taskId: null,
  });
}

/** One row per streamer REVOKE of an active window (PAID-03: revocable at any moment). */
export function recordWindowRevoked(
  db: Database.Database,
  args: { trigger: WindowTriggerArg; donorIdentifier: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "window_revoked",
    source: args.trigger,
    twitchUsername: args.donorIdentifier,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: "Window revoked by streamer — reverting to the normal loop",
    streamMode: args.streamMode,
    taskId: null,
  });
}

/**
 * One row per window DENIAL — a donation/redemption arriving while a window is
 * already active, inside the per-donor cooldown, or while the stream is NOT
 * IDLE (a voting round / build in progress) is turned away NEVER silently
 * (D-05/CR-01, never-silent doctrine). `reason` carries which guard fired:
 *   - "already-active" — a control window is already live (D-05)
 *   - "cooldown"       — the donor is inside the per-donor cooldown (D-04)
 *   - "not-idle"       — the show is mid-round / mid-build (CR-01): a real-money
 *                        event must leave a ledger trace even in this routine case
 */
export function recordWindowDenied(
  db: Database.Database,
  args: {
    trigger: WindowTriggerArg;
    donorIdentifier: string;
    reason: "already-active" | "cooldown" | "not-idle";
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "window_denied",
    source: args.trigger,
    twitchUsername: args.donorIdentifier,
    suggestionText: null,
    decision: null,
    category: args.reason,
    rationale: `Window request denied — ${args.reason} (D-05)`,
    streamMode: args.streamMode,
    taskId: null,
  });
}

/** One row per chaos-mode TOGGLE (CHAOS-01): the streamer flipped random selection on/off. */
export function recordChaosToggled(
  db: Database.Database,
  args: { enabled: boolean; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "chaos_toggled",
    source: "operator",
    twitchUsername: null,
    suggestionText: null,
    decision: args.enabled ? "enabled" : "disabled",
    category: null,
    rationale: `Chaos mode ${args.enabled ? "enabled" : "disabled"}`,
    streamMode: args.streamMode,
    taskId: null,
  });
}

/** One row per chaos PICK (CHAOS-01): a uniform-random selection from the filtered pool. */
export function recordChaosPick(
  db: Database.Database,
  args: { taskId: string; title: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "chaos_pick",
    source: "chaos",
    twitchUsername: null,
    suggestionText: args.title,
    decision: null,
    category: null,
    rationale: "Uniform-random pick from the gate-filtered pool (CHAOS-01)",
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}

// ── Phase 5: build-history changelog ledger (HIST-01, D-01/D-02/D-03) ────────
// A SEPARATE append-only table from audit_log — no VIEW over audit_log can
// losslessly reconstruct a changelog entry (D-01 VERDICT), so build_history gets
// its OWN INSERT/SELECT pair (NOT the audit_log-shaped insert() helper above).
// ONE row per COMPLETED build; recordBuildHistory is called ONLY from finalize()
// with an already gate-approved QueuedTask.text (D-03, T-05-01), never on abort
// (CR-01). Still insert/read only — the append-only ledger discipline holds (no
// mutating write path exists for this table at the application layer).

const INSERT_BUILD_HISTORY_SQL = `
  INSERT INTO build_history
    (task_id, title, provenance, result, created_at_ms)
  VALUES
    (@taskId, @title, @provenance, @result, @createdAtMs)
`;

/**
 * Append ONE build_history row for a completed build. `title` MUST be the
 * gate-APPROVED QueuedTask.text (D-03) — never raw pre-gate suggestion text.
 * `provenance` is threaded explicitly from the build-trigger site (T-05-03) and
 * `result` is the honest terminal outcome (T-05-02). Append-only: this insert is
 * the SOLE write path — no mutating counterpart exists.
 */
export function recordBuildHistory(
  db: Database.Database,
  args: { taskId: string; title: string; provenance: BuildProvenance; result: BuildResult },
): void {
  db.prepare(INSERT_BUILD_HISTORY_SQL).run({
    taskId: args.taskId,
    title: args.title,
    provenance: args.provenance,
    result: args.result,
    createdAtMs: Date.now(),
  });
}

interface BuildHistoryDbRow {
  id: number;
  task_id: string;
  title: string;
  provenance: string;
  result: string;
  created_at_ms: number;
}

/**
 * Read the changelog newest-first (created_at_ms DESC, id DESC) with a bounded
 * limit. `beforeMs` is the pagination cursor — only rows strictly older than it
 * (created_at_ms < beforeMs) are returned, mirroring listAuditRecords' clause
 * builder. The stream-night grouping is derived by the caller on read (D-02).
 */
export function listBuildHistory(
  db: Database.Database,
  args: { limit: number; beforeMs?: number },
): BuildHistoryRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: args.limit };
  if (args.beforeMs !== undefined) {
    clauses.push("created_at_ms < @beforeMs");
    params.beforeMs = args.beforeMs;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM build_history ${where} ORDER BY created_at_ms DESC, id DESC LIMIT @limit`,
    )
    .all(params) as BuildHistoryDbRow[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    provenance: r.provenance as BuildProvenance,
    result: r.result as BuildResult,
    createdAtMs: r.created_at_ms,
  }));
}

/** Read the ledger newest-first with optional filters. */
export function listAuditRecords(
  db: Database.Database,
  args: { limit: number; eventType?: string; decision?: string; sinceMs?: number },
): AuditRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: args.limit };
  if (args.eventType !== undefined) {
    clauses.push("event_type = @eventType");
    params.eventType = args.eventType;
  }
  if (args.decision !== undefined) {
    clauses.push("decision = @decision");
    params.decision = args.decision;
  }
  if (args.sinceMs !== undefined) {
    clauses.push("created_at_ms >= @sinceMs");
    params.sinceMs = args.sinceMs;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at_ms DESC, id DESC LIMIT @limit`)
    .all(params);
  return rows as AuditRecord[];
}
