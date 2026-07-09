---
phase: 02-chat-vote-loop
plan: 01
subsystem: state-machine
tags: [typescript, better-sqlite3, vitest, voting-rounds, vote-ledger, crash-recovery, tdd]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch
    provides: StreamModeMachine (VOTING_ROUND transitions, HALT_TRIGGERED/STATE_CHANGED events), CandidatePool, append-only audit ledger (openDb/record.ts), shared type/event vocabulary
provides:
  - "RoundManager (src/state-machine/round.ts): streamer-triggered round lifecycle open/vote/close/freeze/restore with SQLite write-through"
  - "RoundStartError, RoundManagerDeps, EnqueueWinnerResult, roundDurationMs() contracts for plan 02-03's console route and pipeline funnel"
  - "rounds + round_candidates + round_votes tables with PRIMARY KEY (round_id, twitch_user_id) vote upsert key"
  - "RoundStatus/RoundCandidate/RoundSnapshot types for plans 02-03..02-06"
  - "ROUND_OPENED / ROUND_CLOSED / VOTE_RECORDED event constants (round:opened / round:closed / round:vote-recorded)"
  - "recordRoundOpened / recordRoundClosed / recordPoolDropped insert-only audit helpers"
  - "All 12 Phase 2 env vars in .env.example (no later plan touches this file)"
