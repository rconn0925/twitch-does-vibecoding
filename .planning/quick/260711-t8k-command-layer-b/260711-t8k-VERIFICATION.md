---
phase: quick-260711-t8k-command-layer-b
verified: 2026-07-11T22:03:30Z
status: human_needed
score: 8/8 must-haves verified
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Pre-stream live-fire dry run on the streaming PC: (1) with the real WSL2 sandbox adapter composed, boot the app and confirm python3 -m http.server is serving the ACTIVE app-N dir on 5555 (wsl -d vibecoding-build -u builder -- sh -lc 'pgrep -af http.server'); (2) click console New project and confirm the server re-roots to the fresh dir (one pkill+restart, old-port process gone); (3) vote a !swapbuild to victory against the real gallery publisher and confirm the current app's final snapshot lands on GitHub BEFORE the pointer moves, the swapped-to app appears in the preview slot, and NO new repo is created for the swap target"
    expected: "Detached nohup survival, end-anchored pkill scoping, and the confirmed-push-before-activation gate behave against real wsl.exe/python3/git/gh exactly as the injected fakes assert; a start failure leaves the app running with the standing-by preview page"
    why_human: "startPreviewDevServer/stopPreviewDevServer and the swap ship gate are exercised only through injected execFileFn/GalleryExec fakes in the suite — real external behavior (WSL process detach semantics, pkill matching against live python argv, GitHub push) cannot be proven by grep or unit tests"
---

# Quick Task 260711-t8k: Command Layer B Verification Report

