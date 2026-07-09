# Walking Skeleton — Twitch Does Vibecoding

**Phase:** 1
**Generated:** 2026-07-08

## Capability Proven End-to-End

The streamer opens the localhost operator console, sees the live stream-mode state, and halts everything with one click (or a global double-tap hotkey) — with the halt recorded in a SQLite audit ledger and readable back from the same UI.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime / language | Node.js 24 (Active LTS) + TypeScript 6.0.x, ESM, strict, NodeNext | Locked in STACK.md/CLAUDE.md: single event-loop process fits an I/O-bound system (EventSub, overlay ws, agent streams all multiplex on one runtime); TS 7 RC is off-limits for live-reliability work |
| Process model | One main Node process (`src/main.ts`) hosting state machine, gate, audit, console; future agent sessions as supervised child processes | ARCHITECTURE.md: fewer independently-failing parts on a live broadcast machine; only genuinely separate lifecycles get process boundaries |
| HTTP/WS tier | Express 5.2.x + `ws` ^8.21 — operator console bound strictly to 127.0.0.1:4900 (CONSOLE_PORT) | Localhost-only bind IS the console's access control (no auth layer in v1); plain `ws` full-snapshot-on-connect-then-updates pattern, no Socket.IO |
| Data layer | `better-sqlite3` ^12.11, WAL mode, file at ./data/audit.db (AUDIT_DB_PATH); `:memory:` in tests | Synchronous embedded DB fits single-process app; two-table split: `audit_log` (append-only compliance ledger, only DELETE is the 90-day purge) + `review_queue` (mutable workflow state) |
| Validation | `zod` v4 at every untrusted boundary: console request bodies/queries, candidate shapes, classifier responses (`z.toJSONSchema` for Structured Outputs — never `zodOutputFormat`, zod-v4 incompatible) | Locked project convention; LLM output is untrusted even when schema-guaranteed |
| Classifier | Raw `@anthropic-ai/sdk` Messages API (Sonnet, Structured Outputs, fail-closed after 2 retries) — NOT the Agent SDK | Single-turn classification needs no agentic session; Agent SDK reserved for Phase 3 build/research agents. Model policy: Sonnet = runtime classification (D-09), Fable = everything else |
| Single-funnel invariant | Branded `QueuedTask` (unique symbol) constructible only in `src/compliance/gate.ts` + permanent source-scan invariant test | COMP-01: no code path can enqueue except through the gate; Phases 2/4 inherit the check via `npm test` |
| State authority | Hand-rolled 6-state `StreamModeMachine` (IDLE/VOTING_ROUND/BUILD_IN_PROGRESS/FREE_REIGN_WINDOW/CHAOS_MODE/HALTED); HALTED synchronous from any state, decoupled from abort success | ARCHITECTURE.md Pattern 2; single source of truth for "what can chat do right now" — no component ever re-derives mode |
| Kill mechanics | `uiohook-napi` global hotkey (double-tap ≤2s, default F13) + `tree-kill` SIGKILL for process trees | Windows has no POSIX signal trees; UIPI ops rule documented in docs/OPERATIONS.md |
| Logging | `pino` ^10 for operations; SQLite `audit_log` for compliance record of truth | The two are never conflated (COMP-05) |
| Lint/format/test | Biome + vitest + tsx (dev runner), `tsc --noEmit` for typecheck | Locked in STACK.md |
| Auth | None — localhost-bind implicit trust for the single-operator v1 | RESEARCH.md Security Domain V2; revisit only if the console ever leaves the machine |
| Deployment target | The streamer's Windows 11 PC; `npm run dev` is the documented full-stack run command | This is a local desktop-broadcast system; no cloud tier exists |
| Directory layout | `src/{shared,compliance,state-machine,kill-switch,queue,pipeline,audit,operator-console}` + `tests/{e2e,fixtures,invariants}` + `scripts/` | RESEARCH.md Recommended Project Structure; Phase 2 adds `src/ingestion/`, Phase 3 adds `src/orchestrator/` + `src/overlay/` |

## Stack Touched in Phase 1

- [x] Project scaffold (npm, TypeScript 6 strict, Biome, vitest, tsx)
- [x] Routing — Express console routes (/api/state, /api/halt, /api/audit, /api/review/*, /api/tasks/*, /api/recover, /api/dev/submit)
- [x] Database — audit_log writes on every decision/halt/veto AND reads via the audit endpoints/page
- [x] UI — Halt Everything button, review approve/reject, veto, triage recovery (ws live state push)
- [x] Deployment — documented local full-stack run: `npm run dev` → http://127.0.0.1:4900

## Out of Scope (Deferred to Later Slices)

- Twitch ingestion, EventSub, chat feedback delivery (COMP-03) — Phase 2
- Second-pass build-plan/output screening (COMP-02), agents, sandbox, overlay, live preview — Phase 3
- Paid mechanics, donation platforms, channel points, chaos mode — Phase 4
- Project-switch *mechanics* (chat consensus vote → Phase 2; donation-purchased → Phase 4). Phase 1 only defines the `project-switch` candidate kind + event name (D-15)
- Durable (SQLite-backed) task queue persistence — in-memory queue suffices until Phase 2's crash-recovery requirements
- Auth on the console, audit-log hash chaining (flagged v2 hardening), suggestion clustering

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- Phase 2: viewer suggests/votes via Twitch chat → `submitCandidate()` → gate → pool → winner queued; rejection feedback in chat (COMP-03)
- Phase 3: queued task → Sonnet research / Fable build inside WSL2-or-Docker sandbox, second gate pass on the plan (COMP-02); overlay + live preview; veto aborts agent sessions via the AbortRegistry
- Phase 4: donation free-reign + channel-points windows and chaos mode — all through the identical `submitCandidate()` funnel and the same veto
- Phase 5: persistent changelog + full dry run on a test channel
