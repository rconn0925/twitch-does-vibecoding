# Security Audit: Compliance-Gate Classifier → Plan-Billed `query()` Transport

**Change:** Move the compliance gate's LLM classifier off the metered raw Anthropic
Messages API (`@anthropic-ai/sdk`) onto plan-billed billing via the Claude Agent SDK
`query()` (`claude login` credits). Transport-only change; every safety property preserved.

**Audited commits:** `e4465f2..0b7679e` (master)
**Method:** Independent code trace + grep/read of shipped source and invariant self-tests.
Documentation and REVIEW.md claims were NOT accepted as evidence; every verdict below cites
`file:line`. Suite reported green (679 tests, tsc + biome clean) — not re-run; verified against code.

**Overall verdict: PASS — all declared mitigations present. threats_open = 0.**

---

## Per-Threat Verdicts

| Threat ID | Category | Disposition | Verdict | Evidence |
|-----------|----------|-------------|---------|----------|
| T-QK-01 | Elevation of Privilege — tool authority on gate call | mitigate | **MITIGATED** | `classifier-runner.ts:94-97` |
| T-QK-02 | Tampering / Injection — candidate text → system prompt | mitigate | **MITIGATED** | `classifier-runner.ts:90,100` |
| T-QK-03 | DoS / Fail-open — JSON extraction of raw model text | mitigate | **MITIGATED** | `classifier.ts:57-64,84-147` + `classifier-runner.ts:101-135` |
| T-QK-04 | Spoofing / Repudiation — held-for-review escalation | mitigate | **MITIGATED** | `classifier.ts:104-114`, `gate.ts:106-117` |
| T-QK-05 | Info Disclosure / Boundary erosion — SDK import location | mitigate | **MITIGATED** | grep + invariant self-tests (below) |
| T-QK-06 | DoS — plan credentials absent at boot | accept (safe) | **MITIGATED** | `main.ts:324-329,1385-1397`, `gate.ts:90-96` |
| Secrets posture | Info Disclosure — no runtime API key | mitigate | **MITIGATED** | grep `ANTHROPIC_API_KEY` in `src/` (comments only) |
| T-QK-SC | Tampering — package installs | n/a | **N/A (improved)** | `@anthropic-ai/sdk` removed from `package.json`, none added |

---

## T-QK-01 — Zero tool-execution authority on the gate `query()` — MITIGATED

The classification `query()` in `src/orchestrator/classifier-runner.ts` sets:
- `allowedTools: []` (empty allowlist — `classifier-runner.ts:94`)
- `disallowedTools: CLASSIFIER_DISALLOWED` — a defensive denylist of WebFetch/WebSearch/Write/Edit/MultiEdit/NotebookEdit/Bash (`classifier-runner.ts:38-46,95`)
- `maxTurns: 1` (`classifier-runner.ts:97`)

The guard test asserts this **non-vacuously** via an injected fake `queryFn` that captures the
real `options` object: `allowedTools` `toEqual([])`, `disallowedTools` contains Bash + WebFetch,
`maxTurns` `toBe(1)` (`classifier-runner.test.ts:68-96`). A single turn with an empty allowlist
structurally cannot be talked into tool use by candidate text.

Residual (non-blocking, matches review IN-03): the test asserts `disallowedTools` via
`.toContain(...)` on two entries rather than `.toEqual(CLASSIFIER_DISALLOWED)` for the full set
(`classifier-runner.test.ts:74-75`). The load-bearing properties (`allowedTools: []`, `maxTurns: 1`)
are asserted exactly, so an accidental denylist narrowing would not open tool authority — the empty
allowlist is the primary control. No action required.

## T-QK-02 — Prompt-injection boundary (T-01-06) — MITIGATED

Untrusted candidate text reaches the model ONLY as the `query({ prompt: candidateText })` user
content (`classifier-runner.ts:100`). The system prompt is passed by **bare reference** to the
fixed const `CLASSIFIER_SYSTEM_PROMPT` (`classifier-runner.ts:90`), never an interpolating
template literal.

