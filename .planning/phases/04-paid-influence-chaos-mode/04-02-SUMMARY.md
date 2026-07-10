---
phase: 04-paid-influence-chaos-mode
plan: 02
subsystem: ingestion
tags: [streamelements, socket.io-client, twitch, eventsub, channel-points, donation, zod, oauth-scope]

# Dependency graph
requires:
  - phase: 02-chat-suggestion-loop
    provides: twitch-chat.ts ChatEventSource injected-seam + zod-boundary + fail-closed discipline; twitch-auth.ts TWITCH_SCOPES + buildAuthorizeUrl; SuggestionCandidate vocabulary
provides:
  - StreamElements donation source (DonationEventSource seam, TipEvent zod schema, connectStreamElements dynamic-import adapter)
  - Twitch channel-points redemption source (RedemptionEventSource seam, RedemptionEventSchema, toCandidate mapper)
  - channel:read:redemptions added to TWITCH_SCOPES (broadcaster re-auth deferred to 04-08)
  - isMissingRedemptionScopeError + REDEMPTION_SCOPE — loud missing-scope degraded-state primitive (consumed by 04-05 console pill / 04-08 wiring)
affects: [04-03-control-window, 04-05-console, 04-06-funnel, 04-07-composition-root, 04-08-live-gates]

# Tech tracking
tech-stack:
  added: [socket.io-client@^4.8.3]
  patterns: [injected-seam ingestion source, zod-boundary fail-closed dispatch with per-handler isolation, dynamic-import network adapter kept out of the test path]

key-files:
  created:
    - src/ingestion/donation-source.ts
    - src/ingestion/donation-source.test.ts
    - src/ingestion/redemption-source.ts
    - src/ingestion/redemption-source.test.ts
  modified:
    - src/ingestion/twitch-auth.ts
    - src/ingestion/twitch-auth.test.ts
    - package.json
    - package-lock.json

key-decisions:
  - "connectStreamElements is async and dynamic-imports socket.io-client so the network dependency loads only at the composition root (04-07), never in vitest — the testable wiring lives in makeDonationSource(socket, jwt) against an injected DonationSocket seam"
  - "Fail-closed dispatch isolates EACH handler in its own try/catch (not one loop-wide catch) so a throwing consumer can neither starve other handlers nor kill the socket/listener"
  - "toCandidate maps redemption.user_id (stable, non-spoofable) into SuggestionCandidate.twitchUsername for downstream cooldown keying (04-03), user_input into text, source channel_points"
  - "Added REDEMPTION_SCOPE + isMissingRedemptionScopeError as the loud missing-scope degraded-state primitive since main.ts/console are owned by later plans — this file exports the detection mechanism 04-08/04-05 wire the pill from"

patterns-established:
  - "Ingestion source = injected seam + top-of-file zod schema + fail-closed dispatch helper, mirroring twitch-chat.ts exactly"
  - "Untrusted third-party socket/EventSub payloads are safeParse-validated before any field use; malformed/out-of-scope payloads drop-with-log, never throw into the handler (T-04-04)"

requirements-completed: [PAID-01, PAID-02]

# Metrics
duration: 7min
completed: 2026-07-10
---

# Phase 4 Plan 02: Donation & Redemption Ingestion Sources Summary

**StreamElements donation source (socket.io-client, zod-validated tip, fail-closed) + Twitch channel-points redemption source on the existing EventSub session, plus channel:read:redemptions added to TWITCH_SCOPES with a loud missing-scope degraded-state primitive — all against injected fakes, zero network.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-10T05:02:07Z (base)
- **Completed:** 2026-07-10T05:09:11Z
- **Tasks:** 2
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments
- StreamElements donation ingestion: `DonationEventSource` injected seam, `TipEventSchema` zod boundary (surfaces the donor `message` field), jwt `authenticate` handshake, transient-disconnect handling, and a `connectStreamElements` adapter that dynamic-imports `socket.io-client` so the network never loads in tests.
- Channel-points redemption ingestion: `RedemptionEventSource` seam + snake_case `RedemptionEventSchema` + `toCandidate` mapper into the shared `SuggestionCandidate`; NO second `EventSubWsListener` (rides the existing Phase 2 session, wired in 04-08 via `handleRaw`).
- SCOPE CORRECTION: `channel:read:redemptions` added to `TWITCH_SCOPES` (D-02); `isMissingRedemptionScopeError` + `REDEMPTION_SCOPE` exported as the loud missing-scope degraded-state primitive; broadcaster re-authorization deferred to the 04-08 live gate.
- Full suite green: 544 pass (524 baseline + 20 new); `tsc --noEmit` clean; biome clean.

## Task Commits

1. **Task 1: Install socket.io-client + StreamElements donation source** — `0ab29a0` (feat)
2. **Task 2: Channel-points redemption source + channel:read:redemptions scope** — `e24d679` (feat)

