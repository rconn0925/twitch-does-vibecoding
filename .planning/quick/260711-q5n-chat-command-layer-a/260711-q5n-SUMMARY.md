---
phase: quick-260711-q5n
plan: 01
subsystem: chat-commands
tags: [twitch-chat, command-parser, vote-round, workspace-rotation, git-revert]
requires:
  - quick-260711-hak (per-project gallery publisher, ProjectRepoStore, rotation-ready workspace)
  - quick-260711-0iu (persistent workspace generations, straight-to-build)
provides:
  - "!build <idea> as a kind-tagged project-switch candidate in the SAME pool/funnel/vote as !suggest"
  - "!revert / !undo as a fixed-text revert candidate through the same funnel"
  - "kind router at drainVoteQueue: continue / ship-then-rotate / mirror-revert"
  - "GalleryPublisher.revertLast() — mirror git revert + copy-first workspace write-back + republish"
  - "audit vocabulary: revert_outcome, initiator-aware workspace_reset, build_history result 'reverted'"
affects:
  - any future tier-2 command work (revert candidates, kind routing precedent)
  - stream-night dry run (new NEW/TWEAK/REVERT round wording on broadcast)
tech-stack:
  added: []
  patterns:
    - "kind router switch at queue drain (BUILD_IN_PROGRESS as mutual exclusion)"
    - "copy-first write-back (no rm before a successful cp) for host->distro sync"
    - "awaited-vs-fire-and-forget consumption of the same never-rejecting publisher promise"
key-files:
  created:
    - tests/e2e/tier1-commands.e2e.test.ts
  modified:
    - src/ingestion/command-parser.ts
    - src/ingestion/command-parser.test.ts
    - src/ingestion/twitch-chat.ts
    - src/ingestion/twitch-chat.test.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/pipeline/submit.ts
    - src/shared/types.ts
    - src/orchestrator/gallery-publisher.ts
    - src/orchestrator/gallery-publisher.test.ts
    - src/audit/record.ts
    - src/audit/record.test.ts
    - src/audit/schema.sql
    - src/main.ts
    - tests/e2e/build-flow.e2e.test.ts
    - tests/e2e/chat-wiring.e2e.test.ts
    - tests/e2e/round-flow.e2e.test.ts
    - tests/e2e/recovery.e2e.test.ts
decisions:
  - "Revert candidates carry ONLY the fixed server-composed REVERT_REQUEST_TEXT and still pass classify() — minting an approved GateResult outside gate.ts would need a second brand path (single-funnel invariant); identical text dedups via intake duplicate refusal"
  - "Ship title is server-composed `app-<generation> final snapshot` so a never-published generation degrades to a sane repo slug"
  - "no-changes counts as a CONFIRMED ship (remote already current) — rotation proceeds"
  - "Chaos pick filters to kind 'suggestion' at the call site — selector.ts untouched, preserving the paid-chaos source-scan invariant"
metrics:
  duration: "~35 min"
  completed: "2026-07-11"
  tests: "980 pass (69 files; +63 vs 917 baseline)"
---

# Quick Task 260711-q5n: Chat Command Layer A (Tier-1 Voted Commands) Summary

`!build <idea>` and `!revert`/`!undo` are now kind-tagged candidates competing in the SAME vote round as `!suggest`, with a kind router at queue drain: suggestion → build as today, project-switch → ship-current-app-then-rotate (rotation gated on a confirmed publish), revert → host-side mirror `git revert` + copy-first workspace write-back + republish. No `!fork`.

## What Was Built

