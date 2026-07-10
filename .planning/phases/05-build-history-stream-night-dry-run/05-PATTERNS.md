# Phase 5: Build History & Stream Night Dry Run - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 8 (5 code files for HIST-01, 2 doc/runbook artifacts for the dry run, 1 shared-type touch)
**Analogs found:** 8 / 8

## D-01 VERDICT (read this first)

**A dedicated `build_history` record is required. A pure view-over-`audit_log` CANNOT losslessly reconstruct a changelog entry.** See "D-01 Investigation" below for the full evidence trail. Summary of the gap:

| Needed field | Reconstructable from existing ledger? | Evidence |
|---|---|---|
| Result (`built`\|`refused`\|`failed`) | YES — `audit_log.event_type='pipeline_stage' AND decision IN ('done','failed','refused')`, keyed by `task_id` | `src/audit/record.ts` `recordPipelineStage` / `src/orchestrator/build-session.ts` `finalize()` |
| Suggestion title | **NO** — `recordPipelineStage` always writes `suggestionText: null` (`record.ts:285`); the only rows that carry the approved title (`gate_decision`) never write a `task_id` (`recordGateDecision`, `record.ts:104-126`, and its caller `gate.ts:141-150`) | `src/audit/record.ts` lines 269-292 vs 104-126 |
| Provenance (`vote`\|`paid`\|`chaos`) | **PARTIAL** — only the chaos path is joinable (`recordChaosPick` writes `task_id` = `candidate.id` = the eventual `QueuedTask.id`, `src/main.ts:580-584`); the vote path (`recordRoundClosed`) keys its row by `round_id`, not the build's `task_id`; the paid path (`recordWindowOpened`) never records a `task_id`/title at all | `src/audit/record.ts` `recordRoundClosed` (207-237), `recordWindowOpened` (413-435), `recordChaosPick` (528-544) |
| Stream-night grouping key | **NO column exists anywhere** in `schema.sql` — must be derived from `created_at_ms` (or a new dedicated record's own timestamp) | `src/audit/schema.sql` (full file scanned, no session/day column) |

**Additional finding relevant to the planner:** `BuildStatusView.source` (the provenance chip field, `shared/types.ts:210`) is **never actually set** by `src/orchestrator/build-session.ts`'s `emitStage()` (`build-session.ts:315`, `const view: BuildStatusView = { taskId: task.id, title: task.text, stage };` — no `source` key). The three call sites that DO know provenance contextually (`main.ts` `onWinnerQueued` = vote, `driveWindowBuild` = paid, `driveChaosBuild` = chaos, lines 914-990) never pass it into `buildSession.startBuild(task)`. This means the overlay's provenance chip is currently dead code in production (always defaults to "vote" per `overlay.js:332`), and — more importantly for this phase — **provenance is not currently plumbed to the point where a build-completion record could read it**. The Phase 5 plan must either (a) thread a `provenance` argument through `startBuild()`/`BuildSessionDeps` from the three `main.ts` call sites, or (b) capture provenance a different way (e.g. read `machine.mode` at build-start: `VOTING_ROUND`→vote, `FREE_REIGN_WINDOW`→paid, `CHAOS_MODE`→chaos — mirrors the existing `driveXBuild` mode-guard pattern already in `main.ts`). Recommend (a): explicit is safer than mode-inference and costs one extra parameter.

**Recommended shape:** add `recordBuildHistory` to `src/audit/record.ts` (additive, no schema break — mirrors every other Phase 3/4 helper) writing to a **new** `build_history` table in `src/audit/schema.sql`, populated once at `finalize()` in `build-session.ts` (the terminal `done`/`failed`/`refused` beat — NOT `finalizeAborted()`, which is an explicit non-completion per its own doc comment at `build-session.ts:362-376`). Columns: `id`, `task_id`, `title` (= `task.text`, gate-approved per COMP-01 single-funnel — D-03 compliant), `provenance` (`vote`\|`donation`\|`channel_points`\|`chaos`), `result` (`built`\|`refused`\|`failed`), `created_at_ms`. Stream-night grouping is a derived query concern (`DATE(created_at_ms/1000, 'unixepoch')` or a JS calendar-day bucket on read) — no new column needed for D-02's grouping requirement.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/audit/schema.sql` (add `build_history` table) | model/migration | CRUD (append-only insert) | same file, `control_windows` table block (lines 94-120) | exact (same file, same idiom) |
| `src/audit/record.ts` (add `recordBuildHistory` + `listBuildHistory`) | service | CRUD | `recordChaosPick` (insert, lines 528-544) + `listAuditRecords` (query, lines 546-570) in the same file | exact |
| `src/orchestrator/build-session.ts` (call the new record fn from `finalize()`) | orchestrator hook | event-driven | its own `finalize()` (342-360) / `emitStage()` (313-327) | exact (same file, same pattern already used for `recordPipelineStage`) |
| `src/main.ts` (thread `provenance` into `startBuild()` at the 3 drive sites) | wiring/composition | event-driven | its own `onWinnerQueued`/`driveWindowBuild`/`driveChaosBuild` (914-990) | exact |
| `src/changelog/server.ts` (new) | route/served-surface | request-response | `src/preview/server.ts` (full file — closest: loopback, no ws, static + one thin GET) | exact |
| `src/changelog/public/changelog.html` | component (static shell) | — | `src/preview/public/preview.html` | exact |
| `src/changelog/public/changelog.js` | component (client render) | request-response (poll/fetch, no ws) | `src/operator-console/public/console.js` `renderRound`'s `<ol>`/`<li>` list block (308-330) for the list shape; `src/overlay/public/overlay.js` `el()`/`truncate()` helpers (85-96) for dom-safety | role-match (list rendering) + exact (dom-safety helpers) |
| `docs/OPERATIONS.md` (extend) + new `.planning/phases/05-.../05-DRY-RUN.md` runbook | config/docs | — | `.planning/phases/04-paid-influence-chaos-mode/04-08-PLAN.md` + its `04-LIVE-GATE.md` artifact shape (GO/NO-GO verdict block, numbered runbook sections, `checkpoint:human-action`/`checkpoint:human-verify` tasks) | exact |

## D-01 Investigation (full evidence)

### Ledger schema scanned
`src/audit/schema.sql` (121 lines, read in full) — two tables relevant:
- `audit_log`: `event_type`, `source`, `twitch_username`, `suggestion_text`, `decision`, `category`, `rationale`, `stream_mode`, `task_id`. No CHECK constraints (schema-safe to add new `event_type` values, confirmed by the Phase 3/4 comments at lines 261-268 and 395-404).
- No stream-night/session/date column anywhere in the file.

### Why `pipeline_stage` rows can't carry the title
`src/audit/record.ts` lines 269-292, `recordPipelineStage`:
```typescript
export function recordPipelineStage(
  db: Database.Database,
  args: { taskId: string; stage: PipelineStage; streamMode: StreamMode; summary?: string | null },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "pipeline_stage",
    source: "orchestrator",
    twitchUsername: null,
    suggestionText: null,   // <-- always null
    decision: args.stage,   // 'queued'|'researching'|'planning'|'building'|'done'|'failed'|'refused'
    category: null,
    rationale: args.summary ?? null,
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}
```
Confirmed at the call site — `build-session.ts:313-327`, `emitStage()` — `task.text` (the title) is available in-process but is never passed to `recordPipelineStage`.

### Why `gate_decision` rows can't be joined to a build's `task_id`
`src/audit/record.ts` lines 104-126, `recordGateDecision` (this IS the row with the approved title + `decision: "approved"`):
```typescript
export function recordGateDecision(
  db: Database.Database,
  args: { candidate: SuggestionCandidate; decision: GateDecision; category: GateCategory | null; rationale: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "gate_decision",
    source: args.candidate.source,
    twitchUsername: args.candidate.twitchUsername,
    suggestionText: args.candidate.text,   // <-- the title IS here
    decision: args.decision,               // 'approved' | 'rejected' | 'held-for-review'
    category: args.category,
    rationale: args.rationale,
    streamMode: args.streamMode,
    taskId: null,                          // <-- always null — no task_id yet at gate time
  });
}
```
`taskId: null` is structural, not incidental: `classify()` in `src/compliance/gate.ts` (lines 64-122) runs BEFORE a `QueuedTask` exists — `toQueuedTask()` (line 130) is called only after `classify()` returns. There is no later write-back of the resulting `task.id` onto the earlier `gate_decision` row (the ledger is INSERT-only/append-only by design, `record.ts:11-17`). So even though `QueuedTask.id === candidate.id` (confirmed: `toQueuedTask` does `{ ...candidate } as QueuedTask`, `gate.ts:137`), there is no column in the `gate_decision` row holding that id to join against `pipeline_stage.task_id`. Matching by `(source, twitch_username, suggestion_text, timestamp-proximity)` is a heuristic, not a lossless reconstruction — explicitly what D-01 says disqualifies the view-only approach.

### Provenance: only the chaos path is joinable today
`src/main.ts` lines 568-591, `chaos.pick()`:
```typescript
recordChaosPick(db, {
  taskId: picked.candidate.id,   // <-- matches the eventual QueuedTask.id
  title: picked.candidate.text,
  streamMode: machine.mode,
});
```
This is the ONE existing audit row that could be joined to its terminal `pipeline_stage` row by `task_id` to get provenance="chaos" + title. Nothing equivalent exists for:
- **vote**: `recordRoundClosed` (`record.ts:207-237`) keys `taskId: String(args.roundId)` — the ROUND id, not the build's task id — and `rounds`/`round_candidates` tables have no queued-task-id column either.
- **paid** (donation/channel_points): `recordWindowOpened` (`record.ts:413-435`) records donor/amount/duration for the WINDOW open event, not the specific instruction later submitted through `submitDuringWindow` (`src/pipeline/paid-window.ts:48-77`) — that submission only produces a `gate_decision` row (same `taskId: null` gap as above).

### Runtime provenance never reaches build-completion today
`src/shared/types.ts:198-211`, `BuildStatusView.source` is documented as driving the overlay provenance chip, "optional so existing Phase 3 producers ... stay valid; Wave 2/4 supplies it." But `src/orchestrator/build-session.ts:315` never sets it:
```typescript
const view: BuildStatusView = { taskId: task.id, title: task.text, stage };
```
And none of `main.ts`'s three drivers (`onWinnerQueued` line 914, `driveWindowBuild` line 931, `driveChaosBuild` line 969) pass provenance into `buildSession.startBuild(task)` — the `QueuedTask` type itself has no provenance field. Confirmed dead-code-in-production by grep: `bs.source` is read in `overlay.js:332` but no production write site sets it (only test fixtures do, e.g. `operator-console/server.test.ts:302`).

---

## Pattern Assignments

### `src/audit/schema.sql` (model, CRUD) — add `build_history` table

**Analog:** same file, `control_windows` table (lines 109-120) — closest existing example of "one row per completed lifecycle event, durable, queried newest-first."

**Pattern to copy** (lines 109-120):
```sql
CREATE TABLE IF NOT EXISTS control_windows (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type     TEXT NOT NULL,
  donor_identifier TEXT NOT NULL,
  amount_or_cost   REAL NOT NULL,
  duration_ms      INTEGER NOT NULL,
  opened_at_ms     INTEGER NOT NULL,
  ends_at_ms       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  closed_at_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_control_windows_status ON control_windows(status);
```
Shape it into (suggested — planner's discretion on exact column names per D-01's "Claude's Discretion"):
```sql
CREATE TABLE IF NOT EXISTS build_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL,
  title           TEXT NOT NULL,        -- gate-APPROVED text only (D-03) — task.text, never raw chat
  provenance      TEXT NOT NULL,        -- 'vote' | 'donation' | 'channel_points' | 'chaos'
  result          TEXT NOT NULL,        -- 'built' | 'refused' | 'failed'
  created_at_ms   INTEGER NOT NULL      -- build-completion time; stream-night derived from this on read
);
CREATE INDEX IF NOT EXISTS idx_build_history_created_at ON build_history(created_at_ms);
```
Follows the file's own append-only doctrine (top-of-file comment, lines 1-6): this is a second append-only table alongside `audit_log`, not a mutable one — no `DELETE`/`UPDATE` path should be added (mirrors `record.ts`'s INSERT/SELECT-only discipline, lines 11-17).

