---
phase: 02-chat-vote-loop
reviewed: 2026-07-09T00:00:00Z
depth: standard
files_reviewed: 45
files_reviewed_list:
  - .env.example
  - docs/OPERATIONS.md
  - package.json
  - src/audit/record.test.ts
  - src/audit/record.ts
  - src/audit/schema.sql
  - src/ingestion/chat-sender.test.ts
  - src/ingestion/chat-sender.ts
  - src/ingestion/command-parser.test.ts
  - src/ingestion/command-parser.ts
  - src/ingestion/narration.test.ts
  - src/ingestion/narration.ts
  - src/ingestion/suggest-intake.test.ts
  - src/ingestion/suggest-intake.ts
  - src/ingestion/twitch-auth.test.ts
  - src/ingestion/twitch-auth.ts
  - src/ingestion/twitch-chat.test.ts
  - src/ingestion/twitch-chat.ts
  - src/main.ts
  - src/operator-console/public/console.css
  - src/operator-console/public/console.js
  - src/operator-console/public/index.html
  - src/operator-console/server.ts
  - src/overlay/public/index.html
  - src/overlay/public/overlay.css
  - src/overlay/public/overlay.js
  - src/overlay/server.test.ts
  - src/overlay/server.ts
  - src/pipeline/round.test.ts
  - src/pipeline/round.ts
  - src/queue/pool.test.ts
  - src/queue/pool.ts
  - src/shared/events.ts
  - src/shared/types.ts
  - src/state-machine/round.test.ts
  - src/state-machine/round.ts
  - tests/e2e/chat-wiring.e2e.test.ts
  - tests/e2e/console-flows.e2e.test.ts
  - tests/e2e/oauth-routes.e2e.test.ts
  - tests/e2e/recovery.e2e.test.ts
  - tests/e2e/round-flow.e2e.test.ts
  - tests/invariants/chat-sender.test.ts
  - tests/invariants/dom-safety.test.ts
  - tests/invariants/scan-helpers.ts
  - tests/invariants/single-funnel.test.ts
findings:
  critical: 3
  warning: 6
  info: 8
  total: 17
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-07-09
**Depth:** standard
**Files Reviewed:** 45
**Status:** issues_found

## Summary

Phase 2 connects untrusted Twitch chat to the Phase 1 safety spine. The core
funnel discipline holds up well under adversarial reading: I found **no funnel
bypass** — the winner path (`src/pipeline/round.ts`) goes through
`toQueuedTask` on the stored approved result, the invariant scans genuinely
cover `sendChatMessage` / `.enqueue(` / `toQueuedTask` sole-caller rules, both
browser surfaces are textContent-only with a machine-checked DOM-safety scan,
zod sits at the EventSub boundary, votes are keyed by chatterId with a real
SQLite write-through upsert, and the OAuth state nonce is single-use with a
TTL and burned before the code exchange.

However, three Critical issues remain. Two are correctness gaps on the exact
live-reliability paths this phase exists to protect: a halt-frozen round that
survives a process restart is **unrecoverable and can be silently corrupted**
by starting a new round, and the runbook's "re-authorize while running, no
restart needed" flow is **not implemented** — the chat pipeline is composed
once at boot and never rebuilt. The third is a classic localhost-server gap:
every Origin/CSRF check on the console compares against the request's own
Host header, so DNS rebinding turns the kill-switch console into a remotely
scriptable surface.

## Critical Issues

### CR-01: Crash-restored frozen round is unrecoverable, and `startRound()` can silently orphan it (data loss)

**File:** `src/state-machine/round.ts:192-199` (triage detection), `src/state-machine/round.ts:207-215` (missing guard), `src/main.ts:228-237`, `docs/OPERATIONS.md:199-206`
**Issue:** `#resume()`/`#discard()` fire only on a live `STATE_CHANGED` event
where the *previous* in-memory mode was `HALTED` (`#lastMode` diffing,
round.ts:192-199). The halt context is never persisted, so after a process
restart with a frozen round (`frozen_remaining_ms` set), the machine boots
`IDLE` and the frozen round restores into memory with **no reachable exit**:

1. Triage is unreachable — `/api/recover` 409s unless mode is `HALTED`, and
   the triage view only renders while HALTED. OPERATIONS.md 6.6's "a round
   frozen by a halt restores frozen and waits for triage" is false after a
   restart: no triage exists.
2. The only escape (press Halt again, then recover) **silently discards** the
   round: recovery's "Resume" goes to `frozen.mode`, which is now `IDLE`, and
   `HALTED→IDLE` triggers `#discard()`. There is no way to resume it.
