---
phase: 03-sandboxed-build-engine-live-show
plan: 09
subsystem: orchestrator
tags: [BUILD-03, BUILD-04, D3-08, D3-09, D3-10, narration, operator-console, veto-abort, never-silent]

# Dependency graph
requires:
  - phase: 03-06
    provides: "createBuildSession pipeline (research→plan→COMP-02→build), OverlayBuildSource, AbortRegistry wiring, createApp composition"
  - phase: 03-05
    provides: "registerSandboxTeardown + abortActiveWork (wsl --terminate primitive)"
  - phase: 03-02
    provides: "recordBuildRefusal/recordBuildRetry/recordBuildSkip audit helpers, translate()"
  - phase: 02-04
    provides: "createNarrator + single rate-limited ChatSender; console veto route + CSRF/DNS middleware"
provides:
  - "build-session: refusal/transient-failure surface a narrated retry/skip decision (decision-pending freeze); auto-retry the build step at most once (D3-09); compliance never auto-retries; retryBuild/skipTask resolvers"
  - "Narrator build-event beats (buildPickedUp/stagePlanning/stageBuilding/buildDone/buildRefused/buildRetryingOnce/buildDeciding/buildRetryChosen/buildSkipped/comp02Rejected/buildVetoed) — exact 03-UI-SPEC copy through the single sender"
  - "console POST /api/tasks/:id/retry + /skip (mirror the veto route; inherit CSRF/DNS middleware); ConsoleState.build (task/stage + decisionPending); build-awareness panel + failed/refused decision surface + veto-abort confirmation"
  - "main.ts: retry/skip/buildStatus wired into the console; build narrator into the session; buildVetoed narrated on halt-during-build (D3-10)"
  - "tests/e2e/build-failure.e2e: failure→narrated retry/skip→skip→IDLE; refusal-as-event; veto aborts in-flight build (sandboxTeardown + AbortController, HALTED immediate)"
affects: [phase-04-paid-influence, phase-05-dry-run]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Decision-pending freeze: failed/refused keeps the machine in BUILD_IN_PROGRESS with the overlay frozen (amber) until the streamer resolves via retryBuild/skipTask — never a silent auto-IDLE"
    - "Turn-outcome → disposition mapping: failed = transient (auto-retry once) · refused = first-class event (decision, no auto-retry) · compliance-rejected = drop (never retry)"
    - "One BuildNarrator, injected into the build session; the same Narrator that carries round beats carries build beats (transition-only, off the tally budget)"
    - "New console POST routes mirror the veto route verbatim and inherit the uniform CSRF+DNS-rebinding middleware — zero new middleware (T-03-25)"
    - "Late-binding closures (orchestrator?.retryBuild / snapshot) into the console server, composed before the orchestrator — mirrors the twitchStatus late-binding pattern"

key-files:
  created:
    - src/operator-console/server.test.ts
    - tests/e2e/build-failure.e2e.test.ts
  modified:
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/shared/types.ts
    - src/operator-console/server.ts
    - src/operator-console/public/console.js
    - src/operator-console/public/console.css
    - src/operator-console/public/index.html
    - src/main.ts
    - tests/e2e/build-flow.e2e.test.ts

key-decisions:
  - "A failed/refused build FREEZES a decision (machine stays BUILD_IN_PROGRESS) rather than auto-returning to IDLE — the streamer resolves via retry/skip; this supersedes 03-06's immediate refusal→IDLE (build-flow e2e updated)"
  - "Turn outcome disambiguates auto-retry: `failed`=transient→auto-retry once; `refused`=first-class event→decision, no auto-retry; `compliance-rejected`/COMP-02→drop, never retry"
  - "retryBuild re-runs from the approved plan when available (UI-SPEC: 'retry runs the build from the plan'); a pre-plan failure re-runs the whole pipeline (planText=null)"
  - "buildVetoed narration fires from main.ts's HALT_TRIGGERED handler (decoupled from teardown) — the honest word stays on the console, the overlay stays coarse/amber (T-03-16)"
  - "Skip Task is a neutral secondary button (.button-neutral), NOT destructive-red — scarce red stays on Halt/Veto/Reject (03-UI-SPEC)"

patterns-established:
  - "Never-silent doctrine is structural: every failure/refusal path narrates a beat AND surfaces a console decision before the build can end"
  - "Build-decision console routes as thin injected-hook forwarders (deps.retryBuild?/skipTask?) + pushState"

requirements-completed: [BUILD-03]

# Metrics
duration: ~27min
completed: 2026-07-10
---

# Phase 3 Plan 09: Graceful Build Failure, Refusal & Veto-Abort Summary

