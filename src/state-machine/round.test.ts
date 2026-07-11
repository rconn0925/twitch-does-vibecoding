import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { CandidatePool } from "../queue/pool.js";
import { ROUND_CLOSED, ROUND_OPENED, VOTE_RECORDED } from "../shared/events.js";
import type {
  GateResult,
  HaltContext,
  RoundSnapshot,
  SuggestionCandidate,
} from "../shared/types.js";
import type { EnqueueWinnerResult } from "./round.js";
import { RoundManager, RoundStartError, roundDurationMs } from "./round.js";
import { StreamModeMachine } from "./stream-mode.js";

/** A typed enqueueWinner spy matching the injected three-argument contract. */
function enqueueWinnerSpy() {
  return vi.fn(
    (
      _candidate: SuggestionCandidate,
      _result: GateResult,
      _pooledAtMs: number,
    ): EnqueueWinnerResult => ({
      queued: true,
    }),
  );
}

function candidate(id: string, overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: `viewer_${id}`,
    text: `build idea ${id}`,
    submittedAtMs: 500,
    ...overrides,
  };
}

const approved: GateResult = {
  decision: "approved",
  category: null,
  rationale: "clean suggestion",
};

function haltCtx(machine: StreamModeMachine): HaltContext {
  return { source: "console", reasonTag: null, frozen: machine.snapshot() };
}

interface Harness {
  db: ReturnType<typeof openDb>;
  machine: StreamModeMachine;
  pool: CandidatePool;
  enqueueWinner: ReturnType<typeof vi.fn>;
  manager: RoundManager;
  now: () => number;
  setNow: (t: number) => void;
}

function makeHarness(opts: { candidates?: number; rng?: () => number } = {}): Harness {
  const db = openDb(":memory:");
  const machine = new StreamModeMachine();
  const pool = new CandidatePool();
  const count = opts.candidates ?? 3;
  for (let i = 1; i <= count; i++) {
    pool.add(candidate(`cand-${i}`), approved);
  }
  let t = 1_000;
  const now = (): number => t;
  const enqueueWinner = enqueueWinnerSpy();
  const manager = new RoundManager({
    db,
    machine,
    pool,
    enqueueWinner,
    now,
    rng: opts.rng,
  });
  return {
    db,
    machine,
    pool,
    enqueueWinner,
    manager,
    now,
    setNow: (next: number) => {
      t = next;
    },
  };
}

describe("roundDurationMs (D2-02 env knob)", () => {
  const saved = process.env.ROUND_DURATION_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ROUND_DURATION_SECONDS;
    else process.env.ROUND_DURATION_SECONDS = saved;
  });

  it("defaults to 60 seconds", () => {
    delete process.env.ROUND_DURATION_SECONDS;
    expect(roundDurationMs()).toBe(60_000);
  });

  it("honors ROUND_DURATION_SECONDS and rejects garbage", () => {
    process.env.ROUND_DURATION_SECONDS = "30";
    expect(roundDurationMs()).toBe(30_000);
    process.env.ROUND_DURATION_SECONDS = "not-a-number";
    expect(roundDurationMs()).toBe(60_000);
    process.env.ROUND_DURATION_SECONDS = "-5";
    expect(roundDurationMs()).toBe(60_000);
  });
});

