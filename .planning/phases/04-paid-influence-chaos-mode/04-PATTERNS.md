# Phase 4: Paid Influence & Chaos Mode - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 20 (new + modified)
**Analogs found:** 20 / 20

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/ingestion/donation-source.ts` | service (event source) | event-driven | `src/ingestion/twitch-chat.ts` | exact (injected-fake seam over a socket, zod-validated) |
| `src/ingestion/donation-source.test.ts` | test | event-driven | `src/ingestion/twitch-chat.test.ts` | exact |
| `src/control-window/control-window.ts` | state-machine | event-driven | `src/state-machine/round.ts` (`RoundManager`) + `src/state-machine/stream-mode.ts` | exact (lifecycle-owner + hand-rolled FSM) |
| `src/control-window/control-window.test.ts` | test | event-driven | `src/state-machine/round.test.ts` | exact |
| `src/control-window/persistence.ts` | model / persistence | CRUD | `src/audit/db.ts` + `RoundManager.restore()` in `src/state-machine/round.ts` | exact |
| `src/control-window/duration.ts` | utility | transform | `src/state-machine/round.ts`'s `roundDurationMs()` (pure, env-config-driven) | role-match |
| `src/chaos/selector.ts` | service | transform | `src/state-machine/round.ts`'s tiebreak `rng()` usage (pure pick from array) | partial (small, novel module — no direct analog, pattern only) |
| `src/chaos/selector.test.ts` | test | transform | `src/state-machine/round.test.ts` (tiebreak RNG injection tests) | role-match |
| `src/pipeline/paid-window.ts` | controller (funnel entry) | request-response | `src/pipeline/round.ts` (`enqueueWinner`) | exact |
| `src/pipeline/chaos.ts` | controller (funnel entry) | request-response | `src/pipeline/round.ts` (`enqueueWinner`) | exact |
| `src/audit/record.ts` (extend) | service | CRUD | itself — `recordRoundOpened`/`recordRoundClosed`/`recordPoolDropped` (Phase 2/3 additive pattern) | exact |
| `src/audit/schema.sql` (extend) | migration | CRUD | itself — `rounds`/`round_candidates` table additions (Phase 2 additive pattern) | exact |
| `tests/invariants/paid-chaos-separation.test.ts` | test / invariant | batch (source scan) | `tests/invariants/secrets-isolation.test.ts` | exact |
| `tests/invariants/single-funnel.test.ts` (extend allowlist) | test / invariant | batch (source scan) | itself — check (d) allowlist | exact |
| `src/ingestion/redemption-source.ts` (or extend `twitch-chat.ts`'s EventSub wiring in `main.ts`) | service (event source) | event-driven | `src/ingestion/twitch-chat.ts` (`ChatEventSource` seam) + `src/main.ts`'s `EventSubWsListener` adapter | exact |
| `src/ingestion/twitch-auth.ts` (extend `TWITCH_SCOPES`) | config | request-response | itself | exact |
| `src/operator-console/server.ts` (extend routes) | controller | request-response | itself — `/api/tasks/:id/veto`, `/api/round/start` routes | exact |
| `src/overlay/server.ts` (extend `OverlayState`) | component (state projection) | pub-sub | itself — `buildStatus`/`round` fields + `OverlayBuildSource` seam | exact |
| `src/main.ts` (wire donation/redemption/control-window/chaos) | provider (composition root) | event-driven | itself — existing twurple/EventSub + console/overlay wiring block | exact |
| `src/shared/events.ts` (extend) | config (event vocabulary) | pub-sub | itself | exact |

## Pattern Assignments

### `src/ingestion/donation-source.ts` (service, event-driven)

**Analog:** `src/ingestion/twitch-chat.ts`

**Imports pattern** (twitch-chat.ts lines 22-28):
```typescript
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SubmitResult } from "../pipeline/submit.js";
import type { SuggestionCandidate } from "../shared/types.js";
import { parseCommand } from "./command-parser.js";
import type { FeedbackKind, Narrator } from "./narration.js";
import type { SuggestIntake } from "./suggest-intake.js";
```
For `donation-source.ts`, swap the twurple-specific imports for `socket.io-client`'s `io`/`Socket` types (per RESEARCH.md Code Example 1) — the STRUCTURE (injected seam interface + zod schema at the top) is what to copy, not the literal imports.

**Injected-seam interface pattern** (twitch-chat.ts lines 42-52):
```typescript
export interface ChatEventSource {
  onChannelChatMessage(
    broadcasterId: string,
    userId: string,
    handler: (e: ChatMessageEvent) => void,
  ): unknown;
  onUserSocketReady(handler: (userId: string, sessionId: string) => void): unknown;
  onUserSocketDisconnect(handler: (userId: string, error?: Error) => void): unknown;
  start(): void;
  stop(): void;
}
```
Copy this exact shape for `DonationEventSource` (RESEARCH.md already specifies `onTip`/`onDisconnect`/`onReady`) — a minimal structural interface the real `socket.io-client` adapter satisfies via a thin arrow-function wrapper in `main.ts` (mirrors `main.ts` lines 775-790's `chatSource` adapter), and tests inject a plain fake with zero network.

**Boundary validation pattern** (twitch-chat.ts lines 74-79):
```typescript
const ChatMessageEventSchema = z.object({
  chatterId: z.string().min(1),
  chatterDisplayName: z.string(),
  messageText: z.string(),
});
```
Every external payload (StreamElements `tip` envelope) gets a `z.object(...).safeParse()` at the top of the handler — never trust the socket payload's shape.

**Fail-closed handler pattern** (twitch-chat.ts lines 89-131):
```typescript
const handleMessage = (raw: ChatMessageEvent): void => {
  try {
    const parsedEvent = ChatMessageEventSchema.safeParse(raw);
    if (!parsedEvent.success) return; // malformed EventSub payload — drop, never crash
    // ... dispatch ...
  } catch (err) {
    // Fail-closed: a hostile payload or downstream throw must never kill
    // the listener — log and keep consuming chat (T-02-15).
    deps.logger.error({ err }, "chat message handler failed — listener stays up");
  }
};
```
Copy verbatim structure for the `tip` handler: `safeParse` → early return on failure, whole handler wrapped in try/catch, never let a malformed StreamElements payload kill the socket.

**Reconnect/observability pattern** (twitch-chat.ts lines 140-149):
```typescript
deps.source.onUserSocketDisconnect((userId, error) => {
  deps.logger.warn(
    { userId, err: error },
    "EventSub socket disconnected — twurple will auto-reconnect",
  );
});
deps.source.onUserSocketReady((userId, sessionId) => {
  deps.logger.info({ userId, sessionId }, "EventSub socket (re)connected and ready");
  deps.reconcile();
});
```
For StreamElements, `socket.io-client` has its own reconnect logic (like twurple) — treat disconnect as transient (log + warn), never fatal (RESEARCH.md Anti-Patterns).

---

### `src/control-window/control-window.ts` (state-machine, event-driven)

**Analog:** `src/state-machine/round.ts` (`RoundManager`) — the closest "lifecycle owner with a timer, durable persistence, and an injected funnel" shape in the codebase. Also draw the *legal-transition-table* idea from `src/state-machine/stream-mode.ts`.

**Class shape + injected funnel dependency** (round.ts lines 73-91, 156-179):
```typescript
export interface RoundManagerDeps {
  db: Database.Database;
  machine: StreamModeMachine;
  pool: CandidatePool;
  enqueueWinner: (
    candidate: SuggestionCandidate,
    result: GateResult,
    pooledAtMs: number,
  ) => EnqueueWinnerResult;
  logger?: Logger;
  now?: () => number;
  rng?: () => number;
}

