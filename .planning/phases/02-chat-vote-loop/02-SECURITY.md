---
phase: 2
slug: 02-chat-vote-loop
status: verified
threats_open: 0
asvs_level: 1
created: 2026-07-09
audited: 2026-07-09
auditor: gsd-security-auditor
threats_total: 26
threats_closed: 26
---

# Phase 2 — Security: Chat Vote Loop

> Per-phase security contract: threat register, accepted risks, and audit trail.

Every threat in the plan-time STRIDE register (plans 02-01 through 02-06,
`register_authored_at_plan_time: true`) was verified against implemented code
— never against documentation or summary claims. Stance: every mitigation
assumed absent until located at a specific file:line. All 26 register rows
(22 `mitigate`, 4 `accept`) resolve to CLOSED or documented-accepted below.

The code-review fix pass (02-REVIEW-FIX.md: CR-01..03, WR-01..06, all fixed,
iteration 1) was counted as strengthening evidence where relevant: the shared
loopback Host allowlist (CR-02), frozen-round triage exits across restart
(CR-01/WR-01), live-provider re-auth (CR-03), atomic token writes (WR-06),
and honest queue narration (WR-02).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Twitch EventSub WS → message handler | Raw viewer-authored payloads enter the process (adversarial by design) | Chat text, chatter ids, display names |
| Chat-derived vote identity → vote ledger | round_votes uniqueness key is the fairness-critical control | twitchUserId (numeric), option index |
| Round winner (chat-derived text) → build queue | The ONE new funnel entry point this phase adds (COMP-01 surface) | Gate-approved suggestion text |
| Suggestion intake → metered Sonnet classifier | Each accepted suggestion costs a paid API call | Suggestion text, budget |
| Browser → GET /auth/start + /auth/callback | Credential-writing routes reachable by any local browser page | OAuth code, state nonce, refresh token |
| Token file at rest → process | Long-lived refresh token grants chat read/write as the broadcaster | twitch-token.json |
| App → Twitch Helix (outbound chat) | Rate-limited external API; lockout = bot mute mid-show; messages are themselves a ToS surface | Bot narration text |
| Chat-derived text → OBS broadcast DOM | Stored XSS here renders to the live audience | Candidate titles, queue titles |
| Overlay HTTP/ws surface → local browsers | Public-readable state; must never expose operator capability | Round snapshot, queue titles |
| npm registry → node_modules | 4 new packages installed this phase | @twurple/auth, @twurple/api, @twurple/eventsub-ws, p-queue |
| Process lifecycle (crash/restart) → SQLite | Recovery path is itself a tamper/loss surface | Rounds, votes, audit rows |

---

## Threat Register

All statuses verified in code at audit time. Categories are STRIDE.

### `mitigate` dispositions — verified CLOSED

