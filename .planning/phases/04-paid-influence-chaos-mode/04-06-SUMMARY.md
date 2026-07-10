---
phase: 04-paid-influence-chaos-mode
plan: 06
subsystem: compliance
tags: [chaos-mode, single-funnel, invariant-test, source-scan, crypto-randomint, paid-influence]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch
    provides: "classify() + toQueuedTask() single-funnel gate, TaskQueue, single-funnel.test.ts invariant, scan-helpers.ts"
  - phase: 04-paid-influence-chaos-mode (04-03)
    provides: "ControlWindow FSM with the injected submitDuringWindow seam"
provides:
  - "src/chaos/selector.ts pickChaos() — uniform chaos pick via node:crypto.randomInt (the phase's sole RNG call-site)"
  - "src/pipeline/paid-window.ts submitDuringWindow() — the concrete impl behind ControlWindow's injected funnel seam (PAID-03: guaranteed selection, still gated)"
  - "src/pipeline/chaos.ts submitChaosPick() — chaos single-funnel re-entry mirroring enqueueWinner (staleness re-submit, never a silent re-roll)"
  - "tests/invariants/paid-chaos-separation.test.ts — machine-enforced D-08/CHAOS-02 separation (paid path no RNG; chaos path no payment) with word-anchored regex + sabotage self-test"
