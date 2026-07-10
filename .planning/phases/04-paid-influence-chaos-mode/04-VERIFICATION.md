---
phase: 04-paid-influence-chaos-mode
verified: 2026-07-10T12:43:00Z
status: human_needed
score: 5/5 success criteria verified (against injected fakes); 6/6 requirements proven-vs-fakes
mode: mvp
re_verification:
  previous_status: issues_found (04-REVIEW.md, deep code review — not a prior VERIFICATION.md)
  gaps_closed:
    - "CR-01: not-idle window denial now audited (recordWindowDenied reason 'not-idle') + narrated honestly"
    - "CR-02: exactly one window_revoked writer (the FSM) with the stable donorIdentifier; console double-write removed"
    - "CR-03: gate-approved paid-window + chaos instructions now actually reach buildSession.startBuild and run"
    - "WR-01: chaos has a real production trigger (auto-pick on toggle-on + re-pick after each build)"
    - "WR-02: non-USD tips get least-favorable floor window; label/narration use actual currency"
    - "WR-03: per-donor cooldown rebuilt from the ledger on restore()"
    - "WR-05: control_windows.amount_or_cost is REAL, comment corrected to whole-currency dollars"
    - "IN-01/IN-02/IN-03: minor ledger/narration/regex fixes applied"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Live StreamElements binding (04-08, DELIBERATELY DEFERRED, autonomous:false): create/authenticate the StreamElements account, set STREAMELEMENTS_JWT, and drive a REAL small tip; confirm a free-reign window opens with the amount->duration mapping."
    expected: "A real tip event over the live socket.io realtime channel opens a FREE_REIGN_WINDOW with duration proportional to amount (capped), a durable control_windows row, and a window_opened audit row."
    why_human: "Requires a real StreamElements account + JWT + external network socket; cannot be exercised in-process. This is the single blocking item before real paid use."
  - test: "Live channel-points redemption (04-08): re-authorize the broadcaster token with channel:read:redemptions, redeem a real reward on-channel."
    expected: "The EventSub redemption fires openWindowFromRedemption, a micro-window opens; without the scope the console shows the LOUD missing-scope pill (never silent)."
    why_human: "Requires a broadcaster OAuth re-auth (scope is added to TWITCH_SCOPES but Phase 2's token predates it) and a real Twitch redemption event."
  - test: "CR-03 state-machine control flow under a real build engine: on a live/dry-run stream, tip -> !build -> confirm the build actually STARTS on screen (not merely queued), the window drains sequential builds one-at-a-time for its full duration, and chaos toggle-on drains the pool."
    expected: "buildSession.startBuild runs the paid/chaos task in the sandbox; chat narrates 'building' only when a build starts and 'queued' otherwise; on completion the machine returns to FREE_REIGN_WINDOW/CHAOS_MODE to drain the next."
    why_human: "Real-money control-flow correctness under a genuine WSL2/agent build engine (fakes prove the wiring; a live build is the honesty check). Flagged for human verification per phase intent."
  - test: "Re-read the Bits AUP and StreamElements ToS at live-binding time (04-08)."
    expected: "Confirms external-donation-only funding remains AUP-compliant (Bits-funded free reign stays out of scope)."
    why_human: "Compliance judgment against current third-party policy text; not a codebase check."
deferred:
  - truth: "Real paid/live-platform behavior (StreamElements socket, EventSub redemption re-auth, real tip/redemption smoke test, AUP re-read)"
    addressed_in: "Plan 04-08 (Wave 5, autonomous:false — the batched live human gate)"
    evidence: "ROADMAP Phase 4 Wave 5: '04-08-PLAN.md — Live gate: StreamElements account/JWT + broadcaster re-auth + real tip/redemption smoke test + AUP re-read'"
---

# Phase 4: Paid Influence & Chaos Mode — Verification Report

**Phase Goal:** Money buys guaranteed, time-boxed control — never a compliance exemption — and chaos mode adds random-pick variance as a strictly separate mechanic.
**Verified:** 2026-07-10T12:43:00Z
**Status:** human_needed
**Re-verification:** Yes — re-confirming the 3 blockers + 5 warnings + 3 info from the deep code review (04-REVIEW.md) are genuinely closed in current code.

