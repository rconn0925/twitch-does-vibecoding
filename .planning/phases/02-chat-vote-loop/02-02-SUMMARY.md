---
phase: 02-chat-vote-loop
plan: 02
subsystem: ingestion
tags: [twitch, twurple, p-queue, oauth, rate-limit, zod, tdd]
requires: []
provides:
  - "parseCommand(): total zod-validated !suggest/!vote parsing (never throws)"
  - "createChatSender(): sole rate-budgeted sendChatMessage path (D2-08)"
  - "createAuthProvider/buildAuthorizeUrl/completeAuthorization/TWITCH_SCOPES (INFRA-01)"
  - "tests/invariants/scan-helpers.ts: reusable stripComments/collectFiles/allMatches"
affects: [02-04, 02-05, 02-06]
tech-stack:
  added:
    - "@twurple/auth@8.1.4"
    - "@twurple/api@8.1.4"
    - "@twurple/eventsub-ws@8.1.4"
    - "p-queue@9.3.1"
  patterns:
    - "structural sink interface keeps @twurple/api out of chat-sender (deps-injection)"
    - "PQueue({ concurrency: 1, intervalCap, interval, strict: true }) as sliding-window rate budget"
    - "token-file persistence with injectable makeProvider/exchange seams (zero network under vitest)"
key-files:
  created:
    - src/ingestion/command-parser.ts
    - src/ingestion/command-parser.test.ts
    - src/ingestion/chat-sender.ts
    - src/ingestion/chat-sender.test.ts
    - src/ingestion/twitch-auth.ts
    - src/ingestion/twitch-auth.test.ts
    - tests/invariants/scan-helpers.ts
    - tests/invariants/chat-sender.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "Token persistence: JSON file (TWITCH_TOKEN_PATH, gitignored data/) over SQLite table — keeps plan files disjoint from 02-01's schema.sql in wave 1; tokens are one mutable record, not append-only audit data (D2-09 discretion)"
  - "Chat sender defaults 15 msgs/30s — 85% headroom under verified 100/30s broadcaster tier"
  - "completeAuthorization registers via addUserForToken first to resolve userId, then persists token+userId"
metrics:
  duration: "~15 minutes"
  completed: "2026-07-09"
  tasks: 3
  tests-added: 27
  total-tests: 250
---

# Phase 2 Plan 02: Twitch Client Foundations Summary

**One-liner:** twurple 8.1.4 lockstep + p-queue installed; total !suggest/!vote parser, sole rate-budgeted chat sender with machine-checked sole-caller invariant, and restart-safe token-file auth with refresh re-persistence — all network-free under test.

## What Was Built

### Task 1: Twitch stack install + command parser
- Installed `@twurple/auth@8.1.4`, `@twurple/api@8.1.4`, `@twurple/eventsub-ws@8.1.4` (lockstep verified) and `p-queue@9.3.1`. All four pre-audited in 02-RESEARCH.md (slopcheck OK, zero postinstall scripts); `npm audit` reported 0 vulnerabilities.
- `src/ingestion/command-parser.ts`: pure transform, imports only zod. Regex-first extraction + `safeParse` — total over all inputs (fuzzed with NULs, RTL overrides, BOM, lone surrogates, emoji floods). `!vote` accepts only 1-3; malformed variants return null with no feedback (D2-15). Suggestion body capped at 2000 chars mirroring `CandidateSchema`.

### Task 2: Rate-limited chat sender + sole-caller invariant
- `src/ingestion/chat-sender.ts`: `PQueue({ concurrency: 1, intervalCap: 15, interval: 30_000, strict: true })` wrapping every `sink.sendChatMessage` call. 500-char truncation before send. Rejecting sink is logged and swallowed — `send()` never throws into narration callers. `pending` getter (size + in-flight) for observability. Structural `ChatMessageSink` means this module never imports `@twurple/api`.
- `tests/invariants/scan-helpers.ts`: `stripComments`/`collectFiles`/`allMatches` adapted from single-funnel.test.ts's private helpers (that file untouched — plan 02-03 owns it). Reusable by plan 02-05's DOM-safety scan.
- `tests/invariants/chat-sender.test.ts`: scans every non-test `src/**/*.ts` — `sendChatMessage` allowed ONLY in `src/ingestion/chat-sender.ts`; `@twurple/api` imports confined to `src/ingestion/` + `src/main.ts`. Includes a synthetic-tree self-test proving the scan catches offenders.

