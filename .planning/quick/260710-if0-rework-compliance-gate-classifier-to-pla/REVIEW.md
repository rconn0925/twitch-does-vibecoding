---
phase: quick-260710-if0-rework-compliance-gate-classifier-to-plan-billing
reviewed: 2026-07-10T00:00:00Z
resolution: all 3 warnings + IN-01/IN-02 fixed; IN-03 (guard-test denylist) addressed by added WR-01/WR-02 tests. 679 tests green, tsc+biome clean.
depth: deep
files_reviewed: 12
files_reviewed_list:
  - src/orchestrator/classifier-runner.ts
  - src/orchestrator/classifier-runner.test.ts
  - src/orchestrator/prompt-boundary.ts
  - src/compliance/classifier.ts
  - src/compliance/classifier.test.ts
  - src/compliance/classifier.contract.test.ts
  - src/compliance/gate.ts
  - src/compliance/schema.ts
  - src/main.ts
  - scripts/gate-eval.ts
  - tests/invariants/single-funnel.test.ts
  - tests/invariants/prompt-injection-boundary.test.ts
findings:
  blocker: 0
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Code Review: Compliance-gate classifier → plan-billed `query()` transport

**Reviewed:** 2026-07-10
**Depth:** deep (cross-file trace of every path from `query()` → `ClassifierDecision`)
**Files reviewed:** 12
**Status:** issues_found (0 BLOCKER, 3 WARNING, 3 INFO)

## Summary

The transport swap is well-executed and the fail-closed envelope is structurally
sound. I traced every path from `query()` returning to a returned
`ClassifierDecision` and found **no fail-OPEN BLOCKER**. The safety-critical
properties hold:

- **Fail-closed envelope (path 1):** `classifier.ts` wraps the transport call +
  `extractJsonObject` + shape parse + D-12 coercion + refined re-validation in one
  try/catch whose only non-error `return` is a fully zod-validated decision. Every
  error/timeout/non-JSON/garbage path resolves (never throws) to
  `CLASSIFIER_UNAVAILABLE_DECISION` (`rejected`/`classifier-unavailable`). The
  tolerant `{`…`}` slice fails *closed* on prose-with-braces (JSON.parse throws),
  and a held-with-null-category or a `>500`-char rationale both fail the refined
  schema → fail-closed. Confirmed by contract + classifier tests.
- **Prompt-injection boundary (path 2):** `CLASSIFIER_SYSTEM_PROMPT` is
  **byte-identical** to the retired `SYSTEM_PROMPT` (verified with a diff of the
  two literals — zero wording drift). Candidate text reaches the model ONLY as the
  `query({ prompt })` user content in both `classifier-runner.ts` and
  `classifier.ts`; the system prompt is passed by bare reference, no `${…}`.
- **Zero tool authority (path 3):** `allowedTools: []` + defensive
  `disallowedTools` + `maxTurns: 1`; the guard test asserts these non-vacuously
  (`toEqual([])`, `maxTurns === 1`, model pin). A single turn with an empty
  allowlist structurally cannot be talked into tool use.
- **main.ts wiring fails closed (path 4):** A failed dynamic import →
  `buildClassifierTransport` returns `undefined` → createApp wires neither
  `fakeClassifier` nor `classifier` → `gate.ts` hits the `else` branch and returns
  `FAIL_CLOSED`, with the loud warning. A *constructed-but-credential-less*
  transport throws per call → same fail-closed sentinel. `FakeClassifier` still
  short-circuits the real SDK and the entrypoint never injects a fake.
- **D-12 + canonical behavior (path 5):** Coercion intact in both `classifier.ts`
  and the `gate.ts` belt-and-suspenders; `tax-07-gray` still routes held-for-review
  via the gambling escalate-eligible path (test-covered).
- **Invariants non-vacuous (path 6):** single-funnel (c) scans for zero raw
  `@anthropic-ai/sdk` imports in `src/` with a real planted-offender self-test;
  SAND-04 confines `@anthropic-ai/claude-agent-sdk` to `src/orchestrator/` with its
  own self-test and interpolated-system-prompt guard. Neither weakened.
- **gate-eval SAFETY semantics (path 7):** SAFETY-FAIL logic and the
  `tax-07-gray` must-hold check are unchanged; the not-logged-in skip (exit 2)
  can't be mistaken for a pass — an all-`classifier-unavailable` run returns exit 1.

The three warnings below are robustness/operational-correctness issues, not
fail-open holes. WR-01 is the highest priority: it is the one place the transport
deviates from the module's own stated "any error → fail closed" contract.

## Warnings

### WR-01: Transport trusts partial assistant text on a NON-success `query()` result — deviates from "any error → fail closed"

**File:** `src/orchestrator/classifier-runner.ts:90-104`

The read loop only captures `resultText` when `message.subtype === "success"`,
but the return value falls back to `assistantChunks.join("")` **for every other
terminal outcome** — including a result message with an error subtype
(`error_max_turns`, `error_during_execution`) or a stream that ends with no result
message at all:

```ts
if (message.type === "result") {
  if (message.subtype === "success") resultText = message.result;
} else if (message.type === "assistant") { /* accumulate text blocks */ }
...
return resultText ?? assistantChunks.join("");
```

Failing scenario: the model emits a complete, well-formed
`{"decision":"approved","category":null,"rationale":"…"}` in an assistant text
block, and the run then terminates with a non-`success` result subtype. The
transport returns that text; `extractJsonObject` + schema parse accept it; the gate
**approves a suggestion from a run the SDK reported as errored**. This is the exact
"partial/errored response yields something other than fail-closed" case the review
brief calls out. It is narrow (requires a complete valid JSON *and* a trailing
error), and the value returned is still the model's own verdict — hence WARNING not
BLOCKER — but it contradicts this module's documented invariant and weakens the gate
in the *unsafe* direction.

