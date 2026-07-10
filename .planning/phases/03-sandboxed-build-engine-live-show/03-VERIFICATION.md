---
phase: 03-sandboxed-build-engine-live-show
verified: 2026-07-10T08:10:00Z
status: human_needed
score: 12/12 must-haves verified (against the fake-injected sandbox/agent contract)
overrides_applied: 0
verdict: achieved-against-fakes
blockers_reconfirmed:
  CR-01: closed
  CR-02: closed
wave_0_gate: OPEN (intentional) — SANDBOX-SETUP.md verdict ⏳ PENDING; single blocking item before any live/real build
human_verification:
  - test: "Wave 0 hands-on WSL2 proof (a): filesystem isolation"
    expected: "cat /mnt/c/Users/ross/.env FAILS; echo test > /etc/passwd FAILS; ls / shows only workspace+minimal"
    why_human: "SAND-01 real isolation cannot be proven against injected fakes — requires a live WSL2 distro"
  - test: "Wave 0 hands-on WSL2 proof (b): dev-server-only exposure"
    expected: "127.0.0.1:5555 reachable from Windows browser; sandbox CANNOT curl host 127.0.0.1:4900/4901"
    why_human: "SAND-02 one-way NAT exposure requires a live sandbox + real dev server"
  - test: "Wave 0 hands-on WSL2 proof (c): wsl --terminate veto teardown"
    expected: "wsl.exe --terminate <distro> kills a deliberately-hung process tree in seconds"
    why_human: "BUILD-04 real teardown — fakes prove the wiring/ordering, not that wsl --terminate actually kills the tree"
  - test: "Wave 0 proof (d): billing — same plan credits vs metered"
    expected: "in-distro claude draws on plan credits; if metered, record SANDBOX_ANTHROPIC_API_KEY fallback decision"
    why_human: "A1 billing behavior can only be observed by running claude inside the real distro"
  - test: "Wave 0 proof (e): cold+warm distro launch latency for live pacing"
    expected: "post-terminate cold launch + warm launch latency measured and acceptable for live show pacing"
    why_human: "latency feel is a live-pacing judgment call"
  - test: "CR-01 terminal-state on a REAL veto (streamer UAT)"
    expected: "halting a genuinely in-flight real build never renders 'BUILT IT' on the overlay and writes NO pipeline_stage:done audit row"
    why_human: "flagged in 03-REVIEW as wanting human confirmation; e2e proves it against fakes, but the real broadcast surface should be eyeballed once"
  - test: "WR-05 shutdown ordering under a real mid-build Ctrl-C"
    expected: "aborting the process mid-build drains cleanly — no unhandled promise rejection, no write to a closed DB"
    why_human: "no dedicated automated test exercises the close()-drain race; the 2s CLOSE_DRAIN_MS bound is a runtime-timing behavior"
  - test: "WR-07 watchdog bounds question (5-min per-turn / 2-s drain)"
    expected: "streamer confirms 5-min per-turn timeout and 2-s shutdown-drain are the right bounds for live pacing"
    why_human: "no automated test exercises the hung-stream watchdog; the numeric bounds are a live-show tuning decision, not a correctness fact"
warnings:
  - "WR-03 held-plan routing to the console review queue (D-08) is DEFERRED — a held plan is narrated + audited + dropped, not re-queued. Documented interim behavior (main.ts:540 TODO(D-08)); revisit when review-queue routing is implemented."
  - "WR-05 (close-drain race) and WR-07 (per-turn watchdog) fixes exist in code and read as structurally sound, but have NO dedicated automated test — their runtime behavior is covered only by human UAT above."
---

# Phase 3: Sandboxed Build Engine & Live Show — Verification Report

**Phase Goal:** The winning suggestion gets researched (Sonnet), planned & built (Fable) inside an isolated WSL2 sandbox, re-screened by a second compliance pass before and during the build, shown live on the overlay + an app-under-construction preview, with graceful narrated failure/refusal/retry-skip and a streamer veto that cleanly aborts an in-flight sandboxed build.

