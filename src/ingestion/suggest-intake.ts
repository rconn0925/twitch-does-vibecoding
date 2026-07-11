/**
 * Pre-classification suggestion intake policy (D2-11/D2-12 — closes T-01-11).
 *
 * Every verdict here is computed SYNCHRONOUSLY, in memory, BEFORE
 * submitCandidate() and the classifier are ever invoked — the whole point is
 * that a !suggest flood dies at this check without burning a metered Sonnet
 * call. This module imports no classifier/gate code and returns no Promise.
 *
 * Identity: everything is keyed by chatterId (the immutable Twitch numeric
 * user id from the EventSub payload), NEVER by display name — a name change
 * must not reset a cooldown (T-02-13).
 *
 * State is in-memory only, on purpose: the pool starts clean each stream
 * night (D2-13), so intake state legitimately resets with the process.
 */

import { normalize } from "../compliance/prefilter.js";
import type { CandidatePool } from "../queue/pool.js";

export type IntakeVerdict =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "pending-exists" | "duplicate" };

export interface SuggestIntake {
  /** Synchronous pre-classification verdict for one !suggest attempt. */
  check(chatterId: string, rawText: string): IntakeVerdict;
  /** Record an accepted submission: starts the cooldown and tracks the candidate id. */
  registerAccepted(chatterId: string, candidateId: string): void;
}

interface UserIntakeState {
  lastSuggestAtMs: number;
  /** Candidate ids this user submitted; only ones still POOLED count against the slot. */
  pendingCandidateIds: Set<string>;
}

export function createSuggestIntake(deps: {
  pool: CandidatePool;
  cooldownMs: number;
  /** Max POOLED candidates one user may hold at once (D2-11). Default 1. */
  maxPooledPerUser?: number;
  now?: () => number;
}): SuggestIntake {
  const now = deps.now ?? Date.now;
  const maxPooledPerUser = deps.maxPooledPerUser ?? 1;
  const users = new Map<string, UserIntakeState>();

  return {
    check(chatterId: string, rawText: string): IntakeVerdict {
      const state = users.get(chatterId);

      // (1) Per-user cooldown (D2-11) — the timestamp is set by registerAccepted.
      if (state && now() - state.lastSuggestAtMs < deps.cooldownMs) {
        return { ok: false, reason: "cooldown" };
      }

      const pooled = deps.pool.list();

      // (2) Max N pooled candidates per user (D2-11; default 1, configurable
      // via INTAKE_MAX_POOLED_PER_USER for testing/solo streams). A rejected/
      // held candidate never lands in the pool, so it naturally frees a slot;
      // a candidate drawn into a round or evicted leaves the pool and frees
      // it too.
      if (state) {
        const pooledIds = new Set(pooled.map((entry) => entry.candidate.id));
        for (const id of state.pendingCandidateIds) {
          if (!pooledIds.has(id)) state.pendingCandidateIds.delete(id);
        }
        if (state.pendingCandidateIds.size >= maxPooledPerUser) {
          return { ok: false, reason: "pending-exists" };
        }
      }

      // (3) Exact-duplicate rejection against the current pool (D2-12).
      // normalize() is the canonical text-folding path (NFKC, zero-width strip,
      // hyphen folding, whitespace collapse, lowercase) — imported, never copied.
      const norm = normalize(rawText);
      if (pooled.some((entry) => normalize(entry.candidate.text) === norm)) {
        return { ok: false, reason: "duplicate" };
      }

      return { ok: true };
    },

    registerAccepted(chatterId: string, candidateId: string): void {
      const state = users.get(chatterId) ?? {
        lastSuggestAtMs: 0,
        pendingCandidateIds: new Set<string>(),
      };
      state.lastSuggestAtMs = now();
      state.pendingCandidateIds.add(candidateId);
      users.set(chatterId, state);
    },
  };
}
