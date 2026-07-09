# Twitch Does Vibecoding

A livestream system where Twitch chat dictates what software gets built, live on stream —
behind a single Twitch-ToS compliance gate and an always-reachable streamer kill switch.

## Quick start

```bash
npm install
npm run dev
```

Then open the operator console at **http://127.0.0.1:4900** (localhost-only by design —
the console is the kill switch and has no auth; it must never be exposed to the network).

## Commands

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Start the full local stack (console + state machine + audit db) |
| `npm test`          | Run the vitest suite (unit + e2e)                   |
| `npm run typecheck` | `tsc --noEmit` strict type check                    |
| `npm run lint`      | Biome lint + format check                           |

## Environment variables

Copy `.env.example` to `.env` (gitignored). All values have working defaults except
`ANTHROPIC_API_KEY`, which the compliance classifier (plan 01-02) requires.

| Variable               | Default            | Purpose                                          |
| ---------------------- | ------------------ | ------------------------------------------------ |
| `CONSOLE_PORT`         | `4900`             | Operator console port (always bound to 127.0.0.1) |
| `AUDIT_DB_PATH`        | `./data/audit.db`  | SQLite append-only audit ledger                  |
| `ANTHROPIC_API_KEY`    | —                  | Sonnet compliance classifier (metered API)       |
| `GATE_MODEL`           | `claude-sonnet-5`  | Classifier model id                              |
| `GATE_MAX_RETRIES`     | `2`                | Classifier retry budget (fail-closed after)      |
| `PANIC_HOTKEY`         | `F13`              | Global panic hotkey (double-tap within ~2s)      |
| `REVIEW_TTL_HOURS`     | `4`                | Held-for-review expiry                           |
| `AUDIT_RETENTION_DAYS` | `90`               | Rolling audit retention (auto-purge)             |

## What exists right now (Walking Skeleton)

- Six-state stream-mode machine (`IDLE / VOTING_ROUND / BUILD_IN_PROGRESS /
  FREE_REIGN_WINDOW / CHAOS_MODE / HALTED`) — HALTED is reachable synchronously
  from every state.
- Operator console with a live mode pill and a one-click **Halt Everything** button.
- Every halt writes an append-only `audit_log` row (source, prior mode, timestamp),
  readable back via `GET /api/audit`.

The compliance gate, global hotkey, review queue, and audit page land in plans
01-02 through 01-05.