describe("RoundManager.startRound (D2-01/D2-04)", () => {
  beforeEach(() => {
    delete process.env.ROUND_DURATION_SECONDS;
  });

  it("opens a round over 3 pooled candidates: transition, pool draw, persistence, audit, emit", () => {
    const h = makeHarness({ candidates: 4 });
    let emitted: RoundSnapshot | null = null;
    h.manager.on(ROUND_OPENED, (snap) => {
      emitted = snap as RoundSnapshot;
    });

    const snap = h.manager.startRound();

    expect(h.machine.mode).toBe("VOTING_ROUND");
    // first 3 in insertion order drawn, 4th remains
    expect(h.pool.list().map((a) => a.candidate.id)).toEqual(["cand-4"]);

    const rounds = h.db.prepare("SELECT * FROM rounds").all() as Record<string, unknown>[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("open");
    const rcs = h.db
      .prepare("SELECT * FROM round_candidates WHERE round_id = ? ORDER BY option_index")
      .all(snap.roundId) as Record<string, unknown>[];
    expect(rcs).toHaveLength(3);
    expect(rcs.map((r) => r.candidate_id)).toEqual(["cand-1", "cand-2", "cand-3"]);

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_opened" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.stream_mode).toBe("VOTING_ROUND");

    expect(emitted).not.toBeNull();
    expect((emitted as unknown as RoundSnapshot).roundId).toBe(snap.roundId);
    expect(snap.endsAtMs).toBe(snap.openedAtMs + roundDurationMs());
    expect(snap.candidates).toHaveLength(3);
    expect(snap.status).toBe("open");
    h.db.close();
  });

  it("runs with 2 pooled candidates (D2-04)", () => {
    const h = makeHarness({ candidates: 2 });
    const snap = h.manager.startRound();
    expect(snap.candidates).toHaveLength(2);
    expect(h.machine.mode).toBe("VOTING_ROUND");
    h.db.close();
  });

  it("throws pool-too-small with 1 or 0 candidates, without touching the pool", () => {
    for (const count of [0, 1]) {
      const h = makeHarness({ candidates: count });
      expect(() => h.manager.startRound()).toThrowError(RoundStartError);
      try {
        h.manager.startRound();
      } catch (err) {
        expect((err as RoundStartError).reason).toBe("pool-too-small");
      }
      expect(h.pool.list()).toHaveLength(count);
      expect(h.machine.mode).toBe("IDLE");
      h.db.close();
    }
  });

  it("throws not-idle when the machine is not IDLE, without touching the pool", () => {
    const h = makeHarness({ candidates: 3 });
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    try {
      h.manager.startRound();
      expect.unreachable("startRound should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RoundStartError);
      expect((err as RoundStartError).reason).toBe("not-idle");
    }
    expect(h.pool.list()).toHaveLength(3);
    h.db.close();
  });

  it("throws round-active while a restored frozen round is loaded, even though the machine is IDLE (CR-01)", () => {
    const h = makeHarness({ candidates: 3 });
    h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine)); // freezes + persists remainder

    // "Restart": a fresh machine boots IDLE; restore() loads the frozen round.
    const machine2 = new StreamModeMachine();
    const pool2 = new CandidatePool();
    pool2.add(candidate("cand-x"), approved);
    pool2.add(candidate("cand-y"), approved);
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: pool2,
      enqueueWinner: enqueueWinnerSpy(),
      now: () => 30_000,
    });
    manager2.restore();
    expect(manager2.snapshot()?.frozen).toBe(true);
    expect(machine2.mode).toBe("IDLE");

    // Mode is IDLE and the pool has 2 candidates — startRound must STILL
    // refuse: overwriting the loaded round would orphan its acknowledged
    // votes and strand its 'open' row (D2-14 / D-02).
    try {
      manager2.startRound();
      expect.unreachable("startRound should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RoundStartError);
      expect((err as RoundStartError).reason).toBe("round-active");
    }
    expect(manager2.snapshot()?.frozen).toBe(true);
    const open = h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE status = 'open'").get() as {
      n: number;
    };
    expect(open.n).toBe(1);
    h.db.close();
  });
});

