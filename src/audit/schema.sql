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

-- Phase 2 voting-round persistence (D2-14: vote LEDGER data gets its own tables;
-- round lifecycle NARRATION events are audit_log rows — no parallel logging path).
--   rounds           = one row per voting round; frozen_remaining_ms persists a
--                      halt-frozen timer (D2-16) so resume continues honestly.
--   round_candidates = FULL candidate identity inline (mirrors review_queue's
--                      no-lossy-defaults discipline) so crash restore rebuilds the
--                      exact SuggestionCandidate + GateResult — no joins. pooled_at_ms
--                      is the pool-entry time handed to the D2-05 staleness check at close.
--   round_votes      = write-through vote ledger keyed by Twitch numeric user id
--                      (chatterId, never display name — D2-15). The composite primary
--                      key makes one-vote-per-account structural; a revote upserts.

CREATE TABLE IF NOT EXISTS rounds (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  status              TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'discarded'
  opened_at_ms        INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  ends_at_ms          INTEGER NOT NULL,
  frozen_remaining_ms INTEGER,                      -- null unless a halt froze the round (D2-16)
  closed_at_ms        INTEGER,
  winner_option       INTEGER,                      -- null: still open, discarded, or zero-vote close
  tiebreak            INTEGER NOT NULL DEFAULT 0    -- 1 when the winner came from a random tiebreak (D2-03)
);
CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);

CREATE TABLE IF NOT EXISTS round_candidates (
  round_id        INTEGER NOT NULL,
  option_index    INTEGER NOT NULL,                 -- 1-based, matches !vote N
  candidate_id    TEXT NOT NULL,
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  twitch_username TEXT,
  text            TEXT NOT NULL,
  submitted_at_ms INTEGER NOT NULL,
  gate_category   TEXT,
  gate_rationale  TEXT NOT NULL,
  pooled_at_ms    INTEGER NOT NULL,                 -- ApprovedCandidate.addedAtMs at draw time (D2-05 staleness input)
  PRIMARY KEY (round_id, option_index)
);

CREATE TABLE IF NOT EXISTS round_votes (
  round_id       INTEGER NOT NULL,
  twitch_user_id TEXT NOT NULL,                     -- EventSub chatterId — numeric id, never display name (D2-15)
  option_index   INTEGER NOT NULL,
  voted_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (round_id, twitch_user_id)
);
CREATE INDEX IF NOT EXISTS idx_round_votes_round ON round_votes(round_id);
