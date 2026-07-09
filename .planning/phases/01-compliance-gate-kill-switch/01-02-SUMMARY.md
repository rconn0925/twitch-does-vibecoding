---
phase: 01-compliance-gate-kill-switch
plan: 02
subsystem: compliance
tags: [zod, anthropic-sdk, structured-outputs, sonnet, prompt-injection, vitest]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch (plan 01-01)
    provides: shared types (SuggestionCandidate, GateDecision, CandidateKind), installed deps, gitignored .env
provides:
  - 15-value GateCategory taxonomy (13 ToS categories + prompt-injection-attempt + feasibility) with per-category metadata and ESCALATE_ELIGIBLE set of exactly 3
  - GateDecisionSchema (zod v4) — JSON Schema for the API AND belt-and-suspenders re-parse; GateDecisionShapeSchema for pre-coercion structural parse
  - prefilterCheck() — unicode-normalizing fast-fail (NFKC, zero-width strip, hyphen→space, compact-form matching for spacing obfuscation)
  - classifyWithSonnet() — Structured Outputs call, D-12 escalation coercion, 500/1500ms retry budget, structurally fail-closed to rejected/classifier-unavailable
  - Complete fixture suite (31 taxonomy + 14 adversarial + 8 feasibility) and gate.test.ts as the intentionally-RED classify() contract for plan 01-05
affects: [01-04, 01-05, phase-02-chat-feedback]

# Tech tracking
tech-stack:
  added: []
  patterns: [deps-injection for offline classifier tests, shape-parse-then-coerce-then-refine validation pipeline, fixed zero-interpolation system prompt]

key-files:
  created:
    - src/compliance/categories.ts
    - src/compliance/schema.ts
    - src/compliance/prefilter.ts
    - src/compliance/classifier.ts
    - src/compliance/fixtures/taxonomy.fixtures.ts
    - src/compliance/fixtures/adversarial.fixtures.ts
    - src/compliance/fixtures/feasibility.fixtures.ts
    - src/compliance/schema.test.ts
    - src/compliance/gate.test.ts
    - src/compliance/prefilter.test.ts
    - src/compliance/classifier.test.ts
  modified: []

key-decisions:
  - "D-12 coercion runs on a structural shape parse BEFORE the refined schema — the refine would otherwise reject held-for-review+non-escalate outright and send a coercible response down the fail-closed path"
  - "Compact-form (whitespace-stripped) matching added for spacing obfuscation, but ambiguous-when-compact keywords (bare ddos, viewbot) deliberately excluded — 'add dos and don'ts' and 'review bot' must not false-positive; Sonnet classifier remains the safety net"
  - "Boundary test uses sentinel strings instead of 'keylogger' — the fixed system prompt legitimately names keyloggers in its category descriptions, so candidate-interpolation is proven via sentinels plus byte-identical system prompt across calls"

patterns-established:
  - "Untrusted-boundary validation: shape parse → policy coercion → refined re-parse, all before any business logic"
  - "Fail-closed classifier: no code path lets an error escape classifyWithSonnet(); final attempt returns immediately with rejected/classifier-unavailable"

requirements-completed: [COMP-01]

# Metrics
duration: ~25min (resume session; initial implementation in prior session commit 42d2c56)
completed: 2026-07-09
---

# Phase 1 Plan 02: Taxonomy, Fixtures, Prefilter and Fail-Closed Sonnet Classifier Summary

**15-category compliance taxonomy with zod Structured Outputs schema, obfuscation-resistant prefilter, and a structurally fail-closed Sonnet classifier — plus gate.test.ts as the RED executable contract plan 01-05 must turn green.**

Note on COMP-01: this plan delivers the classification core; COMP-01's full truth ("no code path can enqueue any other way") completes when plan 01-05 lands the single classify() chokepoint. Plans 01-04/01-05 also carry COMP-01.

## Performance