**Build failures never go silent: a mid-build model refusal is a first-class narrated `refused` event, a transient/tooling failure auto-retries the build step at most once and then freezes a narrated retry/skip decision on the operator console (mirrored veto-route POSTs) and in chat, compliance failures drop without retry, and a streamer veto aborts an in-flight sandboxed build end-to-end (fake sandboxTeardown + AbortController, HALTED reached immediately) — all through injected fakes with no real WSL2/query()/network.**

## Performance
- **Duration:** ~27 min
- **Started:** 2026-07-10T01:08Z (base 87b6f56)
- **Completed:** 2026-07-10T01:35Z
- **Tasks:** 3 (`type=auto`)
- **Files modified:** 13 (2 created, 11 modified) + deferred-items log

## Accomplishments

### Task 1 — never-silent failure/refusal/retry logic + build-event narration (`9bcd98c`)
- `build-session.ts`: reworked failure handling into a **decision-pending freeze**. A build turn's outcome now maps: `refused` → `recordBuildRefusal` + `buildRefused` beat + freeze (D3-08); `failed` → `recordBuildRetry` + `buildRetryingOnce` + **one** auto-retry, then `buildDeciding` + freeze (D3-09); `compliance-rejected`/COMP-02-rejected → `comp02Rejected` beat + drop to IDLE (never auto-retry). A frozen build keeps the machine in `BUILD_IN_PROGRESS` and the overlay on the amber stage until the streamer calls `retryBuild`/`skipTask`.
- `retryBuild(taskId)` re-runs the build from the approved plan (or the whole pipeline if the failure was pre-plan); `skipTask(taskId, reasonTag?)` audits `recordBuildSkip`, collapses the overlay, returns to IDLE, and dequeues. Halt/veto mid-turn is detected (`abortedNow`) and finalizes quietly — the kill-switch path owns teardown + the `buildVetoed` beat.
- `narration.ts`: added the `BuildNarrator` build-event methods (exact 03-UI-SPEC copy, 60-char title truncation, one send per transition through the single rate-limited sender). Added `BuildNarrator` to `shared/types.ts`; `Narrator extends BuildNarrator`.
- 18 build-session tests (refusal→decision, auto-retry-exactly-once, retry-recovers-to-done, retryBuild/skipTask resolution, compliance-never-retries) + narration copy/truncation tests.

### Task 2 — console retry/skip routes + build panel + veto-abort confirmation (`91aa571`)
- `server.ts`: `POST /api/tasks/:id/retry` + `/skip` mirror the veto route (zod `TaskIdParamsSchema` + `ResolveBodySchema`), call injected `retryBuild`/`skipTask`, and `pushState()`. They **inherit** the uniform CSRF (Origin+Content-Type) + DNS-rebinding loopback-Host middleware — no new middleware (T-03-25). `ConsoleState` gains a `build` field (`{ taskId, title, stage, decisionPending }`) derived from an injected `buildStatus` source; `decisionPending` = stage is `failed`/`refused`.
- `console.js`: build-awareness panel ("Building: {title}" + stage dots), the failed/refused decision surface (Retry = accent, Skip = neutral secondary, one-tap reason tag), and the D3-10 veto-abort confirmation in triage. `textContent`-only (dom-safety green). `console.css`: `.button-neutral` + build-panel/stage-dot styles.
- New `server.test.ts`: routes call the hooks / 400 on bad tags / no-op without an engine; forged cross-origin, non-JSON, and DNS-rebound requests all 403 (hooks never fire); `/api/state` build + decisionPending reflect the injected source.

### Task 3 — main.ts wiring + full failure/veto e2e (`170f12d`)
- `main.ts`: late-binding `retryBuild`/`skipTask`/`buildStatus` closures into `startConsoleServer` (composed before the orchestrator, mirroring `twitchStatus`); the chat narrator passed into `createBuildSession`; `buildVetoed` narrated from the `HALT_TRIGGERED` handler when a build was in-flight (D3-10, decoupled from teardown).
- `tests/e2e/build-failure.e2e.test.ts`: (1) transient failure auto-retries once → narrates retry + decision → `POST /skip` → IDLE + `build_skip` audit; (2) refusal → `refused` on the overlay + narrated chat line + console decision; (3) streamer Halt during an in-flight build → `abortActiveWork` invokes the fake `sandboxTeardown` and aborts the registered `AbortController`, `HALTED` immediate, `buildVetoed` narrated (BUILD-04).

## Task Commits
1. **Task 1: failure/refusal/retry logic + build-event narration** — `9bcd98c` (feat)
2. **Task 2: console retry/skip routes + build panel + veto-abort confirmation** — `91aa571` (feat)
3. **Task 3: main.ts wiring + full failure/veto e2e** — `170f12d` (feat)