### Task 1 — Parser kinds + one-funnel dispatch + kind-aware narration (bbcd923 test, 6cccbd3 feat)
- `parseCommand`: `!build <idea>` (2000-char cap, same regex shape as main.ts's `BUILD_COMMAND`), strict no-arg `!revert`/`!undo` (trailing text → null, total, never throws), exported `REVERT_REQUEST_TEXT` — the only text a revert candidate ever carries.
- `CandidateKind` + `"revert"`, `BuildResult` + `"reverted"`, `CandidateSchema` kind enum widened; the funnel itself untouched (invariant #1).
- twitch-chat: suggest/build/revert folded into ONE path — `intake.check` BEFORE `deps.submit` for all three (D2-11, sequence-proven); funnel decision documented in the module doc.
- Narration: round-open listing is kind-aware (`NEW:` / `TWEAK:` / fixed `REVERT the last change` label); `pooled-build`/`pooled-revert` coalesced confirmations; five new beats (`revertApplied/Nothing/Failed`, `newProjectShipping/ShipFailed`) — all server-composed, failure lines amber-tier (D2-18, test-asserted no alarm words).
- main.ts (two anchored edits only): interceptor falls through to the parser when no window is live (inside-window branch byte-identical); approved chat project-switch/revert get pooled confirmations (plain suggestions stay silent, D2-15).

### Task 2 — revertLast() + audit vocabulary (8a5a86b test, cec5c8f feat)
- `GalleryPublisher.revertLast({generation, taskId})` → `{status: reverted|nothing-to-revert|failed, commitHash, detail}`:
  1. no stored repo → nothing-to-revert (zero exec calls);
  2. `continueRepo` re-clones a missing mirror;
  3. `rev-list --count` < 2 → nothing-to-revert (never empty the project);
  4. mirror `git revert --no-edit HEAD` with `-c` identity; on rejection: best-effort `revert --abort`, resolve failed, workspace bit-for-bit untouched (invariant #7, test-asserted no fs op on the UNC path);
  5. COPY-FIRST write-back: `cp` mirror→workspace (workspaceCopyFilter drops dot-entries), stale top-level prune ONLY after a successful cp — a cp failure leaves every pre-revert file intact (zero-rm test-asserted);
  6. push identical to publishNow (PAT env-only, never argv — test-asserted).
  Never rejects; serializes on the SAME chain as publishNow (interleave test).
- `recordRevertOutcome` (event_type `revert_outcome`, server-composed detail); `recordWorkspaceReset` optional `initiator: "chat-vote"` (default rationale byte-identical, test-locked); schema.sql comment-only updates.

### Task 3 — Kind router + e2e (c5fada5 test, e28b3ea feat)
- Router in drainVoteQueue's IIFE (sync prologue untouched): `shipThenRotate` implements the LOCKED USER DECISION — an active project ships via an AWAITED `publishNow` with server-composed title `app-<gen> final snapshot` + audit row; `workspace.newProject()` + chat-vote `workspace_reset` + `startBuild` ONLY on `published|no-changes`; `failed` or no publisher → no rotate, no build, task removed, amber `newProjectShipFailed`, failed `gallery_publish` row (no-publisher path writes its own — checker note honored), guarded IDLE. `runRevertWinner` removes the task FIRST, runs `revertLast` (or fixed failed outcome when no publisher), narrates by status, audits always, `build_history` `reverted` only on success, guarded IDLE. Unscaffolded workspace → skip ship/rotate, scaffold directly.
- Chaos pick call site filters `kind === "suggestion"` (selector.ts untouched).
- 28 new e2e tests (tests/e2e/tier1-commands.e2e.test.ts): mixed-round NEW/TWEAK/REVERT one-vote; ship-success ordering (publishNow gen-1 strictly before startBuild app-2; post-rotation onBuildDone publishes gen 2 — "new builds get new repositories" regression guard); ship-failure + no-publisher never rotate; no-changes rotates; revert nothing-to-revert/no-publisher graceful; free-reign in-window byte-compat + outside-window pool entry; gate-before-pool; chaos suggestion-only filter.

## Verification

- Full suite: **980 pass / 0 fail** (69 files; baseline 917 + 63 new).
- `npx tsc --noEmit` clean; `npx biome check src tests` clean.
- Invariant suite (single-funnel, paid-chaos separation, etc.): 55 pass. No new `as QueuedTask`, no new `.enqueue(` call sites (router only consumes/removes).
- Grep gate: `grep -v '^\s*//' src/ingestion/command-parser.ts | grep -ci '!fork'` → 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded a doc comment tripping the append-only source-scan invariant**
- **Found during:** Task 2 (record.test.ts invariant: record.ts must not match /UPDATE|DELETE/i)
- **Issue:** New recordRevertOutcome doc said "schema.sql update"
- **Fix:** Reworded to "schema.sql change"
- **Files modified:** src/audit/record.ts — **Commit:** cec5c8f

**2. [Rule 1 - Consequence of planned copy change] Updated two stale round-open copy assertions**
- **Found during:** Task 3 full-suite run
- **Issue:** chat-wiring/round-flow e2e asserted the pre-q5n `[1] <title>` round-open copy; the plan's must_have deliberately changes this to kind-aware `TWEAK:` wording
- **Fix:** Assertions updated to `[N] TWEAK: <title>`
- **Files modified:** tests/e2e/chat-wiring.e2e.test.ts, tests/e2e/round-flow.e2e.test.ts — **Commit:** e28b3ea

**3. [Rule 3 - Blocking] Widened the build-flow fake publisher to the new GalleryPublisher interface**
- **Found during:** Task 2 (tsc)
- **Issue:** Adding revertLast to the interface broke the existing e2e fake object literal
- **Fix:** Added an inert revertLast to the fake
- **Files modified:** tests/e2e/build-flow.e2e.test.ts — **Commit:** cec5c8f

**4. [Rule 1 - Self-inflicted] Grep-gate false positive from my own doc comment**
- **Found during:** Task 3 verification
- **Issue:** `/** ... No !fork ... */` block comment isn't filtered by the gate's `//`-only filter
- **Fix:** Reworded to "No fork command exists"
- **Files modified:** src/ingestion/command-parser.ts — **Commit:** e28b3ea

No plan-scope deviations: all 7 safety invariants and both LOCKED USER DECISIONS held (rotation provably gated on published|no-changes; per-generation repo routing regression-guarded).

## Known Stubs

None — no placeholder values, no unwired data paths introduced.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary schema changes beyond the plan's threat model. All six mitigations (T-q5n-01..06) are test-enforced; T-q5n-SC held (zero new dependencies).

## TDD Gate Compliance

All three tasks followed RED→GREEN with per-task commits:
- Task 1: bbcd923 (test) → 6cccbd3 (feat)
- Task 2: 8a5a86b (test) → cec5c8f (feat)
- Task 3: c5fada5 (test) → e28b3ea (feat)

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1 — parser/dispatch/narration | bbcd923 | 6cccbd3 |
| 2 — revertLast + audit vocab | 8a5a86b | cec5c8f |
| 3 — kind router + e2e | c5fada5 | e28b3ea |

## Self-Check: PASSED

All key files present; all 6 task commits found in git log; full suite 980/980, tsc + biome + invariants + no-fork grep gate all clean. SUMMARY.md left uncommitted per orchestrator constraint (docs commit is the orchestrator's).
