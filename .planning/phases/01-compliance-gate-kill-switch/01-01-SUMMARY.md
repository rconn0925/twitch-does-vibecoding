---
phase: 01-compliance-gate-kill-switch
plan: 01
subsystem: infra
tags: [typescript, express, ws, better-sqlite3, zod, pino, vitest, biome, state-machine, audit-log, kill-switch]

# Dependency graph
requires: []
provides:
  - Locked Node 24 + TS 6 stack scaffold (express 5, ws, better-sqlite3, zod 4, pino, @anthropic-ai/sdk, uiohook-napi, tree-kill; vitest/tsx/biome)
  - Shared type vocabulary in src/shared/types.ts (StreamMode 6 states, SuggestionCandidate, branded QueuedTask, GateResult, ReasonTag, RecoveryAction, HaltContext, StateSnapshot)
  - Event name constants in src/shared/events.ts incl. project-switch:requested (D-15)
  - StreamModeMachine: hand-rolled 6-state machine, HALTED reachable synchronously from every state via forceTransition
  - triggerHalt()/recover() in src/state-machine/halt.ts with abortActiveWork extension point for plan 01-03
  - Append-only audit ledger (audit_log) + mutable review_queue with full candidate-identity columns for plan 01-05's D-06 pool re-entry
  - Localhost-only operator console (Express 5 + ws state push) with Halt Everything button and D-18 reason-tag row
  - createApp({dbPath, port}) factory used by e2e tests and the npm run dev entrypoint
affects: [01-02, 01-03, 01-04, 01-05, phase-2-chat-loop, phase-3-build-engine]

# Tech tracking
tech-stack:
  added: [express@5.2, ws@8.21, better-sqlite3@12.11, zod@4, pino@10, "@anthropic-ai/sdk@0.110", uiohook-napi@1.5, tree-kill@1.2, typescript@6.0, vitest@3, tsx@4, "@biomejs/biome@2"]
  patterns:
    - "HALT-priority state machine: forceTransition('HALTED') bypasses the transition table, zero async work; best-effort abort decoupled (Pattern 2)"
    - "Two-table audit split: append-only audit_log + mutable review_queue; resolutions INSERT new rows, never mutate (Pitfall 5)"
    - "record.ts grep gate: no UPDATE/DELETE words anywhere in the module, comments included"
    - "zod v4 validation on every request body/query at route entry; terse 400s, never stack traces (ASVS V5)"
    - "textContent-only rendering in console.js — no innerHTML ever (T-01-04 stored-XSS pattern)"
    - "Explicit 127.0.0.1 listen host as the console's only access control (T-01-01)"
    - "ws full-state-on-connect then push-on-change (CLAUDE.md overlay pattern)"

key-files:
  created:
    - package.json
    - tsconfig.json
    - biome.json
    - vitest.config.ts
    - .env.example
    - src/shared/types.ts
    - src/shared/events.ts
    - src/state-machine/stream-mode.ts
    - src/state-machine/halt.ts
    - src/audit/schema.sql
    - src/audit/db.ts
    - src/audit/record.ts
    - src/operator-console/server.ts
    - src/operator-console/public/index.html
    - src/operator-console/public/console.css
    - src/operator-console/public/console.js
    - src/main.ts
    - src/state-machine/stream-mode.test.ts
    - src/audit/record.test.ts
    - tests/e2e/halt.e2e.test.ts
    - README.md
  modified: []

key-decisions:
  - "POST /api/halt while already HALTED records the D-18 reason tag as a new append-only row WITHOUT re-forcing the transition — re-forcing would overwrite the frozen pre-halt snapshot the D-04 triage view needs"
  - "StreamModeMachine gained recoverTo() (HALTED-only exit used by recover()) and setActiveTask() beyond the interface minimum — required for D-04 recovery and discard-and-resume testing"
  - "npm allow-scripts approvals recorded in package.json for better-sqlite3/uiohook-napi/esbuild (all passed RESEARCH.md Package Legitimacy Audit; scripts fetch prebuilt binaries)"
  - "scripts/README.md placeholder created so the locked lint script (biome check src tests scripts) has a valid target before any scripts exist"

