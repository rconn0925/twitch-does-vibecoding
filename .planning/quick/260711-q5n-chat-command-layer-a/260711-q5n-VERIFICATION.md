---
phase: quick-260711-q5n-chat-command-layer-a
verified: 2026-07-11T19:36:00Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Pre-stream live-fire dry run: with the real gallery publisher configured, (1) vote a !build project-switch to victory and confirm the current app's final snapshot lands on GitHub BEFORE the workspace rotates, then the new project's first publish creates a NEW repo; (2) vote !revert to victory on a repo with >=2 commits and confirm the revert commit appears on GitHub and the workspace files roll back"
    expected: "Ship-then-rotate and mirror git-revert + copy-first write-back behave against real git/gh/UNC exactly as the injected fakes assert; no PAT on any argv"
    why_human: "revertLast's git subcommands (revert --no-edit / rev-list --count / revert --abort), the gh credential helper, and the UNC write-back are exercised only through injected exec/fsx fakes in the suite — real external-service behavior (GitHub push, Windows UNC fs semantics) cannot be proven by grep or unit tests"
out_of_scope_findings:
  - finding: "Full suite on merged master is 978/980 — src/control-window/duration.test.ts has 2 failures (expects maxSeconds 300, code returns 600)"
    cause: "Master fast-lane commit 42d7c67 (raise donation free-reign cap to 600s) changed src/control-window/duration.ts WITHOUT updating duration.test.ts; broken on master BEFORE the q5n merge (q5n worktree branched at d62c272, where the suite was 980/980)"
    recommendation: "Update duration.test.ts expectations (300 -> 600) in a follow-up fast task"
  - finding: "npx biome check src tests fails on src/overlay/public/*.css (noImportantStyles, noDescendingSpecificity, CRLF format drift in queue.css)"
    cause: "Fast-lane overlay commits f19fe8d / eded6a2 / cbaf8dc — not q5n files; all q5n-scope dirs (src/ingestion, src/pipeline, src/shared, src/orchestrator, src/audit, src/main.ts, tests/e2e, tests/invariants) are biome-clean (75 files, 0 diagnostics)"
    recommendation: "biome-ignore or fix the overlay CSS in a follow-up fast task"
---

# Quick Task 260711-q5n: Chat Command Layer A — Verification Report

