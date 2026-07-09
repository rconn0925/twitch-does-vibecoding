---
phase: 01-compliance-gate-kill-switch
audited: 2026-07-09
auditor: gsd-security-auditor
asvs_level: 1 (default)
threats_total: 22
threats_closed: 22
threats_open: 0
status: SECURED
---

# Phase 1 Security Audit: Compliance Gate & Kill Switch

Every threat in the plan-time STRIDE register (plans 01-01 through 01-05) was
verified against the implemented code — not against documentation or summary
claims. Stance: every mitigation assumed absent until located at a specific
file:line. All 22 register entries (18 `mitigate`, 4 distinct `accept`
dispositions across 8 rows) resolve to CLOSED or documented-accepted below.

Post-plan hardening from the code-review fix pass (01-REVIEW-FIX.md) was
counted as strengthening evidence where relevant: CSRF Origin+Content-Type
middleware, ws Origin verification, console/hotkey abort symmetry,
halt-audit-write try/catch, and the SDK request-shape `satisfies` pin.

## Threat Verification — `mitigate` dispositions

| Threat ID | Category | Status | Evidence (verified in code) |
|-----------|----------|--------|------------------------------|
| T-01-01 | EoP — console network exposure | CLOSED | `src/operator-console/server.ts:442` — `server.listen(deps.port, "127.0.0.1", ...)` explicit host; `tests/e2e/halt.e2e.test.ts:144-150` asserts bound address is `127.0.0.1`. Strengthened post-plan: CSRF middleware on all non-GET routes (`server.ts:128-144`) and ws `verifyClient` Origin check (`server.ts:175-179`). |
| T-01-02 | Repudiation/Tampering — audit ledger mutation | CLOSED | `src/audit/record.ts` exports 5 INSERT helpers + `listAuditRecords` (SELECT) only; comment-filtered grep for UPDATE/DELETE in record.ts → 0; sole `DELETE FROM` in codebase is `src/audit/purge.ts:37`, enforced live by `tests/invariants/single-funnel.test.ts` check (e) — 6/6 passing at audit time. |
| T-01-03 | Tampering — console route inputs | CLOSED | zod `safeParse` at every route entry: `server.ts:216` (halt), `:250` (recover), `:283-284` (approve), `:302-303` (reject), `:338-339` (veto), `:378` (dev/submit), `:413` (audit query); terse 400s; error boundary `server.ts:429-438` never emits stack traces. Content-Type gate (`server.ts:139-142`) closes the empty-body/text-plain loophole (CR-01 fix). |
| T-01-04 | EoP (stored XSS) — console rendering | CLOSED | `src/operator-console/public/console.js`: grep `innerHTML` → 0, `confirm(` → 0, `insertAdjacentHTML|document.write|outerHTML|eval(` → 0; `textContent` used for dynamic strings (5 occurrences via el()/button() helpers). |
| T-01-SC (01-01) | Tampering (supply chain) | CLOSED | `package.json` dependencies are exactly the 8 audited packages (@anthropic-ai/sdk, better-sqlite3, express, pino, tree-kill, uiohook-napi, ws, zod); `allowScripts` limited to the three audited native/prebuilt packages (better-sqlite3@12.11.1, uiohook-napi@1.5.5, esbuild@0.28.1). |
| T-01-06 | EoP — classifier prompt injection | CLOSED | `src/compliance/classifier.ts:51-79` — `SYSTEM_PROMPT` is a fixed constant with zero interpolation; candidate text appears only in the user-role message (`classifier.ts:110-115`); boundary tests `src/compliance/classifier.test.ts:226-258` prove user-role-only placement and byte-identical system prompt across candidates (sentinel strings); `prompt-injection-attempt` is a first-class reject category with adversarial fixtures. |
| T-01-07 | Tampering (fail-open) — classifier error path | CLOSED | `src/compliance/classifier.ts:167-187` — catch branch RETURNS `CLASSIFIER_UNAVAILABLE_DECISION` (rejected/classifier-unavailable) on the final attempt, never throws; gate adds a second layer: `src/compliance/gate.ts:91-101` fails closed when no classifier is wired or an injected classifier throws. |
| T-01-10 | Info disclosure — ANTHROPIC_API_KEY | CLOSED | Key read only in `classifierDepsFromEnv` (`src/compliance/classifier.ts:34-40`); classifier receives an injected client, never the key; repo-wide grep for key/apiKey in any log call → none; `.env` gitignored (`.gitignore` line 3); `.env.example` ships an empty placeholder. |
| T-01-12 | DoS — hotkey dead under UIPI | CLOSED | `docs/OPERATIONS.md` §1 (never-run-elevated rule, explicit UIPI explanation), §2 (per-stream startup self-test), §5 (limitation log); redundant console kill path independent of the hook (`server.ts:215-246` /api/halt). |
| T-01-13 | DoS — hung task blocking halt | CLOSED | `src/state-machine/halt.ts:24-58` — triggerHalt is synchronous, forceTransition before recordHalt, abort invoked fire-and-forget with `.catch` (never awaited); `src/kill-switch/abort.ts:48-52` — `treeKill(pid, "SIGKILL")` (taskkill /T /F on Windows); e2e proof `tests/e2e/kill-switch.e2e.test.ts:86-98` — HALTED <100ms, signal-ignoring child dead <5s, audit row with source "hotkey". |
| T-01-15 | Tampering — hotkey layer crash | CLOSED | `src/main.ts:178-211` — armPanicHotkey wraps the guarded dynamic `import("uiohook-napi")` in try/catch, degrades to `"PANIC HOTKEY UNAVAILABLE — console Halt button is the only kill path"` and returns null (process survives); `src/kill-switch/hotkey.ts` contains no native import (injected KeyEventSource). |
| T-01-16 | EoP (stored XSS) — attacker-authored suggestion text | CLOSED | Same evidence as T-01-04, now exercised against real attacker-controlled text (suggestion text, usernames, rationales all rendered via textContent). |
| T-01-17 | EoP — review approve as gate bypass | CLOSED | `src/state-machine/review-queue.ts:136` — approve() calls `deps.pool.add(...)` (candidate pool, never TaskQueue); invariant check (b) proves no `.enqueue(` exists outside src/pipeline/; every resolution writes a `review_resolved` audit row (`record.ts:154-178`). |
| T-01-18 | Tampering — /api/dev/submit skipping the gate | CLOSED | `server.ts:391-400` — route calls `submitCandidate` with the pre-bound `classify` (never taskQueue); D-02 refusal surfaced as 409 (`server.ts:401-405`); route sits behind the 127.0.0.1 bind + CSRF middleware; invariant checks (a)/(b)/(d) forbid any bypass construction. |
| T-01-19 | Repudiation — vetoes without triggering input | CLOSED | `server.ts:345-356` — the veto route records `suggestionText: removed.text` + `twitchUsername` from the removed task; e2e console-flows asserts the text lands in the row. Residuals noted below (non-blocking). |
| T-01-20 | Tampering — purge as audit destruction | CLOSED | `src/audit/purge.ts:37` — `DELETE FROM audit_log WHERE created_at_ms < ?` is the only predicate (time cutoff only; no content/decision/event-type targeting); sole-DELETE property enforced by invariant check (e) and grep (`grep -rl "DELETE FROM" src` → purge.ts only). |
| T-01-08 | EoP — QueuedTask constructed outside gate.ts | CLOSED | Non-comment grep for `as QueuedTask` → exactly one hit: `src/compliance/gate.ts:137` (toQueuedTask, which throws unless decision === "approved", `gate.ts:130-138`); `src/queue/task-queue.ts:22` enqueue accepts only the branded type; compile-level proof `src/queue/task-queue.test.ts:53` (@ts-expect-error); invariant checks (a)+(d) passing live at audit time. |
| T-01-09 | Repudiation — unlogged gate decisions/refusals | CLOSED | `src/compliance/gate.ts` — audit() called on the prefilter-reject path (`:78`) and on every classifier/coercion/fail-closed path (`:120`), exactly once per classify(); `src/pipeline/submit.ts:64` — `recordSubmissionRefused` on every D-02 refusal. Residual noted below (GateDeps.db optional for unit tests). |
| T-01-21 | Tampering — input accepted while HALTED | CLOSED | `src/pipeline/submit.ts:61-66` — `deps.mode() === "HALTED"` checked before any classification or pooling; writes submission_refused row; returns `{ accepted: false, reason: "halted" }`; e2e proves 409 over HTTP and that the classifier spy is never invoked while HALTED. |

