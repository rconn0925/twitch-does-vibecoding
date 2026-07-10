# Phase 3: Sandboxed Build Engine & Live Show - Context

**Gathered:** 2026-07-10 (auto mode — recommended defaults selected; the sandbox mechanism is deliberately LEFT OPEN for the mandatory research spike. Audit trail in 03-DISCUSSION-LOG.md)
**Status:** Ready for planning — BUT the sandbox spike (`/gsd:plan-phase --research-phase 3`) MUST run and resolve D3-01 before plans are written.

<domain>
## Phase Boundary

The winning queued task is researched, planned, and built by the agent pipeline inside an isolated sandbox, and viewers watch the whole process live. Deliverables:

1. **Build orchestrator** — drives the per-task agent pipeline: Sonnet research agents → Fable (session default) plan+build agents, via @anthropic-ai/claude-agent-sdk `query()` embedded in-process (per CLAUDE.md — NOT subprocess CLI). Emits status events queued/researching/planning/building/done/failed (BUILD-01, BUILD-02).
2. **Second compliance pass (COMP-02)** — the generated build PLAN (and output during execution) is re-screened through the Phase 1 gate before any code is written: an approved-but-vague suggestion must not yield non-compliant output. This is a NEW caller of the existing gate, not a new gate.
3. **The sandbox (SAND-01..04)** — chat-driven builds execute in an isolated sandbox (WSL2 or Docker — mechanism TBD by spike): no host FS access outside the workspace, no host app control, zero secret/credential/personal-data access; tokens live outside the sandbox. Chat-derived text reaches agents ONLY as data (prompt-injection defense at the orchestrator boundary).
4. **Live show surfaces (PRES-02..04)** — overlay shows the queue, current build status, and pipeline stage (researching → planning → building); viewers watch the app under construction via an auto-refreshing browser view of the sandboxed dev server.
5. **Failure & veto (BUILD-03/04)** — build failures and mid-build model refusals are narrated in chat/overlay with retry/skip (never silent dead air); the Phase 1 streamer veto cleanly aborts an in-flight agent session.

Not in this phase: paid influence / channel points / chaos mode (Phase 4); the full test-channel dry run (Phase 5). Multi-project management beyond the one-ongoing-project frame stays out (Phase 1 D-14).

Requirements: BUILD-01..04, COMP-02, SAND-01..04, PRES-02..04. Roadmap mode: **mvp** (vertical slice).

</domain>

<decisions>
## Implementation Decisions

### Sandbox mechanism — DEFERRED TO SPIKE (highest-priority open question)
- **D3-01 (OPEN — spike decides):** WSL2 vs Docker Desktop vs a Docker-in-WSL2 combination on the Windows 11 host is UNVALIDATED and is the phase's dominant technical risk. The research spike (`/gsd:plan-phase --research-phase 3`) MUST resolve, with a working proof-of-concept: (a) filesystem isolation (agent cannot escape its workspace to host files), (b) network posture (does the build need outbound net? default: deny-by-default, allowlist package registries only), (c) how the sandboxed dev server port is exposed to exactly one host-side browser/OBS source and nothing else (SAND-02), (d) how secrets are kept strictly outside (SAND-03) — the Agent SDK session and tokens run on the HOST orchestrator; only sanitized task data crosses into the sandbox, (e) startup/teardown latency acceptable for live pacing, and (f) native-module/toolchain availability for the kinds of apps chat will request. Recommendation to test first (not locked): WSL2 for filesystem+process isolation with a dedicated unprivileged user and a bind-mounted workspace, falling back to Docker if isolation or secret-leak guarantees are weaker than a container's. The spike output overrides this recommendation.

