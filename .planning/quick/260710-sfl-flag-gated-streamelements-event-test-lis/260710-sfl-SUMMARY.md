---
phase: quick-260710-sfl
plan: 01
subsystem: ingestion
tags: [streamelements, donations, smoke-test, fail-closed, zod]
requires: [PAID-01 donation-source seam, dispatchTipActivity fail-closed pipeline]
provides:
  - Flag-gated (SE_ACCEPT_TEST_EVENTS) event:test listener for the SE dashboard event simulator
  - Zero-money smoke-test path for live gate 04-08's real-tip precursor
affects: [04-LIVE-GATE, 05-DRY-RUN]
tech-stack:
  added: []
  patterns: [zod looseObject at untrusted boundary, opt-in strict === "true" env flag, shared-pipeline revalidation]
key-files:
  created: []
  modified:
    - src/ingestion/donation-source.ts
    - src/ingestion/donation-source.test.ts
    - src/main.ts
    - .env.example
    - docs/OPERATIONS.md
    - biome.json
decisions:
  - "event:test handler is NOT registered when the flag is off — zero subscription, provably zero behavior delta"
  - "Normalizer builds an UNVALIDATED TipEvent candidate; validation stays in the shared dispatchTipActivity/TipEventSchema pipeline (no parallel lenient path, proven by test c2)"
  - "Accepted-event log fires on envelope recognition (before TipEventSchema); a candidate that then fails schema is still dropped — plan-sanctioned ordering"
metrics:
  duration: ~15 min
  completed: 2026-07-10
---

# Quick Task 260710-sfl: Flag-Gated StreamElements event:test Listener Summary

Opt-in `SE_ACCEPT_TEST_EVENTS=true` routes SE dashboard simulated tips (`event:test`) through the SAME fail-closed zod tip pipeline to onTip, with loud TEST MODE warnings at boot and per event — default off means the handler is never even registered.

## Tasks Completed

| Task | Name | Commits | Files |
|------|------|---------|-------|
| 1 | Flag-gated event:test listener + fail-closed normalizer (TDD) | `07267ac` (RED), `1add2e9` (GREEN) | donation-source.ts, donation-source.test.ts |
| 2 | main.ts flag wiring + .env.example + OPERATIONS.md §9 | `a04a9c7` | main.ts, .env.example, docs/OPERATIONS.md, biome.json |

## What Was Built

- **`DonationSourceOptions.acceptTestEvents`** (strict `=== true`): when on, `makeDonationSource` registers an `event:test` handler; when off/absent, no subscription exists at all (test a proves the observable: no onTip call, no throw).
- **`TestTipEnvelopeSchema`** (`z.looseObject`) + **`normalizeTestTipEnvelope`**: safeParse wrapped in try/catch (hostile getters can't throw, T-04-04 discipline); structural failure → `"SE TEST EVENT dropped — unrecognized event:test payload shape"` warn + drop; recognized non-tip listeners (follow/cheer) dropped silently, mirroring the real path. Candidate defaults: `currency: "USD"`, `tipId: se-test-<ts>` only when the simulator omits them — explicit fields honored (test b2).
- **Shared-pipeline revalidation (T-sfl-01/R2):** the normalized candidate goes through the existing `dispatchTipActivity` → `TipActivitySchema`/`TipEventSchema`; test c2 (2-letter currency passes the envelope, fails TipEventSchema, no onTip) proves there is no parallel lenient path.
- **Loud logging (T-sfl-02/03):** construction-time `"TEST MODE: simulated StreamElements events will open real control windows — NEVER enable during a broadcast"` warn (tested), per-accepted-event `"SE TEST EVENT accepted — SE_ACCEPT_TEST_EVENTS is ON"` warn, plus a belt-and-braces composition-root warn in `buildDonationAdapter`.
- **Docs:** `.env.example` documents the flag with the all-caps NEVER-on-broadcast warning; `docs/OPERATIONS.md` §9 adds the 5-step smoke-test runbook (enable → restart/verify boot warn → dashboard simulator tip → verify accepted log/overlay banner/window + revoke → disable and verify warn gone) and the `se-test-*` audit-distinguishability note.

## Verification (gate results)

- `npx vitest run` — **688/688 pass** (679 pre-existing + 9 new donation-source tests), including single-funnel and secrets-isolation invariant suites
- `npx tsc --noEmit` — clean (exit 0)
- `npx biome check .` — clean (exit 0, after Rule 3 config migration below); project lint scope `biome check src tests scripts` also exit 0
- Grep gates: `event:test` x9 in donation-source.ts; `SE_ACCEPT_TEST_EVENTS` present in main.ts (2), .env.example (1), OPERATIONS.md (3)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] biome.json schema migrated 2.0.0 → 2.5.3**
- **Found during:** Task 2 gate run
- **Issue:** The mandated gate `npx biome check .` failed with a config-deserialization error even on the untouched base commit — installed Biome CLI is 2.5.3 while biome.json declared the 2.0.0 schema and the deprecated `rules.recommended` field. Pre-existing, but it made the required gate unsatisfiable.
- **Fix:** `npx biome migrate --write` (schema URL bump + `recommended: true` → `preset: "recommended"`, semantics unchanged); lint scope re-verified green.
- **Files modified:** biome.json
- **Commit:** `a04a9c7`

**2. [Rule 3 - Blocking] CRLF checkout artifacts in 4 untouched files (worktree-local, no repo change)**
- **Found during:** Task 2 gate run
- **Issue:** `biome check` format-failed on src/audit/db.ts, src/compliance/categories.ts, and the two compliance fixtures — checked out with CRLF in this worktree despite `.gitattributes` `eol=lf` (stale-checkout artifact; index content is LF).
- **Fix:** Converted the 4 files to LF on disk (`perl -pi -e 's/\r\n/\n/g'`). Zero-byte `git diff` confirmed no content change; nothing staged for them in any commit.
- **Files modified:** none in git (working-tree normalization only)
- **Commit:** n/a

## Known Stubs

None — no placeholder values or unwired data paths introduced.

## Threat Flags

None beyond the plan's threat model — the new `event:test` surface is exactly the one T-sfl-01..04 register and mitigate (all four mitigations implemented and tested: fail-closed normalizer + shared-pipeline revalidation, strict opt-in + loud warnings + docs, `se-test-*` audit marker + accepted-event warn, handler-isolation reuse).

## Self-Check: PASSED

- src/ingestion/donation-source.ts — FOUND
- src/ingestion/donation-source.test.ts — FOUND
- src/main.ts, .env.example, docs/OPERATIONS.md, biome.json — FOUND
- Commits 07267ac, 1add2e9, a04a9c7 — FOUND in git log