## Threat Verification — `accept` dispositions (accepted risks log)

| Threat ID | Category | Accepted Risk | Rationale / Conditions |
|-----------|----------|---------------|------------------------|
| T-01-05 | DoS — forceTransition("HALTED") ungated | ACCEPTED | Deliberate design: veto is the highest-priority action from any state (D-02). Reachable only from localhost surfaces; browser-borne cross-origin triggering additionally blocked by the CR-01 CSRF middleware. |
| T-01-11 | DoS — suggestion flood burning metered Sonnet calls | ACCEPTED (this phase) | Prefilter absorbs obvious junk without an API call; D-02 halt cuts intake cost to zero mid-incident; no real ingestion source exists in Phase 1. **Flagged for Phase 2: per-user rate limits MUST land with chat ingestion.** |
| T-01-14 | Spoofing — anyone at the physical keyboard can halt | ACCEPTED | Physical access to the streaming PC is the operator trust boundary by design. Double-tap debounce (D-03) protects against accidents, not attackers. |
| T-01-SC (01-02/03/04/05) | Supply chain — no new installs | ACCEPTED | Verified: dependency set unchanged since plan 01-01's audited install (package.json contains exactly the 8 audited packages; no additions in any later plan). |

## Unregistered Flags

**None.** Plan 01-03's SUMMARY declares `## Threat Flags: None`; the other four
SUMMARYs contain no Threat Flags section and introduce no undeclared network
endpoints, auth paths, or schema surfaces beyond the register.

