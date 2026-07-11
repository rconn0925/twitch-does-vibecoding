/**
 * Dev-only overlay visual harness (quick-l2a) — NEVER imported by src/.
 *
 * Serves the REAL overlay pages (/, /queue, /builder) through the REAL
 * startOverlayServer, with injected fake sources exercising the maximum
 * display state so the legibility targets can be checked in a browser or an
 * OBS browser source without a Twitch connection:
 *
 *   --mode=vote    (default) an OPEN round with 5 candidates (the
 *                  ROUND_MAX_OPTIONS default: mixed short + full 80-char
 *                  texts, varied tallies with a unique leader, 30s left) under
 *                  VOTING_ROUND — the vote panel + "VOTE NOW — type !vote 1–5"
 *                  banner.
 *   --mode=suggest no round; a suggest phase ending in 40s + a FULL pool of 5
 *                  (the POOL_MAX_SIZE default; long texts, 24-char usernames,
 *                  one null username) — the SUGGESTIONS OPEN banner, and
 *                  /queue shows the whole pool.
 *
 * Both modes carry 10 queued builds (the VOTE_QUEUE_MAX cap) so /queue's
 * bottom panel renders its own maximum.
 *
 * Every string below is FIXED harness-authored copy — no real chat data ever
 * enters this file. The harness binds to 127.0.0.1:4999 via the real server
 * (which never listens elsewhere).
 *
 * Run:  npx tsx scripts/overlay-harness.ts --mode=vote
 *       npx tsx scripts/overlay-harness.ts --mode=suggest
 */

import { startOverlayServer } from "../src/overlay/server.js";
import type { RoundSnapshot, StreamMode } from "../src/shared/types.js";

const PORT = 4999;

const mode: "vote" | "suggest" = process.argv.includes("--mode=suggest") ? "suggest" : "vote";

/** Deterministic fake texts: alternate short titles and full-width 80-char runs. */
// 82 chars pre-truncation — exercises the client-side 80-char cap + ellipsis.
const LONG_80 = "a physics sandbox where ragdoll robots stack crates against a rising tide of soup";
const SHORT_TEXTS = [
  "snake but the snake is a train",
  "cozy pixel aquarium",
  "drum machine in the browser",
  "tiny roguelike about spreadsheets",
  "weather app for fictional planets",
];

function fakeText(i: number): string {
  return i % 2 === 0 ? (SHORT_TEXTS[(i / 2) % SHORT_TEXTS.length] ?? LONG_80) : LONG_80;
}

/** 5 vote candidates — varied tallies with option 3 as the unique leader. */
function fakeRound(now: number): RoundSnapshot {
  const votesByOption = [4, 7, 12, 2, 0];
  const candidates = votesByOption.map((votes, i) => ({
    option: i + 1,
    candidate: {
      id: `fake-${i + 1}`,
      source: "chat" as const,
      kind: "suggestion" as const,
      twitchUsername: `harness_viewer_${i + 1}`,
      text: fakeText(i),
      submittedAtMs: now - 60_000 + i * 1_000,
    },
    result: {
      decision: "approved" as const,
      category: null,
      rationale: "harness fixture",
    },
    votes,
  }));
  return {
    roundId: 999,
    status: "open",
    frozen: false,
    candidates,
    openedAtMs: now,
    endsAtMs: now + 30_000,
    remainingMs: null,
    winnerOption: null,
    tiebreak: false,
    totalVotes: votesByOption.reduce((sum, v) => sum + v, 0),
    winnerQueued: false,
  };
}

/** A FULL pool (5, the POOL_MAX_SIZE default): long texts + long usernames, one null. */
const fakePool = Array.from({ length: 5 }, (_, i) => ({
  candidate: {
    text: fakeText(i),
    twitchUsername:
      i === 2
        ? null // dev-submitted: the username line must simply be absent
        : `viewer_with_a_very_long_name_${String(i + 1).padStart(2, "0")}`.slice(0, 24),
  },
}));

/** 10 queued builds (the VOTE_QUEUE_MAX cap) — all long texts. */
const fakeQueue = Array.from({ length: 10 }, (_, i) => ({
  text: `${i + 1 < 10 ? "queued build " : ""}${LONG_80} (#${i + 1})`,
}));

const now = Date.now();
const round = mode === "vote" ? fakeRound(now) : null;
const machineMode: StreamMode = mode === "vote" ? "VOTING_ROUND" : "IDLE";

const handle = await startOverlayServer({
  machine: { mode: machineMode, on: () => {} },
  round: { snapshot: () => round, on: () => {} },
  taskQueue: { list: () => fakeQueue },
  pool: { list: () => (mode === "suggest" ? fakePool : []), on: () => {} },
  autoCycle: {
    snapshot: () =>
      mode === "suggest"
        ? { phase: "suggest", phaseEndsAtMs: now + 40_000 }
        : { phase: null, phaseEndsAtMs: null },
    on: () => {},
  },
  port: PORT,
});

console.log(`overlay-harness up in --mode=${mode}`);
console.log(`  main overlay : http://127.0.0.1:${handle.port}/`);
console.log(`  what's coming: http://127.0.0.1:${handle.port}/queue`);
console.log(`  builder view : http://127.0.0.1:${handle.port}/builder`);
console.log("Ctrl+C to stop.");
