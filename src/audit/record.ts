import type Database from "better-sqlite3";
import type {
  GateCategory,
  GateDecision,
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
 * One NEW row per review-queue resolution — the original held-for-review
 * decision row stays exactly as written (two-table split, RESEARCH.md Pitfall 5).
 */
export function recordReviewResolution(
  db: Database.Database,
  args: {
    reviewId: number;
    resolution: "approved" | "rejected" | "expired-unreviewed";
    suggestionText: string | null;
    twitchUsername: string | null;
    streamMode: StreamMode;
  },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "review_resolved",
    source: "operator",
    twitchUsername: args.twitchUsername,
    suggestionText: args.suggestionText,
    decision: args.resolution,
    category: null,
    rationale: null,
    streamMode: args.streamMode,
    taskId: String(args.reviewId),
  });
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