3. Worse, `startRound()` checks only `mode === IDLE` and `pool >= 2` — it
   never checks `this.#round === null`. With the frozen round in memory and
   mode `IDLE`, a Start Round POST (the client-side disabled button is not a
   server-side guard) succeeds and **overwrites `#round`**: the frozen
   round's candidates (already removed from the pool pre-crash) and its
   acknowledged votes are orphaned, and its `rounds` row stays `status='open'`
   with `frozen_remaining_ms` set forever. Two open rows now exist;
   `restore()` picks the newest by `id DESC`, so the old one is permanently
   stranded. Acknowledged votes and gate-approved candidates are lost —
   directly violating the D2-14 "no acknowledged vote is ever lost" and D-02
   "nothing is deleted" guarantees.

This is the *typical* halt scenario (halt mid-round, then restart the process
while triaging), not an exotic one. `recovery.e2e.test.ts:281-289` pins the
stuck state as correct ("waits for recovery triage") without any test that
triage is actually possible afterwards.
**Fix:**
```ts
// (a) round.ts — startRound() must refuse while ANY round is loaded:
startRound(): RoundSnapshot {
  if (this.#round !== null) throw new RoundStartError("round-active");
  if (this.#machine.mode !== "IDLE") throw new RoundStartError("not-idle");
  ...
}

// (b) main.ts restore block — give a restored frozen round a real exit.
// Safest minimal policy: discard-with-audit at boot (candidates repool,
// row -> 'discarded', ROUND_CLOSED emitted), mirroring #discard():
const restored = round.snapshot();
if (restored?.status === "open" && restored.frozen) {
  round.discardRestoredFrozen(); // new public method wrapping #discard()
  logger.warn({ roundId: restored.roundId },
    "frozen round found at boot with no persisted halt context — discarded, candidates repooled");
}
```
Alternatively persist the halt context and re-enter HALTED at boot so real
triage is available; either way update OPERATIONS.md 6.6 to match.

### CR-02: DNS rebinding defeats every Origin/CSRF/ws check — the console's checks validate against the attacker's own Host header

**File:** `src/operator-console/server.ts:167-183` (CSRF middleware), `src/operator-console/server.ts:216-220` (ws verifyClient), `src/overlay/server.ts:127-131`
**Issue:** All three browser-facing defenses compare the request's `Origin`
to `http://${req.headers.host}` — a self-referential check. A remote page at
`http://attacker.com:4900` whose DNS is rebound to `127.0.0.1` reaches this
server with `Host: attacker.com:4900` and `Origin: http://attacker.com:4900`
(or no preflight at all, since from the browser's perspective the request is
*same-origin*). Both the Origin check and the `application/json` check pass,
and the ws `verifyClient` passes identically. Result: a remote web page can
read the full console state (attacker-authored suggestion texts, review
rationales, halt context) **and issue every state-changing POST** — including
`/api/recover` (remotely un-halting a halted stream), `/api/halt`,
`/api/tasks/:id/veto`, `/api/round/start`, and `/api/dev/submit`. The server
never validates that `Host` is actually a loopback name. Browser
private-network-access mitigations are not universally deployed and OBS CEF
has none; the fix is one cheap middleware.
**Fix:**
```ts
// First middleware on BOTH servers (console + overlay):
app.use((req, res, next) => {
  const host = (req.get("host") ?? "").toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  if (bare !== "127.0.0.1" && bare !== "localhost" && bare !== "[::1]") {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  next();
});
// and in both WebSocketServer verifyClient callbacks, apply the same
// loopback-host check to info.req.headers.host before the origin comparison.
```

### CR-03: Re-auth "while the app is running" is documented and narrated but not implemented — chat stays dead until restart

**File:** `src/main.ts:504-573` (`buildTwitchAdapters`, boot-only), `src/operator-console/server.ts:300-314`, `src/ingestion/twitch-auth.ts:109-123`, `docs/OPERATIONS.md:145-168` (6.2 step 4, 6.3)
**Issue:** The twurple adapters (`ApiClient`, `EventSubWsListener`,
provider) are constructed exactly once, at boot, inside
`buildTwitchAdapters()`. `completeAuthorization()` persists the token and
registers it on a **new, throwaway** `RefreshingAuthProvider`
(twitch-auth.ts:117) that nothing else references. Consequences:

