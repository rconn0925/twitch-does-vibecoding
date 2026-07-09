# Phase 2: Chat Vote Loop - Pattern Map

**Mapped:** 2026-07-09
**Files analyzed:** 17 (new) + 7 (modified)
**Analogs found:** 24 / 24 (every file has at least a role-match analog; none are unprecedented)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/ingestion/command-parser.ts` | utility (transform) | transform | `src/compliance/prefilter.ts` | exact (pure fn, zod, regex-first) |
| `src/ingestion/twitch-chat.ts` | service (event listener) | event-driven | `src/kill-switch/hotkey.ts` + `src/main.ts`'s `armPanicHotkey` | role-match (injected native/3rd-party event source) |
| `src/ingestion/twitch-auth.ts` | service (auth/persistence) | request-response + durable state | `src/audit/db.ts` (bootstrap-and-persist) + `src/operator-console/server.ts` OAuth-adjacent route style | role-match (no direct OAuth precedent in repo) |
| `src/ingestion/chat-sender.ts` | service (rate-limited queue) | streaming / batch | `src/queue/task-queue.ts` (queue class) + `src/kill-switch/abort.ts` (registry-style single gatekeeper) | role-match (no rate-limiter precedent) |
| `src/state-machine/round.ts` | state-machine / model | CRUD + event-driven (timers) | `src/state-machine/stream-mode.ts` + `src/state-machine/review-queue.ts` | strong role-match (hand-rolled machine + SQLite CRUD/TTL) |
| `src/pipeline/round.ts` | pipeline (funnel entry) | CRUD (single write, single funnel) | `src/pipeline/submit.ts` | exact (same folder, same funnel contract) |
| `src/overlay/server.ts` | server (ws push, read-only) | streaming (full-state-on-connect + diffs) | `src/operator-console/server.ts` | exact (mirrors ws + `pushState()` pattern minus mutation routes) |
| `src/overlay/public/index.html`, `overlay.css`, `overlay.js` | component (frontend) | streaming (ws client) | `src/operator-console/public/{index.html,console.css,console.js}` | exact |
| `src/audit/schema.sql` (extend) | migration | CRUD | itself (existing `review_queue` table as the model for `rounds`/`round_votes`) | exact |
| `src/audit/record.ts` (extend: `recordRoundEvent`) | service (ledger) | event-driven audit writes | itself (`recordHalt`/`recordVeto`/`recordReviewResolution`) | exact |
| `src/operator-console/server.ts` (extend: `POST /api/round/start`, `GET /auth/start`, `GET /auth/callback`) | controller (route) | request-response | itself (`POST /api/halt`, `POST /api/recover`) | exact |
| `src/operator-console/public/console.js` (extend: Start Round button + round panel) | component (frontend) | request-response + ws-push render | itself (`renderQueue`/triage button wiring) | exact |
| `src/main.ts` (extend: wire ingestion + overlay + round manager) | config / composition root | event-driven wiring | itself (`createApp`, `armPanicHotkey`) | exact |
| `src/shared/types.ts` (extend: `Round`, `RoundVote`, `RoundStatus`) | model (types) | — | itself | exact |
| `src/shared/events.ts` (extend: `ROUND_OPENED`/`ROUND_CLOSED`/`VOTE_RECORDED`) | config (event vocabulary) | — | itself | exact |
| `tests/invariants/single-funnel.test.ts` (extend allowlist) | test | — | itself | exact |
| `.env.example` (extend: `TWITCH_CLIENT_ID`, `ROUND_DURATION_MS`, sender-queue budget, `INTAKE_COOLDOWN_MS`, `POOL_MAX_SIZE`) | config | — | itself | exact |
| `src/ingestion/*.test.ts` (unit tests) | test | — | `src/queue/task-queue.test.ts`, `src/compliance/prefilter.test.ts` | exact |
| `src/state-machine/round.test.ts` | test | — | `src/state-machine/review-queue.test.ts` (implied by module — not opened this session, but same author/pattern as `stream-mode.test.ts`) | role-match |
| `tests/e2e/round-flow.e2e.test.ts` | test (e2e) | — | `tests/e2e/console-flows.e2e.test.ts` | exact |

## Pattern Assignments

### `src/ingestion/command-parser.ts` (utility, transform)

**Analog:** `src/compliance/prefilter.ts`

**Imports pattern** (prefilter.ts lines 13-16):
```typescript
import { z } from "zod";
import type { GateCategory } from "./categories.js";
import { TAXONOMY_CATEGORIES } from "./categories.js";
```

**Core transform pattern** — pure function, regex-first, zod-validated output shape (prefilter.ts lines 147-167, structurally what command-parser.ts should copy: try patterns in order, return a discriminated result, never throw on "no match"):
```typescript
export function prefilterCheck(text: string): PrefilterResult {
  const norm = normalize(text);
  for (const { pattern, category, rationale } of NORMALIZED_PATTERNS) {
    if (pattern.test(norm)) {
      return { rejected: true, category, rationale };
    }
  }
  const compact = norm.replace(/[^a-z0-9]/g, "");
  for (const { pattern, category, rationale } of COMPACT_PATTERNS) {
    if (pattern.test(compact)) {
      return { rejected: true, category, rationale };
    }
  }
  return { rejected: false };
}
```

RESEARCH.md's own `command-parser.ts` code example (already zod-shaped, use verbatim as the starting point — Standard Stack §Code Examples):
```typescript
const SuggestCommand = z.object({ kind: z.literal("suggest"), text: z.string().min(1).max(2000) });
const VoteCommand = z.object({ kind: z.literal("vote"), option: z.number().int().min(1).max(3) });

export function parseCommand(messageText: string):
  | { kind: "suggest"; text: string }
  | { kind: "vote"; option: number }
  | null {
  const suggestMatch = /^!suggest\s+(.+)$/i.exec(messageText.trim());
  if (suggestMatch?.[1]) return SuggestCommand.parse({ kind: "suggest", text: suggestMatch[1] });
  const voteMatch = /^!vote\s+([1-3])$/i.exec(messageText.trim());
  if (voteMatch?.[1]) return VoteCommand.parse({ kind: "vote", option: Number(voteMatch[1]) });
  return null; // not a recognized command — ignored (D2-15)
}
```

**Normalization reuse (D2-12 dedup):** call `normalize()` exported from `src/compliance/prefilter.ts` (lines 32-40) directly — do not duplicate it. It already handles NFKC, zero-width strip, hyphen folding, whitespace collapse, lowercasing — exactly what duplicate-suggestion comparison needs.

---

### `src/ingestion/twitch-chat.ts` (service, event-driven)

**Analog:** `src/kill-switch/hotkey.ts` (native/3rd-party event-source injection) + `src/main.ts`'s `armPanicHotkey` (guarded-import composition wrapper)

**Injected-dependency pattern to copy** (hotkey.ts lines 53-59, 61-77): define a minimal interface for the subset of the 3rd-party client this module needs, inject it — never import the real library at module scope in code vitest loads.
```typescript
/** The subset of uIOhook this module needs — uiohook-napi's uIOhook satisfies it. */
export interface KeyEventSource {
  on(event: "keydown", handler: (e: { keycode: number }) => void): unknown;
  off(event: "keydown", handler: (e: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

export interface StartHotkeyOptions {
  key?: string | undefined;
  onPanic: () => void;
  logger: PanicLogger;
  hook: KeyEventSource; // Injected so tests never touch native code.
  keyMap: Record<string, number>;
}
```
Apply the same shape to twurple: define a `ChatEventSource` interface covering only `onChannelChatMessage`, `onUserSocketReady`, `onUserSocketDisconnect`; inject the real `EventSubWsListener` only from `main.ts`'s guarded entrypoint branch.

**Guarded native import + graceful degradation** (main.ts lines 178-211, `armPanicHotkey`): the exact pattern for "library init can fail on this machine; log loudly, degrade, never crash the process":
```typescript
export async function armPanicHotkey(args: ArmPanicHotkeyArgs): Promise<HotkeyHandle | null> {
  const load = args.loadUiohook ?? (async () => (await import("uiohook-napi")) as unknown as UiohookModule);
  try {
    const { uIOhook, UiohookKey } = await load();
    const handle = startHotkeyListener({ /* ... */ hook: uIOhook, keyMap: UiohookKey });
    args.logger.info({ key: handle.key }, "panic hotkey armed...");
    return handle;
  } catch (err) {
    args.logger.error({ err }, "PANIC HOTKEY UNAVAILABLE — console Halt button is the only kill path");
    return null;
  }
}
```
Mirror this for `startTwitchChat()`: inject `loadTwurple?: () => Promise<TwurpleModule>` for tests, catch init failure, log loudly, return a handle-or-null rather than crashing `main.ts` — Twitch connectivity loss must degrade like hotkey loss does (console/overlay keep running).

**Event-hook logging pattern** (RESEARCH.md Pattern 1, to copy verbatim into `twitch-chat.ts`):
```typescript
listener.onUserSocketDisconnect((userId, error) => {
  logger.warn({ userId, err: error }, "EventSub socket disconnected — twurple will auto-reconnect");
});
listener.onUserSocketReady((userId, sessionId) => {
  logger.info({ userId, sessionId }, "EventSub socket (re)connected and ready");
  reconcileRoundState(); // D2-14
});
```

---

### `src/ingestion/twitch-auth.ts` (service, auth + persistence)

**Analog:** `src/audit/db.ts` (bootstrap pattern: open/create, run schema, return handle) — no direct OAuth precedent exists in-repo, so this is composed from stack-doc-verified twurple API + the project's existing "open and persist" idiom.

**Bootstrap-and-persist shape to copy** (db.ts lines 16-24 — the idiom: a single factory function that does setup-or-create and returns a ready-to-use handle):
```typescript
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  db.exec(schema);
  return db;
}
```
Apply the same idiom to `twitch-auth.ts`: a `createAuthProvider(db, clientId, clientSecret)` factory that (1) reads any persisted token row, (2) constructs `RefreshingAuthProvider`, (3) wires `onRefresh`/`onRefreshFailure` to persist/log, (4) returns the ready provider — exactly like `openDb` returns a ready connection.

**Verified library shapes (RESEARCH.md Pattern 3 — copy directly, this is the authoritative source since no in-repo OAuth precedent exists):**
```typescript
async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<AccessToken>
interface AccessToken {
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  expiresIn: number | null;
  obtainmentTimestamp: number;
}
const authProvider = new RefreshingAuthProvider({ clientId, clientSecret });
authProvider.onRefresh(async (userId, newTokenData) => { /* persist to SQLite */ });
authProvider.onRefreshFailure(async (userId, error) => { /* log loudly */ });
```

**Schema table to add (mirrors `review_queue`'s single-purpose table shape in `src/audit/schema.sql` lines 28-42):** a `twitch_tokens` table, one row, columns matching `AccessToken`'s fields plus `user_id`.

---

### `src/ingestion/chat-sender.ts` (service, rate-limited queue)

**Analog:** `src/queue/task-queue.ts` (class wrapping a private array with a narrow public API) — structural model only; the rate-limiting behavior itself has no in-repo precedent and comes from `p-queue` per RESEARCH.md Pattern 4.

**Structural pattern to copy** (task-queue.ts lines 18-37 — narrow class, single responsibility, no leaking internals):
```typescript
export class TaskQueue {
  #tasks: QueuedTask[] = [];
  enqueue(task: QueuedTask): void { this.#tasks.push(task); }
  list(): QueuedTask[] { return [...this.#tasks]; }
  remove(id: string): QueuedTask | undefined { /* ... */ }
}
```

**Sole-writer enforcement idiom** — copy the comment-driven "only sanctioned callers" discipline from task-queue.ts's own doc comment (lines 1-14) and from `tests/invariants/single-funnel.test.ts` check (b) (`.enqueue(` scanned to `src/pipeline/` only): add an equivalent scan rule for `chat-sender.ts` — `apiClient.chat.sendChatMessage(` or `HelixChatApi` should appear ONLY inside `src/ingestion/chat-sender.ts`, everywhere else must call `enqueueChatMessage()`.

**Rate-limit queue implementation (RESEARCH.md Pattern 4 — copy directly, verified against `p-queue` docs):**
```typescript
import PQueue from "p-queue";
const sendQueue = new PQueue({ concurrency: 1, intervalCap: 15, interval: 30_000, strict: true });
export function enqueueChatMessage(broadcasterId: string, text: string): Promise<void> {
  return sendQueue.add(() => apiClient.chat.sendChatMessage(broadcasterId, text)).then(() => undefined);
}
```

---

### `src/state-machine/round.ts` (state-machine/model, CRUD + event-driven)

**Analog A:** `src/state-machine/stream-mode.ts` (hand-rolled machine, EventEmitter, table-driven legal transitions)

**Emitter + snapshot pattern to copy** (stream-mode.ts lines 45-75, 108-111):
```typescript
export class StreamModeMachine {
  #mode: StreamMode = "IDLE";
  readonly #emitter = new EventEmitter();
  get mode(): StreamMode { return this.#mode; }
  snapshot(): StateSnapshot { return { mode: this.#mode, /* ... */ }; }
  transition(to: StreamMode): void {
    const allowed = TRANSITIONS[this.#mode];
    if (!allowed.includes(to)) throw new InvalidTransitionError(this.#mode, to);
    this.#mode = to;
    this.#emitter.emit(STATE_CHANGED, this.snapshot());
  }
  on(event: string, handler: (...args: unknown[]) => void): void { this.#emitter.on(event, handler); }
}
```
`round.ts` should follow the identical shape: private mutable state + `snapshot()` + emit on every transition (open/close/winner) via `src/shared/events.ts` constants (never string literals, per stream-mode.ts's own doc comment discipline).

**Analog B:** `src/state-machine/review-queue.ts` (SQLite-backed CRUD + TTL-driven sweep — the closest precedent for "durable, timer-swept, per-row state")

**Upsert pattern (revote overrides, D2-15) — RESEARCH.md's own code example, directly copyable:**
```typescript
const upsertVote = db.prepare(`
  INSERT INTO round_votes (round_id, twitch_user_id, option_index, voted_at_ms)
  VALUES (@roundId, @twitchUserId, @optionIndex, @votedAtMs)
  ON CONFLICT(round_id, twitch_user_id) DO UPDATE SET
    option_index = excluded.option_index,
    voted_at_ms = excluded.voted_at_ms
`);
-- requires: CREATE UNIQUE INDEX ... ON round_votes(round_id, twitch_user_id)
```

**TTL/env-config pattern to copy** (review-queue.ts lines 66-74 — the exact idiom for "duration configurable via env, default constant, visible in `.env.example`" that D2-02's round duration needs):
```typescript
const DEFAULT_REVIEW_TTL_HOURS = 4;
export function reviewTtlMs(): number {
  const raw = process.env.REVIEW_TTL_HOURS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_TTL_HOURS;
  return hours * 3_600_000;
}
```
Apply identically for `ROUND_DURATION_MS` (or `ROUND_DURATION_SECONDS`), `INTAKE_COOLDOWN_MS`, `POOL_MAX_SIZE` (D2-11/D2-13, per RESEARCH.md Open Question 3's recommendation).

**Reconstruct-full-identity-from-row pattern** (review-queue.ts `approve()`, lines 119-141) — copy this exact discipline for turning a persisted round row back into an in-memory `Round`/`SuggestionCandidate` on crash-recovery reconciliation (D2-14): persist FULL candidate identity in the `rounds` table's candidate columns (mirrors review_queue's "no joins, no lossy defaults" comment), never a foreign-key-only reference.

**Sweep-timer wiring in main.ts** (main.ts lines 82-90 — copy this exact `setInterval(...).unref()` idiom) if round timers are implemented as a periodic tick rather than per-round `setTimeout`; either way, `.unref()` so the timer never keeps the process alive on shutdown.

---

### `src/pipeline/round.ts` (pipeline, single-funnel entry point)

**Analog:** `src/pipeline/submit.ts` — same folder, same funnel-entry contract, this is the closest possible match.

**Deps-injection + narrow-function shape to copy** (submit.ts lines 42-58, 85-98):
```typescript
export interface SubmitDeps {
  db: Database.Database;
  mode: () => StreamMode;
  pool: CandidatePool;
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
  logger?: Logger;
}
export function submitCandidate(deps: SubmitDeps, candidate: SuggestionCandidate): SubmitResult {
  const parsed: SuggestionCandidate = CandidateSchema.parse(candidate);
  if (deps.mode() === "HALTED") {
    recordSubmissionRefused(deps.db, { candidate: parsed, streamMode: "HALTED" });
    return { accepted: false, reason: "halted" };
  }
  /* ... */
}
```
`round.ts`'s `pipeline/round.ts` counterpart (`enqueueWinner(candidate, approvedResult): QueuedTask`) should follow the identical deps-injection shape but call `toQueuedTask()` + `taskQueue.enqueue()` directly — see gate.ts below for those two calls' exact signatures.

**The two calls this file is the ONLY sanctioned caller of (outside gate.ts itself)** (gate.ts lines 130-138, task-queue.ts lines 22-23):
```typescript
export function toQueuedTask(candidate: SuggestionCandidate, result: GateResult): QueuedTask {
  if (result.decision !== "approved") {
    throw new Error(`toQueuedTask requires an approved gate result, got "${result.decision}" — COMP-01 single funnel`);
  }
  return { ...candidate } as QueuedTask;
}
// TaskQueue:
enqueue(task: QueuedTask): void { this.#tasks.push(task); }
```

**CRITICAL — invariant test update required in the SAME commit** (per RESEARCH.md Pitfall 1, `tests/invariants/single-funnel.test.ts` lines 158-167, 180-190): add `"src/pipeline/round.ts"` to BOTH allowlist literals:
```typescript
// (b) .enqueue( is called only from src/pipeline/  — round.ts already satisfies this by being under src/pipeline/, no change needed to check (b) itself.
// (d) toQueuedTask referenced outside gate.ts only by ...
const allowed = new Set(["src/compliance/gate.ts", "src/pipeline/submit.ts"]);
// MUST become:
const allowed = new Set(["src/compliance/gate.ts", "src/pipeline/submit.ts", "src/pipeline/round.ts"]);
```

---

### `src/overlay/server.ts` (server, read-only ws push)

**Analog:** `src/operator-console/server.ts`

**Server bootstrap + localhost-only bind pattern to copy** (server.ts lines 102-104, 440-458):
```typescript
export function startConsoleServer(deps: ConsoleServerDeps): Promise<ConsoleServerHandle> {
  const app = express();
  /* ... */
  const server = createServer(app);
  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      resolve({ server, port: boundPort, close: () => new Promise<void>((closeResolve, closeReject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close((err) => (err ? closeReject(err) : closeResolve()));
      }) });
    });
  });
}
```

**Full-state-on-connect + push-on-change pattern to copy verbatim** (server.ts lines 163-195):
```typescript
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => info.origin === undefined || info.origin === `http://${info.req.headers.host}`,
});
function pushState(): void {
  const payload = JSON.stringify(buildState());
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
wss.on("connection", (socket) => { socket.send(JSON.stringify(buildState())); });
machine.on(STATE_CHANGED, () => { pushState(); });
```
For overlay: replace `machine.on(STATE_CHANGED, pushState)` with the round manager's own emitted events, PLUS the Pitfall-3 debounce (RESEARCH.md): coalesce vote-tally pushState calls on a 250-500ms interval instead of per-vote — this is the ONE deliberate deviation from the console's synchronous per-mutation push, and it belongs in `overlay/server.ts`, not in `round.ts` (round.ts should just emit; overlay/server.ts decides push cadence).

**Origin-check ws security pattern** (server.ts lines 166-179, verified working via e2e test `tests/e2e/console-flows.e2e.test.ts` lines 336-383) — copy identically; the overlay ws is a public-readable surface, so origin-checking a foreign browser page is equally important there.

**No mutation routes at all** — the overlay's Express app should have ZERO `app.post`/`app.put`/`app.delete` routes (D2-17). Only `app.get("/api/state")` (read-only mirror of console.ts line 211-213) and `app.use(express.static(...))`.

---

### `src/overlay/public/{index.html,overlay.css,overlay.js}` (component, frontend)

**Analog:** `src/operator-console/public/{index.html,console.css,console.js}`

**textContent-only DOM discipline to copy verbatim** (console.js lines 1-8, 41-46 — the XSS rule the phase's own CONTEXT.md flags as "arguably more important since it's broadcast"):
```javascript
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
```
Never use `innerHTML` anywhere in `overlay.js` — chat-derived suggestion text renders live on stream.

**Hand-rolled ws reconnect-with-backoff pattern to copy verbatim** (console.js lines 437-465):
```javascript
let attempts = 0;
function connect() {
  const socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener("open", () => { attempts = 0; disconnected.hidden = true; });
  socket.addEventListener("message", (event) => {
    try { latest = JSON.parse(event.data); renderAll(); } catch { /* resync on next push */ }
  });
  socket.addEventListener("close", () => {
    disconnected.hidden = false;
    const delay = Math.min(500 * 2 ** attempts, 8000);
    attempts += 1;
    setTimeout(connect, delay);
  });
  socket.addEventListener("error", () => { socket.close(); });
}
connect();
```
This is exactly the CLAUDE.md-mandated "~30-line hand-rolled reconnect wrapper" — copy without modification (it already handles the OBS-scene-switch-reload case: a fresh `connect()` gets full state again on `open`).

---

### `src/audit/record.ts` (extend: `recordRoundEvent`)

**Analog:** itself — `recordHalt`/`recordVeto`/`recordReviewResolution` (lines 58-100, 154-178)

**Insert-helper pattern to copy exactly:**
```typescript
export function recordVeto(
  db: Database.Database,
  args: { taskId: string | null; suggestionText: string | null; twitchUsername: string | null; reasonTag: ReasonTag | null; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "veto",
    source: "operator",
    twitchUsername: args.twitchUsername,
    suggestionText: args.suggestionText,
    decision: null,
    category: args.reasonTag,
    rationale: null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}
```
Add `recordRoundOpened`, `recordRoundClosed`, `recordPoolDropped` following this identical shape — every new event type reuses the SAME `audit_log` table/`insert()` helper (no new table for round lifecycle events; only `rounds`/`round_votes` get new tables, per D2-14's persistence need — lifecycle NARRATION events are audit rows, vote LEDGER data is its own table).

---

### `src/operator-console/server.ts` (extend: `POST /api/round/start`, `GET /auth/start`, `GET /auth/callback`)

**Analog:** itself — `POST /api/halt` (lines 215-246) is the closest existing mutation route (validates body with zod, checks a precondition, calls into a domain module, returns JSON).

**Route pattern to copy exactly:**
```typescript
app.post("/api/halt", (req, res) => {
  const parsed = HaltBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid halt request body" });
    return;
  }
  /* precondition check, domain call, res.json(...) */
});
```
`POST /api/round/start` should follow this shape: zod-validate an (empty or optional) body, check `machine.mode === "IDLE"` and pool size >= 2 (D2-04), call into `round.ts`'s `startRound()`, `pushState()`, return JSON — errors surface as `400`/`409` exactly like the halt/recover routes do, never a stack trace (T-01-03 discipline already established at server.ts lines 429-437).

**CSRF middleware already covers new routes automatically** (server.ts lines 128-144) — the Origin/Content-Type check runs on ALL non-GET routes registered on this app; `/api/round/start` needs no additional CSRF work, just correct placement (registered on the SAME `app` instance, after the existing `app.use(...)` CSRF middleware, before the error-boundary middleware).

**OAuth callback route** — no in-repo GET-with-query-param precedent exists (all existing GETs are static/state reads); base `GET /auth/callback` on Express's standard `req.query` pattern plus the RESEARCH.md Pattern 3 `exchangeCode()` call, and place it in the SAME route registration block, still behind the localhost-only bind (server.ts line 442, `server.listen(deps.port, "127.0.0.1", ...)`).

---

### `src/main.ts` (extend: wire ingestion + overlay + round manager into lifecycle)

**Analog:** itself — `createApp()`'s composition-root pattern (lines 61-151) and `armPanicHotkey()`'s guarded-optional-subsystem pattern (lines 178-211)

**Composition + graceful-teardown pattern to copy:**
```typescript
export async function createApp(opts: CreateAppOptions): Promise<AppHandle> {
  /* construct db, machine, registry, pool, taskQueue */
  const console_ = await startConsoleServer({ /* ... */ });
  return {
    /* ...handles... */
    close: async () => {
      clearInterval(reviewSweepTimer);
      clearInterval(purgeTimer);
      await console_.close();
      db.close();
    },
  };
}
```
Extend `AppHandle`/`createApp` to also construct+return the overlay server handle, the round manager, and (in the `isMain` entrypoint branch only, mirroring `armPanicHotkey`'s guarded-import placement at lines 218-240) the twurple chat listener — so vitest-run tests never load native/network code, exactly as today only `main.ts`'s `isMain` branch loads `uiohook-napi`.

---

## Shared Patterns

### Deps-injection for testability
**Source:** `src/pipeline/submit.ts` (`SubmitDeps`), `src/compliance/gate.ts` (`GateDeps`, `FakeClassifier`), `src/kill-switch/hotkey.ts` (`KeyEventSource`)
**Apply to:** `twitch-chat.ts`, `twitch-auth.ts`, `chat-sender.ts`, `round.ts` — every new module that talks to twurple, SQLite, or a timer must accept its dependencies as an injected `Deps` interface/object, never import a live singleton at module scope. This is the single most load-bearing convention in the codebase (every existing module follows it) and is what keeps `npm test` free of network/native calls.

### zod validation at every untrusted boundary
**Source:** `src/pipeline/submit.ts` (`CandidateSchema`), `src/operator-console/server.ts` (`HaltBodySchema`, `RecoverBodySchema`, etc.)
**Apply to:** `command-parser.ts` (EventSub chat message payload — the phase's first untrusted network input per RESEARCH.md Security Domain), the new `POST /api/round/start` body.

### Fail-closed / never-throw-into-caller
**Source:** `src/compliance/gate.ts`'s `classify()` (never throws; resolves to `FAIL_CLOSED` on any classifier error), `src/pipeline/submit.ts`'s background-promise `.catch()` (line 75-80)
**Apply to:** `twitch-chat.ts`'s message handler (a malformed EventSub payload must never crash the listener), `chat-sender.ts` (a failed send must log, not throw into the round-narration caller).

### Append-only audit ledger, one row per event, INSERT-only helper functions
**Source:** `src/audit/record.ts`, `src/audit/schema.sql`
**Apply to:** every round-lifecycle narration event (`round_opened`, `round_closed`, `pool_dropped`) — extend the SAME `audit_log` table via the SAME `insert()` private helper; do NOT create a parallel logging path.

### Localhost-only bind, explicit host argument
**Source:** `src/operator-console/server.ts` line 442 (`server.listen(deps.port, "127.0.0.1", ...)`) plus its own doc comment (lines 95-101) explaining WHY
**Apply to:** `src/overlay/server.ts` — same binding, same "never change the host argument" discipline (D2-17 clarifies overlay is intentionally reachable by local OBS CEF only).

### Origin-check on WebSocket upgrade (CSRF-adjacent for ws)
**Source:** `src/operator-console/server.ts` lines 166-179 (`verifyClient`)
**Apply to:** `src/overlay/server.ts`'s `WebSocketServer` construction — copy verbatim; verified in `tests/e2e/console-flows.e2e.test.ts` lines 336-383, mirror an equivalent e2e test for the overlay.

### Full-state-on-connect + push-on-change (OBS reload resilience)
**Source:** `src/operator-console/server.ts` lines 181-195, `src/operator-console/public/console.js` lines 437-465
**Apply to:** `src/overlay/server.ts` (push side) and `src/overlay/public/overlay.js` (reconnect side) — identical shape, with the Pitfall-3 debounce added only on the push side for vote-tally-frequency events.

### Env-configurable numeric knobs with a sane default, documented in `.env.example`
**Source:** `src/state-machine/review-queue.ts`'s `reviewTtlMs()` (lines 66-74), `.env.example`'s existing entries (`REVIEW_TTL_HOURS`, `GATE_MAX_RETRIES`)
**Apply to:** `ROUND_DURATION_MS`/`ROUND_DURATION_SECONDS` (D2-02), `INTAKE_COOLDOWN_MS` (D2-11), `POOL_MAX_SIZE` (D2-13), sender-queue `intervalCap`/`interval` (D2-08) — add each as a new `.env.example` line with the same one-line "why" comment style already used throughout that file.

### textContent-only DOM construction (stored-XSS mitigation, chat-derived text)
**Source:** `src/operator-console/public/console.js` lines 1-8, 41-46
**Apply to:** `src/overlay/public/overlay.js` — arguably higher stakes here than the console, since overlay content is broadcast live (CONTEXT.md explicitly calls this out).

### Single sanctioned writer per sensitive boundary, enforced by a source-scan test
**Source:** `tests/invariants/single-funnel.test.ts` (checks a-e), `src/queue/task-queue.ts`'s own doc comment (lines 1-14)
**Apply to:** two NEW boundaries this phase introduces: (1) `toQueuedTask`/`.enqueue(` — extend the EXISTING test's allowlist to add `src/pipeline/round.ts` (see Pitfall above); (2) `sendChatMessage`/`HelixChatApi` — add a NEW equivalent scan rule restricting it to `src/ingestion/chat-sender.ts` only (D2-08 says "no direct sendChatMessage calls scattered around" — this is exactly the kind of rule the existing test file's own pattern is built to express; consider adding it as a new `it(...)` block in the SAME `single-funnel.test.ts` file, or a sibling `tests/invariants/chat-sender-funnel.test.ts` using the same `stripComments`/`scanSources`/`allMatches` helpers).

## No Analog Found

None. Every file identified from CONTEXT.md/RESEARCH.md has at least a strong role-match analog in the existing Phase 1 codebase, per the table above. The two areas with the weakest precedent (OAuth bootstrap in `twitch-auth.ts`, and the `p-queue` rate-limiter in `chat-sender.ts`) are compensated for by RESEARCH.md's own verified library-API code examples (Pattern 3, Pattern 4), which are reproduced above as the primary source for those two files specifically — planner should treat RESEARCH.md Pattern 3/4 as load-bearing for those two files, on top of the structural analogs listed.

## Metadata

**Analog search scope:** `src/` (all subdirectories), `tests/` (invariants + e2e), `.env.example`, `package.json` — full repository, no exclusions (small codebase, single Phase 1 skeleton).
**Files scanned (read in full or targeted sections this session):** `src/pipeline/submit.ts`, `src/state-machine/stream-mode.ts`, `src/state-machine/review-queue.ts`, `src/state-machine/halt.ts`, `src/audit/record.ts`, `src/audit/schema.sql`, `src/audit/db.ts`, `src/operator-console/server.ts`, `src/operator-console/public/console.js`, `src/queue/pool.ts`, `src/queue/task-queue.ts`, `src/queue/task-queue.test.ts`, `src/kill-switch/hotkey.ts`, `src/kill-switch/abort.ts` (partial), `src/compliance/gate.ts`, `src/compliance/categories.ts`, `src/compliance/prefilter.ts`, `src/shared/types.ts`, `src/shared/events.ts`, `src/main.ts`, `tests/invariants/single-funnel.test.ts`, `tests/e2e/console-flows.e2e.test.ts`, `.env.example`, `package.json`.
**Pattern extraction date:** 2026-07-09