affects: [02-03, 02-04, 02-05, 02-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Write-through vote ledger: SQLite upsert commits BEFORE in-memory tally moves or VOTE_RECORDED emits (D2-14)"
    - "Native ON CONFLICT(round_id, twitch_user_id) DO UPDATE upsert — atomic revote override, no read-then-write race (D2-15)"
    - "Votes keyed by Twitch numeric user id (EventSub chatterId), never display name (T-02-01)"
    - "Full-candidate-identity persistence in round_candidates (review_queue discipline) — crash restore reconstructs exact SuggestionCandidate + GateResult, no joins"
    - "pooled_at_ms persisted at draw time and read back from the row at close — the D2-05 staleness input survives restarts"
    - "Injected enqueueWinner function as the ONLY queue bridge — RoundManager never imports toQueuedTask/TaskQueue (COMP-01 funnel isolation)"
    - "Halt-freeze: HALT_TRIGGERED cancels the timer synchronously and persists frozen_remaining_ms; close never fights a halt (T-02-04)"

key-files:
  created:
    - src/state-machine/round.ts
    - src/state-machine/round.test.ts
  modified:
    - src/shared/types.ts
    - src/shared/events.ts
    - src/audit/schema.sql
    - src/audit/record.ts
    - src/audit/record.test.ts
    - .env.example

key-decisions:
  - "recordRoundClosed maps winnerOption into the decision column ('winner-option-N' / 'no-winner') and tiebreak into category — full picture in one audit row without new columns"
  - "closeRound() only transitions VOTING_ROUND→IDLE when the machine is actually in VOTING_ROUND — a close can never fight a halt (D-02 priority preserved)"
  - "After close/discard the manager nulls its round state (snapshot() → null); the final RoundSnapshot travels on the ROUND_CLOSED emit payload"
  - "restore() leaves a frozen round frozen (waits for D-04 recovery triage) instead of auto-resuming"

# Metrics
duration: 13min
completed: 2026-07-09
---

# Phase 2 Plan 01: Voting-Round Engine Summary

**Crash-recoverable RoundManager with a SQLite write-through vote ledger keyed by Twitch numeric user id — one vote per viewer, revote overrides, halt-freeze honesty, and the full Phase 2 type/event/audit vocabulary.**

## What Was Built

### Task 1 — Phase 2 vocabulary (TDD: `0d9d3be` RED → `67ceec3` GREEN)
- `RoundStatus`, `RoundCandidate`, `RoundSnapshot` added to `src/shared/types.ts` (existing Phase 1 exports byte-unchanged)
- `ROUND_OPENED`/`ROUND_CLOSED`/`VOTE_RECORDED` constants + widened `AppEvent` union in `src/shared/events.ts`
- Three new tables in `src/audit/schema.sql`: `rounds` (with `frozen_remaining_ms` for D2-16), `round_candidates` (full candidate identity + `pooled_at_ms`), `round_votes` (composite PK `(round_id, twitch_user_id)` makes one-vote-per-account structural)
- `recordRoundOpened`/`recordRoundClosed`/`recordPoolDropped` in `src/audit/record.ts` via the existing private `insert()` helper; the module still contains zero UPDATE/DELETE tokens (grep gate verified)
- All 12 Phase 2 env vars added to `.env.example` in one edit (Twitch auth, round duration, intake cooldown, pool bound, sender budget, staleness bound, overlay port)

### Task 2 — RoundManager (TDD: `26da330` RED → `f746a09` GREEN)
- `startRound()`: IDLE guard → draw first min(3, pool) in insertion order (≥2 required, D2-04) → persist rounds + round_candidates → `transition("VOTING_ROUND")` → audit row → unref'd close timer → `ROUND_OPENED` emit
- `recordVote()`: validates open/not-frozen/VOTING_ROUND/1..N, then upserts to SQLite FIRST, then updates the in-memory tally, then emits `VOTE_RECORDED` (test asserts the row exists inside the emit listener)
- `closeRound()`: winner from tally; ties resolved among leaders only via injectable rng with `tiebreak` flagged in row + snapshot (D2-03); zero votes → no winner, full repool; winner handed to the injected `enqueueWinner` with the PERSISTED `pooled_at_ms` (asserted strictly equal pre- and post-restore); losers repooled; round_closed audit row carries the tally JSON in rationale
- Halt-freeze (D2-16): `HALT_TRIGGERED` cancels the timer and persists `frozen_remaining_ms`; `recoverTo("VOTING_ROUND")` resumes with `endsAtMs = now + remainder`; `recoverTo("IDLE")` discards (row status `'discarded'`, candidates repooled, `ROUND_CLOSED` with discarded snapshot)
- `restore()` (D2-14): rebuilds candidates/tally/timer exclusively from SQLite; expired rounds close immediately; frozen rounds stay frozen for triage; a pre-crash voter's revote still overrides (one ledger row)

## Verification

- `npm test`: **247/247 passing** (223 baseline + 24 new; single-funnel invariant suite untouched and green)
- `npm run typecheck` and `npm run lint` clean
- `grep -c "ON CONFLICT(round_id, twitch_user_id)" src/state-machine/round.ts` → 1 (native upsert)
- `grep -cE "toQueuedTask|task-queue" src/state-machine/round.ts` → 0 (funnel isolation)
- Comment-filtered UPDATE/DELETE grep on `src/audit/record.ts` → 0 (append-only)
- `src/state-machine/round.ts` = 612 lines (min 120 required)

## TDD Gate Compliance

Both tasks followed RED→GREEN: `test(02-01)` commits `0d9d3be` and `26da330` precede their `feat(02-01)` commits `67ceec3` and `f746a09`. Both RED runs were observed failing before implementation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Normalized CRLF working-tree files so `npm run lint` could pass**
- **Found during:** Task 1 verification
- **Issue:** The worktree checkout produced CRLF line endings in 9 pre-existing files (despite `.gitattributes` `eol=lf`), failing Biome's formatter check before any Phase 2 code ran
- **Fix:** Stripped `\r` from working-tree copies only; index content was already LF, so no content diff and nothing extra committed
- **Files modified:** working-tree copies of scripts/README.md, src/audit/db.ts, src/compliance/categories.ts + fixtures, src/shared/{types,events}.ts, src/state-machine/stream-mode.ts, src/audit/record.test.ts
- **Commit:** none (no index change)

No other deviations — plan executed as written.

## Known Stubs

None. The one intentionally-deferred piece is by design, not a stub: `enqueueWinner` is an injected dependency whose real implementation (with the D2-05 staleness check) lands in plan 02-03's `src/pipeline/round.ts`; RoundManager's contract with it (three args, third = persisted `pooled_at_ms`) is machine-tested here.

## Threat Flags

None — all security-relevant surface built this plan is registered in the plan's threat model (T-02-01 chatterId keying, T-02-03 write-through, T-02-04 halt/timer race) and mitigated as specified. No new network endpoints, auth paths, or trust-boundary schema beyond the plan.

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| `0d9d3be` | test | failing tests for round audit helpers + vote-ledger tables |
| `67ceec3` | feat | Phase 2 vocabulary: types, events, schema, audit helpers, env knobs |
| `26da330` | test | failing RoundManager lifecycle tests (19 tests) |
| `f746a09` | feat | RoundManager: open/vote/close/tiebreak/freeze/restore |

## Self-Check: PASSED

All 8 claimed files exist on disk; all 4 task commits verified in git log; working tree clean; full suite green at HEAD (247/247).
