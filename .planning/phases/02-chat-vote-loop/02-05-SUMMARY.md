---
phase: 02-chat-vote-loop
plan: 05
subsystem: overlay
tags: [obs, websocket, broadcast, xss-invariant, debounce, tdd]

# Dependency graph
requires:
  - phase: 02-chat-vote-loop
    plan: 01
    provides: RoundSnapshot shape, ROUND_OPENED/ROUND_CLOSED/VOTE_RECORDED events, RoundManager.snapshot()/.on()
  - phase: 02-chat-vote-loop
    plan: 02
    provides: tests/invariants/scan-helpers.ts (stripComments/collectFiles/allMatches)
  - phase: 02-chat-vote-loop
    plan: 03
    provides: console round panel precedent (client-side countdown from endsAtMs), main.ts round wiring
  - phase: 01-compliance-gate-kill-switch
    provides: operator-console server bootstrap/verifyClient/pushState pattern, StreamModeMachine, TaskQueue, el() textContent helper
provides:
  - "startOverlayServer (src/overlay/server.ts): separate read-only localhost HTTP+ws surface — zero mutation routes by construction, full-state-on-connect, 300ms-debounced tally pushes, public pill vocabulary (STANDBY/VOTING OPEN/BUILDING/ON HOLD)"
  - "OverlayState contract { pill, round, nextUp } consumed by the OBS browser source"
  - "src/overlay/public/{index.html,overlay.css,overlay.js}: UI-SPEC broadcast page — vote panel, queue strip, state pill, 8s winner beat, silent freeze-and-retry reconnect"
  - "tests/invariants/dom-safety.test.ts: discovery-based scan of ALL src/**/public/*.js for innerHTML/outerHTML/insertAdjacentHTML/document.write/eval"
  - "AppHandle.overlay + CreateAppOptions.overlayPort (default 0 ephemeral; entrypoint passes OVERLAY_PORT env default 4901)"
