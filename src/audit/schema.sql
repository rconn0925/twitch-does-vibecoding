-- Audit ledger schema — two-table split (RESEARCH.md Pitfall 5):
--   audit_log    = append-only compliance record of truth (COMP-05, D-16). INSERT-only
--                  at the application layer. The sole DELETE in the codebase lives in
--                  src/audit/purge.ts (plan 01-04, 90-day rolling retention per D-17).
--   review_queue = mutable escalation work-queue (D-05/D-06/D-07). When an item resolves,
--                  a NEW audit_log row is inserted — the original decision row is never touched.

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms   INTEGER NOT NULL,          -- Date.now(); indexed for the purge job
  event_type      TEXT NOT NULL,             -- 'gate_decision' | 'veto' | 'halt' | 'review_resolved' | 'review_expired' | 'submission_refused' | 'round_opened' | 'round_closed' | 'pool_dropped'
                                             --   Phase 3 (D3-13): 'pipeline_stage' | 'comp02_decision' | 'build_refused' | 'build_retry' | 'build_skip' | 'sandbox_teardown'
  source          TEXT NOT NULL,             -- 'chat' | 'channel_points' | 'donation' | 'chaos' | 'operator' | 'orchestrator' | 'console' | 'hotkey'
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

-- Phase 4 paid-influence ledger (PAID-04, D-06/D-12). The DURABILITY CONTRACT of
-- this table: a paid/redemption control window MUST survive a mid-stream crash and
-- MUST NEVER be silently extended.
--   ends_at_ms is an ABSOLUTE Date.now()-based timestamp and the SINGLE SOURCE OF
--   TRUTH for when a window closes. On crash restore, the control-window FSM (04-03)
--   re-arms only the REMAINING time (ends_at_ms - Date.now()) — it never re-adds the
--   full amount-proportional duration, so a large donation can never be resurrected
--   into a fresh full-length window by a restart.
--   amount_or_cost + duration_ms persist the D-04 amount→duration mapping that backs
--   PAID-04's "logged with the mapping" requirement; the audit_log narration rows
--   (recordWindow* in record.ts) carry the human-readable mapping text alongside.
--   status is 'active' | 'expired' | 'revoked' (D-12: full-duration lifetime; a
--   window is not closed on first build). closed_at_ms is null while active.
--   D-11: an OPEN sponsored slot — no donor-ownership/exclusivity column exists BY
--   DESIGN; every submission during the window is still gated + vetoable.
CREATE TABLE IF NOT EXISTS control_windows (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type     TEXT NOT NULL,                   -- 'donation' | 'channel_points' (D-03: one FSM, two triggers)
  donor_identifier TEXT NOT NULL,                   -- donor display name / redeemer handle (untrusted upstream, validated at ingestion 04-02)
  amount_or_cost   REAL NOT NULL,                   -- WR-05: whole-currency tip amount (e.g. 4.50 dollars, NOT cents) or channel-points cost — the D-04 mapping input. REAL because tip amounts are fractional dollars.
  duration_ms      INTEGER NOT NULL,                -- amount→duration result (linear, floored, capped)
  opened_at_ms     INTEGER NOT NULL,                -- Date.now() at open
  ends_at_ms       INTEGER NOT NULL,                -- ABSOLUTE close time — single source of truth, crash-safe (D-06/D-12)
  status           TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'revoked'
  closed_at_ms     INTEGER                          -- null while active; set on expiry/revoke
);
CREATE INDEX IF NOT EXISTS idx_control_windows_status ON control_windows(status);
