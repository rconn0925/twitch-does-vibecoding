import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import express from "express";
import type { Logger } from "pino";
import { z } from "zod";
import { listBuildHistory } from "../audit/record.js";
import { isLoopbackHostHeader } from "../shared/loopback.js";
import type { BuildHistoryRow, BuildResult } from "../shared/types.js";

/**
 * Audience-facing build-history changelog server (HIST-01 / 05-02) — the FOURTH
 * localhost surface, alongside the operator console, public overlay, and
 * app-under-construction preview. It renders the durable build_history table
 * (05-01) as a reverse-chronological, night-grouped, screen-shareable changelog:
 * "the audience built this together."
 *
 * Read-only by construction (D-04, T-05-07): copied wholesale from
 * preview/server.ts — the isLoopbackHostHeader 403 guard is the FIRST middleware
 * (DNS-rebinding defense), express.static serves the shell, and the listen host
 * is pinned to 127.0.0.1. There is NO express.json(), NO POST/PUT/DELETE/PATCH,
 * and NO WebSocketServer. The ONLY dynamic route is GET /api/history.
 *
 * Coarse public projection (D-03/D-04, T-05-05): the wire carries ONLY
 * { buildId, title, provenance(coarsened vote|paid|chaos), result, timeLabel }
 * grouped into nights. The 4-value DB provenance collapses at THIS boundary
 * (donation|channel_points → paid), and donor identity, amount, trigger-type,
 * rationale, category, and every host internal are never selected into the
 * response. The page reads SOLELY build_history — gate-approved records with
 * honest outcomes (D-03) — never pre-gate audit_log text.
 */

/** The coarse 3-value public provenance projection (D-01 vocabulary). */
export type PublicProvenance = "vote" | "paid" | "chaos";

/** One changelog entry on the public wire — the coarse projection, nothing more. */
export interface HistoryEntry {
  buildId: string;
  title: string;
  provenance: PublicProvenance;
  result: BuildResult;
  /** Server-formatted "9:42 PM" — no client timezone/date math. */
  timeLabel: string;
}

/** One stream-night group: a calendar-day bucket of entries, newest-first. */
export interface HistoryNight {
  /** Opaque day key, e.g. "2026-07-08" — the pagination cursor. */
  nightKey: string;
  /** Server-formatted display, e.g. "Tuesday, July 8, 2026". */
  nightLabel: string;
  entries: HistoryEntry[];
  /** Server-pluralized total for the night, e.g. "3 builds" / "1 build". */
  entryCountLabel: string;
  /** Present only when the night overflowed the 50-entry defensive cap. */
  overflowCount?: number;
}

/** The paginated changelog payload (full-state-on-load, adapted to plain GET). */
export interface HistoryPage {
  nights: HistoryNight[];
  /** True when a further ?before= call would return more (older) nights. */
  hasOlder: boolean;
}

export interface HistoryServerDeps {
  /** The audit ledger connection — read-only here (SELECT via listBuildHistory). */
  db: Database.Database;
  /** Listen port for THIS surface (its own port, separate from the others). */
  port: number;
  logger?: Logger;
}

export interface HistoryServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Nights per page (D-04 auto-selected page size). */
const DEFAULT_NIGHTS_PER_PAGE = 10;
/** Defensive per-night entry cap (D-04): a night beyond this renders 50 + overflow. */
const MAX_ENTRIES_PER_NIGHT = 50;
/**
 * Generous row cap for one page fetch (D-04 acceptable-for-v1). We over-fetch
 * newest-first, bucket into nights, then slice to `limit` nights. A single
 * single-streamer night is far below this ceiling, so one page always sees
 * enough rows to fill its nights AND peek at the (limit+1)th for hasOlder.
 */
const ROW_CAP = 2000;

/**
 * Query contract for GET /api/history (operator-console AuditQuerySchema
 * precedent): a bounded nights-per-page limit and an optional YYYY-MM-DD night
 * cursor. safeParse failure → 400, never a leaked stack (T-01-03 discipline).
 */
const ChangelogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_ENTRIES_PER_NIGHT).default(DEFAULT_NIGHTS_PER_PAGE),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Coarsen the 4-value DB provenance to the 3-value public projection (T-05-05). */
function coarsenProvenance(provenance: BuildHistoryRow["provenance"]): PublicProvenance {
  if (provenance === "donation" || provenance === "channel_points") return "paid";
  return provenance;
}