patterns-established:
  - "Insert-only audit helpers: record.ts exports 4 INSERT helpers + listAuditRecords SELECT; the sole DELETE ever allowed lives in src/audit/purge.ts (plan 01-04)"
  - "Typed InvalidTransitionError(from, to) whose message matches UI-SPEC 'Can't transition to {state} from {state}' copy verbatim"
  - "e2e tests use exported createApp factory + ephemeral port + global fetch — no supertest"

requirements-completed: [COMP-04, COMP-05]

# Metrics
duration: 16min
completed: 2026-07-09
---

# Phase 1 Plan 01: Walking Skeleton Summary

**One-command Node 24/TS 6 stack where clicking "Halt Everything" on the localhost-only operator console synchronously forces the 6-state machine to HALTED and writes an append-only SQLite audit row readable back via GET /api/audit**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-07-09T01:27:47Z
- **Completed:** 2026-07-09T01:44:00Z
- **Tasks:** 3 (2 TDD, 1 standard)
- **Files modified:** 24 (incl. package-lock.json, scripts/README.md)

## Accomplishments

- Walking Skeleton proven end-to-end: console page → POST /api/halt → forceTransition(HALTED) → recordHalt INSERT → GET /api/audit readback, all under `npm run dev`
- HALTED is a synchronous, from-anywhere transition — the test iterates all 6 states and asserts mode on the very next line with no await (D-02, Success Criterion 3 foundation)
- Shared type contracts (branded QueuedTask, D-15 project-switch kind, D-18 ReasonTag, D-04 RecoveryAction) locked in for plans 01-02..01-05
- Audit ledger structurally append-only: comment-filtered grep for UPDATE/DELETE in record.ts returns 0; review_queue carries candidate_id/source/kind/submitted_at_ms so plan 01-05 can reconstruct full candidates (D-06)
- Console server provably bound to 127.0.0.1 (e2e Test 4 + netstat), zod-validated inputs return terse 400s, console.js has zero innerHTML occurrences
- 23 tests green; `npm run typecheck` and `npm run lint` clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold locked stack + failing halt e2e test** - `bb4807b` (test — TDD RED)
2. **Task 2: State machine + append-only audit ledger** - `40ff71c` (test — TDD RED), `b6df414` (feat — TDD GREEN)
3. **Task 3: Operator console skeleton + main.ts wiring** - `5f8985e` (feat — e2e GREEN)

## Files Created/Modified

- `src/shared/types.ts` - Shared contracts: StreamMode, SuggestionCandidate, branded QueuedTask (unique symbol), GateResult, ReasonTag, RecoveryAction, HaltContext, StateSnapshot
- `src/shared/events.ts` - Event constants incl. `project-switch:requested` (D-15 placeholder)
- `src/state-machine/stream-mode.ts` - Hand-rolled 6-state machine; transition table + HALT-priority forceTransition; typed InvalidTransitionError
- `src/state-machine/halt.ts` - Synchronous triggerHalt (snapshot → force → recordHalt → return) + D-04 recover(); abortActiveWork extension point for plan 01-03
- `src/audit/schema.sql` - audit_log (append-only) + review_queue (mutable, full candidate identity) two-table split
- `src/audit/db.ts` - openDb() factory, idempotent migration, WAL for file paths
- `src/audit/record.ts` - 4 INSERT helpers + listAuditRecords (newest-first, filterable); zero mutating SQL words
- `src/operator-console/server.ts` - Express 5 + ws console; /api/state, /api/halt, /api/audit; 127.0.0.1-only listen
- `src/operator-console/public/*` - UI-SPEC-conformant dark console: mode pills, 44px Halt Everything, reason-tag row, disconnected state, ws reconnect backoff
- `src/main.ts` - createApp() factory + entrypoint (CONSOLE_PORT/AUDIT_DB_PATH, pino operational logging)
- `tests/e2e/halt.e2e.test.ts` - 4-test skeleton contract (IDLE start, halt flip, audit readback, bind address)
- `README.md` - One-command run, env var table, current scope

## Decisions Made

