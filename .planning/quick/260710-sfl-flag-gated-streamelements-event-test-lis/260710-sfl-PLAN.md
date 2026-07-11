---
phase: quick-260710-sfl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/ingestion/donation-source.ts
  - src/ingestion/donation-source.test.ts
  - src/main.ts
  - .env.example
  - docs/OPERATIONS.md
autonomous: true
requirements: [R1, R2, R3, R4, R5, R6, R7]
must_haves:
  truths:
    - "With SE_ACCEPT_TEST_EVENTS unset (or any value other than the exact string 'true'), event:test payloads are completely ignored — zero behavior change, all 679 existing tests stay green"
    - "With SE_ACCEPT_TEST_EVENTS=true, a well-formed SE dashboard simulated tip flows through the SAME TipActivitySchema/TipEventSchema pipeline and reaches onTip handlers as a normal TipEvent"
    - "With the flag on, a malformed/unrecognized event:test payload is dropped fail-closed (logged, never throws, socket stays up)"
    - "Every accepted test event produces a loud log line at the listener level; enabling the flag produces a prominent TEST MODE warning at adapter construction (boot)"
    - "The flag and the smoke-test procedure are documented (.env.example + docs/OPERATIONS.md) with the NEVER-enable-on-broadcast warning"
  artifacts:
    - path: "src/ingestion/donation-source.ts"
      provides: "Opt-in event:test subscription + fail-closed test-payload normalizer feeding dispatchTipActivity"
      contains: "event:test"
    - path: "src/ingestion/donation-source.test.ts"
      provides: "FakeSocket tests: flag-off ignore, flag-on happy path, flag-on malformed drop, construction-time TEST MODE warning"
      contains: "event:test"
    - path: ".env.example"
      provides: "SE_ACCEPT_TEST_EVENTS documented with NEVER-on-broadcast warning"
      contains: "SE_ACCEPT_TEST_EVENTS"
    - path: "docs/OPERATIONS.md"
      provides: "§9 StreamElements simulated-event smoke-test procedure"
      contains: "SE_ACCEPT_TEST_EVENTS"
  key_links:
    - from: "src/main.ts (buildDonationAdapter)"
      to: "src/ingestion/donation-source.ts (connectStreamElements options)"
      via: "process.env.SE_ACCEPT_TEST_EVENTS === 'true' passed as acceptTestEvents option"
      pattern: "SE_ACCEPT_TEST_EVENTS"
    - from: "event:test handler in makeDonationSource"
      to: "dispatchTipActivity (existing fail-closed pipeline)"
      via: "normalized { type: 'tip', data: <TipEvent candidate> } envelope"
      pattern: "dispatchTipActivity"
---

