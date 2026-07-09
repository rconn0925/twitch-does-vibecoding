/**
 * Held-for-review workflow (D-05/D-06/D-07) against the review_queue table.
 *
 * review_queue is the MUTABLE escalation work-queue; audit_log is the
 * append-only record of truth. Every resolution here INSERTS a new audit row
 * via src/audit/record.ts — the original gate_decision row is never touched
 * (two-table split, RESEARCH.md Pitfall 5).
 *
 * Rows persist the FULL candidate identity (candidate_id, source, kind,
 * submitted_at_ms, text, username) so approve() can reconstruct the exact
 * SuggestionCandidate — no joins, no lossy defaults (D-06).
 *
 * Status transitions: pending → approved | rejected | expired-unreviewed,
 * terminal thereafter.
 */

import type Database from "better-sqlite3";
import { recordReviewResolution } from "../audit/record.js";
import type { CandidatePool } from "../queue/pool.js";
import type {
  CandidateKind,
  CandidateSource,
  GateResult,
  ReasonTag,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";

/** A pending review item, camel-cased from its review_queue row. */
export interface ReviewItem {
  id: number;
  createdAtMs: number;
  candidateId: string;
  source: CandidateSource;
  kind: CandidateKind;
  submittedAtMs: number;
  text: string;
  twitchUsername: string | null;
  category: string;
  rationale: string;
}

/** Raw review_queue row shape (snake_case, as stored). */
interface ReviewRow {
  id: number;
  created_at_ms: number;
  candidate_id: string;
  source: string;
  kind: string;
  submitted_at_ms: number;
  suggestion_text: string;
  twitch_username: string | null;
  category: string;
  rationale: string;
  status: string;
  resolved_at_ms: number | null;
}

/** Deps for resolutions that need more than the db handle. */
export interface ReviewResolveDeps {
  pool: CandidatePool;
  /** Stream mode recorded on the resolution audit row. Defaults to "IDLE" when unwired. */
  streamMode?: StreamMode;
}

const DEFAULT_REVIEW_TTL_HOURS = 4;

/** D-07 TTL from REVIEW_TTL_HOURS env (default 4h), in milliseconds. */
export function reviewTtlMs(): number {
  const raw = process.env.REVIEW_TTL_HOURS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_TTL_HOURS;
  return hours * 3_600_000;
}

/**
 * Persist a held-for-review candidate with its FULL identity so approve()
 * can rebuild the exact SuggestionCandidate later (D-06). Returns the row id.
 */
export function insertHeld(
  db: Database.Database,
  candidate: SuggestionCandidate,
  result: GateResult,
): number {
  if (result.decision !== "held-for-review") {
    throw new Error(`insertHeld requires a held-for-review result, got "${result.decision}"`);
  }
  if (result.category === null) {
    throw new Error("insertHeld requires a non-null category (D-12 escalate-eligible)");
  }
  const info = db
    .prepare(
      `INSERT INTO review_queue
         (created_at_ms, candidate_id, source, kind, submitted_at_ms,
          suggestion_text, twitch_username, category, rationale)
       VALUES
         (@createdAtMs, @candidateId, @source, @kind, @submittedAtMs,
          @suggestionText, @twitchUsername, @category, @rationale)`,
    )
    .run({
      createdAtMs: Date.now(),
      candidateId: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      submittedAtMs: candidate.submittedAtMs,
      suggestionText: candidate.text,
      twitchUsername: candidate.twitchUsername,
      category: result.category,
      rationale: result.rationale,
    });
  return Number(info.lastInsertRowid);
}

/**
 * Streamer approves a held item: resolve the row, insert a review_resolved
 * audit row, reconstruct the ORIGINAL SuggestionCandidate from the row's
 * persisted identity, and re-enter it into the candidate pool (D-06).
 */
export function approve(db: Database.Database, deps: ReviewResolveDeps, reviewId: number): void {
  const row = resolvePendingRow(db, reviewId, "approved");
  recordReviewResolution(db, {
    reviewId,
    resolution: "approved",
    suggestionText: row.suggestion_text,
    twitchUsername: row.twitch_username,
    streamMode: deps.streamMode ?? "IDLE",
  });
  const candidate: SuggestionCandidate = {
    id: row.candidate_id,
    source: row.source as CandidateSource,
    kind: row.kind as CandidateKind,
    twitchUsername: row.twitch_username,
    text: row.suggestion_text,
    submittedAtMs: row.submitted_at_ms,
  };
  deps.pool.add(candidate, {
    decision: "approved",
    category: null,
    rationale: `Approved by streamer review (review #${reviewId})`,
  });
}

/** Streamer rejects a held item: resolve the row + one audit row (optional D-18 tag). */
export function reject(
  db: Database.Database,
  reviewId: number,
  streamMode: StreamMode = "IDLE",
  reasonTag: ReasonTag | null = null,
): void {
  const row = resolvePendingRow(db, reviewId, "rejected");
  recordReviewResolution(db, {
    reviewId,
    resolution: "rejected",
    suggestionText: row.suggestion_text,
    twitchUsername: row.twitch_username,
    streamMode,
    reasonTag,
  });
}

/** Snapshot of one review row (any status) — used by the console's D-18 tag follow-up. */
export interface ReviewRowSnapshot {
  id: number;
  status: "pending" | "approved" | "rejected" | "expired-unreviewed";
  text: string;
  twitchUsername: string | null;
}

/** Look up a review row by id regardless of status. Returns undefined when absent. */
export function getReview(db: Database.Database, reviewId: number): ReviewRowSnapshot | undefined {
  const row = db.prepare("SELECT * FROM review_queue WHERE id = ?").get(reviewId) as
    | ReviewRow
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status as ReviewRowSnapshot["status"],
    text: row.suggestion_text,
    twitchUsername: row.twitch_username,
  };
}

