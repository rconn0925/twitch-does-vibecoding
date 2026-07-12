---
phase: quick-260711-t8k-command-layer-b
plan: 01
subsystem: chat-commands, workspace, preview
tags: [swapbuild, info-commands, top-generation, preview-supervisor, tdd]
requires:
  - src/pipeline/submit.ts single funnel (COMP-01)
  - src/orchestrator/gallery-publisher.ts project_repos routing (quick-hak)
  - quick-q5n kind router (shipThenRotate / runRevertWinner idioms)
provides:
  - "!swapbuild: chat-voted kind 'swap' — ship-gated (LOCKED published|no-changes) activate-existing portfolio swap, repo binding reused"
  - "workspace_state.top_generation monotonic high-water mark + validating activateExisting pointer move"
  - "!projects/!current/!repo/!help/!commands tier-2 instant info replies (zero funnel contact, per-command cooldown)"
  - "orchestrator-owned preview dev server: boot start + re-root on every generation change, probe-checked, fail-open"
affects: [overlay-command-panel (task C), stream-night dry run]
tech-stack:
  added: []
  patterns:
    - "high-water-mark allocation (top_generation) for collision-free generation reuse"
    - "serialized fail-open supervisor chain (gallery-publisher chain idiom) for host-owned distro processes"
    - "end-anchored pkill-by-port process scoping inside the distro"
key-files:
  created:
    - src/preview/dev-server-supervisor.ts
    - src/preview/dev-server-supervisor.test.ts
    - tests/e2e/info-commands.e2e.test.ts
    - tests/e2e/swap-command.e2e.test.ts
    - tests/e2e/preview-reroot.e2e.test.ts
  modified:
    - src/shared/types.ts (CandidateKind + "swap")
    - src/ingestion/command-parser.ts (+ swapbuild, + info arms)
    - src/ingestion/twitch-chat.ts (swap on the shared tier-1 path; infoCommand seam)
    - src/ingestion/narration.ts (pooled-swap, SWAP TO listing, 4 swap beats, 4 info replies)
    - src/orchestrator/types.ts (WorkspaceView.activateExisting; SandboxAdapter preview methods)
    - src/orchestrator/workspace.ts (top_generation migration/seed; monotonic newProject; activateExisting)
    - src/orchestrator/sandbox-process.ts (start/stopPreviewDevServer via execFileFn seam)
    - src/orchestrator/gallery-publisher.ts (DEFAULT_GALLERY_OWNER exported)
    - src/audit/schema.sql (top_generation column; swap event comments)
    - src/audit/record.ts (recordSwapOutcome)
    - src/pipeline/submit.ts (CandidateSchema kind enum + "swap" — see deviations)
    - src/main.ts (runSwapWinner + case "swap"; info closure; supervisor wiring; reRootPreview seam)
    - docs/OPERATIONS.md (§11)
decisions:
  - "swapActivated(name) sends the transition + landed lines post-activation (plan's at-most-two-sends contract); no pre-publish swap beat exists, so the copy avoids claiming a push that may not have happened (unscaffolded skip-ship path)"
  - "Swap audit detail strings are fixed server-composed text — the normalized chat needle is never written to swap_failed rows (recordRevertOutcome doctrine)"
  - "Supervisor deliberately does NOT stop the dev server in close() — availability by design (the 260711 outage was the server dying, not living too long)"
metrics:
  duration: ~40 min
  completed: 2026-07-12
  tasks: 3 (TDD: RED+GREEN commits each)
  tests: 1138 passing (+103 over the 1035 baseline)
---

# Quick Task 260711-t8k: Command Layer B Summary

**One-liner:** !swapbuild ships-then-activates existing generations over a monotonic top_generation high-water mark (repo bindings reused, LOCKED confirmed-push gate), five instant info commands reply from post-gate repo slugs only, and the 5555 preview dev server is now orchestrator-owned (boot start + re-root on every generation change, fail-open).

## Commits

| Task | Phase | Commit | What |
|------|-------|--------|------|
| 1 | RED | 28d296d | failing tests: info command parser/dispatch/narration/e2e |
| 1 | GREEN | 34ddaed | !projects/!current/!repo/!help/!commands — zero funnel contact, INFO_COMMAND_COOLDOWN_SECONDS (30), HALTED silence |
| 2 | RED | c4fcf99 | failing tests: swapbuild parse, monotonicity pin, migration, activateExisting rejections, LOCKED orderings, repo reuse |
| 2 | GREEN | 6818a5b | kind "swap" through the ONE funnel; top_generation (schema + guarded migration + seed); runSwapWinner (resolve → ship gate → activate); recordSwapOutcome; swap beats |
| 3 | RED | 5715833 | failing tests: supervisor unit, sandbox argv (end-anchored pkill), re-root e2e |
| 3 | GREEN | bd2d6a7 | dev-server-supervisor + adapter methods + main.ts wiring (boot/console/rotate/swap re-root) |
| 3 | docs | be7387f | OPERATIONS.md §11 — manual 5555 start retired |

## Verification

