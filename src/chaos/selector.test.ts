import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ApprovedCandidate } from "../queue/pool.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { pickChaos } from "./selector.js";

function candidate(id: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text: `idea ${id}`,
    submittedAtMs: 0,
  };
}

const approvedResult: GateResult = {
  decision: "approved",
  category: null,
  rationale: "ok",
};

function pooled(id: string): ApprovedCandidate {
  return { candidate: candidate(id), result: approvedResult, addedAtMs: 0 };
}

describe("pickChaos — uniform chaos-mode selector (CHAOS-01)", () => {
  it("returns null for an empty pool", () => {
    expect(pickChaos([])).toBeNull();
  });

  it("returns the sole entry for a single-item pool", () => {
    const only = pooled("a");
    expect(pickChaos([only])).toBe(only);
  });

  it("is deterministic under an injected rng (picks the indexed entry)", () => {
    const pool = [pooled("a"), pooled("b"), pooled("c")];
    // Injected rng always yields index 1 -> the middle entry.
    expect(pickChaos(pool, () => 1)).toBe(pool[1]);
    expect(pickChaos(pool, () => 0)).toBe(pool[0]);
    expect(pickChaos(pool, () => 2)).toBe(pool[2]);
  });

  it("passes the pool length as the exclusive upper bound to the rng", () => {
    const pool = [pooled("a"), pooled("b"), pooled("c")];
    let seenMax = -1;
    pickChaos(pool, (max) => {
      seenMax = max;
      return 0;
    });
    expect(seenMax).toBe(pool.length);
  });

  it("uses node:crypto.randomInt as the production default — never Math.random", () => {
    const src = readFileSync(fileURLToPath(new URL("./selector.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/import\s*\{\s*randomInt\s*\}\s*from\s*["']node:crypto["']/);
    expect(src).not.toMatch(/Math\.random/);
  });
});
