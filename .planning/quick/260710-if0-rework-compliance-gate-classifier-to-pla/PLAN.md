---
type: quick
slug: rework-compliance-gate-classifier-to-plan-billing
autonomous: true
files_modified:
  - src/orchestrator/prompt-boundary.ts
  - src/orchestrator/classifier-runner.ts
  - src/orchestrator/classifier-runner.test.ts
  - src/compliance/classifier.ts
  - src/compliance/classifier.test.ts
  - src/compliance/classifier.contract.test.ts
  - src/compliance/gate.ts
  - src/compliance/gate.test.ts
  - src/main.ts
  - scripts/gate-eval.ts
  - tests/invariants/single-funnel.test.ts
  - .env.example
  - README.md
  - docs/OPERATIONS.md
  - .planning/STATE.md
must_haves:
  truths:
    - "The live compliance gate classifies via the Claude Agent SDK query() (plan/subscription billing via `claude login`), never the raw @anthropic-ai/sdk Messages API."
    - "No file under src/compliance/ imports @anthropic-ai/sdk; the plan-billed query() call lives only under src/orchestrator/ (SAND-04)."
    - "When plan credentials / claude login are unavailable, the gate fails CLOSED (auto-rejects every submission) and logs loudly — never fail-open."
    - "The classifier model stays Sonnet (GATE_MODEL, default claude-sonnet-5) — a deliberate documented exception to the Fable policy."
    - "Both machine invariants (SAND-04 prompt-injection-boundary, COMP-01 single-funnel (c)) pass non-vacuously with intact synthetic-offender self-tests."
  artifacts:
    - path: "src/orchestrator/classifier-runner.ts"
      provides: "Plan-billed, tools-disabled, single-turn Sonnet classification transport (candidate text → raw model text)"
    - path: "src/orchestrator/classifier-runner.test.ts"
      provides: "Guard test: no-tools, single-turn, Sonnet-pinned, zero system-prompt interpolation"
  key_links:
    - from: "src/main.ts"
      to: "src/orchestrator/classifier-runner.ts"
      via: "guarded dynamic import (buildClassifierTransport)"
    - from: "src/compliance/gate.ts"
      to: "injected ClassifierTransport"
      via: "classifyWithSonnet(deps.classifier, candidate)"
---

<objective>
Rework the compliance-gate classifier so it bills against the Claude plan/subscription
(Claude Agent SDK `query()` via `claude login`) instead of the metered raw Anthropic
Messages API (`ANTHROPIC_API_KEY`). The user is off API keys entirely.

Only the billing/transport changes. The model stays Sonnet, every safety property is
preserved (fail-closed sentinel, retry+backoff, zod shape/refined re-validation, D-12
coercion, T-01-06 prompt boundary), and BOTH machine-enforced invariants
(SAND-04 + single-funnel (c)) stay green and non-vacuous.

Purpose: The streaming machine must run with `ANTHROPIC_API_KEY` UNSET (CLAUDE.md
"What NOT to Use") so the gate draws on plan credits, not metered per-token billing.
Output: A new orchestrator transport module, a compliance layer that imports NO
Anthropic SDK, rewired boot + eval script, updated invariants, and corrected docs.
</objective>

<locked_decisions>
D-1 (LOCKED): Model stays Sonnet (`claude-sonnet-5` / `GATE_MODEL`). Only billing/transport
change. Document this as a deliberate exception to CLAUDE.md's "non-research work runs on
Fable" policy — the safety gate stays on Sonnet for screening quality.

D-2 (LOCKED): Fail closed, NO key path. Remove the raw `@anthropic-ai/sdk` Messages API from
the compliance gate entirely. If `claude login` / plan credentials are unavailable at boot,
the gate fails closed (auto-reject every submission) and logs loudly — identical safe
behavior to today's no-key case. No `ANTHROPIC_API_KEY` fallback anywhere.

HARD INVARIANTS (both must keep passing non-vacuously):
- SAND-04 (`tests/invariants/prompt-injection-boundary.test.ts:116` `ALLOWED_PREFIX =
  "src/orchestrator/"`): `@anthropic-ai/claude-agent-sdk` may be imported ONLY under
  `src/orchestrator/`. The new plan-billed `query()` call MUST live in a new module under
  `src/orchestrator/`, never in `src/compliance/`.
