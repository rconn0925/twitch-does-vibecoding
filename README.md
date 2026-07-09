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

## Operator console tour

`npm run dev`, then open **http://127.0.0.1:4900**. The console is the streamer's
incident-response surface: a persistent status bar (live mode pill + one-click
**Halt Everything**, no confirmation modal) over three tabbed views, plus a
takeover view that appears only while halted.

### Needs Review

Escalated suggestions (`held-for-review` — gray-zone categories only: gambling,
IP, misinformation) wait here between rounds. No sound, no toast, no
interruption. Each card shows the suggestion text, username, category pill, and
the classifier's rationale, with per-item **Approve** / **Reject**:

- **Approve** re-enters the original candidate into the pre-screened pool.
- **Reject** resolves it — single click, no modal.

Both write a new `review_resolved` audit row; the original gate decision row is
never touched. Anything still pending at process startup (or past the
`REVIEW_TTL_HOURS` TTL) expires as `expired-unreviewed`, audited.

### Active Queue

Queued build tasks, each with a **Veto Task** button (single click, no modal;
the veto row records the task's triggering suggestion text). Below them, the
pre-screened candidate pool is listed read-only with green `approved` pills.

This view also hosts the **Dev: simulate suggestion** form — the demo driver
for the whole slice before Twitch chat ingestion exists: type text, submit, and
watch it flow through the Sonnet gate into the pool (approved), Needs Review
(held), or the audit log only (rejected). While halted, the same form surfaces
the intake refusal inline.

### Audit Log

Every gate decision, veto, halt, review resolution, and refused submission —
each with the triggering input — filterable by event type and decision, with a
row-limit selector. Records older than `AUDIT_RETENTION_DAYS` (default 90) are
purged automatically at startup and daily.

### HALTED triage takeover

When a halt fires (console button or panic hotkey double-tap), the normal view
is replaced by the triage panel: the frozen in-flight task, queued tasks, and
prior mode, plus exactly three equally-weighted recovery buttons — **Resume** /
**Discard Task & Resume** / **Reset to Idle**. Nothing auto-resumes and nothing
is pre-selected. Intake is refused (and audited) for as long as the halt lasts.

### Reason tags

After any destructive action (halt, veto, reject, discard) an optional one-tap
reason row appears — `ToS risk / boring / too big / gut feeling / other / skip`.
Tagging is never required and never blocks: the action has already taken effect.
