---
phase: quick-260717-2gr
plan: 01
subsystem: orchestrator + operator-console
tags: [d-08, wr-03, comp-02, review-queue, preview-taint, auto-decline]
requires: [quick-260717-093 (holdover-aware reroot), quick-260716-tqz (preview holdover), quick-260716-rll (dispatchBuild funnel)]
provides:
  - "COMP-02 held-for-review verdicts (pre-build + mid-build) PARK the build in the console review queue instead of tossing it"
  - "Streamer approve-resume through dispatchBuild (single funnel), reject/120s-timeout down today's denial path"
  - "REVIEW_HOLD_TIMEOUT_SECONDS auto-decline knob (default 120s) with live m:ss console countdown"
affects: [build-session, main composition, console review routes/UI, review-queue]
tech-stack:
  added: []
  patterns:
    - "park exit (skipTask-shaped clean IDLE exit without finalize/history/teardown-hook)"
    - "late-bound heldBuilds seam (driveWindowBuild idiom)"
    - "P4 fail-closed preview taint (previewParked flag guards ALL raw reroot subscribers)"
key-files:
  created:
    - src/main.test.ts
    - tests/e2e/held-review-park.e2e.test.ts
  modified:
    - src/orchestrator/comp02.ts
    - src/orchestrator/comp02.test.ts
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/prompt-boundary.ts
    - src/orchestrator/prompt-boundary.test.ts
    - src/orchestrator/index.ts
    - src/state-machine/review-queue.ts
    - src/state-machine/review-queue.test.ts
    - src/audit/record.ts
    - src/shared/types.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/ingestion/twitch-chat.test.ts
    - src/main.ts
    - src/operator-console/server.ts
    - src/operator-console/server.test.ts
    - src/operator-console/public/console.js
    - tests/e2e/recovery.e2e.test.ts
decisions:
  - "Pre-build holds do NOT terminate the sandbox (nothing spawned) — the healthy 5555 dev server keeps serving; only mid-build holds tear down + write the sandbox_teardown row (P4 doctrine: 'no teardown happened')"
  - "Park is NOT a finalize: no pipeline_stage emit, no build_history row, no fireTeardownHook — audit chain is comp02(held) → build_parked_for_review → review_resolved/review_expired"
  - "heldBuilds seam uses onChange(handler) (no event-name constant) — shared/events.ts untouched"
  - "Expiry e2e proves the knob (REVIEW_HOLD_TIMEOUT_SECONDS=1, real timers); the 119s/120s default boundary is fake-timer-pinned in src/main.test.ts"
metrics:
  duration: "~35 min"
  completed: "2026-07-17"
  tests: "1486 passing (+63 over the 1423 baseline)"
---

# Quick 260717-2gr: D-08 Held-for-Review Routing (Parked Builds, 120s Auto-Decline) Summary

COMP-02 held verdicts now PARK builds in the console review queue (approve resumes via dispatchBuild with the original provenance; reject/120s-timeout auto-declines down the comp02Rejected denial path), closing both 2026-07-16 live incidents.

## What was built

**Task 1 — orchestrator core** (`ab29c1f` RED → `6564489` GREEN)
- `Comp02Outcome`'s held arm carries `category` + `rationale` (D-12 non-null on the live gate; defensive "gut-feeling"/"" fallback, never throws).
- `build-session.ts` gained `parkForReview()`: mid-build → abort + ONE `sandboxAdapter.terminate()` + `sandbox_teardown` row ("parked for streamer review (D-08)"); both phases → `build_parked_for_review` row + `buildHeld` beat + widened `onHeldForReview(task, heldText, { phase, category, rationale, provenance })` hook (own try/catch) + skipTask-shaped clean exit (dequeue BEFORE the guarded IDLE transition — t1n ordering; NO history row, NO `fireTeardownHook`). The old finalize-refused held path (and its D-08 TODO) is gone.
- `startBuild(task, prov, { resume: { phase } })`: `"pre-build"` skips ONLY the pre-build re-screen (streamer approval IS the escalation resolution — no infinite park loop); `"mid-build"` re-screens in full AND the build prompt gains the fixed host-authored `APPROVED_CONTINUATION_NOTE` (appended strictly OUTSIDE the SAND-04 delimiters; absent opts → byte-identical output, exact-equality pinned). Both narrate the new `buildResumedFromReview` beat. HALTED still refuses resume dispatches.
- `review-queue.ts`: `resolveParked()` (resolve WITHOUT re-pooling + `review_resolved` row) and `expireOne()` (`review_expired` row), both throw-free/idempotent (return false on missing/terminal rows).
- `record.ts`: `recordBuildParked` (event_type `build_parked_for_review`, source "orchestrator", decision "held-for-review").