## Overall Verdict

**ACHIEVED AGAINST INJECTED FAKES — with the live-platform binding (04-08) deliberately deferred as a human gate.**

All five ROADMAP success criteria and all six requirements (PAID-01..04, CHAOS-01/02) are proven in the codebase against injected fakes (faked StreamElements `DonationSource` + EventSub redemptions + build engine), mirroring the Phase 3 methodology. The full suite is green: **630 tests / 57 files pass, `tsc --noEmit` clean, `biome check` clean** (independently re-run during this verification, not taken from SUMMARY claims).

The three code-review blockers are **genuinely closed in current code** (verified line-by-line, not from commit messages):
- **CR-01 CLOSED** — a not-idle denial now writes a `window_denied` audit row with `reason: "not-idle"` and narrates the true cause.
- **CR-02 CLOSED** — exactly one `window_revoked` writer (the FSM) with the stable `donorIdentifier`; the console double-write is gone.
- **CR-03 CLOSED** — gate-approved paid-window and chaos instructions now actually reach `buildSession.startBuild` and run; the e2e tests genuinely drive builds to `done` (not just assert `queue.length === 1`).

The residual before real paid use is the **live gate (04-08)**: a real StreamElements JWT/account, a `channel:read:redemptions` broadcaster re-auth, and a real tip/redemption smoke test — quarantined by design (`autonomous:false`) so it never blocked the buildable slices. CR-03 control flow is additionally flagged for human verification under a genuine build engine. Hence overall status **human_needed**, not `passed`.

## Goal Achievement — Observable Truths (ROADMAP Success Criteria)

| # | Truth (Success Criterion) | Status | Evidence |
|---|---------------------------|--------|----------|
| 1 | A donation (external platform, not Bits) grants a free-reign window, duration ∝ amount, with caps + cooldowns | ✓ VERIFIED (vs fakes) | `duration.ts:49 amountToDurationSeconds` = clamp(amount*rate, min, max), hostile-input-safe; per-donor cooldown guard in `control-window.ts:221-235`; e2e `paid-window-loop` (1) opens a 1:00 window from a $5 fake tip. Real socket = 04-08. |
| 2 | A channel-points redemption grants a smaller-scale window via native EventSub redemptions | ✓ VERIFIED (vs fakes) | `main.ts:512 openWindowFromRedemption` maps `reward.cost`→duration via `redemptionConfig` (cap 120s < donation 300s); `redemption-source.ts` zod-validated seam; `channel:read:redemptions` in `TWITCH_SCOPES`. Real redemption + re-auth = 04-08. |
| 3 | Every paid-window instruction passes the identical gate, stays vetoable; windows time-boxed, revocable, logged with amount→duration | ✓ VERIFIED | `paid-window.ts:48 submitDuringWindow` re-enters the SAME `classify()`; single-funnel invariant test enforces `.enqueue(` only in `src/pipeline/` and `toQueuedTask` allowlist; `open()` writes `window_opened` with the mapping, `revoke()` writes `window_revoked`, absolute `endsAtMs` crash-safe restore. |
| 4 | Streamer can toggle chaos mode; system randomly picks the next task from the filtered pool instead of a vote | ✓ VERIFIED (vs fakes) | `main.ts:548-592 chaos` — `toggle()` drives IDLE↔CHAOS_MODE, auto-picks on toggle-on (WR-01); `selector.ts:30 pickChaos` uses `node:crypto.randomInt`; e2e `chaos-mode` (1) drains a 2-item pool to builds with no vote round. |
| 5 | Paid (guaranteed) and chaos (random) share no code path attaching chance to payment — verified in ARCHITECTURE | ✓ VERIFIED | `paid-chaos-separation.test.ts` — word-anchored two-direction source scan: PAID path (`control-window/**` + `paid-window.ts`) has NO RNG; CHAOS path (`chaos/**` + `chaos.ts`) references NO payment token (incl. IN-02 money-adjacent tokens); non-vacuous guards + sabotage self-test. Passes against real tree. |

**Score:** 5/5 success criteria verified against injected fakes.

## Requirement → Code → Proving-Test Trace