**Verified:** 2026-07-10T08:10:00Z
**Status:** human_needed
**Overall verdict:** **ACHIEVED AGAINST THE FAKE-INJECTED CONTRACT.** All 12 phase requirements are delivered in code and proven by non-vacuous tests running against injected fakes that model the sandbox/agent/network contract. Both BLOCKER-class review findings (CR-01, CR-02) are genuinely closed in the current tree. The one remaining blocking item before any live/real build is the deliberately-open Wave 0 human go/no-go (SANDBOX-SETUP.md, ⏳ PENDING).
**Re-verification:** No — initial verification (post-review-fix).

## Suite baseline (independently re-run)

| Check | Result |
|-------|--------|
| `vitest run` | **524 passed / 46 files** ✓ |
| `tsc --noEmit` | exit 0, clean ✓ |
| `biome check` (orchestrator/preview/overlay/console/kill-switch/invariants/e2e) | 49 files, no fixes ✓ |
| Invariants green | single-funnel, secrets-isolation, prompt-injection-boundary, dom-safety all pass (non-vacuous, self-tested) ✓ |
| Debt markers in phase files | 0 TBD/FIXME/XXX; 1 documented `TODO(D-08)` referencing a formal decision (warning, not blocker) ✓ |

## Blocker Re-Confirmation (the two CR- findings)

### CR-01 — aborted/vetoed/halted builds must NOT finalize as `done` → **CLOSED**

- `finalizeAborted()` exists (`src/orchestrator/build-session.ts:377-406`). It writes a `recordSandboxTeardown` audit row — **not** `recordPipelineStage(stage:"done")` — collapses the overlay panel by nulling `current` and emitting `BUILD_STAGE_CHANGED` **without ever emitting a `done` stage**, leaves `HALTED` untouched (kill switch owns it), and dequeues/unregisters for a clean exit.
- **All three abort paths route through it:** build-turn abort (`:629-632`), research abort (`:718`), plan abort (`:739`). The old `finalize(task, "done")` on abort is gone.
- **Non-vacuous proof:** `tests/e2e/build-failure.e2e.test.ts` third case (`:342-349`) now asserts, after a real halt+release, that the observed overlay stages **never contain `"done"`** AND that `listAuditRecords(..., eventType:"pipeline_stage", decision:"done")` is length 0. The review's original complaint (test released the gate but never asserted stage/audit) is directly remediated.

### CR-02 — no unsandboxed host turn may pair host-fs read with network egress on untrusted input → **CLOSED**

- `src/orchestrator/sdk-runner.ts:40` — `RESEARCH_TOOLS = ["Read","Grep","Glob"]`. `WebSearch`/`WebFetch` are **removed** (the read-then-exfiltrate pairing is broken structurally).
- `HOST_TURN_DISALLOWED` denylist (`:48-56`) explicitly forbids `WebFetch, WebSearch, Write, Edit, MultiEdit, NotebookEdit, Bash` and is applied to **both** the research turn (`:78-79`) and the plan turn (`:83-84`) — the host tool boundary no longer depends on an SDK default (also closes WR-01).
- The plan turn now runs with `allowedTools: []` (text-only). Confinement of `@anthropic-ai/claude-agent-sdk` to `src/orchestrator/` is machine-enforced by `tests/invariants/prompt-injection-boundary.test.ts` (with a planted-offender self-test).

## Requirement-by-Requirement Trace

