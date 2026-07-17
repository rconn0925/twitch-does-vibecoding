/**
 * Review workflow tests (D-05/D-06/D-07) including the two-table integrity
 * invariant: resolutions never mutate audit_log — the original gate_decision
 * rows stay byte-identical (RESEARCH.md Pitfall 5).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import { recordGateDecision } from "../audit/record.js";
import { CandidatePool } from "../queue/pool.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import {
  approve,
  expireAllPending,
  expireOne,
  expireStale,
  insertHeld,
  listPending,
  reject,
  resolveParked,
  reviewTtlMs,
} from "./review-queue.js";

const HELD: GateResult = {
  decision: "held-for-review",
  category: "gambling",
  rationale: "play-money gray zone",
};

function makeCandidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-slot-1",
    source: "channel_points",
    kind: "suggestion",
    twitchUsername: "gray_zone_gamer",
    text: "Build a play-money slot machine simulator for chat to spin",
    submittedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function allAuditRows(db: Database.Database): unknown[] {
  return db.prepare("SELECT * FROM audit_log ORDER BY id").all();
}

function auditRowsOfType(db: Database.Database, eventType: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM audit_log WHERE event_type = ? ORDER BY id")
    .all(eventType) as Array<Record<string, unknown>>;
}

function reviewRow(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id) as Record<string, unknown>;
}

describe("review-queue workflow (D-05/06/07)", () => {
  let db: Database.Database;
  let pool: CandidatePool;

  beforeEach(() => {
    db = openDb(":memory:");
    pool = new CandidatePool();
  });

  afterEach(() => {
    db.close();
  });

  it("insertHeld persists the FULL candidate identity with status pending", () => {
    const candidate = makeCandidate();
    const id = insertHeld(db, candidate, HELD);

    const row = reviewRow(db, id);
    expect(row).toMatchObject({
      candidate_id: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      submitted_at_ms: candidate.submittedAtMs,
      suggestion_text: candidate.text,
      twitch_username: candidate.twitchUsername,
      category: "gambling",
      rationale: HELD.rationale,
      status: "pending",
    });
  });

  it("insertHeld refuses non-held results (approved/rejected never enter the review queue)", () => {
    expect(() =>
      insertHeld(db, makeCandidate(), { decision: "approved", category: null, rationale: "ok" }),
    ).toThrow(/held-for-review/);
    expect(() =>
      insertHeld(db, makeCandidate(), {
        decision: "rejected",
        category: "gambling",
        rationale: "no",
      }),
    ).toThrow(/held-for-review/);
  });

  it("approve() reconstructs the ORIGINAL candidate and re-adds it to the pool (D-06)", () => {
    const original = makeCandidate();
    const id = insertHeld(db, original, HELD);

    approve(db, { pool, streamMode: "IDLE" }, id);

    expect(reviewRow(db, id).status).toBe("approved");

    const pooled = pool.list();
    expect(pooled).toHaveLength(1);
    // Field-level equality against the pre-hold candidate — id, source, kind,
    // and submittedAtMs all preserved exactly (no lossy reconstruction).
    expect(pooled[0]?.candidate).toEqual(original);
    expect(pooled[0]?.result.decision).toBe("approved");

    const resolved = auditRowsOfType(db, "review_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      decision: "approved",
      suggestion_text: original.text,
      twitch_username: original.twitchUsername,
      task_id: String(id),
    });
  });

  it("reject() flips the row to rejected and inserts one review_resolved audit row", () => {
    const id = insertHeld(db, makeCandidate(), HELD);

    reject(db, id, "VOTING_ROUND");

    expect(reviewRow(db, id).status).toBe("rejected");
    expect(pool.list()).toHaveLength(0);

    const resolved = auditRowsOfType(db, "review_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decision: "rejected", stream_mode: "VOTING_ROUND" });
  });

  it("resolutions are terminal: approving twice (or rejecting after approve) throws", () => {
    const id = insertHeld(db, makeCandidate(), HELD);
    approve(db, { pool }, id);

    expect(() => approve(db, { pool }, id)).toThrow(/terminal/);
    expect(() => reject(db, id)).toThrow(/terminal/);
    expect(pool.list()).toHaveLength(1);
  });

  it("expireStale() expires only pending rows older than ttlMs, one review_expired row each (D-07)", () => {
    const staleId = insertHeld(db, makeCandidate({ id: "stale" }), HELD);
    // Backdate the stale row past the TTL.
    db.prepare("UPDATE review_queue SET created_at_ms = ? WHERE id = ?").run(
      Date.now() - 5 * 3_600_000,
      staleId,
    );
    const freshId = insertHeld(db, makeCandidate({ id: "fresh" }), HELD);

    const expired = expireStale(db, reviewTtlMs());

    expect(expired).toBe(1);
    expect(reviewRow(db, staleId).status).toBe("expired-unreviewed");
    expect(reviewRow(db, freshId).status).toBe("pending");

    const expiredRows = auditRowsOfType(db, "review_expired");
    expect(expiredRows).toHaveLength(1);
    expect(expiredRows[0]).toMatchObject({
      decision: "expired-unreviewed",
      task_id: String(staleId),
    });
  });

  it("expireAllPending() marks every pending row expired-unreviewed with one audit row each (D-07 start-of-session)", () => {
    const idA = insertHeld(db, makeCandidate({ id: "a" }), HELD);
    const idB = insertHeld(db, makeCandidate({ id: "b" }), HELD);
    const approvedId = insertHeld(db, makeCandidate({ id: "c" }), HELD);
    approve(db, { pool }, approvedId);

    const expired = expireAllPending(db);

    expect(expired).toBe(2);
    expect(reviewRow(db, idA).status).toBe("expired-unreviewed");
    expect(reviewRow(db, idB).status).toBe("expired-unreviewed");
    expect(reviewRow(db, approvedId).status).toBe("approved");
    expect(auditRowsOfType(db, "review_expired")).toHaveLength(2);
    expect(listPending(db)).toHaveLength(0);
  });

  it("listPending() returns only pending items, oldest first, with full identity", () => {
    const candidate = makeCandidate();
    const id = insertHeld(db, candidate, HELD);
    const rejectedId = insertHeld(db, makeCandidate({ id: "gone" }), HELD);
    reject(db, rejectedId);

    const pending = listPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      candidateId: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      submittedAtMs: candidate.submittedAtMs,
      text: candidate.text,
      twitchUsername: candidate.twitchUsername,
      category: "gambling",
    });
  });

  it("reviewTtlMs() defaults to 4h and honors REVIEW_TTL_HOURS", () => {
    const prior = process.env.REVIEW_TTL_HOURS;
    try {
      delete process.env.REVIEW_TTL_HOURS;
      expect(reviewTtlMs()).toBe(4 * 3_600_000);
      process.env.REVIEW_TTL_HOURS = "2";
      expect(reviewTtlMs()).toBe(2 * 3_600_000);
      process.env.REVIEW_TTL_HOURS = "not-a-number";
      expect(reviewTtlMs()).toBe(4 * 3_600_000);
    } finally {
      if (prior === undefined) {
        delete process.env.REVIEW_TTL_HOURS;
      } else {
        process.env.REVIEW_TTL_HOURS = prior;
      }
    }
  });

  // ── quick-260717-2gr parked-build resolvers (D-08) ─────────────────────────

  it("resolveParked('approved') resolves the row + ONE review_resolved audit row WITHOUT touching the pool", () => {
    const candidate = makeCandidate();
    const id = insertHeld(db, candidate, HELD);

    const resolved = resolveParked(db, id, "approved", "IDLE");

    expect(resolved).toBe(true);
    expect(reviewRow(db, id).status).toBe("approved");
    // The parked build's continuation goes through dispatchBuild — the intake
    // pool is NEVER touched (the whole point vs approve()).
    expect(pool.list()).toHaveLength(0);
    const rows = auditRowsOfType(db, "review_resolved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: "approved",
      suggestion_text: candidate.text,
      task_id: String(id),
    });
  });

  it("resolveParked('rejected') carries the optional reason tag onto the audit row", () => {
    const id = insertHeld(db, makeCandidate(), HELD);

    const resolved = resolveParked(db, id, "rejected", "BUILD_IN_PROGRESS", "tos-risk");

    expect(resolved).toBe(true);
    expect(reviewRow(db, id).status).toBe("rejected");
    const rows = auditRowsOfType(db, "review_resolved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: "rejected",
      category: "tos-risk",
      stream_mode: "BUILD_IN_PROGRESS",
    });
  });

  it("resolveParked is throw-free on missing/terminal rows: returns false, writes NOTHING", () => {
    expect(resolveParked(db, 9_999, "approved")).toBe(false);
    const id = insertHeld(db, makeCandidate(), HELD);
    reject(db, id);
    const before = allAuditRows(db).length;
    expect(resolveParked(db, id, "approved")).toBe(false);
    expect(allAuditRows(db).length).toBe(before);
    expect(reviewRow(db, id).status).toBe("rejected");
  });

  it("expireOne() resolves ONE pending row as expired-unreviewed + review_expired audit row; idempotent (false when not pending)", () => {
    const candidate = makeCandidate();
    const id = insertHeld(db, candidate, HELD);

    expect(expireOne(db, id, "IDLE")).toBe(true);
    expect(reviewRow(db, id).status).toBe("expired-unreviewed");
    const rows = auditRowsOfType(db, "review_expired");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: "expired-unreviewed",
      suggestion_text: candidate.text,
      task_id: String(id),
    });

    // Second fire (the timer raced a resolution): false, no extra rows.
    expect(expireOne(db, id, "IDLE")).toBe(false);
    expect(auditRowsOfType(db, "review_expired")).toHaveLength(1);
    // Missing row: false, throw-free.
    expect(expireOne(db, 12_345, "IDLE")).toBe(false);
  });

  it("expireOne() loses the race against resolveParked cleanly (terminal stays terminal)", () => {
    const id = insertHeld(db, makeCandidate(), HELD);
    expect(resolveParked(db, id, "approved")).toBe(true);
    expect(expireOne(db, id)).toBe(false);
    expect(reviewRow(db, id).status).toBe("approved");
    expect(auditRowsOfType(db, "review_expired")).toHaveLength(0);
  });

  it("two-table integrity: original gate_decision audit rows are byte-identical after approve/reject/expire", () => {
    // Simulate the gate writing the original held decisions.
    const candidates = [
      makeCandidate({ id: "int-a" }),
      makeCandidate({ id: "int-b" }),
      makeCandidate({ id: "int-c" }),
    ];
    const ids: number[] = [];
    for (const candidate of candidates) {
      recordGateDecision(db, {
        candidate,
        decision: "held-for-review",
        category: "gambling",
        rationale: HELD.rationale,
        streamMode: "IDLE",
      });
      ids.push(insertHeld(db, candidate, HELD));
    }
    const before = JSON.stringify(auditRowsOfType(db, "gate_decision"));
    const totalBefore = allAuditRows(db).length;

    approve(db, { pool }, ids[0] as number);
    reject(db, ids[1] as number);
    expireAllPending(db);

    // Original decision rows untouched; resolutions arrived as NEW rows only.
    expect(JSON.stringify(auditRowsOfType(db, "gate_decision"))).toBe(before);
    expect(allAuditRows(db).length).toBe(totalBefore + 3);
  });
});