- **Reason-tag follow-up preserves the triage snapshot:** POST /api/halt when mode is already HALTED records the tag as a new audit row but does not re-force the transition — a second forceTransition would replace haltContext.frozen with a HALTED-state snapshot, destroying the D-04 triage data. Plan 01-04 can refine this into a dedicated annotation route if desired.
- **Machine API extended minimally beyond the interface block:** `recoverTo()` (only callable from HALTED, clears haltContext) and `setActiveTask()` were required to implement recover() and test discard-and-resume without exposing raw mode mutation.
- **`.env.example` written once with all 8 Phase 1 vars** so later plans never touch the file (per plan action).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] npm allow-scripts blocked native-module install scripts**
- **Found during:** Task 1 (npm install)
- **Issue:** npm's allow-scripts security feature skipped install scripts for better-sqlite3, uiohook-napi, and esbuild, leaving native bindings unbuilt
- **Fix:** Ran `npm approve-scripts better-sqlite3 uiohook-napi esbuild` — all three are the exact audited packages from RESEARCH.md's Package Legitimacy Audit (no substitutions; install itself had succeeded). Approvals persisted to package.json `allowScripts`
- **Files modified:** package.json
- **Verification:** Both native modules load and execute (`require("better-sqlite3")(":memory:")` and `require("uiohook-napi")` succeed with prebuilt binaries, no node-gyp compile)
- **Committed in:** bb4807b (Task 1 commit)

**2. [Rule 3 - Blocking] Lint script target `scripts/` did not exist**
- **Found during:** Task 3 (npm run lint)
- **Issue:** The plan-locked lint script `biome check src tests scripts` errored with "cannot find the file specified" because no scripts/ directory exists yet
- **Fix:** Created `scripts/README.md` placeholder so the locked script runs clean without weakening its coverage
- **Files modified:** scripts/README.md
- **Verification:** `npm run lint` exits 0, checks 14 files
- **Committed in:** 5f8985e (Task 3 commit)

**3. [Rule 1 - Bug] TS 6 rejects per-file tsc invocation alongside tsconfig.json**
- **Found during:** Task 1 verification (`npx tsc --noEmit src/shared/types.ts`)
- **Issue:** TypeScript 6.0 emits TS5112 when files are passed on the command line while tsconfig.json is present
- **Fix:** Added `--ignoreConfig` (plus explicit strict/module/target flags) for the spot-check; the real gate remains `npm run typecheck` (full project), which passes
- **Files modified:** none (verification command only)
- **Verification:** Spot-check and full typecheck both pass
- **Committed in:** n/a (no source change)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 verification-command bug)
**Impact on plan:** All fixes were unblocking/mechanical. No scope creep; no package substitutions.

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| `GateCategory = string` alias | src/shared/types.ts | Intentional per plan `<interfaces>`: the 15-value union is finalized in plan 01-02's categories.ts; TODO pointer in place |
| Console content panel placeholder copy | src/operator-console/public/index.html | Intentional: review queue, active queue, triage view, and audit page land in plans 01-04/01-05; the skeleton's live surfaces (mode pills, halt, reason tags) are fully wired |
| `abortActiveWork` no-op extension point | src/state-machine/halt.ts | Intentional per plan: plan 01-03 attaches the tree-kill abort hook; invoked with void-and-catch semantics today |

None of these prevent this plan's goal (halt → HALTED → audit row) — all are documented handoffs to later Phase 1 plans.

## Issues Encountered

- Undici keep-alive connections would have hung `server.close()` in the e2e afterEach; solved with `server.closeAllConnections()` plus ws client termination in the close() handle.
- Windows CRLF warnings on commit are cosmetic (git autocrlf); files are stored LF in the index.

## User Setup Required

None for this plan — the skeleton runs entirely locally with defaults. (`ANTHROPIC_API_KEY` becomes required in plan 01-02 for the classifier; already documented in .env.example and README.)

## Next Phase Readiness

- Plans 01-02 (gate), 01-03 (hotkey + abort), 01-04 (console triage/audit page + purge), 01-05 (review queue) can all build against the exact contracts shipped here: types.ts names, StreamModeMachine API, halt.ts deps shape, record.ts helpers, schema.sql columns, console server routes.
- The single sanctioned `as QueuedTask` brand assertion site (src/compliance/gate.ts) does not exist yet — plan 01-05 creates it; the invariant test lands in plan 01-04.
- No blockers.

---
*Phase: 01-compliance-gate-kill-switch*
*Completed: 2026-07-09*

## Self-Check: PASSED

All 15 key files exist on disk; all 4 task commits (bb4807b, 40ff71c, b6df414, 5f8985e) verified in git log.
