---
phase: quick-260711-ur2-command-layer-c
verified: 2026-07-11T22:47:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: initial verification
---

# Command Layer C — Verification Report

**Goal:** Four display deliverables on the read-only overlay server — a static `/commands` page, kind chips on vote rows + both /queue lists, a one-line phase-hint fix, and a FREE REIGN usage hint — widening the public wire by exactly ONE closed `kind` enum.
**Verified against:** merged master `HEAD = deccab5`, range `eb1cc2f..deccab5`.
**Status:** PASSED

## Verdict: PASS

All six observable truths verified in the merged code. The hard invariant holds. `npx vitest run src/overlay/` = 59/59 green; `npx tsc --noEmit` = exit 0. Scope fence respected; the only out-of-plan file is the declared dev fixture `scripts/overlay-harness.ts`.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `/commands` static page lists exactly parser-recognized commands, drift-gated | ✓ VERIFIED | `commands.html` pure static (0 `<script>`); route `server.ts:488`; grep-gate `commands-page.test.ts` validates RECOGNIZED⊆parser, page tokens⊆RECOGNIZED, primaries present |
| 2 | Kind chips (NEW/TWEAK/SWAP/REVERT) on vote rows + both /queue lists | ✓ VERIFIED | `overlay.js:291-293` (vote rows), `queue.js:70-72` (pool), `queue.js:104-106` (queue); `KIND_CHIP` map inlined in both clients |
| 3 | Unknown/missing kind → NO chip (fail closed) | ✓ VERIFIED | `if (kindLabel)` / `if (poolKindLabel)` / `if (queueKindLabel)` guards; `kind-chip.test.ts` asserts banana/""/undefined/null → undefined |
| 4 | Phase-hint fits one line at 1080p, narration.ts untouched | ✓ VERIFIED | Shortened to `type !suggest — an idea or a tweak` (`overlay.js:343`); old copy absent (grep=0); `overlay-copy.test.ts` pins new + asserts old gone; `narration.ts` not in range diff |
| 5 | FREE REIGN hint shown only during active control window | ✓ VERIFIED | `overlay.js:237` appended after DEMOCRATIC (`:212`) and CHAOS (`:203`) branches early-return; reached only when `latest.controlWindow` non-null; `overlay-copy.test.ts` pins position |
| 6 | `kind` is the only new wire field; closed CandidateKind enum only | ✓ VERIFIED | See Hard Invariant below |

**Score: 6/6**

## Hard Invariant — HELD

| Check | Status | Evidence |
|-------|--------|----------|
| Only new wire field is `kind` | ✓ | `OverlayState.pool = {text,username,kind}` (server.ts:123), `queue = {text,kind}[]` (:133), `nextUp` still `string[]` (:73) |
| `kind` typed `CandidateKind` (closed enum) | ✓ | `types.ts:49` = `"suggestion"｜"project-switch"｜"revert"｜"swap"`; imported server.ts:21 |
| Projection by explicit keys (no spread) | ✓ | `buildOverlayState` builds pool/queue by literal `{text, username, kind}` / `{text, kind}` (server.ts:442-453) |
| Chip labels composed CLIENT-SIDE | ✓ | `KIND_CHIP` lookup in overlay.js:88 & queue.js:33; only enum string crosses wire |
| No gate/rationale/category/decision/amount/message leak | ✓ | `server.test.ts:884` forbidden-scan on `pool+queue` JSON for rationale/category/decision/addedAtMs; `:1003` queue-only narrowing |
| Defence-in-depth tests extended to cover kind + still pass | ✓ | pool keys sort `[kind,text,username]` (:893); queue keys sort `[kind,text]` (:1012); kind ∈ enum asserted (:895,:1014); 36/36 server tests green |

## Key Link Verification

| From | To | Via | Status |
|------|----|----|--------|
| server.ts | `/commands` | `app.get("/commands", sendFile)` GET-only, loopback allowlist | ✓ WIRED (server.ts:488; serve+403 test :1054; mutation-404 :625) |
| buildOverlayState | pool/queue wire | explicit-key projection carrying `candidate.kind` / `task.kind` | ✓ WIRED (server.ts:442-453) |
| commands.html | command-parser.ts | grep-gate sync test | ✓ WIRED (RECOGNIZED matches all 12 parser tokens exactly) |

## Data-Flow Trace

| Artifact | Source | Real data | Status |
|----------|--------|-----------|--------|
| pool chips | `poolSource.list().candidate.kind` (real CandidatePool→SuggestionCandidate.kind) | Yes | ✓ FLOWING |
| queue chips | `taskQueue.list().kind` (real TaskQueue→QueuedTask extends SuggestionCandidate) | Yes | ✓ FLOWING |
| vote-row chips | `round.snapshot().candidates[i].candidate.kind` (RoundSnapshot, unchanged) | Yes | ✓ FLOWING |
| /commands page | static server-authored copy (no wire) | N/A (by design) | ✓ VERIFIED |

## Scope Fence

| File | Expected | Status |
|------|----------|--------|
| command-parser.ts | untouched | ✓ not in range diff |
| narration.ts | untouched | ✓ not in range diff (last touch bd2d6a7, pre-range) |
| main.ts | untouched | ✓ not in range diff |
| gate/funnel, kind router, RoundSnapshot | untouched | ✓ not in range diff |
| `scripts/overlay-harness.ts` | only out-of-plan file, dev fixture | ✓ dev-only visual harness (`npx tsx`), gains `kind` on fake sources forced by interface widen; declared deviation; not a production surface |

Range `eb1cc2f..deccab5` touched only: in-scope overlay files, tests, OPERATIONS.md, SUMMARY.md, and the harness fixture. No forbidden file changed.

## Anti-Patterns

None. No red/new-accent color in `.kind-chip`/`.wc-chip`/`.banner-hint`/`.phase-hint`/`cmd-*` (all `var(--secondary)`/`var(--muted)`); `kind-chip.test.ts` CSS guard bans red/--accent/--urgency/--winner/--paid-control. No TODO/FIXME/stub in touched files. commands.html has zero `<script>`.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Overlay suite green | `npx vitest run src/overlay/` | 59 passed (5 files) | ✓ PASS |
| Full typecheck clean | `npx tsc --noEmit` | exit 0 | ✓ PASS |

## Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| command-layer-c | ✓ SATISFIED | All 6 success criteria met; hard invariant held; both automated gates green |

## Advisory (non-blocking)

Truth #4 ("fits one line at 1080p") was made deterministic-by-design: the plan chose the PRIMARY option (shortened copy pinned by exact-string test) rather than a pixel measurement. The chosen string `type !suggest — an idea or a tweak` (~34 chars @ 24px ≈ ~410px) sits comfortably within the 900px banner, so the one-line fit is well supported without needing a live render. An optional on-stream visual glance at 1080p (chips + hints in the actual OBS browser source) would confirm final polish but is not required for goal achievement.

## Gaps

None.

---
_Verified: 2026-07-11T22:47:00Z_
_Verifier: Claude (gsd-verifier)_