---

### `src/audit/record.ts` (service, CRUD) — add `recordBuildHistory` + `listBuildHistory`

**Analog:** `recordChaosPick` (insert shape, lines 528-544) + `listAuditRecords` (query shape, lines 546-570), same file.

**Insert pattern to copy** (lines 528-544):
```typescript
export function recordChaosPick(
  db: Database.Database,
  args: { taskId: string; title: string; streamMode: StreamMode },
): void {
  insert(db, {
    createdAtMs: Date.now(),
    eventType: "chaos_pick",
    source: "chaos",
    twitchUsername: null,
    suggestionText: args.title,
    decision: null,
    category: null,
    rationale: "Uniform-random pick from the gate-filtered pool (CHAOS-01)",
    streamMode: args.streamMode,
    taskId: args.taskId,
  });
}
```
Note: `recordBuildHistory` writes to the NEW `build_history` table, not `audit_log` — it needs its own small `db.prepare(...).run(...)` (mirrors the top-of-file `insert()` helper's shape at lines 33-57 but against the new table) rather than reusing the `audit_log`-shaped `insert()` helper verbatim.

**Query pattern to copy** (lines 546-570):
```typescript
export function listAuditRecords(
  db: Database.Database,
  args: { limit: number; eventType?: string; decision?: string; sinceMs?: number },
): AuditRecord[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: args.limit };
  if (args.eventType !== undefined) {
    clauses.push("event_type = @eventType");
    params.eventType = args.eventType;
  }
  // ...
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at_ms DESC, id DESC LIMIT @limit`)
    .all(params);
  return rows as AuditRecord[];
}
```
`listBuildHistory` should copy this exact `ORDER BY created_at_ms DESC, id DESC LIMIT @limit` reverse-chronological + pagination shape (D-02, D-04's "paginated or scroll-capped") against `build_history`.

---

### `src/orchestrator/build-session.ts` (orchestrator hook, event-driven) — call the recorder at `finalize()`

**Analog:** the file's own `finalize()` (lines 342-360) already writes the terminal `pipeline_stage` audit row via `emitStage()`; add the `recordBuildHistory` call alongside it, guarded the same way (`auditIfOpen`, lines 305-311) since `finalize()` can run during shutdown drain (WR-05, `close()` lines 895-910).

**Core pattern to copy** (lines 342-360, the terminal-completion hook point):
```typescript
function finalize(
  task: QueuedTask,
  stage: "done" | "failed" | "refused",
  summary?: string,
): void {
  emitStage(task, stage, summary);   // <-- writes pipeline_stage; add recordBuildHistory here too
  current = null;
  active = null;
  try {
    if (deps.machine.mode === "BUILD_IN_PROGRESS") {
      deps.machine.transition("IDLE");
    }
    deps.machine.setActiveTask(null, null);
  } catch (err) {
    deps.logger?.error({ err, taskId: task.id }, "failed to return machine to IDLE after build");
  }
  deps.registry.unregister(task.id);
  deps.taskQueue.remove(task.id);
}
```
Map `stage` → `result`: `"done"` → `"built"`, `"failed"` → `"failed"`, `"refused"` → `"refused"` (D-01's vocabulary). Do **NOT** add this call to `finalizeAborted()` (lines 377-406) — its own doc comment explicitly states an abort "is NEITHER a success NOR a narrated failure" and must never register as a completed build (CR-01), so it must never produce a changelog row either.

**Provenance threading:** `BuildSessionDeps`/`startBuild(task: QueuedTask)` currently carries no provenance. Recommend adding an optional `provenance` param to `startBuild()` (defaulting to `"vote"` to match the existing `overlay.js:332` fallback convention: `const source = bs.source ?? "vote"`), supplied by `main.ts`'s three call sites (see next section).

---

### `src/main.ts` (wiring, event-driven) — pass provenance at the 3 build-trigger sites

**Analog:** the file's own three drivers, already differentiated by trigger context.

**Pattern to copy** (lines 914-923, 931-963, 969-990 — each already knows its own provenance contextually):
```typescript
onWinnerQueued = (taskId) => {
  const task = taskQueue.list().find((t) => t.id === taskId);
  if (!task) return;
  // ...
  void buildSession.startBuild(task);   // <-- add: , "vote"
};