**Goal:** Tier-1 voted commands core: kind-tagged `!build` (new-project) and `!revert`/`!undo` entering the SAME pool/round mixed vote through the single gate funnel; winner router (suggest→continue, build→ship-then-rotate-then-scaffold with rotation ONLY on confirmed publish success, revert→mirror git-revert + copy-first write-back + republish); FREE REIGN `!build` interceptor byte-compatible inside windows; kind-aware narration; audit rows; NO `!fork`.
**Verified:** 2026-07-11 (master @ dd82dcd; q5n merge 5858a2b)
**Status:** human_needed (all automated checks pass; one live-fire external-service item)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `!build <idea>` outside a window enters the SAME pool as `!suggest` (intake→classify→pool), kind `project-switch` | VERIFIED | `src/ingestion/twitch-chat.ts:117-149` — one shared path, `intake.check` (L129) strictly before `deps.submit` (L143); e2e `tier1-commands.e2e.test.ts:644-661` asserts pool entry kind `project-switch` AND classify-before-pool sequence |
| 2 | `!build` INSIDE an active window byte-identical to pre-q5n | VERIFIED | `src/main.ts:939-956` — same `BUILD_COMMAND` regex, same `routeWindowInstruction`, consume-and-return when `controlWindow.snapshot() !== null`; only change is fall-through to `handler(event)` when no window; e2e L633-641: in-window `!build` grows queue, pool stays 0 |
| 3 | `!revert`/`!undo` pools ONE fixed server-composed candidate through the same funnel, kind `revert` | VERIFIED | `command-parser.ts:97-100` strict no-arg `/^!(revert\|undo)$/i` (trailing text → null); `REVERT_REQUEST_TEXT` constant L48; `twitch-chat.ts:120` substitutes it — zero chat-derived bytes; funnel decision documented in module doc L20-27 |
| 4 | Mixed round shows NEW/TWEAK/REVERT wording, all kinds in ONE vote | VERIFIED | `narration.ts:211-222` kind-aware roundOpened (`NEW:` / `TWEAK:` / fixed `REVERT the last change` label, never candidate text); e2e L249-255 asserts all three labels in one round-open line |
| 5 | LOCKED DECISION 1: project-switch winner AWAITS publish; rotates ONLY on `published\|no-changes` | VERIFIED | `src/main.ts:1183` awaited `publishNow`; L1203 `if (shipped && (published \|\| no-changes))` gates `workspace.newProject()` (L1204); e2e L347-365: publishNow gen-1 strictly before startBuild in gen-2; L463-469: `no-changes` rotates |
| 6 | Failed ship (or no publisher) NEVER rotates: amber narration, audited, task removed, IDLE, next round | VERIFIED | `src/main.ts:1215-1242` — no `newProject`, no `startBuild`, `taskQueue.remove`, `newProjectShipFailed()`, no-publisher path writes its own failed `gallery_publish` row (L1222-1231), guarded IDLE; e2e L440-457 (failed: generation stays 1, amber no-alarm-words assertion) + L514-522 (no-publisher: no rotate + own audit row) |
| 7 | Revert winner rolls back last mirror commit, syncs workspace, republishes, writes `build_history` result `reverted` | VERIFIED | `gallery-publisher.ts:475-606` doRevert: lookup→continueRepo→rev-list guard→revert --no-edit with -c identity→COPY-FIRST write-back (cp L541 before prune L554-565)→push (env-token, plain https)→rev-parse; `main.ts:1264-1273` build_history `reverted` only on success; e2e L263-264 revertLast receives current generation + winner taskId |
| 8 | Revert edge cases (no repo / 1 commit / no publisher / exec failure) narrate gracefully, never a dead round | VERIFIED | doRevert: null lookup → nothing-to-revert zero git ops (L480-486), count<2 → nothing-to-revert (L494-500), revert failure → best-effort abort + workspace untouched (L517-531), never rejects (L600-605); `main.ts:1253-1293` runRevertWinner removes task FIRST, narrates per status, guarded IDLE for ALL outcomes; e2e sections 4-5 cover nothing-to-revert + no-publisher |
| 9 | `!suggest` winner with no active project scaffolds (proven, not changed) | VERIFIED | e2e L342-344: first build of a fresh app runs scaffold mode (`systemPrompt` contains "scaffold the project from scratch"); router default arm `main.ts:1343-1347` unchanged `startBuild(head, "vote")` |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/ingestion/command-parser.ts` | !build/!revert/!undo variants + `REVERT_REQUEST_TEXT` | VERIFIED | 105 lines, total parser (safeParse, null on unrecognized); 2000-char cap mirrors suggest; contains "revert" |
| `src/orchestrator/gallery-publisher.ts` | `revertLast()` — mirror git revert + write-back + republish | VERIFIED | `revertLast` on the returned interface (L617-627), serialized on the SAME `chain` as publishNow; exports `GalleryPublisher` with `revertLast(input: RevertInput)` in the interface (L83) |
| `src/audit/record.ts` | `recordRevertOutcome` + initiator-aware `recordWorkspaceReset` | VERIFIED | `recordRevertOutcome` (L600, event_type `revert_outcome`, server-composed detail); `recordWorkspaceReset` optional `initiator?: "operator" \| "chat-vote"` (L573), chat-vote rationale L576 |
| `src/main.ts` | kind router in drainVoteQueue + interceptor fall-through | VERIFIED | `shipThenRotate` (L1166), `runRevertWinner` (L1253), kind switch in the IIFE (L1336-1348), drain continuation for all three arms (L1353); interceptor fall-through L950-955 |
| `src/shared/types.ts` / `src/pipeline/submit.ts` | kind + result vocabulary widened | VERIFIED | `CandidateKind` includes `"revert"` (types.ts:44), `BuildResult` includes `"reverted"` (types.ts:237), `CandidateSchema` kind enum widened (submit.ts:36) |
| `src/audit/schema.sql` | comment-only vocabulary updates | VERIFIED | `revert_outcome` comment L13, build_history `'reverted'` comments L137/L147 — no CHECK constraint, no migration |
| `src/ingestion/narration.ts` | kind-aware roundOpened + pooled-build/pooled-revert + 5 new beats | VERIFIED | FeedbackKind `pooled-build`/`pooled-revert` (L34-35); `revertApplied/Nothing/Failed`, `newProjectShipping/ShipFailed` on the Narrator interface (L117-125) with implementations (L452-476); amber wording test-asserted (e2e L457) |
| `tests/e2e/tier1-commands.e2e.test.ts` | e2e routing coverage | VERIFIED | 741 lines, 7 describe sections: mixed round, ship-success ordering, ship-failure, no-changes, revert edges, free-reign byte-compat + gate-before-pool, chaos suggestion-only filter |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `twitch-chat.ts` | `pipeline/submit.ts` | `intake.check` BEFORE `deps.submit` for build/revert (D2-11) | WIRED | Single shared path L117-149; sequence-proven in twitch-chat.test.ts and e2e gate-before-pool |
| `main.ts drainVoteQueue` | `workspace.newProject()` | AWAITED publishNow; newProject ONLY on `published\|no-changes` | WIRED | L1183 await → L1203 status gate → L1204 rotate; failure branch has ZERO newProject calls (e2e-asserted, generation stays 1) |
| `main.ts drainVoteQueue` | `galleryPublisher.revertLast` | revert winner, host-side, never an agent build | WIRED | L1257; no `startBuild` anywhere in `runRevertWinner`; task removed first (L1254) |
| `main.ts buildAwareChatSource` | `startTwitchChat` handler | outside-window !build falls through to the parser | WIRED | L943-955: window-null → `handler(event)`; window-live → `routeWindowInstruction` + return (byte-compat) |

### Behavioral Spot-Checks (executed)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite | `npx vitest run` (master) | 978 pass / 2 fail (69 files) — both failures in `src/control-window/duration.test.ts`, broken by master commit 42d7c67 BEFORE the q5n merge (q5n worktree branched at d62c272; executor's 980/980 claim was true at its tip e28b3ea, where duration.ts still held 300) | PASS for q5n scope / out-of-scope master regression flagged |
| All q5n-owned test files + invariants | `npx vitest run tests/invariants tests/e2e/tier1-commands... (7 targets)` | 222 pass / 0 fail (12 files) | PASS |
| Invariant suite | `npx vitest run tests/invariants` | 55 pass / 0 fail (6 files) — matches executor's 55/55 claim | PASS |
| Type check | `npx tsc --noEmit` | exit 0, clean | PASS |
| Lint | `npx biome check src tests` | Fails ONLY on `src/overlay/public/*.css` (fast-lane commits f19fe8d/eded6a2/cbaf8dc, not q5n); scoped check of all q5n dirs: 75 files, 0 diagnostics | PASS for q5n scope / out-of-scope CSS flagged |
| No-!fork grep gate | `grep -v '^\s*//' src/ingestion/command-parser.ts \| grep -ci '!fork'` | 0 (the 4 matches in command-parser.test.ts are tests asserting `!fork` parses to null) | PASS |
| Commits exist | `git log` | All 6 task commits present (bbcd923/6cccbd3, 8a5a86b/cec5c8f, c5fada5/e28b3ea) in RED→GREEN pairs, merged at 5858a2b | PASS |