<objective>
Add an opt-in, flag-gated listener for StreamElements simulated events (`event:test`) so the streamer can smoke-test the live tip pipeline (live gate 04-08's "real tip smoke test" precursor) with zero real money. Today `makeDonationSource` subscribes only to `event`, so the SE dashboard event simulator (which emits `event:test` with a differently-shaped payload) is silently ignored.

Purpose: de-risk the Phase 4 live gate — verify overlay banner / control-window open / revoke end-to-end before any real dollar moves.
Output: gated `event:test` support in donation-source.ts (fail-closed, same zod pipeline), env-flag wiring in main.ts, tests, and docs (.env.example + OPERATIONS.md §9).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/ingestion/donation-source.ts
@src/ingestion/donation-source.test.ts
@.env.example

<interfaces>
<!-- Key contracts the executor needs. Extracted from the codebase — no exploration needed. -->

From src/ingestion/donation-source.ts (existing, to extend):
```typescript
export const TipEventSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  message: z.string(),
  tipId: z.string(),
});
export type TipEvent = z.infer<typeof TipEventSchema>;

// module-private: real events arrive as { type: "tip", data: TipEvent }
const TipActivitySchema = z.object({ type: z.literal("tip"), data: TipEventSchema });

export interface DonationIngestLogger {
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}
export interface DonationEventSource {
  onTip(handler: (tip: TipEvent) => void): void;
  onDisconnect(handler: () => void): void;
  onReady(handler: () => void): void;
}
export interface DonationSocket {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}
// module-private fail-closed dispatcher — REUSE for the test path:
function dispatchTipActivity(raw, handlers, logger?): void

export function makeDonationSource(socket: DonationSocket, jwt: string, logger?: DonationIngestLogger): DonationEventSource
export async function connectStreamElements(jwt: string, logger?: DonationIngestLogger): Promise<DonationEventSource>
```

From src/main.ts:1408 (the ONLY main.ts touch point):
```typescript
async function buildDonationAdapter(logger: Logger): Promise<DonationEventSource | undefined> {
  const jwt = process.env.STREAMELEMENTS_JWT;
  if (!jwt) { /* warn: DONATIONS DISABLED */ return undefined; }
  try {
    const source = await connectStreamElements(jwt, logger);
    logger.info("DONATIONS ARMED — StreamElements realtime socket connecting");
    return source;
  } catch (err) { /* error: DONATIONS UNAVAILABLE */ return undefined; }
}
```

StreamElements `event:test` payload shape (SE dashboard event simulator — differs from real `event`):
```jsonc
// real `event`:      { "type": "tip", "data": { username, displayName, amount, currency, message, tipId } }
// simulator `event:test`: { "listener": "tip-latest", "event": { "name": "fake_donator", "amount": 25, "message": "...", /* currency and _id often ABSENT */ } }
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Flag-gated event:test listener + fail-closed normalizer in donation-source</name>
  <files>src/ingestion/donation-source.ts, src/ingestion/donation-source.test.ts</files>
  <behavior>
    Follow the existing FakeSocket pattern in donation-source.test.ts (fakeSocket() + capturingLogger()). Write these tests FIRST, watch them fail, then implement:
    - Test (a) flag off: makeDonationSource with no options (and with { acceptTestEvents: false }) → fake.fire("event:test", VALID_TEST_ENVELOPE) → onTip handler never called, nothing thrown. (Prefer implementing as "handler not subscribed when flag off" — socket.on("event:test", ...) is only registered when acceptTestEvents is true — but the test asserts the observable: no onTip call.)
    - Test (b) flag on, happy path: makeDonationSource(fake.socket, "jwt", logger, { acceptTestEvents: true }) → fire "event:test" with { listener: "tip-latest", event: { name: "fake_donator", amount: 25, message: "build a slot machine" } } → onTip receives a TipEvent with username === "fake_donator", displayName === "fake_donator", amount === 25, currency === "USD" (default), message === "build a slot machine", tipId matching /^se-test-/. AND the capturing logger recorded a warn containing "SE TEST EVENT accepted — SE_ACCEPT_TEST_EVENTS is ON".
    - Test (b2) flag on, explicit fields honored: envelope event carrying currency: "EUR" and _id: "abc" → TipEvent has currency "EUR", tipId "abc" (no defaults clobbering real data).
    - Test (c) flag on, malformed dropped fail-closed: each of — event missing `name`; `amount: -5`; `amount: "25"` (string); `event` not an object; `listener: 42`; payload null; payload a string — fires without throwing, onTip never called, and at least one logger entry recorded for the structurally-unrecognized cases. A recognized-but-non-tip listener ({ listener: "follow-latest", event: {...} }) is dropped SILENTLY (mirrors how the real path drops cheer activities silently).
    - Test (c2) flag on, normalized-but-invalid still fails the REAL pipeline: envelope whose event normalizes to a TipEvent candidate that TipEventSchema rejects (e.g. currency: "EU" — 2 letters, passed through explicitly) → dropped, no onTip call. This proves the test path runs through the SAME TipActivitySchema/TipEventSchema validation, not a parallel lenient one (R2).
    - Test (d) boot warning: constructing makeDonationSource with { acceptTestEvents: true } and a capturing logger immediately records a warn containing "TEST MODE: simulated StreamElements events will open real control windows — NEVER enable during a broadcast". Constructing WITHOUT the option records no such warn.
  </behavior>
  <action>
    In src/ingestion/donation-source.ts:
    1. Add an exported options type: `export interface DonationSourceOptions { acceptTestEvents?: boolean }`. Extend signatures backward-compatibly: `makeDonationSource(socket, jwt, logger?, options?)` and `connectStreamElements(jwt, logger?, options?)` (connectStreamElements just forwards options to makeDonationSource). No existing call site changes shape — the new params are optional.
    2. Add a module-private zod schema for the simulator envelope (zod-at-the-boundary, same discipline as TipActivitySchema): listener must be a string, event must be an object with `name: z.string()` and `amount: z.number().nonnegative()`; `message`, `currency`, and `_id` optional. Use z.looseObject / passthrough semantics for extra simulator fields (zod ^4 — match whatever zod v4 idiom the codebase's zod version supports; `.loose()` on z.object or z.looseObject).
    3. Add a module-private normalizer `normalizeTestTipEnvelope(raw, logger?): { type: "tip"; data: unknown } | undefined` that: safeParse-wraps in try/catch exactly like dispatchTipActivity does (hostile getters must not throw, T-04-04); on structural parse failure → logger?.warn with a "SE TEST EVENT dropped — unrecognized event:test payload shape" message + return undefined; if `listener` does not start with "tip" → return undefined silently (recognized non-tip, out of scope, mirrors the real path's silent cheer drop); otherwise build a TipEvent CANDIDATE: username = event.name, displayName = event.name, amount = event.amount, message = event.message ?? "", currency = event.currency ?? "USD", tipId = event._id ?? `se-test-${Date.now()}`. Return `{ type: "tip", data: candidate }`. Do NOT validate the candidate here — validation belongs to the shared pipeline (next point).
    4. In makeDonationSource, when `options?.acceptTestEvents === true` (strict boolean check): (a) immediately log the construction-time warning verbatim: `logger?.warn("TEST MODE: simulated StreamElements events will open real control windows — NEVER enable during a broadcast")`; (b) register `socket.on("event:test", (raw) => { const envelope = normalizeTestTipEnvelope(raw, logger); if (!envelope) return; logger?.warn({ raw: <safe summary: listener only> }, "SE TEST EVENT accepted — SE_ACCEPT_TEST_EVENTS is ON"); dispatchTipActivity(envelope, tipHandlers, logger); })`. Reusing dispatchTipActivity means the candidate passes through TipActivitySchema → TipEventSchema — the SAME fail-closed pipeline as real events (R2) — and handler throws stay isolated. Nuance for the "accepted" log: it fires when the envelope is recognized; a candidate that then fails TipEventSchema is dropped by dispatchTipActivity — acceptable, but ALSO acceptable (and slightly better) to log "accepted" only after building the envelope and let test (c2) assert no onTip call; either ordering satisfies R3, pick one and keep the test consistent. When the flag is absent/false, do NOT register the "event:test" handler at all — zero subscription, zero behavior delta (R4).
    5. Update the module doc comment (top of file) with one short paragraph on the gated test path.
    Keep the diff tight: no refactors of existing functions beyond the optional params. Match existing comment style (threat-ID references, fail-closed rationale). RED commit (failing tests) then GREEN commit (implementation), per TDD cycle.
  </action>
  <verify>
    <automated>npx vitest run src/ingestion/donation-source.test.ts</automated>
  </verify>
  <done>All new tests (a, b, b2, c, c2, d) pass; all 8 pre-existing donation-source tests still pass unmodified; event:test handler is provably not subscribed when the flag is off.</done>
</task>

<task type="auto">
  <name>Task 2: main.ts flag wiring + .env.example + OPERATIONS.md smoke-test procedure</name>
  <files>src/main.ts, .env.example, docs/OPERATIONS.md</files>
  <action>
    1. src/main.ts — buildDonationAdapter (line ~1408) ONLY: read `const acceptTestEvents = process.env.SE_ACCEPT_TEST_EVENTS === "true";` (strict string comparison — any other value, including "1"/"TRUE", is OFF; note this in a comment). Pass `{ acceptTestEvents }` as the new third options arg to connectStreamElements. When acceptTestEvents is true, additionally log at the composition root BEFORE connecting: `logger.warn("TEST MODE: SE_ACCEPT_TEST_EVENTS=true — simulated StreamElements events will open real control windows — NEVER enable during a broadcast")` (belt-and-braces with the adapter-level warning; the adapter-level one is the tested guarantee). No other main.ts changes.
    2. .env.example — in the "--- Phase 4: paid influence & chaos mode ---" block, directly under the STREAMELEMENTS_JWT entry (line ~95), add:
       - comment lines explaining: opt-in smoke-test flag; when "true" the app also accepts StreamElements DASHBOARD SIMULATED events (event:test) and routes them through the real tip pipeline — simulated tips open REAL control windows; all-caps warning: NEVER enable during a broadcast; default off — leave blank/absent for normal operation; only the exact string "true" enables it.
       - `SE_ACCEPT_TEST_EVENTS=`
    3. docs/OPERATIONS.md — OPERATIONS.md currently has sections 1–8 and NO StreamElements section, so add a new `## 9. StreamElements Tip Smoke Test (Simulated Events)` at the end of the file (this becomes "the StreamElements material" per R6). Content — short, runbook-style, matching the existing sections' voice:
       - What it is: zero-money end-to-end test of the tip → free-reign window pipeline using the SE dashboard event simulator; the simulator emits `event:test` (not `event`), which the app ignores unless SE_ACCEPT_TEST_EVENTS=true.
       - Prominent warning box/line: TEST MODE opens REAL control windows — never enable during a broadcast; the app logs a loud TEST MODE warning at boot and on every accepted simulated tip.
       - Procedure (numbered): 1) set `SE_ACCEPT_TEST_EVENTS=true` in .env; 2) restart the app; confirm the boot log shows the TEST MODE warning; 3) open the StreamElements dashboard → event simulator (streamelements.com dashboard, "Emulate" / test-event widget) → send a test tip; 4) verify: console shows "SE TEST EVENT accepted", the overlay shows the free-reign banner/countdown, and the console window opens; exercise revoke from the operator console; 5) unset/blank the flag and restart — confirm the boot warning is gone.
       - One line noting simulated tips carry a synthetic tipId (`se-test-*`) and default currency USD when the simulator omits it, so test windows are distinguishable in the audit log.
    4. Run the full gates: `npx vitest run` (expect 679 + new tests, all green — including the single-funnel and secrets-isolation invariant suites, non-vacuously), `npx tsc --noEmit`, `npx biome check .` (fix any drift).
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>Full suite green (all pre-existing 679 tests + new donation-source tests); tsc and biome clean; SE_ACCEPT_TEST_EVENTS documented in .env.example with the NEVER-on-broadcast warning; OPERATIONS.md §9 contains the 5-step smoke-test procedure; main.ts diff confined to buildDonationAdapter.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| StreamElements realtime socket → app | Untrusted third-party input; `event:test` payloads are attacker-influenceable to the same degree as real `event` payloads (same JWT-authenticated socket) |
| .env flag → runtime behavior | Operator misconfiguration surface: flag left on during a broadcast |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-sfl-01 | Tampering | event:test payload (donation-source.ts) | mitigate | Fail-closed normalizer (zod safeParse in try/catch, T-04-04 discipline) + the candidate re-validated by the SAME TipActivitySchema/TipEventSchema pipeline via dispatchTipActivity — no parallel lenient path (test c2 proves it) |
| T-sfl-02 | Elevation of Privilege | Flag left on during broadcast → simulated tips open real control windows | mitigate | Strict `=== "true"` opt-in, default off; loud TEST MODE warning at construction (tested) + composition root; NEVER-on-broadcast warning in .env.example and OPERATIONS.md §9 step 5 (unset + restart + verify warning gone) |
| T-sfl-03 | Repudiation | Test-sourced windows indistinguishable from real ones in logs/audit | mitigate | "SE TEST EVENT accepted" warn on every accepted event + synthetic `se-test-*` tipId marks test rows in the audit trail |
| T-sfl-04 | Denial of Service | Malformed event:test flood killing the socket handler | mitigate | dispatchTipActivity's existing handler-isolation try/catch reused; normalizer never throws (early-return drops) |
| T-sfl-SC | Tampering | npm installs | accept | No new dependencies in this change — zero package installs |
</threat_model>

