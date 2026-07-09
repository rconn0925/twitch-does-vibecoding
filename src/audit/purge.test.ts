import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { purgeOldAuditRecords } from "./purge.js";

// NOTE: this file deliberately never spells out the purge's SQL statement —
// the single-funnel invariant gate asserts purge.ts is the only src file
// containing that phrase (D-17 append-only exception).

const DAY_MS = 24 * 3_600_000;

let db: Database.Database;
const savedRetention = process.env.AUDIT_RETENTION_DAYS;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  if (savedRetention === undefined) {
    delete process.env.AUDIT_RETENTION_DAYS;
  } else {
    process.env.AUDIT_RETENTION_DAYS = savedRetention;
  }
});

function insertRow(ageDays: number, marker: string): void {
  db.prepare(
    `INSERT INTO audit_log
       (created_at_ms, event_type, source, twitch_username, suggestion_text,
        decision, category, rationale, stream_mode, task_id)
     VALUES (?, 'gate_decision', 'chat', NULL, ?, 'rejected', 'spam-malware', 'test', 'IDLE', NULL)`,
  ).run(Date.now() - ageDays * DAY_MS, marker);
}

function remainingMarkers(): string[] {
  const rows = db.prepare("SELECT suggestion_text FROM audit_log ORDER BY id").all() as Array<{
    suggestion_text: string;
  }>;
  return rows.map((r) => r.suggestion_text);
}

describe("purgeOldAuditRecords (D-17, 90-day rolling retention)", () => {
  it("removes rows older than 90 days, keeps newer rows, and returns the removed count", () => {
    delete process.env.AUDIT_RETENTION_DAYS;
    insertRow(100, "too-old");
    insertRow(91, "also-too-old");
    insertRow(89, "keep-me");
    insertRow(0, "fresh");

    const removed = purgeOldAuditRecords(db);

    expect(removed).toBe(2);
    expect(remainingMarkers()).toEqual(["keep-me", "fresh"]);
  });

  it("honors AUDIT_RETENTION_DAYS from the environment", () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    insertRow(2, "beyond-short-retention");
    insertRow(0, "fresh");

    const removed = purgeOldAuditRecords(db);

    expect(removed).toBe(1);
    expect(remainingMarkers()).toEqual(["fresh"]);
  });

  it("falls back to 90 days on a malformed AUDIT_RETENTION_DAYS", () => {
    process.env.AUDIT_RETENTION_DAYS = "not-a-number";
    insertRow(89, "keep-me");
    insertRow(91, "too-old");

    const removed = purgeOldAuditRecords(db);

    expect(removed).toBe(1);
    expect(remainingMarkers()).toEqual(["keep-me"]);
  });

  it("an explicit retentionDays argument overrides the environment", () => {
    process.env.AUDIT_RETENTION_DAYS = "365";
    insertRow(30, "one-month-old");

    const removed = purgeOldAuditRecords(db, 7);

    expect(removed).toBe(1);
    expect(remainingMarkers()).toEqual([]);
  });

  it("returns 0 on an empty ledger", () => {
    expect(purgeOldAuditRecords(db)).toBe(0);
  });
});
