---
phase: 3
slug: sandboxed-build-engine-live-show
status: verified
threats_open: 0
asvs_level: 2
created: 2026-07-10
---

# Phase 3 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Verification method: each declared mitigation was located in the current
> (post-REVIEW/post-fix) implementation by direct code inspection — documentation
> and intent were NOT accepted as evidence. Six Wave-0-dependent threats carry
> their CODE mitigation verified-present here, with the real-environment proof
> flagged as the still-open Wave 0 hands-on gate (SANDBOX-SETUP.md), NOT a code gap.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| chat-derived task → agent pipeline | Untrusted viewer text enters research/plan/build agents | Suggestion text (untrusted, prompt-injection risk) |
| orchestrator host ↔ WSL2 sandbox | Host Node process spawns the Claude Code engine inside the build distro | Spawn env (allowlist), build plan text, teardown signal |
| build-agent output → broadcast/workspace | Generated plan + Write/Edit output batches | Agent-authored code/plan (compliance-drift risk) |
| console POST routes → orchestrator control | Operator retry/skip/veto/halt commands | Task ids, reason tags (CSRF surface) |
| streamer veto → in-flight sandboxed build | Kill switch aborts a running build tree | AbortSignal + `wsl.exe --terminate` teardown |
| public overlay/preview surfaces → broadcast | Overlay + app-under-construction rendered on stream | Build title, stage vocabulary, dev-server reachability |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation (verified location) | Status |
|-----------|----------|-----------|-------------|--------------------------------|--------|
| T-03-01 | Info Disclosure | WSL2 drvfs automount /mnt/c | mitigate | Code defense-in-depth: `buildSandboxOptions()` sets `filesystem.denyRead/denyWrite: ["/mnt"]` — `src/orchestrator/sandbox-process.ts:150-162`. Real automount-off proof = Wave 0 gate. | closed¹ |
| T-03-02 | Spoofing | Sandbox → host loopback console/overlay | mitigate | Code: default NAT retained; `network.allowedDomains` package-registry allowlist only — `sandbox-process.ts:154-156`. Real "cannot reach 127.0.0.1:4900/4901" proof = Wave 0 gate (b). | closed¹ |
| T-03-03 | DoS (kill switch) | Hung Linux process surviving veto | mitigate | Code: `sandboxTeardown = wsl.exe --terminate` in abort fan-out — `src/kill-switch/abort.ts:124-133`; registered in `build-session.ts:546`. Real terminate-vs-hung-tree proof = Wave 0 gate (c). | closed¹ |
| T-03-04 | Info Disclosure | Host claude credential copied into sandbox | mitigate/accept | Code: env is explicit object-literal allowlist (`PATH` only); host key never spread — `sandbox-process.ts:72-83`. In-distro `claude login` is the primary path; distinct `SANDBOX_ANTHROPIC_API_KEY` is the only fallback. | closed¹ |
| T-03-05 | Tampering (billing) | Metered per-token billing in-sandbox | accept-with-verification | Code: fallback injects ONLY `SANDBOX_`-prefixed key, deriving the in-distro name by stripping the prefix — `sandbox-process.ts:74-81`. A1 billing surface proof = Wave 0 gate (d). | closed¹ |
| T-03-SC | Tampering | @anthropic-ai/claude-agent-sdk supply chain | mitigate | Exact pin `"@anthropic-ai/claude-agent-sdk": "0.3.206"` — `package.json:18`. | closed |
| T-03-06 | Info Disclosure | Raw SDK message types leaking to stream | mitigate | `translate()` is the sole raw-shape inspector; only fixed `PipelineStage` vocabulary crosses outward; unknown → null, never throws — `src/orchestrator/progress-events.ts:49-78`. | closed |
| T-03-07 | Repudiation | Pipeline events not auditable | mitigate | `recordPipelineStage` + `recordComp02Decision`/`recordBuildRefusal`/`recordBuildRetry`/`recordBuildSkip`/`recordSandboxTeardown` each append one row with task id — `src/audit/record.ts:270-393`. | closed |
| T-03-08 | EoP | Chat-driven prompt injection reaching tool-use | mitigate | Fixed module-level system prompts + delimited-data user turn — `src/orchestrator/prompt-boundary.ts:39-100`; adversarial-fixture invariant over every fixture — `tests/invariants/prompt-injection-boundary.test.ts:60-108`. | closed |
| T-03-09 | Tampering | Future file interpolating text into a prompt | mitigate | `INTERPOLATED_SYSTEM_PROMPT` source scan + planted-offender self-test — `prompt-injection-boundary.test.ts:138-189`. | closed |
| T-03-12a | EoP | File outside src/orchestrator/ importing the SDK | mitigate | Agent-SDK-confinement source scan + synthetic `src/ingestion/rogue.ts` self-test — `prompt-injection-boundary.test.ts:123-171`. | closed |
| T-03-10 | EoP | Non-compliant build plan reaching execution | mitigate | `screenBuildPlan()` pre-write re-screen before the build query() — `build-session.ts:746-779`; in-flight `screenOutputBatch()` per batch — `build-session.ts:445-465`; both call the single funnel `classify()` — `src/orchestrator/comp02.ts:74-116`. | closed |
| T-03-11 | Tampering | COMP-02 bypassing the single funnel | mitigate | COMP-02 uses direct pre-bound `classify()` only; single-funnel invariant proves no `toQueuedTask`/`.enqueue(` in orchestrator — `tests/invariants/single-funnel.test.ts:159-195`. | closed |
| T-03-12b | Info Disclosure | Host secrets forwarded into sandbox env | mitigate | Explicit allowlist (`PATH` only) — `sandbox-process.ts:72-83`; secrets-isolation source scan (no `...process.env`, no host-secret identifiers) + self-test — `tests/invariants/secrets-isolation.test.ts:36-94`. | closed |
| T-03-13 | DoS (kill switch) | wsl.exe orphaning — tree survives veto | mitigate | `registerSandboxTeardown` → `wsl.exe --terminate` fired in `abortActiveWork` fan-out (not instead of tree-kill) — `abort.ts:55-59,124-133`; `build-session.ts:544-547`. Real proof = Wave 0 gate (c). | closed¹ |
| T-03-14 | Tampering | Silently-unsandboxed build if layer unavailable | mitigate | `buildSandboxOptions()` sets `failIfUnavailable: true` — `sandbox-process.ts:151-153`; applied on every build turn — `sdk-runner.ts:71-75`. | closed |
| T-03-20 | EoP | Untrusted chat task executing inside sandbox | mitigate | Build turn runs via `spawnClaudeCodeProcess` into WSL2 with sandbox options — `build-session.ts:601-622`, `sdk-runner.ts:71-75`; prompt-boundary keeps text as delimited data. | closed |
| T-03-21 | EoP | Orchestrator gaining a second enqueue path | mitigate | Build session calls `taskQueue.remove()/list()` only; single-funnel check (b) confirms `.enqueue(` only under src/pipeline/ — `single-funnel.test.ts:159-168`. | closed |
| T-03-22 | DoS | Stuck BUILD_IN_PROGRESS with no exit | mitigate | Fail-closed/never-throw pipeline + `PQueue({concurrency:1})` + per-turn WR-07 watchdog aborts+fails a hung stream — `build-session.ts:184,277-278,413-501,785-788`. | closed |
| T-03-23 | Tampering | Silently running a build outside the sandbox | mitigate | Real SDK runner dynamically imported behind guarded entrypoint; `failIfUnavailable: true` fails loud — `sdk-runner.ts:1-24,71-75`, `sandbox-process.ts:151-153`. | closed |
| T-03-27 | Info Disclosure/EoP | Compliant plan drifting into non-compliant output | mitigate | `screenOutputBatch` re-screens each Write/Edit batch; rejected batch aborts+narrates — `build-session.ts:445-465,657-662`; NotebookEdit `notebook_path`/`new_source` covered (WR-02) — `build-session.ts:242-246`. | closed |
| T-03-15 | Tampering (XSS) | Chat-voted title rendered on overlay | mitigate | `el()` textContent-only + `truncate(..,80)` — `src/overlay/public/overlay.js:69-79,276`; dom-safety no-sink invariant + self-test — `tests/invariants/dom-safety.test.ts:42-81`. | closed |
| T-03-16 | Info Disclosure | Error/rationale reaching broadcast | mitigate | `BuildStatusView` carries only `{taskId,title,stage}` — `build-session.ts:314-316`; fixed `STAGE_CAPTION` amber failed/refused copy, no error text — `overlay.js:56-65`; abort path emits no `done` — `finalizeAborted` `build-session.ts:377-406`. | closed |
| T-03-17 | Info Disclosure | Preview exposing more than the dev server | mitigate | iframe `src` = dev-server URL only, no ws/orchestrator connection — `src/preview/public/preview.js:79-93`; server has no mutation route + `/api/reachable` returns only `{reachable,url}` — `src/preview/server.ts:52-86`. | closed |
| T-03-18 | Spoofing | Non-loopback client reading the preview | mitigate | First middleware `isLoopbackHostHeader` → 403 + `listen(port,"127.0.0.1")` — `preview/server.ts:61-67,92`; shared helper — `src/shared/loopback.ts`. | closed |
| T-03-19 | Info Disclosure | Raw browser error/stack on stream | mitigate | Unreachable → amber "STANDING BY" + calm placeholder, fail-closed probe — `preview/preview-manager.ts:105-114`, `preview.js:17-19,131-165`. | closed |
| T-03-24 | DoS (dead air) | Silent build failure/stall on stream | mitigate | Never-silent: narrated failed/refused/held/retry/skip beats + console retry/skip; auto-retry once on transient — `build-session.ts:572-692`. | closed |
| T-03-25 | Spoofing/CSRF | Forged retry/skip request | mitigate | Retry/skip POST routes inherit the uniform global CSRF middleware (Origin+`application/json`) + DNS-rebinding Host check applied before all routes — `src/operator-console/server.ts:185-236,589-610`. | closed |
| T-03-26 | DoS (kill switch) | Veto not reaching in-flight build | mitigate | `abortActiveWork` fires `sandboxTeardown` + `controller.abort()` fan-out — `abort.ts:92-148`; HALTED is immediate/decoupled from teardown; aborted path routes through `finalizeAborted` and never emits `done` — `build-session.ts:377-406,629-632`. | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

