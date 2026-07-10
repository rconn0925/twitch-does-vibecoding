import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import type { BuildProvenance, BuildResult } from "../shared/types.js";
import { type HistoryPage, type HistoryServerHandle, startHistoryServer } from "./server.js";

/**
 * History server behavior (HIST-01, 05-02): a FOURTH read-only localhost surface
 * (copied from preview/server.ts) that serves the static changelog shell and one
 * paginated GET /api/history. It reads build_history (05-01), groups rows into
 * stream-nights (local-calendar-day buckets), reverse-chronological, coarsens the
 * 4-value DB provenance to the 3-value public projection (donation|channel_points
 * → paid), and drops every donor/financial/trigger detail at the wire boundary.
 * In-memory db seeded with fake rows — the projection is asserted, not the network.
 */

/** Insert a build_history row with an EXPLICIT created_at_ms so tests control the
 *  night bucket (recordBuildHistory would stamp Date.now()). */
function seed(
  db: Database.Database,
  row: {
    taskId: string;
    title: string;
    provenance: BuildProvenance;
    result: BuildResult;
    createdAtMs: number;
  },
): void {
  db.prepare(
    `INSERT INTO build_history (task_id, title, provenance, result, created_at_ms)
     VALUES (@taskId, @title, @provenance, @result, @createdAtMs)`,
  ).run(row);
}

/** Local-midnight ms for a given Y/M/D (month is 1-based here) at an h:m time. */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

