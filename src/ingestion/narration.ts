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
import type { BuildNarrator, RoundSnapshot } from "../shared/types.js";
import type { ChatSender } from "./chat-sender.js";

export type FeedbackKind = "rejected" | "held" | "duplicate" | "cooldown" | "trim";

/**
 * The narrator implements the round/feedback beats AND the build-pipeline beats
 * (BuildNarrator, BUILD-03/D3-08/D3-09). Build events are transitions too — one
 * message per transition through the SAME single rate-limited sender — so a
 * build failure is never silent (per-token/per-file churn stays OFF chat).
 */
export interface Narrator extends BuildNarrator {
  roundOpened(snap: RoundSnapshot): void;
  roundClosed(snap: RoundSnapshot): void;
  feedback(kind: FeedbackKind, displayName: string, categoryLabel?: string): void;
  error(text: string): void;

  // ── Phase 4 window/chaos beats (PAID-01/02/03, CHAOS-01 — 04-UI-SPEC copy) ──
  // Every beat is a low-frequency transition through the SAME rate-limited sender.
  // Trigger-appropriate wording: DONATION windows say "tipped", channel-points
  // windows say "redeemed" — a channel-points redeemer is never mislabelled a
  // "donor". Copy-separation invariant (hard, mirrors D-08): the paid-window copy
  // never mentions chance/luck/odds/random/roll; the chaos copy never mentions
  // money/tips/donations/points/paying.
  /** A DONATION-triggered window opened. `amount` is the pre-formatted "$X.XX" string. */
  windowOpenedDonation(donor: string, amount: string, durationMs: number): void;
  /** A CHANNEL-POINTS-triggered window opened. `reward` is the redeemed reward title. */
  windowOpenedChannelPoints(user: string, reward: string, durationMs: number): void;
  /** A grant was denied because a window is already active (D-05, never silent). */
  windowDeniedActive(donor: string): void;
  /** A grant was denied because the donor is inside the per-donor cooldown (D-04). */
  windowDeniedCooldown(donor: string): void;
  /**
   * A grant was denied because the stream is NOT IDLE — a voting round or a
   * build is mid-flight (CR-01). The HONEST reason (never "a window is already
   * running", which would be a lie when no window is live).
   */
  windowDeniedNotIdle(donor: string): void;
  /**
   * An in-window instruction was rejected by the gate (PAID-03 — narrated, never
   * silent; window time is NOT consumed). `categoryLabel` is a viewer-safe
   * CATEGORY_META label — never the internal code.
   */
  instructionRejected(donor: string, categoryLabel?: string): void;
  /** An in-window instruction was held for streamer review (window time unaffected). */
  instructionHeld(donor: string): void;
  /** An in-window instruction cleared the gate and its build STARTED immediately. */
  instructionAccepted(donor: string, title: string): void;
  /**
   * An in-window instruction cleared the gate and is QUEUED behind an in-flight
   * build (CR-03 honesty): it will build when the current one wraps — narrated as
   * "queued", never "building now" (which would be a lie until startBuild fires).
   */
  instructionQueued(donor: string, title: string): void;
  /** 30-seconds-remaining beat — emitted only for windows ≥ 60s. */
  window30sLeft(donor: string): void;
  /** The window reached its full duration and closed (D-12). */
  windowExpired(donor: string): void;
  /** The streamer revoked the window early (PAID-03). */
  windowRevoked(): void;
  /** Chaos mode turned on. */
  chaosOn(): void;
  /** Chaos mode turned off — the vote loop resumes. */
  chaosOff(): void;
  /** A uniform-random chaos pick was made and queued (CHAOS-01). */
  chaosPick(title: string): void;
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

/** Format a millisecond duration as m:ss (60000 → "1:00", 30000 → "0:30"). */
function formatMmss(ms: number): string {
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

    // ── Build-pipeline beats (BUILD-03 / D3-08 / D3-09) ───────────────────────
    // One message per transition, through the SAME rate-limited sender. Copy is
    // the reviewed 03-UI-SPEC "Bot chat narration" contract — render verbatim.
    // Task titles truncate to 60 chars (Twitch 500-char cap headroom).

    buildPickedUp(title: string): void {
      void deps.sender.send(
        `Building "${truncateTitle(title)}" now — researching how to pull it off.`,
      );
    },

    stagePlanning(title: string): void {
      void deps.sender.send(`Plan's coming together for "${truncateTitle(title)}"…`);
    },

    stageBuilding(title: string): void {
      void deps.sender.send(
        `Writing the code for "${truncateTitle(title)}" now — watch it come alive.`,
      );
    },

    buildDone(title: string): void {
      void deps.sender.send(`"${truncateTitle(title)}" is built — it's live on screen. GG.`);
    },

    buildRefused(title: string): void {
      void deps.sender.send(
        `Heads up — the build agent won't build "${truncateTitle(title)}". Moving on to the next one.`,
      );
    },

    buildRetryingOnce(title: string): void {
      void deps.sender.send(`"${truncateTitle(title)}" hit a snag — giving it one more shot.`);
    },

    buildDeciding(title: string): void {
      void deps.sender.send(
        `"${truncateTitle(title)}" won't build cleanly — streamer's calling retry or skip.`,
      );
    },

    buildRetryChosen(title: string): void {
      void deps.sender.send(`Another go at "${truncateTitle(title)}" — here we go.`);
    },

    buildSkipped(title: string): void {
      void deps.sender.send(`Skipping "${truncateTitle(title)}" — on to the next idea.`);
    },

    comp02Rejected(title: string): void {
      void deps.sender.send(
        `"${truncateTitle(title)}" didn't pass the second safety check — can't build that one. Next up.`,
      );
    },

    buildHeld(title: string): void {
      void deps.sender.send(
        `"${truncateTitle(title)}" needs a human look before it can build — held for streamer review. Next up.`,
      );
    },

    buildVetoed(title: string): void {
      void deps.sender.send(
        `Build stopped — pulling the plug on "${truncateTitle(title)}". Standing by.`,
      );
    },

    // ── Phase 4 window/chaos beats (04-UI-SPEC §Bot chat narration — VERBATIM) ──
    // Trigger-appropriate wording + the copy-separation invariant baked into the
    // strings: paid copy carries no chance/luck/odds/random/roll words; chaos copy
    // carries no money/tip/donation/points/pay words.

    windowOpenedDonation(donor: string, amount: string, durationMs: number): void {
      void deps.sender.send(
        `@${donor} tipped ${amount} and takes the wheel — free reign for ${formatMmss(durationMs)}! Type !build <your instruction> to use it.`,
      );
    },

    windowOpenedChannelPoints(user: string, reward: string, durationMs: number): void {
      void deps.sender.send(
        `@${user} redeemed ${reward} — direct control for ${formatMmss(durationMs)}! Type !build <your instruction> to use it.`,
      );
    },

    windowDeniedActive(donor: string): void {
      void deps.sender.send(
        `Thanks @${donor} — a control window is already running, so this one can't open. One window at a time.`,
      );
    },

    windowDeniedCooldown(donor: string): void {
      void deps.sender.send(
        `Thanks @${donor} — you're on cooldown from your last window. Try again in a bit.`,
      );
    },

    windowDeniedNotIdle(donor: string): void {
      void deps.sender.send(
        `Thanks @${donor} — the show's mid-round or mid-build right now, so a control window can't open yet. Try again in a bit.`,
      );
    },

    instructionRejected(donor: string, categoryLabel?: string): void {
      void deps.sender.send(
        `Can't build that one, @${donor} — it didn't pass the safety check (${categoryLabel ?? "not allowed here"}). Your window's still open — try another idea.`,
      );
    },

    instructionHeld(donor: string): void {
      void deps.sender.send(
        `That one needs a human look first, @${donor} — the streamer's checking it. Your window's still open.`,
      );
    },

    instructionAccepted(donor: string, title: string): void {
      void deps.sender.send(`Locked in — building @${donor}'s pick: "${truncateTitle(title)}".`);
    },

    instructionQueued(donor: string, title: string): void {
      void deps.sender.send(
        `Queued up @${donor}'s pick: "${truncateTitle(title)}" — it builds as soon as the current one wraps.`,
      );
    },

    window30sLeft(donor: string): void {
      void deps.sender.send(`30 seconds left on @${donor}'s window.`);
    },

    windowExpired(donor: string): void {
      void deps.sender.send(`Time's up — @${donor}'s window is closed. Back to the regular show.`);
    },

    windowRevoked(): void {
      void deps.sender.send(
        "Streamer's call — the control window is closed early. Back to the regular show.",
      );
    },

    chaosOn(): void {
      void deps.sender.send(
        "CHAOS MODE ON — the next build is a random pick from the approved pool. No votes.",
      );
    },

    chaosOff(): void {
      void deps.sender.send("Chaos mode off — voting is back.");
    },

    chaosPick(title: string): void {
      void deps.sender.send(
        `Chaos pick: "${truncateTitle(title)}" — no vote needed, building it now.`,
      );
    },
  };
}