describe("RoundManager.recordVote (CHAT-03/D2-14/D2-15)", () => {
  it("revote overwrites: one round_votes row with the later option; tally matches SQL", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();

    expect(h.manager.recordVote("111", 1)).toBe(true);
    expect(h.manager.recordVote("111", 2)).toBe(true);

    const rows = h.db
      .prepare("SELECT * FROM round_votes WHERE round_id = ? AND twitch_user_id = ?")
      .all(snap.roundId, "111") as { option_index: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.option_index).toBe(2);

    const mem = h.manager.snapshot();
    expect(mem?.candidates.find((c) => c.option === 1)?.votes).toBe(0);
    expect(mem?.candidates.find((c) => c.option === 2)?.votes).toBe(1);
    expect(mem?.totalVotes).toBe(1);

    const sqlTally = h.db
      .prepare(
        "SELECT option_index, COUNT(*) AS n FROM round_votes WHERE round_id = ? GROUP BY option_index",
      )
      .all(snap.roundId) as { option_index: number; n: number }[];
    for (const rc of mem?.candidates ?? []) {
      const sqlCount = sqlTally.find((r) => r.option_index === rc.option)?.n ?? 0;
      expect(rc.votes).toBe(sqlCount);
    }
    h.db.close();
  });

  it("persists the vote row BEFORE emitting VOTE_RECORDED (write-through, D2-14)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    let rowCountAtEmit = -1;
    h.manager.on(VOTE_RECORDED, () => {
      rowCountAtEmit = (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM round_votes WHERE round_id = ?")
          .get(snap.roundId) as { n: number }
      ).n;
    });
    h.manager.recordVote("111", 1);
    expect(rowCountAtEmit).toBe(1);
    h.db.close();
  });

  it("a no-op revote (same option) refreshes voted_at_ms but does NOT emit VOTE_RECORDED (WR-04)", () => {
    const h = makeHarness();
    h.manager.startRound();
    let emits = 0;
    h.manager.on(VOTE_RECORDED, () => {
      emits += 1;
    });

    h.setNow(2_000);
    expect(h.manager.recordVote("111", 1)).toBe(true);
    expect(emits).toBe(1);

    h.setNow(3_000);
    expect(h.manager.recordVote("111", 1)).toBe(true); // same option — no-op
    expect(emits).toBe(1); // vote spam does not ride the event path
    // …but the write-through still refreshed voted_at_ms.
    const row = h.db
      .prepare("SELECT voted_at_ms FROM round_votes WHERE twitch_user_id = '111'")
      .get() as { voted_at_ms: number };
    expect(row.voted_at_ms).toBe(3_000);

    // A REAL revote (different option) still emits.
    expect(h.manager.recordVote("111", 2)).toBe(true);
    expect(emits).toBe(2);
    h.db.close();
  });

  it("silently ignores invalid votes: bad option, no round open, wrong machine mode", () => {
    const h = makeHarness();

    // no round open yet
    expect(h.manager.recordVote("111", 1)).toBe(false);

    h.manager.startRound();
    // option out of range (3 candidates)
    expect(h.manager.recordVote("111", 4)).toBe(false);
    expect(h.manager.recordVote("111", 0)).toBe(false);

    // machine no longer VOTING_ROUND (halt) — vote refused
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    expect(h.manager.recordVote("111", 1)).toBe(false);

    const count = (h.db.prepare("SELECT COUNT(*) AS n FROM round_votes").get() as { n: number }).n;
    expect(count).toBe(0);
    h.db.close();
  });
});

