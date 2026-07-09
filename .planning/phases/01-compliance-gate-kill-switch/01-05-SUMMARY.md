---
phase: 01-compliance-gate-kill-switch
plan: 05
subsystem: compliance
tags: [comp-01, branded-types, sqlite, zod, sonnet, d-02, d-10, review-queue, gate-eval]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch (plan 01-01)
    provides: shared types (QueuedTask brand, GateResult), audit db/schema/record helpers, review_queue table
  - phase: 01-compliance-gate-kill-switch (plan 01-02)
    provides: prefilterCheck, classifyWithSonnet (fail-closed), GateDecisionSchema, fixture suite, gate.test.ts RED contract
provides:
  - classify() — the single COMP-01 chokepoint (prefilter → classifier → D-12 guard → audit → return, never throws)
  - toQueuedTask() — the codebase's ONLY `as QueuedTask` brand assertion (grep-verified exactly one)
  - TaskQueue (brand-typed enqueue, @ts-expect-error compile proof) and CandidatePool (approved-only, D-10)
  - review-queue workflow: insertHeld/approve/reject/expireStale/expireAllPending/listPending (D-05/06/07, lossless D-06 reconstruction)
  - submitCandidate — the ONLY ingestion entry point; sync D-02 HALTED refusal + async-on-submission routing (D-10)
  - recordSubmissionRefused (insert-only) + review_expired audit rows for D-07 expiries
  - scripts/gate-eval.ts + npm run gate:eval — live Sonnet fixture eval with SAFETY FAIL bar (Success Criterion 2)
affects: [01-04, phase-02-chat-ingestion, phase-03-rounds, phase-04-paid-control]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - deps-injection gate (db/classifier/prefilter/streamModeProvider all injectable; fakeClassifier for offline tests)
    - floating-promise background classification with .catch into logger (D-10)
    - two-table integrity assertions (audit rows byte-identical across review resolutions)

key-files:
  created:
    - src/compliance/gate.ts
    - src/compliance/gate.unit.test.ts
    - src/queue/pool.ts
    - src/queue/task-queue.ts
    - src/queue/task-queue.test.ts
    - src/state-machine/review-queue.ts
    - src/state-machine/review-queue.test.ts
    - src/pipeline/submit.ts
    - src/pipeline/submit.test.ts
    - scripts/gate-eval.ts
  modified:
    - src/compliance/gate.test.ts (defective third test scoped — see Deviations)
    - src/audit/record.ts (recordSubmissionRefused; review_expired event type)
    - src/audit/schema.sql (event_type comment includes submission_refused)
    - src/compliance/classifier.test.ts (pre-existing lint errors fixed)
    - package.json (gate:eval script)
    - tsconfig.json (scripts/ now typechecked)

key-decisions:
  - "Gate-level D-12 belt-and-suspenders: classify() re-coerces held-for-review outside ESCALATE_ELIGIBLE even though classifier.ts already does — guards injected fakes and future classifier implementations"
  - "GateDeps.db is optional ONLY for unit tests (the 01-02 RED contract calls classify without a db); all production wiring must pass a db so every decision is audited before return"
  - "Review resolutions take an explicit streamMode (approve via deps, reject/expire via param, default IDLE) because audit rows require NOT NULL stream_mode — plan signatures said reject(db, reviewId)"
  - "gate-eval treats all-calls-failed-closed as exit 1 (nothing was actually evaluated), distinct from the exit-2 missing-key skip"

patterns-established:
  - "Single-funnel: TaskQueue imports nothing from compliance/; the brand flows only via shared/types.ts + gate.ts"
  - "Halt-freeze semantics: refuse-before-classify with audit row; in-flight classifications settle into the passive pool"

requirements-completed: [COMP-01]

# Metrics
duration: ~25min
completed: 2026-07-09
---

# Phase 1 Plan 05: Gate Chokepoint, Queues, Review Workflow, Submission Pipeline and Live Eval Summary

**COMP-01 assembled end-to-end: classify()+toQueuedTask() as the sole route from viewer text to a build task, brand-typed queue provably unreachable otherwise, lossless held-for-review lifecycle, D-02 halt-frozen intake with full audit trail, and a live-Sonnet eval runner with an explicit safety-fail bar.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-09
- **Tasks:** 3/3
- **Files modified:** 10 created, 6 modified

## Accomplishments