¹ **Wave-0-dependent (accept-with-verification).** The CODE mitigation is verified present in the current implementation and exercised against injected fakes. The FINAL real-environment proof (filesystem escape, dev-server/loopback exposure, `wsl.exe --terminate` vs a hung tree, A1 billing) is the still-PENDING hands-on gate in `SANDBOX-SETUP.md` (verdict currently ⏳ PENDING). These are NOT unmitigated code gaps; they are documented accepted risks pending the Wave 0 go/no-go. No REAL build may execute until that verdict reads GO.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-1 | T-03-01, T-03-02, T-03-03, T-03-13 | WSL2 isolation + veto teardown code mitigations are present and fake-tested; real-environment proof deferred to the Wave 0 hands-on gate (SANDBOX-SETUP.md proofs a/b/c). No real build runs until that verdict is GO. | Phase 3 plan (Wave 0 gate) | 2026-07-10 |
| AR-03-2 | T-03-04 | Anthropic-auth exception: the sandboxed engine authenticates via its OWN in-distro `claude login` (its own `~/.claude/`). In the common case NO credential crosses the boundary; the host key is never spread into the sandbox env by construction. | Phase 3 plan (RESEARCH §b) | 2026-07-10 |
| AR-03-3 | T-03-05 | If Wave 0 records A1 (plan-credit billing) as FALSE, a distinct sandbox-scoped `SANDBOX_ANTHROPIC_API_KEY` is injected into the sandbox env only — never the host key. Metered-billing exposure is bounded to that scoped credential. | Phase 3 plan (Wave 0 gate d) | 2026-07-10 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-10 | 27 | 27 | 0 | gsd-security-auditor (Claude) |

Notes: 27 register entries verified (26 T-03-NN threats + T-03-SC supply-chain). No `## Threat Flags` section present in any 03-*-SUMMARY.md — no unregistered new attack surface flagged by the executor. Deep code review (03-REVIEW.md) blockers CR-01 (abort paths route through `finalizeAborted`, no `done` beat/row) and CR-02 (host research turn stripped of WebFetch/WebSearch, explicit `disallowedTools` denylist) were verified present in `src/orchestrator/build-session.ts` and `src/orchestrator/sdk-runner.ts` respectively.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-10 (code mitigations complete; Wave 0 real-environment go/no-go remains an open operational gate per SANDBOX-SETUP.md before any real build executes)
