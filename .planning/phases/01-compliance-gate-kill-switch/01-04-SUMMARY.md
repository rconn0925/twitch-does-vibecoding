---
phase: 01-compliance-gate-kill-switch
plan: 04
subsystem: operator-console
tags: [comp-01, comp-04, comp-05, d-04, d-05, d-06, d-07, d-17, d-18, invariant-test, ui-spec, xss]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch (plan 01-01)
    provides: state machine, halt/recover, console server skeleton, audit db/schema, hotkey
  - phase: 01-compliance-gate-kill-switch (plan 01-02)
    provides: prefilter + Sonnet classifier (fail-closed), taxonomy, fixtures
  - phase: 01-compliance-gate-kill-switch (plan 01-03)
    provides: kill-switch abort registry + tree-kill wiring in main.ts
  - phase: 01-compliance-gate-kill-switch (plan 01-05)
    provides: classify()/toQueuedTask(), CandidatePool, TaskQueue, review-queue, submitCandidate
provides:
  - Full operator console (four UI-SPEC views + HALTED triage takeover) over zod-validated routes
  - purgeOldAuditRecords — the codebase's ONLY DELETE (D-17, 90-day rolling retention)
  - tests/invariants/single-funnel.test.ts — machine-enforced COMP-01 funnel (Success Criterion 1)
  - /api/dev/submit — the demoable live slice + the exact pattern Phase 2 chat ingestion replaces
  - Session-lifecycle hygiene in createApp — expireAllPending + purge at boot, unref'd sweeps
affects: [phase-02-chat-ingestion, phase-03-sandbox, phase-04-paid-control]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-18 follow-up tag pattern: re-POST the same endpoint with only reasonTag after the action took effect (mirrors the existing /api/halt already-halted path)"
    - "classifyThenPush: wrap the gate so a ws snapshot lands on a macrotask AFTER submit.ts's microtask routing settles"
    - "textContent-only DOM construction via el()/button() helpers — zero innerHTML, zero confirm()"
    - "Source-scan invariant tests with comment stripping (grep-gate hygiene, actionable file:line failures)"

key-files:
  created:
    - src/audit/purge.ts
    - src/audit/purge.test.ts
    - tests/e2e/console-flows.e2e.test.ts
    - tests/invariants/single-funnel.test.ts
  modified:
    - src/operator-console/server.ts
    - src/operator-console/public/index.html
    - src/operator-console/public/console.css
    - src/operator-console/public/console.js
    - src/main.ts
    - src/audit/record.ts
    - src/state-machine/review-queue.ts
    - src/compliance/classifier.ts
    - README.md

key-decisions:
  - "D-18 follow-up reason tags reuse the SAME action endpoints (veto/reject/halt) rather than a new tag route — the veto route appends a tag-only row when the task is already gone; reject appends a resolution row with the tag for already-terminal items"
  - "classifierDepsFromEnv lives in src/compliance/classifier.ts so main.ts never imports @anthropic-ai/sdk — the plan's own invariant (c) forbids the SDK outside compliance/"
  - "Extended ConsoleState (pool, queue, review list + count) is the single ws payload AND the GET /api/state body — the UI renders every view from one snapshot shape"
  - "Discard Task & Resume's follow-up tag posts to /api/tasks/{frozenActiveTaskId}/veto — no dedicated recover-tag route needed"

patterns-established:
  - "Invariant tests as permanent phase-gate: future phases inherit the funnel scan in every npm test"

requirements-completed: [COMP-01, COMP-04, COMP-05]

# Metrics
duration: ~20min
completed: 2026-07-09
---

# Phase 1 Plan 04: Operator Console, Audit Purge and Single-Funnel Invariant Summary

**The complete Phase-1 incident surface: Needs Review with per-item approve/reject (D-05/06), HALTED triage takeover with exactly three recovery buttons (D-04), per-task veto with triggering-input audit rows and one-tap reason tags (D-18/COMP-04/05), a filterable audit page with 90-day purge (D-17), and the COMP-01 single funnel now machine-checked by a source-scanning invariant test proven sensitive to sabotage.**

## Performance

- **Duration:** ~20 min (2026-07-09T20:52Z → 21:12Z)
- **Completed:** 2026-07-09
- **Tasks:** 3/3
- **Files modified:** 4 created, 9 modified

## Accomplishments