affects: [04-07, 04-chaos-mode-wiring, composition-root]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-funnel re-entry: a new candidate source gets a narrow src/pipeline/*.ts wrapper calling the SAME classify()+toQueuedTask()+enqueue(), allowlisted atomically in single-funnel.test.ts"
    - "Paired directional source-scan invariant (mirror of secrets-isolation): scan set A for token X, scan set B for token Y, plus a sabotage self-test and a non-empty-scan guard"
    - "Word-anchored token regex (\\b...\\b) to prevent innocent-substring false matches in source scans"

key-files:
  created:
    - src/chaos/selector.ts
    - src/chaos/selector.test.ts
    - src/pipeline/paid-window.ts
    - src/pipeline/paid-window.test.ts
    - src/pipeline/chaos.ts
    - src/pipeline/chaos.test.ts
    - tests/invariants/paid-chaos-separation.test.ts
  modified:
    - tests/invariants/single-funnel.test.ts

key-decisions:
  - "chaos.ts mirrors enqueueWinner (stored gate result + D2-05 staleness re-submit) rather than re-classifying every pick — pool entries are already gate-approved at intake; staleness re-submit avoids a silent re-roll (Pitfall 3)"
  - "Word-anchored PAYMENT_TOKEN regex per plan-checker W5 fix, superseding the RESEARCH sketch's unanchored version, so 'tip' can never match 'multiple' etc."

patterns-established:
  - "Directional separation invariant: two module sets each forbidden a distinct token class, enforced by a comment-stripped source scan with a sabotage self-test"

requirements-completed: [PAID-03, CHAOS-01, CHAOS-02]

# Metrics
duration: 16min
completed: 2026-07-10
---

# Phase 4 Plan 06: Chaos Selector + Single-Funnel Re-Entry + Paid↔Chaos Separation Summary

**The enforcement spine of Phase 4: a `node:crypto.randomInt` chaos selector, two narrow single-funnel re-entry points (`paid-window.ts`, `chaos.ts`) routing paid/chaos tasks through the IDENTICAL gate the vote path uses, and a machine-checked `paid-chaos-separation.test.ts` proving chance is never wired to payment — PAID-03 and CHAOS-02 asserted in the architecture, not by review vigilance.**

## Performance

- **Duration:** ~16 min (including a full `npm install` in the fresh worktree)
- **Tasks:** 3 completed
- **Files created:** 7
- **Files modified:** 1 (single-funnel allowlist)

## Accomplishments
- Chaos selector: `pickChaos()` uniform pick from the already-gate-filtered pool via `node:crypto.randomInt` — the phase's single RNG call-site, injectable for deterministic tests, null-safe on an empty pool (CHAOS-01).
- Two single-funnel re-entry points routing through the SAME `classify()`+`toQueuedTask()`+`enqueue()` chain: `paid-window.ts` (guaranteed selection, still fully gated — PAID-03, no exemption) and `chaos.ts` (mirrors `enqueueWinner` with a D2-05 staleness re-submit, never a silent re-roll). No second enqueue/brand path.
- Extended the single-funnel invariant allowlist by exactly the two new callers, landed atomically with them so `single-funnel.test.ts` stayed green.
- New `paid-chaos-separation.test.ts` (D-08/CHAOS-02): paid path scanned for ZERO RNG references, chaos path scanned for ZERO payment references, with a WORD-ANCHORED payment regex, a sabotage self-test on planted offenders (both sides), an innocent-substring guard, and a non-empty-scan guard.

## Task Commits

Each task was committed atomically:

1. **Task 1: Chaos selector (TDD)** — `4b299a2` (feat)
2. **Task 2: Single-funnel re-entry (paid-window + chaos) + allowlist extension** — `c9c09ee` (feat)
3. **Task 3: paid↔chaos separation invariant (source scan + sabotage self-test)** — `b59a908` (test)
4. **Fixup: mode-override type conflict + biome formatting** — `9e96177` (fix)

_Task 1 was TDD; RED (missing-module failure) and GREEN were folded into the single `feat` commit after the impl passed._

## Files Created/Modified
- `src/chaos/selector.ts` — `pickChaos(pool, rng?)`; the only RNG-importing module in the phase (D-08 chaos side).
- `src/chaos/selector.test.ts` — empty-pool/null, single-item, injected-rng determinism, exclusive-bound, and a `node:crypto.randomInt`-present / no-`Math.random` source assertion.
- `src/pipeline/paid-window.ts` — `submitDuringWindow()`; HALTED guard → IDENTICAL `classify()` → typed rejected/held → `toQueuedTask`+`enqueue`. Concrete impl behind ControlWindow's injected seam.
- `src/pipeline/paid-window.test.ts` — HALTED (no classify/enqueue), rejected, held, approved (one branded task enqueued).
- `src/pipeline/chaos.ts` — `submitChaosPick()`; mirrors `enqueueWinner` (stored result + staleness re-submit), narrates a stale pick instead of silently re-rolling.
- `src/pipeline/chaos.test.ts` — HALTED, fresh-pick enqueue, stale-pick re-submit (never enqueues stale).
- `tests/invariants/paid-chaos-separation.test.ts` — two directional source scans + word-anchored payment regex + sabotage self-test + non-empty guard.
- `tests/invariants/single-funnel.test.ts` — check (d) allowlist extended by `paid-window.ts` + `chaos.ts`, description string updated.

## Decisions Made
- **chaos.ts uses the stored gate result + staleness re-submit (mirrors `enqueueWinner`), not a fresh classify() on every pick.** Pool entries are gate-approved at intake; re-classifying only on staleness (D2-05) is the established Phase 2 pattern and avoids a silent re-roll (Pitfall 3). classify() is still reached transitively via the injected `resubmit` seam.
- **Word-anchored `PAYMENT_TOKEN` regex** (`/\b(donation|tip|cheer|streamelements|redemption|channel_points)\b/i`) per the plan-checker W5 fix, replacing the RESEARCH sketch's unanchored version. Proven by an explicit innocent-substring guard (`pickMultiple()` / `description` NOT flagged) alongside the planted-offender self-test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `mode` override type conflict in test helpers**
- **Found during:** Task 2 (verification / tsc)
- **Issue:** The `deps()` test helpers typed their override param as `Partial<Deps> & { mode?: StreamMode }`, which intersected the dep's `mode: () => StreamMode` with `mode?: StreamMode`, producing an impossible `(() => StreamMode) & StreamMode` type and a tsc error.
- **Fix:** `Omit<Partial<Deps>, "mode"> & { mode?: StreamMode }` so the plain-`StreamMode` override replaces (not intersects) the functional dep type.
- **Files modified:** `src/pipeline/paid-window.test.ts`, `src/pipeline/chaos.test.ts`
- **Verification:** `tsc --noEmit` clean; both test files pass.
- **Committed in:** `9e96177`

**2. [Rule 3 - Blocking] Comment containing the literal `Math.random` tripped the selector's own source assertion**
- **Found during:** Task 1 (TDD GREEN)
- **Issue:** `selector.test.ts` asserts the raw (non-stripped) source contains no `Math.random`; a doc comment in `selector.ts` used the phrase "not Math.random", failing that assertion.
- **Fix:** Reworded the comment to "not the seedable stdlib PRNG".
- **Verification:** `selector.test.ts` all 5 tests pass.
- **Committed in:** `4b299a2` (folded into the task commit)

---

**Total deviations:** 2 auto-fixed (1× Rule 1, 1× Rule 3)
**Impact on plan:** Both were local test/impl corrections needed for the tasks to verify green. No scope creep, no architectural change.

## Issues Encountered
- **Pre-existing biome CRLF format failures (out of scope).** `npx biome check src tests scripts` reports formatting errors in files I did not touch (`src/audit/db.ts`, `src/compliance/categories.ts`, the compliance fixtures, `src/state-machine/stream-mode.ts`) — all flagged solely for CRLF line terminators (a Windows-checkout artifact in this worktree). All eight files are unmodified in my working tree. My changed files (`src/chaos/**`, `src/pipeline/{paid-window,chaos}.ts` + tests, `tests/invariants/**`) pass `biome check` clean. Logged as a deferred, repo-wide line-ending item; not fixed per the scope boundary.

## Next Phase Readiness
- The composition root / chaos-mode wiring plan can now inject: `pickChaos` (selector) → `submitChaosPick` (chaos funnel), and `submitDuringWindow` into the existing `ControlWindow` seam. All three re-enter the single funnel; no new enqueue path exists.
- Full suite green: **611 passed** (595 baseline + 16 new), `tsc --noEmit` clean, biome clean on all changed files.
- The D-08/CHAOS-02 separation is now enforced on every `npm test` run, inherited automatically by any future paid/chaos code.

## Self-Check: PASSED

- `src/chaos/selector.ts` — FOUND
- `src/pipeline/paid-window.ts` — FOUND
- `src/pipeline/chaos.ts` — FOUND
- `tests/invariants/paid-chaos-separation.test.ts` — FOUND
- Commits `4b299a2`, `c9c09ee`, `b59a908`, `9e96177` — FOUND

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
