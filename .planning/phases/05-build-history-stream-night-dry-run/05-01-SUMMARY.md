---
phase: 05-build-history-stream-night-dry-run
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, build-history, provenance, changelog, append-only]

# Dependency graph
requires:
  - phase: 03-build-pipeline
    provides: build-session finalize()/finalizeAborted() lifecycle + emitStage + auditIfOpen shutdown-drain guard
  - phase: 04-paid-influence-chaos
    provides: ControlWindowSnapshot.trigger + the driveWindowBuild/driveChaosBuild drivers + BuildStatusView.source vocabulary
provides:
  - Append-only build_history table (task_id, title, provenance, result, created_at_ms) + index
  - recordBuildHistory (insert) + listBuildHistory (reverse-chrono, bounded, beforeMs cursor)
  - BuildProvenance / BuildResult / BuildHistoryRow shared types
  - Provenance threaded startBuild → finalize → recordBuildHistory from all three build-trigger drivers
affects: [05-02-changelog-page, stream-night-grouping]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dedicated append-only ledger table (mirrors control_windows) with its own INSERT/SELECT pair — not a VIEW over audit_log (D-01 VERDICT: a view cannot losslessly reconstruct an entry)"
    - "Single-slot provenance stored on the active session (concurrency-1 safe), read at finalize() before active=null, guarded by auditIfOpen"
    - "Stream-night grouping key derived on read from created_at_ms — no session/day column (D-02)"

key-files:
  created: []
  modified:
    - src/audit/schema.sql
    - src/audit/record.ts
    - src/shared/types.ts
    - src/orchestrator/build-session.ts
    - src/main.ts
    - src/audit/record.test.ts
    - src/orchestrator/build-session.test.ts
    - tests/e2e/build-flow.e2e.test.ts
    - tests/e2e/paid-window-loop.e2e.test.ts
    - tests/e2e/chaos-mode.e2e.test.ts

key-decisions:
  - "recordBuildHistory is called ONLY from finalize() (never finalizeAborted) — an abort is neither success nor narrated failure (CR-01), and gate-approved title holds by construction (D-03)"
  - "Provenance is pinned inside runPipeline (under concurrency-1), not at startBuild call time, so a second queued startBuild cannot overwrite the running build's value"
  - "Per-driver provenance is asserted at the e2e layer (vote/donation/chaos) so a forgotten wiring defaulting to one value fails the suite"

patterns-established:
  - "Append-only ledger table with a mirrored record/list helper pair"
  - "mapStageToResult: honest 1:1 terminal-stage → result mapping (done→built, failed→failed, refused→refused)"

requirements-completed: [HIST-01]

# Metrics
duration: ~20min
completed: 2026-07-10
---

# Phase 5 Plan 01: build_history persistence + provenance threading Summary

**Append-only `build_history` ledger plus provenance threaded from all three build-trigger drivers through `startBuild → finalize → recordBuildHistory`, so every completed build leaves one honest, gate-approved, provenance-tagged changelog row (HIST-01 persistence half).**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-10
- **Tasks:** 2 (both TDD: RED → GREEN)
- **Files modified:** 10

## Accomplishments
- Dedicated append-only `build_history` table (id, task_id, title, provenance, result, created_at_ms) + `idx_build_history_created_at`, mirroring the `control_windows` idiom.
- `recordBuildHistory` insert helper + `listBuildHistory` reverse-chronological (`created_at_ms DESC, id DESC`) paginated query with an optional `beforeMs` cursor; INSERT/SELECT only (append-only discipline preserved — the record.ts grep gate stays green).
- `BuildProvenance` / `BuildResult` / `BuildHistoryRow` shared types.
- Closed the provenance-wiring gap: `startBuild(task, provenance?)` stores provenance on the active session (default `vote`); `finalize()` — and never `finalizeAborted()` — persists exactly one row with the honest `mapStageToResult` mapping, reading provenance before `active = null`, guarded by `auditIfOpen`.
- The three drivers now thread contextual provenance: `onWinnerQueued = vote`, `driveWindowBuild = live ControlWindowSnapshot.trigger` (donation | channel_points), `driveChaosBuild = chaos`. Streamer retry preserves the original provenance.

## Task Commits

1. **Task 1 (RED): build_history record/list + schema tests** - `01ba74f` (test)
2. **Task 1 (GREEN): build_history table + record/list + types** - `0cfcd38` (feat)
3. **Task 2 (RED): provenance→build_history + per-driver tests** - `75e01a8` (test)
4. **Task 2 (GREEN): thread provenance startBuild→finalize→recordBuildHistory** - `5078774` (feat)