- **First-time bootstrap:** boot with no token → `createAuthProvider` returns
  null → `createApp` receives only `twitchAuth`, no `chatSource`/`chatSink` →
  `twitchStatus` stays `"unauthorized"` forever. After the operator completes
  /auth/start, the callback page says "Twitch authorized — you can close this
  tab" and the log says "token persisted", but **no EventSub listener starts
  and the pill stays red** ("Twitch: not authorized … Re-authorize at
  /auth/start"), sending the operator in a loop. OPERATIONS.md 6.2 step 4
  ("then a console log line confirming the EventSub listener started and the
  console pill turning green") describes behavior that does not exist.
- **Mid-session token revocation:** the *running* listener holds the boot-time
  provider with the revoked refresh token. Re-authorizing at /auth/start
  writes the fresh token to disk and to the throwaway provider; the live
  provider never sees it. OPERATIONS.md 6.3 ("Same flow, any time, while the
  app is running. No other state needs resetting") is wrong — a restart is
  required in both cases.

On a live show, an operator following the runbook gets a dead chat with a
green-lie success page. This is incorrect behavior on the phase's primary
integration path.
**Fix:** Minimal (docs + honesty): have `/auth/callback`'s success HTML and
the completion log say "restart the app to connect chat," and fix
OPERATIONS.md 6.2/6.3 accordingly. Correct (code): register the exchanged
token on the *live* provider when one exists (pass the provider into the
`twitchAuth.complete` closure and call `provider.addUserForToken(token,
["chat"])` on it), and for the no-provider bootstrap case, rebuild the
adapters and run the chat composition after a successful callback (extract
the composition block in `createApp` into a `startChat(source, sink)` helper
invoked from the auth-complete path).

## Warnings

### WR-01: `closeRound()` has no `frozen` guard, and a refused winner is dropped — neither queued nor repooled

**File:** `src/state-machine/round.ts:337-339`, `src/state-machine/round.ts:395-401`, `src/pipeline/round.ts:71-77`
**Issue:** Two related gaps in the close path. (1) `closeRound()` only checks
`round?.status !== "open"` — a halt-frozen round still has status `"open"`,
so any caller (`AppHandle.round.closeRound()` is public and used by e2e;
future console routes) can close a frozen round mid-halt. (2) When the
injected `enqueueWinner` returns `{ queued: false, reason: "halted" }`, the
winner candidate is only logged (round.ts:396-401) — it is not returned to
the pool and not queued. The gate-approved candidate vanishes entirely. The
`"stale-reclassified"` branch is fine (resubmit re-routes it), but the
`"halted"` branch is a silent drop of an approved candidate.
**Fix:**
```ts
closeRound(): void {
  const round = this.#round;
  if (round?.status !== "open" || round.frozen) return; // frozen waits for triage
  ...
  if (!outcome.queued && outcome.reason === "halted") {
    this.#pool.add(winner.candidate, winner.result); // never drop an approved candidate
  }
```

### WR-02: Chat is told "Queued for the build" even when the winner was not queued

**File:** `src/ingestion/narration.ts:112-132`, `src/state-machine/round.ts:395-401`
**Issue:** `roundClosed()` renders the winner template ("… Queued for the
build.") from the `RoundSnapshot` alone. The snapshot carries no
enqueue outcome, so when `enqueueWinner` returns `queued: false`
(stale-reclassified or halted) the broadcast surface announces a queued build
that never happened — and if reclassification then *rejects* the stale
winner, chat watched a winner announcement for an idea that silently
disappeared. This violates the phase's own broadcast-honesty doctrine
(D2-18).
**Fix:** Add the enqueue outcome to the close path — e.g. extend
`RoundSnapshot` with `winnerQueued: boolean` (set in `closeRound()` from the
`EnqueueWinnerResult`) and have `roundClosed()` render a "…is being
re-checked before the build" variant when false.

### WR-03: Fail-closed classifier feedback bypasses coalescing — identical-message chat spam and unbounded sender queue growth during an outage

**File:** `src/main.ts:283-287`, `src/ingestion/narration.ts:144-146`, `src/ingestion/chat-sender.ts:54-77`
**Issue:** `classifyThenNotify` routes the fail-closed rejection (classifier
down / no API key, D-11) through `narrator.error()`, which sends immediately
— it skips the D2-07 coalesce buffer entirely. During a classifier outage
every accepted `!suggest` (per-user cooldown still allows one per user per
60s, so N distinct users → N messages) enqueues an *identical* "Suggestion
check is backed up…" line. The p-queue is unbounded, drains at 15/30s, so a
100-user burst produces ~3.5 minutes of the same line on repeat — the exact
budget-doctrine failure mode the coalescer exists to prevent, on the exact
night (outage) the show can least afford it.
**Fix:** Route the outage line through the coalesce buffer with dedup, or
throttle it directly: keep a `lastErrorSentAtMs` in the `classifyThenNotify`
closure and send the backed-up notice at most once per (say) 30 seconds.

### WR-04: No-op revotes still hit SQLite and emit VOTE_RECORDED; the console pushes full state synchronously per vote

**File:** `src/state-machine/round.ts:304-330`, `src/operator-console/server.ts:237-244`
**Issue:** `recordVote()` runs the upsert and emits `VOTE_RECORDED` (with a
full deep-copied snapshot) even when `previous === option` — a user spamming
`!vote 1` generates a DB write plus an event per message. The console server
then treats `VOTE_RECORDED` as "operator-frequency" (comment at
server.ts:237-239) and calls `pushState()` synchronously per event — but
VOTE_RECORDED fires at *chat* frequency, and each push rebuilds the entire
`ConsoleState` including a `listPending(db)` query and a JSON.stringify of
pool + queue + review, per vote, per connected console client. Under a vote
flood this sits directly on the live event-handling path. (The overlay
correctly debounces the same event at 300ms.) The comment's frequency claim
is simply wrong.
**Fix:** In `recordVote()`, return early (after the upsert, to keep
`voted_at_ms` fresh, or before it) without emitting when
`previous === option`; and debounce the console's VOTE_RECORDED handler the
same way the overlay does (a shared 250-300ms trailing timer is fine for an
operator surface).

### WR-05: `close()` never clears the round timer — a pending `closeRound()` fires against a closed database

**File:** `src/main.ts:418-426`, `src/state-machine/round.ts:569-576`
**Issue:** `AppHandle.close()` clears the sweep/purge intervals, stops chat,
closes both servers, then `db.close()` — but `RoundManager` has no dispose
and its armed round timer (unref'd, up to `ROUND_DURATION_SECONDS`) is left
pending. If the process (or a long-running test worker — several e2e tests
close the app mid-round) stays alive past the deadline, the timer callback
calls `closeRound()`, whose first prepared statement throws
"database connection is closed" inside a `setTimeout` callback — an uncaught
exception that kills the process. On the real streaming box a graceful
shutdown attempt mid-round can turn into a crash.
**Fix:** Add `dispose(): void { this.#clearTimer(); }` to `RoundManager` and
call `round.dispose()` first in `close()`.

### WR-06: Token file writes are non-atomic — a crash during a refresh corrupts the credential and kills chat on next boot

**File:** `src/ingestion/twitch-auth.ts:179-190`
**Issue:** `persistToken` rewrites `twitch-token.json` in place with
`writeFileSync` on every token refresh (roughly every few hours, for the life
of the process). A crash/power-loss mid-write leaves a truncated file;
`readPersistedToken` correctly degrades to null, but the practical outcome is
that the *next* boot — plausibly a frantic mid-show restart, exactly when a
crash just happened — comes up with Twitch dead and requires a manual browser
re-auth. The refresh token that was in the old file is also gone.
**Fix:**
```ts
const tmp = `${deps.tokenPath}.tmp`;
writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
renameSync(tmp, deps.tokenPath); // atomic on the same volume
```

## Info

### IN-01: Confirmed biome `useOptionalChain` lint debt in overlay.js

**File:** `src/overlay/public/overlay.js:146-147`, `src/overlay/public/overlay.js:216`
**Issue:** Confirms the two deferred lint hits
(`.planning/phases/02-chat-vote-loop/deferred-items.md`): `latest &&
latest.round && latest.round.status === "open"` appears at 146-147 and inside
the interval predicate at 216. No behavioral bug — pure lint debt blocking a
clean `npm run lint`.
**Fix:** `latest?.round?.status === "open"` in both places (next plan that
touches src/, per the deferred-items note).

### IN-02: D2-11 "max 1 pooled candidate per user" can be exceeded via repooling; duplicate check misses in-round candidates

**File:** `src/ingestion/suggest-intake.ts:59-75`
**Issue:** The pending-slot check counts only *currently pooled* ids. A
user's candidate drawn into a round (or held for review) frees their slot;
if the drawn candidate later loses and repools (or the held item is
approved into the pool), the user ends up with two pooled candidates.
Similarly, the D2-12 duplicate check only scans the pool, so a viewer can
`!suggest` the exact text of an in-round candidate and, after the round
closes, two identical candidates coexist in the pool. Bounded impact
(pool ≤ 50, everything still gate-approved), but the documented invariant is
soft.
**Fix:** Treat "pooled OR currently in a round" as slot-occupying and include
in-round candidate texts in the duplicate scan (RoundManager already exposes
`snapshot()`).

### IN-03: Stale-winner resubmission bypasses `classifyThenNotify` — no chat feedback if the re-check rejects

**File:** `src/main.ts:203-214`
**Issue:** The `resubmit` binding inside the `RoundManager` wiring uses raw
`classify(gateDeps, cand)`, not the narrator-wrapped `classifyThenNotify`
(which is defined later, inside the chat block). A stale winner that fails
re-classification is audited but produces zero chat/console narration —
compounding WR-02's "Queued for the build" announcement. Structural
consequence of construction order.
**Fix:** Wire the round manager's `resubmit` through a late-bound reference
(e.g. a `let classifyRef` the chat block upgrades), or accept and document
the silence.

### IN-04: `.slice()` truncation can split a surrogate pair

**File:** `src/ingestion/chat-sender.ts:64-65`, `src/ingestion/narration.ts:41-43`
**Issue:** `text.slice(0, 500)` and `text.slice(0, 59)` cut on UTF-16 code
units; a suggestion ending in an astral character (emoji — explicitly common
in this chat) at the boundary sends a lone surrogate to the Twitch API /
broadcast surface (mojibake, possible API rejection of the message).
**Fix:** Truncate on code points: `[...text].slice(0, max).join("")`, or
check `/[\uD800-\uDBFF]$/` on the sliced result and drop the final unit.

### IN-05: No upper bounds on `chatterDisplayName` / `messageText` at the EventSub zod boundary

**File:** `src/ingestion/twitch-chat.ts:75-79`
**Issue:** `ChatMessageEventSchema` validates presence/shape but not size.
Twitch bounds these in practice, but this schema is documented as the trust
boundary ("twurple's TS types are compile-time fiction"); an oversized
display name flows into narrator @-mentions, `twitchUsername`, and audit rows
unbounded. Defense-in-depth gap only.
**Fix:** `chatterDisplayName: z.string().max(100)`,
`messageText: z.string().max(10_000)` (drop, don't crash, on violation —
same as today).

### IN-06: Stale TODO — `GateCategory` still aliases `string` although `categories.ts` exists

**File:** `src/shared/types.ts:41-45`
**Issue:** The `TODO(01-02): narrow this alias to the categories.ts union
once it exists` is now actionable — `src/compliance/categories.ts` exists and
is consumed by `main.ts` (`isLegalCategory`, `CATEGORY_META`). Keeping
`GateCategory = string` forfeits type-checking on every gate-result category
throughout the round/audit plumbing reviewed this phase.
**Fix:** `export type GateCategory = LegalCategory | "prompt-injection-attempt" | "feasibility"`
(or re-export the union from categories.ts).

### IN-07: `stripComments`/scan machinery duplicated between scan-helpers.ts and single-funnel.test.ts

**File:** `tests/invariants/scan-helpers.ts:28-129`, `tests/invariants/single-funnel.test.ts:45-139`
**Issue:** ~90 lines of identical comment-stripping/scanning code exist in
both files (acknowledged in scan-helpers' header as a plan-ownership
boundary). Two copies of a security-relevant scanner will drift — a bug fixed
in one (e.g. the known regex-literal `//` limitation both docstrings admit)
must be fixed twice.
**Fix:** Now that both plans have landed, refactor
`single-funnel.test.ts` to import `stripComments`/`collectFiles`/`allMatches`
from `./scan-helpers.js`.

### IN-08: Votes are accepted after `endsAtMs` until the timer callback actually runs

**File:** `src/state-machine/round.ts:304-330`, `src/state-machine/round.ts:569-576`
**Issue:** `recordVote()` never compares `now()` to `round.endsAtMs`; the
round closes only when the `setTimeout` fires. Normal jitter is milliseconds,
but if the event loop is busy (vote-flood pushes, WR-04) votes arriving
visibly after the overlay's 0:00 still count, and the acceptance window is
non-deterministic across restarts (restore re-arms from wall clock).
**Fix:** Add `if (this.#now() > round.endsAtMs) return false;` at the top of
`recordVote()` (frozen rounds already excluded via the `frozen` flag).

---

_Reviewed: 2026-07-09_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