affects: [02-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structural dep seams for server surfaces: OverlayModeSource/OverlayRoundSource/OverlayQueueSource are slivers of the real classes, so tests inject plain fakes without SQLite (KeyEventSource pattern applied to a server)"
    - "Push-side debounce: RoundManager emits per-vote; overlay/server.ts collapses VOTE_RECORDED into max one push per 300ms window (one unref'd timer); lifecycle events push immediately"
    - "Lifecycle pushes carry the EVENT's snapshot, not a re-read: RoundManager nulls its round before emitting ROUND_CLOSED, so the push overrides state.round with the event payload"
    - "Broadcast surfaces render zero error text: ws close freezes the last render and retries silently — errors belong on the operator console"

key-files:
  created:
    - src/overlay/server.ts
    - src/overlay/server.test.ts
    - src/overlay/public/index.html
    - src/overlay/public/overlay.css
    - src/overlay/public/overlay.js
    - tests/invariants/dom-safety.test.ts
  modified:
    - src/main.ts
    - tests/e2e/chat-wiring.e2e.test.ts

key-decisions:
  - "createApp defaults overlayPort to 0 (ephemeral) instead of 4901: eleven existing e2e createApp call sites pass no overlayPort, and a fixed default would collide across parallel vitest workers — the entrypoint passes OVERLAY_PORT (default 4901) exactly like CONSOLE_PORT"
  - "ROUND_CLOSED/ROUND_OPENED pushes use the event's own RoundSnapshot payload (pushState roundOverride) so the winner beat has winnerOption + final tally to render from"
  - "Leader badge highlights only a UNIQUE leader — ties show no accent badge (accent stays honest)"
  - "A newly opened round always outranks a lingering winner beat in the vote panel render"

# Metrics
duration: ~20min
completed: 2026-07-10
---

# Phase 2 Plan 05: Public OBS Overlay Summary

**A second, physically read-only localhost surface (default :4901) pushes full `{ pill, round, nextUp }` state to an OBS browser source — live tally bars with 300ms-debounced updates, client-side countdown from endsAtMs, an 8-second winner beat, amber ON HOLD (never red, never "HALTED"), and a discovery-based dom-safety scan keeping HTML-injection sinks out of every public JS file.**

## What Was Built

### Task 1 — Overlay server (TDD: `53c78a9` RED → `0e9bbc5` GREEN)
- `startOverlayServer({ machine, round, taskQueue, port, debounceMs?, logger? })`: express app with ONLY `express.static(public)` + `GET /api/state` — no `express.json()`, no mutation handler of any kind; POST/PUT/DELETE/PATCH to every path 404s (tested across 16 method×path combinations)
- Same bootstrap/teardown shape as the console: `createServer` + `WebSocketServer({ server, verifyClient })` (foreign Origin rejected, no-Origin and same-origin accepted) + `listen(port, "127.0.0.1")` + close() that terminates clients
- Full state on connect; STATE_CHANGED/ROUND_OPENED/ROUND_CLOSED push immediately; VOTE_RECORDED collapses into one push per 300ms window (one unref'd trailing timer — proven with fake timers: 5 rapid votes → exactly 1 push at 300ms, nothing at 299ms, nothing after)
- Pill mapping emits ONLY public wording: IDLE→STANDBY, VOTING_ROUND→VOTING OPEN, BUILD_IN_PROGRESS→BUILDING, HALTED→ON HOLD (FREE_REIGN/CHAOS→STANDBY); the literal "HALTED" appears in server.ts only as the mapping key
- Structural dep interfaces (`OverlayModeSource`/`OverlayRoundSource`/`OverlayQueueSource`) keep the ten server tests SQLite-free

### Task 2 — Overlay client per UI-SPEC + dom-safety scan (`f9d48f6`)
- `overlay.js`: console.js's `el()` textContent helper and reconnect-with-backoff (500ms base, 2x, 8s cap) copied; NO disconnected banner — ws close freezes the last render and retries silently; malformed frames ignored (next push resyncs)
- Vote panel: "VOTE NOW" + m:ss countdown computed client-side every 1s from `endsAtMs` (resynced each push; frozen rounds hold at `remainingMs`); amber digits in the final 10s; hint "type !vote 1, 2 or 3" (adapts to "1 or 2"); rows with number badge (accent bg on the unique leader only), 80-char JS truncation + "…", tally fill = votes/totalVotes (0 votes → empty bars), tabular-nums counts
- Winner beat: a closed-round push with `winnerOption` renders 8s — green left border + "WINNER" on the winning row, losers at 50% opacity, header "Round over" — then the panel collapses client-side
- Queue strip: "NEXT UP" + ≤3 chips at 60-char truncation, hidden entirely when empty; state pill with UI-SPEC dot variants (ON HOLD = amber dot + amber text)
- `overlay.css`: exact palette tokens (rgba(15,23,42,.88)/rgba(30,41,59,.92)/#3B82F6/#F8FAFC/#F59E0B/#22C55E), 20/24/32/48 scale at 600/700, 48px safe margins, 12px tally track with `transition: width 300ms ease-out`, nowrap/ellipsis backstops; #DC2626 absent
- `tests/invariants/dom-safety.test.ts`: discovers every non-test `.js` under `src/**/public/` (no hardcoded names — console.js + overlay.js both found), asserts zero `innerHTML|outerHTML|insertAdjacentHTML|document.write|\beval(` after comment stripping; proven live — appending `node.innerHTML` to overlay.js failed the scan naming `src/overlay/public/overlay.js:251`

### Task 3 — Lifecycle wiring (`bb07552`)
- createApp starts the overlay after the console; `AppHandle.overlay` exposes `{ server, port, close }`; `close()` awaits `overlay.close()` before the console and `db.close()`
- `CreateAppOptions.overlayPort` defaults to 0 (ephemeral) so the eleven untouched e2e createApp call sites never collide across parallel workers; the isMain entrypoint passes `OVERLAY_PORT` (default 4901, already documented in `.env.example`)
- Boot log: "public overlay listening at http://127.0.0.1:{port} — add as OBS browser source at 1920x1080"
- Production smoke-tested: `tsx src/main.ts` boots both surfaces; overlay `/api/state` returns `{"pill":"STANDBY","round":null,"nextUp":[]}`, POST → 404, page → 200, console independent on its own port

## Verification

- `npm test`: **349/349 passing** (335 baseline preserved + 10 overlay server + 4 dom-safety); single-funnel and chat-sender invariants green
- `npm run typecheck` and `npm run lint` clean
- `grep -cE "app\.(post|put|delete|patch)\(" src/overlay/server.ts` → 0; `grep -c "127.0.0.1" src/overlay/server.ts` → 3
- `grep -c "innerHTML" src/overlay/public/overlay.js` → 0; `grep -ci "DC2626" src/overlay/public/overlay.css` → 0
- UI-SPEC copy verbatim in overlay.js: "VOTE NOW" / "NEXT UP" / "WINNER" / "Round over" / STANDBY / VOTING OPEN / BUILDING / ON HOLD each present; truncation constants 80 and 60 present; 1s interval derives from endsAtMs — no per-second message handling exists

## TDD Gate Compliance

Task 1 followed RED→GREEN: `test(02-05)` commit `53c78a9` precedes `feat(02-05)` commit `0e9bbc5`; the RED run was observed failing (module absent) before implementation. Tasks 2/3 are UI/wiring tasks (not `tdd="true"`) and shipped with the dom-safety scan, a new server test, and the full suite green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] ROUND_CLOSED push carried `round: null`, starving the winner beat**
- **Found during:** Task 2 (wiring the client's winner beat)
- **Issue:** `RoundManager.closeRound()` nulls its live round BEFORE emitting ROUND_CLOSED, so the Task 1 server's push (built from `round.snapshot()`) would never contain the closed snapshot with `winnerOption` — the client could not render the 8s winner beat
- **Fix:** `pushState(roundOverride?)` — ROUND_OPENED/ROUND_CLOSED handlers pass the event's own snapshot; new server test proves the ROUND_CLOSED push carries `status: "closed"` + `winnerOption` while `snapshot()` returns null
- **Files modified:** src/overlay/server.ts, src/overlay/server.test.ts
- **Commit:** `f9d48f6`

**2. [Rule 3 - Blocking] Fresh install pulled biome 2.5.3, which reformats two wave-3 files**
- **Found during:** Task 1 verification (`npm run lint` exit 1)
- **Issue:** The worktree's fresh `npm install` resolved `@biomejs/biome@^2` to 2.5.3, whose formatter reflows two call expressions committed by plan 02-04 (src/main.ts, tests/e2e/chat-wiring.e2e.test.ts) — the lint gate blocked every task's verify
- **Fix:** Applied the formatter; whitespace-only, no logic change
- **Files modified:** src/main.ts, tests/e2e/chat-wiring.e2e.test.ts
- **Commit:** `07368bc`

**3. [Rule 3 - Blocking] CRLF worktree checkout artifacts (recurring from waves 1–3)**
- **Found during:** Task 1 verification
- **Issue:** Worktree creation left CRLF endings on 5 pre-existing files (audit/db.ts, compliance/categories.ts + 2 fixtures, state-machine/stream-mode.ts); committed blobs are LF
- **Fix:** Normalized working-tree endings only; `git diff` empty — zero content change, nothing committed
- **Commit:** none (no index change)

### Minor implementation choices (within plan discretion)

- `createApp` defaults `overlayPort` to 0 rather than reading `OVERLAY_PORT` inside the factory: a 4901 default would EADDRINUSE across parallel vitest workers at the eleven existing e2e call sites (plan's "tests pass 0 for ephemeral" honored by default instead of by editing every test); the entrypoint reads the env var, mirroring `CONSOLE_PORT`
- Overlay server deps are narrow structural interfaces satisfied by the real StreamModeMachine/RoundManager/TaskQueue (the codebase's injected-seam convention) — private-field classes can't be faked nominally in tests
- Task 1's commit included a placeholder `public/index.html` so `express.static` had a real file for the static-serving test; Task 2 replaced it with the UI-SPEC page

## Known Stubs

None. The overlay renders live data end-to-end (round events → debounced ws push → DOM), and the production entrypoint was smoke-verified serving both surfaces. The on-stream OBS verification (browser source at 1920x1080, scene-switch reload, halt-to-amber) is plan 02-06's live checkpoint.

## Threat Flags

None — all new surface is registered in the plan's threat model and each `mitigate` disposition is implemented and machine-checked: T-02-19 (textContent-only el(), 80/60 truncation, dom-safety scan over ALL public JS), T-02-20 (separate server/port, zero mutation routes grep-gated, 127.0.0.1 bind, ws Origin check), T-02-21 (fixed public pill vocabulary, no error text on broadcast, overlay JSON carries only round snapshot + queue titles), T-02-22 (300ms push-side debounce + CSS width transition).

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| `53c78a9` | test (RED) | failing overlay server tests |
| `0e9bbc5` | feat (GREEN) | read-only overlay server: full-state-on-connect + 300ms tally debounce |
| `07368bc` | style | biome 2.5.3 format reflow on two wave-3 files |
| `f9d48f6` | feat | UI-SPEC overlay client + dom-safety scan + ROUND_CLOSED snapshot push fix |
| `bb07552` | feat | overlay wired into createApp lifecycle (AppHandle.overlay, OVERLAY_PORT) |

## Self-Check: PASSED

All 8 claimed files exist on disk; all 5 commits verified in git log; full suite 349/349 green at HEAD; working tree clean apart from the wave-recurring CRLF checkout artifacts with zero content diff.