| Requirement | Code location | Proving test | Verdict |
|-------------|--------------|--------------|---------|
| **BUILD-01** full pipeline research→plan→comp02→build, one-at-a-time | `build-session.ts` `runPipeline` (research `:706` → plan `:727` → COMP-02 `:746` → build `:784`); `PQueue({concurrency:1})` `:278` | `build-flow.e2e.test.ts` (research→plan→building→done, BUILD_IN_PROGRESS→IDLE); `build-session.test.ts` "serializes two builds" (`:795`) | ✓ VERIFIED (vs fakes) |
| **BUILD-02** progress-stage vocabulary → overlay/chat | `progress-events.ts` `translate()` (single SDK-shape inspector → PipelineStage); `emitStage` → audit + overlay push + progress sink (`:314`) | `progress-events.test.ts`; `build-flow.e2e` overlay `/api/state` reflects live `building` stage | ✓ VERIFIED |
| **BUILD-03** narrated failure/refusal, auto-retry-once, streamer retry/skip | `runBuildAttempt` (`:601`) auto-retry-once (`:674-683`), refusal→decision, narrator beats; console `/api/tasks/:id/retry` + `/skip` (`server.ts:589,603`) | `build-failure.e2e.test.ts` (auto-retry once, narrated retry+decision, skip→IDLE+audit; refusal→`refused`+narration) | ✓ VERIFIED |
| **BUILD-04** veto aborts in-flight sandboxed build; wsl --terminate teardown; HALTED immediate | AbortRegistry controller + `registerSandboxTeardown`→`sandboxAdapter.terminate()` (`:544-547`); `finalizeAborted`; `sandbox-process.ts` `terminate()`=`wsl.exe --terminate` | `build-failure.e2e.test.ts` case 3 (AbortController aborted, fake teardown fires, HALTED immediate, CR-01 no-done) | ✓ VERIFIED (vs fakes) — **real `wsl --terminate` kill is Wave 0 proof (c)** |
| **COMP-02** plan re-screen BEFORE + output re-screen DURING build | `comp02.ts` `screenBuildPlan` + `screenOutputBatch` (same pre-bound single-funnel `classify`); pre-write at `:746`, in-flight per Write/Edit batch at `:449`; WR-02 NotebookEdit fix `extractWriteEditText:245-246` | `build-flow.e2e` (`-plan` candidate hits gate before any `-output`); `build-session.test.ts` in-flight re-screen (`:409`) + rejected-batch abort (`:435`) | ✓ VERIFIED |
| **SAND-01** filesystem isolation (agent can't read/write host outside workspace) | `sandbox-process.ts` `buildSandboxOptions()` `failIfUnavailable:true`, `filesystem.denyRead/denyWrite ["/mnt"]` | `secrets-isolation.test.ts` (env-allowlist scan) | ✓ code+fake VERIFIED — **real filesystem-escape proof is Wave 0 (a)** |
| **SAND-02** dev-server-only host exposure | `preview-manager.ts` probes only `127.0.0.1:<devServerPort>`; NAT one-way; overlay/preview are read-only localhost surfaces | `preview-manager.test.ts` | ✓ code+fake VERIFIED — **real one-way NAT proof is Wave 0 (b)** |
| **SAND-03** sandbox adapter env allowlist + secrets isolation | `sandbox-process.ts` `buildSandboxEnv` = explicit `{PATH}` literal, never spreads `process.env`/`opts.env`; sandbox-scoped key only via distinct `SANDBOX_ANTHROPIC_API_KEY` | `secrets-isolation.test.ts` (forbids env spread + host-secret identifiers; synthetic-offender self-test) | ✓ VERIFIED |
| **SAND-04** prompt-injection boundary (chat text as delimited data) | `prompt-boundary.ts` fixed module-level system prompts, untrusted text only inside `<task_description>`/`<build_plan>` frames; zero interpolation | `prompt-injection-boundary.test.ts` (every Phase-1 adversarial fixture; system prompt invariant; SDK-confinement + interpolated-prompt self-tests) | ✓ VERIFIED |
| **PRES-02** overlay suggestion queue + current build status | `overlay/public/overlay.js` `build-panel` renders live `buildStatus` | `build-flow.e2e` overlay `/api/state` build fields; `overlay/server.test.ts` | ✓ VERIFIED |
| **PRES-03** app-under-construction preview surface (auto-refresh iframe) | `preview/server.ts` + `preview.html` iframe framing `devServerUrl` (WR-06: `http://127.0.0.1:${port}` matches probe); IN-01 fixed — iframe `sandbox` no longer grants `allow-popups` | `preview-manager.test.ts`, `preview/server.test.ts` | ✓ code+fake VERIFIED — **real dev-server reachability is Wave 0 (b)** |
| **PRES-04** overlay pipeline stepper (researching→planning→building) | `overlay.js` `build-stepper` + `effectiveStepIndex` (done→beat only; failed/refused freeze at last active step, amber caption) | `build-flow.e2e` stage sequence; overlay render tests | ✓ VERIFIED |

**Score: 12/12 requirements delivered and proven against the fake-injected contract.**

## Fully-code-proven vs Wave-0-residual

- **Fully proven in code + fakes (no Wave 0 dependency):** BUILD-01, BUILD-02, BUILD-03, COMP-02, SAND-03 (env allowlist), SAND-04, PRES-02, PRES-04.
- **Coded + fake-tested, but the REAL safety proof is Wave 0 hands-on:** SAND-01 (filesystem escape → proof a), SAND-02/PRES-03 (dev-server one-way exposure → proof b), BUILD-04 (`wsl --terminate` real kill → proof c). The wiring, ordering, and fail-closed discipline are verified; only the real WSL2 isolation/kill behavior awaits the streamer's go/no-go.

## Wave 0 Open-Gate Callout (the single blocking item before live use)

`SANDBOX-SETUP.md` verdict is **⏳ PENDING**. This is **by design** — the phase was built with a Wave 0 human-validation gate that deliberately precedes any real execution. All code waves (03-02..03-09) were built against injected fakes, so the code is complete and green without real WSL2. **No real build may execute until the streamer records a GO** after performing proofs (a) filesystem escape, (b) dev-server exposure, (c) `wsl --terminate` veto, (d) billing, (e) latency. A NO-GO on isolation or veto escalates to the Docker path (03-RESEARCH §Alternatives). This is the one and only thing standing between "code goal achieved" and "safe to run live."

## Anti-Patterns / Residuals

| Item | Severity | Note |
|------|----------|------|
| `TODO(D-08)` at `main.ts:540` — held-plan console review-queue routing deferred | ⚠️ Warning | References formal decision D-08; interim behavior is explicit, narrated (`buildHeld`) + audited (`comp02_decision: held-for-review` + `pipeline_stage: refused`). Held plan is dropped, not re-queued. Not a silent stub; not a blocker. |
| WR-05 (close-drain race) fix has no dedicated test | ⚠️ Warning | `running` promise tracking + `auditIfOpen` guard + `CLOSE_DRAIN_MS` exist and read as sound; runtime behavior covered only by human UAT. |
| WR-07 (per-turn watchdog) fix has no dedicated test | ⚠️ Warning | `turnTimeoutMs`/`DEFAULT_TURN_TIMEOUT_MS` + `timedOut` routing exist and read as sound; the 5-min turn / 2-s drain bounds are a live-pacing judgment call for the streamer. |
| Other 03-REVIEW warnings | ℹ️ Resolved | WR-01 (plan-turn allowlist) closed in sdk-runner; WR-02 (NotebookEdit) closed in extractWriteEditText; WR-04 (stale types) / WR-06 (127.0.0.1 preview URL) / IN-01 (drop allow-popups) all reflected in current code. |

## Human Verification Required (UAT / judgment items)

1. **Wave 0 hands-on proofs (a)-(e)** — the real WSL2 isolation/veto/billing/latency go/no-go. See SANDBOX-SETUP.md. **Blocking for live use.**
2. **CR-01 terminal-state on a real veto** — eyeball that halting a genuine in-flight build never shows "BUILT IT" and leaves no `pipeline_stage:done` row (proven vs fakes; confirm once on the real broadcast surface).
3. **WR-05 shutdown ordering** — Ctrl-C mid-real-build: no unhandled rejection, no write to a closed DB.
4. **WR-07 watchdog bounds question** — confirm 5-min per-turn timeout and 2-s shutdown-drain are correct for live pacing (no automated test exercises the hung-stream path).

## Gaps Summary

No FAILED truths and no surviving blockers. Both CR-01 and CR-02 are independently re-confirmed closed with non-vacuous tests. The code goal is achieved against the fake-injected sandbox/agent/network contract (12/12 requirements, 524 tests green, tsc+biome clean). Status is **human_needed** (not gaps_found) because (a) the Wave 0 real-sandbox go/no-go is intentionally open and is the single blocking gate before any live build, and (b) three review fixes (CR-01 terminal-state, WR-05 shutdown, WR-07 bounds) plus the Wave 0 proofs require hands-on human verification that grep/tests cannot supply.

---

_Verified: 2026-07-10T08:10:00Z_
_Verifier: Claude (gsd-verifier)_
_Methodology: goal-backward — requirement → code → proving test, with independent suite re-run and blocker re-confirmation_
