---
phase: 02-chat-vote-loop
fixed_at: 2026-07-09T20:52:00Z
review_path: .planning/phases/02-chat-vote-loop/02-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 2: Code Review Fix Report

**Fixed at:** 2026-07-09T20:52:00Z
**Source review:** .planning/phases/02-chat-vote-loop/02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 10 (CR-01..CR-03, WR-01..WR-06, plus IN-01 lint debt per fix directive)
- Fixed: 10
- Skipped: 0

**Verification:** `tsc --noEmit` clean, full `vitest run` green (34 files / 378
tests, including the new CR/WR regression tests), `npm run lint` clean
repo-wide (76 files). All machine-enforced invariants (single-funnel,
chat-sender sole-caller, dom-safety, append-only audit) pass unchanged.

## Fixed Issues

### CR-01: Crash-restored frozen round is unrecoverable; startRound() can silently orphan it

**Files modified:** `src/state-machine/round.ts`, `src/main.ts`, `src/state-machine/round.test.ts`, `tests/e2e/recovery.e2e.test.ts`, `docs/OPERATIONS.md`
**Commit:** e54c874
**Applied fix:** `startRound()` now throws a new `RoundStartError("round-active")`
whenever ANY round is loaded (mode alone was insufficient — a restored frozen
round sits in memory while IDLE). A frozen round found at boot is given a real
exit via the new `discardRestoredFrozen()` (row → `discarded`, candidates
repooled, votes kept in the ledger, ROUND_CLOSED emitted — the review's
"safest minimal policy"). OPERATIONS.md 6.6 updated to match. New unit tests
prove the round-active guard and the boot discard; the recovery e2e that
previously pinned the stuck state now proves the exit is real (row resolved,
votes retained, a fresh round starts cleanly).

### CR-02: DNS rebinding defeats every Origin/CSRF/ws check

**Files modified:** `src/shared/loopback.ts` (new), `src/operator-console/server.ts`, `src/overlay/server.ts`, `tests/e2e/console-flows.e2e.test.ts`, `src/overlay/server.test.ts`
**Commit:** 6c25795
**Applied fix:** New shared loopback allowlist (`127.0.0.1` / `localhost` /
`[::1]`, with or without port — one copy so the two surfaces can't drift).
Applied as the FIRST middleware on BOTH servers for ALL methods (reads leak
state too), to the CSRF Origin comparison (present Origin must be a loopback
origin AND exactly match the pinned Host), and to BOTH ws `verifyClient`
handshakes (Host checked before the origin comparison). e2e tests exercise the
real attack shape via raw `node:http` (fetch forbids Host overrides): rebound
GET, rebound POST with AGREEING Host/Origin against `/api/halt`, and rebound ws
handshakes are all refused; `localhost` alias still accepted. Note: one new
file was created (`src/shared/loopback.ts`) — a shared helper both servers
import, chosen over duplicating the check per the review's own IN-07 drift
concern. This also closes the Phase 1 residual noted in 01-SECURITY.md.

### CR-03: "Re-authorize while running" documented but not implemented — chat stays dead behind a success page

**Files modified:** `src/ingestion/twitch-auth.ts`, `src/ingestion/twitch-auth.test.ts`, `src/main.ts`, `src/operator-console/server.ts`, `tests/e2e/oauth-routes.e2e.test.ts`, `tests/e2e/chat-wiring.e2e.test.ts`, `docs/OPERATIONS.md`
**Commit:** 0e02d64
**Applied fix:** Combined the review's "correct (code)" fix for mid-session
revocation with its honesty fix for bootstrap: `completeAuthorization()` gains
an optional `liveProvider` and registers the exchanged token on the RUNNING
pipeline's provider when one exists (`addUserForToken` replaces the token in
place — no restart); `buildTwitchAdapters` exposes the boot provider to the
auth-complete closure once the full adapters compose, and `complete()` resolves
`{ chatLive }`. `/auth/callback` now renders one of two static pages: "chat is
reconnecting" (live) or "now RESTART the app to connect chat" (bootstrap — the
chat pipeline only composes at boot; full live recomposition was deliberately
NOT attempted, keeping the fix contained). OPERATIONS.md 6.2/6.3 rewritten to
match actual behavior. Unit test proves the live provider (never the throwaway)
receives the token; e2e tests pin both callback-page variants.

### WR-01: closeRound() lacks a frozen guard; a "halted"-refused winner is silently dropped