- Full suite green: 210/210 tests across 17 files (up from 187/187); `npm run typecheck` and `npm run lint` clean
- TDD gate sequence honored: RED commit (12 failing e2e/unit contracts) → GREEN commit (all passing) for Task 1
- D-02 over HTTP: dev-submit while HALTED returns 409 {reason:"halted"} with a `submission_refused` audit row; nothing classified/pooled/queued (e2e-proven)
- D-06 lossless approval over HTTP: approve re-pools the original candidate; the original `gate_decision` audit row is deep-equal before/after (e2e-proven)
- D-07 session hygiene: a pending review row seeded into a file-backed db before `createApp` boots is `expired-unreviewed` after boot with a `review_expired` audit row; a 200-day-old audit row is purged (e2e-proven)
- COMP-05 veto rows carry the removed task's `suggestion_text` (triggering input) plus the optional reason tag (e2e-proven)
- Invariant test enforces all five funnel properties after comment stripping, with file:line failure messages — and demonstrably fails when sabotaged (see Verification Evidence)
- Console UI implements the UI-SPEC copywriting contract verbatim; zero `innerHTML`, zero `confirm()` (grep-gated)

## Task Commits

1. **Task 1 (RED): failing e2e + purge unit contracts** — `f58be9f` (test)
2. **Task 1 (GREEN): console API routes, purge, session wiring** — `418b549` (feat)
3. **Task 2: console UI — four views + triage takeover + README tour** — `a46a966` (feat)
4. **Task 2 (fix-up): biome formatting after lint-warning fixes** — `34bedee` (style)
5. **Task 3: single-funnel invariant test** — `bfd4de2` (test)

## Files Created/Modified

- `src/audit/purge.ts` — `purgeOldAuditRecords(db, retentionDays?)`; the sole DELETE; `AUDIT_RETENTION_DAYS` env (default 90); time-cutoff-only deletion (T-01-20)
- `src/operator-console/server.ts` — GET /api/review, POST /api/review/:id/{approve,reject}, POST /api/tasks/:id/veto, POST /api/recover, POST /api/dev/submit, extended GET /api/state + /api/audit filters; every body/param/query zod-validated with terse 400s; ws pushes the full ConsoleState on every mutation
- `src/operator-console/public/{index.html,console.css,console.js}` — four views per UI-SPEC (status bar, Needs Review, Active Queue + dev form, Audit Log) plus the HALTED triage takeover; textContent-only rendering
- `src/main.ts` — boot-time `expireAllPending` + `purgeOldAuditRecords`, unref'd 15-min review sweep + 24h purge timers (cleared on close), gate deps wiring (fakeClassifier injection / live Sonnet from env), pool + taskQueue on AppHandle
- `src/audit/record.ts`, `src/state-machine/review-queue.ts` — reason tags on review resolutions; `getReview` lookup (see Deviations)
- `src/compliance/classifier.ts` — `classifierDepsFromEnv` factory (see Deviations)
- `tests/invariants/single-funnel.test.ts` — the five-property source scan
- `README.md` — full console tour (four views, triage takeover, dev-submit usage, reason tags)

## Decisions Made

- **Follow-up tags reuse action endpoints:** the UI's post-action one-tap tag re-POSTs the same route; the server tolerates the already-resolved state and appends a tag-only audit row. This mirrors plan 01-01's existing already-HALTED `/api/halt` behavior instead of inventing a parallel tag route
- **Extended snapshot everywhere:** `ConsoleState` (machine snapshot + pool + queue + pending review list/count) is both the ws payload and GET /api/state body, so the UI is a pure function of one shape
- **No-key boot is legal:** without `ANTHROPIC_API_KEY` (and no injected fake), createApp logs a loud warning and every submission fails closed — never fail-open (D-11)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] main.ts could not construct the Anthropic client without violating the plan's own invariant**
- **Found during:** Task 1 (wiring design)
- **Issue:** The plan says main.ts "constructs the real Anthropic client from ANTHROPIC_API_KEY", but Task 3's invariant (c) forbids `@anthropic-ai/sdk` imports outside src/compliance/
- **Fix:** Added `classifierDepsFromEnv(logger)` to src/compliance/classifier.ts (runtime SDK import stays inside the compliance boundary); main.ts calls the factory
- **Files modified:** src/compliance/classifier.ts, src/main.ts
- **Commit:** 418b549

