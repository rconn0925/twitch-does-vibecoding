---
phase: 04-paid-influence-chaos-mode
plan: 07
subsystem: infra
tags: [composition-root, streamelements, eventsub, control-window, chaos, narration, e2e]

# Dependency graph
requires:
  - phase: 04-paid-influence-chaos-mode (waves 1-3)
    provides: "ControlWindow FSM, donation/redemption sources, paid-window + chaos funnels, chaos selector, overlay/console window+chaos seams, window/chaos audit recorders"
  - phase: 02-vote-loop
    provides: "createApp composition root, chat pipeline seams, rate-limited narrator, RoundManager"
  - phase: 03-build-engine
    provides: "build orchestrator composition + overlay build source pattern"
provides:
  - "createApp composes the full Phase-4 paid/chaos slice against injected seams: donation + redemption sources feed the ControlWindow FSM (paid-window funnel injected); chaos toggle + selector + chaos funnel; console revoke/toggle/donations seams; coarse overlay window projection"
  - "Open-window !build routing from ANY chatter through controlWindow.submitInstruction only (no direct enqueue) — D-11"
  - "Window/chaos chat narration (trigger-appropriate, copy-separated) via the single rate-limited sender"
  - "Guarded isMain entrypoint: real StreamElements socket + redemption subscription on the SINGLE EventSubWsListener, degrading loudly (missing JWT/scope), never in tests"
  - "paid-window + chaos end-to-end tests proving the slice against fakes"
affects: [04-08 live-platform-binding, deferred paid/chaos build-drain]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Thin chatSource wrapper at the composition root to intercept !build without editing twitch-chat.ts or adding a second EventSub subscription"
    - "Injected donation/redemption sources + chaosRng on CreateAppOptions — fakes and real adapters share one code path (02/03 seam doctrine)"
    - "Window-opened narration at the open() call site (needs amount/reward the coarse snapshot drops); expiry/revoke narration via WINDOW_CLOSED/WINDOW_REVOKED subscriptions"

key-files:
  created:
    - tests/e2e/paid-window-loop.e2e.test.ts
    - tests/e2e/chaos-mode.e2e.test.ts
  modified:
    - src/main.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/ingestion/twitch-chat.test.ts
    - tests/e2e/recovery.e2e.test.ts

key-decisions:
  - "Route !build via a thin chatSource wrapper (twitch-chat.ts/command-parser.ts out of scope) — keeps exactly ONE EventSub subscription and ONE funnel"
  - "Paid/chaos instructions are gated + enqueued but NOT auto-built here — build-triggering for non-vote sources is deferred (consistent with the existing queue-holds-tasks / winner-only build trigger); the e2e + must-haves only require the gated enqueue"
  - "In-window rejected narration uses the generic viewer-safe label (the paid funnel seam returns only a typed reason, no category) — never-silent duty still met"

patterns-established:
  - "Composition-root event→WindowGrantRequest mapping keeps control-window.ts free of ingestion imports"
  - "Single hoisted resubmit closure shared by the round funnel and the chaos controller"

requirements-completed: [PAID-01, PAID-02, PAID-03, CHAOS-01]

# Metrics
duration: 40min
completed: 2026-07-10
---

# Phase 4 Plan 07: Composition + End-to-End Paid/Chaos Slice Summary

**createApp now composes the whole Phase-4 slice against injected seams — a faked tip opens a gated, time-boxed, revocable free-reign window; open-window `!build` routes through the one funnel; chaos toggle picks randomly from the filtered pool — all proven end-to-end with fakes and narrated with trigger-appropriate, copy-separated chat.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-07-10T05:35:00Z
- **Completed:** 2026-07-10T06:03:00Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified) + 2 test-fake fixups

## Accomplishments
- Extended `createNarrator` with 13 window/chaos beats — distinct donation ("tipped") vs channel-points ("redeemed") wording, the paid↔chaos copy-separation invariant baked into the strings and asserted by a scan.
- Wired `createApp`: always-composed ControlWindow FSM (restore() before any window listener), donation + redemption sources feeding the same FSM, a chaos controller (toggle + deterministic pick through the sanctioned funnel), console (window snapshot/revoke, chaos toggle, donations pill) + overlay (coarse window projection) seams, and `!build` routing via a thin chatSource wrapper. Real StreamElements + EventSub adapters build only in the guarded `isMain` entrypoint and degrade loudly.
- Two end-to-end tests (injected fakes, zero network) prove: tip→window→gated `!build`→queue (PAID-03), rejected-instruction-keeps-window (D-12), second-tip-denied (D-05), revoke→IDLE; and chaos toggle→random pick→queue with no vote (CHAOS-01), Start-Round refused while chaos on, toggle-off reverts.

## Task Commits

1. **Task 1: Window + chaos chat narration templates** - `8fdd72c` (feat)
2. **Task 2: main.ts composition — donation/redemption/window/chaos wiring** - `8828c6e` (feat)
3. **Task 3: Paid-window + chaos end-to-end tests** - `364f1e1` (test)