| Threat ID | Category | Component | Status | Evidence (verified in code) |
|-----------|----------|-----------|--------|------------------------------|
| T-02-01 | Spoofing | round_votes uniqueness key | CLOSED | `src/audit/schema.sql:84-90` — `PRIMARY KEY (round_id, twitch_user_id)`; `src/state-machine/round.ts:183-189` — native `ON CONFLICT ... DO UPDATE` upsert (atomic revote override); `recordVote` keys exclusively by `twitchUserId` (`round.ts:316-327`), fed from EventSub `chatterId` (`src/ingestion/twitch-chat.ts:100`), never display name. |
| T-02-03 | Tampering | in-memory tally vs. ledger divergence | CLOSED | Write-through ordering proven in source: upsert runs at `round.ts:322-327` BEFORE the in-memory tally mutates (`:329-344`) and before `VOTE_RECORDED` emits (`:346`); `restore()` rebuilds candidates + tally exclusively from `round_candidates`/`round_votes` (`round.ts:471-539`); `main.ts:233-236` calls `round.restore()` before any surface accepts input. |
| T-02-04 | DoS | halt vs. round-close timer race | CLOSED | `round.ts:192-194` — `HALT_TRIGGERED` handler calls `#freeze()` synchronously; `#freeze` cancels the timer and persists `frozen_remaining_ms` (`round.ts:558-569`); `closeRound()` refuses while frozen (`round.ts:359`, WR-01 guard) and only transitions VOTING_ROUND→IDLE when actually in VOTING_ROUND (`round.ts:442-444`). |
| T-02-05 | Tampering | command-parser input handling | CLOSED | `src/ingestion/command-parser.ts:36-53` — total function: trim + regex-first extraction + zod `safeParse` (`:41`, `:47`), returns null on anything unrecognized, never throws; 2000-char cap (`:20`) mirrors CandidateSchema. |
| T-02-06 | DoS | outbound chat rate lockout | CLOSED | `src/ingestion/chat-sender.ts:54-60` — single `PQueue` with `concurrency: 1`, `intervalCap` 15 / `interval` 30_000, `strict: true` (sliding window, no boundary bursts); 500-char cap `:63-65`; fail-closed send `:66-76`. Sole-caller machine-enforced: `tests/invariants/chat-sender.test.ts:28-41` (sendChatMessage referenced only in chat-sender.ts) + `:43-52` (@twurple/api confined to src/ingestion/ + main.ts). |
| T-02-07 | Info Disclosure | refresh token at rest + in logs | CLOSED | `src/ingestion/twitch-auth.ts:199-212` — token file written mode `0o600`, write-to-`.tmp` + `renameSync` atomic (WR-06); token path defaults into gitignored `data/` (`.gitignore:2`); every log call carries only userId/scope/obtainmentTimestamp (`twitch-auth.ts:80-84, 127-135, 144-154`); `onRefreshFailure` logs loudly WITHOUT the token (`:155-160`); capturing-logger test proves no token value ever logged across all five logging paths (`src/ingestion/twitch-auth.test.ts:298-338`). |
| T-02-SC | Tampering (supply chain) | npm installs this phase | CLOSED | `package.json:19-24` — exactly the four audited packages added (`@twurple/auth@^8.1.4`, `@twurple/api@^8.1.4`, `@twurple/eventsub-ws@^8.1.4`, `p-queue@^9.3.1`, lockstep twurple minor); 02-RESEARCH.md:148-159 Package Legitimacy Audit — all four slopcheck [OK], 2016/2021 first-publish, official repos; `allowScripts` unchanged from Phase 1's three audited native packages (no new postinstall grants). |
| T-02-09 | Tampering | winner→queue path bypassing the gate | CLOSED | `tests/invariants/single-funnel.test.ts:181-195` — check (d) allowlist is exactly {gate.ts, pipeline/submit.ts, pipeline/round.ts}; check (a) still exactly one `as QueuedTask` in gate.ts (`:147-157`); `src/pipeline/round.ts:89-90` — `toQueuedTask(approved.candidate, approved.result)` on the pooled, already-gated candidate object (byte-identical text, never re-derived from chat); RoundManager imports no queue/gate internals (`round.ts:17-20, 23-45`). |
| T-02-10 | Tampering | stale approval enqueued after conditions changed | CLOSED | `src/pipeline/round.ts:79-87` — `Date.now() - approved.addedAtMs > staleAfterMs` (WINNER_STALENESS_MINUTES, default 360) routes to `deps.resubmit()` (full re-classification), returns `{ queued: false, reason: "stale-reclassified" }`; staleness input is the PERSISTED `round_candidates.pooled_at_ms` read at close (`src/state-machine/round.ts:407-414`) and mapped onto `addedAtMs` in the composition root (`src/main.ts:211-231`) — never reconstructed at close time. |
| T-02-11 | Tampering (CSRF) | POST /api/round/start | CLOSED | Route registered on the console app behind the uniform middleware stack: loopback Host pin FIRST, all methods (`src/operator-console/server.ts:157-163`, CR-02) + Origin/Host agreement + application/json gate on every non-GET (`:189-208`); strict empty-body zod schema (`:115`); `RoundStartError` → terse 409 with machine-readable reason, never a stack trace (`:405-422`); terse error boundary (`:605-614`). |
| T-02-12 | DoS | round start spam wedging the state machine | CLOSED | `src/state-machine/round.ts:216-224` — `startRound()` throws `RoundStartError` unless no round is loaded (CR-01 `round-active` guard, stronger than the planned IDLE-only check), mode is IDLE, and pool ≥ 2; surface is the 127.0.0.1-bound console only (`server.ts:618`); transition table rejects illegal re-entry. |
| T-02-13 | Spoofing | intake cooldown bypass via display-name change | CLOSED | `src/ingestion/suggest-intake.ts` — all intake state keyed by `chatterId` (`:43-47, 80-88`), module never touches display names; `twitch-chat.ts:105` passes `chatterId` to `intake.check`, `:100` to `recordVote`; `chatterDisplayName` used only for @-reply rendering (`:107`) and candidate display metadata (`:115`). |
| T-02-14 | DoS | !suggest flood burning metered Sonnet calls (closes Phase 1 accepted risk T-01-11) | CLOSED | `twitch-chat.ts:104-109` — `intake.check()` runs BEFORE `deps.submit()` (the classifier path); `suggest-intake.ts:46-78` — synchronous per-user cooldown + max-1-pooled + exact-dup (via the canonical `normalize()` fold), no Promise, imports no classifier code; over-limit gets coalesced quiet feedback (`narration.ts:140-148`); pool bounded with audited oldest-drop eviction (`src/queue/pool.ts:48-56`; `src/main.ts:144-148` wires `onEvict` → `recordPoolDropped`); WR-03 throttles the fail-closed outage notice to 1/30s (`main.ts:322-341`). |
| T-02-15 | Tampering | malformed/hostile EventSub payload shape | CLOSED | `twitch-chat.ts:75-79` — `ChatMessageEventSchema` zod-validates the event object before ANY field use (`:91-93`); entire handler wrapped in try/catch that logs and keeps consuming (`:90, 126-130`) — listener survives hostile payloads and downstream throws. |
| T-02-16 | Spoofing (login CSRF) | GET /auth/callback swapping in an attacker's token | CLOSED | `server.ts:313-343` — 32-byte `randomBytes` nonce generated at `/auth/start` (single slot; a second start invalidates the first), 10-min expiry (`AUTH_STATE_TTL_MS`, `:137-138`), zod-validated callback query (`:132-135`), mismatch/missing/expired → terse 403 with NO token write (`:338-341`), matched nonce burned before the exchange (`:343`); callback renders two fixed static HTML strings, nothing user-controlled interpolated (`:359-365`, CR-03). |
| T-02-17 | Info Disclosure / Compliance | outbound bot messages echoing non-compliant text | CLOSED | `src/ingestion/narration.ts:65-78, 102-137` — fixed UI-SPEC templates rendered verbatim; rejected/held feedback carries only the caller-passed category label; `src/main.ts:324-347` — `classifyThenNotify` passes ONLY `CATEGORY_META[...].label` (never suggestion text, never rationale); fail-closed path sends the fixed outage line, no internal codes (`:333-341`); round-message titles are gate-approved text truncated to 60 chars (`narration.ts:35, 41-43`); WR-02 honest "Queued for the build" gating (`narration.ts:125-137`). |
| T-02-19 | EoP (stored XSS, broadcast) | overlay.js rendering chat-derived titles | CLOSED | `src/overlay/public/overlay.js:30-35` — textContent-only `el()` helper; 80/60-char JS truncation (`:23-24, 87, 126`); no URL/image/markup interpretation anywhere; machine-checked: `tests/invariants/dom-safety.test.ts:23, 42-49` scans ALL `src/**/public/*.js` (auto-discovered, `:26-39`) for innerHTML/outerHTML/insertAdjacentHTML/document.write/eval — zero hits, with self-tests proving the scan catches offenders. |
| T-02-20 | EoP | overlay surface exposing operator controls (D2-17) | CLOSED | `src/overlay/server.ts` — physically separate http server on its own port (OVERLAY_PORT 4901, `.env.example:59`); zero mutation routes by construction — the only handlers are `express.static` (`:117`) and `GET /api/state` (`:131-133`); no `express.json()`; explicit `127.0.0.1` bind (`:197`); ws `verifyClient` with loopback Host pin + Origin check copied from the console (`:143-149`, WR-01/CR-02); loopback Host middleware first for all methods (`:108-114`). |
| T-02-21 | Info Disclosure | overlay leaking internal state on stream | CLOSED | `overlay/server.ts:84-91` — fixed public pill vocabulary (`PILL_BY_MODE`), internal "HALTED" maps to "ON HOLD" and is never emitted; `buildOverlayState()` composes only pill + round snapshot + first-3 queue titles (`:120-129`) — no audit/review data; `overlay.js:236-242` — ws close freezes the last render and retries silently, no error text ever renders on the broadcast surface. Residual noted below (rationale field inside the round snapshot JSON — never rendered). |
| T-02-22 | DoS | per-vote push flooding OBS CEF rendering | CLOSED | `overlay/server.ts:184-193` — VOTE_RECORDED collapses into one push per 300ms trailing debounce window (default `:76`), timer unref'd and cleared in `close()` (`:209-212`); lifecycle events push immediately (`:172-179`); console got the same treatment post-review (WR-04, `operator-console/server.ts:279-288`). |
| T-02-23 | Repudiation / DoS | silent vote loss across crash or reconnect | CLOSED | `tests/e2e/recovery.e2e.test.ts:165-216` — kill mid-round → restart restores the exact round, winner counts votes from both process lives; `:217-252` — expired-during-downtime round closes and enqueues via the funnel; `:253-367` — halt-freeze survives restart with both triage exits (CR-01); `:368-414` — disconnect→ready reconciliation re-syncs the tally from the ledger; `src/main.ts:352-396` — `reconcile()` performs a real db-vs-memory tally comparison and restores from SQLite on divergence, run on every EventSub (re)connect (`twitch-chat.ts:146-149`); `round_closed` audit row records the final tally JSON (`round.ts:446-453`). |
| T-02-25 | Spoofing | live checkpoint against a wrong/test app identity | CLOSED | `docs/OPERATIONS.md` §6.2 step 2 (`:149-151`) — explicit "log into the broadcaster account first, scopes bind to whichever account approves" warning; §6.1 (`:126`) registers the app while logged into the broadcaster account; checkpoint steps in 02-HUMAN-UAT.md carry the same walkthrough. The live checkpoint itself is deferred (see Operational Follow-ups) — the declared mitigation artifacts all exist. |

