/**
 * Chaos-mode selector (CHAOS-01) — a uniform pick from the ALREADY
 * gate-filtered candidate pool.
 *
 * This is the ONLY module in Phase 4 permitted to import an RNG. The D-08
 * paid<->chaos separation invariant (tests/invariants/paid-chaos-separation.test.ts)
 * scans this side for PAYMENT references only: this file may reference
 * randomness but must NEVER reference a donation/redemption/payment event.
 * The paid side is the mirror image — it may reference payment but never RNG.
 *
 * `node:crypto.randomInt` (not the seedable stdlib PRNG) gives a
 * cryptographically uniform, unseedable pick, and its distinct import token is
 * exactly what makes the source-scan invariant simple and reliable
 * (RESEARCH Pattern 3 / Alternatives Considered).
 */

import { randomInt } from "node:crypto";
import type { ApprovedCandidate } from "../queue/pool.js";

/**
 * Uniformly select one entry from an already-gate-filtered pool.
 *
 * @param pool - the current gate-approved pool entries (Phase 2's CandidatePool).
 * @param rng  - injectable index source for deterministic tests; the production
 *               default is `node:crypto.randomInt(0, max)` (exclusive upper bound).
 * @returns the picked entry, or null when the pool is empty.
 */
export function pickChaos(
  pool: ApprovedCandidate[],
  rng: (max: number) => number = (max) => randomInt(0, max),
): ApprovedCandidate | null {
  if (pool.length === 0) return null;
  return pool[rng(pool.length)] ?? null;
}