**Fix:** Only trust text from a successful result. On any non-`success` terminal
result (or absent result), return empty/throw so the `classifier.ts` envelope fails
closed:

```ts
let resultText: string | undefined;
let sawResult = false;
for await (const message of stream) {
  if (message.type === "result") {
    sawResult = true;
    if (message.subtype === "success") resultText = message.result;
  } else if (message.type === "assistant") { /* accumulate */ }
}
// Trust ONLY a successful result; anything else → fail closed upstream.
if (!sawResult || resultText === undefined) {
  throw new Error("classifier query() did not complete successfully");
}
return resultText;
```
(If the assistant-text fallback must be kept for streams that legitimately omit a
result message, gate it on the *absence* of an error result, never on an error
subtype.)

### WR-02: Hand-rolled AbortController timeout is a weaker liveness guarantee than the retired `messages.parse({ timeout })`

**File:** `src/orchestrator/classifier-runner.ts:70-107`

The old path used the SDK-enforced `anthropic.messages.parse(request, { timeout:
8000 })`, which reliably aborts the in-flight request and throws at 8s. The new path
replaces that with a hand-rolled `AbortController` + `setTimeout(() =>
controller.abort(), 8000)` handed to `options.abortController`. `clearTimeout` only
runs in `finally` *after* the `for await` loop ends, so the 8s bound is only real if
the Agent SDK's `query()` generator actually honors the abort promptly. If a
`query()` call stalls in a way that does not react to the AbortController (e.g. a
subprocess/credential-probe hang before streaming begins), the `for await` never
settles and that `classify()` promise hangs indefinitely.

Failing scenario (live show): a hung Sonnet call leaves one `!suggest` submission's
gate decision pending forever — the viewer gets no feedback and the candidate never
enters the pool. Not fail-open (nothing is approved) and not process-wide (other
submissions are independently awaited), but it is a real robustness regression from
the previously reliable SDK-level timeout on a "failures are public" gate.

**Fix:** Wrap the stream consumption in an explicit timeout race that resolves the
transport (letting the envelope fail closed) even if the generator never settles,
rather than relying solely on `abortController` being honored:

```ts
const timeout = new Promise<string>((_, reject) =>
  setTimeout(() => reject(new Error("classifier timeout")), CLASSIFIER_TIMEOUT_MS).unref(),
);
return await Promise.race([consumeStream(stream), timeout]);
```
so a stalled `query()` deterministically rejects → retry/fail-closed at 8s.

### WR-03: gate-eval prints a stale prompt-location instruction at a live SAFETY FAIL

**File:** `scripts/gate-eval.ts:197`

On a SAFETY FAIL the script tells the operator:

```
"Iterate the classifier system prompt in src/compliance/classifier.ts and re-run."
```

The prompt no longer lives there — this rework moved it to
`CLASSIFIER_SYSTEM_PROMPT` in `src/orchestrator/prompt-boundary.ts`, and
`classifier.ts` contains no system prompt at all. An operator following this message
during a pre-stream safety failure edits the wrong (prompt-less) file. This is the
one place the change left a safety-relevant operational instruction pointing at the
old location.

**Fix:** Update the message to
`src/orchestrator/prompt-boundary.ts (CLASSIFIER_SYSTEM_PROMPT)`.

## Info

### IN-01: `@anthropic-ai/sdk` is now a dead production dependency

**File:** `package.json:19`

No file under `src/` (or `scripts/`, `tests/`) imports `@anthropic-ai/sdk` anymore —
the only remaining occurrences are the single-funnel invariant's *string* literal
and doc comments. The package remains a declared runtime dependency, drifting from
the CLAUDE.md T-01-SC audited-package set and leaving unused supply-chain surface on
the streaming machine.

**Fix:** `npm rm @anthropic-ai/sdk` and drop it from the audited-set docs, once you
confirm nothing else references it.

### IN-02: `getGateDecisionJsonSchema()` + schema docstrings describe the retired Structured-Outputs flow

**File:** `src/compliance/schema.ts:1-8, 90-97`

The header ("sent to the Anthropic API as the Structured Output JSON schema
constraint", `output_config.format`) and `getGateDecisionJsonSchema()` describe the
`messages.parse`/`output_config` path that no longer exists — `query()` has no native
`json_schema` enforcement (correctly noted in `classifier.ts`). `getGateDecisionJsonSchema`
is now dead in production; only `schema.test.ts` still exercises it.

**Fix:** Remove `getGateDecisionJsonSchema()` (and its two tests) and refresh the
docstring to describe the tolerant-extract-then-re-validate flow. Keep
`GateDecisionSchema`/`GateDecisionShapeSchema` (still the live validators).

### IN-03: Guard test under-specifies the tool denylist

**File:** `src/orchestrator/classifier-runner.test.ts:63-71`

The guard asserts `disallowedTools` `.toContain("Bash")`/`.toContain("WebFetch")`
but not the full `CLASSIFIER_DISALLOWED` set, and does not assert the tool boundary
holds under crafted candidate text. The core properties (`allowedTools: []`,
`maxTurns: 1`) are already asserted non-vacuously and structurally cannot be changed
by candidate text, so this is low value — but tightening the denylist assertion to
the full list would catch an accidental narrowing of the defensive denylist.

**Fix:** `expect(captured().options?.disallowedTools).toEqual(CLASSIFIER_DISALLOWED)`
(export the const for the test).

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