**Task Goal:** !swapbuild (voted kind "swap" through the one funnel, LOCKED confirmed-push-before-activation, activate-existing with top_generation monotonicity, repo reuse), instant info commands (!projects/!current/!repo/!help — zero funnel contact, global per-command cooldown, post-gate slugs only), preview dev-server ownership (boot + re-root at all generation changes via existing adapter seam, end-anchored pkill, fail-open), OPERATIONS.md §11.
**Verified:** 2026-07-11T22:03:30Z
**Status:** human_needed (all automated checks passed; one live-fire dry-run item)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | !swapbuild wins → ship current (published\|no-changes) → activate EXISTING generation, repo binding reused, no new repo | ✓ VERIFIED | main.ts:1586-1718 runSwapWinner mirrors shipThenRotate ii-iv; activateExisting reachable only after publishNow resolves published\|no-changes (1647-1703); swap-command.e2e.test.ts:194-296 (published ordering) + :521-531 (ZERO `gh repo create` at the REAL createGalleryPublisher level, fake GalleryExec call list asserted) |
| 2 | Failed/unconfirmable ship NEVER activates — amber, audit, head removed, next round opens | ✓ VERIFIED | main.ts:1667-1697 (failed OR no publisher → swapShipFailed + recordSwapOutcome ship-failed + backToIdle, return BEFORE activateExisting); e2e :298-368 pins failed→pointer-unchanged AND no-changes→activates; :429 pins the loop never dead-rounds |
| 3 | Unresolvable name → amber failed-head; exclusively-current match → its own honest line | ✓ VERIFIED | main.ts:1606-1640 (null → swapUnresolved; target===current → swapAlreadyCurrent, distinct copy); resolveSwapTarget (main.ts:303-322) resolves over ALL rows, prefers non-current at the winning tier; e2e :370-439 + precedence table :441-482 |
| 4 | Generation monotonicity survives backward swaps: newProject allocates ABOVE the all-time high-water mark | ✓ VERIFIED | workspace.ts:89-101 single UPDATE `top_generation = top_generation + 1, generation = top_generation + 1` (never pointer+1); MONOTONICITY PIN workspace.test.ts:125-142 (3→1→newProject→4); POST-SWAP NEW-REPO PIN swap e2e :271 + :533-548 (fresh gen 4 → ONE `gh repo create` for the new name only); guarded ALTER migration + idempotent never-lowering seed workspace.ts:43-63, pinned :144-182 |
| 5 | Info commands reply instantly — NO gate, NO vote, NO state change, per-command cooldown (default 30s) | ✓ VERIFIED | twitch-chat.ts:145-148 dispatch calls `deps.infoCommand?.()` and RETURNS before intake.check/submit; main.ts:1108-1141 closure (envPositive INFO_COMMAND_COOLDOWN_SECONDS, per-kind lastSent map, HALTED-silent); info-commands.e2e.test.ts:116-128 (silent repeat, independent windows), :143 (zero funnel contact asserted), :180 (HALTED silent, no window charged) |
| 6 | !projects lists ONLY post-gate public data (repo_name slugs + github links) | ✓ VERIFIED | main.ts:1113-1126 composes from project_repos rows + public owner string only (prepared read-only SELECT, DEFAULT_GALLERY_OWNER fallback exported at gallery-publisher.ts:127); hostile-raw-prompt-never-appears pinned at info e2e :150 |
| 7 | Orchestrator owns the 5555 preview dev server: boot start, re-root on EVERY generation change, probe-checked, fail-open | ✓ VERIFIED | Wired at all four sites: boot main.ts:1943, console new-project wrapper :1322-1329, shipThenRotate rotation :1493, swap activation :1716. Supervisor (dev-server-supervisor.ts) serializes on a promise chain, one retry, never rejects, warn-once no-op on method-less adapters; preview-reroot.e2e.test.ts:208-318 pins boot/console/rotate/swap re-roots, failed-ship suppression, start-rejection fail-open, adapter absence |
| 8 | Swap text gate-screened through the ONE funnel (tier-1); info commands zero funnel contact (tier-2) | ✓ VERIFIED | twitch-chat.ts:158-193 swapbuild rides the SAME intake.check→submit path as suggest/build/revert; pool.add only inside submit.ts route() AFTER classify resolves approved (submit.ts:72-99); rejected-swap-never-pools pinned at swap e2e :639; tests/invariants (single-funnel, paid-chaos-separation, secrets-isolation) green in this verification run |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/preview/dev-server-supervisor.ts` | reroot: stop → start → probe → retry-once → fail-open | ✓ VERIFIED | 121 lines, substantive; imported + composed in main.ts:1927; never rejects; no child_process/spawn imports (types-only import) |
| `src/ingestion/command-parser.ts` | swapbuild (quoted/unquoted) + 5 info arms | ✓ VERIFIED | Lines 131-167: quote-strip + re-trim + 2000 cap; strict no-arg info arms, !commands→help alias; never-throw total parse kept |
| `src/orchestrator/workspace.ts` | top_generation high-water mark + validating activateExisting | ✓ VERIFIED | See truths 4; all rejection classes throw BEFORE any write, row-untouched asserted (workspace.test.ts:203-216) |
| `src/audit/schema.sql` | workspace_state.top_generation column (fresh DBs) | ✓ VERIFIED | Line 179, DEFAULT 0, doc comment cross-references the runtime migration |
| `src/audit/record.ts` | recordSwapOutcome (swap_activated / swap_failed statuses) | ✓ VERIFIED | Lines 634+; server-composed detail strings only, chat needle never written (deviation 2 doctrine); called at all four outcomes in runSwapWinner |
| `docs/OPERATIONS.md` | §11 orchestrator-owned preview server, manual start retired, pkill idiom | ✓ VERIFIED | §11 at line 388: retirement, lifecycle (boot + three re-root sites), end-anchored pkill rationale, wsl --terminate exclusion, troubleshooting, §10 cross-ref intact |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| twitch-chat.ts | pipeline/submit.ts | swap on the shared intake.check → deps.submit path | ✓ WIRED | `command.kind === "swapbuild"` → kind "swap", twitch-chat.ts:163-170; intake precedes submit |
| main.ts drainVoteQueue | runSwapWinner | `case "swap"` in the kind router | ✓ WIRED | main.ts:1773-1776 |
| runSwapWinner | galleryPublisher.publishNow | confirmed-push gate (published\|no-changes) | ✓ WIRED | main.ts:1650-1697; both orderings + no-publisher-unconfirmable path audited |
| workspace.newProject | workspace_state.top_generation | monotonic allocation, never pointer+1 | ✓ WIRED | workspace.ts:94-99 single UPDATE off top_generation |
| main.ts | dev-server-supervisor.ts | late-bound reRootPreview seam, boot + all three generation-change sites | ✓ WIRED | Declared main.ts:454 (no-op default — deviation 3), assigned :1940, fired :1326/:1493/:1716/:1943 |
| sandbox-process.ts | wsl.exe | EXISTING execFileFn seam only | ✓ WIRED | start/stopPreviewDevServer (lines 277-310) both use execFileFn(wslExePath, ["-d", distro, "-u", user, "--", "sh", "-lc", ...]); no new spawn paths; pkill literal `pkill -f 'http\.server ${port}$' \|\| true` end-anchored at :308 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Targeted suites (workspace, parser, dispatch, supervisor, sandbox argv, record, 3 new e2e specs, invariants) | `npx vitest run <9 targets> tests/invariants` | 263/263 passed (15 files) | ✓ PASS |
| Full regression | `npx vitest run` | 1138/1138 passed (75 files) — matches SUMMARY claim, re-run in verifier process | ✓ PASS |
| Type check | `npx tsc --noEmit` | clean | ✓ PASS |
| Grep gate: no distro-terminate in preview path | `grep -rn -- "--terminate" src/preview/` | zero hits | ✓ PASS |
| Grep gate: activation never scaffolds | `grep scaffoldRepo src/main.ts` | zero hits | ✓ PASS |
| Grep gate: no new process-spawn path in supervisor | `grep "child_process\|spawn(" src/preview/dev-server-supervisor.ts` | zero hits (types-only import) | ✓ PASS |
| Commits documented in SUMMARY | `git log --oneline` × 7 hashes | all 7 found (28d296d…be7387f) | ✓ PASS |

### Documented Deviations — soundness check (5/5 sound)

1. **submit.ts CandidateSchema kind enum + "swap"** — SOUND. The widening admits the kind through boundary shape-validation only; `pool.add` remains reachable exclusively inside `route()` after `classify()` resolves approved (submit.ts:72-99), so gate-before-pool ordering is unchanged for EVERY kind. Pinned by rejected-swap-never-pools (swap e2e :639) and the single-funnel invariant suite.
2. **Test-fake extensions for new interface members** — SOUND. Mechanical tsc-compliance; behavior-neutral.
3. **reRootPreview as no-op function default instead of nullable** — SOUND. main.ts:454; semantics identical (silent no-op until supervisor composes); failed-swap-ship path returns before the call site regardless.
4. **PREVIEW_DEV_SERVER_SETTLE_MS test knob** — SOUND. main.ts:1926-1935 applies only when the env parses to a finite >= 0 integer; timing-only, no broadcast-safety surface.
5. **Comment rewording for grep gates** — SOUND. Both gates verified against the live tree above; behavior unchanged.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | none | — | No TBD/FIXME/XXX in modified files; no stub returns; info replies read live project_repos rows; supervisor drives the real adapter seam |

### Human Verification Required

#### 1. Stream-night live-fire dry run (real WSL distro + real GitHub)

**Test:** On the streaming PC with the real sandbox adapter: boot → confirm `python3 -m http.server 5555` serves the active app-N dir; console New project → confirm re-root; vote a !swapbuild to victory → confirm the pre-swap app's final snapshot lands on GitHub BEFORE the pointer moves, the target app appears in the preview slot, and no new repo is created.
**Expected:** Detached nohup survival, end-anchored pkill scoping, and the confirmed-push-before-activation gate behave against real wsl.exe/python3/git/gh exactly as the injected fakes assert; a start failure fail-opens to the standing-by page without crashing the app.
**Why human:** The adapter's preview methods and the swap ship gate are exercised only through injected execFileFn/GalleryExec fakes — real WSL process-detach semantics, live pkill argv matching, and GitHub pushes cannot be proven by grep or unit tests. (Same class of item as q5n/rs3 verifications — batch into the existing pre-stream dry run.)

### Gaps Summary

None. All 8 must-have truths, all 6 artifacts, and all 6 key links verified directly against the merged tree; full suite 1138/1138, tsc clean, all grep gates pass in the verifier's own process. All 5 documented deviations are sound — in particular the submit.ts enum widening does not loosen gate-before-pool ordering for any kind. The single outstanding item is the real-machine dry run, consistent with this repo's convention of batching live-fire checks at the end.

---

_Verified: 2026-07-11T22:03:30Z_
_Verifier: Claude (gsd-verifier)_
