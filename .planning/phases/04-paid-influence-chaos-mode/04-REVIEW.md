---
phase: 04-paid-influence-chaos-mode
reviewed: 2026-07-10T00:00:00Z
depth: deep
files_reviewed: 26
files_reviewed_list:
  - src/control-window/control-window.ts
  - src/control-window/duration.ts
  - src/control-window/persistence.ts
  - src/pipeline/paid-window.ts
  - src/pipeline/chaos.ts
  - src/chaos/selector.ts
  - src/ingestion/donation-source.ts
  - src/ingestion/redemption-source.ts
  - src/ingestion/twitch-auth.ts
  - src/ingestion/narration.ts
  - src/operator-console/server.ts
  - src/operator-console/public/console.js
  - src/overlay/server.ts
  - src/overlay/public/overlay.js
  - src/audit/record.ts
  - src/audit/schema.sql
  - src/shared/types.ts
  - src/shared/events.ts
  - src/main.ts
  - tests/invariants/paid-chaos-separation.test.ts
  - tests/invariants/single-funnel.test.ts
  - tests/e2e/paid-window-loop.e2e.test.ts
  - tests/e2e/chaos-mode.e2e.test.ts
  - src/control-window/control-window.test.ts
  - src/operator-console/server.test.ts
findings:
  critical: 3
  warning: 5
  info: 3
  total: 11
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-07-10
**Depth:** deep
**Files Reviewed:** 26
**Status:** issues_found

## Summary

Reviewed the Paid Influence & Chaos Mode phase with an adversarial focus on the two
things that make this phase load-bearing: real money and Twitch ToS/sweepstakes-law
compliance. The core single-funnel invariant holds up well — I traced every paid and
chaos instruction and confirmed the ONLY routes to `taskQueue.enqueue` are
`pipeline/paid-window.ts`, `pipeline/chaos.ts`, and `pipeline/round.ts`, all of which
re-enter the identical `classify()` gate; there is no ungated or second enqueue path.
The `!build` interception in `main.ts` delegates to `controlWindow.submitInstruction`
and never enqueues directly. The D-08 paid↔chaos source-scan separation invariant is
genuinely non-vacuous (word-anchored regex, two-direction sabotage self-test,
non-empty guards). Crash-safe `endsAtMs` re-arm-of-remainder is correctly implemented
and tested. Coarse overlay projection (donor name + deadline only, textContent,
truncated) is clean — no amount/currency/message reaches the wire.

However, three defects undercut the phase's central promise and its compliance ledger:

1. A paid tip that arrives while the stream is not IDLE (a **voting round or a build in
   progress** — the common case) is denied with **no audit row** and a **factually wrong
   chat message**, violating the never-silent doctrine for real money.
2. The console revoke route writes a **second** `window_revoked` audit row (the real
   `ControlWindow.revoke()` already writes one), and the two rows carry **different donor
   identifiers** — corrupting the compliance ledger. The unit test masks this with a fake
   whose `revoke()` doesn't record.
3. Paid and chaos instructions are gated + enqueued but **never built** — no code path
   triggers `startBuild` for them — so "money buys guaranteed control" (PAID-01) is
   unmet, and chat is narrated "building @donor's pick" for a build that never starts.

## Critical Issues

### CR-01: Paid tip denied while not IDLE is unaudited and narrated dishonestly

**File:** `src/control-window/control-window.ts:190-196` (and `src/main.ts:484-491, 508-515`)
**Issue:** `open()` writes a `window_denied` audit row for the `window-active` and
`cooldown` denials, but the `not-idle` branch throws WITHOUT `recordWindowDenied`:

```ts
if (this.#machine.mode !== "IDLE") {
  this.#logger?.warn(...);            // pino only — NOT the audit ledger
  throw new ControlWindowError("not-idle");
}
```