`CLASSIFIER_SYSTEM_PROMPT` lives in `src/orchestrator/prompt-boundary.ts:74-102` as a plain
template literal with zero `${…}`. A `git show` diff of the retired
`classifier.ts` `SYSTEM_PROMPT` body against the new const body is **byte-identical** — no wording
weakened, no rule dropped (verified: `diff` returns empty).

The compliance layer never imports this const (confirmed — `classifier.ts` imports only schema +
categories). The guard test proves a sentinel candidate string never appears in `systemPrompt` and
that `prompt` equals the candidate verbatim (`classifier-runner.test.ts:98-114`). The SAND-04
prompt-source guard `INTERPOLATED_SYSTEM_PROMPT` (`prompt-injection-boundary.test.ts:138-145`)
enforces that no orchestrator file assigns an interpolating template to a `system`/`systemPrompt`
field, with a planted-offender self-test (`:181-189`).

## T-QK-03 — Fail-closed envelope, no fail-open path (D-11) — MITIGATED

I traced every failure path from `query()` to a returned `ClassifierDecision`. There is **no code
path where a model-produced `{"decision":"approved"}` survives a failed or timed-out run.**

- **Transport throw / credential failure:** caught by `classifier.ts:127`, drives retry/backoff then
  `CLASSIFIER_UNAVAILABLE_DECISION` (`classifier.ts:134-137`).
- **Timeout (WR-02 fix):** `createClassifierTransport` races stream consumption against an explicit
  timeout that both `controller.abort()`s AND `reject()`s (`classifier-runner.ts:78-85,131-135`); the
  reject wins the `Promise.race` regardless of whether `query()` honors the abort, so a stalled call
  deterministically rejects → envelope fails closed. Non-vacuous fake-timer test
  (`classifier-runner.test.ts:157-175`).
- **Non-success terminal result (WR-01 fix):** the read loop trusts text ONLY when
  `message.subtype === "success"` (`classifier-runner.ts:105-114`); on any non-success terminal
  result (`error_max_turns` / `error_during_execution`) or an absent result, `sawSuccess` stays false
  and the transport returns `""` (`classifier-runner.ts:124-125`). A complete-looking
  `{"decision":"approved"}` emitted by an errored run is therefore discarded. Test asserts `""`
  return on `error_max_turns` even with valid-looking text (`classifier-runner.test.ts:139-148`) and
  on a stream with no success result (`:132-137`).
- **Empty / garbage / non-JSON output:** `extractJsonObject` throws when no `{…}` slice exists or
  `JSON.parse` fails (`classifier.ts:57-64`), caught → fail closed. Prose-with-braces fails closed
  because the sliced substring is not valid JSON.
- **zod shape or refined validation failure:** `throw` on `!shape.success` / `!validation.success`
  (`classifier.ts:92-98,118-124`), caught → fail closed.

The only non-error `return` in `classifyWithSonnet` is a fully zod-validated decision
(`classifier.ts:126`); the function resolves (never throws) on every error path
(`classifier.ts:134-147`). Retry budget + backoff (500/1500 ms) unchanged.

## T-QK-04 — D-12 escalation coercion — MITIGATED

Held-for-review with a non-escalate-eligible category is coerced to `rejected` in the compliance
layer (`classifier.ts:104-114`) AND independently at the gate as belt-and-suspenders
(`gate.ts:106-117`, which also maps a null-category held decision to the fail-closed sentinel). The
gate coercion additionally guards injected fakes and future classifier implementations. Both layers
intact and unchanged in intent.

## T-QK-05 — SDK import confinement (SAND-04 + single-funnel c) — MITIGATED

- `grep "@anthropic-ai/sdk"` (raw Messages API) across `src/`: **no matches** — retired from all of
  `src/`.
- `grep "@anthropic-ai/claude-agent-sdk"` across `src/`: 8 files, **all under `src/orchestrator/`**
  (classifier-runner, sdk-runner, sandbox-process, prompt-boundary, types, index + tests).