driveWindowBuild = (taskId) => {
  // ...
  void (async () => {
    await buildSession.startBuild(task);   // <-- add: , controlWindow.snapshot()?.trigger ?? "donation"
    // ...
```
`driveChaosBuild` (line 979) → pass `"chaos"`. `driveWindowBuild` should read the trigger off the live `ControlWindowSnapshot` (`trigger: WindowTrigger` field already exists, `shared/types.ts:164-172`) rather than hardcoding — this distinguishes `donation` vs `channel_points` for free.

---

### `src/changelog/server.ts` (new, route, request-response)

**Analog:** `src/preview/server.ts` (full file, 111 lines) — the closest existing "third localhost surface": loopback-bound, read-only by construction, no ws.

**Full structural pattern to copy** (lines 1-110 of `preview/server.ts`):
```typescript
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import { isLoopbackHostHeader } from "../shared/loopback.js";

export function startPreviewServer(deps: PreviewServerDeps): Promise<PreviewServerHandle> {
  const app = express();

  // DNS-rebinding defense (T-03-18) — FIRST middleware, all methods:
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.get("host"))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir, { index: "preview.html" }));

  // The ONLY dynamic route — a thin, narrow-projection GET.
  app.get("/api/reachable", async (_req, res) => {
    // ...
    res.json({ reachable, url: devServerUrl });
  });

  const server = createServer(app);
  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {   // <-- never change this host arg
      // ...
      resolve({ server, port: boundPort, close: () => /* closeAllConnections + server.close */ });
    });
  });
}
```
Add ONE dynamic route mirroring the console's `/api/audit` query-validation pattern (see below) instead of `/api/reachable` — `GET /api/history` returning `listBuildHistory(db, { limit, beforeMs? })`. **No `express.json()`, no POST/PUT/DELETE/PATCH** — read-only by construction is the load-bearing control (D-04), exactly as `preview/server.ts`'s own doc comment states (lines 22-25).

**Query-validation pattern to copy** (from `src/operator-console/server.ts` lines 215-219, 782-795 — the existing paginated audit-query precedent):
```typescript
const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().min(1).max(64).optional(),
  decision: z.string().min(1).max(64).optional(),
});

