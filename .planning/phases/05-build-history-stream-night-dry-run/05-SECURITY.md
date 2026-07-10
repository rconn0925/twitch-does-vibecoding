---
phase: 05
slug: build-history-stream-night-dry-run
status: verified
threats_open: 0
asvs_level: 2
created: 2026-07-10
---

# Phase 05 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Verified against the current post-review implementation (05-REVIEW warnings + IN-01/IN-03 RESOLVED; 663 tests green). Every mitigation below was grep/line-verified in the implemented code — documentation and intent were NOT accepted as evidence. The audience-facing changelog (`GET /history` / `GET /api/history`) is the new attack surface this phase introduces; it received the deepest scrutiny.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| chat-derived suggestion text → durable `build_history` row | Only gate-APPROVED `QueuedTask.text` may persist; raw pre-gate text must never enter the table | Gate-approved title only (single funnel, branded task) |
| build lifecycle → append-only ledger | A completed build persists exactly one row; an aborted/vetoed build persists none | Terminal outcome (`built`/`refused`/`failed`) + provenance |
| `build_history` (server) → public `/api/history` wire | Coarse projection: 4-value provenance collapses to 3; donor identity/amount/trigger/rationale/category/task-id/raw-timestamp dropped | `{ title, provenance(vote\|paid\|chaos), result, timeLabel }` only |
| chat-derived title → audience browser DOM | Untrusted text rendered on a screen-shareable page | textContent-only, 100-char truncated |
| network → `/history` server | A fourth localhost surface must stay loopback-bound + read-only | GET-only, no mutation path, no ws |
| completed builds → live screen-share (dry run) | The night's honest outcomes must appear without re-broadcasting pre-gate text or donor detail | Gate-approved titles + coarse projection (human-verified) |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation (verified in code) | Status |
|-----------|----------|-----------|-------------|-------------------------------|--------|
| T-05-01 | Tampering | pre-gate / banned text in `build_history` (D-03) | mitigate | `recordBuildHistory` is called from a SINGLE site — `finalize()` (`build-session.ts:379-386`) with `task.text` off an already-branded `QueuedTask`; append-only by construction (`schema.sql:138-146`, no session/day column, INSERT-only helper `record.ts:558-583`); grep confirms ZERO `UPDATE`/`DELETE` against `build_history` anywhere in `src/**`; the append-only self-test `record.test.ts:397` (`source not.toMatch /UPDATE\|DELETE/i`) is green | closed |
| T-05-02 | Repudiation | aborted/vetoed build silently recorded as "built" | mitigate | `finalizeAborted()` (`build-session.ts:416-424`) writes `recordSandboxTeardown`, NOT `recordBuildHistory` — zero changelog rows on abort; `mapStageToResult` (`:358-360`) is 1:1 honest (done→built, failed→failed, refused→refused); e2e drives an aborted build (`build-history.e2e.test.ts:306`) and asserts it never surfaces | closed |
| T-05-03 | Tampering | provenance mis-attribution (paid/chaos recorded as vote) | mitigate | provenance is threaded EXPLICITLY, not mode-inferred: pinned inside `runPipeline` under concurrency-1 (`build-session.ts:298,738`), read at `finalize()` (`:383`); the three drivers pass `vote`/live-trigger/`chaos`; per-driver assertions in `build-flow`/`paid-window-loop`/`chaos-mode` e2e tests catch a defaulted wiring | closed |
| T-05-04 | Tampering (XSS) | chat-derived title on the audience page | mitigate | `history.js` renders every node via `el()`/`textContent` (`:23-28`); the untrusted title is `textContent` + JS-truncated to 100 chars (`:64`); NO `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval` anywhere; `dom-safety.test.ts` auto-scans `src/**/public/*.js` via a regex glob (`:26-30`) that covers `src/history/public/history.js` without hardcoding it, and fails the build on any sink | closed |
| T-05-05 | Info Disclosure | donor identity / amount / trigger-type leaking onto the screen-shareable changelog | mitigate | `HistoryEntry` carries ONLY `{ title, provenance, result, timeLabel }` (`server.ts:38-44`); `buildHistoryPage` selects exactly those four fields (`:196-201`); `coarsenProvenance` (`:129-133`) is WHITELIST-only (vote/chaos pass, everything else → `paid`, collapsing `donation\|channel_points`); `buildId` REMOVED from the wire per IN-01 (confirmed absent); e2e asserts against raw serialized bytes — `not.toContain("donation"/"channel_points")`, forbidden field-name list, and `Object.keys(entry)` === exactly the four fields (`build-history.e2e.test.ts:340-357`) | closed |
| T-05-06 | Info Disclosure | re-broadcasting pre-gate / rejected text on the page (D-03) | mitigate | the page's ONLY data source is `listBuildHistory` over `build_history` (`server.ts:260`), which per T-05-01 holds solely gate-approved `task.text`; there is NO query path from this surface to `audit_log` pre-gate text; refused/failed render the honest WORD ("Refused"/"Failed"), never raw rejected-at-intake text | closed |
| T-05-07 | Elevation of Privilege | a second write path / non-read-only surface | mitigate | copied from `preview/server.ts`: `isLoopbackHostHeader` 403 is the FIRST middleware, all methods (`server.ts:234-240`); listen host pinned to `127.0.0.1` (`:271`); NO `express.json()`, NO POST/PUT/DELETE/PATCH, NO `WebSocketServer` — the ONLY dynamic route is `GET /api/history` (`:251`); `server.test.ts:341-349` asserts every mutation method 404s | closed |
| T-05-08 | Denial of Service | adversarially-large history / a single huge night | mitigate | 10-nights-per-page (`DEFAULT_NIGHTS_PER_PAGE`, `server.ts:81`) + defensive 50-entry/night cap with overflow indicator (`MAX_ENTRIES_PER_NIGHT`, `:85,195,208`); zod-bounded `limit` (`min(1).max(50)`, `:100`); `ROW_CAP` 2000 with a `hasOlder` heuristic (`:217`) that survives a single night larger than the cap (WR-04 fix) | closed |
| T-05-09 | Elevation of Privilege | live-only gate-bypass / sandbox-escape under real conditions | mitigate | code paths proven vs injected fakes (single-funnel, sandbox isolation from Phases 1–3); `05-DRY-RUN.md` §1 blocks the rehearsal on Phase 3 Wave 0 WSL2 GO + Phase 4 live gate GO, and §6 mandates an audit review proving zero unfiltered inputs reached an agent. **Verified-in-code; live confirmation gated at the PENDING dry-run GO** (see Deferred Confirmations) | closed (code) |
| T-05-10 | Denial of Service | kill switch failing against a genuinely in-progress build | mitigate | the `finalizeAborted` clean-abort path is code-verified (`build-session.ts:416-429`, no false "BUILT IT" beat, no changelog row); `05-DRY-RUN.md` §5 exercises the veto against a real mid-session build and requires a clean abort within seconds as a GO condition. **Verified-in-code; live confirmation gated at the PENDING dry-run GO** | closed (code) |
| T-05-11 | Repudiation | false "built" record or re-broadcast rejected text on the live changelog | mitigate | underpinned by T-05-02 (abort → no row) + T-05-05/06 (coarse projection, gate-approved only), all code-verified above; `05-DRY-RUN.md` §5–6 confirm the aborted build adds no row and only honest, donor-free entries render. **Verified-in-code; live confirmation gated at the PENDING dry-run GO** | closed (code) |
| T-05-12 | Info Disclosure | donor identity/amount visible on stream during a real donation window | mitigate | Phase-4 coarse overlay projection (`overlay/server.ts` narrows to `{donorDisplayName, endsAtMs}`, verified in 04-SECURITY T-04-03); `05-DRY-RUN.md` §4 confirms the banner shows donor + countdown only, no amount/message. **Verified-in-code (Phase 4); live confirmation gated at the PENDING dry-run GO** | closed (code) |
| T-05-SC | Tampering (supply chain) | package installs | accept | all three Phase 5 plans install NO new packages (`added: []` in every 05-SUMMARY); reuses `better-sqlite3`/`zod`/`express` already vetted in Phases 1–4 | closed (accepted) |

