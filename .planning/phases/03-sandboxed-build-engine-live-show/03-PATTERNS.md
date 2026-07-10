# Phase 3: Sandboxed Build Engine & Live Show - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 22 (new) + 6 (modified)
**Analogs found:** 22 / 22 (every new file has at least a role-match analog; no "no analog" files this phase)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/orchestrator/build-session.ts` | orchestrator/service (per-task lifecycle driver) | event-driven + request-response (COMP-02 blocking calls) | `src/state-machine/round.ts` (RoundManager: owns a lifecycle, calls `classify()`/`enqueueWinner`, emits events) + `src/pipeline/round.ts` (direct `classify()` call pattern) | role-match (closest lifecycle-owner analog in the repo; no prior agent-driving code exists) |
| `src/orchestrator/sandbox-process.ts` | service/adapter (spawns + tears down an external process) | process-lifecycle / event-driven | `src/kill-switch/abort.ts` (`AbortRegistry`, `killTree`, PID-based teardown) + `src/kill-switch/hotkey.ts` (injected external-process source, guarded native import in main.ts) | role-match (process-adapter + injected-source shape) |
| `src/orchestrator/progress-events.ts` | transform/translation layer | event-driven (SDK message stream → small vocabulary) | `src/overlay/server.ts`'s `PILL_BY_MODE` translation table + `buildOverlayState()` | role-match (exact "small stable public vocabulary" precedent) |
| `src/orchestrator/prompt-boundary.ts` | utility (prompt construction, zero-interpolation) | transform | `src/compliance/classifier.ts`'s fixed `SYSTEM_PROMPT` + `candidate.text` passed only as `content`, never interpolated | exact (same zero-interpolation discipline, same "untrusted text as data" shape) |
| `src/orchestrator/comp02.ts` (COMP-02 second-pass caller — file name Claude's discretion) | orchestrator internal / compliance caller | request-response (blocking classify) | `src/pipeline/round.ts`'s `enqueueWinner` (direct `classify(gateDeps, candidate)` call, NOT `submitCandidate`) | exact (RESEARCH.md Pattern 1 names this precedent explicitly) |
| `src/sandbox/wsl-adapter.ts` (or folded into `sandbox-process.ts`) | adapter (WSL2 process spawn/env-allowlist/teardown) | process-lifecycle | `src/kill-switch/abort.ts` (`killTree`/`AbortRegistry`) + `src/ingestion/twitch-auth.ts`-style guarded external-tool wiring | role-match (no existing WSL/container adapter; closest is the process-teardown module) |
| `src/preview/preview-manager.ts` | service (tracks dev-server reachability/port) | request-response (poll) | `src/overlay/server.ts` (`OverlayModeSource`/`OverlayRoundSource` structural-seam pattern; injected polling source) | role-match |
| `src/preview/server.ts` | HTTP server (read-only, separate surface) | request-response | `src/overlay/server.ts` (physically separate localhost surface, loopback allowlist, zero mutation routes, `express.static` only) | exact (near-identical posture: read-only, no ws state push needed here since it holds no orchestrator connection per D3-12) |
| `src/preview/public/preview.html` / `preview.css` / `preview.js` | static asset / component | request-response (polling reachability + iframe reload) | `src/overlay/public/index.html`/`overlay.css`/`overlay.js` (hand-rolled reconnect-with-backoff, `el()` textContent helper, pill-state rendering) | role-match (same vanilla-JS-no-framework posture; NEW because this surface has zero ws connection, unlike overlay.js) |
| `src/overlay/server.ts` (MODIFIED — add build-status panel to `OverlayState`) | server (extend existing) | event-driven (push) | itself (Phase 2 baseline) — extend `OverlayState`, `PILL_BY_MODE` stays unchanged (no new pill words per UI-SPEC), add `buildStatus: BuildStatusView \| null` | exact (same file, additive) |
| `src/overlay/public/overlay.js` (MODIFIED — render build panel) | component (extend existing) | event-driven (render on push) | itself — `renderVotePanel()`/`candidateRow()` pattern (reuses the vote panel's slot; `el()` helper; `truncate()` to 80 chars; textContent-only) | exact |
| `src/overlay/public/overlay.css` (MODIFIED) | style | — | itself | exact |
| `src/operator-console/server.ts` (MODIFIED — retry/skip + veto-abort routes) | server (extend existing) | request-response (POST routes) | itself — `app.post("/api/tasks/:id/veto", ...)` and `app.post("/api/halt", ...)` (zod-validated body, CSRF middleware already covers all POSTs, `pushState()` after mutation) | exact |
| `src/operator-console/public/console.js` (MODIFIED — build panel, retry/skip buttons, veto-abort confirmation) | component (extend existing) | request-response | itself — `renderQueue()`/`vetoTask()`/`postJson()`/`button()` helpers, `showReasonRow()` pattern | exact |
| `src/operator-console/public/console.css` (MODIFIED) | style | — | itself | exact |
| `src/audit/record.ts` (MODIFIED — new `record*` functions for pipeline stage/COMP-02/refusal/retry/veto-of-build) | data-access (append-only insert helpers) | CRUD (insert-only) | itself — `recordVeto`/`recordGateDecision`/`recordRoundOpened` (same `insert()` helper, same arg-object shape) | exact |
| `src/audit/schema.sql` (MODIFIED — extend `event_type`/`source` comment vocabulary, NO new columns needed per schema's own no-CHECK-constraint design) | schema | — | itself | exact |
| `src/main.ts` (MODIFIED — compose orchestrator, wire `spawnClaudeCodeProcess`, register sandbox teardown into `AbortRegistry`, wire preview server) | composition root | event-driven (wiring) | itself — the existing `createApp()` composition (chat pipeline wiring block, `abortActiveWork` wiring, `startOverlayServer`/`startConsoleServer` calls) | exact |
| `src/queue/task-queue.ts` (READ-ONLY consumer — orchestrator dequeues) | model (existing) | CRUD | itself — no changes expected; orchestrator calls `taskQueue.list()`/`remove()`, never a new `.enqueue()` call site (COMP-01 invariant (b): `.enqueue(` only from `src/pipeline/`) | exact (must NOT be modified to add enqueue calls elsewhere) |
| `tests/invariants/secrets-isolation.test.ts` (NEW invariant) | test (source scan) | — | `tests/invariants/single-funnel.test.ts` + `tests/invariants/chat-sender.test.ts` (comment-stripped source scan via `scan-helpers.ts`) | exact |
| `tests/invariants/prompt-injection-boundary.test.ts` (NEW invariant, or folded into `src/orchestrator/prompt-boundary.test.ts`) | test | — | `src/compliance/classifier.contract.test.ts` + `src/compliance/fixtures/adversarial.fixtures.ts` (reuse Phase 1 adversarial fixtures per D3-05) | exact |
| `src/orchestrator/*.test.ts` (unit tests for build-session, sandbox-process, progress-events) | test | — | `src/pipeline/round.test.ts` + `src/kill-switch/abort.test.ts` (injected-fake pattern, no real network/process in unit tests) | exact |
| `tests/e2e/build-flow.e2e.test.ts` (NEW) | test (e2e) | — | `tests/e2e/round-flow.e2e.test.ts` + `tests/e2e/kill-switch.e2e.test.ts` | exact |

## Pattern Assignments

### `src/orchestrator/build-session.ts` (orchestrator, event-driven + blocking compliance gate)

**Analogs:** `src/state-machine/round.ts` (RoundManager — lifecycle owner) and `src/pipeline/round.ts` (`enqueueWinner` — direct `classify()` call)

**Dependency-injection shape** (mirrors `RoundManager`'s constructor-injected `db`/`machine`/`pool`/`logger` and `enqueueWinner` callback — read directly, not excerpted at length since it's a full-file constructor pattern):
```typescript
// Source: src/pipeline/round.ts:35-45 (EnqueueWinnerDeps) — the shape to mirror
// for BuildSessionDeps: everything the orchestrator touches is injected so
// vitest never constructs a real query()/WSL2/SQLite.
export interface EnqueueWinnerDeps {
  taskQueue: TaskQueue;
  db: Database.Database;
  mode: () => StreamMode;
  resubmit: (candidate: SuggestionCandidate) => SubmitResult;
  staleAfterMs?: number;
  logger?: Logger;
}
```

**COMP-02 direct-classify pattern** (Source: `src/pipeline/round.ts:57-96`, `src/compliance/gate.ts:64-122` — this is THE precedent RESEARCH.md Pattern 1 names explicitly):
```typescript
// classify() is the ONLY route to a gate decision (COMP-01 single funnel).
// COMP-02 re-uses it directly on the build agent's OWN generated plan text —
// NOT submitCandidate() (wrong schema: CandidateSource has no "orchestrator"
// value yet per RESEARCH.md Open Question 2 — add one), NOT a parallel gate.
const planCandidate: SuggestionCandidate = {
  id: `${task.id}-plan`,
  source: "orchestrator", // NEW CandidateSource value — extend shared/types.ts
  kind: "suggestion",
  twitchUsername: null,
  text: planText, // the build agent's OWN plan — never raw chat text
  submittedAtMs: Date.now(),
};
const result = await classify(gateDeps, planCandidate);
if (result.decision === "rejected") {
  // narrate + abort (BUILD-03 narrated-failure pattern); audit row already
  // written by classify() itself (gate.ts's audit() call).
} else if (result.decision === "held-for-review") {
  // routes through the SAME review_queue D-08 flow the console already renders.
}
// only "approved" proceeds to the sandboxed build query()
```

**Fail-closed / never-throw discipline to mirror** (Source: `src/compliance/classifier.ts:87-188`, `src/compliance/gate.ts:64-122`): every classifier/gate call in the codebase RESOLVES to a rejected/fail-closed result rather than throwing; the orchestrator's own agent-call wrappers should follow the same discipline — a `query()` failure or refusal must resolve to a `refused`/`failed` status event, never an uncaught rejection that kills the build-session loop.

**State-machine integration** (Source: `src/state-machine/stream-mode.ts:102-106`, `src/main.ts:206-232`): `machine.setActiveTask(taskId, pid)` already exists as plumbing for exactly this phase ("Phase 1: plumbing for plans 01-03/01-05" comment) — call it when a build starts/ends. `BUILD_IN_PROGRESS` transition already exists in `TRANSITIONS` (`VOTING_ROUND`/`FREE_REIGN_WINDOW`/`CHAOS_MODE` → `BUILD_IN_PROGRESS` → `IDLE`); the orchestrator calls `machine.transition("BUILD_IN_PROGRESS")` when it picks up a queued task and `machine.transition("IDLE")` on done/failed/skip.

### `src/orchestrator/sandbox-process.ts` + `src/sandbox/` WSL2 adapter (process adapter)

**Analog:** `src/kill-switch/abort.ts` (`AbortRegistry`, `killTree`) — RESEARCH.md §(g) gives the EXACT extension to make:

**Registry extension** (Source: `src/kill-switch/abort.ts:16-19`, extend per RESEARCH.md's own code block at lines 189-214 of 03-RESEARCH.md):
```typescript
// src/kill-switch/abort.ts — EXTEND RegistryEntry, do not replace the shape.
interface RegistryEntry {
  pid?: number;
  controller?: AbortController;
  // NEW (Phase 3): reliable, total sandbox teardown — tree-kill on a wsl.exe
  // wrapper PID does not reliably reach the Linux process tree inside WSL2
  // (microsoft/WSL#12159, nodejs/node#18431).
  sandboxTeardown?: () => Promise<void>;
}
```
Add `registerSandboxTeardown(taskId, fn)` alongside the existing `registerProcess`/`registerController`, and extend `abortActiveWork()`'s `Promise.allSettled` fan-out (currently only cooperative-abort + tree-kill, `src/kill-switch/abort.ts:64-101`) with a third step that calls every registered `sandboxTeardown`. This preserves the exact fire-and-forget, never-awaited-by-`triggerHalt` discipline already documented in `src/state-machine/halt.ts:47-57`.

**Injected external-process source pattern** (Source: `src/kill-switch/hotkey.ts:53-59`, `src/ingestion/twitch-chat.ts:42-52`): the WSL2 spawn/terminate calls should be behind a structural interface (mirrors `KeyEventSource`/`ChatEventSource`) so unit tests inject a fake and never shell out to `wsl.exe`. Guarded native/external-tool loading happens ONLY in `src/main.ts`'s entrypoint branch (mirror `armPanicHotkey`'s `loadUiohook` injection at `src/main.ts:513-546` and `buildTwitchAdapters`'s dynamic-import-in-try/catch at `src/main.ts:563-658`) — a missing/broken WSL2 install must degrade to a loud log, never crash the whole process (same "console + overlay keep running" graceful-degradation doctrine).

**Env-allowlist discipline** (Source: RESEARCH.md §(b), no direct codebase precedent since this is the first process-env boundary in the repo — pattern it against the classifier's own boundary-isolation discipline in `src/compliance/classifier.ts:34-40`, `classifierDepsFromEnv`, which explicitly reads exactly one env var and nothing else): `spawnClaudeCodeProcess`'s `env` must be an explicit allowlist (e.g. `{ PATH: "/usr/bin:/bin" }`), never `...process.env` spread — this is the SAND-03 secrets boundary and should get its own unit test asserting no `TWITCH_*`/`ANTHROPIC_API_KEY` key ever appears in the constructed env object.

### `src/orchestrator/progress-events.ts` (translation layer)

**Analog:** `src/overlay/server.ts`'s `PILL_BY_MODE` (Source: `src/overlay/server.ts:30, 84-91`):
```typescript
/** Public pill vocabulary — the ONLY state words that ever reach the stream (D2-18). */
export type OverlayPill = "STANDBY" | "VOTING OPEN" | "BUILDING" | "ON HOLD";

const PILL_BY_MODE: Record<StreamMode, OverlayPill> = {
  IDLE: "STANDBY",
  VOTING_ROUND: "VOTING OPEN",
  BUILD_IN_PROGRESS: "BUILDING",
  FREE_REIGN_WINDOW: "STANDBY",
  CHAOS_MODE: "STANDBY",
  HALTED: "ON HOLD",
};
```
Mirror this EXACTLY for the pipeline-stage vocabulary: a fixed `Record<SDKInternalEventType, PipelineStage>` translation table where `PipelineStage = "queued" | "researching" | "planning" | "building" | "done" | "failed" | "refused"` (per 03-CONTEXT.md/03-UI-SPEC.md's locked vocabulary) is the ONLY thing that crosses into `OverlayState`/`ConsoleState`/chat narration — raw SDK message types never leak past this file, exactly as raw `StreamMode` internal words never leak past `PILL_BY_MODE`.

### `src/orchestrator/prompt-boundary.ts` (zero-interpolation prompt construction, SAND-04/D3-05)

**Analog:** `src/compliance/classifier.ts` (Source: lines 50-79, 106-124) — the EXACT precedent for "fixed system prompt, zero interpolation of untrusted fields":
```typescript
/** Fixed system prompt — zero interpolation of candidate fields (T-01-06). */
const SYSTEM_PROMPT = `You are a compliance classifier for a Twitch livestream. ...`;
// ...
const request = {
  model,
  max_tokens: 512,
  system: SYSTEM_PROMPT,        // ← fixed string, never templated
  messages: [{ role: "user", content: candidate.text }], // ← untrusted text ONLY here
  // ...
} satisfies Anthropic.MessageCreateParamsNonStreaming;
```
Apply the identical shape to every `query()` call: the `AgentDefinition.prompt` (system prompt) is 100% orchestrator-authored, task text only ever enters via the per-turn `prompt` argument, delimited (`<task_description source="chat">...</task_description>`) — never via string-concatenation into the system prompt. RESEARCH.md's own Code Examples section (lines 384-409) gives the exact `query()` call shape to copy.

**Adversarial-fixture reuse** (Source: `src/compliance/fixtures/adversarial.fixtures.ts`, `src/compliance/classifier.contract.test.ts`): D3-05 requires reusing Phase 1's adversarial fixtures for the new orchestrator-boundary injection test suite — read `adversarial.fixtures.ts`'s fixture shape before writing `prompt-boundary.test.ts` so the same fixture format is reused, not reinvented.

### `src/preview/server.ts` (new read-only surface, PRES-03/D3-12)

**Analog:** `src/overlay/server.ts` (Source: lines 1-29, 94-135, 195-223) — near-identical posture, EVEN STRONGER isolation (D3-12 requires it hold zero orchestrator connection):
```typescript
// Loopback-only bind, DNS-rebinding defense FIRST middleware — copy verbatim:
app.use((req, res, next) => {
  if (!isLoopbackHostHeader(req.get("host"))) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  next();
});
const publicDir = fileURLToPath(new URL("./public", import.meta.url));
app.use(express.static(publicDir));
// ...
server.listen(deps.port, "127.0.0.1", () => { /* ... */ });
```
**Key deviation from the overlay analog:** the preview server does NOT need a `WebSocketServer`/`pushState()` at all — D3-12 says it "holds zero orchestrator connection and renders zero chat-derived text." Its only dynamic behavior is a lightweight `GET /api/reachable` (or client-side poll of the dev-server port directly) — simpler than the overlay, not a ws-push surface. Still import `isLoopbackHostHeader` from `src/shared/loopback.ts` (shared by both existing surfaces per that file's own doc comment — "shared by src/operator-console/server.ts and src/overlay/server.ts... so the two surfaces can never drift apart" — Phase 3 makes it three surfaces).

### `src/preview/public/*` (preview.html/css/js)

**Analog:** `src/overlay/public/overlay.js` (Source: lines 1-11, 28-35, 219-247) — the `el()` textContent helper and the hand-rolled ws-reconnect-with-backoff shape, MINUS the ws entirely (per D3-12, replace with a `fetch`/`Image`-based reachability poll or iframe `load`/`error` events):
```javascript
// el() helper — copy verbatim (textContent-only construction, DOM-safety invariant):
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
```
The dom-safety invariant scan (`tests/invariants/dom-safety.test.ts`) auto-discovers ANY `src/**/public/*.js` file (Source: `tests/invariants/dom-safety.test.ts:25-30`, `collectFiles`/regex `/^src\/.+\/public\/.+\.js$/`) — `src/preview/public/preview.js` is covered automatically with zero test-file changes needed, but MUST avoid `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval(` exactly like the two existing surfaces.

### `src/overlay/server.ts` + `overlay.js`/`overlay.css` (MODIFIED — build-status panel, PRES-02/04)

**Analog:** itself (Phase 2 baseline) — additive only, same file:
```typescript
// Source: src/overlay/server.ts:34-39 — extend OverlayState, do not replace:
export interface OverlayState {
  pill: OverlayPill;
  round: RoundSnapshot | null;
  nextUp: string[];
  // NEW (Phase 3): null when no build is active/mounting.
  // buildStatus: BuildStatusView | null;
}
```
`PILL_BY_MODE` stays UNCHANGED (UI-SPEC: "This phase adds no new pill words — the pill stays BUILDING for the entire research→plan→build pipeline"). The push-cadence discipline (`src/overlay/server.ts:18-27`, lifecycle events push immediately, high-frequency events debounce) extends directly: pipeline-stage transitions are low-frequency (a handful per build per RESEARCH.md/UI-SPEC), so they push immediately like `ROUND_OPENED`/`ROUND_CLOSED`, NOT through the 300ms tally debounce.

`overlay.js`'s `candidateRow()`/`renderVotePanel()`/`startWinnerBeat()` pattern (Source: lines 115-192) is the direct template for the new stepper renderer: same `el()` construction, same `truncate(text, 80)` JS-truncation + CSS ellipsis backstop, same "done beat holds N seconds via `setTimeout`, then collapses" shape (`WINNER_BEAT_MS = 8000` → reuse for the UI-SPEC's build "BUILT IT" 8-second beat).

### `src/operator-console/server.ts` + `console.js` (MODIFIED — retry/skip + veto-abort routes)

**Analog:** itself — `app.post("/api/tasks/:id/veto", ...)` (Source: lines 513-546) is the template for the new retry/skip routes:
```typescript
// Source: src/operator-console/server.ts:513-546 — copy this shape for
// POST /api/tasks/:id/retry and POST /api/tasks/:id/skip:
app.post("/api/tasks/:id/veto", (req, res) => {
  const params = TaskIdParamsSchema.safeParse(req.params);
  const body = ResolveBodySchema.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "invalid veto request" });
    return;
  }
  // ... mutate, audit, pushState(), respond
});
```
CSRF/DNS-rebinding middleware (Source: lines 151-208) already covers ALL POST routes uniformly (Origin/Host agreement + `application/json` Content-Type check) — new build-control routes get this defense automatically, zero new middleware needed. `console.js`'s `vetoTask()`/`showReasonRow()`/`postJson()` (Source: lines 331-334, 82-102, 65-78) is the direct template for `retryBuild()`/`skipTask()`.

### `src/audit/record.ts` (MODIFIED — new record functions, D3-13)

**Analog:** itself — every existing `record*` function shares one shape (Source: lines 54-125): build the args object → call the shared `insert()` helper → same 10-column row. New functions (`recordPipelineStage`, `recordComp02Decision`, `recordBuildRefusal`, `recordBuildRetry`, `recordSandboxTeardown` or similar) follow `recordGateDecision`'s exact shape (it already carries `category`/`rationale`/`taskId`-shaped fields that fit pipeline events with zero schema changes):
```typescript
// Source: src/audit/record.ts:102-125 — template for new Phase 3 record fns.
export function recordGateDecision(
  db: Database.Database,
  args: { candidate: SuggestionCandidate; decision: GateDecision; category: GateCategory | null;
           rationale: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(), eventType: "gate_decision", source: args.candidate.source,
    twitchUsername: args.candidate.twitchUsername, suggestionText: args.candidate.text,
    decision: args.decision, category: args.category, rationale: args.rationale,
    streamMode: args.streamMode, taskId: null,
  });
}
```
**No schema.sql column changes needed** — `audit_log.source`/`event_type`/`category` have NO CHECK constraints (confirmed in `src/audit/schema.sql:8-20`'s own comments), so Phase 3's new `event_type` values (e.g. `pipeline_stage`, `comp02_decision`, `build_refused`, `build_retry`, `build_skip`) and the new `source: "orchestrator"` value are schema-safe additions — only the SQL file's descriptive comment (line 11-12) needs updating to document the extended vocabulary, matching RESEARCH.md Assumption A4's own conclusion.

### `src/main.ts` (MODIFIED — compose orchestrator, register sandbox teardown)

**Analog:** itself — the existing composition pattern for injected-dep wiring at boot (Source: lines 133-486, especially the `abortActiveWork` wiring at 432-435 and `AbortRegistry` construction at 141):
```typescript
// Source: src/main.ts:141, 432-435 — the registry already exists; the
// orchestrator registers into it exactly like this:
const registry = new AbortRegistry();
// ...
abortActiveWork: (frozen) => abortActiveWork(registry, frozen, logger),
```
The orchestrator's `createBuildSession`/`startOrchestrator` call should be composed inside `createApp()` (not the entrypoint-only `isMain` branch) so the e2e suite gets it with injected fakes, matching how `round`/`taskQueue`/`overlay` are all composed inside `createApp()` today. `AppHandle` (Source: lines 94-109) should be extended with an `orchestrator` handle whose `close()` participates in the existing `close: async () => { ... }` teardown chain (line 473-484) in the same "cancel timers/handles before `db.close()`" order.

## Shared Patterns

### Injected-dependency + structural-interface seam (applies to ALL new orchestrator/sandbox/preview files)
**Source:** `src/kill-switch/hotkey.ts:53-59` (`KeyEventSource`), `src/ingestion/twitch-chat.ts:42-52` (`ChatEventSource`), `src/overlay/server.ts:46-58` (`OverlayModeSource`/`OverlayRoundSource`/`OverlayQueueSource`)
**Apply to:** `src/orchestrator/sandbox-process.ts` (a `SandboxAdapter` interface satisfied by a real `wsl.exe`-shelling implementation, faked in tests), `src/orchestrator/build-session.ts` (an `AgentRunner`/`QueryFn` interface wrapping `@anthropic-ai/claude-agent-sdk`'s `query()`), `src/preview/preview-manager.ts` (a `DevServerProbe` interface). Every real, native/network-touching implementation is constructed ONLY in `src/main.ts`'s entrypoint branch or a guarded dynamic import, mirroring `buildTwitchAdapters`/`armPanicHotkey`'s exact shape (dynamic `import()` inside try/catch, degrade-to-loud-log on failure, never crash the process).
```typescript
// Source: src/main.ts:513-546 (armPanicHotkey) — the guarded-native-import
// template for the orchestrator's real SDK/WSL2 wiring in main.ts:
try {
  const { uIOhook, UiohookKey } = await load();
  // ... construct real adapter, wire into createApp-composed logic
} catch (err) {
  args.logger.error({ err }, "PANIC HOTKEY UNAVAILABLE — console Halt button is the only kill path");
  return null; // degrade gracefully — the rest of the app keeps running
}
```

### Fail-closed / never-throw discipline
**Source:** `src/compliance/classifier.ts:87-188` (`classifyWithSonnet`, structurally never throws), `src/compliance/gate.ts:64-122` (`classify`, catches classifier errors, resolves `FAIL_CLOSED`), `src/ingestion/chat-sender.ts:62-77` (`send()`, catches sink errors, logs and drops, never throws into the caller)
**Apply to:** every orchestrator boundary that calls `query()`, the sandbox adapter's spawn/terminate calls, and COMP-02's re-screen — a refusal, a WSL2 spawn failure, or a classifier error must resolve to a narrated `failed`/`refused` status event, never an uncaught rejection that could kill the orchestrator's event loop or leave `BUILD_IN_PROGRESS` stuck with no exit path.

### Append-only audit write on every decision path
**Source:** `src/audit/record.ts` (every `record*` fn) + `src/compliance/gate.ts:140-150` (`audit()` called unconditionally before `classify()` returns)
**Apply to:** every pipeline-stage transition, COMP-02 decision, refusal, retry, skip, and veto-abort (D3-13) — one row per event, never batched, following the exact "audit before return" ordering `classify()` already uses.

### DNS-rebinding + loopback-only bind (CR-02)
**Source:** `src/shared/loopback.ts` (whole file) + its use in `src/overlay/server.ts:104-114` and `src/operator-console/server.ts:151-164`
**Apply to:** `src/preview/server.ts` — the THIRD surface to import `isLoopbackHostHeader`; bind to `"127.0.0.1"` explicitly (never `"0.0.0.0"`), first-middleware Host-header check, same as the other two.

### DOM-safety textContent-only + the `el()` helper
**Source:** `src/overlay/public/overlay.js:28-35`, `src/operator-console/public/console.js:42-56`, enforced by `tests/invariants/dom-safety.test.ts` (auto-discovers `src/**/public/*.js`)
**Apply to:** `src/preview/public/preview.js` and any new build-panel rendering code added to `overlay.js`/`console.js` — no `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval(` anywhere; the existing scan covers new files with zero test changes, but a new file under a public/ dir should be spot-checked against the pattern before commit.

### The single-funnel COMP-01 invariant, and its EXTENSION points for Phase 3
**Source:** `tests/invariants/single-funnel.test.ts` (whole file, esp. checks (b)/(c)/(d))
**Apply to (read carefully before writing orchestrator code):**
- Check (b): `.enqueue(` may ONLY appear in `src/pipeline/`. The orchestrator DEQUEUES (`taskQueue.list()`/`taskQueue.remove()`), it must never gain its own `.enqueue()` call site.
- Check (c): only `src/compliance/` may import the literal string `"@anthropic-ai/sdk"`. The NEW `"@anthropic-ai/claude-agent-sdk"` package is a DIFFERENT string and does not trip this regex — confirmed by reading the regex source (`/["']@anthropic-ai\/sdk["']/`) — but if a future refactor ever imports the classifier's SDK from the orchestrator, that WOULD trip it. Keep `query()` usage confined to `src/orchestrator/`.
- Check (d): `toQueuedTask` may be referenced only in `gate.ts`, `pipeline/submit.ts`, `pipeline/round.ts`. The orchestrator must NEVER call `toQueuedTask` directly — it consumes already-queued `QueuedTask`s from `TaskQueue`, it does not mint new ones.
- **New scan needed this phase (secrets-isolation invariant, flagged in the orchestrator context):** extend `tests/invariants/` with a scan asserting `src/orchestrator/sandbox-process.ts` (or wherever `spawnClaudeCodeProcess`'s `env` is built) never spreads `process.env` wholesale and never references `TWITCH_CLIENT_SECRET`/`ANTHROPIC_API_KEY`/`.env`-sourced identifiers directly in the constructed sandbox `env` object — pattern it after `chat-sender.test.ts`'s "sole caller" scan shape (`allMatches(files, /\.\.\.process\.env/)` restricted to the sandbox-adapter file, or an allowlist-diff assertion).

## No Analog Found

None — every file this phase extends an existing surface (overlay/console/audit/main) or has a role-match precedent (RoundManager for lifecycle, AbortRegistry for process teardown, hotkey.ts/twitch-chat.ts for injected external sources, classifier.ts for zero-interpolation prompts). The one genuinely novel piece — the WSL2/container adapter itself — has no direct in-repo precedent (this is the repo's first process-sandboxing code), but RESEARCH.md's own verified `sdk.d.ts` code examples (§Code Examples, §Sandbox Recommendation) substitute as the authoritative reference for that specific piece; the planner should treat RESEARCH.md's `spawnClaudeCodeProcess`/`wsl --terminate` code blocks as the primary source for that file, with `abort.ts` as the secondary structural analog for its teardown-registration shape.

## Metadata

**Analog search scope:** `src/` (all subdirectories), `tests/invariants/`, `tests/e2e/`
**Files scanned:** 62 non-test `.ts`/`.js` source files + 6 invariant/e2e test files read directly
**Pattern extraction date:** 2026-07-10