describe("RoundManager.closeRound (D2-03/D2-05)", () => {
  it("clear leader: closes row, enqueues winner once with the persisted pooled_at_ms, returns losers", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 1);
    h.manager.recordVote("333", 2);

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });

    h.manager.closeRound();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBe(1);
    expect(row.tiebreak).toBe(0);

    expect(h.enqueueWinner).toHaveBeenCalledTimes(1);
    const [winCand, winResult, pooledAtMs] = h.enqueueWinner.mock.calls[0] as [
      SuggestionCandidate,
      GateResult,
      number,
    ];
    expect(winCand.id).toBe("cand-1");
    expect(winResult.decision).toBe("approved");
    const persisted = h.db
      .prepare("SELECT pooled_at_ms FROM round_candidates WHERE round_id = ? AND option_index = 1")
      .get(snap.roundId) as { pooled_at_ms: number };
    expect(pooledAtMs).toBe(persisted.pooled_at_ms);

    // losers back in the pool, winner not
    const pooledIds = h.pool.list().map((a) => a.candidate.id);
    expect(pooledIds).toContain("cand-2");
    expect(pooledIds).toContain("cand-3");
    expect(pooledIds).not.toContain("cand-1");

    expect(h.machine.mode).toBe("IDLE");

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_closed" });
    expect(audit).toHaveLength(1);
    const tally = JSON.parse(audit[0]?.rationale ?? "{}") as Record<string, number>;
    expect(tally["1"]).toBe(2);
    expect(tally["2"]).toBe(1);

    expect(closed).not.toBeNull();
    expect((closed as unknown as RoundSnapshot).tiebreak).toBe(false);
    expect((closed as unknown as RoundSnapshot).winnerOption).toBe(1);
    h.db.close();
  });

  it("after crash-restore, closeRound still passes the ORIGINAL pooled_at_ms (survives via the row)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 2);

    const persisted = h.db
      .prepare("SELECT pooled_at_ms FROM round_candidates WHERE round_id = ? AND option_index = 2")
      .get(snap.roundId) as { pooled_at_ms: number };

    // second manager on the same db, much later wall clock
    const enqueue2 = enqueueWinnerSpy();
    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueue2,
      now: () => 9_999_999,
    });
    manager2.restore();
    // ends_at_ms passed during downtime → restore() closed it immediately
    expect(enqueue2).toHaveBeenCalledTimes(1);
    const [, , pooledAtMs] = enqueue2.mock.calls[0] as [SuggestionCandidate, GateResult, number];
    expect(pooledAtMs).toBe(persisted.pooled_at_ms);
    h.db.close();
  });

  it("tie: picks only among tied leaders with the injected rng and flags tiebreak (D2-03)", () => {
    // rng → 0.99 picks the LAST tied leader; option 3 (0 votes) must never win
    const h = makeHarness({ rng: () => 0.99 });
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 2);

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });
    h.manager.closeRound();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.tiebreak).toBe(1);
    expect(row.winner_option).toBe(2); // last leader, never option 3
    expect((closed as unknown as RoundSnapshot).tiebreak).toBe(true);
    expect((closed as unknown as RoundSnapshot).winnerOption).toBe(2);
    expect(h.enqueueWinner).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it("zero votes: the EARLIEST-submitted candidate wins deterministically with shuffled submission times (D-03, quick-t5k)", () => {
    // Shuffled submittedAtMs: option 2 carries the earliest submission, so it
    // must win regardless of pool insertion order — no repool, no re-run beat.
    const db = openDb(":memory:");
    const machine = new StreamModeMachine();
    const pool = new CandidatePool();
    pool.add(candidate("cand-1", { submittedAtMs: 900 }), approved);
    pool.add(candidate("cand-2", { submittedAtMs: 300 }), approved);
    pool.add(candidate("cand-3", { submittedAtMs: 600 }), approved);
    const enqueue = enqueueWinnerSpy();
    const manager = new RoundManager({ db, machine, pool, enqueueWinner: enqueue, now: () => 1_000 });
    const snap = manager.startRound();

    manager.closeRound();

    const row = db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBe(2);
    expect(row.tiebreak).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [winCand] = enqueue.mock.calls[0] as [SuggestionCandidate];
    expect(winCand.id).toBe("cand-2");
    // Losers repool; the winner rides the SAME enqueue path as a voted winner.
    expect(
      pool
        .list()
        .map((a) => a.candidate.id)
        .sort(),
    ).toEqual(["cand-1", "cand-3"]);
    expect(machine.mode).toBe("IDLE");
    db.close();
  });

  it("zero votes with tied earliest submissions: the LOWEST option index wins (D-03 tie rule)", () => {
    const db = openDb(":memory:");
    const machine = new StreamModeMachine();
    const pool = new CandidatePool();
    pool.add(candidate("cand-1", { submittedAtMs: 700 }), approved);
    pool.add(candidate("cand-2", { submittedAtMs: 400 }), approved);
    pool.add(candidate("cand-3", { submittedAtMs: 400 }), approved);
    const enqueue = enqueueWinnerSpy();
    const manager = new RoundManager({ db, machine, pool, enqueueWinner: enqueue, now: () => 1_000 });
    const snap = manager.startRound();

    manager.closeRound();

    const row = db.prepare("SELECT winner_option FROM rounds WHERE id = ?").get(snap.roundId) as {
      winner_option: number;
    };
    // cand-2 (option 2) and cand-3 (option 3) tie at 400ms → lowest index wins.
    expect(row.winner_option).toBe(2);
    const [winCand] = enqueue.mock.calls[0] as [SuggestionCandidate];
    expect(winCand.id).toBe("cand-2");
    db.close();
  });

  it("is a no-op on a halt-frozen round — frozen rounds wait for triage (WR-01)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    expect(h.manager.snapshot()?.frozen).toBe(true);

    h.manager.closeRound();

    // Nothing moved: the round is still open+frozen, nothing was enqueued.
    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("open");
    expect(row.frozen_remaining_ms).toBe(40_000);
    expect(h.enqueueWinner).not.toHaveBeenCalled();
    expect(h.manager.snapshot()?.frozen).toBe(true);
    h.db.close();
  });

  it("repools a winner the funnel refused as 'halted' — an approved candidate is never dropped (WR-01)", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.enqueueWinner.mockReturnValue({ queued: false, reason: "halted" });

    h.manager.closeRound();

    // Winner AND losers are all back in the pool — nothing vanished.
    expect(
      h.pool
        .list()
        .map((a) => a.candidate.id)
        .sort(),
    ).toEqual(["cand-1", "cand-2", "cand-3"]);
    h.db.close();
  });

  it("does NOT repool a stale-reclassified winner — resubmit() already re-routed it (WR-01)", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.enqueueWinner.mockReturnValue({ queued: false, reason: "stale-reclassified" });

    h.manager.closeRound();

    // Only the losers repool; the winner is owned by the resubmission path.
    expect(
      h.pool
        .list()
        .map((a) => a.candidate.id)
        .sort(),
    ).toEqual(["cand-2", "cand-3"]);
    h.db.close();
  });
});

