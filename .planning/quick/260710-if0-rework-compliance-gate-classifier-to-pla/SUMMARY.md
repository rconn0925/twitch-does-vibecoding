# Quick Plan Summary: Rework Compliance-Gate Classifier to Plan Billing

**One-liner:** The live compliance gate now classifies via the Claude Agent SDK
`query()` (plan/subscription billing through `claude login`) instead of the metered
raw Anthropic Messages API — every safety property (fail-closed sentinel, retry+backoff,
zod shape/refined re-validation, D-12 coercion, T-01-06 prompt boundary) preserved, and
both machine invariants (SAND-04 + single-funnel (c)) stay green and non-vacuous.

## Outcome

All 7 ordered tasks executed exactly as planned, one atomic commit each (plus two small
fix-forward commits during the acceptance gate). The raw `@anthropic-ai/sdk` Messages API
is retired from all of `src/`; the plan-billed `query()` transport lives only under
`src/orchestrator/`; `src/compliance/` imports no Anthropic SDK. `ANTHROPIC_API_KEY` is no
longer required (and must stay UNSET on the streaming machine).

## Acceptance Gate (run from project root)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | CLEAN |
| `npx vitest run` | 60 files, 678 tests — all passing |
| `npx biome check src tests` | CLEAN (exit 0, no infos) |

