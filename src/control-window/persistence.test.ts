import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import { closeWindow, insertWindow, readActiveWindow } from "./persistence.js";

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
