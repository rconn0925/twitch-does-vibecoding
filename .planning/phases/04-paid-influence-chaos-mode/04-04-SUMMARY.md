---
phase: 04-paid-influence-chaos-mode
plan: 04
subsystem: ui
tags: [overlay, obs, websocket, broadcast-safety, xss, vanilla-js, coarse-projection]

# Dependency graph
requires:
  - phase: 04-01
    provides: BuildStatusView.source field + ControlWindowSnapshot/WindowTrigger shared types
  - phase: 02-05/03
    provides: read-only overlay server + full-state-on-connect+diff pattern, overlay.js/css build panel
provides:
  - "OverlayState.controlWindow coarse public projection {donorDisplayName,endsAtMs} — donor financials/message never reach the wire"
  - "OverlayControlWindowSource seam + NULL_CONTROL_WINDOW_SOURCE default (mirrors OverlayBuildSource)"
  - "Six-word pill vocabulary: FREE REIGN (violet) / CHAOS (white) added, final"
  - "Free-reign banner (top-left) + build-panel provenance chip driven by BuildStatusView.source"
affects: [04-01, 04-02, 04-03, 04-06, orchestrator-window-wiring, overlay]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Coarse public projection: server re-projects window snapshot down to exactly {donorDisplayName,endsAtMs} — defence-in-depth even if the source leaks richer fields"
    - "Banner independence: broadcast element driven by controlWindow (not the pill), persists across mode transitions, collapses silently"
    - "Client-side countdown from absolute endsAtMs on the shared 1s tick — server never streams timer frames"

key-files:
  created: []
  modified:
    - src/overlay/server.ts
    - src/overlay/server.test.ts
    - src/overlay/public/overlay.js
    - src/overlay/public/overlay.css

key-decisions:
  - "Server explicitly narrows the window snapshot to two keys rather than trusting the source — the T-04-13 coarse-surface guarantee lives on the push side, asserted against raw wire bytes"
  - "Chaos toggles ride the existing STATE_CHANGED push (mode → CHAOS pill); only WINDOW_OPENED/CLOSED/REVOKED needed new immediate-push wiring"
  - "Absent BuildStatusView.source defaults to 'vote' → no provenance chip (Wave-1 made source optional)"

patterns-established:
  - "Paid-control violet (#8B5CF6) reserved exclusively for the three free-reign elements; chaos gets no color (slate-50 white)"
  - "Attacker-controlled donor name: el()/textContent + JS 24-char truncate + CSS ellipsis backstop; message text absent entirely"

requirements-completed: [PAID-01, PAID-02, CHAOS-01]

# Metrics
duration: 7min
completed: 2026-07-10
---

# Phase 4 Plan 04: Overlay Paid/Chaos Broadcast Surface Summary

**Free-reign window banner (donor name + m:ss countdown, coarse by design), the final six-word pill vocabulary (FREE REIGN violet / CHAOS white), and a build-panel provenance chip — donor financials and message text never cross onto the public wire.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-10T11:14:01Z
- **Completed:** 2026-07-10T11:20:31Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- `OverlayState.controlWindow` coarse public projection `{donorDisplayName, endsAtMs}` — the server re-projects the window snapshot to exactly two keys, so no amount, currency, message, or trigger type can ever reach the broadcast wire (T-04-13), asserted against the raw serialized bytes.
- Pill vocabulary extended to the final six words: `FREE_REIGN_WINDOW → FREE REIGN` (violet dot), `CHAOS_MODE → CHAOS` (slate-50 white dot), replacing the Phase 2 STANDBY placeholders.
- Free-reign banner (top-left, 48px) driven by `controlWindow` not the pill — persists across `FREE_REIGN_WINDOW → BUILD_IN_PROGRESS` while the donor's build runs, collapses silently on expiry/revoke (no red, no error text, T-04-14). Countdown ticks client-side from the absolute `endsAtMs`, amber in the final 10s.
- Build-panel provenance chip: `FREE REIGN` (violet) for donation/channel_points, `CHAOS PICK` (neutral) for chaos, no chip for a vote winner (absent source defaults to "vote").
- Donor display name rendered `textContent`-only, JS-truncated to 24 chars (T-04-12); the dom-safety invariant auto-covers the new banner/chip code paths (zero innerHTML/insertAdjacentHTML/document.write/eval).

## Task Commits

Each task was committed atomically:

1. **Task 1: coarse controlWindow projection + six-word pill vocabulary + window seam** - `7af5865` (feat)
2. **Task 2: free-reign banner + provenance chip + FREE REIGN/CHAOS pill dots** - `85804cc` (feat)

## Files Created/Modified
- `src/overlay/server.ts` - Added `OverlayState.controlWindow` coarse projection, `OverlayControlWindowSource` seam + `NULL_CONTROL_WINDOW_SOURCE`, `OverlayPill` union +2 words, PILL_BY_MODE FREE REIGN/CHAOS, immediate push on WINDOW_OPENED/CLOSED/REVOKED.
- `src/overlay/server.test.ts` - Fake control-window source (deliberately rich snapshot proving server narrowing); tests for coarse projection vs raw wire bytes, immediate push, null-when-inactive, silent collapse, new pill mappings.
- `src/overlay/public/overlay.js` - Free-reign banner renderer, provenance chip on the build header, FREE REIGN/CHAOS pill variants, banner countdown on the 1s tick.
- `src/overlay/public/overlay.css` - `--paid-control` violet token, `.free-reign-banner`/dot/label/donor/countdown, `.pill-freereign`/`.pill-chaos` dots, `.provenance-chip`/`.chip-freereign`/`.chip-chaos`.

## Decisions Made
- The coarse-surface guarantee is enforced on the push side by explicit two-key re-projection in `buildOverlayState()`, not by trusting the source shape — so a future real source that carries `ControlWindowSnapshot` (amountLabel/trigger/durationMs) still cannot leak. The test's fake source returns a deliberately rich snapshot (amount/currency/message/trigger) to prove this.
- Chaos-mode presentation needs no new push wiring: a chaos toggle is a `StreamMode` change already covered by the existing `STATE_CHANGED → pushState()` subscription. Only the window lifecycle events required new immediate-push wiring.
- Reused the shared `.countdown-final` rule (defined later in the cascade) for the banner's final-10s amber, keeping a single amber source of truth.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Worktree had no `node_modules`; ran `npm install` (249 packages, 0 vulnerabilities) before executing — expected per the parallel-executor note.

## Known Stubs
None. `NULL_CONTROL_WINDOW_SOURCE` is an intentional composition-root default (mirrors the shipped `NULL_BUILD_SOURCE`), not a stub: the seam is fully live and the banner renders whenever a real source is fed by the Phase 4 window engine. The overlay composes and stays broadcast-safe before that wiring lands.

## Verification
- `npm test -- src/overlay/server.test.ts` — 19 passed (14 baseline + 5 new).
- `npm test -- tests/invariants/dom-safety.test.ts` — 4 passed (overlay.js covered).
- Full suite: **555 passed** (550 baseline + 5 new), 48 files.
- `tsc --noEmit` exit 0; `biome check` clean on all four files.

## Next Phase Readiness
- The overlay is ready to surface active paid/redemption windows and build provenance the moment the Phase 4 window engine (04-01..04-03) feeds a real `OverlayControlWindowSource` and populates `BuildStatusView.source`. No overlay changes needed downstream — wire the seam in the composition root (main.ts).
- STATE.md / ROADMAP.md intentionally untouched (parallel-executor rule).

## Self-Check: PASSED

All 4 modified files present; both task commits (`7af5865`, `85804cc`) verified in git history.

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