_TDD tasks: each has a test (RED) then feat (GREEN) commit._

## Files Created/Modified
- `src/audit/schema.sql` - Added the append-only `build_history` table + index.
- `src/audit/record.ts` - `recordBuildHistory` + `listBuildHistory` (own INSERT/SELECT pair, not the audit_log helper).
- `src/shared/types.ts` - `BuildProvenance`, `BuildResult`, `BuildHistoryRow`.
- `src/orchestrator/build-session.ts` - `startBuild` provenance param, `currentProvenance` slot, `mapStageToResult`, `recordBuildHistory` in `finalize()`, retry provenance preservation.
- `src/main.ts` - Threaded provenance at the three build-trigger drivers.
- `src/audit/record.test.ts` - build_history insert / order / limit / beforeMs / durability / table-existence.
- `src/orchestrator/build-session.test.ts` - per-result rows, per-provenance storage, default vote, finalizeAborted-writes-none, closed-ledger no-throw.
- `tests/e2e/{build-flow,paid-window-loop,chaos-mode}.e2e.test.ts` - per-driver provenance assertions (vote / donation / chaos).

## Decisions Made
- **build_history is a dedicated table, not a VIEW** — honoring the 05-PATTERNS.md D-01 VERDICT (recordPipelineStage writes suggestionText:null; recordGateDecision writes taskId:null → a view cannot losslessly reconstruct an entry).
- **Provenance pinned in `runPipeline`, not `startBuild`** — set inside the concurrency-1 pipeline so a second queued `startBuild` cannot overwrite the running build's value; retry paths reuse the stored value.
- **Night grouping derived on read** from `created_at_ms` (D-02) — no session/day column added.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Test Coverage] Per-driver provenance asserted at the e2e layer**
- **Found during:** Task 2 (thread provenance)
- **Issue:** The plan's `files_modified` listed only `build-session.test.ts` for Task 2, but the phase directive requires behavior tests that assert *per-driver* provenance (onWinnerQueued=vote, driveWindowBuild=trigger, driveChaosBuild=chaos) so a forgotten wiring defaulting to one value fails the suite. That wiring lives in `main.ts` and is only observable end-to-end.
- **Fix:** Added `listBuildHistory` provenance assertions to the three existing e2e tests that already drive each path (build-flow=vote, paid-window-loop=donation, chaos-mode=chaos). No new e2e files; assertions folded into existing `it` blocks / one new `it` in build-flow.
- **Files modified:** tests/e2e/build-flow.e2e.test.ts, tests/e2e/paid-window-loop.e2e.test.ts, tests/e2e/chaos-mode.e2e.test.ts
- **Verification:** All three e2e files green; each asserts the correct provenance + result 'built'.
- **Committed in:** `75e01a8` (RED) / `5078774` (GREEN)

---

**Total deviations:** 1 auto-fixed (1 missing-critical test coverage)
**Impact on plan:** Necessary to satisfy the phase's per-driver provenance requirement. No production-scope creep — the extra edits are test-only assertions on existing paths.

## Issues Encountered
- The record.test.ts append-only self-test greps `record.ts` for `/UPDATE|DELETE/i` (comments included). An initial doc comment used the words "UPDATE/DELETE" and tripped the gate; reworded to "no mutating write path" prose. Resolved.

## Threat Coverage
- **T-05-01** (pre-gate text in build_history): recordBuildHistory called only from finalize() with `task.text` off a branded QueuedTask; append-only (no UPDATE/DELETE path — verified by grep). Holds by construction.
- **T-05-02** (abort recorded as built): finalizeAborted() has zero recordBuildHistory calls (verified); stage→result mapping is 1:1 and honest; unit test asserts zero rows on abort.
- **T-05-03** (provenance mis-attribution): provenance threaded explicitly from each driver, unit + e2e tested per provenance.

## Next Phase Readiness
- The durable, provenance-tagged, append-only source of truth is ready for 05-02 to render the browsable changelog page (`listBuildHistory` + on-read night grouping).
- No external service configuration required. STATE.md / ROADMAP.md intentionally left untouched (orchestrator owns those).

## Self-Check: PASSED

- All 4 task commits present (01ba74f, 0cfcd38, 75e01a8, 5078774).
- All created/modified key files present on disk.
- recordBuildHistory + listBuildHistory exported.
- Full suite green: 645 passed (630 baseline + 15 new); tsc + biome clean.
- finalizeAborted has 0 recordBuildHistory calls; no UPDATE/DELETE against build_history.

---
*Phase: 05-build-history-stream-night-dry-run*
*Completed: 2026-07-10*