describe("RoundManager halt-freeze (D2-16)", () => {
  it("a halt mid-round freezes the timer and persists frozen_remaining_ms", () => {
    const h = makeHarness();
    const snap = h.manager.startRound(); // opened at 1000, ends at 61000
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    const mem = h.manager.snapshot();
    expect(mem?.frozen).toBe(true);
    expect(mem?.remainingMs).toBe(40_000);

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.frozen_remaining_ms).toBe(40_000);
    expect(row.status).toBe("open");
    h.db.close();
  });

  it("recoverTo VOTING_ROUND resumes with endsAtMs = now + frozen remaining", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    h.setNow(500_000);
    h.machine.recoverTo("VOTING_ROUND");

    const mem = h.manager.snapshot();
    expect(mem?.frozen).toBe(false);
    expect(mem?.remainingMs).toBeNull();
    expect(mem?.endsAtMs).toBe(540_000);
    // votes accepted again after resume
    expect(h.manager.recordVote("111", 1)).toBe(true);
    h.db.close();
  });

  it("recoverTo IDLE discards: row status 'discarded', candidates return to the pool", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });
    h.machine.recoverTo("IDLE");

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("discarded");
    expect(h.pool.list()).toHaveLength(3);
    expect(h.enqueueWinner).not.toHaveBeenCalled();
    expect((closed as unknown as RoundSnapshot).status).toBe("discarded");
    // CR-01: a triage discard writes its own audit row (COMP-05).
    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_closed" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decision).toBe("discarded");
    h.db.close();
  });
});