### Safety Invariants (7)

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Single funnel — no new classifier/pool entry path | HELD | submit.ts only widened its kind enum; twitch-chat routes all three commands through the ONE `deps.submit`; invariant suite 55/55 incl. single-funnel; no new `as QueuedTask` / `.enqueue(` call sites |
| 2 | Intake-before-classify (D2-11) | HELD | twitch-chat.ts:129 before :143 for all three kinds; sequence-recording fakes in tests |
| 3 | State machine untouched | HELD | drainVoteQueue's synchronous prologue (mode guards, transition to BUILD_IN_PROGRESS) unchanged (main.ts:1307-1329); router lives entirely inside the IIFE; guarded IDLE returns use finalize()'s idiom |
| 4 | Interceptor byte-compat inside windows | HELD | main.ts:943-953 — identical regex/route/consume inside a window; e2e in-window test asserts pool stays empty |
| 5 | Non-destructive rotation (ship strictly before rotate) | HELD | Awaited publishNow observes pre-rotation generation; e2e ordering assertion (publish gen-1 < startBuild gen-2) |
| 6 | Server-composed narration | HELD | All new beats fixed strings; only gate-approved `head.text` interpolated through `truncateTitle`; revert label never renders candidate text |
| 7 | Revert never leaves workspace unbuildable (copy-first) | HELD | doRevert: workspace untouched until mirror revert commit succeeds; `fsx.cp` (L541) strictly before any prune `fsx.rm` (L564); cp-failure branch test-asserts ZERO rm on workspace UNC paths |