### `accept` dispositions — see Accepted Risks Log

| Threat ID | Category | Component | Status |
|-----------|----------|-----------|--------|
| T-02-02 | EoP (of influence) | vote brigading via alt accounts | ACCEPTED (documented) |
| T-02-08 | Spoofing | stolen client secret enabling token minting | ACCEPTED (documented) |
| T-02-18 | EoP | chat text treated as instructions downstream | ACCEPTED (out of phase scope — Phase 3) |
| T-02-24 | DoS | votes sent during a genuine connectivity gap | ACCEPTED (documented) |

*Status: open · closed — all 26 rows closed at audit time.*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-02 | One-vote-per-account is structural (PK + upsert, T-02-01) and revote-override closes the basic case; account-age weighting is explicitly v2. Backstops verified in code: `round_closed` audit rows carry the full tally JSON (`round.ts:450`) and the streamer veto on any queued winner exists (`server.ts:513-546`). | Plan 02-01 threat model (plan-time register) | 2026-07-09 |
| AR-02-02 | T-02-08 | Client secret lives in gitignored `.env` (`.gitignore:3`; `.env.example:31` ships an empty placeholder) on the streamer's own machine — same trust boundary as ANTHROPIC_API_KEY (Phase 1 T-01-10). No at-rest encryption for the v1 single-machine deployment. | Plan 02-02 threat model | 2026-07-09 |
| AR-02-03 | T-02-18 | Prompt-injection boundary for chat text reaching the orchestrator is Phase 3 scope (SAND-04). This phase preserves the discipline: suggestion text is opaque data end-to-end — verified that the enqueued winner text is the byte-identical gated candidate (`pipeline/round.ts:89`, T-02-09) and no chat text is interpolated into any prompt or HTML this phase. **Must be re-registered and mitigated in Phase 3.** | Plan 02-04 threat model | 2026-07-09 |
| AR-02-04 | T-02-24 | EventSub has no event replay (verified from source, 02-RESEARCH.md Pattern 1) — no consumer could recover votes typed during a socket gap. Documented honestly: `docs/OPERATIONS.md` §6.5 (`:186-201`, including the manual compromised-round remedy: veto + re-run) and the console's "Twitch connection lost" copy (`src/operator-console/public/console.js:146`). Acknowledged votes are covered by T-02-23. | Plan 02-06 threat model | 2026-07-09 |