## Decisions Made
See frontmatter `key-decisions`. The load-bearing one: a failed/refused build **freezes a streamer decision** instead of auto-returning to IDLE — this is the never-silent contract (BUILD-03) and required updating 03-06's `build-flow` refusal e2e (which asserted refusal→IDLE) to the decision-pending behavior.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated the 03-06 `build-flow` refusal e2e to the decision-pending contract**
- **Found during:** Task 1 (behavior change)
- **Issue:** `tests/e2e/build-flow.e2e.test.ts` (not in this plan's file list) asserted a refused build returns the machine to `IDLE`. This plan makes a refusal freeze a streamer decision (`BUILD_IN_PROGRESS`), which superseded that assertion — the test failed.
- **Fix:** Updated the test to assert the `refused` freeze (BUILD_IN_PROGRESS + `build_refused` audit) then resolve via `skipTask` → IDLE. The describe title was "03-09 preview", confirming this was the anticipated 03-09 behavior change.
- **Files modified:** tests/e2e/build-flow.e2e.test.ts
- **Verification:** `build-flow.e2e` green (8 tests).
- **Committed in:** `170f12d`

**2. [Rule 3 - Blocking] Extended two out-of-scope Narrator fakes for the widened interface**
- **Found during:** Task 1 (interface change)
- **Issue:** `Narrator extends BuildNarrator` broke inline `Narrator` fakes in `src/ingestion/twitch-chat.test.ts` and `tests/e2e/recovery.e2e.test.ts` (missing the 11 build methods; object-literal excess-property checks blocked narrowing the `startTwitchChat` param).
- **Fix:** Added no-op build-event methods to both fakes.
- **Files modified:** src/ingestion/twitch-chat.test.ts, tests/e2e/recovery.e2e.test.ts
- **Verification:** `tsc --noEmit` clean; both suites green.
- **Committed in:** `9bcd98c` (twitch-chat/recovery)

**3. [Rule 2 - Correctness] Suppressed the `buildDone` beat on a halt-aborted build turn**
- **Found during:** Task 1
- **Issue:** A halt aborts the build turn mid-stream; the consumed turn reports `ok`, which (03-06 parity) finalizes `done`. With the new narrator wired, that would send a celebratory "built it, GG" chat line after a veto.
- **Fix:** `runBuildAttempt` checks `abortedNow(ac)` (aborted signal OR mode HALTED) and finalizes quietly with no narration — the `buildVetoed` beat is owned by the halt path instead.
- **Files modified:** src/orchestrator/build-session.ts
- **Verification:** veto e2e asserts `buildVetoed` (not `buildDone`) fires.
- **Committed in:** `9bcd98c`

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 correctness)
**Impact on plan:** All necessary to make the never-silent decision-pending contract consistent across the existing suite. No scope creep.

## Issues Encountered
- **Pre-existing biome CRLF errors (5)** in untouched files (`audit/db.ts`, `compliance/categories.ts`, two fixtures, `state-machine/stream-mode.ts`) — CRLF line-ending artifacts from the Windows worktree checkout, unchanged from base 87b6f56. All 13 files changed by 03-09 are biome-clean. Left untouched per the scope boundary; logged to `deferred-items.md`.

## Known Stubs
- `onHeldForReview` in `createApp` remains the logged hook from 03-06 (COMP-02 **held**-plan → console review-queue insertion is still deferred). Not a 03-09 stub: 03-09 scopes the failure/refusal/retry-skip narration + veto-abort, and the held path still ends cleanly (audited via `comp02_decision`). The `comp02Rejected` narration for **rejected** plans is wired.
- The orchestrator `ProgressSink` in `createApp` still logs stage transitions; build chat narration now flows through the dedicated `BuildNarrator` (the sink stays presentational).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- BUILD-03 complete: failures degrade gracefully (narrated retry/skip, never silent), refusals are first-class events, and the streamer veto aborts an in-flight sandboxed build end-to-end.
- Full suite: **524 passed** (503 baseline + 21 new); `tsc --noEmit` clean; biome clean on all changed files. Single-funnel / secrets-isolation / prompt-injection / dom-safety invariants green.
- STATE.md / ROADMAP.md intentionally untouched (per orchestrator instruction).

## Self-Check: PASSED
- Created files exist: `src/operator-console/server.test.ts`, `tests/e2e/build-failure.e2e.test.ts` — both FOUND.
- Task commits exist: `9bcd98c`, `91aa571`, `170f12d` — all FOUND.
- Full suite 524 passed; typecheck clean; changed files biome-clean.

---
*Phase: 03-sandboxed-build-engine-live-show*
*Completed: 2026-07-10*
