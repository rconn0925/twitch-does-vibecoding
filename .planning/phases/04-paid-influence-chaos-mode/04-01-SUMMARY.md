---
phase: 04-paid-influence-chaos-mode
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, audit-ledger, shared-types, event-bus, paid-influence, chaos-mode]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch
    provides: audit_log two-table ledger, record.ts insert() helper shape, shared types/events vocabulary
  - phase: 02-chat-vote-loop
    provides: rounds/round_candidates/round_votes ledger tables, ROUND_* event constants pattern
  - phase: 03-sandboxed-build-engine-live-show
    provides: BuildStatusView + PipelineStage vocabulary, orchestrator CandidateSource, Phase 3 audit event pattern
provides:
  - control_windows durable ledger table (crash-safe absolute ends_at_ms, D-06/D-12)
  - recordWindowOpened/Expired/Revoked/Denied audit helpers (PAID-04, never-silent)
  - recordChaosToggled/recordChaosPick audit helpers (CHAOS-01)
  - ControlWindowSnapshot + WindowTrigger + WindowStatus shared types
  - BuildStatusView.source provenance field (overlay chip vocabulary)
  - WINDOW_OPENED/CLOSED/REVOKED/DENIED + CHAOS_TOGGLED/CHAOS_PICK event constants
affects: [04-02-ingestion, 04-03-control-window-fsm, 04-04-overlay-console, chaos-mode-selection]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Append-only paid-window ledger: control_windows persists amount->duration mapping; audit_log carries the human-readable narration row (two-path-free, mirrors D2-14 vote-ledger split)"
    - "Absolute crash-safe timestamp: ends_at_ms is the single source of truth; restore re-arms remaining time only, never re-adds full duration (D-06/D-12)"
    - "Console-vs-public projection split: ControlWindowSnapshot (amountLabel, console-only) kept distinct from the coarse overlay projection so no donation amount reaches the broadcast wire (T-04-03)"

key-files:
  created: []
  modified:
    - src/audit/schema.sql
    - src/audit/record.ts
    - src/audit/record.test.ts
    - src/shared/types.ts
    - src/shared/events.ts

key-decisions:
  - "BuildStatusView.source is OPTIONAL, not required — keeps tsc clean without editing the non-owned Phase 3 producer (src/orchestrator/build-session.ts) during a parallel Wave-1 worktree run; consumers treat absent as 'vote'"
  - "record.ts window helpers use inline 'donation' | 'channel_points' literals (not an import of WindowTrigger) so Task 1's commit is independently green before Task 2 adds the shared type"
  - "Window audit rows carry source = the trigger so the ledger is filterable by influence path; chaos_pick = 'chaos', chaos_toggled = 'operator'"

patterns-established:
  - "Paid-window lifecycle audit: every open/expire/revoke/deny appends exactly one audit_log row (never-silent, D-05/COMP-05)"
  - "Durability-contract comment convention: the control_windows schema block documents the crash-restore invariant inline (mirrors the rounds/round_candidates prose headers)"

requirements-completed: [PAID-04]

# Metrics
duration: 12min
completed: 2026-07-10
---

# Phase 4 Plan 01: Paid-Influence & Chaos Shared Foundation Summary

**Durable crash-safe `control_windows` ledger (absolute `ends_at_ms`), six additive window/chaos audit-record helpers logging the amount→duration mapping, and the `ControlWindowSnapshot` + `BuildStatusView.source` + `WINDOW_*`/`CHAOS_*` shared vocabulary every Wave 2 plan consumes.**

## Performance