- single-funnel (c) (`tests/invariants/single-funnel.test.ts:170-179`): update so the raw
  `@anthropic-ai/sdk` Messages API is no longer imported anywhere in `src/`, while keeping a
  synthetic-offender self-test so the check can never pass vacuously.
</locked_decisions>

<context>
@CLAUDE.md
@.planning/STATE.md

Current classifier (transport to replace):
@src/compliance/classifier.ts
@src/compliance/gate.ts
@src/compliance/schema.ts

Existing Agent SDK query() pattern to MIRROR:
@src/orchestrator/sdk-runner.ts
@src/orchestrator/prompt-boundary.ts
@src/orchestrator/types.ts

Boot wiring + eval script + invariants + tests to update:
@src/main.ts
@scripts/gate-eval.ts
@tests/invariants/prompt-injection-boundary.test.ts
@tests/invariants/single-funnel.test.ts
@tests/invariants/scan-helpers.ts
@src/compliance/classifier.contract.test.ts
@src/compliance/classifier.test.ts

<interfaces>
Existing contracts the executor builds against (do NOT re-derive):

From src/compliance/schema.ts:
- `GateDecisionShapeSchema` (enums-only shape parse), `GateDecisionSchema` (refined),
  `type ClassifierDecision = z.infer<typeof GateDecisionSchema>`.

From src/compliance/classifier.ts (current, being reworked):
- `interface ClassifierDeps { anthropic: Anthropic; model?; maxRetries?; logger? }` (classifier.ts:17-25)
- `classifierDepsFromEnv(logger?): ClassifierDeps | null` (classifier.ts:34-40) — from ANTHROPIC_API_KEY
- `CLASSIFIER_UNAVAILABLE_DECISION` fail-closed sentinel (classifier.ts:42-48)
- `SYSTEM_PROMPT` fixed const, zero interpolation (classifier.ts:50-79)
- `classifyWithSonnet(deps, candidate): Promise<ClassifierDecision>` (classifier.ts:87-188) —
  retry loop, `anthropic.messages.parse(request, { timeout: 8000 })` (classifier.ts:125),
  shape parse → D-12 coercion → refined validation → fail-closed sentinel.
- `envInt`, `backoff`, `BACKOFF_MS` (classifier.ts:190-210)

From src/compliance/gate.ts:
- `type FakeClassifier = (candidate) => ClassifierDecision | Promise<ClassifierDecision>` (gate.ts:27-29)
- `interface GateDeps { db?; fakeClassifier?; classifier?: ClassifierDeps; prefilter?; logger?; streamModeProvider? }` (gate.ts:31-47)
- `classify(deps, candidate)` dispatch (gate.ts:82-101): fakeClassifier → classifyWithSonnet(deps.classifier,…) → FAIL_CLOSED.

From src/orchestrator/sdk-runner.ts (the query() pattern to mirror):
- `import { type Options, query } from "@anthropic-ai/claude-agent-sdk"` (sdk-runner.ts:23)
- Host text-only turn sets `options.allowedTools = []` + `options.disallowedTools = HOST_TURN_DISALLOWED`
  (sdk-runner.ts:48-56, 83-84); `for await (const message of query({ prompt, options }))` (sdk-runner.ts:86-89).

From src/main.ts:
- classifier import (main.ts:12), gate import (main.ts:13), gate wiring (main.ts:314-328),
  guarded dynamic-import pattern `buildOrchestratorAdapters` (main.ts:1345-1367),
  boot `Promise.all([...])` (main.ts:1413-1418).
</interfaces>
</context>

<design_decisions>
Concrete design the tasks below implement (resolves the "decide where" latitude in the brief):

1. `CLASSIFIER_SYSTEM_PROMPT` lives in `src/orchestrator/prompt-boundary.ts` (the existing
   home of fixed, orchestrator-authored, zero-interpolation agent system prompts —
   RESEARCH_SYSTEM_PROMPT/BUILD_SYSTEM_PROMPT, prompt-boundary.ts:39-55). It is a plain
   template literal with NO `${…}`, so the SAND-04 prompt-source guard
   (`INTERPOLATED_SYSTEM_PROMPT`, prompt-injection-boundary.test.ts:138) is satisfied.
   prompt-boundary.ts imports no SDK, so it introduces no boundary risk. The compliance
   layer never imports this const.