- **single-funnel (c)** rewritten to a pure `rawSdkImportOffenders(files)` that must be empty
  (`single-funnel.test.ts:153-155,186-192`), with a synthetic-offender self-test that plants
  `src/rogue/anthropic-rogue.ts` and asserts it is flagged (`:194-202`) — non-vacuous.
- **SAND-04** confinement of `@anthropic-ai/claude-agent-sdk` to `src/orchestrator/` intact
  (`prompt-injection-boundary.test.ts:123-128,155-161`), with a planted `src/ingestion/rogue.ts`
  self-test (`:163-171`) and a non-empty-scan guard (`:150-153`) — non-vacuous. The new
  `classifier-runner.ts` legitimately imports the SDK under the allowed prefix.

## T-QK-06 — Fail-closed when plan credentials absent (accept-safe) — MITIGATED

Two independent fail-closed paths, both with loud warnings:
- **SDK unavailable at boot:** `buildClassifierTransport` catches the dynamic-import failure, logs
  `COMPLIANCE CLASSIFIER UNAVAILABLE — Agent SDK failed to load … FAIL CLOSED` and returns
  `undefined` (`main.ts:1385-1397`). `createApp` then wires neither `fakeClassifier` nor `classifier`
  (`main.ts:324-335`) and emits a second loud warning (`main.ts:326-328`); `classify()` hits the
  `else` branch → `FAIL_CLOSED` (`gate.ts:90-96`).
- **Constructed-but-credential-less transport:** each `query()` call throws → `classifier.ts` catch →
  fail closed.

The `FakeClassifier` seam is preserved (`gate.ts:85-86`, `main.ts:334`) and the entrypoint never
injects a fake, so vitest never touches the real SDK or network (guarded dynamic import keeps the SDK
out of the static/test graph — `classifier-runner.ts:6-9`). `gate-eval.ts` replaced the old
`ANTHROPIC_API_KEY` exit with a plan-credential probe that returns exit 2 (clean skip) when not
logged in (`gate-eval.ts:95-105`), and an all-`classifier-unavailable` run still returns exit 1
(cannot be mistaken for a pass). The stale operator instruction (review WR-03) now correctly points
to `src/orchestrator/prompt-boundary.ts (CLASSIFIER_SYSTEM_PROMPT)` (`gate-eval.ts:197`).

## Secrets posture (improved) — MITIGATED

- No runtime read of a host `ANTHROPIC_API_KEY` for the gate: `grep ANTHROPIC_API_KEY src/` returns
  only doc comments and the **separate, out-of-scope** sandbox build-agent path
  (`SANDBOX_ANTHROPIC_API_KEY`, `sandbox-process.ts:34,44`), which is a distinct billing surface.
- `@anthropic-ai/sdk` is no longer declared in `package.json` (dead dependency removed — resolves
  review IN-01 and shrinks supply-chain surface on the streaming machine).
- No key is logged or required; the gate authenticates via `claude login` plan credits.
- The `secrets-isolation.test.ts` invariant was not touched by this change and remains present
  (`tests/invariants/secrets-isolation.test.ts`); it continues to hold.

---

## Unregistered Flags

None. The SUMMARY.md safety-property list maps 1:1 to the registered T-QK-0x threats; no new attack
surface appeared without a threat mapping.

## Residual (non-blocking) observations

Carried from the deep review, none security-blocking; recorded for completeness:
- **IN-02:** `getGateDecisionJsonSchema()` and schema docstrings in `src/compliance/schema.ts`
  describe the retired Structured-Outputs flow; the function is now dead in production (only
  `schema.test.ts` exercises it). Documentation/cleanup only — no runtime effect on the fail-closed
  envelope.
- **IN-03:** guard test denylist assertion uses `.toContain` rather than the full-set `.toEqual`
  (see T-QK-01) — the empty allowlist is the primary control.

---

_Audited: 2026-07-10 · Scope: commits e4465f2..0b7679e · Verdict: PASS, threats_open = 0_