**Files modified:** `src/state-machine/round.ts`, `src/state-machine/round.test.ts`
**Commit:** 7070fb8
**Applied fix:** `closeRound()` returns early while the round is frozen (a
frozen round still has status `open` and must wait for triage). A winner the
funnel refuses with reason `"halted"` is returned to the pool; the
`"stale-reclassified"` branch is deliberately NOT repooled (resubmit() already
re-routed it — repooling would duplicate). Three new unit tests cover the
frozen no-op, the halted repool, and the stale non-repool.

### WR-02: Chat announces "Queued for the build" for winners that never queued

**Files modified:** `src/shared/types.ts`, `src/state-machine/round.ts`, `src/ingestion/narration.ts`, `src/ingestion/narration.test.ts`, `src/overlay/server.test.ts`
**Commit:** 8d838b4
**Applied fix:** `RoundSnapshot` gains required `winnerQueued: boolean` (false
while open, set at close from the funnel's `EnqueueWinnerResult`). Narration
renders "Queued for the build." only when true; otherwise the honest
"It's being re-checked before the build." variant, on both the winner and
dead-heat templates (D2-18). Test snapshot factories updated; new tests pin
both variants including the tiebreak path.

### WR-03: Fail-closed classifier feedback bypasses coalescing — identical-message spam during an outage

**Files modified:** `src/main.ts`, `tests/e2e/chat-wiring.e2e.test.ts`
**Commit:** 3aca4f7
**Applied fix:** Took the review's throttle option: `classifyThenNotify` keeps
`lastOutageNoticeAtMs` in its closure and sends the "Suggestion check is backed
up" line at most once per 30 seconds. e2e proves a 5-distinct-user burst under
a fail-closed classifier produces exactly one notice.

### WR-04: No-op revotes emit VOTE_RECORDED; console pushes full state synchronously per vote

**Files modified:** `src/state-machine/round.ts`, `src/state-machine/round.test.ts`, `src/operator-console/server.ts`
**Commit:** cc11ec0
**Applied fix:** `recordVote()` returns early AFTER the upsert (keeping
`voted_at_ms` fresh, the review's preferred ordering) without emitting when
`previous === option`. The console server debounces VOTE_RECORDED with the
overlay's trailing-timer pattern (250ms, unref'd, cleared in `close()`); round
open/close still push synchronously. The stale "operator-frequency" comment is
corrected. Unit test proves no-op suppression, freshness, and that a real
revote still emits.

### WR-05: close() never clears the round timer — pending closeRound() fires against a closed db

**Files modified:** `src/state-machine/round.ts`, `src/state-machine/round.test.ts`, `src/main.ts`
**Commit:** 23163e2
**Applied fix:** `RoundManager.dispose()` (clears the armed timer; persisted
state untouched — restore() picks it up next boot) called FIRST in
`AppHandle.close()`. Fake-timer unit test proves the deadline elapsing after
dispose+db.close() no longer throws.

### WR-06: Token file writes are non-atomic — crash mid-refresh corrupts the credential

**Files modified:** `src/ingestion/twitch-auth.ts`, `src/ingestion/twitch-auth.test.ts`
**Commit:** 60ac68f
**Applied fix:** `persistToken` writes to `tokenPath.tmp` (mode 0600) then
`renameSync`s over the target — atomic on the same volume, Windows included.
Test proves no `.tmp` residue and that a second persist replaces the existing
file cleanly.

### IN-01: biome useOptionalChain lint debt in overlay.js (deferred-items.md)

**Files modified:** `src/overlay/public/overlay.js`, `src/state-machine/round.test.ts`, `tests/e2e/round-flow.e2e.test.ts`
**Commit:** 8bb5da7
**Applied fix:** Both deferred hits become `latest?.round?.status === "open"`
(renderVotePanel and the 1s countdown tick). A biome format pass also cleared
the pre-existing formatter debt in `round-flow.e2e.test.ts` so `npm run lint`
is now clean repo-wide. The dom-safety invariant scan still passes (no
innerHTML anywhere in public/*.js). The deferred-items.md entry for the
useOptionalChain hits is now resolved; the CRLF complaints it mentions did not
reproduce (`npm run lint` is clean).

## Skipped Issues

None — all in-scope findings were fixed. Remaining Info findings
(IN-02..IN-08) were out of scope per the fix directive and remain open in
02-REVIEW.md.

---

_Fixed: 2026-07-09_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