/** Local-calendar-day key (YYYY-MM-DD) — the stream-night bucket, derived on read (D-02). */
function nightKeyOf(createdAtMs: number): string {
  const dt = new Date(createdAtMs);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local midnight (ms) at the START of a YYYY-MM-DD night key. */
function startOfNightMs(nightKey: string): number {
  const [year, month, day] = nightKey.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).getTime();
}

/** Server-formatted human night label, e.g. "Tuesday, July 8, 2026". */
function nightLabelOf(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Server-formatted time-of-day label, e.g. "9:42 PM". */
function timeLabelOf(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Server-side plural (avoids client pluralization logic). */
function entryCountLabelOf(count: number): string {
  return `${count} ${count === 1 ? "build" : "builds"}`;
}

/**
 * Build one page of night-grouped history from build_history. Rows arrive
 * newest-first (created_at_ms DESC); we bucket into ordered nights, take up to
 * `limit`, coarsen each entry's provenance, and drop everything else. `hasOlder`
 * is true when the fetched data contains at least one night beyond the returned
 * set (or, defensively, when the row cap was saturated — there may be more).
 */
function buildHistoryPage(rows: BuildHistoryRow[], limit: number, capHit: boolean): HistoryPage {
  const nightOrder: string[] = [];
  const byNight = new Map<string, BuildHistoryRow[]>();
  for (const row of rows) {
    const key = nightKeyOf(row.createdAtMs);
    let bucket = byNight.get(key);
    if (!bucket) {
      bucket = [];
      byNight.set(key, bucket);
      nightOrder.push(key);
    }
    bucket.push(row);
  }

  const pageKeys = nightOrder.slice(0, limit);
  const nights: HistoryNight[] = pageKeys.map((key) => {
    const bucket = byNight.get(key) ?? [];
    const total = bucket.length;
    const shown = bucket.slice(0, MAX_ENTRIES_PER_NIGHT);
    const entries: HistoryEntry[] = shown.map((row) => ({
      buildId: String(row.id),
      title: row.title,
      provenance: coarsenProvenance(row.provenance),
      result: row.result,
      timeLabel: timeLabelOf(row.createdAtMs),
    }));
    const night: HistoryNight = {
      nightKey: key,
      nightLabel: nightLabelOf(bucket[0]?.createdAtMs ?? startOfNightMs(key)),
      entries,
      entryCountLabel: entryCountLabelOf(total),
    };
    if (total > MAX_ENTRIES_PER_NIGHT) night.overflowCount = total - MAX_ENTRIES_PER_NIGHT;
    return night;
  });

  // More nights than one page holds → definitely older nights remain. Otherwise,
  // a saturated row cap means we may not have fetched far enough to be sure.
  const hasOlder = nightOrder.length > limit || (capHit && nightOrder.length >= limit);
  return { nights, hasOlder };
}

/**
 * Start the read-only history server. Same bootstrap/teardown shape as the
 * preview server (its verified precedent), minus the WebSocketServer entirely.
 *
 * The explicit "127.0.0.1" listen host is deliberate: the changelog is reachable
 * by the local browser/OBS source only (D-04). Never change the host argument.
 */
export function startHistoryServer(deps: HistoryServerDeps): Promise<HistoryServerHandle> {
  const { db, logger } = deps;
  const app = express();

  // ── DNS-rebinding defense (T-05-07, shared with console/overlay/preview) ──
  // FIRST middleware, all methods: the Host header must name a loopback host.
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.get("host"))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  // The changelog page is history.html (not index.html): serve it at "/" so a
  // dedicated browser tab / OBS source can point at the bare origin.
  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir, { index: "history.html" }));

  // The ONLY dynamic route: a bounded, validated, read-only paginated GET. It
  // coarsens provenance and drops every donor/financial/trigger/host field at
  // this boundary (T-05-05). No express.json(), no mutating method — read-only
  // by construction (D-04, T-05-07).
  app.get("/api/history", (req, res) => {
    const parsed = ChangelogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid history query" });
      return;
    }
    const { limit, before } = parsed.data;
    // Nights strictly older than the `before` day = rows before its local midnight.
    const beforeMs = before !== undefined ? startOfNightMs(before) : undefined;
    const rows = listBuildHistory(db, {
      limit: ROW_CAP,
      ...(beforeMs !== undefined ? { beforeMs } : {}),
    });
    res.json(buildHistoryPage(rows, limit, rows.length >= ROW_CAP));
  });

  const server = createServer(app);

  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      logger?.info(
        { port: boundPort },
        "build-history changelog listening at http://127.0.0.1:%d",
        boundPort,
      );
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
