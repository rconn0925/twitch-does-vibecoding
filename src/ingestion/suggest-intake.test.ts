import { describe, expect, it } from "vitest";
import { CandidatePool } from "../queue/pool.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { createSuggestIntake } from "./suggest-intake.js";

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "fine" };

function candidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text,
    submittedAtMs: 1_000,
  };
}

describe("createSuggestIntake (D2-11/D2-12 — pre-classification intake policy)", () => {
  it("cooldown: ok, then blocked within cooldownMs after registerAccepted, then ok again", () => {
    let now = 0;
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => now });

    expect(intake.check("42", "build a snake game")).toEqual({ ok: true });
    intake.registerAccepted("42", "c1");

    now = 30_000;
    expect(intake.check("42", "another idea")).toEqual({ ok: false, reason: "cooldown" });

    now = 60_000; // exactly cooldownMs elapsed -> allowed again
    expect(intake.check("42", "another idea")).toEqual({ ok: true });
  });

  it("cooldown is per-chatterId: one user's cooldown never blocks another", () => {
    let now = 0;
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => now });

    intake.registerAccepted("42", "c1");
    now = 10_000;
    expect(intake.check("42", "second idea")).toEqual({ ok: false, reason: "cooldown" });
    expect(intake.check("77", "totally new idea")).toEqual({ ok: true });
  });

  it("pending-exists: a pooled registered candidate blocks; leaving the pool frees the slot", () => {
    let now = 0;
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => now });

    intake.registerAccepted("42", "c1");
    pool.add(candidate("c1", "build a snake game"), APPROVED);

    now = 120_000; // well past cooldown — pending check is what blocks now
    expect(intake.check("42", "a different idea")).toEqual({
      ok: false,
      reason: "pending-exists",
    });

    // Candidate drawn into a round / evicted: leaves the pool, slot frees.
    pool.remove("c1");
    expect(intake.check("42", "a different idea")).toEqual({ ok: true });
  });

  it("a rejected/held candidate never pooled does not occupy the pending slot", () => {
    let now = 0;
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => now });

    intake.registerAccepted("42", "rejected-id"); // classification rejected it — never pooled
    now = 120_000;
    expect(intake.check("42", "a fresh idea")).toEqual({ ok: true });
  });

  it("duplicate (D2-12): normalize()-equal text against any pooled candidate is refused", () => {
    let now = 0;
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => now });

    pool.add(candidate("c1", "Build a Snake Game"), APPROVED);
    now = 120_000;

    // Case-folded exact duplicate from a DIFFERENT user.
    expect(intake.check("77", "build a snake game")).toEqual({ ok: false, reason: "duplicate" });
    // Zero-width-disguised variant (U+200B) — normalize() strips it.
    expect(intake.check("77", "build a s​nake game")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    // Hyphen-disguised variant (U+2011 non-breaking hyphen folds to a space).
    expect(intake.check("77", "build a snake‑game")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    // A genuinely different idea passes.
    expect(intake.check("77", "build a pomodoro timer")).toEqual({ ok: true });
  });

  it("check() is synchronous and pure over injected state — no Promise, no classifier", () => {
    const pool = new CandidatePool();
    const intake = createSuggestIntake({ pool, cooldownMs: 60_000, now: () => 0 });
    const verdict = intake.check("42", "an idea");
    expect(verdict).not.toBeInstanceOf(Promise);
    expect(verdict).toEqual({ ok: true });
  });
});
