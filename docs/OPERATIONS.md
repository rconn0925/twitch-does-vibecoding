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

## 6. Twitch Chat Integration

Setup, re-auth, and failure behavior for the chat-vote loop (Phase 2). Without
this setup the app still runs — console and overlay come up, chat stays off,
and the console shows the red "unauthorized" Twitch pill.

### 6.1 One-Time Setup: Register the App

1. Go to <https://dev.twitch.tv/console/apps> **while logged into the
   broadcaster account** and register a new application:
   - **OAuth Redirect URL:** `http://localhost:4900/auth/callback`
     (if you changed `CONSOLE_PORT`, use that port instead — the app derives
     the redirect from `CONSOLE_PORT` unless `TWITCH_REDIRECT_URI` overrides it)
   - **Category:** anything reasonable (e.g., "Broadcaster Suite")
2. Copy the Client ID, generate a Client Secret, and fill `.env` at the repo
   root:

   ```ini
   # .env
   TWITCH_CLIENT_ID=your-client-id
   TWITCH_CLIENT_SECRET=your-client-secret
   TWITCH_BROADCASTER_USER_ID=your-numeric-twitch-user-id
   ```

   The broadcaster user id is the NUMERIC Twitch id (not the login name) —
   look it up with any "Twitch username to user id" converter, or via
   `twitch api get users -q login=<name>` if you have the Twitch CLI.

### 6.2 Authorize (One Browser Visit)

1. Start the app (`npm run dev`). The log will say Twitch is not yet
   authorized and the console pill shows "unauthorized".
2. **Log into the broadcaster account in your browser first** — the scopes
   bind to whichever account approves the consent screen, and the wrong
   account means the bot reads/writes chat as the wrong user.
3. Visit <http://127.0.0.1:4900/auth/start> and approve. The app requests
   exactly two scopes: `user:read:chat` and `user:write:chat` — nothing else
   (channel-points scopes come later, in Phase 4).
4. Expect the "Twitch authorized — now RESTART the app" page. **First-time
   authorization requires one restart:** the chat pipeline is composed at
   boot, and it could not compose without a token. Restart the app
   (`npm run dev` again), then confirm the console log line that the
   EventSub listener started and the console pill turning green.

The token persists at `TWITCH_TOKEN_PATH` (default `./data/twitch-token.json`)
and auto-refreshes — restarts do NOT require re-authorizing. Treat that file
like a password: it grants chat read/write as the broadcaster.

### 6.3 Re-Auth After Revocation or Expiry

