import type Database from "better-sqlite3";

/**
 * 90-day rolling audit retention (D-17).
 *
 * This module holds the codebase's ONLY delete statement — the deliberate,
 * single exception to the append-only audit ledger (see src/audit/record.ts
 * and src/audit/db.ts provenance notes). The single-funnel invariant test
 * (tests/invariants/single-funnel.test.ts) asserts no other src file contains
 * a delete against the ledger, and src/main.ts is the only scheduler (at boot
 * plus an unref'd 24h interval).
 *
 * Purge is strictly time-bounded: rows are removed by created_at_ms cutoff
 * only, never by content, decision, or event type (T-01-20 — the purge must
 * not be usable as a targeted audit-destruction vector).
 */

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 3_600_000;

/** Retention window from AUDIT_RETENTION_DAYS env (default 90 days). */
export function auditRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/**
 * Remove audit rows older than the retention window. Returns the number of
 * rows removed.
 */
export function purgeOldAuditRecords(
  db: Database.Database,
  retentionDays: number = auditRetentionDays(),
): number {
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const result = db.prepare("DELETE FROM audit_log WHERE created_at_ms < ?").run(cutoff);
  return result.changes;
}