| Requirement | Code | Proving Test | Verdict |
|-------------|------|-------------|---------|
| **PAID-01** donation→capped/cooldown window, ∝ amount | `duration.ts` (clamp floor/cap), `control-window.ts open()` (cooldown + one-at-a-time), `persistence.ts insertWindow` | `duration.test.ts`, `control-window.test.ts`, `paid-window-loop.e2e` (1)(4)(5) | FULLY-PROVEN-VS-FAKES; live tip = 04-08 |
| **PAID-02** channel-points micro-window via native EventSub | `redemption-source.ts` (zod seam, `REDEMPTION_SCOPE`), `main.ts openWindowFromRedemption`, `twitch-auth.ts TWITCH_SCOPES` | `redemption-source.test.ts` (scope-sync + missing-scope) | PROVEN-VS-FAKES; broadcaster re-auth + real redemption = 04-08 |
| **PAID-03** identical gate, never an exemption | `paid-window.ts submitDuringWindow` (same `classify()`, no bypass), single-funnel | `single-funnel.test.ts` (b)(d), `paid-window-loop.e2e` (3) rejected `!build` not built | FULLY-PROVEN |
| **PAID-04** time-boxed, revocable, logged; crash-safe absolute endsAtMs; cooldown survives restart | `control-window.ts` (revoke/expire/restore, absolute `endsAtMs`), `readLastGrantsByDonor` (WR-03), audit `recordWindow*` | `control-window.test.ts` (crash-restore, cooldown, revoke) | FULLY-PROVEN |
| **CHAOS-01** toggle→random pick from filtered pool, and it BUILDS (WR-01/CR-03) | `main.ts chaos.pick/toggle`, `selector.ts randomInt`, `chaos.ts submitChaosPick`, `driveChaosBuild` | `chaos-mode.e2e` (1)(2)(4), `selector.test.ts`, `chaos.test.ts` | FULLY-PROVEN-VS-FAKES |
| **CHAOS-02** paid/chaos share no chance-to-payment path | `paid-chaos-separation.test.ts` (machine-enforced source scan) | invariant test (word-anchored, sabotage-tested, non-empty guards) | FULLY-PROVEN |

## Three-Blocker Re-Confirmation (from 04-REVIEW.md deep review)

| ID | Issue | Fix Commit | Current-Code Evidence | Status |
|----|-------|-----------|----------------------|--------|
| **CR-01** | not-idle denial unaudited + dishonest chat copy | `3255387` | `control-window.ts:205-219` writes `recordWindowDenied({reason:"not-idle"})` before throw; `record.ts:490` reason union widened to include `"not-idle"`; `main.ts:532 windowDeniedNotIdle` narrator branch | ✓ CLOSED |
| **CR-02** | console revoke double-writes `window_revoked` with inconsistent donor id | `6d46399` | `server.ts:693-715` revoke route calls `deps.controlWindow?.revoke()` ONLY — no second `recordWindowRevoked` (grep confirms none in server.ts); FSM `control-window.ts:333` is the sole writer, with stable `window.donorIdentifier` | ✓ CLOSED |
| **CR-03** | paid + chaos gated/queued but NEVER built (core value unmet) | `0d71cc5` | `stream-mode.ts:34` adds `BUILD_IN_PROGRESS→{FREE_REIGN_WINDOW,CHAOS_MODE}` return edges; `main.ts:931 driveWindowBuild` + `:969 driveChaosBuild` call `buildSession.startBuild` and drain one-at-a-time; `main.ts:753` narrates "building" only when `started===true`, else "queued"; e2e assert real builds reach `done` + `pipeline_stage` rows | ✓ CLOSED |

## Warnings & Info Re-Confirmation