- gate.test.ts (plan 01-02's RED contract) is GREEN: all 51 fixtures route correctly through classify() with an injected fake classifier; fail-closed path verified
- Full suite 187/187 tests green (up from 101); `npm run typecheck` and `npm run lint` clean project-wide, scripts/ now included in typecheck
- Single-funnel invariant grep-verified: exactly one non-comment `as QueuedTask` in src/, inside gate.ts's toQueuedTask(); task-queue.test.ts carries the passing @ts-expect-error compile proof
- Every classify() path (prefilter reject, classifier reject, approve, hold, fail-closed, no-classifier) writes exactly one gate_decision audit row before returning (COMP-05)
- D-02 proven by test: while HALTED, submitCandidate returns { accepted: false, reason: "halted" }, the classifier spy is never invoked, pool/review_queue/task queue are unchanged, and one submission_refused row carries text/username/stream_mode; acceptance resumes after recover()
- D-06 lossless review approval: approve() rebuilds the SuggestionCandidate from review_queue columns with original id/source/kind/submittedAtMs (field-equality asserted) and re-pools it; original gate_decision audit rows proven byte-identical after approve/reject/expire
- gate-eval runner written, typechecked, linted, and exit-2 path executed (no key present — zero API calls made, honoring the no-live-eval instruction for this session)

## Task Commits

1. **Task 1: Gate chokepoint + branded queue + pool** — `4e5c4e9` (feat)
2. **Task 2: Review workflow + submission pipeline with D-02 refusal** — `051fa41` (feat)
3. **Task 3 (part 1): pre-existing lint/format fixes unblocking the lint gate** — `46b219e` (style)
4. **Task 3 (part 2): live Sonnet gate-eval runner** — `f7e56e3` (feat)

## Files Created/Modified

- `src/compliance/gate.ts` — classify() + toQueuedTask(); deps-injected; fail-closed; audits every path
- `src/queue/task-queue.ts` — brand-typed enqueue; zero compliance/ imports
- `src/queue/pool.ts` — approved-only CandidatePool (passive pre-screened storage, D-10)
- `src/state-machine/review-queue.ts` — D-05/06/07 lifecycle; terminal resolutions; REVIEW_TTL_HOURS (default 4h)
- `src/pipeline/submit.ts` — zod boundary validation; D-02 gate; floating-promise routing
- `src/audit/record.ts` — recordSubmissionRefused; expiries land as review_expired (still INSERT/SELECT only)
- `scripts/gate-eval.ts` — 51 fixtures through the real gate at concurrency 4; exit 0/1/2 protocol; throwaway data/eval.db

## Decisions Made

- **Gate re-runs the D-12 escalation guard** even though classifier.ts coerces live output — the gate cannot trust any classifier implementation, injected or future
- **Review resolutions accept an explicit stream mode** (defaulting to IDLE) because audit_log.stream_mode is NOT NULL; plan 01-04's console wiring should pass the machine's real mode
- **rejected-expected fixtures that come back held-for-review are WARN, not SAFETY FAIL** in gate-eval — they route to human review, never the build queue; only wrongly-APPROVED results (or tax-07-gray not held) trip exit 1

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Defective test] gate.test.ts's wrongly-approving-classifier test was unsatisfiable as written**
- **Found during:** Task 1 (pre-implementation analysis of the RED contract)
- **Issue:** The test looped over ALL non-approved fixtures with an injected classifier that always approves, asserting the gate still never approves. With the injected classifier as sole authority, non-prefilter-catchable fixtures (e.g. tax-01-block, feat-01-chess, adv-leet-phishing) are deterministically approved; worse, held-for-review fixtures MUST reach the classifier for the it.each contract to pass (a prefilter can only reject, never hold), making the two tests mutually contradictory for any implementation
- **Fix:** Scoped the loop to prefilter-caught fixtures (defense-in-depth: the prefilter verdict is never overridden by an approving classifier), with a comment pointing to scripts/gate-eval.ts, which enforces the full-suite property against the real Sonnet as a SAFETY FAIL. No other test expectations changed
- **Files modified:** src/compliance/gate.test.ts
- **Commit:** 4e5c4e9

**2. [Rule 2 - Missing critical functionality] D-07 expiries produced review_resolved instead of review_expired audit rows**
- **Found during:** Task 2
- **Issue:** recordReviewResolution hardcoded event_type "review_resolved"; the plan's behavior spec and schema.sql's documented event vocabulary both require review_expired for expiries
- **Fix:** event type derived from the resolution ("expired-unreviewed" → review_expired); schema.sql comment extended with submission_refused. record.ts remains INSERT/SELECT-only (comment-filtered grep gate re-verified: 0 hits)
- **Files modified:** src/audit/record.ts, src/audit/schema.sql
- **Commit:** 051fa41