*Status: open · closed · closed (code = code mitigation verified, live proof gated at the dry-run GO) · closed (accepted)*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-05-01 | T-05-SC | No new dependencies were added in Phase 5 (verified: every 05 summary lists `tech-stack.added: []`). Supply-chain surface is unchanged from the Phase 1–4 baseline; no re-vet required. | Ross (phase owner) | 2026-07-10 |

*Note: T-05-09..12 are `mitigate` (not accepted). Their code mitigations are verified present; only the deliberately-deferred LIVE human confirmation is pending — tracked below, not as an accepted risk.*

---

## Deferred Confirmations (live human gate — not a code blocker)

The dry-run runbook `05-DRY-RUN.md` exists with a PENDING GO/NO-GO verdict block and all six mandated sections (preconditions, test-channel setup, full-loop, paid+chaos, kill-switch-vs-in-progress, audit+changelog review). Its §1 correctly BLOCKS the rehearsal on both earlier human gates reading GO first (Phase 3 Wave 0 WSL2 GO in `SANDBOX-SETUP.md`; Phase 4 live gate GO in `04-LIVE-GATE.md`), and its §4/§6 explicitly require donor-free overlay + a screen-share-safe changelog as GO conditions.

| Threat Ref | Code side (verified now) | Live proof (pending dry-run GO) |
|------------|--------------------------|---------------------------------|
| T-05-09 | Single-funnel gate + sandbox isolation code-proven vs fakes | §3/§6: zero unfiltered inputs reached an agent, on a low-stakes test channel |
| T-05-10 | `finalizeAborted` clean abort, no false completion, no row | §5: veto halts a genuinely in-progress build within seconds |
| T-05-11 | Abort→no-row + coarse projection + gate-approved-only | §5/§6: no false "BUILT IT", no pre-gate/donor text on the changelog |
| T-05-12 | Phase-4 overlay narrows to donorDisplayName + endsAtMs | §4: banner shows donor + countdown only, no amount, on stream |

