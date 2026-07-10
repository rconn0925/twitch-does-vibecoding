import { describe, expect, it } from "vitest";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { type ApprovedCandidate, CandidatePool } from "./pool.js";

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "fine" };

function candidate(id: string, text = `idea ${id}`): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text,
    submittedAtMs: 1_000,
  };
}

describe("CandidatePool bounded mode (D2-13)", () => {
  it("without opts, behavior is unchanged from Phase 1 (unbounded)", () => {
    const pool = new CandidatePool();
    for (let i = 0; i < 60; i++) {
      pool.add(candidate(`c${i}`), APPROVED);
    }
    expect(pool.list()).toHaveLength(60);
    expect(pool.list()[0]?.candidate.id).toBe("c0");
  });

  it("with maxSize 3, adding a 4th evicts the OLDEST and invokes onEvict exactly once with it", () => {
    const evicted: ApprovedCandidate[] = [];
    const pool = new CandidatePool({ maxSize: 3, onEvict: (item) => evicted.push(item) });
    pool.add(candidate("a"), APPROVED);
    pool.add(candidate("b"), APPROVED);
    pool.add(candidate("c"), APPROVED);
    pool.add(candidate("d"), APPROVED);

    expect(pool.list().map((entry) => entry.candidate.id)).toEqual(["b", "c", "d"]);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.candidate.id).toBe("a");
  });

  it("eviction keeps working across further adds (always insertion-order oldest)", () => {
    const evictedIds: string[] = [];
    const pool = new CandidatePool({
      maxSize: 2,
      onEvict: (item) => evictedIds.push(item.candidate.id),
    });
    pool.add(candidate("a"), APPROVED);
    pool.add(candidate("b"), APPROVED);
    pool.add(candidate("c"), APPROVED);
    pool.add(candidate("d"), APPROVED);

    expect(pool.list().map((entry) => entry.candidate.id)).toEqual(["c", "d"]);
    expect(evictedIds).toEqual(["a", "b"]);
  });

  it("the approved-only guard still applies with the bounded constructor", () => {
    const pool = new CandidatePool({ maxSize: 3 });
    expect(() =>
      pool.add(candidate("x"), { decision: "rejected", category: "spam-malware", rationale: "no" }),
    ).toThrow(/approved/);
    expect(pool.list()).toHaveLength(0);
  });

  it("existing method signatures are untouched: list() copies, remove() deletes", () => {
    const pool = new CandidatePool({ maxSize: 5 });
    pool.add(candidate("a"), APPROVED);
    const listed = pool.list();
    listed.pop();
    expect(pool.list()).toHaveLength(1);
    pool.remove("a");
    expect(pool.list()).toHaveLength(0);
  });
});
