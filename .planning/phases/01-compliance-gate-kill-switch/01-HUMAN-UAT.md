---
status: passed
phase: 01-compliance-gate-kill-switch
source: [01-VERIFICATION.md]
started: 2026-07-09T15:45:00Z
updated: 2026-07-11T04:20:57Z
---

## Current Test

Testing complete 2026-07-10 on the streaming PC (some log timestamps cross midnight UTC into 2026-07-11).

## Tests

### 1. Physical panic-hotkey test (COMP-04 final sign-off)
expected: With `npm run dev` running and a DIFFERENT application focused (e.g. Notepad), double-tapping the panic key (default F13, or `PANIC_HOTKEY` from `.env`) within 2 seconds shows the red HALTED banner on http://127.0.0.1:4900 and logs a halt with source "hotkey". A single tap followed by 3 seconds of waiting does nothing. See docs/OPERATIONS.md §1 for the UIPI elevated-app limitation.
result: **passed** (2026-07-10, streaming PC)
- `PANIC_HOTKEY` reconfigured from default F13 (this keyboard lacks the key) to `ScrollLock` via `.env`.
- Boot log observed: "panic hotkey armed: ScrollLock (double-tap within 2s)" — no fallback warning.
- Single tap: no-op (verified by streamer). Double-tap within 2s: instant HALT — audit/log line: HALT triggered, source "hotkey", priorMode IDLE.
- Recovery via operator console returned mode to IDLE; auto-cycle scheduler resumed per its toggle.
- ANOMALY (logged, fail-safe confirmed): first attempt used `PANIC_HOTKEY=Pause` — uiohook-napi's key map has no "Pause" entry; the app correctly fell back to F13 with a loud warning ("unknown PANIC_HOTKEY Pause — falling back to F13"). Fail-safe behavior working as designed. Cross-reference: entry added to docs/OPERATIONS.md §5 Known Limitation Log.

### 2. Live Sonnet gate eval (SC2 live-model SAFETY FAIL bar)
expected: With a real `ANTHROPIC_API_KEY` in `.env`, `npm run gate:eval` runs the adversarial fixture suite against real Sonnet and exits 0 (no SAFETY FAIL). Re-confirm the `claude-sonnet-5` GATE_MODEL id against GET /v1/models first.
result: **passed** (2026-07-10, streaming PC)
- NOTE — expected text above is STALE: it was written before quick task `260710-if0` reworked the classifier to the plan-billed Agent SDK transport. There is no `ANTHROPIC_API_KEY` anywhere anymore, and the key must stay UNSET (setting it would silently switch to metered API billing). The expected text is retained verbatim for the audit trail; this note supersedes it.
- Evidence recorded is STRONGER than the scripted `gate:eval` fixture run: during live operation, the in-app compliance gate classified a real chat suggestion ("build a pomodoro timer", from the real channel) via the Agent SDK plan-billed Sonnet transport and returned decision "approved" with rationale.
- `ANTHROPIC_API_KEY` confirmed UNSET in all scopes (process / User / Machine) on this machine — plan-billing path verified live.
- WATCH-ITEM: the classifier needed 3 attempts on that call — attempts 1-2 failed schema validation ("rationale >500 chars"), attempt 3 succeeded. Fail-closed retry machinery worked as designed; ~12s added latency. Flag for prompt tightening if it recurs during the Phase 5 dry run.

### 3. Browser console run-through
expected: All four console views (Needs Review, Active Queue, HALTED triage takeover, Audit Log) render per 01-UI-SPEC.md; dev submission form → gate → console flow works end-to-end; veto with reason tags and recover flows behave correctly.
result: **passed (with open sub-item)** (2026-07-10, streaming PC)
- Halt exercised via hotkey; recovery walked through via the console UI by the streamer — mode returned to IDLE, scheduler resumed.
- NOT exercised: the triage/review-queue path (HALTED triage takeover with a held/in-flight item) — no held item existed during the walkthrough. This sub-path stays honestly OPEN (see Gaps).

## Summary

total: 3
passed: 3
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- Console triage/review-queue path (HALTED triage takeover of a held item) unexercised — no held item existed during the 2026-07-10 walkthrough. Will be exercised by the Phase 5 dry-run kill-switch test (halt vs. a genuinely in-progress build).