/** The server-side night key format (YYYY-MM-DD, local). */
function nightKeyOf(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const mo = String(dt.getMonth() + 1).padStart(2, "0");
  const da = String(dt.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

describe("history server (read-only, night-grouped, coarsened, paginated)", () => {
  let db: Database.Database;
  const handles: HistoryServerHandle[] = [];

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    db.close();
  });

  async function start(): Promise<HistoryServerHandle> {
    const handle = await startHistoryServer({ db, port: 0 });
    handles.push(handle);
    return handle;
  }

  async function getPage(port: number, query = ""): Promise<{ status: number; body: HistoryPage }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/history${query}`);
    return { status: res.status, body: (await res.json()) as HistoryPage };
  }

  it("serves the static changelog shell at / (200 text/html)", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("returns an empty page (nights: [], hasOlder: false) with no history", async () => {
    const handle = await start();
    const { status, body } = await getPage(handle.port);
    expect(status).toBe(200);
    expect(body).toEqual({ nights: [], hasOlder: false });
  });

  it("groups rows into stream-nights, reverse-chronological, entries newest-first", async () => {
    seed(db, {
      taskId: "t1",
      title: "older night build",
      provenance: "vote",
      result: "built",
      createdAtMs: at(2026, 7, 7, 20, 0),
    });
    seed(db, {
      taskId: "t2",
      title: "night build 8:58",
      provenance: "vote",
      result: "failed",
      createdAtMs: at(2026, 7, 8, 20, 58),
    });
    seed(db, {
      taskId: "t3",
      title: "night build 9:42",
      provenance: "chaos",
      result: "built",
      createdAtMs: at(2026, 7, 8, 21, 42),
    });
    const handle = await start();
    const { body } = await getPage(handle.port);

    expect(body.nights.map((n) => n.nightKey)).toEqual(["2026-07-08", "2026-07-07"]);
    const first = body.nights[0];
    // Newest-first within the night: 9:42 PM before 8:58 PM.
    expect(first?.entries.map((e) => e.title)).toEqual(["night build 9:42", "night build 8:58"]);
    expect(first?.entryCountLabel).toBe("2 builds");
    expect(body.nights[1]?.entryCountLabel).toBe("1 build");
  });

  it("coarsens provenance at the wire boundary: donation|channel_points → paid; vote/chaos pass through", async () => {
    seed(db, {
      taskId: "v",
      title: "vote build",
      provenance: "vote",
      result: "built",
      createdAtMs: at(2026, 7, 8, 9, 0),
    });
    seed(db, {
      taskId: "d",
      title: "donation build",
      provenance: "donation",
      result: "built",
      createdAtMs: at(2026, 7, 8, 9, 1),
    });
    seed(db, {
      taskId: "c",
      title: "points build",
      provenance: "channel_points",
      result: "built",
      createdAtMs: at(2026, 7, 8, 9, 2),
    });
    seed(db, {
      taskId: "x",
      title: "chaos build",
      provenance: "chaos",
      result: "built",
      createdAtMs: at(2026, 7, 8, 9, 3),
    });
    const handle = await start();
    const { body } = await getPage(handle.port);

    const byTitle = new Map(body.nights[0]?.entries.map((e) => [e.title, e.provenance]));
    expect(byTitle.get("vote build")).toBe("vote");
    expect(byTitle.get("donation build")).toBe("paid");
    expect(byTitle.get("points build")).toBe("paid");
    expect(byTitle.get("chaos build")).toBe("chaos");
    // The 3-value public projection is the ONLY provenance vocabulary on the wire.
    for (const entry of body.nights[0]?.entries ?? []) {
      expect(["vote", "paid", "chaos"]).toContain(entry.provenance);
    }
  });

  it("carries ONLY the coarse HistoryEntry fields — no donor/amount/trigger/rationale/category leak", async () => {
    seed(db, {
      taskId: "task-abc-123",
      title: "a shiny new feature",
      provenance: "donation",
      result: "built",
      createdAtMs: at(2026, 7, 8, 9, 0),
    });
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/history`);
    const raw = await res.text();
    // The DB provenance VALUES never reach the wire (coarsened to 'paid').
    expect(raw).not.toContain("donation");
    expect(raw).not.toContain("channel_points");
    // No leak of the row's server-side field names/values (donor identity, amount,
    // trigger-type, rationale, category, the task id, or the raw timestamp).
    for (const forbidden of [
      "task-abc-123",
      "taskId",
      "task_id",
      "createdAtMs",
      "created_at_ms",
      "rationale",
      "category",
      "amountOrCost",
      "donorIdentifier",
    ]) {
      expect(raw, `wire must not leak "${forbidden}"`).not.toContain(forbidden);
    }
    const body = JSON.parse(raw) as HistoryPage;
    const entry = body.nights[0]?.entries[0];
    // The wire object has EXACTLY the five coarse public fields — nothing else.
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["buildId", "provenance", "result", "timeLabel", "title"].sort(),
    );
  });

  it("server-formats nightLabel, timeLabel and pluralized entryCountLabel", async () => {
    const ms = at(2026, 7, 8, 21, 42);
    seed(db, { taskId: "t", title: "one", provenance: "vote", result: "built", createdAtMs: ms });
    const handle = await start();
    const { body } = await getPage(handle.port);
    const night = body.nights[0];
    expect(night?.nightKey).toBe(nightKeyOf(ms));
    // Server-formatted strings (no client date/timezone math).
    expect(night?.nightLabel).toBe(
      new Date(ms).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    );
    expect(night?.entries[0]?.timeLabel).toBe(
      new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    );
    expect(night?.entryCountLabel).toBe("1 build");
  });

  it("paginates 10 nights per page with hasOlder and a ?before= cursor", async () => {
    // 12 distinct nights, one build each (newest = July 12, oldest = July 1).
    for (let d = 1; d <= 12; d++) {
      seed(db, {
        taskId: `t${d}`,
        title: `night ${d}`,
        provenance: "vote",
        result: "built",
        createdAtMs: at(2026, 7, d, 20, 0),
      });
    }
    const handle = await start();

    const first = await getPage(handle.port);
    expect(first.body.nights).toHaveLength(10);
    expect(first.body.hasOlder).toBe(true);
    expect(first.body.nights[0]?.nightKey).toBe("2026-07-12");
    const oldestLoaded = first.body.nights.at(-1)?.nightKey;
    expect(oldestLoaded).toBe("2026-07-03");

    const second = await getPage(handle.port, `?before=${oldestLoaded}`);
    expect(second.body.nights.map((n) => n.nightKey)).toEqual(["2026-07-02", "2026-07-01"]);
    expect(second.body.hasOlder).toBe(false);
  });

  it("respects a smaller limit and reports hasOlder", async () => {
    for (let d = 1; d <= 4; d++) {
      seed(db, {
        taskId: `t${d}`,
        title: `n${d}`,
        provenance: "vote",
        result: "built",
        createdAtMs: at(2026, 7, d, 20, 0),
      });
    }
    const handle = await start();
    const { body } = await getPage(handle.port, "?limit=2");
    expect(body.nights.map((n) => n.nightKey)).toEqual(["2026-07-04", "2026-07-03"]);
    expect(body.hasOlder).toBe(true);
  });

  it("caps a huge night at 50 entries and reports the overflow", async () => {
    for (let i = 0; i < 55; i++) {
      seed(db, {
        taskId: `t${i}`,
        title: `build ${i}`,
        provenance: "vote",
        result: "built",
        createdAtMs: at(2026, 7, 8, 12, 0) + i * 1000,
      });
    }
    const handle = await start();
    const { body } = await getPage(handle.port);
    const night = body.nights[0];
    expect(night?.entries).toHaveLength(50);
    expect(night?.overflowCount).toBe(5);
    // The count label still reflects the TRUE total that night.
    expect(night?.entryCountLabel).toBe("55 builds");
  });

  it("rejects an out-of-range limit with 400", async () => {
    const handle = await start();
    for (const q of ["?limit=0", "?limit=51", "?limit=abc"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/history${q}`);
      expect(res.status, `${q} must 400`).toBe(400);
    }
  });

  it("rejects a malformed before cursor with 400", async () => {
    const handle = await start();
    for (const q of ["?before=notadate", "?before=2026-7-8", "?before=07-08-2026"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/history${q}`);
      expect(res.status, `${q} must 400`).toBe(400);
    }
  });

  it("rejects a non-loopback Host header with 403 (DNS-rebinding defense)", async () => {
    const handle = await start();
    const http = await import("node:http");
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/api/history",
          headers: { host: `attacker.example:${handle.port}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += String(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain("nights");
  });

  it("has NO mutation routes — every POST/PUT/DELETE/PATCH 404s (read-only)", async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}`;
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/api/history", "/", "/anything"]) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "DELETE" ? undefined : "{}",
        });
        expect(res.status, `${method} ${path} must 404`).toBe(404);
      }
    }
  });

  it("binds 127.0.0.1 and close() resolves", async () => {
    const handle = await start();
    expect((handle.server.address() as AddressInfo).address).toBe("127.0.0.1");
    handles.splice(handles.indexOf(handle), 1);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("constructs NO WebSocketServer and mounts NO express.json (read-only by construction)", () => {
    const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/WebSocketServer/);
    expect(code).not.toMatch(/from "ws"/);
    expect(code).not.toMatch(/express\.json/);
  });
});