| ID | Fix | Evidence | Status |
|----|-----|----------|--------|
| WR-01 | chaos production trigger | `main.ts:565` auto-pick on toggle-on; `:588/:989` re-pick after each build; empty pool = null no-op | ✓ CLOSED |
| WR-02 | tip currency honored | `control-window.ts:242-247` non-USD → floor window; `:519` label in actual ISO currency | ✓ CLOSED |
| WR-03 | cooldown survives restart | `control-window.ts:355-361 restore()` seeds from `readLastGrantsByDonor` (MAX(opened_at_ms) per donor) | ✓ CLOSED |
| WR-04 | vacuous revoke test | superseded by `paid-window-loop.e2e` (5) driving the REAL ControlWindow revoke | ✓ CLOSED |
| WR-05 | amount_or_cost unit honesty | `schema.sql:113` now `REAL NOT NULL` with corrected "whole-currency dollars, NOT cents" comment | ✓ CLOSED |
| IN-01 | 30s beat on live restore | `main.ts` re-arms 30s beat after restore (commit `b5399ed`) | ✓ CLOSED |
| IN-02 | separation regex money-adjacent tokens | `paid-chaos-separation.test.ts:45` adds `pay|money|donor|amount|currency`, self-test proves flag | ✓ CLOSED |
| IN-03 | window_opened pre-transition mode | `control-window.ts:285-293` captures `priorMode` before transition | ✓ CLOSED |

## Security / Boundary Confirmations

| Check | Evidence | Status |
|-------|----------|--------|
| Coarse overlay projection (donorDisplayName + endsAtMs only, textContent, no red) | `overlay/server.ts:242` explicit narrowing to `{donorDisplayName, endsAtMs}`; `overlay.js` textContent-only `el()`, banner collapses silently on close (no error text/red) | ✓ VERIFIED |
| StreamElements/EventSub untrusted boundaries zod-validated + fail-closed | `donation-source.ts` `TipActivitySchema.safeParse` + try/catch handler isolation; `redemption-source.ts` `RedemptionEventSchema.safeParse` drop-with-log | ✓ VERIFIED |
| JWT never logged | `donation-source.ts` passes jwt only to `authenticate` emit; `main.ts:1338-1339` "NEVER logged"; log lines carry only `reason`/`err` | ✓ VERIFIED |
| Real adapters guarded to isMain | `main.ts:1364 isMain` gate; `buildDonationAdapter`/`buildTwitchAdapters` build real socket.io/EventSub only in the entrypoint branch; dynamic imports keep vitest network-free | ✓ VERIFIED |
| Console revoke/chaos routes inherit CSRF/DNS middleware | `server.ts:247` DNS-rebinding + `:279` CSRF global `app.use` before routes `:693`/`:723` ("NO new middleware — T-03-25") | ✓ VERIFIED |

## Behavioral Spot-Checks (independently re-run)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite (fake-injected paid/chaos loop) | `npm test` | 630 passed / 57 files | ✓ PASS |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | no errors | ✓ PASS |
| Lint | `npm run lint` (`biome check`) | 120 files, no fixes | ✓ PASS |
| Debt markers in phase-4 files | grep TBD/FIXME/XXX across control-window, pipeline paid/chaos, chaos, donation/redemption sources | none | ✓ PASS |

## Anti-Patterns Found

None blocking. No `TBD`/`FIXME`/`XXX` in the phase-4 core files. The one `TODO` at `main.ts:904` is a Phase-3 COMP-02 review-queue-routing note, out of scope for Phase 4.

## Human Verification Required (callouts before live use)

1. **Live StreamElements binding (04-08)** — real account/JWT + a real small tip opens a mapped window. *Blocking item before real paid use; deferred by design.*
2. **Live channel-points redemption (04-08)** — broadcaster re-auth for `channel:read:redemptions` + a real on-channel redemption; confirm the loud missing-scope pill otherwise.
3. **CR-03 control flow under a real build engine** — tip/chaos → build actually STARTS on screen, drains sequentially for the window's full duration; narration stays honest (building vs queued). *Flagged per phase intent (state-machine control flow).*
4. **Bits AUP + StreamElements ToS re-read (04-08)** — confirm external-donation-only funding stays AUP-compliant.

## Gaps Summary

No codebase gaps. All 6 requirements and all 5 success criteria are proven against injected fakes; all 3 blockers, 5 warnings, and 3 info items from the deep review are closed in current code; suite/typecheck/lint are green. The only outstanding work is the deliberately-deferred live human gate (04-08) plus the CR-03 control-flow human check — both are external-service / real-money / real-build validations that cannot be exercised in-process. Status is therefore **human_needed**, not a gap.

---

_Verified: 2026-07-10T12:43:00Z_
_Verifier: Claude (gsd-verifier)_