### Orchestration & model policy
- **D3-02:** In-process `@anthropic-ai/claude-agent-sdk` `query()` embedded in the orchestrator (per CLAUDE.md "What NOT to Use" — no `claude` CLI subprocess per turn), so the ToS filter, streamer veto, and structured progress streaming have in-process hook/abort granularity.
- **D3-03:** Model policy holds: **Sonnet** for research agents (investigating chat's idea); **Fable** (session default, via omitting model override) for planning and building. Set explicitly per agent, never hardcoded to a deprecated id.
- **D3-04:** **One build at a time** — `p-queue` concurrency 1 for the build agent (CLAUDE.md supporting-libs). The pipeline is strictly sequential per task; the winner from Phase 2 is the only active build.
- **D3-05:** The orchestrator boundary is the **prompt-injection trust boundary (SAND-04)**: chat-derived suggestion/plan text is passed to agents as clearly-delimited DATA (e.g., inside a structured field the system prompt treats as untrusted content), never concatenated into instructions. Mirrors Phase 1's classifier discipline (zero-interpolation system prompt); an orchestrator-boundary injection test suite is required (reuse Phase 1 adversarial fixtures where applicable).

### Second compliance pass (COMP-02)
- **D3-06:** After the plan agent produces a build plan, that plan text is re-screened through the SAME Phase 1 gate (`classify()`), before any code is written. A rejection aborts the build with narrated feedback; a held-for-review routes to the existing console review queue. This is a second CALL to the single funnel, not a parallel path — the single-funnel invariant must still hold.
- **D3-07:** During execution, a lightweight output re-screen guards against compliant-plan-but-non-compliant-output drift (D3-06 covers pre-write; this covers in-flight). Cadence/granularity is Claude's discretion informed by the spike (e.g., screen on file-write batches or on dev-server-visible output), balanced against live latency.

### Failure, refusal & veto
- **D3-08:** Model refusals mid-build are **first-class narrated events**, not errors — surfaced to chat/overlay like any pipeline stage transition (success criterion 1). The agent SDK's refusal/stop signals map to a `refused` status event.
- **D3-09:** Build failures degrade to a **narrated retry/skip decision surfaced on the console** (streamer picks) and announced in chat — never silent (BUILD-03). Auto-retry at most once on transient/tooling errors before asking; content/compliance failures never auto-retry.
- **D3-10:** Streamer veto (Phase 1 kill switch) **aborts the in-flight agent session cleanly** (BUILD-04): the Agent SDK `query()` is abortable in-process (AbortController), the sandbox process tree is killed via the existing tree-kill abort path, and HALTED freezes the pipeline. Decouple state transition from abort success, exactly as Phase 1 D-02.

### Live-show surfaces
- **D3-11:** Overlay gains **queue + build-status + pipeline-stage** panels (PRES-02, PRES-04) on the existing read-only overlay surface (Phase 2 pattern: full-state-on-connect + diffs, textContent-only, broadcast-safe). Pipeline stage renders as researching → planning → building progression.
- **D3-12:** The **app-under-construction view (PRES-03)** is a browser/OBS source pointed at the sandboxed dev server, auto-refreshing. It is a SEPARATE surface from both the operator console and the vote overlay; it exposes ONLY the dev server, nothing of the host or orchestrator (SAND-02). How the port crosses the sandbox boundary to exactly that one source is part of the D3-01 spike.

### Audit
- **D3-13:** Every pipeline stage transition, the COMP-02 re-screen decision, refusals, failures, retries, and vetoes are written to the existing append-only audit ledger with the task id, extending the Phase 1/2 audit vocabulary.

### Claude's Discretion
- COMP-02 in-flight re-screen cadence (D3-07), auto-retry classification of transient vs terminal errors, exact pipeline stage granularity, dev-server framework assumptions for the PRES-03 view, orchestrator ↔ sandbox IPC mechanism (informed by spike), SQLite schema for build/pipeline state, whether build workspace state persists across a stream session or resets (lean: reset per project per Phase 1/2 posture, but the one-ongoing-project frame may argue for persistence — resolve in planning).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Sandboxing & agent orchestration (drives the spike)
- `.planning/research/ARCHITECTURE.md` — component boundaries: sandbox as isolation layer, orchestrator as the agent driver, state machine never talks to Claude directly.
- `.planning/research/PITFALLS.md` — prompt injection via chat text, sandbox-as-afterthought, secret exposure.
- `CLAUDE.md` Agent Orchestration + "What NOT to Use" — in-process Agent SDK `query()` (NOT CLI subprocess), `p-queue` concurrency, model policy (Sonnet research / Fable build), ANTHROPIC_API_KEY must stay UNSET for plan-credit billing.
- `.planning/research/STACK.md` — Agent SDK version pin (`@anthropic-ai/claude-agent-sdk ^0.3.x`, pre-1.0 breaking changes), better-sqlite3, p-queue.

### Compliance (COMP-02 second pass)
- `.planning/research/COMPLIANCE.md` — the taxonomy the second pass re-applies; §on two-pass filter design.
- `.planning/phases/01-compliance-gate-kill-switch/01-CONTEXT.md` — D-08 decision vocabulary, D-11 fail-closed, the single-funnel invariant COMP-02 must route through.

### Phase 1/2 contracts this phase consumes
- `src/compliance/gate.ts` — `classify()` is the second-pass entry (COMP-02 re-screens the build plan here).
- `src/queue/task-queue.ts`, `src/pipeline/round.ts` — the queued task this phase consumes as build input.
- `src/state-machine/stream-mode.ts`, `src/state-machine/halt.ts`, `src/kill-switch/abort.ts` — BUILD_IN_PROGRESS state + veto/abort path (BUILD-04, D3-10).
- `src/overlay/server.ts` + `src/overlay/public/` — read-only overlay to extend with build panels (PRES-02/04).
- `src/audit/record.ts`, `src/audit/schema.sql` — append-only ledger to extend (D3-13).
- `.planning/phases/02-chat-vote-loop/02-SECURITY.md` — T-02-18 (chat-as-instructions) was ACCEPTED in Phase 2 as Phase 3 scope — this phase must close it (SAND-04/D3-05).

### Requirements & frame
- `.planning/REQUIREMENTS.md` — BUILD-01..04, COMP-02, SAND-01..04, PRES-02..04 verbatim.
- `.planning/PROJECT.md` — hard compliance requirement, model policy, live-reliability constraint, sandbox-containment out-of-scope fence (no secrets/destructive host access).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `classify()` (src/compliance/gate.ts): the COMP-02 second pass calls this on the build plan — no new gate needed.
- Kill-switch abort (src/kill-switch/abort.ts, tree-kill) + HALTED transition (src/state-machine/halt.ts): BUILD-04 veto aborts the agent session and sandbox process tree through this existing path.
- Overlay server + full-state-on-connect/diff pattern (src/overlay/): build-status/queue/pipeline-stage panels extend this read-only surface.
- Audit ledger (src/audit/): stage-transition events follow established record patterns.
- p-queue (already a dependency from Phase 2's chat sender): reuse for build concurrency=1.
- Injected-dependency + zod-at-boundary conventions throughout: the orchestrator and sandbox adapter should be injected for testability (fake sandbox + fake Agent SDK in vitest, no real containers/network in unit tests).

### Established Patterns
- Fail-closed everywhere; zero-interpolation system prompts (Phase 1 classifier) → the orchestrator's agent prompts treat chat text as delimited data (D3-05).
- Separate surfaces per audience (operator console vs vote overlay vs — now — app-under-construction view); loopback Host allowlist (src/shared/loopback.ts) applies to any new HTTP/ws surface.
- textContent-only rendering + dom-safety invariant scan extends to any new overlay/public assets.

### Integration Points
- src/main.ts composition root: the build orchestrator joins the lifecycle and must die cleanly on halt/shutdown.
- The Phase 2 winner→queue funnel feeds the build orchestrator's input; BUILD_IN_PROGRESS is entered when a build starts.

</code_context>

<specifics>
## Specific Ideas

- "The AI process is part of the show" (PRES-04) — the pipeline stage display is a feature, not debug output; researching → planning → building should read as narrative beats.
- Never silent dead air (BUILD-03) is a live-reliability doctrine, same weight as Phase 2's rate-budget law.
- Secrets never cross into the sandbox (SAND-03) is non-negotiable — the Agent SDK session, Twitch tokens, and .env live on the host orchestrator only.

</specifics>

<deferred>
## Deferred Ideas

- Multiple concurrent builds / build parallelism — one-at-a-time is locked (D3-04); revisit only if the format demands it.
- Persistent multi-session project state across stream nights — flagged for planning-time resolution (D3 discretion), not decided here.
- Paid influence over builds, chaos-mode random build pick — Phase 4.
- Full test-channel dry run of the end-to-end loop — Phase 5.
- Change-project consensus vote (carried unresolved from Phase 1 D-15 / Phase 2) — still a roadmap-conflict item for the user; not this phase.

</deferred>

---

*Phase: 03-sandboxed-build-engine-live-show*
*Context gathered: 2026-07-10*
