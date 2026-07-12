---
phase: quick-260711-raz
plan: 01
subsystem: ingestion
tags: [free-reign, donor-privilege, control-window, chat-commands, compliance-gate]
requires:
  - "quick-260711-q5n (buildAwareChatSource interceptor + kind router)"
  - "Phase 4 control window (submitDuringWindow gate funnel, D-11/D-12)"
provides:
  - "In-window !suggest aliases !build through the SAME window funnel (gate classify → queue)"
  - "Window-open narration announcing both commands"
  - "Explicit test proof of the intake exemption (zero cooldown/cap state consumed in-window)"
affects: []
tech-stack:
  added: []
  patterns: ["interceptor alias — one regex added beside BUILD_COMMAND, zero new routing logic"]
key-files:
  created: []
  modified:
    - src/main.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - tests/e2e/tier1-commands.e2e.test.ts
decisions:
  - "D-11 open-slot resolution (binding, per plan): in-window !suggest uses EXACTLY `controlWindow.snapshot() !== null` — no identity comparison; any chatter's !suggest routes like any chatter's !build already does (test-asserted in e2e (e))"
  - "Directive scenario (c) reinterpreted per the plan's binding resolution: non-command chat untouched; non-donor in-window !suggest travels the open-slot path (matching the existing 'donorfan' idiom)"
metrics:
  duration: "~6 minutes"
  completed: "2026-07-12"
  tasks: 2
  tests: "986 passing (+6 e2e, +extended narration assertions)"
---

# Quick Task 260711-raz: Free-Reign Donor Privileges Summary

**One-liner:** In-window `!suggest` now aliases `!build` through the identical D-11 open-slot funnel (interceptor → gate classify → build queue) with a one-regex change; intake exemption and byte-compatibility proven by a 6-test e2e matrix.

## What Was Built

### Task 1 — Interceptor alias + narration (TDD)
- **RED** (`1ff453d`): narration verbatim assertions updated to dual-command copy plus a loop-assert that every open beat names both `!build` and `!suggest` — confirmed failing against the old strings.
- **GREEN** (`fe4eb30`):
  - `src/main.ts`: `SUGGEST_COMMAND = /^!suggest\s+(.+)$/i` added beside `BUILD_COMMAND` (same regex shape as command-parser's suggest match, with an agreement comment). `buildAwareChatSource` now matches `BUILD_COMMAND.exec(trimmed) ?? SUGGEST_COMMAND.exec(trimmed)`; the window condition is unchanged (`controlWindow.snapshot() !== null`). `routeWindowInstruction` untouched — candidate kind stays `"suggestion"`, source stays the window trigger, so the `gate_decision` audit row keeps window-source provenance for free. The D-11 comment block documents the alias and the structural intake exemption.
  - `src/ingestion/narration.ts`: both open beats now read `…Type !build or !suggest <your instruction> — it goes straight to the build queue.` Server-composed template strings only; donor/user name remains the sole interpolated chat-derived value; copy-separation test (no chance/luck/odds/random/roll in paid copy) passes against the new copy.

### Task 2 — E2E matrix (`5adf82f`)
New describe block in `tests/e2e/tier1-commands.e2e.test.ts` (131 insertions, **0 deletions** — the existing block-6 !build byte-compat suite is untouched):
- **(a)** in-window `!suggest` → queue grows post-gate, pool untouched, classify recorder proves the gate ran, honest "queued" beat
- **(b)** gate-rejected marker text → narrated denial, nothing queued/pooled, window still open (D-12)
- non-command chat during a window falls through silently (D2-15)
- **(c)** intake exemption EXPLICIT: same chatterId pools normally immediately post-window (60s default cooldown would have refused if any state had been consumed); in-window gate row `source: "donation"`, post-window `source: "chat"`
- **(d)** outside-window `!suggest` byte-compatible: pools `source "chat"`, `kind "suggestion"`, gate-before-pool ordering held
- **(e)** D-11 open-slot parity: a fresh window + a chatter ≠ donor gets the identical funnel

## Verification Results

| Gate | Result |
|------|--------|
| Full suite `npx vitest run` | 986 passed / 0 failed (baseline 980 + 6 new e2e) |
| Existing tier1 block 6 (!build byte-compat) | Passes UNCHANGED (0 removed/modified lines in the file) |
| `npx tsc --noEmit` | Clean |
| `npx biome check .` | Exit 0 (3 pre-existing warnings in `src/overlay/public/overlay.css` — out of scope, file untouched) |
| Invariant suite (single funnel, prompt-injection boundary) | Green |
| grep gate `SUGGEST_COMMAND` in src/main.ts | 2 (declaration + use) ≥ 2 ✓ |
| grep gate `!suggest` in src/ingestion/narration.ts | 6 ≥ 2 ✓ |
| No-diff files (command-parser.ts, twitch-chat.ts, control-window.ts, paid-window.ts) | 0 diffs ✓ |

## Binding Invariants — all held

1. **Single funnel:** in-window !suggest reuses `routeWindowInstruction` → `submitInstruction` → gate → queue; no new `as QueuedTask` mint; invariant suite green.
2. **Window !build byte-compatible:** existing e2e block at :603 passes unchanged (file diff is insert-only).
3. **Outside-window !suggest byte-compatible:** e2e (d) — source "chat", kind "suggestion", cooldown consumed via the normal parser/intake path.
4. **State machine / HALT untouched:** no changes outside the four planned files.
5. **Server-composed narration:** template strings only; copy-separation test green.
6. **D-11 open-slot resolution:** documented in the main.ts comment block and test-asserted in e2e (e).

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new surface beyond the plan's threat model. T-raz-01 mitigation verified (e2e (a) classify-before-queue); T-raz-04 mitigation verified (narration verbatim tests updated, no new interpolation).

## TDD Gate Compliance

RED commit `1ff453d` (test) precedes GREEN commit `fe4eb30` (feat). No refactor commit needed.

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| `1ff453d` | test | Failing narration assertions — open beats must announce both commands (RED) |
| `fe4eb30` | feat | SUGGEST_COMMAND interceptor alias + dual-command open beats (GREEN) |
| `5adf82f` | test | E2E matrix (a)–(e) + intake exemption + non-command fall-through |

## Self-Check: PASSED

- src/main.ts modified (SUGGEST_COMMAND present, 2 occurrences) — FOUND
- src/ingestion/narration.ts modified (!suggest in both open beats) — FOUND
- tests/e2e/tier1-commands.e2e.test.ts new block — FOUND
- Commits 1ff453d, fe4eb30, 5adf82f — FOUND in git log