## Files Created/Modified
- `src/ingestion/donation-source.ts` — DonationEventSource seam, TipEventSchema, makeDonationSource (testable), connectStreamElements (dynamic-import adapter)
- `src/ingestion/donation-source.test.ts` — 9 tests: schema, handshake, tip dispatch, malformed/non-tip drop, fail-closed handler isolation, ready/disconnect
- `src/ingestion/redemption-source.ts` — RedemptionEventSource seam, RedemptionEventSchema, makeRedemptionSource/handleRaw, toCandidate, REDEMPTION_SCOPE, isMissingRedemptionScopeError
- `src/ingestion/redemption-source.test.ts` — 10 tests: schema, dispatch, malformed drop, fail-closed isolation, toCandidate mapping, scope sync, missing-scope detection
- `src/ingestion/twitch-auth.ts` — TWITCH_SCOPES extended with channel:read:redemptions (+ re-auth doc comment)
- `src/ingestion/twitch-auth.test.ts` — updated exact-scopes + authorize-URL assertions for the new scope
- `package.json` / `package-lock.json` — socket.io-client ^4.8.3

## Decisions Made
See frontmatter `key-decisions`. Most load-bearing: the network adapter (`connectStreamElements`) is `async` and dynamic-imports `socket.io-client`, keeping the dependency out of the vitest path while the actual wiring/fail-closed logic is unit-tested against an injected `DonationSocket` fake.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Per-handler fail-closed isolation instead of one loop-wide try/catch**
- **Found during:** Task 1 (donation source dispatch)
- **Issue:** A single try/catch wrapping the whole handler loop lets one throwing consumer abort the remaining handlers for that event — weaker than the "socket stays up / handlers not starved" intent of T-04-04.
- **Fix:** safeParse in its own guard, then each handler invocation isolated in its own try/catch (applied identically to the redemption dispatch).
- **Files modified:** src/ingestion/donation-source.ts, src/ingestion/redemption-source.ts
- **Verification:** Fail-closed tests assert a throwing handler is logged and a second handler still receives the same event, and subsequent events still dispatch.
- **Committed in:** 0ab29a0 (Task 1), e24d679 (Task 2)

**2. [Rule 2 - Missing Critical] Loud missing-scope degraded-state primitive (REDEMPTION_SCOPE + isMissingRedemptionScopeError)**
- **Found during:** Task 2 (scope correction)
- **Issue:** Success criteria require the redemption subscription to fail LOUDLY (not silently) when the token lacks channel:read:redemptions, but main.ts/console are owned by later plans (04-08/04-05) and are outside this plan's files_modified.
- **Fix:** Exported REDEMPTION_SCOPE and isMissingRedemptionScopeError from redemption-source.ts as the detection primitive 04-08 wires the degraded state from; a unit test asserts REDEMPTION_SCOPE stays in sync with TWITCH_SCOPES.
- **Files modified:** src/ingestion/redemption-source.ts, src/ingestion/redemption-source.test.ts
- **Verification:** Tests cover scope-name/401/403 detection and no false-positive on unrelated errors.
- **Committed in:** e24d679 (Task 2)

**3. [Rule 3 - Blocking] Updated twitch-auth.test.ts scope assertions**
- **Found during:** Task 2 (scope correction)
- **Issue:** Existing tests asserted TWITCH_SCOPES was exactly the two chat scopes and the authorize URL scope string had only those — adding channel:read:redemptions broke both (the plan explicitly directs extending the existing scope test).
- **Fix:** Updated the exact-scopes assertion and the authorize-URL scope-string assertion; added a contains-channel:read:redemptions test.
- **Files modified:** src/ingestion/twitch-auth.test.ts
- **Verification:** twitch-auth.test.ts (11 tests) green.
- **Committed in:** e24d679 (Task 2)

**4. [Rule 3 - Blocking] Full `npm install` (node_modules absent in worktree)**
- **Found during:** Task 1
- **Issue:** The fresh worktree had no node_modules; `npm install socket.io-client` installed the full dependency tree (expected per parallel-executor instructions).
- **Fix:** Ran `npm install socket.io-client` — added 249 packages, socket.io-client pinned ^4.8.3, 0 vulnerabilities.
- **Committed in:** 0ab29a0 (Task 1)

---

**Total deviations:** 4 auto-fixed (2 missing-critical, 2 blocking)
**Impact on plan:** All auto-fixes serve correctness/success-criteria (stronger fail-closed, required loud degraded-state, mandated test update, environment bootstrap). No scope creep — no files outside the plan's files_modified were touched.

## Issues Encountered
- Initial donation fail-closed test failed because a loop-wide try/catch let the first (throwing) handler block the second — resolved by moving to per-handler isolation (Deviation 1), which is the more correct fail-closed semantics.

## User Setup Required
None in this plan. NOTE: the `channel:read:redemptions` scope requires the broadcaster to RE-AUTHORIZE at /auth/start — this is a deferred live human gate handled in plan 04-08, not here.

## Next Phase Readiness
- Both untrusted event streams are typed, zod-validated, fail-closed injected seams ready for the 04-03 ControlWindow FSM to consume (PAID-01 donation, PAID-02 redemption).
- `toCandidate` produces the standard `SuggestionCandidate` so the redemption path funnels through the one gate (04-06) with no new candidate type.
- 04-07 composition root: call `connectStreamElements(jwt)` for donations and forward the existing EventSub redemption callback into `makeRedemptionSource().handleRaw`.
- 04-08: perform the broadcaster re-auth for channel:read:redemptions and wire `isMissingRedemptionScopeError` into the loud degraded state (04-05 console missing-scope pill).

## Self-Check: PASSED

All created files exist on disk; both task commits (`0ab29a0`, `e24d679`) are present in git history; `channel:read:redemptions` confirmed in twitch-auth.ts.

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
