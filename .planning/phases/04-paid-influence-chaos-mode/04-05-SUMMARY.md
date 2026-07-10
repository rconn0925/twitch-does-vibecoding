---
phase: 04-paid-influence-chaos-mode
plan: 05
subsystem: ui
tags: [operator-console, express, csrf, control-window, chaos-mode, audit, vanilla-js]

# Dependency graph
requires:
  - phase: 04-01
    provides: ControlWindowSnapshot type (console-only amountLabel), WindowTrigger, window/chaos audit helpers + WINDOW_*/CHAOS_* events
  - phase: 01 (walking skeleton)
    provides: operator console server + client (veto/retry/skip route shape, CSRF/DNS-rebinding middleware, ConsoleState, showReasonRow/postJson/el helpers)
provides:
  - ConsoleState extended with controlWindow + chaos + donations fields and a Twitch missing-scope status
  - POST /api/control-window/revoke (single-click revoke, window_revoked audit row, 409 no-window)
  - POST /api/chaos/toggle (toggle seam, InvalidTransitionError -> 409 precedence)
  - ConsoleControlWindowSource + ChaosModeSource injected seams (real impls wired in 04-07)
  - Control-window panel (donor + amountLabel ledger + client countdown + Revoke), chaos toggle, donations/missing-scope pills, six new audit filters
affects: [04-07 (wires the real control-window FSM + chaos + donation-status seams into the console)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injected structural seams default to null-object/no-op so the console composes before its real backing FSM exists"
    - "New state-changing routes registered AFTER the shared CSRF/DNS-rebinding middleware inherit it with zero new security surface (T-03-25/T-04-15)"

key-files:
  created: []
  modified:
    - src/operator-console/server.ts
    - src/operator-console/server.test.ts
    - src/operator-console/public/index.html
    - src/operator-console/public/console.js
    - src/operator-console/public/console.css

key-decisions:
  - "donations union reconciled to connected|reconnecting|unconfigured (UI-checker flag) — 'reconnecting' matches the copy, not 'disconnected'"
  - "chaos-toggle precedence backstop maps InvalidTransitionError -> 409 (IDLE<->CHAOS_MODE machine transition), mirroring the round-start 409 pattern"
  - "revoke reason-tag D-18 follow-up is a non-blocking 200 ack (window already closed) — the window_revoked ledger row is written at revoke time"

patterns-established:
  - "Console shows FULL honest detail (donor + amountLabel amount->duration math) the coarse public overlay deliberately hides"
  - "hidden-not-empty panel posture reused for the window panel (matches the build panel)"

requirements-completed: [PAID-04, CHAOS-01]

# Metrics
duration: 30min
completed: 2026-07-10
---

# Phase 4 Plan 05: Console Paid/Chaos Control Surface Summary

**Operator console gains a full-detail control-window panel with single-click Revoke, a chaos-mode toggle with D-05 precedence surfacing, donation-feed + missing-channel-points-scope pills, and two new POST routes that inherit the existing CSRF posture with zero new security surface.**

## Performance

- **Duration:** ~30 min
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- ConsoleState extended with `controlWindow` (honest full detail), `chaos`, and `donations`; Twitch status union gains `missing-scope`
- `POST /api/control-window/revoke` and `POST /api/chaos/toggle` mirror the veto/round-start route shape, inherit the shared Origin+Content-Type CSRF + DNS-rebinding loopback-Host middleware (no new middleware), and map typed errors to terse 409s
- Control-window panel renders donor (untruncated, textContent-only), trigger, the amount->duration `amountLabel` ledger line, a client-side 1s countdown, and a single-click Revoke Window (`.button-destructive`, no modal, optional D-18 reason tag)
- Chaos toggle (`.button-accent`) in the round panel with all three D-05 disabled-reason states; Start Round disabled with "Voting is off while chaos mode is on." while chaos is on
- Donations pill (`connected` green / `reconnecting` amber / `not configured` amber) + disconnected error box; Twitch missing-scope pill + re-authorization error box
- Six new audit event-type filter options (`window_opened/expired/revoked/denied`, `chaos_toggled/pick`)

## Task Commits

1. **Task 1: ConsoleState extension + revoke/chaos routes** - `2dc1bf3` (feat)
2. **Task 2: Window panel + chaos toggle + pills + audit filters** - `2121c50` (feat)

## Files Created/Modified
- `src/operator-console/server.ts` - ConsoleState + seam deps (ConsoleControlWindowSource/ChaosModeSource/donationsStatus), DonationsStatus type, missing-scope Twitch status, revoke + chaos-toggle routes
- `src/operator-console/server.test.ts` - 12 new tests: revoke (active/no-window/D-18 ack/no-seam), chaos toggle (flip/precedence-409/no-seam), inherited CSRF/DNS 403s, Phase 4 state fields
- `src/operator-console/public/index.html` - donations pill, donations error box, window panel section, six audit filter options
- `src/operator-console/public/console.js` - window panel + Revoke, chaos toggle + precedence reasons, donations pill/error, missing-scope pill/error, revoke-window reason-tag branch, 1s countdown tick
- `src/operator-console/public/console.css` - window-donor/window-mapping/chaos-on-line styling (no new color)

## Decisions Made
- **donations union reconciled** to `connected|reconnecting|unconfigured` per the UI-checker flag — the value `reconnecting` matches the "Donations: reconnecting" copy label rather than the state-contract-delta draft's `disconnected`.
- **chaos precedence backstop** catches `InvalidTransitionError` (the IDLE<->CHAOS_MODE machine transition thrown by the seam) and maps it to a 409 `{ reason: "not-togglable" }`, mirroring the round-start 409. The client also disables the button with a reason, so the 409 is a defense-in-depth backstop.
- **chaos route delegates recording to the seam** (like round-start delegates to RoundManager) while the revoke route records `window_revoked` directly, per the plan's explicit route instructions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reconciled contradictory revoke body-schema instructions**
- **Found during:** Task 1 (revoke route)
- **Issue:** The plan said both "strict-empty body schema (mirror RoundStartBodySchema)" AND "support the optional D-18 reasonTag on revoke". A strict-empty schema (`z.object({}).strict()`) would 400 on any reasonTag, making the D-18 follow-up impossible.
- **Fix:** Used the existing `ResolveBodySchema` (`{ reasonTag?: ReasonTag }.strict()`) for the revoke route — the optional-reasonTag interpretation wins since it is explicitly required for the D-18 follow-up; the chaos route keeps the strict-empty `RoundStartBodySchema`.
- **Files modified:** src/operator-console/server.ts
- **Verification:** revoke and D-18 tag-ack tests pass; full suite green.
- **Committed in:** `2dc1bf3` (Task 1 commit)

**2. [Rule 3 - Blocking] Installed missing node_modules in the worktree**
- **Found during:** Setup (before Task 1)
- **Issue:** The fresh worktree had no `node_modules`; tests/tsc/biome could not run.
- **Fix:** Ran `npm install` (added 249 packages, 0 vulnerabilities) — no package name changes, only restoring the committed dependency set.
- **Verification:** Baseline suite ran (550 passing) before any change.
- **Committed in:** n/a (no lockfile change)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking)
**Impact on plan:** Both necessary to execute the plan; no scope creep. The revoke schema reconciliation preserves the D-18 non-blocking guarantee while keeping the chaos route strict-empty.