export class RoundManager {
  readonly #db: Database.Database;
  readonly #machine: StreamModeMachine;
  // ...
  readonly #emitter = new EventEmitter();

  constructor(deps: RoundManagerDeps) {
    // ...
    this.#now = deps.now ?? Date.now;
    this.#lastMode = deps.machine.mode;

    this.#machine.on(HALT_TRIGGERED, () => { this.#freeze(); });
    this.#machine.on(STATE_CHANGED, (...args: unknown[]) => {
      const snap = args[0] as StateSnapshot;
      const prev = this.#lastMode;
      this.#lastMode = snap.mode;
      if (prev !== "HALTED") return;
      if (snap.mode === "VOTING_ROUND") this.#resume();
      else if (snap.mode === "IDLE") this.#discard();
    });
  }
}
```
`ControlWindow` should follow this EXACT shape: constructor takes `{ db, machine, ...injected funnel fn, now, logger }`, subscribes to `HALT_TRIGGERED`/`STATE_CHANGED` for halt-freeze/recovery symmetry, drives `StreamModeMachine.transition("FREE_REIGN_WINDOW")` on open and `transition("IDLE")` on close/expire/revoke (both are already-legal transitions per `stream-mode.ts` lines 27-34 — no changes needed there).

**Absolute-timestamp expiry (crash-safety) pattern** (round.ts lines 226-236, 533-538):
```typescript
const openedAtMs = this.#now();
const durationMs = roundDurationMs();
const endsAtMs = openedAtMs + durationMs;
// ... persisted to the rounds table ...