**3. [Rule 2 - Audit correctness] Review resolution signatures extended with stream mode**
- **Found during:** Task 2
- **Issue:** Plan interface `reject(db, reviewId): void` provides no stream mode, but audit_log.stream_mode is NOT NULL — resolutions would have to fabricate it
- **Fix:** approve() takes it via deps ({ pool, streamMode? }); reject/expireStale/expireAllPending take an optional trailing param, defaulting to "IDLE" (documented; plan 01-04's console should pass the machine's live mode)
- **Commit:** 051fa41

**4. [Rule 3 - Blocking] scripts/ was invisible to `npm run typecheck`**
- **Found during:** Task 3
- **Issue:** tsconfig include covered only src/tests/vitest.config — gate-eval.ts would never be typechecked, violating the task's acceptance criteria
- **Fix:** added "scripts/**/*.ts" to tsconfig include
- **Commit:** f7e56e3

**5. [Rule 3 - Blocking] Pre-existing lint failures blocked Task 3's repo-wide `npm run lint` gate**
- **Found during:** Task 3 verification
- **Issue:** (a) plan 01-02's compliance files were committed with biome format violations (line-width etc.); (b) classifier.test.ts had one noExplicitAny and five noNonNullAssertion violations; (c) the fresh worktree checkout materialized all files as CRLF (core.autocrlf=true, no .gitattributes), which biome's LF formatter flags
- **Fix:** biome-safe formatting applied to the six compliance files; the any-cast and non-null assertions replaced with typed casts/optional chaining; CRLF working copies normalized to LF (git-invisible — index blobs were already LF; verified via `git diff --name-only` showing only real content changes)
- **Files modified:** src/compliance/{classifier,prefilter,schema}{,.test}.ts, src/compliance/classifier.test.ts
- **Commit:** 46b219e

**6. [Minor] New test file beyond the plan's files_modified list**
- src/compliance/gate.unit.test.ts added to host the audit-exactly-once and toQueuedTask behavior tests the plan specified for Task 1 (gate.test.ts is the untouched-expectations RED contract; a separate file keeps that boundary clean)

---

**Total deviations:** 6 (1× Rule 1, 2× Rule 2, 2× Rule 3, 1× minor). All within the plan's own acceptance criteria and threat model (T-01-08/T-01-09/T-01-21); no scope creep.

## Verification Evidence

- `npx vitest run`: 187/187 tests, 14 files, all green (baseline was 101 + failing gate.test.ts collection)
- `npm run typecheck`: clean (now includes scripts/)
- `npm run lint`: clean, zero diagnostics
- Single-funnel: `grep -rn "as QueuedTask" src` after comment filtering → exactly 1 hit, src/compliance/gate.ts
- Append-only: comment-filtered UPDATE/DELETE grep on src/audit/record.ts → 0
- `npm run gate:eval` without ANTHROPIC_API_KEY → exit 2, "ANTHROPIC_API_KEY not set — live eval skipped" (GATE_EVAL_SKIPPED_NO_KEY; zero API calls)

## Known Stubs

None. All new modules are fully wired; the in-memory pool/queue are the plan's explicit Phase 1 design (audit ledger persists the compliance record; durable queue persistence is a later-phase concern).

## User Setup Required

**The phase is not verifiable-complete until the live Sonnet eval has passed.** The eval runner is written and verified up to the missing-key exit, but was intentionally not run live this session:

1. Create an API key: console.anthropic.com → API Keys → Create Key (metered billing — each of the 51 fixtures costs one Sonnet call per run)
2. Put `ANTHROPIC_API_KEY=...` in `.env` (gitignored, never committed)
3. Optionally verify the model id first: the classifier defaults to `GATE_MODEL=claude-sonnet-5` — confirm against a live GET /v1/models (carried-forward note from plan 01-02, RESEARCH Assumption A2)
4. Run `npm run gate:eval` — expect exit 0 with zero SAFETY FAILs and tax-07-gray held-for-review; iterate the system prompt in src/compliance/classifier.ts if it safety-fails

## Next Phase Readiness

- Plan 01-04 can wire the console against classify()/submitCandidate/review-queue exactly per this plan's `<interfaces>`; expireAllPending() is ready for main.ts startup wiring
- tests/invariants/single-funnel.test.ts (plan 01-04) has its target: the one brand assertion in gate.ts carries the referencing comment
- Phase 2 chat ingestion has a single call to make: `submitCandidate(deps, candidate)` — nothing else

## Self-Check: PASSED

- All 10 created files + 6 modified files exist on disk
- Commits 4e5c4e9, 051fa41, 46b219e, f7e56e3 present in git log
- 187/187 tests green; typecheck + lint clean; SINGLE_FUNNEL_OK; APPEND_ONLY_STILL_OK; GATE_EVAL_SKIPPED_NO_KEY

---
*Phase: 01-compliance-gate-kill-switch*
*Completed: 2026-07-09*