A tip that arrives during a `VOTING_ROUND` or `BUILD_IN_PROGRESS` (both routine, both
frequent) therefore leaves **no trace in `audit_log`** — the compliance record of truth
(COMP-05) has no record that a paid instruction was turned away. `recordWindowDenied`'s
`reason` enum is even typed `"already-active" | "cooldown"` only, so the schema never
anticipated this case. Compounding it, `main.ts` maps every non-cooldown
`ControlWindowError` to `windowDeniedActive()`, so the donor is told *"a control window is
already running, so this one can't open. One window at a time"* when in fact **no window is
running** — a round or build is. For a real-money feature the money event vanishes from
the ledger with an actively false explanation.

**Fix:** Record the denial for the not-idle case too, and narrate the true reason:

```ts
if (this.#machine.mode !== "IDLE") {
  recordWindowDenied(this.#db, {
    trigger: request.trigger,
    donorIdentifier: request.donorIdentifier,
    reason: "not-idle",              // widen the reason union + schema comment
    streamMode: this.#machine.mode,
  });
  this.#logger?.warn({ donor: request.donorIdentifier, mode: this.#machine.mode },
    "control window request denied — stream not idle");
  throw new ControlWindowError("not-idle");
}
```

Add a `windowDeniedNotIdle(donor)` narrator beat (or branch on `err.reason === "not-idle"`
in `main.ts`) so the chat copy is honest ("the show is mid-round/mid-build — try again in
a bit"), not "a window is already running."

### CR-02: Console revoke writes a duplicate, donor-inconsistent `window_revoked` row

**File:** `src/operator-console/server.ts:696-706` (with `src/control-window/control-window.ts:288-292`, wired in `src/main.ts:806-809`)
**Issue:** The console revoke route calls `deps.controlWindow.revoke()` — which in
production is the real `ControlWindow.revoke()` that already writes a `window_revoked`
audit row — and then writes a SECOND row itself:

```ts
deps.controlWindow?.revoke();          // ControlWindow.revoke() → recordWindowRevoked (row #1)
recordWindowRevoked(db, {              // row #2, from the console
  trigger: snapshot.trigger,
  donorIdentifier: snapshot.donorDisplayName,   // ← display name
  streamMode: machine.mode,
});
```

Every streamer revoke therefore double-counts in the ledger. Worse, the two rows disagree
on the donor: `ControlWindow.revoke()` records `window.donorIdentifier` (the stable
key — `tip.username` / redemption `user_id`), while the console records
`snapshot.donorDisplayName` (the mutable/spoofable display name). The compliance ledger
ends up with two revoke events for one action, attributed to two different identities.
The unit test at `server.test.ts:243-268` asserts exactly one row, but only because
`fakeControlWindow.revoke()` (line 236) does not record — so the test passes while the
production path is broken (vacuous coverage; see WR-04).

**Fix:** The revoke audit row is the FSM's responsibility (it already writes it). Remove
the duplicate write from the console route entirely:

```ts
if (snapshot) {
  deps.controlWindow?.revoke();       // this already audits, with the stable identifier
  pushState();
  res.json({ revoked: true, controlWindow: deps.controlWindow?.snapshot() ?? null });
  return;
}
```

If the console must own the audit instead, then `ControlWindow.revoke()` should NOT record
and the console should use `snapshot`'s stable identifier — but exactly one writer, one
consistent identifier.

### CR-03: Paid and chaos instructions are gated + queued but never built (PAID-01 / CHAOS-01 unmet)

**File:** `src/pipeline/paid-window.ts:71`, `src/pipeline/chaos.ts:90`, `src/main.ts:329-348, 861-870`
**Issue:** The build trigger is winner-only. `startBuild` is invoked exclusively from
`onWinnerQueued` (`main.ts:869`), which is called only from the RoundManager's
`enqueueWinner` wrapper (`main.ts:346`). The paid funnel (`paid-window.ts:71
taskQueue.enqueue`) and chaos funnel (`chaos.ts:90 taskQueue.enqueue`) enqueue their task
but nothing ever hands that task to `buildSession.startBuild`, and nothing transitions the
machine into `BUILD_IN_PROGRESS` for them. Result: a donor pays, the `!build` instruction
clears the gate and lands in the queue — and then sits there forever. On a live money
stream this means "money buys GUARANTEED control" (PAID-01/goal) is not delivered: the
donor paid and nothing happens on screen.

It is also a broadcast-honesty defect: `main.ts:702` narrates *"Locked in — building
@Bob's pick"* (`instructionAccepted`) and `narration.ts:342` narrates *"Chaos pick … —
building it now"*, both announcing a build that never starts. The `paid-window-loop` e2e
(only asserts `taskQueue.list().length === 1`) and `chaos-mode` e2e (same) pass precisely
because neither injects a build engine — so the tests are consistent with the gap rather
than catching it.

This is documented as a known limitation in 04-07, but it defeats the phase's core value
proposition, so it is flagged at BLOCKER severity for a scope decision before shipping to
a live paid audience.

**Fix:** Give the paid and chaos enqueue paths the same winner→build trigger the round has.
E.g. have `controlWindow.submitInstruction` / `chaos.pick` return the queued task id and, in
`main.ts`, drive a `FREE_REIGN_WINDOW`/`CHAOS_MODE`→`BUILD_IN_PROGRESS` transition +
`buildSession.startBuild(task)` (mirroring `onWinnerQueued`). Until the build actually
starts, do NOT narrate "building" — narrate "queued" so chat isn't told a lie.

## Warnings

### WR-01: Chaos mode has no production trigger for `pick()` — it is inert on stream

**File:** `src/main.ts:540-557` (definition), no production caller
**Issue:** `chaos.pick()` is exposed on the `AppHandle` but nothing in `src/` ever calls
it (a grep for `.pick()` finds only the definition and the returned handle). The console
`chaos` seam exposes only `enabled()` and `toggle()`. So in production, enabling chaos mode
flips the pill to `CHAOS`, blocks voting (D-05), and then… produces no pick and no build.
Only the e2e test drives `app.chaos.pick()` directly. CHAOS-01 ("the next build is a random
pick from the approved pool") is therefore non-functional outside tests, independent of
CR-03.
**Fix:** Wire a streamer-facing trigger — a console `POST /api/chaos/pick` route (or an
auto-pick on toggle-on) that calls `chaos.pick()` — so a build is actually selected while
chaos mode is active.

### WR-02: Tip currency is validated then ignored; duration mapping and label assume USD

**File:** `src/ingestion/donation-source.ts:33` (`currency`), `src/control-window/duration.ts:49`, `src/control-window/control-window.ts:454-457`, `src/main.ts:478-482`
**Issue:** `TipEventSchema` captures and validates `currency` (`z.string().length(3)`), but
`amountToDurationSeconds` and the console label use the raw `amount` number with no currency
normalization, and the label hardcodes `$`:

```ts
return `$${amountOrCost.toFixed(2)} -> ${formatMmss(durationMs)} window ...`;  // control-window.ts:456
windowNarrator?.windowOpenedDonation(tip.displayName, `$${tip.amount.toFixed(2)}`, ...);  // main.ts:481
```

A tip of `5` in a weak currency (e.g. 5 JPY ≈ $0.03) buys the identical 60s window as a $5
USD tip, and every tip is displayed/narrated to viewers as dollars regardless of the actual
currency. For a real-money influence feature this is a fairness/monetization hole and a
public mislabel.
**Fix:** Either normalize `amount` to a single base currency before the duration mapping
(FX table or minor-unit conversion) or reject/least-favorably-treat non-USD tips, and format
the label/narration using the actual `currency` rather than a hardcoded `$`.

### WR-03: Per-donor cooldown is in-memory only — a restart resets the anti-abuse guard

**File:** `src/control-window/control-window.ts:134, 197-211, 239`
**Issue:** The active window is crash-safe (persisted `control_windows` row, restored on
boot), but the per-donor cooldown lives solely in `#lastGrantedAtMs = new Map<...>()`. It is
never persisted and `restore()` doesn't rebuild it. A donor who just consumed a window can,
after any process restart (plausibly a mid-show crash-restart), immediately open another —
the D-04 cooldown is silently bypassed. The one-at-a-time guard survives a restart; the
cooldown does not.
**Fix:** Derive cooldown state from the durable ledger on `restore()` — e.g. read the most
recent `opened_at_ms`/`closed_at_ms` per `donor_identifier` from `control_windows` (or the
`window_opened` audit rows) and seed `#lastGrantedAtMs`, so the cooldown is honored across a
restart.

### WR-04: `server.test.ts` revoke test is vacuous w.r.t. the production double-row bug

**File:** `src/operator-console/server.test.ts:231-268`
**Issue:** `fakeControlWindow.revoke()` (line 236) flips the snapshot to null but does NOT
write an audit row, whereas the real `ControlWindow.revoke()` does. The test then asserts
exactly one `window_revoked` row (line 256) — a condition only the fake satisfies. It thus
gives false confidence that the revoke ledger write is correct while CR-02's production
double-write goes uncaught. This is the kind of seam-fake divergence that hides real bugs.
**Fix:** After fixing CR-02, add a test that exercises the REAL `ControlWindow` through the
console route (or an integration assertion in the paid-window e2e) verifying exactly one
`window_revoked` row with the stable donor identifier.

### WR-05: `amount_or_cost` typed INTEGER but receives fractional dollars; schema comment says "minor units"

**File:** `src/audit/schema.sql:113`, `src/control-window/persistence.ts:42-59`, `src/main.ts:474`
**Issue:** `control_windows.amount_or_cost INTEGER NOT NULL  -- tip amount (minor units)`
contradicts the actual value flow: donation `amount` is dollars (e.g. `5`, and the label
formats `$5.00`, so `4.50` is representable and expected), passed straight into the INTEGER
column. SQLite's INTEGER affinity stores a non-integer as REAL rather than rejecting it, so
this doesn't crash, but the "minor units" comment is wrong and the column type implies an
integer contract the code doesn't honor. A future reader relying on "minor units" (i.e.
cents) would misread every stored amount by 100×.
**Fix:** Correct the schema comment to state the stored unit is whole-currency dollars /
points, and either change the column to REAL or convert donation amounts to true minor
units (cents) before persisting so INTEGER is honest.

## Info

### IN-01: A window restored live on boot gets no 30s-left beat and no re-narration

**File:** `src/control-window/control-window.ts:310-346`, `src/main.ts:420, 439-448`
**Issue:** `restore()` re-arms the expiry timer for the remaining time but does not arm the
`window30sLeft` beat, and `windowNarrator` isn't even assigned yet at `restore()` call time
(`main.ts:420` runs before the chat block at ~585). A ≥60s window that survives a crash
therefore silently skips its "30 seconds left" beat. Minor UX honesty gap; the window itself
behaves correctly.
**Fix:** After a live restore, if `remaining > 30_000`, re-arm the 30s beat from `main.ts`
once the narrator exists.

### IN-02: Paid↔chaos separation regex omits several money words

**File:** `tests/invariants/paid-chaos-separation.test.ts:39`
**Issue:** `PAYMENT_TOKEN` matches `donation|tip|cheer|streamelements|redemption|channel_points`
but not `pay|money|donor|amount|currency`. The chaos path could reference, say, `amount` or
`donorIdentifier` without tripping the scan. Low risk today (the chaos modules reference none
of these), but the guard is narrower than the D-08 intent implies.
**Fix:** Consider adding the additional money-adjacent tokens to `PAYMENT_TOKEN` for
defense-in-depth, keeping the word-anchoring.

### IN-03: `window_opened` audit row records the post-transition mode

**File:** `src/control-window/control-window.ts:241-249`
**Issue:** `open()` calls `this.#machine.transition("FREE_REIGN_WINDOW")` (line 241) before
`recordWindowOpened(..., streamMode: this.#machine.mode)` (line 243-248), so the row's
`stream_mode` is `FREE_REIGN_WINDOW` (the new mode) rather than the pre-open `IDLE`. This is a
defensible reading of "mode at time of event," but it differs from the intuitive "mode the
request arrived in." Cosmetic ledger semantics only.
**Fix:** If the ledger should reflect the mode the request arrived in, capture
`this.#machine.mode` before the transition and pass that.

---

_Reviewed: 2026-07-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
