---
phase: 03-sandboxed-build-engine-live-show
plan: 03
subsystem: security
tags: [prompt-injection, orchestrator, invariant-scan, zero-interpolation, vitest, sand-04]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch
    provides: "classifier.ts fixed-SYSTEM_PROMPT zero-interpolation precedent; adversarial.fixtures.ts; single-funnel check (c) confinement-scan pattern"
  - phase: 02-chat-vote-loop
    provides: "tests/invariants/scan-helpers.ts (collectFiles/allMatches/stripComments shared scanner)"
  - phase: 03-sandboxed-build-engine-live-show
    provides: "03-02 orchestrator/types.ts seams (AgentRunSpec.systemPrompt/userPrompt; @anthropic-ai/claude-agent-sdk confined to src/orchestrator/)"
provides:
  - "src/orchestrator/prompt-boundary.ts: zero-interpolation delimited prompt constructor (buildResearchPrompt/buildBuildPrompt) — chat/plan text reaches agents ONLY as delimited user-turn data (SAND-04, D3-05)"
  - "RESEARCH_SYSTEM_PROMPT / BUILD_SYSTEM_PROMPT fixed orchestrator-authored consts"
  - "tests/invariants/prompt-injection-boundary.test.ts: adversarial-fixture suite proving system-prompt injection-invariance + delimited-only placement"
  - "agent-SDK-confinement invariant: @anthropic-ai/claude-agent-sdk imported ONLY under src/orchestrator/ (mirrors single-funnel check (c)), with non-empty-scan guard + synthetic-offender self-test"
  - "orchestrator prompt-source guard: no system prompt built by string interpolation, with its own synthetic-offender self-test"
affects: [03-04-comp02, 03-06-orchestrator, 03-05-sandbox-process]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Zero-interpolation prompt boundary (classifier.ts SYSTEM_PROMPT analog): fixed system const + untrusted text as delimited user-turn data only"
    - "Confinement source-scan extended to a second SDK: @anthropic-ai/claude-agent-sdk confined to src/orchestrator/ the way check (c) confines @anthropic-ai/sdk to src/compliance/"
    - "Pure offender-detection function reused on the real tree AND a synthetic planted file (fail-loud self-test) so a scan can never pass by matching nothing"

key-files:
  created:
    - src/orchestrator/prompt-boundary.ts
    - src/orchestrator/prompt-boundary.test.ts
    - tests/invariants/prompt-injection-boundary.test.ts
  modified: []

key-decisions:
  - "Prompt boundary exposes buildResearchPrompt(task)/buildBuildPrompt(planText) returning { systemPrompt, userPrompt } — the delimiter frame is the ONLY templating; untrusted text inserted verbatim (no meaning-changing escaping), never crossing the system/user boundary"
  - "Confinement scan matches the package import string /[\"']@anthropic-ai\\/claude-agent-sdk[\"']/ (the query()/spawnClaudeCodeProcess surface is reachable only through it), mirroring check (c)'s string-scan exactly rather than chasing a bare `query(` token that would false-positive"
  - "Prompt-source guard regex system(Prompt)?:`...${ spans newlines via [^`]* so a multi-line interpolated template literal is still caught; proven live by a planted synthetic offender"

patterns-established:
  - "Every query() prompt is constructed via prompt-boundary.ts — system prompts are fixed consts assigned by bare reference, never string-concatenated from any candidate/plan field"
  - "New confinement invariants reuse scan-helpers (no re-rolled comment stripper) and ship a non-empty-scan guard + synthetic-offender self-test as a fixed pair"

requirements-completed: [SAND-04]

# Metrics
duration: ~20min
completed: 2026-07-10
---

# Phase 3 Plan 03: Prompt-Injection Boundary & SDK-Confinement Invariant Summary

**Chat-derived text now reaches build/research agents ONLY as delimited user-turn data behind a fixed orchestrator-authored system prompt (SAND-04/D3-05), proven against Phase 1's adversarial fixtures — and the agent SDK's `query()` tool-use authority is machine-confined to `src/orchestrator/` by a verified source scan, not convention.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-10
- **Tasks:** 2 of 2
- **Files created:** 3