*Accepted risks do not resurface in future audit runs — except AR-02-03, which is explicitly scoped to re-open in Phase 3.*

---

## Cross-Phase Closure

**Phase 1 residual #1 (T-01-01 DNS-rebinding in the CSRF check) is now CLOSED.**
01-SECURITY.md flagged that the console compared Origin against the request's
own Host header — a DNS-rebinding attacker controls both. CR-02 fixed this
with a shared pinned allowlist: `src/shared/loopback.ts:23-46`
(`127.0.0.1`/`localhost`/`[::1]`, fail-closed on missing Host), applied as the
FIRST middleware for ALL methods on both servers
(`operator-console/server.ts:157-163`, `overlay/server.ts:108-114`), inside
the CSRF Origin comparison (`operator-console/server.ts:196-208`), and in both
ws handshakes (`operator-console/server.ts:246-252`,
`overlay/server.ts:143-149`). e2e tests exercise the real attack shape via raw
`node:http` with rebound Host/Origin pairs (02-REVIEW-FIX.md, commit 6c25795).

---

## Unregistered Flags

**None.** All six SUMMARYs declare `## Threat Flags: None` and map every piece
of new surface to a registered threat ID (02-01: T-02-01/03/04; 02-02:
T-02-05..08/SC; 02-03: T-02-09..12; 02-04: T-02-13..17; 02-05: T-02-19..22;
02-06: T-02-23..25).

