---
phase: quick-260716-9mk
plan: 01
subsystem: orchestrator
tags: [model-policy, security, options-assembly, fable]
requires: []
provides:
  - "Explicit claude-fable-5 model pin on every sandboxed build turn (BUILD_MODEL env override)"
  - "Host-branch model pin (defense-in-depth, CR-02/WR-01)"
affects: []
tech-stack:
  added: []
  patterns:
    - "GATE_MODEL-idiom call-time env read (process.env.BUILD_MODEL inside the assembly function)"
    - "?.trim() || hardening so a blank .env entry cannot un-pin"
key-files:
  created: []
  modified:
    - src/orchestrator/turn-options.ts
    - src/orchestrator/turn-options.test.ts
    - src/orchestrator/sdk-runner.ts
    - src/orchestrator/types.ts
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - .env.example
decisions:
  - "Pin assembleHostTurnOptions too: the unreachable host branch stays under the same CR-02/WR-01 doctrine as the MCP lockdown triple — no boundary depends on an SDK/account default"
  - "?.trim() || instead of GATE_MODEL's bare ??: a blank BUILD_MODEL= .env entry falls back to claude-fable-5 instead of un-pinning"
metrics:
  duration: "~5 min"
  completed: "2026-07-16"
---

# Quick Task 260716-9mk: Pin Sandboxed Build Turn Model to Fable Summary

Explicit `model: claude-fable-5` pin (BUILD_MODEL-overridable, blank-safe) in both options-assembly functions, replacing silent reliance on the builder account's ambient default.

## What Changed

- **src/orchestrator/turn-options.ts** — `assembleSandboxedBuildOptions` and `assembleHostTurnOptions` both return `model: process.env.BUILD_MODEL?.trim() || "claude-fable-5"`, read at assembly-call-time (GATE_MODEL idiom). Doctrine comments at both sites. Module stays runtime-SDK-free (`import type` only — verified by grep).
- **src/orchestrator/turn-options.test.ts** — 4 new tests (default pin, BUILD_MODEL override via `vi.stubEnv`, whitespace-only fallback, host-branch pin) plus `afterEach(() => vi.unstubAllEnvs())`. All 8 pre-existing tests (lockdown triple, acceptEdits, SAND-04 identity, no-mutation, host denylist) untouched and green.
- **Comment corrections** (no behavior changes): sdk-runner.ts header, types.ts AgentRunSpec doc, build-session.ts (~816 and ~1011), build-session.test.ts (~321) — every "inherits the Fable session default" claim replaced with the explicit-pin reality. Zero remaining "session default" mentions in src/orchestrator.
- **.env.example** — BUILD_MODEL entry added next to BUILD_TURN_TIMEOUT_SECONDS with pin rationale.

## Locked Invariants Verified

- classifier-runner.ts / classifier-runner.test.ts: zero diff (D-1 Sonnet gate untouched)
- AgentRunSpec: no model field added; build-session.test.ts `expect(spec && "model" in spec).toBe(false)` assertion byte-identical
- turn-options.ts: only `import type` from @anthropic-ai/claude-agent-sdk

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | bfdf09e | test(quick-260716-9mk): add failing tests for explicit build-turn model pin |
| 1 (GREEN) | 33a7c49 | feat(quick-260716-9mk): pin sandboxed build turn model to claude-fable-5 |
| 2 | 9f22d52 | docs(quick-260716-9mk): correct stale 'session default' comments; document BUILD_MODEL |

## Verification

- `npx vitest run` — 80 files, 1214 tests, all green
- `npx tsc --noEmit` — green
- `grep -rn "session default" src/orchestrator --include="*.ts"` — zero hits
- `grep BUILD_MODEL .env.example` — present

## Deviations from Plan

**1. [Rule 1 - Bug avoidance] Reworded the new turn-options.ts pin comment**
- **Found during:** Task 2
- **Issue:** The Task-1 comment draft said "the builder account's session default", which would have tripped the plan's own zero-"session default" verification grep.
- **Fix:** Reworded to "the builder account's ambient default" before the Task 2 commit.
- **Files modified:** src/orchestrator/turn-options.ts
- **Commit:** 9f22d52

## Threat Register Outcome

- T-9mk-01 (chat-influenced model selection): mitigated — pin lives only in orchestrator-authored assembly; spec structurally carries no model field
- T-9mk-02 (ambient account default override): mitigated — `?.trim() ||` hard default
- T-9mk-03 (auditability): accepted per plan — no new logging

## Self-Check: PASSED

- src/orchestrator/turn-options.ts: FOUND
- .env.example BUILD_MODEL: FOUND
- Commits bfdf09e, 33a7c49, 9f22d52: FOUND in git log