<verification>
- `npx vitest run` — full suite green (679 pre-existing + new), including tests/invariants/single-funnel.test.ts and the secrets-isolation invariants (non-vacuous: they run against real source files, unchanged by this diff except donation-source.ts additions)
- `npx tsc --noEmit` clean
- `npx biome check .` clean
- Grep gate: `grep -c "event:test" src/ingestion/donation-source.ts` ≥ 1 and `grep -c "SE_ACCEPT_TEST_EVENTS" src/main.ts .env.example docs/OPERATIONS.md` ≥ 1 each
</verification>

<success_criteria>
- Flag absent/false → zero behavior change: no event:test subscription exists, all pre-existing tests pass unmodified (R1, R4)
- Flag "true" → simulated tips normalize fail-closed and flow through the SAME zod pipeline to onTip (R2), with loud per-event and boot-time TEST MODE logging (R3)
- Tests a/b/c/d from R5 implemented on the FakeSocket pattern, plus b2/c2 hardening tests
- .env.example + OPERATIONS.md §9 document the flag and 5-step smoke-test procedure with the NEVER-on-broadcast warning (R6)
- Diff confined to the 5 listed files; pino/zod/injected-fake style preserved (R7)
</success_criteria>

<output>
Create `.planning/quick/260710-sfl-flag-gated-streamelements-event-test-lis/260710-sfl-SUMMARY.md` when done.
</output>