// restore():
const remaining = row.ends_at_ms - this.#now();
if (remaining <= 0) {
  this.closeRound();
  return;
}
this.#armTimer(remaining);
```
This is the DIRECT template for Pitfall 2 in RESEARCH.md ("never re-arm from `Date.now() + duration`"): persist `ends_at_ms` (absolute), and on restore either close-as-expired or re-arm for exactly the remainder — never recompute a fresh full-duration timer.

**Timer arm/clear pattern** (round.ts lines 624-638):
```typescript
#armTimer(delayMs: number): void {
  this.#clearTimer();
  this.#timer = setTimeout(() => {
    this.closeRound();
  }, delayMs);
  this.#timer.unref();
}

#clearTimer(): void {
  if (this.#timer !== null) {
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
```
Copy verbatim for the window-expiry timer — `unref()` so it never keeps the process alive; always clear before re-arming.

**Funnel isolation note** (round.ts lines 17-21, module doc):
> "Funnel isolation: the winner is handed to the INJECTED enqueueWinner function... This module never imports the queue or gate internals — the COMP-01 single-funnel invariant scan must stay clean."

`control-window.ts` must follow the identical discipline: it calls an INJECTED `submitDuringWindow`-style function (from `src/pipeline/paid-window.ts`), never imports `compliance/gate.ts` or `queue/task-queue.ts` directly.

**One-active-at-a-time guard pattern** (round.ts lines 211-225, `RoundStartError`):
```typescript
export class RoundStartError extends Error {
  readonly reason: "not-idle" | "pool-too-small" | "round-active";
  // ...
}

startRound(): RoundSnapshot {
  if (this.#round !== null) {
    throw new RoundStartError("round-active");
  }
  if (this.#machine.mode !== "IDLE") {
    throw new RoundStartError("not-idle");
  }
  // ...
}
```
Mirror this for D-05 (one active control window at a time): a typed `ControlWindowError` with reasons like `"window-active" | "cooldown" | "not-idle"`, thrown synchronously and mapped to a 409 by the console route (see operator-console section below).

---

### `src/control-window/persistence.ts` (model, CRUD)

**Analog:** `src/audit/db.ts` (connection/schema loading) + `RoundManager.restore()` in `src/state-machine/round.ts` (lines 471-539) for the read-back-and-rebuild half.

**Schema-loading pattern** (audit/db.ts, whole file):
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
The `control_windows` table (RESEARCH.md Pattern 1 schema, reproduced below) is added to the EXISTING `src/audit/schema.sql` (not a new schema file) — this codebase keeps one schema file, loaded once at boot; no second `openDb`-style connection factory.

**New table (from RESEARCH.md, to append to `src/audit/schema.sql`):**
```sql
CREATE TABLE IF NOT EXISTS control_windows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type      TEXT NOT NULL,             -- 'donation' | 'channel_points'
  donor_identifier  TEXT NOT NULL,
  amount_or_cost    INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  opened_at_ms      INTEGER NOT NULL,
  ends_at_ms        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  closed_at_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_control_windows_status ON control_windows(status);
```
Follow `src/audit/schema.sql`'s existing comment-header convention (see the `rounds`/`round_candidates`/`round_votes` block, lines 45-56) — a short prose comment above the table explaining the durability contract, referencing D-06 by name.

**Restore-on-boot pattern** (round.ts lines 471-539, `restore()`):
```typescript
restore(): void {
  const row = this.#db
    .prepare("SELECT * FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    .get() as RoundRow | undefined;
  if (!row) return;
  // ... rebuild in-memory state from the row + child tables ...
  const remaining = row.ends_at_ms - this.#now();
  if (remaining <= 0) {
    this.closeRound();
    return;
  }
  this.#armTimer(remaining);
}
```
Copy this exact shape for `ControlWindow.restore()`: `SELECT ... WHERE status = 'active' ORDER BY id DESC LIMIT 1`, and on boot either close-as-`expired` (writing the closed_at_ms + status update) or re-arm for the persisted remainder — called at startup BEFORE any donation/redemption listener accepts events (mirrors `RoundManager.restore()`'s "called at startup BEFORE any listener accepts votes" doc comment).

---

### `src/pipeline/paid-window.ts` and `src/pipeline/chaos.ts` (controller / funnel entry, request-response)

**Analog:** `src/pipeline/round.ts` (`enqueueWinner`) — this is the EXACT structural template named by RESEARCH.md Pattern 2 and already drafted there. Reproduce nearly verbatim.

**Full existing analog** (`src/pipeline/round.ts`, lines 35-96):
```typescript
export interface EnqueueWinnerDeps {
  taskQueue: TaskQueue;
  db: Database.Database;
  mode: () => StreamMode;
  resubmit: (candidate: SuggestionCandidate) => SubmitResult;
  staleAfterMs?: number;
  logger?: Logger;
}

export function enqueueWinner(
  deps: EnqueueWinnerDeps,
  approved: ApprovedCandidate,
): EnqueueWinnerResult {
  if (deps.mode() === "HALTED") {
    deps.logger?.warn(/* ... */);
    return { queued: false, reason: "halted" };
  }
  // staleness check ...
  const task = toQueuedTask(approved.candidate, approved.result);
  deps.taskQueue.enqueue(task);
  deps.logger?.info(/* ... */);
  return { queued: true };
}
```

**RESEARCH.md's already-drafted `paid-window.ts` (ready to use as the plan's starting point):**
```typescript
// src/pipeline/paid-window.ts — Source: mirrors src/pipeline/round.ts's enqueueWinner exactly
import { classify, toQueuedTask } from "../compliance/gate.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { SuggestionCandidate } from "../shared/types.js";

export interface PaidWindowFunnelDeps {
  taskQueue: TaskQueue;
  classify: (candidate: SuggestionCandidate) => Promise<import("../shared/types.js").GateResult>;
  mode: () => import("../shared/types.js").StreamMode;
}

export async function submitDuringWindow(
  deps: PaidWindowFunnelDeps,
  candidate: SuggestionCandidate,
): Promise<{ queued: true } | { queued: false; reason: "halted" | "rejected" | "held" }> {
  if (deps.mode() === "HALTED") return { queued: false, reason: "halted" };
  const result = await deps.classify(candidate);
  if (result.decision !== "approved") {
    return { queued: false, reason: result.decision === "held-for-review" ? "held" : "rejected" };
  }
  deps.taskQueue.enqueue(toQueuedTask(candidate, result));
  return { queued: true };
}
```
`src/pipeline/chaos.ts` follows the identical shape, taking a `pickChaos()` result (already a `SuggestionCandidate`-shaped pool entry) instead of a raw donor instruction. **Critical invariant** (enforced by `tests/invariants/single-funnel.test.ts` check (d)): only `classify()` + `toQueuedTask()` from `compliance/gate.ts`, only `.enqueue()` inside `src/pipeline/`.

**Required test-file edit** — `tests/invariants/single-funnel.test.ts` lines 181-186:
```typescript
it("(d) toQueuedTask is referenced outside gate.ts only by src/pipeline/{submit,round}.ts", () => {
  const allowed = new Set([
    "src/compliance/gate.ts",
    "src/pipeline/submit.ts",
    "src/pipeline/round.ts",
  ]);
  // ...
});
```
Add `"src/pipeline/paid-window.ts"` and `"src/pipeline/chaos.ts"` to the `allowed` set — this is the ONE deliberate, test-visible extension point (RESEARCH.md Pattern 2). Update the `it(...)` description string too (currently names only `submit`/`round`).

---

### `src/control-window/duration.ts` (utility, transform)

**Analog:** `src/state-machine/round.ts`'s `roundDurationMs()` (lines 93-101) — a pure, env-config-driven function pattern already established for "a tunable numeric constant with a sane default."

```typescript
const DEFAULT_ROUND_DURATION_SECONDS = 60;

export function roundDurationMs(): number {
  const raw = process.env.ROUND_DURATION_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROUND_DURATION_SECONDS;
  return seconds * 1_000;
}
```
`amountToDurationSeconds` (RESEARCH.md Pattern 1) should follow the same "parse env or fall back to a documented default, never NaN/negative" discipline for its `ratePerUnit`/`minSeconds`/`maxSeconds` config, kept as a pure function with no I/O (directly unit-testable, as RESEARCH.md specifies).

---

### `src/chaos/selector.ts` (service, transform)

**Analog:** No direct module-level analog exists (this is a genuinely new capability), but the RNG-injection PATTERN is already established in `src/state-machine/round.ts`'s tiebreak logic (lines 89-91, 178, 372-374):

```typescript
export interface RoundManagerDeps {
  // ...
  /** Injectable RNG for deterministic tiebreak tests (D2-03). */
  rng?: () => number;
}
// constructor:
this.#rng = deps.rng ?? Math.random;
// usage:
const pick = Math.min(Math.floor(this.#rng() * leaders.length), leaders.length - 1);
winnerOption = leaders[pick]?.option ?? null;
```
`chaos/selector.ts` should use the SAME "injectable RNG for deterministic tests" shape, but per RESEARCH.md/D-08, the PRODUCTION default must be `node:crypto`'s `randomInt` — NOT `Math.random` (the round tiebreak's `Math.random` default is fine there because it isn't part of the D-08 boundary; `pickChaos` is, so its RNG source is the one deliberately-scanned import). RESEARCH.md's drafted implementation:
```typescript
import { randomInt } from "node:crypto";
import type { ApprovedCandidate } from "../queue/pool.js";

export function pickChaos(pool: ApprovedCandidate[]): ApprovedCandidate | null {
  if (pool.length === 0) return null;
  return pool[randomInt(0, pool.length)] ?? null;
}
```
For deterministic tests, accept an optional injected `rng: (max: number) => number` parameter mirroring `RoundManagerDeps.rng`, defaulting to `(max) => randomInt(0, max)`.

---

### `src/ingestion/redemption-source.ts` (or extend the existing EventSub wiring) (service, event-driven)

**Analog:** `src/ingestion/twitch-chat.ts`'s `ChatEventSource` seam + `src/main.ts` lines 768-790 (the twurple `EventSubWsListener` dynamic-import adapter).

**Composition-root wiring pattern** (main.ts lines 768-793):
```typescript
const { ApiClient } = await import("@twurple/api");
const { EventSubWsListener } = await import("@twurple/eventsub-ws");
const apiClient = new ApiClient({ authProvider: provider });
const listener = new EventSubWsListener({ apiClient });

const chatSource: ChatEventSource = {
  onChannelChatMessage: (broadcasterId, userId, handler) =>
    listener.onChannelChatMessage(broadcasterId, userId, (event) =>
      handler({
        chatterId: event.chatterId,
        chatterDisplayName: event.chatterDisplayName,
        messageText: event.messageText,
      }),
    ),
  onUserSocketReady: (handler) => listener.onUserSocketReady((userId, sessionId) => handler(userId, sessionId)),
  onUserSocketDisconnect: (handler) => listener.onUserSocketDisconnect((userId, error) => handler(userId, error)),
  start: () => listener.start(),
  stop: () => listener.stop(),
};
```
The channel-points redemption subscription is ONE MORE call on this SAME `listener` object (RESEARCH.md: "extends the EXISTING Phase 2 `@twurple/eventsub-ws` session... not a new session/connection"). Add a `redemptionSource: RedemptionEventSource` adapter alongside `chatSource`, both built from the same `listener`/`apiClient` pair, both dynamically imported in the same `main.ts` block — never a second `EventSubWsListener`.

**zod boundary schema** (RESEARCH.md Code Example 2, follows `ChatMessageEventSchema`'s exact shape):
```typescript
const RedemptionEventSchema = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
  user_input: z.string(),
  status: z.string(),
  reward: z.object({ id: z.string(), title: z.string(), cost: z.number() }),
  redeemed_at: z.string(),
});
```

---

### `src/ingestion/twitch-auth.ts` (config, request-response)

**Analog:** itself (extend, do not rewrite) — lines 27-32:
```typescript
export const TWITCH_SCOPES = ["user:read:chat", "user:write:chat"] as const;
```
Add `"channel:read:redemptions"` to this array. This is a "planning-relevant correction" per RESEARCH.md Open Question 1 — the broadcaster MUST re-authorize via the existing `/auth/start` flow (no new auth surface, just a broader scope list) once this ships. No other change to `twitch-auth.ts`'s structure — `buildAuthorizeUrl` already joins `TWITCH_SCOPES` with a space (line 99), so the new scope is picked up automatically.

---

### `src/operator-console/server.ts` (controller, request-response) — extend with revoke-window / toggle-chaos routes

**Analog:** itself — the veto route (`/api/tasks/:id/veto`, lines 549-582) and round-start route (`/api/round/start`, lines 441-458) are the templates for "streamer-triggered state mutation with a typed error → HTTP status mapping."

**Veto route pattern** (server.ts lines 549-582):
```typescript
app.post("/api/tasks/:id/veto", (req, res) => {
  const params = TaskIdParamsSchema.safeParse(req.params);
  const body = ResolveBodySchema.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "invalid veto request" });
    return;
  }
  const reasonTag = body.data.reasonTag ?? null;
  const removed = taskQueue.remove(params.data.id);
  if (removed) {
    recordVeto(db, { /* ... */ });
    pushState();
    res.json({ removed: true });
    return;
  }
  // ...
  res.status(404).json({ error: "task not found" });
});
```
`POST /api/control-window/revoke` (no params — mirrors `RoundStartBodySchema`'s strict-empty-object pattern) should: call `controlWindow.revoke()`, write the revoke audit row, `pushState()`, return the updated snapshot. `POST /api/chaos/toggle` mirrors the same shape, driving `machine.transition("CHAOS_MODE")` / back to `IDLE`.

**Typed-error → HTTP-status mapping pattern** (server.ts lines 441-458, `RoundStartError`):
```typescript
app.post("/api/round/start", (req, res) => {
  const parsed = RoundStartBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid round start request body" });
    return;
  }
  try {
    const snap = deps.round.startRound();
    pushState();
    res.json(snap);
  } catch (err) {
    if (err instanceof RoundStartError) {
      res.status(409).json({ error: err.message, reason: err.reason });
      return;
    }
    throw err;
  }
});
```
Use this EXACT try/catch → 409-with-reason shape for opening a control window (donation/redemption arriving while one is active or in cooldown maps to a typed `ControlWindowError`, per D-05's "queued behind the cooldown or dropped-with-feedback, never silently").

**No new middleware needed:** the shared DNS-rebinding + Origin/Content-Type CSRF middleware (server.ts lines 179-236) already covers every POST route uniformly — new routes add zero new security surface, mirroring the retry/skip routes' own comment ("the shared CSRF/DNS-rebinding middleware above already covers this POST — NO new middleware, T-03-25").

**`ConsoleState` extension pattern** (server.ts lines 111-122, `buildState()` at lines 244-263):
```typescript
export interface ConsoleState extends StateSnapshot {
  pool: ReturnType<CandidatePool["list"]>;
  queue: SuggestionCandidate[];
  pendingReviewCount: number;
  review: ReviewItem[];
  round: RoundSnapshot | null;
  twitch: TwitchConnectionStatus;
  build: BuildConsoleStatus | null;
}
```
Add `controlWindow: ControlWindowSnapshot | null` and `chaosMode: boolean` fields, populated in `buildState()` the same way `round`/`build` are (`deps.controlWindow.snapshot()` — an injected structural seam, mirroring `RoundManager`/`OverlayBuildSource`).

---

### `src/overlay/server.ts` (component, pub-sub) — extend `OverlayState` with window/chaos presentation

**Analog:** itself — the `OverlayBuildSource` seam (lines 86-100) and `OverlayState.buildStatus` field are the direct template for "read-only projection of a new backend state slice onto the public overlay."

**Structural seam pattern** (overlay/server.ts lines 86-100):
```typescript
export interface OverlayBuildSource {
  snapshot(): BuildStatusView | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

const NULL_BUILD_SOURCE: OverlayBuildSource = {
  snapshot: () => null,
  on: () => {},
};
```
Add `OverlayControlWindowSource` (and a `NULL_CONTROL_WINDOW_SOURCE` default so the overlay composes before Phase 4 wiring lands, exactly as the build source does before 03-06) with the same `snapshot()`/`on()` shape.

**Public-vocabulary narrowing pattern** (overlay/server.ts lines 122-135, `PILL_BY_MODE`):
```typescript
const PILL_BY_MODE: Record<StreamMode, OverlayPill> = {
  IDLE: "STANDBY",
  VOTING_ROUND: "VOTING OPEN",
  BUILD_IN_PROGRESS: "BUILDING",
  FREE_REIGN_WINDOW: "STANDBY",
  CHAOS_MODE: "STANDBY",
  HALTED: "ON HOLD",
};
```
`FREE_REIGN_WINDOW`/`CHAOS_MODE` are ALREADY present in this table (mapped to STANDBY as a Phase-1 placeholder) — Phase 4 changes these two mappings to real pill words (e.g. `"FREE REIGN"` / `"CHAOS MODE"`) and adds the `controlWindow`/`chaosMode` fields to `OverlayState` (mirrors `buildStatus`'s addition in Phase 3). RESEARCH.md's Security Domain table flags: the public overlay carries ONLY a coarse view (truncated donor handle + countdown) — never the full donation message — following the `BuildStatusView.title` truncation precedent (`T-03-16`, textContent-only, dom-safety invariant).

**Push-cadence pattern** (overlay/server.ts lines 214-234, immediate push for low-frequency lifecycle events):
```typescript
build.on(BUILD_STAGE_CHANGED, () => {
  pushState();
});
```
Control-window open/close/revoke and chaos toggle are low-frequency show beats — push IMMEDIATELY (no debounce), exactly like `BUILD_STAGE_CHANGED`/`ROUND_OPENED`/`ROUND_CLOSED`. Only a live COUNTDOWN tick (if rendered server-computed rather than client-computed from `endsAtMs`) would need debounce consideration — RESEARCH.md's "full-state + `endsAtMs`" design avoids a ticking push entirely (client renders the countdown from the absolute timestamp, same as `RoundSnapshot.endsAtMs`).

---

### `src/audit/record.ts` (extend) (service, CRUD)

**Analog:** itself — the Phase 2/3 additive pattern (`recordRoundOpened`/`recordRoundClosed`/`recordPoolDropped`, `recordPipelineStage`/`recordComp02Decision` etc.) at lines 182-393.

**Insert-helper pattern** (record.ts lines 185-201, `recordRoundOpened`):
```typescript
export function recordRoundOpened(
  db: Database.Database,
  args: { roundId: number; candidateCount: number; durationMs: number; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "round_opened",
    source: "operator",
    twitchUsername: null,
    suggestionText: null,
    decision: null,
    category: null,
    rationale: `Round opened with ${args.candidateCount} candidates, ${args.durationMs}ms duration`,
    streamMode: args.streamMode,
    taskId: String(args.roundId),
  });
}
```
Add `recordWindowOpened`/`recordWindowClosed`/`recordWindowRevoked`/`recordChaosPick` following this EXACT arg-object → `insert()` shape — new `event_type` values only, no schema/CHECK-constraint changes needed (the module doc at lines 261-268 confirms `audit_log` has no CHECK constraints, so new event_type/source string values are schema-safe additions — only `schema.sql`'s descriptive comment needs extending, per the Phase 3 precedent). `source` for window events should be `"donation"` or `"channel_points"` (already in `CandidateSource`); `recordChaosPick` uses `source: "chaos"` (already in the union, `shared/types.ts` line 30).

---

## Shared Patterns

### Single-Funnel Re-Entry (D-06 / COMP-01)
**Source:** `src/pipeline/round.ts` (`enqueueWinner`) + `src/compliance/gate.ts` (`classify`, `toQueuedTask`)
**Apply to:** `src/pipeline/paid-window.ts`, `src/pipeline/chaos.ts`

Every paid/chaos-selected instruction MUST pass through `classify()` → `toQueuedTask()` → `TaskQueue.enqueue()`, called ONLY from a narrow `src/pipeline/*.ts` module. No other file may call `.enqueue(` or construct `as QueuedTask`. Enforced today by `tests/invariants/single-funnel.test.ts` checks (a)/(b)/(d) — extend allowlist (d) with the two new filenames; checks (a)/(b) need NO changes (they already scan the whole `src/` tree structurally, not by filename).

### Never-Silent Doctrine
**Source:** `src/pipeline/round.ts` (`WR-02`/`WR-01` comments, lines 60-77, 415-433) + `src/ingestion/twitch-chat.ts` (`INTAKE_FEEDBACK` narration on refusal, lines 82-86, 106-109)
**Apply to:** `control-window.ts` (window open/close/revoke/dropped-while-active), `chaos/selector.ts` callers (empty-pool pick), `pipeline/paid-window.ts`/`chaos.ts` (rejected/held outcomes)

Every drop, refusal, or non-obvious outcome gets an audit row AND (where user-facing) a narrated message — never a silent no-op. Follow `round.ts`'s pattern of returning a typed `{ queued: false, reason: ... }` result and logging a `logger?.warn(...)` at every non-happy path, exactly mirrored in RESEARCH.md's drafted `submitDuringWindow`.

### Machine-Checked Source-Scan Invariant (D-08)
**Source:** `tests/invariants/secrets-isolation.test.ts` (whole file) + `tests/invariants/scan-helpers.ts` (`collectFiles`, `allMatches`, `stripComments`)
**Apply to:** new `tests/invariants/paid-chaos-separation.test.ts`

Reuse `scan-helpers.ts`'s `collectFiles`/`allMatches` directly (do not re-roll the comment stripper — `scan-helpers.ts`'s own doc comment says as much: "New invariant scans... import these instead of re-rolling the comment stripper"). Two independent regex scans + a synthetic self-test proving sensitivity to sabotage, structured exactly like `secrets-isolation.test.ts`'s three `it()` blocks (scope-sanity check, the enforced-property check, the self-test). RESEARCH.md Pattern 4 has the full drafted test — use it as the plan's starting point verbatim.

### CSRF / DNS-Rebinding Middleware (console routes)
**Source:** `src/operator-console/server.ts` lines 179-236 (both middleware blocks)
**Apply to:** any new `/api/control-window/*` and `/api/chaos/*` POST routes

No new middleware — the existing app-level `app.use(...)` DNS-rebinding + Origin/Content-Type CSRF checks apply globally to every route registered after them (already proven by the retry/skip routes needing zero new middleware, T-03-25). New routes just need a `z.object({}).strict()` or param schema following `RoundStartBodySchema`/`TaskIdParamsSchema`'s exact shape.

### Full-State-on-Connect + Debounced/Immediate Diffs (overlay)
**Source:** `src/overlay/server.ts` (whole file, especially lines 197-248)
**Apply to:** `OverlayState.controlWindow`/`OverlayState.chaosMode` fields

Lifecycle events (window open/close/revoke, chaos toggle) push immediately like `ROUND_OPENED`/`ROUND_CLOSED`/`BUILD_STAGE_CHANGED` — never through the 300ms vote-tally debounce, which is reserved for genuinely high-frequency events only.

### Event Vocabulary Constants
**Source:** `src/shared/events.ts` (whole file)
**Apply to:** new `WINDOW_OPENED`, `WINDOW_CLOSED`, `CHAOS_TOGGLED` (naming TBD by planner) constants

```typescript
export const ROUND_OPENED = "round:opened" as const;
export const ROUND_CLOSED = "round:closed" as const;
export const VOTE_RECORDED = "round:vote-recorded" as const;

export type AppEvent =
  | typeof STATE_CHANGED
  // ...
  | typeof ROUND_OPENED
  | typeof ROUND_CLOSED
  | typeof VOTE_RECORDED;
```
Add new constants to this file (never inline string literals per the file's own header doc), and extend the `AppEvent` union — every emitter/listener in Phase 4 must reference these constants.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/chaos/selector.ts` | service | transform | No prior "pure uniform-random pick from a pool" module exists — closest precedent is `round.ts`'s inline tiebreak RNG usage (partial match, documented above), not a standalone module. Low risk: RESEARCH.md already provides a complete, ready-to-use implementation (Pattern 3). |

## Metadata

**Analog search scope:** `src/` (all subdirectories), `tests/invariants/`
**Files scanned directly:** `src/state-machine/stream-mode.ts`, `src/state-machine/round.ts`, `src/pipeline/round.ts`, `src/pipeline/submit.ts`, `src/compliance/gate.ts`, `src/kill-switch/abort.ts`, `src/ingestion/twitch-chat.ts`, `src/ingestion/twitch-auth.ts`, `src/audit/record.ts`, `src/audit/db.ts`, `src/audit/schema.sql`, `src/operator-console/server.ts`, `src/overlay/server.ts`, `src/queue/task-queue.ts`, `src/queue/pool.ts`, `src/shared/types.ts`, `src/shared/events.ts`, `src/main.ts` (EventSub wiring section), `tests/invariants/secrets-isolation.test.ts`, `tests/invariants/single-funnel.test.ts`, `tests/invariants/scan-helpers.ts`
**Pattern extraction date:** 2026-07-10