Post-plan attack surface WAS found by the code review (02-REVIEW.md) and is
already closed with regression tests — recorded as review-discovered, not
unregistered:

- **CR-01** crash-restored frozen round unrecoverable/orphanable — fixed e54c874 + 46733a2 (`round.ts:216-218`, restored freeze re-enters HALTED; audited discard `round.ts:607-617`)
- **CR-02** DNS rebinding defeating Origin/CSRF/ws checks — fixed 6c25795 (`src/shared/loopback.ts`, see Cross-Phase Closure)
- **CR-03** re-auth-while-running documented but not implemented — fixed 0e02d64 (`twitch-auth.ts:116-136` liveProvider; honest callback pages `server.ts:359-365`)
- **WR-01** frozen round closable / halted winner silently dropped — fixed 7070fb8 (`round.ts:359, 429-431`)
- **WR-02** dishonest "Queued for the build" narration — fixed 8d838b4 (`round.ts:419`, `narration.ts:128-130`)
- **WR-03** fail-closed feedback spam during classifier outage — fixed 3aca4f7 (`main.ts:322-341`)
- **WR-04** per-vote synchronous console pushes + no-op revote emits — fixed cc11ec0 (`round.ts:330-337`, `server.ts:279-288`)
- **WR-05** armed round timer firing against a closed db — fixed 23163e2 (`round.ts:553-555`)
- **WR-06** non-atomic token writes — fixed 60ac68f (`twitch-auth.ts:209-211`)

---

## Known Residuals (non-blocking)

1. **Overlay state JSON carries the gate rationale inside round candidates.**
   `RoundSnapshot.candidates[].result` is the full `GateResult` (decision,
   category, rationale — `round.ts:648-667`), and `buildOverlayState()`
   forwards the round snapshot verbatim (`overlay/server.ts:120-129`). The
   overlay client never renders it (`overlay.js` draws only titles, votes,
   pill), and the surface is loopback-bound + rebind-protected + ws
   Origin-gated — but internal classifier rationale is readable by any local
   process or the OBS source page on the "public" surface. Trimming the
   snapshot to display fields would remove it. Non-blocking (T-02-21's
   broadcast-leak concern is fully mitigated; this is a local-read nuance
   inside the Phase 1 physical-access trust boundary).
2. **ws handshakes with no Origin header are allowed on both surfaces**
   (`operator-console/server.ts:250`, `overlay/server.ts:147`) — intentional
   (non-browser clients); inherited Phase 1 residual, inside the
   physical-access trust boundary (T-01-14).
3. **First-run OAuth requires a restart** (CR-03 deliberately did not attempt
   full live pipeline recomposition at bootstrap; `server.ts:364` says so
   honestly). Availability nuance only — no security impact.

---

## Operational Follow-ups (verification completeness, not mitigation gaps)

- **Live Twitch checkpoint pending** (02-HUMAN-UAT.md: both tests `[pending]`,
  status `partial`): the T-02-25 mitigation artifacts (OPERATIONS.md §6.1/§6.2
  broadcaster-account warnings, checkpoint walkthrough) all exist, but the
  real-channel smoke test and the OBS overlay check have not yet been
  performed. Complete or explicitly defer before the first live stream.
- **Phase 1 follow-ups still open where applicable** (hotkey UIPI check on the
  streaming PC, live `gate:eval` run) — tracked in 01-SECURITY.md.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-09 | 26 | 26 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-09