- **Duration:** ~25 min (this resume session) + prior session (initial implementation)
- **Completed:** 2026-07-09
- **Tasks:** 2/2
- **Files modified:** 11 created (this plan's full surface), 6 touched in this session

## Accomplishments

- All 58 unit tests green across schema (18), prefilter (27), classifier (13) — zero network calls, CI-safe without ANTHROPIC_API_KEY
- gate.test.ts RED for exactly one reason: `Cannot find module './gate.js'` (TS2307) — the intentional contract for plan 01-05; scoped typecheck excluding gate.test.ts reports zero errors
- Fixture surface complete: 31 taxonomy (all 13 categories with violation + clean-approve neighbors, 3 escalate gray-zones, project-switch D-15 case), 14 adversarial (injection, spacing/leetspeak/base64 obfuscation, roleplay, paraphrase, embedded injection), 8 feasibility (D-13/D-14 suggest-trim rationales)
- Zero occurrences of the SDK's zod output-format helper anywhere in src/compliance/ (RESEARCH Pitfall 1)

## Task Commits

1. **Task 1: Taxonomy, schema, fixtures (gate contract RED)** — `42d2c56` (prior session, feat)
2. **Task 2: Prefilter + classifier (initial)** — `42d2c56` (prior session, feat)
3. **Task 2 fix: spacing/hyphen obfuscation + alternation grouping** — `5934dd0` (fix)
4. **Task 2 fix: D-12 pre-refine coercion + fail-closed/backoff/output_config repairs** — `794d825` (fix)
5. **Task 2 fix: type-clean prefilter test assertions** — `0a95f99` (fix)

## Files Created/Modified

- `src/compliance/categories.ts` — 15-value taxonomy, per-category viewer-safe labels/dispositions/example rejections, ESCALATE_ELIGIBLE
- `src/compliance/schema.ts` — GateDecisionSchema (refined) + GateDecisionShapeSchema (structural, for pre-coercion parse)
- `src/compliance/prefilter.ts` — normalize (NFKC/zero-width/hyphen→space) + normalized and compact-form pattern tables
- `src/compliance/classifier.ts` — classifyWithSonnet with GATE_MODEL/GATE_MAX_RETRIES env defaults, 8s per-attempt timeout, 500/1500ms backoff, fail-closed sentinel
- `src/compliance/fixtures/*.fixtures.ts` — GateFixture arrays (taxonomy/adversarial/feasibility)
- `src/compliance/{schema,prefilter,classifier,gate}.test.ts` — 58 green tests + intentionally-RED gate contract

## Decisions Made

- **Shape-parse-then-coerce-then-refine:** the D-12 lean-reject coercion must see the model's raw held-for-review choice before the refine forbids it; the coerced value is still re-validated through the full refined schema before return
- **Compact-match exclusion list:** bare "ddos" and "viewbot" excluded from whitespace-stripped matching (word boundaries vanish — "add dos", "review bot" would false-positive); distinctive compounds (ddostool/ddosattack, keylogger, tokengrabber) included
- **COMP-01 left unchecked in REQUIREMENTS.md** — shared with plans 01-04/01-05; orchestrator marks it when the chokepoint truth is provable

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Spacing-obfuscated malware not caught by prefilter**
- **Found during:** Task 2 (resume — known defect from prior session)
- **Issue:** "b u i l d  a  k e y l o g g e r" passed the prefilter; patterns only ran against the whitespace-collapsed form
- **Fix:** Added compact (all non-alphanumerics stripped) matching pass with a curated high-distinctiveness pattern list
- **Files modified:** src/compliance/prefilter.ts, src/compliance/prefilter.test.ts
- **Verification:** prefilter suite 27/27 green including new false-positive guards
- **Committed in:** 5934dd0

**2. [Rule 1 - Bug] Hyphenated "view-bot" not caught**
- **Found during:** Task 2
- **Issue:** hyphens were not normalized, so `view\s*bot` missed "view-bot"
- **Fix:** normalize() replaces hyphens/dashes with a space (multi-word patterns keep matching)
- **Committed in:** 5934dd0

**3. [Rule 1 - Bug] Unparenthesized alternation rejected benign text**
- **Found during:** Task 2
- **Issue:** `/reveal|print|show|output|display\s+…/` matched bare "show" anywhere — "show a snake game" was rejected as prompt injection
- **Fix:** grouped the verb alternation and required a system-prompt noun target; regression tests added ("show a snake game on screen" passes, "reveal your system prompt" still rejected)
- **Committed in:** 5934dd0

**4. [Rule 1 - Bug] D-12 coercion unreachable — refined schema rejected the pairing first**
- **Found during:** Task 2
- **Issue:** held-for-review + non-escalate responses failed the zod refine, went down retry/fail-closed instead of being coerced to rejected with the same category
- **Fix:** structural shape parse first, coerce, then full refined re-parse
- **Files modified:** src/compliance/schema.ts (GateDecisionShapeSchema export), src/compliance/classifier.ts
- **Committed in:** 794d825

**5. [Rule 1 - Bug] Retry loop hung under fake timers; wrong backoff schedule; trailing backoff on final attempt**
- **Found during:** Task 2
- **Issue:** backoff was 500/1000/2000ms (plan: 500/1500) and ran even after the final failed attempt, so exhausted-retries never resolved within the test's advanced time
- **Fix:** BACKOFF_MS = [500, 1500]; final attempt returns the fail-closed decision immediately
- **Committed in:** 794d825

**6. [Rule 1 - Bug] Wrong output_config shape — schema constraint would be silently ignored**
- **Found during:** Task 2
- **Issue:** code sent `output_config: { type, json_schema }`; the installed SDK expects `output_config.format = { type: "json_schema", schema }` (exactly the plan's specified shape)
- **Fix:** corrected to the SDK's OutputConfig.format shape, verified against node_modules type declarations
- **Committed in:** 794d825

**7. [Rule 3 - Blocking] classifier.test.ts failed to collect (`afterEach` not imported); mock client never threw**
- **Found during:** Task 2
- **Issue:** missing vitest import masked 3 latent test failures; makeMockClient returned Error objects as responses instead of rejecting
- **Fix:** import added; mock now throws Error responses; flawed boundary test rewritten with sentinel strings (fixed system prompt legitimately mentions "keyloggers")
- **Committed in:** 794d825

**8. [Rule 1 - Bug] 23 scoped typecheck errors in plan-owned files**
- **Found during:** Task 2 verification (acceptance criterion: zero scoped tsc errors)
- **Issue:** pino Logger type misuse, untyped mock access, unnarrowed union `.category` access in tests
- **Fix:** `import type { Logger } from "pino"`, exposed typed parseMock, toMatchObject assertions
- **Committed in:** 794d825, 0a95f99

---

**Total deviations:** 8 auto-fixed (7× Rule 1, 1× Rule 3)
**Impact on plan:** All fixes were required by the plan's own acceptance criteria and threat model (T-01-07 fail-closed). No scope creep.

## Issues Encountered

- An accidental `git stash -u` during a verification command temporarily stashed uncommitted classifier work; the stash entry was verified as this session's own WIP (branch + base commit + exact file list) and immediately popped, restoring state and leaving the shared stash stack clean. All tests re-verified green after recovery.

## Known Stubs

None. gate.test.ts is not a stub — it is the intentionally-RED executable contract for plan 01-05 (imports `./gate.js`, which does not exist yet by design; all other code typechecks clean).

## User Setup Required

None - no external service configuration required. (Live gate-eval against the real Sonnet endpoint is plan 01-05's script and will need ANTHROPIC_API_KEY at that point.)

## Next Phase Readiness

- Plan 01-05 can implement gate.ts purely against gate.test.ts + exported modules (prefilterCheck, classifyWithSonnet, GateDecisionSchema, TAXONOMY_CATEGORIES) — zero open design decisions
- Verify GATE_MODEL default "claude-sonnet-5" against a live GET /v1/models before the 01-05 gate-eval run (RESEARCH Assumption A2)

## Self-Check: PASSED

- All 11 plan files exist on disk
- Commits 42d2c56, 5934dd0, 794d825, 0a95f99 present in git log
- 58/58 unit tests green; gate.test.ts RED solely on missing ./gate.js; scoped tsc errors: 0

---
*Phase: 01-compliance-gate-kill-switch*
*Completed: 2026-07-09*