describe("RoundManager.restore (crash recovery, D2-14)", () => {
  it("a second manager on the same db reproduces roundId, candidates, tally, endsAtMs", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 2);

    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueueWinnerSpy(),
      now: () => 30_000, // round still live (ends at 61000)
    });
    manager2.restore();

    const restored = manager2.snapshot();
    expect(restored?.roundId).toBe(snap.roundId);
    expect(restored?.endsAtMs).toBe(snap.endsAtMs);
    expect(restored?.candidates.map((c) => c.candidate.id)).toEqual(["cand-1", "cand-2", "cand-3"]);
    expect(restored?.candidates.find((c) => c.option === 1)?.votes).toBe(1);
    expect(restored?.candidates.find((c) => c.option === 2)?.votes).toBe(1);
    expect(restored?.totalVotes).toBe(2);

    // revote by a pre-crash voter still overrides, not duplicates
    expect(manager2.recordVote("111", 3)).toBe(true);
    const rows = h.db
      .prepare("SELECT * FROM round_votes WHERE round_id = ? AND twitch_user_id = ?")
      .all(snap.roundId, "111") as { option_index: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.option_index).toBe(3);
    h.db.close();
  });

  it("a round whose ends_at_ms passed during downtime closes immediately on restore", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);

    const enqueue2 = enqueueWinnerSpy();
    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueue2,
      now: () => 100_000, // past ends_at_ms 61000
    });
    manager2.restore();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBe(1);
    expect(enqueue2).toHaveBeenCalledTimes(1);
    expect(machine2.mode).toBe("IDLE");
    h.db.close();
  });

  it("restored-frozen triage RESUME: boot re-enters HALTED, recoverTo VOTING_ROUND re-arms the frozen remainder and accepts votes (CR-01)", () => {
    const h = makeHarness();
    h.manager.startRound(); // opened at 1000, ends at 61000
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine)); // freezes 40s remainder

    // "Restart": fresh machine, restore() loads frozen, then main.ts
    // re-enters HALTED so the D-04 triage exits are reachable (CR-01).
    const machine2 = new StreamModeMachine();
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueueWinnerSpy(),
      now: () => 500_000,
    });
    manager2.restore();
    machine2.forceTransition("HALTED", haltCtx(machine2));
    expect(manager2.snapshot()?.frozen).toBe(true);

    // Triage picks Resume: the round unfreezes with endsAtMs = now + remainder.
    machine2.recoverTo("VOTING_ROUND");
    const resumed = manager2.snapshot();
    expect(resumed?.frozen).toBe(false);
    expect(resumed?.remainingMs).toBeNull();
    expect(resumed?.endsAtMs).toBe(540_000); // 500_000 + the 40s frozen remainder
    expect(manager2.recordVote("111", 1)).toBe(true);
    h.db.close();
  });

  it("restored-frozen triage DISCARD: recoverTo IDLE discards with an audit row, repools candidates, keeps votes in the ledger (CR-01)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    // "Restart": fresh machine, empty pool; boot re-enters HALTED (CR-01).
    const machine2 = new StreamModeMachine();
    const pool2 = new CandidatePool();
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: pool2,
      enqueueWinner: enqueueWinnerSpy(),
      now: () => 30_000,
    });
    manager2.restore();
    machine2.forceTransition("HALTED", haltCtx(machine2));
    let closed: RoundSnapshot | null = null;
    manager2.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });

    // Triage picks Reset to Idle: HALTED→IDLE discards the round.
    machine2.recoverTo("IDLE");

    expect(manager2.snapshot()).toBeNull();
    const row = h.db
      .prepare("SELECT status, frozen_remaining_ms FROM rounds WHERE id = ?")
      .get(snap.roundId) as { status: string; frozen_remaining_ms: number | null };
    expect(row.status).toBe("discarded");
    expect(row.frozen_remaining_ms).toBeNull();
    expect(pool2.list().map((a) => a.candidate.id)).toEqual(["cand-1", "cand-2", "cand-3"]);
    expect((closed as unknown as RoundSnapshot).status).toBe("discarded");
    expect(machine2.mode).toBe("IDLE");
    // The discard is audited (COMP-05) and the acknowledged vote survives (D-02).
    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_closed" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decision).toBe("discarded");
    const votes = h.db
      .prepare("SELECT COUNT(*) AS n FROM round_votes WHERE round_id = ?")
      .get(snap.roundId) as { n: number };
    expect(votes.n).toBe(1);
    h.db.close();
  });

  it("restores a frozen round with its persisted remaining time (D2-16)", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    const machine2 = new StreamModeMachine();
    machine2.forceTransition("HALTED", haltCtx(machine2));
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueueWinnerSpy(),
      now: () => 999_000,
    });
    manager2.restore();

    const restored = manager2.snapshot();
    expect(restored?.frozen).toBe(true);
    expect(restored?.remainingMs).toBe(40_000);
    h.db.close();
  });
});

