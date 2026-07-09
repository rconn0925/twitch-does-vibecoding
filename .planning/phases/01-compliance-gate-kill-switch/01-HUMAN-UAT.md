---
status: partial
phase: 01-compliance-gate-kill-switch
source: [01-VERIFICATION.md]
started: 2026-07-09T15:45:00Z
updated: 2026-07-09T15:45:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Physical panic-hotkey test (COMP-04 final sign-off)
expected: With `npm run dev` running and a DIFFERENT application focused (e.g. Notepad), double-tapping the panic key (default F13, or `PANIC_HOTKEY` from `.env`) within 2 seconds shows the red HALTED banner on http://127.0.0.1:4900 and logs a halt with source "hotkey". A single tap followed by 3 seconds of waiting does nothing. See docs/OPERATIONS.md §1 for the UIPI elevated-app limitation.
result: [pending]

### 2. Live Sonnet gate eval (SC2 live-model SAFETY FAIL bar)
expected: With a real `ANTHROPIC_API_KEY` in `.env`, `npm run gate:eval` runs the adversarial fixture suite against real Sonnet and exits 0 (no SAFETY FAIL). Re-confirm the `claude-sonnet-5` GATE_MODEL id against GET /v1/models first.
result: [pending]

### 3. Browser console run-through
expected: All four console views (Needs Review, Active Queue, HALTED triage takeover, Audit Log) render per 01-UI-SPEC.md; dev submission form → gate → console flow works end-to-end; veto with reason tags and recover flows behave correctly.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