If the console shows **"Twitch login expired"** (or the pill goes red after a
password change / disconnection of the app in Twitch settings): visit
<http://127.0.0.1:4900/auth/start> again while logged into the broadcaster
account. Because the app booted with a working token, the fresh token
registers directly on the **running** chat pipeline — same flow, any time,
while the app is running, no restart needed (the success page says "chat is
reconnecting"). Only the first-ever authorization — when the app booted with
no token at all — needs the one restart described in 6.2.

### 6.4 Chat Rate Budget

The bot sends at most **~15 messages per 30 seconds** (`CHAT_SEND_INTERVAL_CAP`
/ `CHAT_SEND_INTERVAL_MS`), well inside Twitch's broadcaster-tier limit of
100/30s. This works because of the budget doctrine: **chat gets transitions,
the overlay gets state.** Chat hears round open, round close/winner, and
coalesced rejection/cooldown feedback — live tallies and countdowns render on
the overlay only and NEVER go to chat. If chat narration ever seems throttled,
that is the sender queue smoothing a burst, not an outage.

### 6.5 Honest Limitation: Votes During a Connection Gap Are Lost

If the EventSub connection drops mid-round (look for `EventSub socket
disconnected` in the log), **votes typed while the socket is down are gone** —
Twitch EventSub has no event replay, so no software could recover them. What
IS guaranteed:

- Every vote the app **acknowledged** (written to SQLite before the drop)
  survives — reconnection re-syncs the tally from the ledger, and a crash
  can't lose them either (see 6.6).
- The reconnect is logged (`EventSub socket (re)connected and ready`) and the
  console pill tracks the connection honestly.

If a round overlapped a visible gap and the result feels compromised, treat it
as a compromised round: let it close, veto the winner from the console if
needed, and run the round again.

### 6.6 Crash Recovery Mid-Round

Restarting the app mid-round (crash or Ctrl+C) is safe: the round restores
from SQLite automatically at startup — same round, same tally, same remaining
time — before the console or chat listener accepts any input. A round whose
timer expired while the process was down closes immediately on startup and its
winner still enqueues through the normal funnel.

A round frozen by a halt survives a restart WITH its halt: at startup the
frozen round restores (same tally, same frozen remainder) and the app
**re-enters HALTED**, so the console shows the recovery triage exactly as it
did before the crash. Pick one, same as any halt (D-04 — nothing
auto-resumes):

- **Resume** — the round continues with its exact frozen remaining time.
- **Reset to Idle** — the round is discarded (audited): its candidates return
  to the suggestion pool and its acknowledged votes remain in the ledger
  (nothing is deleted, D-02). Start a fresh round whenever ready.

No acknowledged vote is ever lost to a restart.

## 7. Build-History Changelog (Phase 5)

The changelog is the audience-facing "the audience built this together" page —
a read-only, reverse-chronological list of completed builds grouped by stream
night. It is served on loopback like the other surfaces and is **safe to
screen-share**.

### 7.1 Opening It

- Served at <http://127.0.0.1:4903/> on its OWN surface — a separate server on
  `HISTORY_PORT` (default **4903**), distinct from the console (4900), overlay
  (4901), and preview (4902). Loopback-bound; non-loopback Host headers get 403,
  so it never leaves the machine in v1. Point a browser tab or OBS source at the
  bare origin — the changelog page is served at `/`.
- It is **read-only**: `GET /` (page) and `GET /api/history` (data) only.
  There are no mutating routes, no WebSocket, and no `express.json` body parser —
  nothing on this surface can change state.
- Full history loads on open and paginates by night (10 nights per page, a
  "load older" cursor); each night caps at 50 entries in the projection.

### 7.2 What It Shows (and Deliberately Does Not)

Each entry is a **gate-APPROVED** build: its title, a provenance chip, an honest
result, and a time label. Provenance chips reuse the Phase-4 vocabulary:

| Chip | Meaning |
| --- | --- |
| **VOTE** | A vote-round winner. |
| **FREE REIGN** | A paid free-reign window build (donation OR channel-points — both coarsen to the same chip; the trigger type is NOT shown). |
| **CHAOS PICK** | A chaos-mode random pick, no vote. |

Results are honest but calm: **Built** (green), **Refused** / **Failed**
(amber). There is **no red** on this surface (red is reserved for the live
kill-switch state), and there are no screenshots in v1.

Load-bearing compliance guarantees (D-03), the same ones the invariant tests and
the e2e test enforce — verify by eye during the dry run:

- **Only gate-approved titles appear.** Pre-gate / rejected-at-intake text NEVER
  reaches this page — a `refused`/`failed` row is a suggestion that *passed*
  intake and later failed (e.g. COMP-02 in-flight or a build error), never raw
  banned text.
- **No donor identity or amount, no trigger type** — the coarse projection
  carries none of it (a paid build is indistinguishable from a channel-points
  one here).
- Chat-derived titles render **textContent-only** (truncated) — no `innerHTML`,
  so a suggestion title can never inject markup on the shared screen.

### 7.3 Durability

The changelog is a **view over the durable ledger** — a build-history row is
written at build completion (`recordBuildHistory`), so entries survive process
restarts and span multiple stream nights automatically (SQLite is durable). A
**killed / aborted build writes NO changelog row** (`finalizeAborted` records
the teardown but never a `build_history` entry) — so a vetoed build never shows
up as if it shipped. This is one of the dry-run checks (Section 5 of the
runbook).

## 8. Stream-Night Dry Run (v1 Go-Live Gate)

Before the first REAL stream night, run the end-to-end rehearsal in
`.planning/phases/05-build-history-stream-night-dry-run/05-DRY-RUN.md` on a
**low-stakes test channel**. It consolidates every deferred human gate into one
pass and ends in a recorded **GO / NO-GO** verdict.

- **Preconditions (both must read GO first):** Phase 3 Wave 0 WSL2 go/no-go
  (`SANDBOX-SETUP.md`) and the Phase 4 live gate (`04-LIVE-GATE.md`). The dry run
  exercises both, so it is BLOCKED until they are cleared.
- **What it rehearses:** the full suggest→filter→vote→build→preview loop, a real
  small donation free-reign window, a channel-points window, a chaos round, the
  **kill switch against a genuinely in-progress build** (confirm HALTED is
  instant, no false "BUILT IT", and no changelog row for the killed build), and
  an audit + changelog review (zero unfiltered inputs reached an agent, every
  rejection produced chat feedback, no donor detail or pre-gate text on the
  shared changelog).
- **Do not run a real stream night until the runbook's verdict reads GO.** A
  NO-GO records the failing check; fix it and re-run that section.
