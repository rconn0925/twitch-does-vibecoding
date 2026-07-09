# Operations Runbook — Panic Hotkey & Kill Switch

Pre-stream operational rules for the streamer kill switch (COMP-04). Read this
before every stream night. The whole point of the panic hotkey is that it works
while ANY application has focus — the rules below keep that guarantee true.

## 1. UIPI Rule: Never Run OBS (or Any Focused App) Elevated

**Never run OBS Studio — or any application that will hold focus during a live
show (games, browsers, editors) — "as Administrator" while the orchestrator
runs non-elevated.**

Why: Windows User Interface Privacy Isolation (UIPI) silently blocks the global
keyboard hook while an elevated window has focus. There is no error, no log
line — the panic hotkey just appears intermittently dead, depending on which
window happens to have focus. This is the worst possible failure mode: it looks
fine in testing against Notepad and fails live when an elevated game grabs
focus.

Resolution order:

1. **Preferred: keep everything non-elevated.** OBS, the orchestrator, and any
   app that takes focus during the show all run at normal integrity level.
2. **Not recommended: elevating the orchestrator to match.** The orchestrator
   process holds Twitch and Anthropic API credentials — running it elevated
   widens the blast radius of any future orchestrator-side compromise. Prefer
   de-elevating the other app instead.

If an elevated app is unavoidable during the show, treat the hotkey as dead
while that app has focus and rely on the operator console's Halt button
(http://127.0.0.1:4900) — it is an independent, redundant kill path (D-01).

## 2. Hotkey Startup Self-Test (Every Stream)

Before going live, prove the hook is actually receiving keystrokes:

1. Start the orchestrator (`npm run dev`) and confirm the log line
   `panic hotkey armed: F13 (double-tap within 2s)`.
   - If you instead see `PANIC HOTKEY UNAVAILABLE — console Halt button is the
     only kill path`, the native hook failed to load. Do NOT go live relying on
     the hotkey; the console Halt button is your only kill path until fixed.
2. Open the operator console at http://127.0.0.1:4900 — mode pill shows IDLE.
3. Focus a NON-ELEVATED window that is not the console page (e.g., Notepad).
4. Double-tap the panic key within 2 seconds.
5. Confirm the console shows the red HALTED banner and the terminal logs the
   halt with source `hotkey`.
6. Recover: pick **Reset to Idle** from the console (D-04 — nothing
   auto-resumes).
7. Single-tap the panic key once and wait 3 seconds — confirm nothing happens
   (double-tap accidental-press protection, D-03).

If step 5 fails while a plain non-elevated window has focus, the hook itself is
broken (see the limitation log below) — do not go live until diagnosed.

## 3. PANIC_HOTKEY Configuration

- **Default key: `F13`.** F13–F24 are ideal panic keys: real keyboards with
  macro pads and remappable keyboards (via QMK/VIA or vendor software) can
  emit them, and nothing on Windows or OBS binds them out of the box.
- To change the key, set `PANIC_HOTKEY` in `.env` at the repo root:

  ```ini
  # .env
  PANIC_HOTKEY=F14
  ```

- Valid values are uiohook key names (`F1`–`F24`, letters, etc. — see
  `UiohookKey` in uiohook-napi). An unknown value logs a warning at startup and
  falls back to `F13` — check the armed-hotkey log line to confirm which key is
  actually live.
- Avoid keys with OS-wide or OBS-wide bindings (media keys, `F12` which many
  apps bind to dev tools/screenshots, anything OBS uses for scene hotkeys).

## 4. Halt / Recovery Quick Reference

| Action | Effect |
| --- | --- |
| **Double-tap panic key** (within 2s) | Freeze everything: instant transition to HALTED from any state. In-progress work is force-killed (process tree, SIGKILL), queue and round state frozen. **Nothing is deleted** (D-02). |
| Single tap | Nothing (arming only — accidental-press protection, D-03). |
| Double-tap while already HALTED | Ignored — the frozen triage snapshot is never overwritten. |
| Console **Halt** button | Same HALTED transition, independent of the hotkey (works even if the hook is dead). |

Triage happens from the console (http://127.0.0.1:4900) while HALTED — the
frozen snapshot shows what was in flight. Pick exactly one (D-04):

- **Resume** — return to the mode you halted from; nothing discarded.
- **Discard Task & Resume** — veto the in-flight task (audited), then resume.
- **Reset to Idle** — drop back to IDLE; queue contents remain for review.

Every halt and veto is written to the audit ledger with its source
(`hotkey` / `console`) — COMP-05.

The state flip is intentionally decoupled from the kill: HALTED is reported
instantly even if a wedged process takes a few seconds to die (or refuses —
tree-kill failures are logged as
`abort attempt failed after HALT — task may still be running`; if you see that
line, check Task Manager for orphaned `node` processes before resuming).

## 5. Known Limitation Log

Machine-specific hotkey anomalies discovered during checkpoint verification or
live operation. Add an entry any time the hotkey misbehaves.

| Date | Windows build / context | Symptom | Workaround |
| --- | --- | --- | --- |
| — | — | (none recorded yet — pending first human verification on the streaming PC) | — |

Known-by-design (not bugs):

- **Elevated-foreground UIPI block** — see rule 1. Hotkey does not fire while
  an elevated window has focus; console button still works.
- **uiohook-napi prebuilt failure** — if the native binary doesn't load on this
  Windows build, the process starts WITHOUT the hotkey (loud error log) and the
  console button is the only kill path. Documented fallback library:
  `node-global-key-listener` (do not install without a verification pass).