**Task 2 — composition + console** (`5418164` RED → `e69de26` GREEN)
- `main.ts`: `parkedReviews` registry (retains the branded QueuedTask — no re-branding, gate.ts untouched), `reviewHoldEvents`, late-bound `heldBuildsSeam`. The real `onHeldForReview` handler inserts the review row (mid-build rationale = classifier rationale + `\n---\n` + first 1500 chars of the flagged batch; plain rationale pre-build), arms the unref'd per-item timer (`REVIEW_HOLD_TIMEOUT_SECONDS`, default 120s), applies P4 preview semantics, and pushes the console. `expireParkedReview` = guard-first `expireOne` → discard → `comp02Rejected` denial beat → push. Seam `resolve()` checks HALTED before approving (409 conflict, row stays pending, timer keeps running), clears the timer, and fire-and-forgets `dispatchBuild(entry.task, entry.provenance, { resume: { phase } })` — still exactly ONE `buildSession.startBuild(` call site.
- P4 preview taint: `previewParked` flag; project-switch holds fire one raw holdover-aware reroot (previous project back on screen, holdover retained); tweak holds withhold the 093 resurrection. Guards added to BOTH raw reroot subscribers (`onBuildTeardown` handler and the HALTED-exit subscription) with `previewParked && previewHoldoverGeneration === null`. Discharges: approve-of-tweak, next done build (`onBuildDone`), and every `rerootPreviewNow` operator path.
- `server.ts`: optional `heldBuilds` seam; approve/reject routes consult `expiresAtMs(id) !== null` FIRST (parked → seam; "conflict" → 409; "not-held" race → falls through to the byte-identical intake path); `ConsoleState.review` items carry `expiresAtMs` (null for intake holds); `onChange` → `pushState`.
- `console.js`: "PARKED BUILD" amber pill (status-held) + "auto-declines in m:ss" countdown line via the existing `formatRemaining`; the 1s tick re-renders the review view while any item is parked. textContent-only throughout.

**Task 3 — e2e proof matrix** (`39fb3d9`)
`tests/e2e/held-review-park.e2e.test.ts` (18 tests) drives the REAL createApp composition: incident replay 1 (mid-build park → approve → done, workspace intact, full audit chain, flagged bytes absent from overlay + chat wire), incident replay 2 (pre-build hold gets a console row; approve without re-screening; reject variant), project-switch holdover semantics (reroot at holdover dir, survives reject, done/approve discharge), expiry knob (audited + narrated + park kept), T-2gr-03 re-hold recurrence (an approved continuation that re-emits flagged output re-parks), the halt matrix (park survives, 409 while HALTED, recovery never resurrects taint, post-recovery approve works), and the structural grep gates.

## Verification

