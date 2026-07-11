---
phase: quick-260711-0iu
verified: 2026-07-11T08:30:00Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
re_verification: false
deferred:
  - truth: "Real WSL2 cwd handoff on the streaming PC (first build lands in /home/builder/projects/app-1; second continues it; New project rotates to app-2)"
    addressed_in: "Phase 5 dry run"
    evidence: "PLAN workspace_design live-verification note + SUMMARY follow-ups both schedule this for the Phase 5 dry run — fakes cannot prove the real wsl --cd behavior"
  - truth: "Classifier holds tweak-style prompts correctly in the straight-to-build context"
    addressed_in: "Follow-up quick task (gate:eval re-run) before/at Phase 5 dry run"
    evidence: "PLAN out_of_scope (amendment E) + SUMMARY follow-ups; 260711-0ms retune already merged, live re-eval scheduled"
---

# Quick Task 260711-0iu Verification Report

**Goal:** Vote winner goes STRAIGHT to the sandboxed build turn; pre-build compliance re-screens the winning suggestion fail-closed; suggestions are raw prompts against a PERSISTENT workspace; streamer "New project" console action; single-Build-step overlay; SAND-04 holds in both prompt modes; safety surfaces zero-diff.
**Verified:** 2026-07-11 (against merged working tree, HEAD 4344b0c, base 6c5885c)
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Winner goes straight to COMP-02 re-screen then the sandboxed build turn — no research/plan/host turns | ✓ VERIFIED | `runPipeline` (build-session.ts:782-849): dequeue → `screenBuildPlan(…, planText: task.text)` at :804 → `runBuildAttempt` at :849. Grep of src/ finds zero research/plan turn construction (`buildResearchPrompt`/`buildPlanPrompt`/`RESEARCH_SYSTEM_PROMPT`/`agent === "research"` — no matches in src or tests). `AgentRunSpec.agent` narrowed to `"build"` with no `model` field (types.ts:41-61). "researching"/"planning" appear ONLY in tolerated legacy render surfaces (progress-events.ts translate map, console.js/overlay.js render maps, shared PipelineStage union, untouched legacy tests) — never emitted: `emitStage` calls are `"building"` (:689) and terminal stages only. e2e build-flow.e2e.test.ts:204-205 asserts FIRST stage seen is "building"; ran green |
| 2 | Rejected → refused, held → held path; AgentRunner NEVER invoked in either case | ✓ VERIFIED | build-session.ts:812-838: rejected → `comp02Rejected` + `finalize(refused)`; held → `buildHeld` + `onHeldForReview(task, task.text)` + `finalize(refused)`; `runBuildAttempt` only reachable after `screen.proceed` AND post-screen `abortedNow` guard (:843). Tests build-session.test.ts:384 (rejected, `calls.toHaveLength(0)` at :411) and :418 (held, `calls.toHaveLength(0)` at :451, `onHeldForReview` called with `(task, "borderline idea")`) — re-ran: 34/34 green |
| 3 | SAND-04: suggestion text delimited chat DATA in user turn only; fixed system prompts in BOTH modes | ✓ VERIFIED | prompt-boundary.ts: `BUILD_SYSTEM_PROMPT_SCAFFOLD` (:50) and `BUILD_SYSTEM_PROMPT_CONTINUE` (:62) are zero-interpolation constants; `buildBuildPrompt(taskText, mode)` (:147-150) frames with `<task_description source="chat">`. Invariant suite runs FULL ADVERSARIAL_FIXTURES against both modes with system-prompt byte-invariance (test :74) and outsideFrame containment (:86-90) — 32/32 green in isolation |
| 4 | Persistent workspace `/home/builder/projects/app-<N>`, generation rotation, survives restarts | ✓ VERIFIED (code) / deferred (live WSL2) | workspace.ts: single-row SQLite `workspace_state` (schema.sql:158, `INSERT OR IGNORE` boot at :33-36 never resets an existing row), `dir()` from internal integer only (:47), `markBuilt`/`newProject` semantics; scaffolded flips ONLY on `done` finalize (build-session.ts:427-433). Wiring chain traced: `deps.workspace.dir()` → `AgentRunSpec.workspaceDir` (build-session.ts:701) → `options.cwd = spec.workspaceDir` (sdk-runner.ts:69, sandboxed branch only) → SDK `Options.cwd` (declared sdk.d.ts:1347-ish "Current working directory for the session") → sdk.mjs transport constructs `{command, args, cwd, …}` for `spawnClaudeCodeProcess` (independently confirmed: `{command:ia,args:sa,cwd:o` present in sdk.mjs) → sandbox-process.ts:184 `const cd = opts.cwd?.startsWith("/") ? opts.cwd : "~"` → `wsl --cd` (:192-193, UNTOUCHED). workspace.test.ts 6/6 green incl. close/reopen durability + resume-without-reset. Real distro behavior deferred to Phase 5 dry run (see frontmatter) |
| 5 | Streamer "New project": CSRF, 409 while building, audited | ✓ VERIFIED | server.ts:789-812 — registered AFTER the shared DNS-rebinding (:277) + Origin/Host CSRF (:309) middleware, so it inherits both; strict-empty `RoundStartBodySchema` → 400; `BUILD_IN_PROGRESS` → 409 build-active; `HALTED` → 409 halted; 503 unwired; success → `newProject()` + `recordWorkspaceReset` (record.ts:573, eventType `workspace_reset`, source operator) + `pushState()`. Console button textContent-only with `window.confirm` (console.js:451-460). server.test.ts 28/28 green (incl. 403 forged-Origin with newProject never called, 409 no-rotation) |
| 6 | Overlay stepper is a single Build step; legacy stages render without crashing | ✓ VERIFIED | overlay.js:71 `BUILD_STEPS = [{ key: "build", label: "Build" }]` (exactly one entry); :72 `STAGE_STEP_INDEX = { researching: 0, planning: 0, building: 0 }`; STAGE_CAPTION keeps legacy entries (:73-74); `effectiveStepIndex` uses `BUILD_STEPS.length` for done (:352), undefined stages fall back to 0 (:357) |
| 7 | Guidance copy invites tweaks; abort/veto still routes through finalizeAborted with no stage "done" | ✓ VERIFIED | overlay.js:285 "type !suggest — new idea or a tweak to what's on screen"; narration.ts:240 `Building "X" now — straight to the code.`, :393/:399 tweak-inviting suggest-window beats; abort paths: post-screen `abortedNow → finalizeAborted` (build-session.ts:843), mid-build (:716-717); halt.ts zero-diff |