Post-plan attack surface WAS found by the code review (01-REVIEW.md) and is
already closed with tests — recorded here as review-discovered, not
unregistered:

- **CR-01 CSRF on /api/halt** — fixed 9099b16 (`server.ts:128-144`), e2e-tested
- **WR-01 ws state exfiltration (no Origin check)** — fixed 990b975 (`server.ts:175-179`), e2e-tested
- **WR-02 console/hotkey abort asymmetry** — fixed f3c13f3 (`main.ts:126`, `server.ts:235-244`), e2e-tested
- **WR-04 halt audit-write failure unwinding the kill switch** — fixed dfba658 (`halt.ts:38-45`), unit-tested

## Known Residuals (non-blocking)

1. **DNS-rebinding residual in the CSRF check** — `server.ts:135` compares
   Origin against the request's own Host header, not a fixed allowlist. A
   DNS-rebinding attacker controls both. Practical exposure is low (loopback
   bind + Content-Type gate + no ambient credentials), but pinning the
   expected origin to `http://127.0.0.1:{port}` would remove it. Flagged
   non-blocking.
2. **`GateDeps.db` is optional** (`gate.ts:37`) — an unwired db silently skips
   the COMP-05 audit write. All production wiring passes a db (`main.ts:108`),
   and the option exists solely for the 01-02 unit-test contract, but the
   audit-always property is enforced by wiring convention, not structure.
3. **Two veto-row shapes carry no suggestion text**: the discard-and-resume
   veto (`halt.ts:85-91`, carries taskId only) and the D-18 follow-up tag-only
   row (`server.ts:358-366`). Both are secondary rows on an already-audited
   action; the primary veto path always carries the triggering input.
4. **ws handshakes with no Origin header are allowed** (`server.ts:178`) —
   intentional (non-browser clients); local non-browser processes can read
   console state. Inside the physical-access trust boundary (T-01-14).

## Operational follow-ups (verification completeness, not mitigation gaps)

- **Human hotkey checkpoint pending** (plan 01-03 Task 3): focus-independence
  and machine-specific UIPI behavior must be confirmed on the streaming PC.
  The mitigation artifacts (OPERATIONS.md rule + self-test + redundant console
  path) all exist in code/docs.
- **Live `npm run gate:eval` not yet run** (exit 2, no ANTHROPIC_API_KEY):
  Success Criterion 2's live-Sonnet proof is outstanding. The fail-closed
  design means the untested integration cannot fail open — worst case is
  100% rejection, which the eval run will surface pre-stream.

---
_Audited: 2026-07-09 — gsd-security-auditor_
