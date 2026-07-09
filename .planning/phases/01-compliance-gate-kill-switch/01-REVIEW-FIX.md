---
phase: 01-compliance-gate-kill-switch
fixed_at: 2026-07-09T15:42:00Z
review_path: .planning/phases/01-compliance-gate-kill-switch/01-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report

**Fixed at:** 2026-07-09
**Source review:** .planning/phases/01-compliance-gate-kill-switch/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (1 Critical + 6 Warning; Info findings IN-01..IN-03 out of scope)
- Fixed: 7
- Skipped: 0

Verification at branch tip: `tsc --noEmit` clean, `vitest run` 223/223 passing
(18 files), `biome check src tests scripts` clean. Safety invariants
re-verified: exactly one `as QueuedTask` (src/compliance/gate.ts toQueuedTask),
sole SQL DELETE in src/audit/purge.ts, zero innerHTML in
src/operator-console/public/console.js.

## Fixed Issues

### CR-01: Operator console `/api/halt` is CSRF-triggerable

**Files modified:** `src/operator-console/server.ts`, `tests/e2e/halt.e2e.test.ts`
**Commit:** 9099b16
**Applied fix:** New middleware guards every non-GET/HEAD route uniformly (not
just /api/halt): (1) a present Origin header must exactly match the server's
own Host origin; (2) Content-Type must be application/json, which forces a
CORS preflight the server never approves and closes the empty-body loophole
(text/plain body → `{}` → HaltBodySchema passing). e2e tests cover the
text/plain simple request, Origin mismatch, the console's own same-origin
fetch shape, and a no-Content-Type POST. Console UI (postJson always sends
application/json, same-origin) and e2e clients (no Origin, JSON content-type)
are unaffected.

### WR-01: WebSocket state channel has no origin check

**Files modified:** `src/operator-console/server.ts`, `tests/e2e/console-flows.e2e.test.ts`
**Commit:** 990b975
**Applied fix:** `verifyClient` on the WebSocketServer rejects (401) any
handshake whose Origin is present but does not match `http://{Host}`.
Browsers always send Origin on ws handshakes, so malicious pages are dropped
at upgrade time; non-browser clients (no Origin) remain allowed. e2e tests
cover foreign-Origin rejection, same-origin acceptance with full-state push,
and no-Origin clients.

### WR-02: Console halt and hotkey halt are wired asymmetrically

**Files modified:** `src/operator-console/server.ts`, `src/main.ts`, `tests/e2e/halt.e2e.test.ts`
**Commit:** f3c13f3
**Applied fix:** `ConsoleServerDeps` gains optional `abortActiveWork`;
`createApp` passes `(frozen) => abortActiveWork(registry, frozen, logger)` to
`startConsoleServer`, and `/api/halt` builds the same abort-bearing HaltDeps
the hotkey path uses. Phase-1 e2e test registers an AbortController in
`handle.registry` and asserts a console halt aborts it.

### WR-03: Live classifier API contract verified by mocks only

**Files modified:** `src/compliance/classifier.ts`, `src/compliance/classifier.contract.test.ts` (new)
**Commit:** fa82330 (+ 2a9edc1 import-order lint fix)
**Applied fix:** The parse request in classifier.ts is now pinned with
`satisfies Anthropic.MessageCreateParamsNonStreaming` so SDK shape drift
fails `tsc --noEmit`. New network-free contract test pins (a) the runtime
`messages.parse` symbol on the installed SDK, (b) the exact request shape
(model/max_tokens/system/messages/output_config.format json_schema) against
the SDK's own request type, and (c) `parsed_output` as a key of
`ParsedMessage`. No live API call added; `npm run gate:eval` remains the
opt-in pre-stream real-API check.

### WR-04: `triggerHalt` flips state before writing the audit row

**Files modified:** `src/state-machine/halt.ts`, `src/state-machine/stream-mode.test.ts`
**Commit:** dfba658
**Applied fix:** `recordHalt` wrapped in try/catch inside `triggerHalt`: the
halt always succeeds and is never blocked or unwound by a ledger failure; the
audit gap is surfaced via a loud `logger.error` instead of an uncaught
exception (500 on the console path). Unit test injects a throwing db and
asserts HALTED state, correct frozen snapshot, and the logged failure.

### WR-05: `discard-and-resume` recovery can emit two `veto` audit rows

**Files modified:** `src/operator-console/public/console.js`
**Commit:** b4c48e7
**Applied fix:** The client no longer surfaces the veto reason row after
`discard-and-resume` — `recover()` already writes the veto audit row
server-side, and the follow-up tag POST targeted the active (never-queued)
task id, appending a second bare veto row. One discard now produces exactly
one veto row. (Trade-off, per review option 1: the discard veto carries
reasonTag null; the append-only ledger forbids amending the existing row.)

### WR-06: Homoglyph fixture cites wrong codepoint and misspelled keyword

**Files modified:** `src/compliance/fixtures/adversarial.fixtures.ts`, `src/compliance/prefilter.test.ts`
**Commit:** 4a779f4
**Applied fix:** Fixture note corrected: the glyph is U+2113 (SCRIPT SMALL L,
not stripped by normalize()) and the keyword has a single g, so the case
deliberately relies on the Sonnet classifier via gate:eval. The prefilter
test description misnaming U+0261 ("Latin small L with tail") corrected to
"Latin small letter script g", and a new `prefilterCheck` case asserts the
U+0261 homoglyph insertion IS stripped and caught by the prefilter.

## Auxiliary change

**Commit:** 60ee6f7 — `.gitattributes` with `* text=auto eol=lf`. Before any
fix was applied, `npm run lint` failed on all 40 files with format-only CRLF
errors: `core.autocrlf=true` checked out CRLF while Biome requires LF. The
attribute pins LF in the working tree; both the fix worktree and the main
working tree were renormalized, after which `biome check src tests scripts`
passes cleanly.

## Skipped Issues

None. (Info findings IN-01, IN-02, IN-03 were out of fix scope and remain
open in REVIEW.md.)

---

_Fixed: 2026-07-09_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