**Score:** 7/7 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|--------------|----------|
| 1 | Real WSL2 cwd handoff (app-1 persists across builds; New project rotates to app-2 on the streaming PC) | Phase 5 dry run | PLAN workspace_design "Live-verification note" + SUMMARY follow-ups — fakes cannot prove wsl --cd |
| 2 | Classifier gate:eval re-run against live tweak-style prompts | Follow-up quick task before/at Phase 5 dry run | PLAN amendment E out-of-scope + SUMMARY follow-ups (260711-0ms retune already merged) |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/orchestrator/build-session.ts` | runPipeline no research/plan; `planText: task.text`; mode from workspace seam | ✓ VERIFIED | :804 screens task.text with call-site comment; :694 mode fresh per attempt; :433 markBuilt on done only |
| `src/orchestrator/prompt-boundary.ts` | Two fixed prompts + `buildBuildPrompt(taskText, mode)` with chat-source frame | ✓ VERIFIED | :50/:62/:147-150; CLASSIFIER_SYSTEM_PROMPT byte-identical base vs HEAD (extracted const 4243 chars both, `identical: true`) |
| `src/orchestrator/workspace.ts` | SQLite WorkspaceView: dir/scaffolded/markBuilt/newProject | ✓ VERIFIED | Full implementation, rotation-not-deletion docblock, no destructive commands, no wsl.exe exec |
| `src/operator-console/server.ts` | POST /api/workspace/new-project mirroring chaos-toggle pattern | ✓ VERIFIED | :789-812, exact pattern match |
| `src/overlay/public/overlay.js` | Single-step BUILD_STEPS, legacy keys → 0, tweak copy | ✓ VERIFIED | :71-72, :285 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| build-session.ts | comp02.ts | `screenBuildPlan(deps.comp02, { taskId, planText: task.text })` | ✓ WIRED | :804; comp02.ts + src/compliance/ zero-diff |
| build-session.ts | prompt-boundary.ts | `buildBuildPrompt(taskText, mode)` | ✓ WIRED | :695, output feeds systemPrompt/userPrompt of the single build spec (:698-700) |
| sdk-runner.ts | sandbox-process.ts | `options.cwd = spec.workspaceDir` → SDK SpawnOptions.cwd → `--cd` | ✓ WIRED | sdk-runner.ts:69 (sandboxed branch); SDK internals independently confirmed (`cwd:o` in spawn options object in sdk.mjs); sandbox-process.ts:184 untouched |
| operator-console/server.ts | workspace.ts | `newProject()` behind CSRF + 409 guards | ✓ WIRED | :808 after :800/:804 guards; main.ts:273 constructs ONE WorkspaceView passed to both console deps (:976) and build session deps (:1011) |

### Behavioral Spot-Checks / Probe Execution

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Invariant suites in isolation | `npx vitest run tests/invariants/{prompt-injection-boundary,single-funnel,dom-safety,secrets-isolation}.test.ts` | 47 passed / 4 files (32 + 7 + 4 + 4) | ✓ PASS |
| Cited safety/unit suites | `npx vitest run build-session.test.ts workspace.test.ts prompt-boundary.test.ts server.test.ts` | 79 passed / 4 files (34 + 6 + 11 + 28) | ✓ PASS |
| Full gate: vitest | `npx vitest run` | **784 passed / 64 files** (matches SUMMARY claim) | ✓ PASS |
| Full gate: tsc | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Full gate: biome | `npx biome check .` | 142 files checked, no diagnostics | ✓ PASS |

### Safety Zero-Diff Checks

| Path | Check | Result |
|------|-------|--------|
| src/orchestrator/sandbox-process.ts + .test.ts | `git diff 6c5885c..HEAD --stat` | empty — ✓ zero-diff |
| src/compliance/ | `git diff 6c5885c..HEAD --stat` | empty — ✓ zero-diff |
| src/kill-switch/halt.ts | `git diff 6c5885c..HEAD --stat` | empty — ✓ zero-diff |
| CLASSIFIER_SYSTEM_PROMPT | Extracted template literal compared base vs HEAD | 4243 chars both, byte-identical |

### Anti-Patterns Found

None. No TBD/FIXME/XXX in modified files; no stub returns; e2e fake runners correctly narrowed (zero `agent === "research"` anywhere in src/ or tests/).

### Human Verification Required

None for this task — the two items fakes cannot prove are plan-mandated deferrals to the Phase 5 dry run (see Deferred Items), already recorded in the SUMMARY follow-ups.

### Gaps Summary

No gaps. All seven must-have truths hold in the merged working tree with executable evidence: the pipeline is dequeue → fail-closed suggestion re-screen → single sandboxed Fable build turn in a persistent, generation-rotated workspace; the console rotation route is CSRF-inherited, 409-guarded, and audited; SAND-04 delimiter containment passes the full adversarial sweep in both prompt modes; and every safety surface the plan froze (sandbox-process, compliance, halt, classifier prompt) is byte-untouched since base 6c5885c.

---

_Verified: 2026-07-11T08:30:00Z_
_Verifier: Claude (gsd-verifier)_
