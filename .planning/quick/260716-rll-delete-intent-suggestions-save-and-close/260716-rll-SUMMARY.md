---
phase: quick-260716-rll
plan: 01
subsystem: orchestrator / composition-root / audit / narration
tags: [build-dispatch, destructive-intent, save-and-close, audit, workspace-rotation]
requires: [quick-0iu persistent workspace newProject rotation, quick-t8k reRootPreview seam, quick-260716-ko2 PULL-based playUrl, quick-q5n kind router + runChaosWinner remove-first idiom, D2-18 amber-tier copy rules]
provides:
  - "isDestructiveIntent(text): deterministic, total, never-throws wipe-intent matcher (bounded connector-gap verb->target + it-all phrase forms, possessive lookahead)"
  - "dispatchBuild(task, provenance): the ONE build-dispatch convergence point — buildSession.startBuild now has exactly ONE call site (structural gate A)"
  - "saveAndCloseProject: remove -> rotate (existing new-project flow, unscaffolded skip) -> project_closed audit -> projectClosed beat -> guarded IDLE"
  - "Narrator.projectClosed(): fixed amber-tier save-and-close beat, zero interpolation"
  - "recordProjectClosed (event_type project_closed, decision saved-and-closed) — generation integers only, never chat text"
  - "e2e matrix: vote/solo, free-reign window, chaos, control, unscaffolded + structural gates A/B"
affects: [src/main.ts, src/orchestrator/destructive-intent.ts, src/ingestion/narration.ts, src/audit/record.ts, src/audit/schema.sql, tests/e2e/save-and-close.e2e.test.ts]
tech-stack:
  added: []
  patterns: [one-funnel dispatch wrapper before startBuild, remove-first interception (runChaosWinner idiom), guarded BUILD_IN_PROGRESS->IDLE ending that reuses all three completion continuations unchanged, comment-filtered structural grep gates in e2e]
key-files:
  created:
    - src/orchestrator/destructive-intent.ts
    - src/orchestrator/destructive-intent.test.ts
    - tests/e2e/save-and-close.e2e.test.ts
  modified:
    - src/main.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/audit/record.ts
    - src/audit/record.test.ts
    - src/audit/schema.sql
    - src/ingestion/twitch-chat.test.ts (Rule-3 fake-narrator fallout)
    - tests/e2e/recovery.e2e.test.ts (Rule-3 fake-narrator fallout)
decisions:
  - "Detection is deterministic regex over the APPROVED text (locked D-1): the Sonnet gate surface (src/compliance/**, GATE_MODEL, prompts) is byte-untouched — verified by git diff against the base commit"
  - "Matcher policy is asymmetric by design: false negatives fall through to a normal build (today's behavior); false positives save-and-close (non-destructive, recoverable). Both documented in the module doc comment"
  - "saveAndCloseProject ends with a GUARDED transition to IDLE only from BUILD_IN_PROGRESS — that single choice makes drainVoteQueue's drain-next, driveWindowBuild's window-return, and driveChaosBuild's chaos-repick continuations work with ZERO edits (proven per-path in the e2e)"
  - "Unscaffolded canvas skips the rotation (closedGeneration === freshGeneration) but STILL audits + narrates — the double-rotation guard also covers a wipe-intent !build arriving after shipThenRotate already rotated (site-2 comment)"
  - "record.ts wording constraint honored: the helper/doc/rationale say 'wipe'/'wipe-intent'/'closed', never the d-word — the append-only /UPDATE|DELETE/i source scan stays green"
  - "e2e beat assertions poll (until-based) because the projectClosed beat rides the SAME rate-budgeted ChatSender as every other transition — a synchronous toContain raced the rate budget on the chaos path"
metrics:
  duration: ~17 minutes
  completed: 2026-07-17
  tests: 1369 passing (baseline 1326 + 43 new)
  commits: 4
---

# Quick Task 260716-rll: Delete-Intent Suggestions Save-and-Close — Summary