## Files Created/Modified
- `src/main.ts` - Composition of the paid/chaos slice: ControlWindow FSM + injected paid funnel, donation/redemption source wiring, chaos controller, console/overlay seams, `!build` chatSource wrapper, window/chaos narration, AppHandle.close teardown, guarded real-adapter construction (StreamElements + redemption subscription).
- `src/ingestion/narration.ts` - 13 window/chaos narration beats (trigger-appropriate, copy-separated) + `formatMmss`.
- `src/ingestion/narration.test.ts` - Verbatim-copy + copy-separation-invariant tests; updated the key-set assertion.
- `src/ingestion/twitch-chat.test.ts` / `tests/e2e/recovery.e2e.test.ts` - Added the new Narrator methods to two existing fakes (Rule 3 — compile fix from the interface extension).
- `tests/e2e/paid-window-loop.e2e.test.ts` - Tip→window→gated `!build`→queue→revoke slice.
- `tests/e2e/chaos-mode.e2e.test.ts` - Chaos toggle→deterministic pick→queue (no vote)→toggle-off slice.

## Decisions Made
- **`!build` via a thin composition-root wrapper.** `twitch-chat.ts` and `command-parser.ts` are outside this plan's file boundary, so `!build` is intercepted by wrapping `chatSource.onChannelChatMessage` — one registered handler that delegates every non-`!build` message to `startTwitchChat`'s own handler. This keeps exactly ONE EventSub subscription and never enqueues directly (single-funnel green).
- **Paid/chaos instructions are gated + enqueued, not auto-built here.** Builds are triggered only by round winners today (the queue otherwise holds tasks); wiring an autonomous build-drain for non-vote sources with window-duration semantics (D-12) is deferred. The plan's must-haves and both e2e assert the gated enqueue, which is delivered.
- **Generic label for in-window rejections.** The paid funnel seam returns only `{ queued:false, reason }` (no category), so `narrator.instructionRejected(donor)` uses the generic viewer-safe fallback — never-silent duty met; the specific-category method exists for future use.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added window/chaos methods to two existing Narrator fakes**
- **Found during:** Task 2 (main.ts composition — extending the `Narrator` interface)
- **Issue:** Extending `Narrator` broke `tsc` in `src/ingestion/twitch-chat.test.ts` and `tests/e2e/recovery.e2e.test.ts`, which construct fake narrators.
- **Fix:** Added the 13 new methods as no-op/`vi.fn()` stubs to both fakes.
- **Files modified:** src/ingestion/twitch-chat.test.ts, tests/e2e/recovery.e2e.test.ts
- **Verification:** `tsc --noEmit` clean; both files' tests pass.
- **Committed in:** `8828c6e` (Task 2 commit)

**2. [Rule 3 - Blocking] npm install in a fresh worktree**
- **Found during:** Setup — the worktree had no `node_modules`.
- **Fix:** `npm install` (per the plan's worktree note). Added 249 packages, 0 vulnerabilities.
- **Verification:** Baseline `tsc` clean, baseline suite green before any edits.

---

**Total deviations:** 2 auto-fixed (both Rule 3 blocking). **Impact:** No scope creep — both were mechanical prerequisites for the interface change and the worktree environment.

## Issues Encountered
- **Biome flags 5 pre-existing CRLF files** (`src/audit/db.ts`, `src/compliance/categories.ts`, `src/state-machine/stream-mode.ts`, and two fixtures) that this plan did NOT touch — a Windows `core.autocrlf=true` line-ending condition, not a code issue. All 7 files this plan authored/edited are biome-clean. These 5 unrelated files were left untouched (reformatting them is out of scope and would bloat the diff).
- **Console `POST /api/control-window/revoke` writes two `window_revoked` audit rows** — the console route audits and `ControlWindow.revoke()` also audits (a wave-2/3 interaction). Harmless (extra append-only ledger row); left as-is because both `server.ts` and `control-window.ts` are out of this plan's file boundary. The e2e drives revoke via the FSM directly (one row).

## User Setup Required
None for tests. For live use (deferred to 04-08): set `STREAMELEMENTS_JWT` to enable tip-triggered windows, and the broadcaster must re-authorize at `/auth/start` to grant `channel:read:redemptions` for channel-points windows. Both degrade loudly (unconfigured / missing-scope) without crashing the vote loop.

## Next Phase Readiness
- Full slice green: `tsc` clean, biome clean on all authored files, 625/625 tests pass (611 baseline + 14 new), single-funnel + paid-chaos-separation invariants green.
- **Deferred:** auto-building queued paid/chaos tasks (build-trigger for non-vote sources); live StreamElements/EventSub binding + missing-scope console pill wiring from real connection state (04-08).

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*

## Self-Check: PASSED

All created files exist on disk; all three task commits are present in git history.