- `npx vitest run` — **1138/1138** green (75 files), including the monotonicity pin (activate 3→1 → newProject → 4, never 2) and the post-swap new-repo pin (fresh gen 4 publish, `gh repo create` for gen-4 name only; zero creates for the swapped-to generation).
- `npx vitest run tests/invariants` — single-funnel, paid-chaos-separation, secrets-isolation, chat-sender, dom-safety all green (part of the full run).
- `npx tsc --noEmit` clean; `npx biome check src tests` exit 0 (3 pre-existing CSS warnings only).
- Grep gates: `case "swap"` in main.ts kind router — hit; `--terminate` under src/preview/ — zero hits; `scaffoldRepo` in main.ts — 0; `top_generation` in workspace.ts + schema.sql — both hit.

## Must-have truths — status

- Swap wins ship (confirmed published|no-changes) then activate the EXISTING generation, repo binding reused, never a new repo — e2e + publisher-level pins. DONE
- Failed/unconfirmable ship never activates — amber beat, swap_failed audit row, head removed, next round opens. DONE (both orderings test-pinned)
- Unresolvable name → failed-head amber; exclusively-current match → its own honest "already on screen" line. DONE
- Monotonicity: activate 3→1 then newProject → 4 (top_generation column, guarded ALTER migration, idempotent seed, in-method activateExisting validation with row-untouched rejection tests). DONE
- Info commands: instant, zero gate/vote/state change, per-command 30s cooldown windows (independent), post-gate repo_name slugs + links only (hostile-prompt-never-appears asserted), HALTED-silent. DONE
- Preview server: boot start at active app-N, kill+re-root on console new-project / project-switch / swap activation, TCP-probe health check with one retry, fail-open (start failure never crashes the app), end-anchored pkill, distro-terminate teardown never involved. DONE
- Paid↔chaos separation, halt/state machine untouched; console chaos pick still excludes swap; paid-window !swapbuild falls through to pooling. DONE

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened src/pipeline/submit.ts CandidateSchema kind enum with "swap"**
- **Found during:** Task 2 (swap e2e — every swap submission threw ZodError at the funnel boundary)
- **Issue:** The single funnel's own zod boundary enumerates kinds; the plan's files list omitted submit.ts
- **Fix:** `kind: z.enum([... , "swap"])` + doc comment; gate-before-pool proven by the rejected-swap-never-pools e2e
- **Commit:** 6818a5b

**2. [Rule 3 - Blocking] Extended WorkspaceView/Narrator test fakes for the new interface members**
- **Found during:** Tasks 1–2 (tsc gate)
- **Fix:** `activateExisting` added to fakes in operator-console/server.test.ts, orchestrator/build-session.test.ts, tests/e2e/build-history.e2e.test.ts; info/swap narrator stubs added to tests/e2e/recovery.e2e.test.ts and twitch-chat.test.ts
- **Commits:** 34ddaed, 6818a5b

**3. [Rule 3 - Blocking] reRootPreview seam typed as a no-op function default instead of `(() => void) | null = null`**
- **Found during:** Task 2 (tsc: TS narrows a never-reassigned `let x = null` to `null`, making `x?.()` uncompilable before Task 3's assignment lands)
- **Fix:** `let reRootPreview: () => void = () => {};` — semantics identical (silent no-op until the supervisor composes)
- **Commit:** 6818a5b

**4. [Rule 2 - Testability knob] PREVIEW_DEV_SERVER_SETTLE_MS env override for the supervisor settle wait**
- **Found during:** Task 3 (e2e reroot chains with the 1500ms default would stack past hook timeouts)
- **Fix:** main.ts passes `settleMs` only when the env var parses to a >= 0 integer; unset/invalid → the plan's ~1500ms default. Not a broadcast-safety-relevant knob (timing only)
- **Commit:** bd2d6a7

**5. [Rule 1 - Cosmetic, grep-gate compliance] Comment rewording**
- A pre-existing quick-q5n comment in main.ts mentioned `scaffoldRepo` (the plan's gate expects a zero count — no *call* ever existed); supervisor comments/test names avoided the literal `--terminate` token so the src/preview grep gate reads zero. Behavior unchanged.
- **Commit:** bd2d6a7

## Known Stubs

None — no placeholder copy, no unwired data paths introduced. The info replies read live `project_repos` rows; the supervisor drives the real adapter seam.

## Threat Flags

None beyond the plan's threat model. New surfaces (info replies, swap resolution, preview scripts) land exactly on T-t8k-01..09 mitigations: prepared statements + in-memory matching only, LOCKED activation gate, post-gate slugs on chat, cooldown upstream of the rate-budgeted sender, internally-derived dir/port in the wsl scripts, end-anchored pkill.

## Self-Check: PASSED

- src/preview/dev-server-supervisor.ts — FOUND
- tests/e2e/swap-command.e2e.test.ts / info-commands.e2e.test.ts / preview-reroot.e2e.test.ts — FOUND
- Commits 28d296d, 34ddaed, c4fcf99, 6818a5b, 5715833, bd2d6a7, be7387f — FOUND in git log
- Full suite 1138 pass; tsc + biome clean re-verified after the final commit