**One-liner:** A gate-approved winner asking to delete/wipe/reset the whole app now NEVER reaches the build agent on any dispatch path (vote/solo, paid free-reign window, chaos) — the new `dispatchBuild` funnel (the now-sole `buildSession.startBuild` call site) intercepts it and saves-and-closes instead: workspace rotates via the existing non-destructive new-project flow, a calm "saved to the gallery and closed" beat lands in chat, a `project_closed` audit row is written, and the show loop continues on the default overlay state (playUrl null, PLAY IT hidden).

## What Was Built

### Task 1 — matcher + beat + audit helper (`6500751` RED, `50db024` GREEN)

- **`src/orchestrator/destructive-intent.ts`** — `isDestructiveIntent(text): boolean`. Verbs `delete|wipe|erase|remove|destroy|nuke|reset|clear` reach targets `app|application|repo|repository|project|codebase|workspace|everything` only across a bounded connector gap (`the|this|that|it|its|my|our|your|whole|entire|current|all|of`); an arbitrary noun breaks the bridge ("add a reset button to the app" never matches); a possessive negative lookahead `(?!['’]s)` kills "remove the app's dark mode" (both apostrophe forms); explicit phrase forms cover "clear it all" / "wipe all of it". Total/never-throws (non-string guard + try/catch → false), case-insensitive, fixed linear patterns only (T-rll-01). Full mandated 11-positive / 9-negative table pinned in `destructive-intent.test.ts`, including the verbatim live-incident text and `REVERT_REQUEST_TEXT`.
- **`Narrator.projectClosed()`** — exact-string pinned beat: `"Project saved to the gallery and closed — fresh canvas! Keep the ideas coming."` Amber-tier + copy-separation clean (alarm/chance/money scans in narration.test.ts); added to the structural no-tally method-list test.
- **`recordProjectClosed`** — one `project_closed` row (source `operator`, decision `saved-and-closed`, suggestionText null); rationale interpolates the closed→fresh generation integers only. The word constraint held: record.ts's `/UPDATE|DELETE/i` append-only scan stays green ("wipe-intent" wording throughout).
- **`schema.sql`** — comment-only `project_closed` enumeration (revert_outcome precedent).

### Task 2 — the one dispatch funnel + e2e matrix (`bc69113` RED, `a42ade7` GREEN)

- **`src/main.ts`**: `saveAndCloseProject` (remove head FIRST → rotate iff `workspace.scaffolded()` via `workspace.newProject()` + `reRootPreview()` → `recordProjectClosed` → `windowNarrator?.projectClosed()` → guarded `BUILD_IN_PROGRESS→IDLE`) and `dispatchBuild` (`isDestructiveIntent` check, else `buildSession.startBuild`). All FIVE former call sites (shipThenRotate paths i + iii, drainVoteQueue default arm, driveWindowBuild, driveChaosBuild) now `await dispatchBuild(...)` with their exact provenance arguments; drainVoteQueue guards, ship-gating, all three completion continuations, HALTED paths, and the console new-project route are untouched.
- **`tests/e2e/save-and-close.e2e.test.ts`** (15 tests):
  - Test 1 (the incident shape): the delete-intent suggestion as the ONLY pool entry is solo-picked at a 0.3s phase end → agent never invoked, queue clean, generation 1→2 (fresh unscaffolded), `project_closed` row linked to the solo-picked task id, exact beat in chat, machine IDLE, and the overlay `playUrl` flipped non-null → null (PLAY IT hidden, quick-ko2).
  - Test 2: the next normal suggestion builds on the fresh canvas (`app-2` workspaceDir) — drain continuation alive.
  - Test 3: in-window `!build <incident text>` intercepted → no agent run, rotation, machine returns to FREE_REIGN_WINDOW while the window is live, and a follow-up normal window instruction builds.
  - Test 4: console chaos-toggle pick (chaosRng 0) intercepted → chaos_pick row exists (true-origin), no build, rotation, machine returns to CHAOS_MODE (re-pick continuation intact).
  - Test 5 (control): the non-destructive seeder built exactly as before.
  - Test 6: unscaffolded canvas → NO rotation (generation unchanged), audit (closed === fresh) + beat still fire — never silent.
  - Gate A: comment-filtered count of `buildSession.startBuild(` in src/main.ts === 1, and `await dispatchBuild(` === 5.
  - Gate B: zero repo-removal patterns (`gh repo delete`, `-X DELETE`, `method: "DELETE"`) anywhere under src/ (comment-stripped via the shared scan-helpers).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two full-interface Narrator fakes needed the new member**