/**
 * D-07: mark pending items older than ttlMs as expired-unreviewed, one
 * review_expired audit row each. Returns the number of items expired.
 */
export function expireStale(
  db: Database.Database,
  ttlMs: number,
  streamMode: StreamMode = "IDLE",
): number {
  const cutoff = Date.now() - ttlMs;
  const stale = db
    .prepare("SELECT * FROM review_queue WHERE status = 'pending' AND created_at_ms <= ?")
    .all(cutoff) as ReviewRow[];
  for (const row of stale) {
    expireRow(db, row, streamMode);
  }
  return stale.length;
}

/**
 * D-07 "review queue starts clean each stream night": expire EVERY pending
 * item. Wired into main.ts startup by plan 01-04. Returns the count expired.
 */
export function expireAllPending(db: Database.Database, streamMode: StreamMode = "IDLE"): number {
  const pending = db
    .prepare("SELECT * FROM review_queue WHERE status = 'pending'")
    .all() as ReviewRow[];
  for (const row of pending) {
    expireRow(db, row, streamMode);
  }
  return pending.length;
}

/** All pending review items, oldest first. */
export function listPending(db: Database.Database): ReviewItem[] {
  const rows = db
    .prepare("SELECT * FROM review_queue WHERE status = 'pending' ORDER BY created_at_ms, id")
    .all() as ReviewRow[];
  return rows.map((row) => ({
    id: row.id,
    createdAtMs: row.created_at_ms,
    candidateId: row.candidate_id,
    source: row.source as CandidateSource,
    kind: row.kind as CandidateKind,
    submittedAtMs: row.submitted_at_ms,
    text: row.suggestion_text,
    twitchUsername: row.twitch_username,
    category: row.category,
    rationale: row.rationale,
  }));
}

/**
 * Atomically move a PENDING row to a terminal status and return its prior
 * contents. Throws if the row does not exist or is already terminal.
 */
function resolvePendingRow(
  db: Database.Database,
  reviewId: number,
  status: "approved" | "rejected" | "expired-unreviewed",
): ReviewRow {
  const row = db.prepare("SELECT * FROM review_queue WHERE id = ?").get(reviewId) as
    | ReviewRow
    | undefined;
  if (!row) {
    throw new Error(`review item #${reviewId} not found`);
  }
  if (row.status !== "pending") {
    throw new Error(
      `review item #${reviewId} is already "${row.status}" — resolutions are terminal (D-05)`,
    );
  }
  db.prepare(
    "UPDATE review_queue SET status = @status, resolved_at_ms = @resolvedAtMs WHERE id = @id AND status = 'pending'",
  ).run({ status, resolvedAtMs: Date.now(), id: reviewId });
  return row;
}

/** Expire one pending row: terminal status + one review_expired audit row. */
function expireRow(db: Database.Database, row: ReviewRow, streamMode: StreamMode): void {
  resolvePendingRow(db, row.id, "expired-unreviewed");
  recordReviewResolution(db, {
    reviewId: row.id,
    resolution: "expired-unreviewed",
    suggestionText: row.suggestion_text,
    twitchUsername: row.twitch_username,
    streamMode,
  });
}
