---
phase: 04
slug: paid-influence-chaos-mode
status: verified
threats_open: 0
asvs_level: 2
created: 2026-07-10
---

# Phase 04 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Verified against the current post-fix implementation (04-REVIEW blockers/warnings closed, 04-VERIFICATION re-confirmed). Every mitigation below was grep/line-verified in code — documentation and intent were NOT accepted as evidence.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Donor/redeemer text → agent pipeline | Attacker-controlled tip message / redemption `user_input` becomes a SuggestionCandidate | Untrusted free text (re-screened at the single gate funnel) |
| StreamElements socket + Twitch EventSub → app | Third-party realtime event streams | Untrusted JSON payloads (zod-validated at the seam) |
| Console POST routes → orchestrator control | Streamer control-plane (revoke window, toggle chaos) | State-changing requests (CSRF + DNS-rebinding guarded) |
| Paid/chaos instruction → build queue | Guaranteed-selection / random-pick promotion | Gate-approved candidates only (single funnel) |
| Window/chaos state → broadcast overlay | Live on-stream projection to OBS browser source | Coarse projection: donorDisplayName + endsAtMs only |
| Payment ↔ chance separation | Structural boundary: money must never buy a lottery | No shared code path (machine-enforced source scan) |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation (verified in code) | Status |
|-----------|----------|-----------|-------------|-------------------------------|--------|
| T-04-01 | Repudiation | control-window / audit | mitigate | `control-window.ts` calls `recordWindowOpened/Denied/Revoked/Expired`; `audit/record.ts` + `audit/schema.sql` (`control_windows` table); CR-01 not-idle denial audited (`open()` line 209 `reason:"not-idle"`), CR-02 single `window_revoked` writer (FSM `revoke()` line 333, console route line 702 no second write) | closed |
| T-04-02 / T-04-08 | Tampering | control-window crash/restore | mitigate | Absolute `endsAtMs` persisted; `restore()` re-arms REMAINING only (`control-window.ts:390-401`); expired-on-restore → `#expire()` | closed |
| T-04-03 / T-04-13 | Info Disclosure | overlay projection | mitigate | Explicit narrowing to `{donorDisplayName, endsAtMs}` (`overlay/server.ts:241-242`); no amount/message/trigger keys on the wire | closed |
| T-04-04 / T-04-25 | DoS | ingestion / boot | mitigate | zod `safeParse` + whole-handler try/catch drop-with-log (`donation-source.ts:88-113`, `redemption-source.ts:102-123`); disconnect transient → auto-reconnect; absent JWT degrades to "unconfigured" not crash (`main.ts:1343-1348`) | closed |
| T-04-05 / T-04-18 / T-04-23 | EoP | paid funnel | mitigate | `submitDuringWindow` ALWAYS calls `classify()` before enqueue (`paid-window.ts:61`); no direct enqueue; `!build` routes only via `controlWindow.submitInstruction` | closed |
| T-04-06 | EoP | OAuth scope | mitigate | `TWITCH_SCOPES` = exactly `channel:read:redemptions` (read-only), no write/manage (`twitch-auth.ts:44-48`) | closed |
| T-04-07 | Tampering | duration mapping | mitigate | `amountToDurationSeconds` floor+hard cap, hostile-input safe (`duration.ts:49-53`); one-active-window + per-donor cooldown (`control-window.ts:192,221-235`); WR-03 cooldown survives restart via `readLastGrantsByDonor` (`restore()` 359-361); WR-02 non-USD → floor | closed |
| T-04-09 / T-04-19 / T-04-24 | EoP / Tampering | single funnel / listener | mitigate | `single-funnel.test.ts` (b) `.enqueue(` only in `src/pipeline/`, (d) `toQueuedTask` allowlist; `control-window.ts` imports no gate/queue/RNG; redemption rides the SINGLE existing EventSub listener (`redemption-source.ts` constructs none); CR-03 build triggers call `buildSession.startBuild` not enqueue (`main.ts:945,980`) | closed |
| T-04-10 | Tampering (race) | window open | mitigate | Synchronous guard→transition, no `await` between checks and state write (`control-window.ts open()` 191-303) | closed |
| T-04-11 / T-04-17 | DoS / precedence | window lifecycle | mitigate | Fail-closed `revoke()` always available + HALT freeze/discard machinery; `restore()` closes orphaned expired rows; typed-error → 409 precedence (`server.ts:520,714,733`) | closed |
| T-04-12 / T-04-16 | XSS | overlay + console DOM | mitigate | `dom-safety.test.ts` scans all `src/**/public/*.js`, zero innerHTML/outerHTML/insertAdjacentHTML/document.write/eval; textContent-only | closed |
| T-04-14 | Info Disclosure | overlay banner | mitigate | WINDOW_CLOSED/WINDOW_REVOKED collapse banner silently, no red, no error string (`overlay/server.ts:313-317`) | closed |
| T-04-15 | CSRF | console POST routes | mitigate | New routes `/api/control-window/revoke` (`server.ts:693`) + `/api/chaos/toggle` (`:723`) inherit the global `app.use` Origin+Content-Type CSRF (`:279`) and DNS-rebinding loopback-host (`:247`) middleware; NO new middleware; cross-origin → 403 (`:290`) | closed |
| T-04-20 | Tampering (sweepstakes) | paid↔chaos separation | mitigate | `paid-chaos-separation.test.ts` word-anchored two-direction scan: paid path (control-window/** + paid-window.ts) has NO RNG; chaos path (chaos/** + chaos.ts) references NO payment token (incl. IN-02 money-adjacent tokens); non-empty guards + sabotage self-test | closed |
| T-04-21 | Tampering (RNG) | chaos selector | mitigate | `node:crypto.randomInt` (not Math.random), single call site (`selector.ts:17,30`) | closed |
| T-04-22 / T-04-26 | Info Disclosure | StreamElements JWT | mitigate | JWT passed only to `authenticate` emit, never logged (`donation-source.ts:132`); absent JWT → unconfigured not crash (`main.ts:1338-1348`); secrets-isolation invariant green | closed |
| T-04-27 | Repudiation | live compliance (Bits AUP / chargeback) | accept | Code funnels are gated; MEDIUM-confidence AUP/chargeback claims require a manual re-read at live-binding time — deferred to the 04-08 live gate (see Accepted Risks) | closed (accepted) |
| T-04-28 | EoP | live-only gate bypass | accept | Code paths proven vs injected fakes + smoke test exercises a real gated instruction (630 tests green); residual live-only risk (real StreamElements JWT + broadcaster re-auth) accepted for single-streamer v1, gated in 04-08 (see Accepted Risks) | closed (accepted) |
| T-04-SC | Tampering (supply chain) | socket.io-client | mitigate | `socket.io-client@4.8.3` in `package.json`; installed package carries NO postinstall/preinstall/install lifecycle script; official socket.io provenance | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-27 | Live Bits AUP / chargeback compliance is a judgment against third-party policy text that cannot be exercised in-process. The CODE mitigation (external-donation-only funding, identical gating) is present and fake-proven; the real-environment re-read is quarantined to the 04-08 live gate (`autonomous:false`). Not a code failure. | Ross (phase owner) | 2026-07-10 |
| AR-04-02 | T-04-28 | Live-only paths (real StreamElements JWT/account, `channel:read:redemptions` broadcaster re-auth, real tip/redemption + CR-03 control-flow-under-real-build smoke test) require external services and real money; cannot run in CI. Code mitigations are present and proven vs injected fakes; residual real-environment proof is the deliberately-deferred 04-08 human gate. Accepted for single-streamer v1. | Ross (phase owner) | 2026-07-10 |

*Accepted risks do not resurface in future audit runs. Both AR entries are gated by open plan 04-08 (Wave 5 live gate) before real paid use.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-10 | 19 | 19 (17 mitigate-verified + 2 accepted) | 0 | gsd-security-auditor (Claude) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log (AR-04-01, AR-04-02)
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-10

---

## Unregistered Flags

None. Only 04-05-SUMMARY.md carries a `## Threat Flags` section ("None — the two new console routes introduce no new network/auth/file surface beyond the existing console POST boundary"); all other Phase 4 summaries declare no new attack surface. No new attack surface appeared during implementation that lacks a threat mapping.

## Verification Notes

- The four load-bearing machine-enforced invariants were independently re-run during this audit and are green and non-vacuous (self-tests + non-empty guards): `single-funnel` (6), `paid-chaos-separation` (4), `dom-safety` (4), `secrets-isolation` (4) — 18/18 assertions pass.
- CR-03 build-trigger wiring verified NOT to create a second enqueue path: `driveWindowBuild`/`driveChaosBuild` (`main.ts:931,969`) call `buildSession.startBuild`, never `taskQueue.enqueue`; the single-funnel invariant confirms `.enqueue(` exists only under `src/pipeline/`. The paid build trigger does not invoke `chaos.pick`/`pickChaos`; the chaos build trigger references no payment — T-04-09/19/20 hold post-fix.