- **Found during:** Task 1 (tsc after adding `projectClosed` to the interface)
- **Issue:** `src/ingestion/twitch-chat.test.ts` and `tests/e2e/recovery.e2e.test.ts` build complete `Narrator` fakes — the interface widening broke their type-checks
- **Fix:** mechanical one-line member additions (`projectClosed: vi.fn()` / `projectClosed() {}`), the exact same fallout h73 handled for its five beats
- **Files modified:** src/ingestion/twitch-chat.test.ts, tests/e2e/recovery.e2e.test.ts
- **Commit:** `50db024`

**2. [Rule 1 - Bug in new test] Beat assertions raced the chat sender's rate budget**
- **Found during:** Task 2 (chaos-path e2e failed on `toContain(PROJECT_CLOSED_BEAT)`)
- **Issue:** the projectClosed beat rides the SAME rate-limited ChatSender as every transition beat; a synchronous membership assert right after the audit row lands can run before the send drains
- **Fix:** all four beat assertions poll via the harness `until()` (the sibling e2e idiom)
- **Files modified:** tests/e2e/save-and-close.e2e.test.ts
- **Commit:** `a42ade7`

No production-code deviations: plan executed as written.

## Verification

- Full suite: **1369 passing** (baseline at base commit 1326 + 43 new: 25 matcher + 3 narration + 1 audit + 15 e2e — 1 pre-existing narration test also grew via the method list), 0 failures, no baseline tests removed/changed (additive edits only to narration.test.ts's method list, per the h73 precedent).
- `npx tsc --noEmit` clean; `npx biome check` clean on every touched file (the two pre-existing `overlay.css` complaints are in an untouched file — out of scope).
- Invariant suites green untouched: single-funnel, paid-chaos-separation, prompt-injection-boundary, secrets-isolation, dom-safety, chat-sender (70/70 across tests/invariants + the new e2e in the same run).
- Gate classifier surface untouched: `git diff base..HEAD` over src/compliance/, src/overlay/server.ts, src/overlay/public/, halt.ts, paid-window.ts is EMPTY.
- 4 atomic commits, TDD order: `6500751` (RED), `50db024` (GREEN), `bc69113` (RED), `a42ade7` (GREEN).

## Threat Register Outcomes (from PLAN threat_model)

- T-rll-01 (regex DoS) — mitigated: fixed alternations, bounded connector gap, non-string/try-catch total guard; 200KB-input test.
- T-rll-02 (rotation tampering) — mitigated: EXISTING newProject flow only; gate B proves zero repo-removal calls in src/.
- T-rll-03 (silent interception) — mitigated: project_closed row on EVERY interception including the unscaffolded no-rotation case (e2e Test 6).
- T-rll-04 (info disclosure) — mitigated: rationale = generation integers; beat = fixed string; e2e asserts the incident text never appears in the audit rationale.
- T-rll-05 (second queue path) — mitigated: interception only removes; single-funnel invariant green.

## Known Stubs

None.

## Self-Check: PASSED

- src/orchestrator/destructive-intent.ts — FOUND
- src/orchestrator/destructive-intent.test.ts — FOUND
- tests/e2e/save-and-close.e2e.test.ts — FOUND
- Commits 6500751, 50db024, bc69113, a42ade7 — FOUND on worktree-agent-ab4b3977998a8b31d