- Full suite: **1486 passing** (baseline 1423, +63; zero failures).
- `npx tsc --noEmit` clean; `npx biome check .` clean on all touched files (3 pre-existing overlay.css warnings, untouched files).
- Grep gates: exactly 1 `buildSession.startBuild(` in src/main.ts (test-enforced twice: save-and-close gate A + the new 2gr gate).
- Byte-rails verified by git diff vs base `7075376`: zero changes under `src/compliance/`, `src/preview/`, and to `paid-window.ts`, `duration.ts`, `auto-cycle.ts`, `gate.ts`. Intake-hold 4h TTL flow (`REVIEW_TTL_HOURS`, 15-min sweep, boot `expireAllPending`) byte-identical — boot expiry also covers crash-restore of parked rows (fail-closed).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Expiry "default 120s with fake timers" pinned at the createApp level, knob-override pinned in BOTH layers**
- **Found during:** Task 2/3
- **Issue:** Running the 119s/120s fake-timer boundary inside the e2e file (which already runs five real createApp instances with real sockets) risked timer-faking interference across apps.
- **Fix:** The exact fake-timer 119s-pending/120s-expired boundary + the knob override + the resolution-beats-timer race live in `src/main.test.ts` (fake timers, auto-cycle paused); the e2e file proves the knob (`REVIEW_HOLD_TIMEOUT_SECONDS=1`) end-to-end with real timers, plus the audited/narrated/park-kept behavior. Same proof coverage, deterministic suites.
- **Files:** src/main.test.ts, tests/e2e/held-review-park.e2e.test.ts

**2. [Rule 1 - Bug] Test-harness marker runner was one-shot**
- **Found during:** Task 2 GREEN
- **Issue:** The RED harness's `flaggedOnce` flag meant later tests in the same app could not drive a second hold.
- **Fix:** The runner now flags every "flagme" build EXCEPT approved continuations (detected via the host-authored note), which also mirrors reality; an `alwaysFlag` variant drives the T-2gr-03 recurrence e2e.
- **Files:** src/main.test.ts, tests/e2e/held-review-park.e2e.test.ts

Everything else executed as planned (all pinned decisions P1–P8 implemented as written).

## Accepted edge (documented per plan, no code)

If the workspace rotates during the 120s park window (another switch build shipping within 2 minutes — build durations make this near-impossible), the continuation builds in the CURRENT workspace; the prompt says "continue from the current workspace state", and the content was already approved.

## Known Stubs

None — no placeholder values or unwired surfaces introduced.

## Threat Flags

None — no security surface beyond the plan's threat model. All six T-2gr mitigations implemented and test-asserted (review detail console-only with e2e raw-bytes-absent proof; approve rides existing CSRF + loopback; resume screening per T-2gr-03 with recurrence proof; 120s fail-closed decline; full audit chain; P4 taint guards on all raw reroot subscribers).

## Deploy note (CEF cache — batch at next startup ritual)

`console.js` changed (parked-build pill + countdown). The app is shut down for the night; changes deploy at the next startup ritual, and the operator-console browser source needs a **refreshnocache** (CEF caches client JS/CSS) — batch with the other pending refreshes per the deploy memory. `REVIEW_HOLD_TIMEOUT_SECONDS` is a new optional .env knob (default 120 — no .env change needed).

## Commits

| Commit | Type | Scope |
|--------|------|-------|
| ab29c1f | test | failing tests for held-verdict park/resume core |
| 6564489 | feat | park exit, resume opts, review-queue parked resolvers |
| 5418164 | test | failing tests for console parked-review routing + 120s expiry |
| e69de26 | feat | parked registry, heldBuilds seam, 120s auto-decline, countdown UI |
| 39fb3d9 | test | e2e park/approve/expiry/halt matrix + format pass |

## Self-Check: PASSED

- src/orchestrator/build-session.ts contains "compliance-held" ✓
- src/state-machine/review-queue.ts exports resolveParked + expireOne ✓
- src/main.ts contains REVIEW_HOLD_TIMEOUT_SECONDS ✓
- tests/e2e/held-review-park.e2e.test.ts exists (18 tests green) ✓
- All 5 commits present on worktree-agent branch ✓
- Full suite 1486 > 1423 baseline; tsc + biome clean ✓