app.get("/api/audit", (req, res) => {
  const parsed = AuditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid audit query" });
    return;
  }
  res.json(listAuditRecords(db, { limit: parsed.data.limit, /* ... */ }));
});
```
Shape a `ChangelogQuerySchema` (`limit`, optional `beforeMs` cursor for pagination/scroll-cap per D-04) the same way.

**No-ws note (D-04 "served read-only page"):** unlike `overlay/server.ts`'s `WebSocketServer` (lines 262-333), the changelog does NOT need push — it's a browsable historical list, not a live state surface. Follow `preview/server.ts`'s zero-ws precedent, not `overlay/server.ts`'s.

---

### `src/changelog/public/changelog.html` + `changelog.js` (component, request-response)

**Analog (HTML shell):** `src/preview/public/preview.html` (full file) — static shell + one `<script src="...">`, comment stating what's dynamic vs. static, no inline JS/handlers.

**Analog (list-rendering JS pattern):** `src/operator-console/public/console.js` `renderRound()`'s candidate list (lines 308-330):
```javascript
const list = el("ol", "round-candidates");
entries.forEach((entry) => {
  const item = el("li", "round-candidate");
  item.appendChild(el("span", "round-candidate-text", entry.candidate.text));
  item.appendChild(el("span", "round-votes", `${entry.votes} votes`));
  list.appendChild(item);
});
roundPanel.appendChild(list);
```
This is the closest existing "render an array of records as a DOM list" pattern in the codebase (the overlay is panel/singleton-based, not list-based) — use it as the shape for rendering `build_history` rows (one `<li>` per entry: title span, provenance-chip span, result-pill span, timestamp span), grouped under stream-night `<h2>` headers.

**Analog (dom-safety helpers — MANDATORY, D-03):** `src/overlay/public/overlay.js` lines 85-96:
```javascript
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;   // textContent ONLY — never innerHTML
  return node;
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
```
This file is auto-covered by `tests/invariants/dom-safety.test.ts` (confirmed: the scan discovers ALL `src/**/public/*.js` files without hardcoding names, `dom-safety.test.ts` lines 26-30) — `changelog.js` will be picked up automatically once created under `src/changelog/public/`. **No action needed to register it with the invariant test**; just follow the `textContent`-only discipline (never `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval`) or the invariant test fails the build.

**Provenance chip vocabulary to reuse (D-05):** `src/overlay/public/overlay.js` lines 327-337:
```javascript
const source = bs.source ?? "vote";
if (source === "donation" || source === "channel_points") {
  header.appendChild(el("span", "provenance-chip chip-freereign", "FREE REIGN"));
} else if (source === "chaos") {
  header.appendChild(el("span", "provenance-chip chip-chaos", "CHAOS PICK"));
}
```
Reuse the same three-way `vote` (no chip) / `donation`+`channel_points` (FREE REIGN, violet) / `chaos` (CHAOS PICK, neutral) vocabulary and CSS class names for visual consistency with the overlay (D-05 explicitly says "reusing the Phase-4 provenance vocabulary").

---

## Shared Patterns

### Loopback-only, read-only served surface (D-04)
**Source:** `src/preview/server.ts` (whole-file precedent), `src/shared/loopback.ts` (`isLoopbackHostHeader`)
**Apply to:** `src/changelog/server.ts`
```typescript
app.use((req, res, next) => {
  if (!isLoopbackHostHeader(req.get("host"))) {
    res.status(403).json({ error: "forbidden host" });
    return;
  }
  next();
});
// ...
server.listen(deps.port, "127.0.0.1", () => { /* never change this host arg */ });
```

### DOM-safety / textContent-only (D-03, machine-checked)
**Source:** `src/overlay/public/overlay.js` lines 85-96; enforced by `tests/invariants/dom-safety.test.ts`
**Apply to:** `src/changelog/public/changelog.js` — automatic coverage, zero registration needed, but the file must contain zero `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval(`.

### Never-broadcast-pre-gate-text (D-03, compliance-critical)
**Source:** COMP-01 single-funnel discipline (`src/compliance/gate.ts`, `toQueuedTask()` throw-on-non-approved, lines 130-138) + the whole ledger's append-only design
**Apply to:** `recordBuildHistory` call site — it MUST only ever be called with `task.text` from an already-branded `QueuedTask` (never raw `SuggestionCandidate.text` pre-gate, never a `rejected`/`held-for-review` candidate's text). Since the only place `finalize()` is called is inside `runPipeline()`/`runBuildAttempt()` operating on an already-`QueuedTask`-typed `task`, this is naturally satisfied — just don't introduce a new call site that bypasses the branded type.

### Append-only ledger discipline
**Source:** `src/audit/record.ts` lines 11-17 (module doc) + `src/audit/db.ts` lines 12-14 + the `record.ts` self-test at `record.test.ts:262-266` (`expect(source).not.toMatch(/UPDATE|DELETE/i)`)
**Apply to:** `build_history` — INSERT + SELECT only, no UPDATE/DELETE path, mirroring `audit_log`'s compliance-record-of-truth discipline. If Phase 5's planner adds a `record.ts`-adjacent module (or extends `record.ts` itself), expect the same self-test grep discipline to apply.

### Reverse-chronological, paginated query (D-02, D-04)
**Source:** `src/audit/record.ts` `listAuditRecords` (546-570); query-param validation from `src/operator-console/server.ts` `AuditQuerySchema` (215-219)
**Apply to:** `listBuildHistory` (record.ts) + `ChangelogQuerySchema` (changelog/server.ts) — `ORDER BY created_at_ms DESC, id DESC LIMIT @limit`, zod `z.coerce.number().int().min(1).max(N).default(...)` for the limit/cursor.

### Runbook + GO/NO-GO verdict artifact shape (D-06)
**Source:** `.planning/phases/04-paid-influence-chaos-mode/04-08-PLAN.md` (full file) — the `04-LIVE-GATE.md` artifact it produces, plus its own task structure
**Apply to:** the Phase 5 dry-run plan/runbook. Concrete shape to copy:
- A `<task type="auto">` that writes a runbook doc with an **empty PENDING verdict block at the top**.
- Numbered sections matching each precondition/exercised surface (mirrors 04-08's 4 sections: account/scope setup → smoke test → compliance re-read).
- A `<task type="checkpoint:human-action" gate="blocking">` for irreversible/external setup steps (here: confirming Phase-3 Wave-0 WSL2 GO is recorded, StreamElements/redemption live binding is set up — D-06's stated preconditions).
- A `<task type="checkpoint:human-verify" gate="blocking">` that walks the reviewer through the FULL end-to-end loop (suggest→filter→vote→build→preview, a real donation window, a chaos round, kill-switch-against-in-progress-build, and the audit-log review for zero-unfiltered-input + every-rejection-has-chat-feedback) and ends with `resume-signal: "GO"` or `"NO-GO: <failing check>"`.
- `docs/OPERATIONS.md` gets a new section (mirrors the existing `## 6. Twitch Chat Integration` structure in the current file, e.g. numbered subsections `X.1`, `X.2`...) documenting the dry-run's operational setup, in the same voice as the existing `## 1-6` sections (calm, no-red, explicit "if X fails, do Y" resolution steps — see `docs/OPERATIONS.md` lines 1-223, especially the "Known Limitation Log" table pattern at lines 99-115 for recording any dry-run anomalies).
- Plan frontmatter: `autonomous: false` (per D-06 explicitly).

## No Analog Found

None — every file in scope has a strong existing analog. The one structural gap (provenance never threaded to `startBuild()`) is not a "missing analog" but a genuine wiring gap the plan must close (see D-01 Investigation, "Runtime provenance never reaches build-completion today").

## Metadata

**Analog search scope:** `src/audit/`, `src/preview/`, `src/overlay/`, `src/operator-console/`, `src/orchestrator/`, `src/main.ts`, `src/pipeline/`, `src/compliance/gate.ts`, `src/shared/types.ts`, `tests/invariants/dom-safety.test.ts`, `docs/OPERATIONS.md`, `.planning/phases/04-paid-influence-chaos-mode/04-08-PLAN.md`
**Files scanned:** 20
**Pattern extraction date:** 2026-07-10