**These are verified-in-code + confirmed-at-dry-run: the code mechanisms are present and tested; the runbook exists and is correctly gated; the final live sign-off is the PENDING `05-DRY-RUN.md` verdict.** The dry run is `autonomous:false` by design and does not block the code from shipping — it blocks the first REAL stream night.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-10 | 13 | 13 (8 mitigate-verified + 4 code-verified/live-gated + 1 accepted) | 0 | gsd-security-auditor (Claude) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log (AR-05-01)
- [x] Live-gated confirmations documented (T-05-09..12) — code verified, dry-run GO pending
- [x] `threats_open: 0` confirmed (no code mitigation is absent)
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-10

---

## Unregistered Flags

None. No Phase 5 summary (`05-01-SUMMARY.md`, `05-02-SUMMARY.md`) carries a `## Threat Flags` section, and no new attack surface appeared during implementation that lacks a threat mapping. The one new network surface introduced — the `/history` changelog server — is fully covered by T-05-04 through T-05-08.

## Verification Notes

- **IN-01 (buildId removal) confirmed in code.** The plans and both summaries describe a five-field wire including `buildId`, but 05-REVIEW finding IN-01 removed it. The live implementation is the FOUR-field shape: `HistoryEntry` = `{ title, provenance, result, timeLabel }` (`server.ts:38-44`), and `build-history.e2e.test.ts:354-357` asserts `Object.keys(entry)` equals exactly those four. The sequential `build_history.id` is no longer disclosed to the audience wire.
- **IN-03 (whitelist coarsening) confirmed.** `coarsenProvenance` (`server.ts:129-133`) passes only `vote`/`chaos`; every other DB value (including any future/unexpected string) collapses to `paid` — no raw DB provenance is ever echoed. The client mirrors this defense-in-depth: unknown provenance/result render muted `chip-unknown`/`result-unknown`, never a celebratory "VOTE"/"Built" (`history.js:52-53,60,66`).
- **Append-only discipline is non-vacuous.** A `src/**` grep for `UPDATE`/`DELETE` returns matches only against `rounds`, `review_queue`, `control_windows`, and the single deliberate `audit_log` purge (`purge.ts:37`) — ZERO against `build_history`. The `record.test.ts:397` self-test greps `record.ts` itself for the same, and is green.
- **dom-safety scan covers the new surface automatically.** `collectPublicJs()` (`dom-safety.test.ts:26-30`) discovers files by the `src/.+/public/.+\.js` pattern, so `history.js` is scanned without being named. Its `files.length >= 2` + explicit console/overlay assertions remain green with history.js added.