## Known Limitations
- **Revoke D-18 reason tag is not persisted to a dedicated audit column.** `recordWindowRevoked` (shipped in Wave 1, `src/audit/record.ts`, outside this plan's files) has no `reasonTag` parameter, and modifying it would risk a merge conflict with the sibling 04-03 control-window executor. The primary `window_revoked` ledger row IS written at revoke time (with donor + trigger); the optional follow-up tag is acknowledged non-blocking (`{ revoked: false, tagged: true }`) but not stored. This matches the plan's "never blocking" requirement; persisting the tag can be added when `recordWindowRevoked` is extended in a future plan.

## Issues Encountered
- Biome flagged two auto-formatting fixes (line-wrapping in test + console.js); applied via `biome check --write`, no logic change.

## Deferred Issues
None.

## Threat Flags
None — the two new routes introduce no new network/auth/file surface beyond the existing console POST boundary, which the shared CSRF + DNS-rebinding middleware already covers (T-04-15/T-04-17 mitigated and asserted in tests; T-04-16 donor XSS mitigated via textContent-only, dom-safety green).

## Next Phase Readiness
- The console composes cleanly with no seams injected (window absent, chaos off, donations unconfigured). 04-07 wires the real ControlWindow FSM (`controlWindow` seam), chaos machine (`chaos` seam), and donation-feed status (`donationsStatus`) into `startConsoleServer`.
- Full suite: 562 passing (550 baseline + 12 new). tsc + biome clean.

## Self-Check: PASSED

All 5 modified files present; both task commits (`2dc1bf3`, `2121c50`) exist in git history.

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
