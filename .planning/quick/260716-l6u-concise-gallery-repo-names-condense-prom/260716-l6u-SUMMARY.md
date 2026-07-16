---
phase: quick-260716-l6u
plan: 01
subsystem: orchestrator
tags: [gallery-publisher, github-pages, repo-naming, slug, tdd]

# Dependency graph
requires:
  - phase: quick-260711-hak
    provides: "sanitizeRepoName + per-project gallery publisher (the derivation point this condenses)"
  - phase: quick-260716-1ki
    provides: "GitHub Pages play URLs + _index-site mirror (the underscore-unreachability rule re-asserted here)"
provides:
  - "Concise repo-name derivation: sanitizeRepoName condenses to <= 4 meaningful words and <= 32 chars at word boundaries"
  - "REPO_NAME_FILLER_WORDS locked 10-word filler list (a, an, the, please, make, create, build, can, you, we) with unfiltered-first-words all-filler fallback"
  - "Condense-rule test block + deliberately updated legacy naming pins in gallery-publisher.test.ts"
affects: [gallery-publisher, overlay-play-url, chat-info-commands, gallery-index]

# Tech tracking
tech-stack:
  added: []
  patterns: ["condense-after-locked-pipeline: the new step only SUBSETS the existing [a-z0-9-] output (split/filter/rejoin on '-'), so every char-class security property is inherited, not re-proven"]

key-files:
  created: []
  modified:
    - src/orchestrator/gallery-publisher.ts
    - src/orchestrator/gallery-publisher.test.ts

key-decisions:
  - "Second-prompt publish test keeps its 'make-a-counter-app' store seed — proves stored names are lookup-only, never re-derived (plan explicitly allowed either)"
  - "REPO_NAME_* constants kept module-private (plan asked for module constants; nothing external consumes them)"

patterns-established:
  - "Word-boundary cap: while >1 word and join > 32 chars, drop the LAST whole word; hard-slice only for a single mega-word (no boundary exists)"

requirements-completed: [QUICK-l6u-01]

# Metrics
duration: 6min
completed: 2026-07-16
---

# Quick Task 260716-l6u: Concise Gallery Repo Names Summary

**sanitizeRepoName now condenses chat prompts to <= 4 meaningful words / <= 32 chars at word boundaries (filler-word drop + unfiltered fallback), so future play URLs, the overlay PLAY IT line, the gallery index, and !current/!repo replies get slugs like `space-simulation-where-fly` instead of 80-char mid-word monsters**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-07-16T15:20:00Z
- **Completed:** 2026-07-16T15:26:00Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 2

## Accomplishments

- The motivating prompt "a space simulation where we fly around the galaxy exploring beautiful planets stuff" now derives exactly `space-simulation-where-fly` (26 chars) — fillers dropped everywhere, first 4 remaining words, never cut mid-word
- Filler drop proven: "Make a Counter App!" -> `counter-app`, "can you build a calculator" -> `calculator`; all-filler "make a build" falls back to unfiltered `make-a-build` (never empty, never dated); empty/symbol titles still get `vibe-YYYYMMDD-HHMM`
- 32-char cap drops trailing WHOLE words (`extraordinary-magnificent`, a hyphen-boundary prefix of the full join); a 200-char single mega-word hard-slices to exactly 32 (no boundary exists)
- Dedupe layering unchanged and proven on the condensed base: knownNames {counter-app} + title "Make a Counter App" scaffolds `counter-app-2`
- Char rules LOCKED and re-asserted: output stays `[a-z0-9-]` only (condense only subsets the existing pipeline), so the underscore-prefixed `_index-site` mirror remains unreachable by chat-derived names

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — failing condense-rule tests + deliberate legacy-pin updates** - `478e6dd` (test) — 9 failures, exactly the new/updated naming pins; all 52 untouched tests in the file still passed
2. **Task 2: GREEN — condense step inside sanitizeRepoName** - `cd6ad0e` (feat)

_TDD gate compliance: test commit precedes feat commit, both scoped quick-260716-l6u._

## Files Created/Modified

- `src/orchestrator/gallery-publisher.ts` - REPO_NAME_FILLER_WORDS / REPO_NAME_MAX_WORDS=4 / REPO_NAME_MAX_CHARS=32 constants + condense step appended AFTER the locked pipeline inside sanitizeRepoName; doc comment and file-header bullet updated to describe the condense rule
- `src/orchestrator/gallery-publisher.test.ts` - new "concise condense rule (quick-260716-l6u)" describe block (7 tests: motivating case, filler drop, all-filler fallback, word-boundary cap, mega-word slice, condensed-base dedupe, preserved-behavior re-pins); legacy pins deliberately updated (hostile-title length 80->32, `make-a-counter-app` -> `counter-app` in the readable-slug pin + first-prompt publish test, `make-a-counter.git` -> `counter.git` in the token-isolation test)

## Decisions Made

- Kept the second-prompt publish test's `make-a-counter-app` store seed as-is — it exercises the lookup path (no derivation), and keeping it proves stored names are never re-derived. Plan explicitly allowed either choice.
- REPO_NAME_* constants are module-private (not exported) — the plan asked for module constants and no external consumer exists; the artifact `contains: REPO_NAME_MAX_CHARS` requirement is satisfied.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Verification Results

- `npx vitest run` — **1303 passed, 0 failed** (baseline 1296 + 7 new condense tests)
- `npx tsc --noEmit` — clean
- `npx biome check` on both touched files — clean
- Combined diff vs base `3df0e37` touches ONLY `src/orchestrator/gallery-publisher.ts` and `src/orchestrator/gallery-publisher.test.ts`
- `normalizeSwapName` (src/main.ts:287) byte-identical — the !swapbuild needle normalizer is NOT condensed; `dedupName(sanitizeRepoName(...))` call shape in scaffoldRepo unchanged
- Generation-6 data, DB rows, and remote repos untouched (future naming only — `voidfarer` hand-rename stands)

## Threat Register Outcomes

- T-l6u-01 (char-class tampering): mitigated — condense only subsets `[a-z0-9-]` pipeline output; hostile-input + char-class + underscore-unreachability re-asserted in the new block
- T-l6u-02 (dedup namespace collisions): mitigated — condensed-base collision test pins `counter-app` -> `counter-app-2`
- T-l6u-03 (swap-needle corruption): mitigated — main.ts untouched, diff-scoped verify confirms

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Every FUTURE first-prompt publish gets a concise repo name; nothing retroactive changes
- Note for the operator: shorter bases will collide more often across stream nights — the existing `-2`/`-3` dedupe suffixing absorbs this by design

## Self-Check: PASSED

- SUMMARY.md exists at the planned path
- Commit `478e6dd` (test) exists
- Commit `cd6ad0e` (feat) exists
- Suite 1303/1303, tsc clean, biome clean on touched files

---
*Phase: quick-260716-l6u*
*Completed: 2026-07-16*