**2. [Rule 2 - Missing critical functionality] Review rejections could not record the D-18 reason tag**
- **Found during:** Task 1 (route design)
- **Issue:** The plan's route contract accepts optional `{reasonTag}` on reject, but `reject()` / `recordReviewResolution()` had no tag parameter (audit rows would silently drop the tag)
- **Fix:** `recordReviewResolution` gained optional `reasonTag` (lands in the `category` column, matching the schema's documented D-18 usage); `reject()` gained a trailing `reasonTag` param; added exported `getReview()` so the follow-up tag path can rebuild the resolution row. Neither file was in the plan's files_modified list
- **Files modified:** src/audit/record.ts, src/state-machine/review-queue.ts
- **Commit:** 418b549

**3. [Rule 3 - Blocking] Fresh worktree checkout materialized every file as CRLF, failing repo-wide lint**
- **Found during:** Task 1 verification
- **Issue:** Same environmental issue as plan 01-05's deviation #5 (`core.autocrlf=true`, no `.gitattributes`) — 41 biome format errors across untouched files
- **Fix:** `biome format --write` normalized working copies to LF; git-invisible (verified: `git diff --stat` showed content changes only in this plan's five files). A `.gitattributes` (`*.ts text eol=lf` etc.) would fix this permanently — left for the orchestrator/user since it touches repo-wide config
- **Commit:** (no content change — working-copy normalization only)

**4. [Minor] Post-commit formatting fix-up**
- Two lint-warning fixes (optional chaining) after the Task 2 commit shortened lines biome then wanted collapsed — separate `style` commit 34bedee keeps lint at zero diagnostics

## Verification Evidence

- `npm test`: 210/210 tests, 17 files, green (includes tests/invariants/single-funnel.test.ts and tests/e2e/console-flows.e2e.test.ts)
- `npm run typecheck`: exit 0; `npm run lint`: exit 0, zero diagnostics
- `grep -c "DELETE FROM audit_log" src/audit/purge.ts` → 1; `grep -rl 'DELETE FROM' src --include=*.ts` → exactly `src/audit/purge.ts`
- `grep -c "innerHTML" console.js` → 0; `grep -c "confirm(" console.js` → 0; verbatim copy grep-verified: "Halt Everything", "Veto Task", "Nothing waiting for review", "Queue is empty", "No matching records", "Discard Task & Resume", "Reset to Idle"
- **Sabotage sensitivity proof:** added a scratch `src/sabotage-scratch.ts` containing `return candidate as QueuedTask;` → invariant check (a) failed with `found: src/sabotage-scratch.ts:3, src/compliance/gate.ts:137` → removed the file → 6/6 pass again
- Static-serve smoke test: `/`, `/console.js`, `/console.css`, `/api/state` all 200 with the extended state shape
- `npm run gate:eval` → exit 2, "ANTHROPIC_API_KEY not set — live eval skipped" (the documented skip path per plan 01-05; zero API calls made)

## Known Stubs

None blocking the plan goal. Two intentional notes:
- `/api/dev/submit` + the console's dev form are deliberate dev tooling — commented in server.ts as the exact pattern Phase 2 chat ingestion replaces (candidate → `submitCandidate`, never the queue)
- `StateSnapshot.queuedTaskIds` (machine-internal) is Phase-1 plumbing that nothing populates yet; the triage view renders the real TaskQueue contents and falls back to the frozen ids

## User Setup Required

Carried forward from plan 01-05 — **the phase is not verifiable-complete until the live Sonnet checks pass:**

1. Put `ANTHROPIC_API_KEY=...` in `.env` (gitignored), then run `npm run gate:eval` — expect exit 0 with zero SAFETY FAILs
2. Manual console run-through (Task 2 acceptance, needs a browser + the key): `npm run dev`, open http://127.0.0.1:4900, dev-submit "make a slot machine simulator with play money" → appears in Needs Review → Approve → appears in the pool → Audit Log shows `gate_decision` + `review_resolved` rows. The reason-tag row after destructive actions is the manual spot-check (the API side is e2e-covered)

## Next Phase Readiness

- Phase 2 chat ingestion: one call — `submitCandidate(deps, candidate)`; the invariant test will fail any shortcut automatically
- Phase 3 orchestrator: `AppHandle.registry` + `machine.setActiveTask` are ready; the triage view already renders the in-flight task
- The audit page, veto path, and halt triage are demo-ready for the first dry run

## Self-Check: PASSED

- All 4 created + 9 modified files exist on disk (verified per-file)
- Commits f58be9f, 418b549, a46a966, 34bedee, bfd4de2 present in git log
- 210/210 tests green; typecheck + lint exit 0; SINGLE_DELETE_OK; innerHTML=0; confirm()=0; gate:eval exit 2 (documented no-key skip)

---
*Phase: 01-compliance-gate-kill-switch*
*Completed: 2026-07-09*