### Locked User Decisions

| Decision | Status | Evidence |
|----------|--------|----------|
| 1. Rotation ONLY on confirmed publish success (`published\|no-changes`); failed ship or absent publisher NEVER rotates | HELD | main.ts:1203 status gate; e2e: failed → generation stays 1, newProject zero calls, task removed, amber line, audit row, next round opens; no-publisher → same, with its own failed audit row; `no-changes` → rotates |
| 2. New builds get new repositories (post-rotation publish carries the NEW generation) | HELD | e2e L382-383 regression guard: the rotated project's first done-build publish carries `generation: 2` (per-generation repo routing) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/orchestrator/gallery-publisher.ts` | ~offset 8594 | Raw control bytes (NUL, 0x1f, 0x7f) inside a regex character class — git/grep treat the file as binary (`Bin` in diffs) | Info | Intentional (biome-ignore'd control-char stripping) and pre-existing before q5n (file was already `Bin` on both sides of the merge). Valid TS; costs reviewable diffs. Consider `\x00` escape sequences in a future touch. |

No TBD/FIXME/XXX debt markers in any q5n-modified file. No stubs, no hardcoded empty data paths, no console.log-only implementations.

### Human Verification Required

#### 1. Live-fire ship-then-rotate + revert dry run (pre-stream)

**Test:** With the real gallery publisher configured against the actual GitHub gallery: (a) vote a `!build <idea>` project-switch to victory while an active project exists — confirm the final snapshot commit lands on the current repo BEFORE the workspace rotates, and the new project's first publish creates a NEW repo; (b) vote `!revert` to victory on a project with >=2 commits — confirm the revert commit appears on GitHub and the workspace files actually roll back on disk.
**Expected:** Real git/gh/UNC behavior matches the injected-fake assertions; no PAT visible in any process command line.
**Why human:** All git subcommands (`revert --no-edit`, `rev-list --count`, `revert --abort`), the gh credential helper, and the mirror→workspace UNC copy are exercised exclusively through injected exec/fsx fakes — real GitHub and Windows-UNC filesystem semantics cannot be proven programmatically here.

### Out-of-Scope Findings (not q5n gaps — pre-existing master issues)

1. **`src/control-window/duration.test.ts` — 2 failures on master** (expects `maxSeconds` 300, code returns 600). Broken by fast-lane commit 42d7c67 which raised the donation cap in `duration.ts` without updating its test; master was red from that commit onward, independent of and prior to the q5n merge. Recommend a follow-up fast task updating the expectations to 600.
2. **`npx biome check` fails on `src/overlay/public/*.css`** (`!important`, descending specificity, CRLF format drift) — introduced by fast-lane overlay commits f19fe8d/eded6a2/cbaf8dc, not q5n. All q5n-scope directories are biome-clean.

### Gaps Summary

None. All 9 must-have truths, 8 artifacts, 4 key links, 7 safety invariants, and both LOCKED USER DECISIONS verified against the live tree with substantive (non-vacuous) test assertions. The two full-repo check failures (duration tests, overlay CSS lint) are attributable to concurrent fast-lane commits outside this task's worktree and do not touch the phase goal. Status is `human_needed` solely for the one external-service live-fire item above.

---

_Verified: 2026-07-11T19:36:00Z_
_Verifier: Claude (gsd-verifier)_
