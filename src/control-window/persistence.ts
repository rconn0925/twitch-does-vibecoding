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

/** Args for opening a durable window row. status defaults to 'active' when absent. */
export interface InsertWindowArgs {
  trigger: WindowTrigger;
  donorIdentifier: string;
  amountOrCost: number;
  durationMs: number;
  openedAtMs: number;
  /**
   * ABSOLUTE close time (opened + duration) — the crash-safety linchpin (D-06).
   * quick-260716-h73: PROVISIONAL for a 'pending' insert (bank time + duration);
   * promotePendingWindow rewrites it at open.
   */
  endsAtMs: number;
  /**
   * quick-260716-h73: 'pending' banks a window awaiting the return to IDLE.
   * Absent → 'active' (existing call sites/tests stay byte-compatible).
   */
  status?: WindowStatus;
}

/** Insert one window row (active by default, or a banked pending); returns its autoincrement id. */
export function insertWindow(db: Database.Database, args: InsertWindowArgs): number {
  const info = db
    .prepare(
      `INSERT INTO control_windows
         (trigger_type, donor_identifier, amount_or_cost, duration_ms, opened_at_ms, ends_at_ms, status)
       VALUES
         (@trigger, @donorIdentifier, @amountOrCost, @durationMs, @openedAtMs, @endsAtMs, @status)`,
    )
    .run({
      trigger: args.trigger,
      donorIdentifier: args.donorIdentifier,
      amountOrCost: args.amountOrCost,
      durationMs: args.durationMs,
      openedAtMs: args.openedAtMs,
      endsAtMs: args.endsAtMs,
      status: args.status ?? "active",
    });
  return Number(info.lastInsertRowid);
}

/**
 * The most-recent still-pending window row (quick-260716-h73; D-05: only one can
 * ever be banked), or undefined. The restore-on-boot pending read-back — its
 * timestamps are PROVISIONAL: the FSM re-derives the FULL duration from
 * duration_ms at promote time, never from the banked ends_at_ms.
 */
export function readPendingWindow(db: Database.Database): ControlWindowRow | undefined {
  return db
    .prepare("SELECT * FROM control_windows WHERE status = 'pending' ORDER BY id DESC LIMIT 1")
    .get() as ControlWindowRow | undefined;
}

/**
 * Promote a banked pending row to ACTIVE (quick-260716-h73): the single durable
 * pending→active transition. Rewrites opened_at_ms/ends_at_ms with the
 * promote-time clock (FULL paid duration starts at OPEN, never at bank) — after
 * this, ends_at_ms is the authoritative crash-safe deadline (D-06).
 */
export function promotePendingWindow(
  db: Database.Database,
  id: number,
  openedAtMs: number,
  endsAtMs: number,
): void {
  db.prepare(
    "UPDATE control_windows SET status = 'active', opened_at_ms = @openedAtMs, ends_at_ms = @endsAtMs WHERE id = @id",
  ).run({ openedAtMs, endsAtMs, id });
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

/** The most-recent grant time per donor (WR-03 cooldown rebuild input). */
export interface DonorLastGrant {
  donor_identifier: string;
  opened_at_ms: number;
}

/**
 * WR-03: the most recent opened_at_ms per donor across ALL windows
 * (active/expired/revoked). On restore() the FSM seeds its per-donor cooldown
 * map from this so a mid-show crash-restart never resets the D-04 anti-abuse
 * guard — a donor who just consumed a window still can't immediately open
 * another after a restart.
 */
export function readLastGrantsByDonor(db: Database.Database): DonorLastGrant[] {
  return db
    .prepare(
      "SELECT donor_identifier, MAX(opened_at_ms) AS opened_at_ms FROM control_windows GROUP BY donor_identifier",
    )
    .all() as DonorLastGrant[];
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
