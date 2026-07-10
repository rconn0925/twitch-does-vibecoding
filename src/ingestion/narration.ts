/**
 * Bot chat narration — UI-SPEC copy templates + burst coalescing (CHAT-05,
 * COMP-03, D2-06/D2-07).
 *
 * This module is the SOLE consumer of ChatSender for show narration: every
 * message it produces is a TRANSITION beat (round open, round close/winner,
 * rejection/held feedback, errors). Live tallies and timers NEVER go to chat
 * — the Narrator interface has no tally-shaped input, making the rate-budget
 * doctrine structural rather than a convention.
 *
 * Copy strings are a reviewed contract (02-UI-SPEC.md "Bot chat narration"
 * table) — render them VERBATIM; candidate titles truncate to 60 chars so a
 * 3-candidate round-open message always fits Twitch's 500-char cap.
 *
 * Compliance surface (T-02-17): rejected/held feedback carries ONLY the
 * viewer-safe category label the caller passes in — never the rejected
 * suggestion text or classifier rationale. Candidate titles in round
 * messages are already-gate-approved text.
 */

import type { Logger } from "pino";
import type { RoundSnapshot } from "../shared/types.js";
import type { ChatSender } from "./chat-sender.js";

export type FeedbackKind = "rejected" | "held" | "duplicate" | "cooldown" | "trim";

export interface Narrator {
  roundOpened(snap: RoundSnapshot): void;
  roundClosed(snap: RoundSnapshot): void;
  feedback(kind: FeedbackKind, displayName: string, categoryLabel?: string): void;
  error(text: string): void;
}

/** UI-SPEC: titles inside chat messages truncate to 60 chars (incl. the ellipsis). */
const TITLE_MAX_CHARS = 60;
/** Twitch hard cap — coalesced feedback packs into messages at most this long. */
const MESSAGE_MAX_CHARS = 500;
const DEFAULT_COALESCE_MS = 3_000;
const DEFAULT_COOLDOWN_SECONDS = 60;

function truncateTitle(text: string): string {
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}

/** "1, 2 or 3" for a 3-candidate round; "1 or 2" for two (D2-04). */
function optionsPhrase(count: number): string {
  const options = Array.from({ length: count }, (_, i) => String(i + 1));
  if (options.length <= 1) return options[0] ?? "1";
  return `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;
}

export function createNarrator(deps: {
  sender: ChatSender;
  coalesceMs?: number;
  /** The {n} in the UI-SPEC cooldown notice ("one suggestion per {n}s"). */
  cooldownSeconds?: number;
  logger?: Logger;
}): Narrator {
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const cooldownSeconds = deps.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;

  let buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  function renderFeedback(kind: FeedbackKind, displayName: string, categoryLabel?: string): string {
    switch (kind) {
      case "rejected":
        return `@${displayName} that one can't run on stream: ${categoryLabel ?? "not allowed here"}. Different idea?`;
      case "trim":
        return `@${displayName} too big for a live build — try a smaller version of that idea.`;
      case "held":
        return `@${displayName} that idea is held for streamer review — it may join a later round.`;
      case "duplicate":
        return `@${displayName} that one's already in the pool — vote for it when it comes up!`;
      case "cooldown":
        return `@${displayName} easy there — one suggestion per ${cooldownSeconds}s.`;
    }
  }

  /** Flush the coalesce buffer: greedy-pack @-runs into ≤500-char messages (D2-07). */
  function flush(): void {
    timer = null;
    const lines = buffer;
    buffer = [];
    if (lines.length > 1) {
      deps.logger?.info({ coalesced: lines.length }, "coalescing feedback burst into one message");
    }
    let current = "";
    for (const line of lines) {
      const merged = current === "" ? line : `${current} ${line}`;
      if (merged.length > MESSAGE_MAX_CHARS && current !== "") {
        void deps.sender.send(current);
        current = line;
      } else {
        current = merged;
      }
    }
    if (current !== "") void deps.sender.send(current);
  }

  return {
    roundOpened(snap: RoundSnapshot): void {
      const durationSeconds = Math.round((snap.endsAtMs - snap.openedAtMs) / 1_000);
      const listing = snap.candidates
        .map((entry) => `[${entry.option}] ${truncateTitle(entry.candidate.text)}`)
        .join(" ");
      void deps.sender.send(
        `Voting is OPEN — !vote ${optionsPhrase(snap.candidates.length)}: ${listing} — ${durationSeconds}s on the clock.`,
      );
    },

    roundClosed(snap: RoundSnapshot): void {
      // A discarded round is a halt-triage outcome, not a show beat — no chat
      // noise while recovering (D-02; the UI-SPEC table has no discard line).
      if (snap.status === "discarded") return;
      if (snap.winnerOption === null) {
        void deps.sender.send(
          "No votes this round — candidates return to the pool. We'll run it back.",
        );
        return;
      }
      const winner = snap.candidates[snap.winnerOption - 1];
      if (!winner) return;
      const title = truncateTitle(winner.candidate.text);
      // WR-02 broadcast honesty (D2-18): only announce "Queued for the
      // build" when the funnel actually queued the winner. A refused winner
      // (halted, or stale → re-classification) gets the honest variant.
      const disposition = snap.winnerQueued
        ? "Queued for the build."
        : "It's being re-checked before the build.";
      if (snap.tiebreak) {
        void deps.sender.send(`Dead heat! Coin flip says… "${title}". ${disposition}`);
        return;
      }
      void deps.sender.send(
        `Round over — "${title}" wins with ${winner.votes} votes. ${disposition}`,
      );
    },

    feedback(kind: FeedbackKind, displayName: string, categoryLabel?: string): void {
      buffer.push(renderFeedback(kind, displayName, categoryLabel));
      if (timer === null) {
        // Trailing coalesce window: everything buffered before it fires goes
        // out as one combined message of @-runs (D2-07 burst rule).
        timer = setTimeout(flush, coalesceMs);
        timer.unref();
      }
    },

    error(text: string): void {
      void deps.sender.send(text);
    },
  };
}