Spot-checks (from the plan's `<verification>`):
- `grep -rn "@anthropic-ai/sdk" src/` -> nothing (raw Messages API gone from `src/`).
- `grep -rn "@anthropic-ai/claude-agent-sdk" src/` -> only `src/orchestrator/` files.

Both invariants pass NON-VACUOUSLY (synthetic-offender self-tests present + green):
- `single-funnel.test.ts` -> `(c) ... imported NOWHERE in src/` and `(c self-test) FLAGS a planted src/rogue/anthropic-rogue.ts import`.
- `prompt-injection-boundary.test.ts` (SAND-04) -> `(confinement) ... ONLY under src/orchestrator/`, `(self-test) FLAGS a planted src/ingestion/rogue.ts`, `(prompt-source guard)`, and its planted-interpolation self-test.

## Safety Properties Preserved

- Fail-closed, never fail-open. Any JSON parse/validation error, transport throw, or
  timeout resolves to `CLASSIFIER_UNAVAILABLE_DECISION` (rejected). No fail-open branch
  exists; the retry budget + backoff (500ms/1500ms) and D-12 held->rejected coercion are
  byte-for-byte unchanged in `classifier.ts`.
- Zero tool authority on the gate call. `createClassifierTransport` runs `query()` with
  `allowedTools: []` + a defensive denylist and `maxTurns: 1`; a network-free guard test
  asserts all four (no-tools, single-turn, Sonnet-pinned, zero interpolation).
- T-01-06 prompt boundary. Candidate/chat text travels ONLY as the query `prompt`
  (user content); `systemPrompt` is `CLASSIFIER_SYSTEM_PROMPT` by bare reference with zero
  `${...}`, satisfying the SAND-04 prompt-source guard.
- Tests stay network-free. The `FakeClassifier` gate path and injected `queryFn` /
  `ClassifierTransport` seams mean vitest never touches the real SDK or network.
- Model stays Sonnet (`GATE_MODEL`, default `claude-sonnet-5`) — documented D-1 exception
  to the Fable policy. Only billing/transport changed.

## Files Changed

Created:
- `src/orchestrator/classifier-runner.ts` — plan-billed, tools-disabled, single-turn Sonnet transport (candidate text -> raw model text).
- `src/orchestrator/classifier-runner.test.ts` — network-free guard test (9 tests).

Modified:
- `src/orchestrator/prompt-boundary.ts` — added `CLASSIFIER_SYSTEM_PROMPT` (verbatim, zero interpolation; documents D-1).
- `src/compliance/classifier.ts` — dropped `@anthropic-ai/sdk`, `classifierDepsFromEnv`, local `SYSTEM_PROMPT`; `ClassifierDeps` now carries an injected `ClassifierTransport`; tolerant JSON extraction (strip fences/prose) feeds the existing zod shape -> D-12 -> refined path.
- `src/compliance/gate.ts` — doc-comment only (transport wording).
- `src/compliance/classifier.test.ts` — injected fake transport (raw JSON strings/throws); added tolerant-extraction cases.
- `src/compliance/classifier.contract.test.ts` — removed `@anthropic-ai/sdk`; pins the new transport contract (bare/fenced/prose JSON parse; fail-closed).
- `src/main.ts` — `buildClassifierTransport` guarded dynamic import; boot `Promise.all` threads `classifierTransport` into `createApp`; gate deps use it; loud warning + fail-closed when absent; `classifierDepsFromEnv` removed.
- `scripts/gate-eval.ts` — routes through `createClassifierTransport`; one-shot plan-credential probe replaces the `ANTHROPIC_API_KEY` exit-2; header rewritten (plan billing).
- `tests/invariants/single-funnel.test.ts` — check (c) rewritten to `rawSdkImportOffenders(files)` must be empty, with a synthetic-offender self-test.
- `.env.example`, `README.md`, `docs/OPERATIONS.md`, `.planning/STATE.md` — billing docs now describe plan-credit auth via `claude login`, no required `ANTHROPIC_API_KEY`.

## Commits (in order)

| SHA | Task | Message |
| --- | --- | --- |
| `e4465f2` | 1 | feat: add shared CLASSIFIER_SYSTEM_PROMPT to prompt-boundary |
| `83d28e4` | 2 | feat: plan-billed classifier transport under src/orchestrator |
| `e81c624` | 3 | feat: compliance gate uses injected transport, no Anthropic SDK |
| `2d1a79a` | 4 | feat: wire plan-billed classifier transport into main.ts |
| `c033be6` | 5 | feat: route gate-eval through the plan-billed transport |
| `a3d4340` | 6 | test: single-funnel (c) asserts zero raw-SDK imports in src/ |
| `3a8e068` | 7 | docs: billing is Claude-plan credits via claude login, no API key |
| `2bd62a3` | gate | style: use join() over string concat in classifier test fences |
| `0d41af4` | gate | docs: drop raw-SDK package literal from runner doc comment |

## Deviations from Plan

1. [Rule 3 — no-op] `gate.test.ts` needed no change. The plan listed it in Task 3's
   files "in case" a case constructed `ClassifierDeps` with `anthropic`. It doesn't — it only
   uses the `fakeClassifier` path — so it was left untouched (verified by grep). No behavior change.

2. [Task 3, within plan intent] Re-scoped the `classifier.test.ts` "boundary" describe.
   The old boundary test asserted on the SDK request's `messages`/`system` fields, which no
   longer exist in this layer. Per the plan's own design (item 3 + Task 2), the
   system-prompt/tool-authority boundary now lives in `classifier-runner.test.ts`; the
   compliance-layer boundary test now asserts the transport receives ONLY `candidate.text`.

3. [Acceptance fix-forward] Two extra commits during the gate.
   - `2bd62a3` (style): biome flagged two `useTemplate` infos on the test fence strings.
     Biome already exited 0 (infos don't fail), but the user asked to apply biome fixes — rewrote
     the concatenated fence as `["```json", X, "```"].join("\n")` (concat-free, no escaped backticks).
   - `0d41af4` (docs): a doc comment in `classifier-runner.ts` contained the literal string
     `@anthropic-ai/sdk` (describing what NOT to use). The invariant already passed (it strips
     comments), but the plan's literal spot-check `grep -rn "@anthropic-ai/sdk" src/` expects
     nothing — reworded to "raw Anthropic Messages API" so the grep is truly empty. No logic change.

No architectural changes (Rule 4) were needed; no packages were installed (the Agent SDK was
already a dependency). No authentication gates were hit (all tests are network-free; the live
`gate:eval` / `claude login` path is a documented human step, not part of this execution).

## Self-Check

- `src/orchestrator/classifier-runner.ts` — FOUND
- `src/orchestrator/classifier-runner.test.ts` — FOUND
- `.planning/quick/260710-if0-rework-compliance-gate-classifier-to-pla/SUMMARY.md` — FOUND (this file)
- All 9 commits present in `git log` — FOUND

Self-Check: PASSED