2. Candidate text is passed as the RAW user-message content (matching current classifier
   behavior at classifier.ts:110-114 — no delimiter reframing), preserving the reviewed
   classification behavior. The T-01-06 boundary holds because candidate text NEVER enters
   the system prompt regardless of framing.

3. The compliance↔orchestrator seam is an injected async transport function
   `type ClassifierTransport = (candidateText: string) => Promise<string>` returning the
   model's raw assistant text. Model pinning + query() live in the orchestrator runner;
   the retry budget, tolerant JSON extraction, zod re-validation, D-12 coercion, and
   fail-closed sentinel STAY in `src/compliance/classifier.ts`.

4. `query()` has no native `json_schema` enforcement (unlike `messages.parse`). The
   compliance layer parses the raw assistant text tolerantly (strip ```json / ``` code
   fences and any leading/trailing prose; slice from first `{` to last `}`), then runs the
   EXISTING zod shape → D-12 coercion → refined validation. ANY parse/validation/transport
   failure = fail closed (`CLASSIFIER_UNAVAILABLE_DECISION`), never fail open. Retry budget
   unchanged.
</design_decisions>

<tasks>

<task type="auto">
  <name>Task 1: Add shared CLASSIFIER_SYSTEM_PROMPT constant</name>
  <files>src/orchestrator/prompt-boundary.ts</files>
  <action>
    Add an exported `CLASSIFIER_SYSTEM_PROMPT` const to prompt-boundary.ts, alongside
    RESEARCH_SYSTEM_PROMPT/BUILD_SYSTEM_PROMPT (prompt-boundary.ts:39-55). Copy the prompt
    text VERBATIM from the current classifier `SYSTEM_PROMPT` (classifier.ts:50-79) — a
    fixed template literal with ZERO `${…}` interpolation. Add a doc comment noting it is
    orchestrator-authored, static, interpolation-free, and that the compliance gate runs on
    Sonnet as a deliberate documented exception to the Fable model policy (D-1). Do NOT add
    any SDK import to this file (it must stay a pure string module). Do NOT yet remove the
    copy in classifier.ts — Task 3 removes it during the transport swap.
  </action>
  <verify>
    <automated>npx tsc --noEmit && grep -c "export const CLASSIFIER_SYSTEM_PROMPT" src/orchestrator/prompt-boundary.ts</automated>
  </verify>
  <done>CLASSIFIER_SYSTEM_PROMPT exported from prompt-boundary.ts; tsc clean; no SDK import added.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Orchestrator plan-billed classifier transport + guard test</name>
  <files>src/orchestrator/classifier-runner.ts, src/orchestrator/classifier-runner.test.ts</files>
  <behavior>
    - query() Options carry `allowedTools: []` AND a disallow denylist (mirror
      HOST_TURN_DISALLOWED, sdk-runner.ts:48-56) → zero tool-execution authority.
    - The call is single-turn (`maxTurns: 1`).
    - `model` is pinned to `process.env.GATE_MODEL ?? "claude-sonnet-5"`.
    - `systemPrompt` is `CLASSIFIER_SYSTEM_PROMPT` by BARE reference and does NOT contain
      the candidate text (zero interpolation, T-01-06).
    - Candidate text appears ONLY as the query `prompt` (user content).
    - Returns the model's raw assistant text.
    - An ~8s timeout aborts the query via AbortController.
  </behavior>
  <action>
    Create `src/orchestrator/classifier-runner.ts` mirroring sdk-runner.ts:23,63-92.
    Import `{ type Options, query }` from "@anthropic-ai/claude-agent-sdk" and
    `CLASSIFIER_SYSTEM_PROMPT` from "./prompt-boundary.js". Export
    `type ClassifierTransport = (candidateText: string) => Promise<string>` and a factory
    `createClassifierTransport(injected?: { queryFn?: typeof query }): ClassifierTransport`.
    The transport, per call: build an AbortController; `setTimeout(() => controller.abort(),
    8000)` (unref if available); construct `const options: Options = { systemPrompt:
    CLASSIFIER_SYSTEM_PROMPT, model: process.env.GATE_MODEL ?? "claude-sonnet-5",
    allowedTools: [], disallowedTools: [...same denylist as sdk-runner], maxTurns: 1,
    abortController: controller }`; call `queryFn({ prompt: candidateText, options })`
    (default queryFn = imported `query`); iterate the message stream, accumulating assistant
    text (prefer the final `result` message's text if present, else concatenated assistant
    text content blocks); clear the timeout; return the raw text. Pass `systemPrompt` by bare
    reference — never an interpolating template literal (SAND-04 prompt-source guard).
    Write `classifier-runner.test.ts` (network-free): inject a fake `queryFn` that captures
    the `{ prompt, options }` and returns an async generator yielding a canned assistant
    message with a JSON body. Assert: options.allowedTools deep-equals [] (no tool
    authority); options.maxTurns === 1 (single-turn); options.model === "claude-sonnet-5"
    (Sonnet pinned; also test GATE_MODEL override); options.systemPrompt ===
    CLASSIFIER_SYSTEM_PROMPT and does NOT include the candidate text (no interpolation);
    the candidate text is passed only as `prompt`; the transport returns the model's raw
    text. Follow the injected-fake style of build-session.test.ts.
  </action>
  <verify>
    <automated>npx vitest run src/orchestrator/classifier-runner.test.ts</automated>
  </verify>
  <done>Runner exists under src/orchestrator/; guard test green proving no-tools, single-turn, Sonnet-pinned, zero interpolation.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Swap compliance transport to injected function; remove Anthropic SDK from src/compliance/</name>
  <files>src/compliance/classifier.ts, src/compliance/gate.ts, src/compliance/classifier.test.ts, src/compliance/classifier.contract.test.ts, src/compliance/gate.test.ts</files>
  <behavior>
    - Valid JSON from the transport → parsed ClassifierDecision (via existing zod path).
    - Raw text wrapped in ```json code fences or surrounded by prose → JSON extracted, then validated.
    - Malformed / non-JSON / transport throw → fail closed (CLASSIFIER_UNAVAILABLE_DECISION), never fail open; retry budget honored with backoff.
    - held-for-review with a non-escalate category → coerced to rejected (D-12), unchanged.
  </behavior>
  <action>
    In classifier.ts: remove `import Anthropic from "@anthropic-ai/sdk"` (classifier.ts:9),
    delete `classifierDepsFromEnv` (classifier.ts:34-40), and delete the local `SYSTEM_PROMPT`
    const (classifier.ts:50-79 — now owned by prompt-boundary.ts). Replace `ClassifierDeps`
    (classifier.ts:17-25) with:
    `export type ClassifierTransport = (candidateText: string) => Promise<string>;`
    `export interface ClassifierDeps { transport: ClassifierTransport; maxRetries?: number; logger?: Logger; }`
    (drop `anthropic` and `model` — model pinning now lives in the orchestrator runner).
    Rewrite `classifyWithSonnet` (classifier.ts:87-188), KEEPING the retry loop, backoff,
    envInt, CLASSIFIER_UNAVAILABLE_DECISION, GateDecisionShapeSchema shape parse, D-12
    coercion (classifier.ts:143-154), and GateDecisionSchema refined re-validation
    (classifier.ts:156-166). Change ONLY the transport: replace the request build +
    `anthropic.messages.parse(request, { timeout: 8000 })` (classifier.ts:99-125) with
    `const raw = await transport(candidate.text);` followed by a tolerant JSON extraction
    helper (strip leading/trailing prose and ```json / ``` fences; slice from the first `{`
    to the last `}`; `JSON.parse`). Feed the parsed object into the EXISTING shape →
    coercion → refined validation. Any extraction/parse/validation error or transport throw
    is caught by the existing catch and drives the existing fail-closed/backoff path
    (classifier.ts:167-188). Never fail open.
    In gate.ts: keep everything; only update the `deps.classifier?: ClassifierDeps` doc
    comment (gate.ts:40-41) to "Live plan-billed classifier transport (Sonnet via Agent
    SDK)". `classify()` still calls `classifyWithSonnet(deps.classifier, candidate)`
    (gate.ts:89). FakeClassifier path (gate.ts:85-86) and FAIL_CLOSED (gate.ts:49-55)
    unchanged.
    Repoint compliance tests (network-free): rewrite classifier.test.ts `makeMockClient`
    (classifier.test.ts:22-53) into a fake `ClassifierTransport` returning raw JSON
    strings/Errors, and update the `deps` builder to `{ transport }`. Rewrite
    classifier.contract.test.ts (classifier.contract.test.ts:17-57) to remove the
    `@anthropic-ai/sdk` imports and instead pin the NEW transport contract: an injected fake
    transport → tolerant JSON extraction (bare JSON, fenced JSON, prose-wrapped JSON all
    parse) → fail-closed on malformed/thrown, using GateDecisionSchema for validation.
    Update any gate.test.ts case that constructs `ClassifierDeps` with `anthropic` to use
    `{ transport }`.
  </action>
  <verify>
    <automated>npx vitest run src/compliance/ && grep -rc "@anthropic-ai/sdk" src/compliance/ | grep -v ':0$' || echo "NO_SDK_IMPORT_IN_COMPLIANCE"</automated>
  </verify>
  <done>src/compliance/ imports no @anthropic-ai/sdk; classifier uses injected transport with tolerant JSON extraction + fail-closed; all compliance tests green.</done>
</task>

<task type="auto">
  <name>Task 4: Rewire main.ts to the plan-billed transport (guarded dynamic import)</name>
  <files>src/main.ts</files>
  <action>
    Remove `import { classifierDepsFromEnv } from "./compliance/classifier.js"` (main.ts:12)
    and add a type import of `ClassifierTransport` from "./compliance/classifier.js" where
    needed. Add a guarded dynamic-import factory `buildClassifierTransport(logger)` modeled
    on `buildOrchestratorAdapters` (main.ts:1345-1367): inside a try, `const {
    createClassifierTransport } = await import("./orchestrator/classifier-runner.js");
    return createClassifierTransport();` and on catch log a LOUD warning
    ("COMPLIANCE CLASSIFIER UNAVAILABLE — Agent SDK failed to load; the gate will FAIL CLOSED
    on every submission until `claude login` / plan credentials are available") and return
    `undefined`. This keeps the agent SDK out of the static/vitest graph (mirrors
    buildOrchestratorAdapters). Invoke it in the entrypoint `Promise.all` boot
    (main.ts:1413-1418) and thread the resulting transport into createApp options.
    Rewire the gate deps block (main.ts:314-328): replace `classifierDepsFromEnv(logger)`
    with the injected transport — `const classifierTransport = opts.fakeClassifier ? null :
    opts.classifierTransport ?? null;` keep the loud warning + fail-closed when it is absent
    (update the message from "ANTHROPIC_API_KEY not set …" to the plan-credentials wording),
    and set `...(classifierTransport ? { classifier: { transport: classifierTransport,
    logger } } : {})` on GateDeps. KEEP the `fakeClassifier` injection path (main.ts:326) so
    vitest never touches the network/real SDK. Add `classifierTransport?: ClassifierTransport`
    to the app options type.
  </action>
  <verify>
    <automated>npx tsc --noEmit && grep -c "classifierDepsFromEnv" src/main.ts</automated>
  </verify>
  <done>main.ts wires the plan-billed transport via guarded dynamic import; classifierDepsFromEnv gone (grep → 0); fail-closed + loud warning preserved; FakeClassifier path intact; tsc clean.</done>
</task>

<task type="auto">
  <name>Task 5: Route gate-eval through the plan-billed transport; replace no-key exit with not-logged-in skip</name>
  <files>scripts/gate-eval.ts</files>
  <action>
    Remove `import Anthropic from "@anthropic-ai/sdk"` (gate-eval.ts:28). Import
    `createClassifierTransport` from "../src/orchestrator/classifier-runner.js". Replace the
    `new Anthropic()` + `classifier: { anthropic }` deps (gate-eval.ts:113-118) with
    `classifier: { transport }` where `transport = createClassifierTransport()`. Replace the
    `ANTHROPIC_API_KEY`-missing exit-2 block (gate-eval.ts:93-101) with a "not logged in /
    plan unavailable" skip: before running fixtures, do a one-shot probe — call `transport`
    on a trivial input inside try/catch; if it throws (SDK unavailable / not logged in),
    print guidance ("Claude plan credentials unavailable — run `claude login`, then re-run:
    npm run gate:eval") and return 2 (clean follow-up, not a failure). Update the header
    comment (gate-eval.ts:1-25) — remove "metered … per-token" wording, state the eval now
    bills against the Claude plan (`claude login`). KEEP unchanged: SAFETY FAIL / WARN logic,
    the canonical `tax-07-gray` must-be-held-for-review check (gate-eval.ts:73-91), the
    all-failed-closed → exit 1 guard (gate-eval.ts:178-183), and the summary output.
  </action>
  <verify>
    <automated>npx tsc --noEmit && grep -c "@anthropic-ai/sdk" scripts/gate-eval.ts</automated>
  </verify>
  <done>gate-eval routes through createClassifierTransport; no @anthropic-ai/sdk import (grep → 0); not-logged-in skip replaces the no-key exit-2; SAFETY/WARN/tax-07-gray logic unchanged; tsc clean.</done>
</task>

<task type="auto">
  <name>Task 6: Update single-funnel (c); confirm SAND-04 stays green non-vacuously</name>
  <files>tests/invariants/single-funnel.test.ts</files>
  <action>
    Rewrite single-funnel check (c) (single-funnel.test.ts:170-179). Since NO src file now
    imports `@anthropic-ai/sdk`, the old "outside src/compliance/" filter would pass
    vacuously. Replace it with a meaningful, self-testing assertion: extract a pure function
    (e.g. `rawSdkImportOffenders(files)`) returning EVERY "file:line" where
    `/["']@anthropic-ai\/sdk["']/` matches anywhere in the scanned src tree, and assert it
    has length 0 (the raw Messages API is retired from src/). Add a synthetic-offender
    self-test that runs the SAME pure function over `[...files, { rel:
    "src/rogue/anthropic-rogue.ts", stripped: 'import Anthropic from "@anthropic-ai/sdk";\n'
    }]` and asserts it flags `src/rogue/anthropic-rogue.ts:1` — mirroring the
    prompt-injection-boundary self-test pattern (prompt-injection-boundary.test.ts:163-171)
    so the check can never pass by scanning nothing or matching nothing. Update the (c)
    description string and the file's top-of-file enumerated comment for (c) to reflect the
    new meaning ("the raw @anthropic-ai/sdk Messages API is imported NOWHERE in src/ — the
    compliance gate now bills via the Agent SDK query() under src/orchestrator/").
    Do NOT edit prompt-injection-boundary.test.ts logic — the new
    `src/orchestrator/classifier-runner.ts` legitimately imports the agent SDK under the
    allowed prefix, and its bare-reference systemPrompt satisfies the existing prompt-source
    guard; just confirm the suite still passes.
  </action>
  <verify>
    <automated>npx vitest run tests/invariants/single-funnel.test.ts tests/invariants/prompt-injection-boundary.test.ts</automated>
  </verify>
  <done>single-funnel (c) asserts zero @anthropic-ai/sdk imports in src/ with an intact synthetic-offender self-test; SAND-04 suite green; both invariants non-vacuous.</done>
</task>

<task type="auto">
  <name>Task 7: Update billing docs (plan credits, no required API key)</name>
  <files>.env.example, README.md, docs/OPERATIONS.md, .planning/STATE.md</files>
  <action>
    Correct the billing story everywhere: the live compliance gate now bills to the Claude
    plan (`claude login`); no `ANTHROPIC_API_KEY` is required for normal operation OR for
    `npm run gate:eval`.
    - .env.example (lines 10-12): remove the "metered API billing — every suggestion costs
      one classifier call" note; either delete the `ANTHROPIC_API_KEY=` line or replace it
      with a comment stating the gate bills via `claude login` plan credits and the key must
      stay UNSET on the streaming machine (CLAUDE.md "What NOT to Use"). Keep GATE_MODEL /
      GATE_MAX_RETRIES.
    - README.md (line 28 and the env table line 34): drop "requires ANTHROPIC_API_KEY" —
      state all values have working defaults and the gate authenticates via `claude login`
      (plan credits); remove/replace the `ANTHROPIC_API_KEY … Sonnet compliance classifier
      (metered API)` table row.
    - docs/OPERATIONS.md (line ~25, "Twitch and Anthropic API credentials"): correct so the
      Anthropic side reflects plan-credit auth via `claude login`, not an API key.
    - .planning/STATE.md go-live batch item A (line 47): change "Live Sonnet `gate:eval` pass
      (needs `ANTHROPIC_API_KEY` for the eval only …)" to state the eval bills via the
      Claude plan (`claude login`) and needs NO `ANTHROPIC_API_KEY`; also fix the line 122
      UAT note ("live Sonnet gate:eval (needs ANTHROPIC_API_KEY)") to match.
    Do not touch Phase 3/5 SANDBOX/SANDBOX_ANTHROPIC_API_KEY references — those are the
    separate in-distro build-agent billing path, out of scope here.
  </action>
  <verify>
    <automated>! grep -rn "metered" .env.example README.md && grep -rc "claude login" README.md .env.example docs/OPERATIONS.md</automated>
  </verify>
  <done>.env.example, README.md, docs/OPERATIONS.md, and STATE.md (batch item A + UAT note) describe plan-credit billing via claude login with no required ANTHROPIC_API_KEY.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| untrusted chat text → classifier | Viewer `candidate.text` is untrusted input screened by the gate. |
| orchestrator → Agent SDK query() | The only place tool-use authority (`query()`) exists; must be tools-disabled for the gate. |
| boot → plan credentials | `claude login` availability determines whether the gate can classify; absence must fail closed. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-QK-01 | Elevation of Privilege | classifier-runner.ts `query()` | mitigate | Options set `allowedTools: []` + denylist and `maxTurns: 1` (Task 2) — the gate's query() has ZERO tool-execution authority and cannot multi-turn; guard test asserts both. |
| T-QK-02 | Tampering / Injection | candidate text → system prompt | mitigate | Candidate text passed ONLY as query `prompt` (user content); `systemPrompt = CLASSIFIER_SYSTEM_PROMPT` by bare reference, no `${…}` (T-01-06). Enforced by SAND-04 prompt-source guard + Task 2 assertion. |
| T-QK-03 | Denial of Service / Fail-open | JSON extraction of raw model text | mitigate | Tolerant parse (strip fences/prose) then EXISTING zod shape+refined validation; ANY parse/validation/transport failure → CLASSIFIER_UNAVAILABLE_DECISION (fail closed), never fail open (Task 3). Retry budget + backoff retained. |
| T-QK-04 | Spoofing / Repudiation | held-for-review escalation | mitigate | D-12 coercion (held-for-review + non-escalate category → rejected) and gate-level belt-and-suspenders (gate.ts:106-117) unchanged; canonical gambling-gray `tax-07-gray` still held-for-review (Task 5 keeps eval check). |
| T-QK-05 | Information Disclosure / Boundary erosion | agent SDK import location | mitigate | New query() call confined to src/orchestrator/ (SAND-04); raw @anthropic-ai/sdk retired from all of src/ with a self-testing invariant (Task 6). Both invariants stay green non-vacuously. |
| T-QK-06 | Denial of Service | plan credentials absent at boot | accept (safe) | Guarded dynamic import + per-call query() failure both drive the existing fail-closed path with a loud warning (Task 4) — identical safe behavior to today's no-key case (D-2). |
| T-QK-SC | Tampering | npm/pip/cargo installs | n/a | No new package installs — `@anthropic-ai/claude-agent-sdk` is already a project dependency; this change removes a usage, adds none. |
</threat_model>

<verification>
Full-suite acceptance (autonomous executor runs after all tasks):
- `npx tsc --noEmit` clean.
- `npx vitest run` fully green, with SAND-04 (prompt-injection-boundary) and single-funnel
  (c) passing NON-VACUOUSLY (their synthetic-offender self-tests intact).
- `npx biome check src tests` clean.
- Spot-confirm: `grep -rn "@anthropic-ai/sdk" src/` returns nothing (compliance no longer
  imports the raw Messages API); `grep -rn "@anthropic-ai/claude-agent-sdk" src/` matches
  only files under src/orchestrator/.
</verification>

<success_criteria>
- The live compliance gate classifies via the Agent SDK `query()` (plan/subscription billing
  via `claude login`); the raw `@anthropic-ai/sdk` Messages API is gone from src/compliance/
  and from all of src/.
- Model stays Sonnet (GATE_MODEL, default claude-sonnet-5) — documented Fable-policy exception.
- Fail-closed behavior, retry+backoff, zod shape/refined re-validation, D-12 coercion, and the
  T-01-06 prompt boundary are all preserved; no fail-open JSON path exists.
- SAND-04 and single-funnel (c) both pass non-vacuously; `tsc --noEmit`, `vitest run`, and
  `biome check src tests` are all clean.
- Docs (`.env.example`, README, docs/OPERATIONS.md, STATE.md batch item A) describe plan-credit
  billing with no required `ANTHROPIC_API_KEY`.
</success_criteria>

<output>
This is a quick-mode plan; no SUMMARY.md is required. On completion the executor should report
the acceptance-command results (tsc / vitest / biome) and confirm both invariants pass
non-vacuously.
</output>