### Task 3: Persisted auto-refreshing Twitch auth
- `src/ingestion/twitch-auth.ts`: `TWITCH_SCOPES = ["user:read:chat", "user:write:chat"]` (user token acting as itself — no user:bot/channel:bot per RESEARCH.md Pattern 2). `createAuthProvider` reads the zod-validated token file; missing/corrupt → warn + null, never throws (armPanicHotkey degradation pattern). `onRefresh` re-persists rotated tokens; `onRefreshFailure` logs the "bot going deaf" alarm. `buildAuthorizeUrl` is a pure URL builder; `completeAuthorization` uses an injectable `exchange` seam (default: real `exchangeCode`) and `addUserForToken(token, ["chat"])`.
- Token file written with mode 0o600 (advisory on Windows — NTFS ACLs apply, noted in comment). Capturing-logger test proves no accessToken/refreshToken value is ever logged (T-02-07).

## Commits

| Task | Commit | Type | Description |
| ---- | ------ | ---- | ----------- |
| 1 | 445c3c5 | chore | install twurple 8.1.4 lockstep + p-queue 9.3.1 |
| 1 | 3a3b6f8 | test (RED) | failing parser tests |
| 1 | 3bbbaae | fix | escape literal NUL bytes in fuzz fixtures |
| 1 | fbbc18e | feat (GREEN) | total !suggest/!vote command parser |
| 2 | 341c096 | test (RED) | failing chat-sender tests + sole-caller scan + scan-helpers |
| 2 | 9a0808f | feat (GREEN) | p-queue rate-budgeted chat sender (D2-08) |
| 3 | 8193aa3 | test (RED) | failing twitch-auth tests |
| 1 | 84712ee | style | biome formatting on parser union type |
| 3 | 4b5ff77 | feat (GREEN) | persisted auto-refreshing Twitch auth (INFRA-01) |

## Verification

- `npm test`: 250/250 passing (223 pre-existing + 27 new; both invariant scans green, single-funnel.test.ts untouched)
- `npm run typecheck`: clean
- `npm run lint`: clean
- twurple lockstep check: all three `@twurple/*` at ^8.1.4
- `grep -c "strict: true" src/ingestion/chat-sender.ts` = 1; `grep -c safeParse src/ingestion/command-parser.ts` >= 1
- Zero network calls under vitest: sink/exchange/provider all injected seams

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Literal NUL bytes in parser fuzz fixtures made the test file a binary blob**
- **Found during:** Task 1 (RED commit showed `Bin` diff)
- **Issue:** Hostile-input fixtures were written with literal U+0000 characters, so git classified the file as binary
- **Fix:** Replaced with backslash-u0000 escape sequences — semantically identical test input, text file restored
- **Files modified:** src/ingestion/command-parser.test.ts
- **Commit:** 3bbbaae

**2. [Rule 3 - Blocking] Worktree checkout left CRLF line endings on 8 pre-existing files, failing `npm run lint`**
- **Found during:** Task 3 verification (`biome check` format errors on files this plan never touched)
- **Issue:** Working-tree copies of 8 Phase 1 files had CRLF endings from worktree creation; committed blobs are LF (`.gitattributes` eol=lf), so this was a checkout artifact, not a content problem
- **Fix:** Normalized working-tree endings to LF and refreshed the index — `git diff` confirmed zero content change; nothing was committed for those files
- **Files modified (working tree only, no commit):** src/audit/db.ts, src/audit/record.test.ts, src/compliance/categories.ts, src/compliance/fixtures/*.fixtures.ts, src/shared/events.ts, src/shared/types.ts, src/state-machine/stream-mode.ts
- **Commit:** none (no content change)

**3. [Rule 1 - Bug] Biome format violations in this plan's own files**
- **Found during:** Task 3 verification
- **Fix:** `biome check --write` on this plan's files (union-type formatting, import ordering)
- **Commits:** 84712ee (parser), folded into 4b5ff77 (twitch-auth.test.ts import order)

## Known Stubs

None — all three modules are fully wired at the unit level. Live wiring to a real EventSub listener and ApiClient is explicitly plan 02-04's scope (composition root), and live end-to-end proof is plan 02-06's checkpoint.

## Threat Flags

None — all new surface (chat-text parse boundary, outbound rate limit, token-at-rest, npm supply chain) was already registered in this plan's threat model (T-02-05/06/07/08/SC) and each `mitigate` disposition is implemented and test-proven.

## User Setup Required (carried forward)

Before plan 02-06's live checkpoint the streamer must register a Twitch app (dev.twitch.tv/console, OAuth redirect `http://localhost:4900/auth/callback`, category Chat Bot) and set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_USER_ID`. No code in this plan blocks on it (all tests injected).
