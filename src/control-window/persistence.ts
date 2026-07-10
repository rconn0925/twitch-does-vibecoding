/**
 * Durable read/write for the `control_windows` table (D-06 crash safety).
 *
 * Mirrors the durability discipline of `rounds`/`round_candidates`: an ABSOLUTE
 * `ends_at_ms` timestamp is the single source of truth — duration is never
 * recomputed on read, so a crash can neither lose nor silently extend a paid
 * window (PAID-04). Operates on the EXISTING shared db handle (the table lives in
 * src/audit/schema.sql, loaded once at boot) — no second openDb here.
 *
 * This module exposes INSERT/SELECT/UPDATE-status only; it never imports the gate,
 * the queue, or an RNG (the paid side of the D-08 separation).
 */

import type Database from "better-sqlite3";
import type { WindowStatus, WindowTrigger } from "../shared/types.js";

/** Raw control_windows row shape (snake_case, as stored). */
export interface ControlWindowRow {
  id: number;
  trigger_type: string;
  donor_identifier: string;
  amount_or_cost: number;
  duration_ms: number;
  opened_at_ms: number;
  ends_at_ms: number;
  status: string;
  closed_at_ms: number | null;
}

/** Args for opening a durable window row. status defaults to 'active' in the schema. */
export interface InsertWindowArgs {
  trigger: WindowTrigger;
  donorIdentifier: string;
  amountOrCost: number;
  durationMs: number;
  openedAtMs: number;
  /** ABSOLUTE close time (opened + duration) — the crash-safety linchpin (D-06). */
  endsAtMs: number;
}

/** Insert one active window row; returns its autoincrement id. */
export function insertWindow(db: Database.Database, args: InsertWindowArgs): number {
  const info = db
    .prepare(
      `INSERT INTO control_windows
         (trigger_type, donor_identifier, amount_or_cost, duration_ms, opened_at_ms, ends_at_ms)
       VALUES
         (@trigger, @donorIdentifier, @amountOrCost, @durationMs, @openedAtMs, @endsAtMs)`,
    )
    .run({
      trigger: args.trigger,
      donorIdentifier: args.donorIdentifier,
      amountOrCost: args.amountOrCost,
      durationMs: args.durationMs,
      openedAtMs: args.openedAtMs,
      endsAtMs: args.endsAtMs,
    });
  return Number(info.lastInsertRowid);
}

/**
 * The most-recent still-active window row (D-05: only one can be active), or
 * undefined. The restore-on-boot read-back — `ends_at_ms` is absolute, so the
 * caller derives `remaining = ends_at_ms - now()` and never a fresh full duration.
 */
export function readActiveWindow(db: Database.Database): ControlWindowRow | undefined {
  return db
    .prepare("SELECT * FROM control_windows WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .get() as ControlWindowRow | undefined;
}

/** Close a window row with its terminal status ('expired' | 'revoked') and closed_at_ms. */
export function closeWindow(
  db: Database.Database,
  id: number,
  status: WindowStatus,
  closedAtMs: number,
): void {
  db.prepare(
    "UPDATE control_windows SET status = @status, closed_at_ms = @closedAtMs WHERE id = @id",
  ).run({ status, closedAtMs, id });
}
