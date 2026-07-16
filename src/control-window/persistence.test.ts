import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import {
  closeWindow,
  insertWindow,
  promotePendingWindow,
  readActiveWindow,
  readPendingWindow,
} from "./persistence.js";

function makeDb(): ReturnType<typeof openDb> {
  return openDb(":memory:");
}

describe("control_windows persistence (crash-safe CRUD)", () => {
  let db: ReturnType<typeof openDb>;
  afterEach(() => {
    db?.close();
  });

  it("insertWindow writes an absolute ends_at_ms and returns the row id", () => {
    db = makeDb();
    const id = insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "viewer_a",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000,
    });
    expect(id).toBeGreaterThan(0);
    const row = readActiveWindow(db);
    expect(row?.id).toBe(id);
    expect(row?.trigger_type).toBe("donation");
    expect(row?.donor_identifier).toBe("viewer_a");
    expect(row?.amount_or_cost).toBe(5);
    expect(row?.duration_ms).toBe(60_000);
    expect(row?.opened_at_ms).toBe(1_000);
    // ABSOLUTE timestamp is stored — not recomputed on read.
    expect(row?.ends_at_ms).toBe(61_000);
    expect(row?.status).toBe("active");
    expect(row?.closed_at_ms).toBeNull();
  });

  it("readActiveWindow returns the MOST-RECENT active row, or undefined when none", () => {
    db = makeDb();
    expect(readActiveWindow(db)).toBeUndefined();
    insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "old",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000,
    });
    const newer = insertWindow(db, {
      trigger: "channel_points",
      donorIdentifier: "new",
      amountOrCost: 1_000,
      durationMs: 30_000,
      openedAtMs: 2_000,
      endsAtMs: 32_000,
    });
    expect(readActiveWindow(db)?.id).toBe(newer);
  });

  it("closeWindow sets status + closed_at_ms and drops the row out of readActiveWindow", () => {
    db = makeDb();
    const id = insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "viewer_a",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000,
    });
    closeWindow(db, id, "expired", 61_000);
    expect(readActiveWindow(db)).toBeUndefined();
    const row = db
      .prepare("SELECT status, closed_at_ms FROM control_windows WHERE id = ?")
      .get(id) as { status: string; closed_at_ms: number | null };
    expect(row.status).toBe("expired");
    expect(row.closed_at_ms).toBe(61_000);
  });

  it("insertWindow with explicit status 'pending' round-trips through readPendingWindow, NOT readActiveWindow (quick-260716-h73)", () => {
    db = makeDb();
    const id = insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "viewer_a",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000, // PROVISIONAL (bank time + duration) — rewritten at promote
      status: "pending",
    });
    expect(id).toBeGreaterThan(0);
    // A pending row is INVISIBLE to the active-window read (snapshot()/restore active path).
    expect(readActiveWindow(db)).toBeUndefined();
    const row = readPendingWindow(db);
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("pending");
    expect(row?.duration_ms).toBe(60_000);
    expect(row?.opened_at_ms).toBe(1_000);
    expect(row?.ends_at_ms).toBe(61_000);
    expect(row?.closed_at_ms).toBeNull();
  });

  it("readPendingWindow returns undefined when no pending row exists", () => {
    db = makeDb();
    expect(readPendingWindow(db)).toBeUndefined();
    insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "viewer_a",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000,
    });
    // A default (active) insert never shows up as pending.
    expect(readPendingWindow(db)).toBeUndefined();
  });

  it("promotePendingWindow rewrites status/opened_at_ms/ends_at_ms — the pending→active durable transition", () => {
    db = makeDb();
    const id = insertWindow(db, {
      trigger: "donation",
      donorIdentifier: "viewer_a",
      amountOrCost: 5,
      durationMs: 60_000,
      openedAtMs: 1_000,
      endsAtMs: 61_000,
      status: "pending",
    });
    // Promote at t=50000: the FULL duration clock starts at OPEN, not at bank.
    promotePendingWindow(db, id, 50_000, 110_000);
    expect(readPendingWindow(db)).toBeUndefined();
    const row = readActiveWindow(db);
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("active");
    expect(row?.opened_at_ms).toBe(50_000);
    expect(row?.ends_at_ms).toBe(110_000);
    // duration_ms is untouched — the mapping result stays the ledger's truth.
    expect(row?.duration_ms).toBe(60_000);
  });

  it("insertWindow WITHOUT a status stays byte-compatible: the row lands 'active' (existing call sites unchanged)", () => {
    db = makeDb();
    insertWindow(db, {
      trigger: "channel_points",
      donorIdentifier: "redeemer",
      amountOrCost: 1_000,
      durationMs: 30_000,
      openedAtMs: 5_000,
      endsAtMs: 35_000,
    });
    expect(readActiveWindow(db)?.status).toBe("active");
  });

  it("closeWindow with 'revoked' is durable and distinguishable from expiry", () => {
    db = makeDb();
    const id = insertWindow(db, {
      trigger: "channel_points",
      donorIdentifier: "redeemer",
      amountOrCost: 1_000,
      durationMs: 30_000,
      openedAtMs: 5_000,
      endsAtMs: 35_000,
    });
    closeWindow(db, id, "revoked", 10_000);
    const row = db
      .prepare("SELECT status, closed_at_ms FROM control_windows WHERE id = ?")
      .get(id) as { status: string; closed_at_ms: number | null };
    expect(row.status).toBe("revoked");
    expect(row.closed_at_ms).toBe(10_000);
  });
});