- **Duration:** ~12 min
- **Completed:** 2026-07-10
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Appended the `control_windows` table + `idx_control_windows_status` index to `schema.sql` with an inline D-06/D-12 durability-contract comment: `ends_at_ms` is an absolute timestamp and the single source of truth, so a mid-stream crash can never lose or silently extend a paid window; the amount/cost + duration persist the D-04 mapping (PAID-04).
- Added six additive audit helpers mirroring the `recordRoundOpened` arg-object → `insert()` shape: `recordWindowOpened` (rationale carries the amount→duration mapping text), `recordWindowExpired`, `recordWindowRevoked`, `recordWindowDenied` (reason `already-active` | `cooldown`, never-silent D-05), `recordChaosToggled`, `recordChaosPick`. No schema/CHECK change — `audit_log` has no CHECK constraint so the new `event_type`/`source` values are schema-safe.
- Added the shared vocabulary Wave 2 needs before it forks: `ControlWindowSnapshot` (console-only honest `amountLabel`, kept distinct from the coarse public overlay projection — T-04-03), `WindowTrigger`, `WindowStatus`, an optional `BuildStatusView.source` provenance field, and the six `WINDOW_*`/`CHAOS_*` event constants wired into the `AppEvent` union.
- Full suite green: 530 passed (524 baseline + 6 new); `tsc --noEmit` and Biome both clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: control_windows table + audit-record helpers** - `fc7b28c` (feat)
2. **Task 2: shared type + event vocabulary for windows and chaos** - `a99327a` (feat)

## Files Created/Modified
- `src/audit/schema.sql` - Appended `control_windows` table + status index + D-06/D-12 durability comment (existing tables untouched, append-only).
- `src/audit/record.ts` - Added Phase 4 section with 6 window/chaos `recordX` helpers; `listAuditRecords` and all existing helpers unchanged.
- `src/audit/record.test.ts` - Added 6 tests (5 helper-behaviour + 1 `control_windows` schema-migration check).
- `src/shared/types.ts` - Added `ControlWindowSnapshot`, `WindowTrigger`, `WindowStatus`; added optional `source` field to `BuildStatusView`.
- `src/shared/events.ts` - Added `WINDOW_OPENED/CLOSED/REVOKED/DENIED` + `CHAOS_TOGGLED/CHAOS_PICK` constants and extended the `AppEvent` union.

## Decisions Made
- **`BuildStatusView.source` made optional, not required.** The plan expressed a preference for a required field but also mandated tsc-clean, don't-touch-non-owned-files, and honoring the parallel-executor file-ownership discipline. A required field would force editing `src/orchestrator/build-session.ts:315` (a real Phase 3 producer NOT in this plan's `files_modified` and owned by no Wave-1 plan), breaking the worktree isolation invariant. Optional satisfies every hard constraint: the field exists, tsc stays clean, no non-owned file is touched, and Wave 2/4 supplies concrete values (treating absent as `"vote"`).
- **`record.ts` uses inline `"donation" | "channel_points"` literals** rather than importing `WindowTrigger` from `types.ts`, so Task 1's commit type-checks independently before Task 2 introduces the shared type. Matches the plan's stated record.ts interface exactly.
- **Window audit rows carry `source` = the trigger** (`donation`/`channel_points`) so the ledger is filterable by influence path; `chaos_pick` uses `chaos`, `chaos_toggled` uses `operator`.

## Deviations from Plan

None affecting scope. The only judgement call was the required-vs-optional `source` field, resolved in favour of optional to satisfy the hard success criteria (tsc clean) and the parallel-worktree file-ownership rule — documented under Decisions Made. `npm install` was run once because the fresh worktree had no `node_modules` (explicitly sanctioned by the parallel-execution instructions); it did not modify `package.json` or `package-lock.json` (both owned by the sibling 04-02 executor).

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The shared contract is stable and consumable: Wave 2 plans (04-03 control-window FSM, 04-04 overlay/console) can import `ControlWindowSnapshot`, the `WINDOW_*`/`CHAOS_*` constants, and call the `recordWindow*`/`recordChaos*` helpers without inventing any shared type.
- The durable `control_windows` table is ready for the 04-03 restore logic to derive remaining time from `ends_at_ms` (D-06/D-12).
- Note for downstream: `BuildStatusView.source` is optional — 04-04's provenance chip should default an absent value to `"vote"`.

## Self-Check: PASSED

All five modified files and the SUMMARY exist on disk; both task commits (`fc7b28c`, `a99327a`) are present in git history; `control_windows` in schema.sql, `ControlWindowSnapshot` in types.ts, and `CHAOS_TOGGLED` in events.ts all verified.

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
