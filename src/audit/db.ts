import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Connection factory for the audit ledger.
 *
 * Executes schema.sql idempotently (CREATE TABLE IF NOT EXISTS) on every open.
 * WAL journaling is enabled for file-backed databases only — ":memory:" databases
 * do not support WAL and are used by the test suite.
 *
 * Append-only provenance note: src/audit/record.ts exposes INSERT and SELECT
 * helpers only. The sole DELETE in the codebase lives in src/audit/purge.ts
 * (plan 01-04, 90-day rolling retention per D-17).
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  db.exec(schema);
  return db;
}