## Accomplishments
- Built `src/orchestrator/prompt-boundary.ts`: a pure string module mirroring `classifier.ts`'s zero-interpolation discipline. `buildResearchPrompt`/`buildBuildPrompt` return a FIXED `{systemPrompt}` const and a `{userPrompt}` where untrusted text lives ONLY inside `<task_description source="chat">…</task_description>` / `<build_plan source="orchestrator">…</build_plan>` delimiters. An "ignore your instructions" suggestion structurally cannot move into instruction position.
- Adversarial-fixture invariant suite iterates all 13 reused Phase 1 fixtures (with a `count > 0` fail-loud guard), asserting for each that the system prompt is byte-invariant and the fixture text is contained within the delimiter frame and nowhere else — for both the research and build turns.
- New agent-SDK-confinement invariant (defense-in-depth mirror of single-funnel check (c)): `@anthropic-ai/claude-agent-sdk` is imported ONLY under `src/orchestrator/`, closing the checker-noted "previously convention-only" gap. Backed by a non-empty-scan guard (`files.length > 10` + a known orchestrator file present) and a synthetic `src/ingestion/rogue.ts` self-test proving the scan catches a planted violation.
- Orchestrator prompt-source guard: no orchestrator file builds a system prompt by string interpolation, with its own planted-offender self-test.

## Task Commits

Each task was committed atomically:

1. **Task 1: prompt-boundary.ts — zero-interpolation delimited prompt construction (TDD)** - `ed16a00` (feat) — RED test + GREEN implementation; REFACTOR was a no-op (named consts + no SDK import were correct at first write)
2. **Task 2: injection invariant suite + agent-SDK-confinement scan** - `8ce67f0` (test)

_TDD note: Task 1's RED (module-not-found) → GREEN cycle was captured in a single atomic `feat` commit since the REFACTOR step required no changes; the plan-level `type: tdd` RED/GREEN sequence is documented under TDD Gate Compliance below._

## Files Created
- `src/orchestrator/prompt-boundary.ts` — SAND-04 zero-interpolation prompt boundary: `RESEARCH_SYSTEM_PROMPT`/`BUILD_SYSTEM_PROMPT` fixed consts + `buildResearchPrompt`/`buildBuildPrompt` delimited constructors. Pure string module, zero `@anthropic-ai/claude-agent-sdk` import.
- `src/orchestrator/prompt-boundary.test.ts` — unit tests: system-prompt byte-invariance under an injection payload, verbatim delimited-only placement, no text leak into the system prompt.
- `tests/invariants/prompt-injection-boundary.test.ts` — (1) reused-adversarial-fixture boundary suite and (2) agent-SDK-confinement scan + orchestrator prompt-source guard, each with a synthetic-offender self-test.

## Verification

- `npm test -- src/orchestrator/prompt-boundary.test.ts` → 9 passed.
- `npm test -- tests/invariants/prompt-injection-boundary.test.ts` → 32 passed (13 fixtures × 2 turns + guards + self-tests).
- Full suite: **435 passed + 6 todo** (394-pass baseline + 41 new tests; zero regressions, no real `query()`/WSL2/network exercised).
- `tsc --noEmit` clean; `biome check` clean on all three files.

## Deviations from Plan

None — plan executed exactly as written. The prompt-boundary module needed no REFACTOR pass (the GREEN implementation already extracted named system-prompt consts and imported no SDK), so Task 1's TDD cycle collapsed to one atomic `feat` commit.

## TDD Gate Compliance

Plan `type: tdd`. Task 1 followed RED → GREEN:
- **RED:** `prompt-boundary.test.ts` written first; run failed with `Cannot find module './prompt-boundary.js'` (fail-fast confirmed the feature did not yet exist).
- **GREEN:** `prompt-boundary.ts` implemented; 9 tests pass.
- **REFACTOR:** no-op (no changes needed).

Both RED and GREEN landed in commit `ed16a00` as a single atomic `feat(03-03)` (the test and implementation for the same unit). Task 2's invariant suite committed as `test(03-03)` `8ce67f0`. No unexpected passing test appeared during RED.

## Known Stubs

None. Both modules are fully wired: `prompt-boundary.ts` is consumed by the AgentRunSpec seam (03-02) and its constructors are exercised by real fixtures; the invariant scans run against the live source tree.

## Self-Check: PASSED
