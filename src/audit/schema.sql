-- Audit ledger schema — two-table split (RESEARCH.md Pitfall 5):
--   audit_log    = append-only compliance record of truth (COMP-05, D-16). INSERT-only
--                  at the application layer. The sole DELETE in the codebase lives in
--                  src/audit/purge.ts (plan 01-04, 90-day rolling retention per D-17).
--   review_queue = mutable escalation work-queue (D-05/D-06/D-07). When an item resolves,
--                  a NEW audit_log row is inserted — the original decision row is never touched.

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms   INTEGER NOT NULL,          -- Date.now(); indexed for the purge job
  event_type      TEXT NOT NULL,             -- 'gate_decision' | 'veto' | 'halt' | 'review_resolved' | 'review_expired' | 'submission_refused'
  source          TEXT NOT NULL,             -- 'chat' | 'channel_points' | 'donation' | 'chaos' | 'operator' | 'console' | 'hotkey'
  twitch_username TEXT,                      -- nullable: absent for operator-console-originated events
  suggestion_text TEXT,                      -- nullable: absent for pure veto/halt events with no candidate
  decision        TEXT,                      -- 'approved' | 'rejected' | 'held-for-review' | review resolution | null (halt/veto)
  category        TEXT,                      -- taxonomy category, or a reason_tag for vetoes/halts (D-18)
  rationale       TEXT,                      -- classifier's rationale text, or streamer's optional note
  stream_mode     TEXT NOT NULL,             -- state machine's mode at time of event
  task_id         TEXT                       -- nullable: links to a QueuedTask if applicable
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision);

-- review_queue carries FULL candidate identity (candidate_id, source, kind, submitted_at_ms)
-- so plan 01-05's approve() can reconstruct the complete SuggestionCandidate
-- { id: candidate_id, source, kind, twitchUsername, text, submittedAtMs } and re-enter it
-- into the candidate pool per D-06 — no joins, no lossy defaults.
CREATE TABLE IF NOT EXISTS review_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms   INTEGER NOT NULL,
  candidate_id    TEXT NOT NULL,
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'suggestion',
  submitted_at_ms INTEGER NOT NULL,
  suggestion_text TEXT NOT NULL,
  twitch_username TEXT,
  category        TEXT NOT NULL,             -- one of the 3 escalate-eligible categories (D-12)
  rationale       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'expired-unreviewed'
  resolved_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