describe("concurrent rounds (A1, quick-t5k): rounds keep cycling while a build executes", () => {
  /** Drive the harness machine to BUILD_IN_PROGRESS via the legal IDLE row. */
  function enterBuild(h: Harness): void {
    h.machine.transition("BUILD_IN_PROGRESS");
  }

  it("startRound from BUILD_IN_PROGRESS opens the round with NO mode transition", () => {
    const h = makeHarness();
    enterBuild(h);

    const snap = h.manager.startRound();

    expect(snap.status).toBe("open");
    expect(h.machine.mode).toBe("BUILD_IN_PROGRESS"); // never VOTING_ROUND
    expect(h.manager.snapshot()?.roundId).toBe(snap.roundId);
    h.db.close();
  });

  it("startRound from FREE_REIGN_WINDOW / CHAOS_MODE still throws not-idle", () => {
    for (const mode of ["FREE_REIGN_WINDOW", "CHAOS_MODE"] as const) {
      const h = makeHarness();
      h.machine.transition(mode);
      try {
        h.manager.startRound();
        expect.unreachable("startRound should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RoundStartError);
        expect((err as RoundStartError).reason).toBe("not-idle");
      }
      h.db.close();
    }
  });

  it("recordVote succeeds during a concurrent round under BUILD_IN_PROGRESS and after the build returns to IDLE mid-round", () => {
    const h = makeHarness();
    enterBuild(h);
    h.manager.startRound();

    // Vote while the build is still running (mode BUILD_IN_PROGRESS).
    expect(h.manager.recordVote("111", 1)).toBe(true);

    // The build finishes mid-vote: mode returns to IDLE, the round stays open.
    h.machine.transition("IDLE");
    expect(h.manager.recordVote("222", 2)).toBe(true);
    expect(h.manager.snapshot()?.totalVotes).toBe(2);
    h.db.close();
  });

  it("closeRound of a concurrent round: winner enqueued, mode NOT transitioned, losers repooled", () => {
    const h = makeHarness();
    enterBuild(h);
    h.manager.startRound();
    h.manager.recordVote("111", 1);

    h.manager.closeRound();

    expect(h.machine.mode).toBe("BUILD_IN_PROGRESS"); // untouched — the build owns the mode
    expect(h.enqueueWinner).toHaveBeenCalledTimes(1);
    const pooledIds = h.pool.list().map((a) => a.candidate.id);
    expect(pooledIds.sort()).toEqual(["cand-2", "cand-3"]);
    expect(h.manager.snapshot()).toBeNull();
    h.db.close();
  });
});

describe("halt during a CONCURRENT round × all three recovery targets (BLOCKER-2, quick-t5k)", () => {
  /** Open a concurrent round under BUILD_IN_PROGRESS, vote once, then halt. */
  function haltedConcurrent(): Harness {
    const h = makeHarness();
    h.machine.transition("BUILD_IN_PROGRESS");
    h.manager.startRound(); // opened at 1000, ends at 61000
    h.manager.recordVote("111", 1);
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine)); // freezes 40s remainder
    expect(h.manager.snapshot()?.frozen).toBe(true);
    return h;
  }

  it("(a) resume → HALTED→BUILD_IN_PROGRESS: the frozen round RESUMES with votes intact; startRound works after it closes", () => {
    const h = haltedConcurrent();
    h.setNow(100_000);

    // halt.ts 'resume' recovers to frozen.mode — BUILD_IN_PROGRESS here.
    h.machine.recoverTo("BUILD_IN_PROGRESS");

    const resumed = h.manager.snapshot();
    expect(resumed?.frozen).toBe(false);
    expect(resumed?.endsAtMs).toBe(140_000); // 100_000 + the 40s frozen remainder
    expect(resumed?.totalVotes).toBe(1); // acknowledged votes kept (D2-14 spirit)
    expect(h.manager.recordVote("222", 2)).toBe(true); // votes flow again

    // The round closes normally and a LATER startRound is not wedged (CR-01).
    h.manager.closeRound();
    expect(h.manager.snapshot()).toBeNull();
    h.pool.add(candidate("cand-x"), approved);
    h.pool.add(candidate("cand-y"), approved);
    expect(() => h.manager.startRound()).not.toThrow();
    h.db.close();
  });

  it("(b) discard-and-resume → HALTED→IDLE: round discarded, candidates repooled, startRound works immediately", () => {
    const h = haltedConcurrent();

    // discard-and-resume maps frozen BUILD_IN_PROGRESS → IDLE (halt.ts ~93).
    h.machine.recoverTo("IDLE");

    expect(h.manager.snapshot()).toBeNull();
    expect(
      h.pool
        .list()
        .map((a) => a.candidate.id)
        .sort(),
    ).toEqual(["cand-1", "cand-2", "cand-3"]);
    expect(() => h.manager.startRound()).not.toThrow();
    h.db.close();
  });

  it("(c) reset-to-idle → HALTED→IDLE: same discard path — nothing stays wedged behind CR-01", () => {
    const h = haltedConcurrent();

    h.machine.recoverTo("IDLE");

    expect(h.manager.snapshot()).toBeNull();
    const row = h.db.prepare("SELECT status FROM rounds ORDER BY id DESC LIMIT 1").get() as {
      status: string;
    };
    expect(row.status).toBe("discarded");
    expect(() => h.manager.startRound()).not.toThrow();
    h.db.close();
  });
});

describe("recordRoundOpened initiator (quick-t5k audit honesty)", () => {
  it("startRound() defaults to operator; startRound('auto') records the auto initiator", () => {
    const h = makeHarness({ candidates: 4 });
    h.manager.startRound();
    h.manager.closeRound();
    h.pool.add(candidate("cand-5"), approved);
    h.manager.startRound("auto");

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_opened" });
    expect(audit).toHaveLength(2);
    // Newest first: the auto round, then the operator round.
    expect(audit[0]?.rationale).toContain("initiated by auto");
    expect(audit[1]?.rationale).toContain("initiated by operator");
    h.db.close();
  });
});

describe("RoundManager.dispose (WR-05 shutdown safety)", () => {
  it("cancels the armed round timer so a pending closeRound never fires against a closed db", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.manager.startRound();
      h.manager.dispose();
      h.db.close(); // AppHandle.close() order: dispose first, THEN db.close()
      // The round deadline elapsing must NOT run closeRound against the
      // closed database (it would throw inside the setTimeout callback).
      expect(() => vi.advanceTimersByTime(roundDurationMs() + 1_000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
