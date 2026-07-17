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

export type FeedbackKind =
  | "rejected"
  | "held"
  | "duplicate"
  | "cooldown"
  | "trim"
  // quick-q5n: confirmation beats for an APPROVED chat !build / !revert — the
  // routing verbs are invisible until a round opens, so their pooling is
  // confirmed (a plain approved !suggest stays silent per D2-15).
  | "pooled-build"
  | "pooled-revert"
  // quick-t8k: same treatment for an approved chat !swapbuild.
  | "pooled-swap";

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

  // ── Pending-window beats (quick-260716-h73 — server-composed) ─────────────
  // A trigger arriving mid-build/mid-round BANKS a window that auto-opens on
  // the return to IDLE. Each beat fires at most once per bank/open/discard
  // (never in the anti-spam no-op set). Copy-separation invariant holds: no
  // chance/luck/odds/random/roll words. Donor name is the SOLE chat-derived
  // interpolation; `amount` is pre-formatted server-side (WR-02 currency copy).
  /** A DONATION banked a pending window — granted now, opens when the build wraps. */
  windowPendingDonation(donor: string, amount: string, durationMs: number): void;
  /** A CHANNEL-POINTS redemption banked a pending window. */
  windowPendingChannelPoints(user: string, reward: string, durationMs: number): void;
  /** The banked window OPENED on the return to IDLE — full duration starts now. */
  windowOpenedFromPending(donor: string, durationMs: number): void;
  /** A trigger was denied because a window is already banked (one slot, D-05). */
  windowDeniedPending(donor: string): void;
  /** The pending window was discarded (streamer revoke / halt recovery) — never silent. */
  windowPendingCancelled(donor: string): void;
  /** Chaos mode turned on. */
  chaosOn(): void;
  /** Chaos mode turned off — the vote loop resumes. */
  chaosOff(): void;
  /** A uniform-random chaos pick was made and queued (CHAOS-01). */
  chaosPick(title: string): void;

  // ── Chat-voted chaos-mode beats (quick-260711-ly4 — server-composed) ──────
  // Fixed templates; the only interpolations are a formatted duration and
  // gate-approved titles through truncateTitle. Copy-separation (directive
  // + D2 rules): no gambling-adjacent words (luck/odds/roll/gamble) and no
  // money words in any of these strings.
  /** The CHAOS ballot option WON a vote round — chaos mode is now live for durationMs. */
  chaosActivated(durationMs: number): void;
  /** The vote-skip pick landed in the build queue (chat-activated path). */
  chaosModePicked(title: string): void;
  /** The pick went stale and re-entered the full gate (D2-05 — never a silent re-roll). */
  chaosPickRecheck(): void;
  /** The chaos window reached its full duration — democratic voting resumes. */
  chaosExpired(): void;

  // ── Auto-cycle suggestion-phase beats (quick-t5k D-01/D-02) ──────────────
  // Low-frequency transition beats, one message per phase begin — the phase
  // countdown itself lives on the overlay (A2), never in chat.
  /** A fresh 40s suggestion window opened — the cycle's collect beat. */
  suggestionsOpen(seconds: number): void;
  /** Pool was too small at phase end — another full window restarts (D-02). */
  stillCollecting(seconds: number): void;
  /**
   * The vote-winner build queue hit VOTE_QUEUE_MAX — the scheduler pauses new
   * rounds until the queue drains (user amendment). Emitted ONCE per park.
   */
  buildQueueFull(): void;
  /**
   * quick-260716-fdl: the vote is parked behind an in-progress build
   * (VOTE_WAITS_FOR_BUILD default mode). Emitted ONCE per park. This beat
   * POSTS to chat (the buildQueueFull precedent) — it fires at most once per
   * build, and chat needs to know why no vote countdown is running.
   */
  waitingForBuild(): void;

  // ── Single-suggestion auto-build beats (quick-260711-ly4 — server-composed) ─
  // A DISTINCT beat from a vote win (roundClosed) and a chaos pick
  // (chaosModePicked): the suggestion window ended with exactly ONE pooled idea,
  // so it was built directly with no vote. Copy carries no chance/money words
  // (copy-separation), and truthfully names the origin (one idea, not a vote).
  /** The lone pooled candidate was auto-built (no vote round opened). */
  soloPicked(title: string): void;
  /** The lone pick went stale and re-entered the full gate (D2-05 — never a silent re-roll). */
  soloPickRecheck(): void;

  // ── Tier-1 voted-command beats (quick-q5n) ───────────────────────────────
  // All server-composed; failure lines are AMBER-TIER (D2-18): matter-of-fact
  // regroup language, never ERROR/red/alarm wording. `title` is gate-approved
  // text rendered through truncateTitle.
  /** A revert winner rolled back the last change — the previous version is live again. */
  revertApplied(): void;
  /** A revert winner found no earlier version to roll back to (no repo / one commit). */
  revertNothing(): void;
  /** The rollback couldn't apply cleanly — everything left as-is, loop continues. */
  revertFailed(): void;
  /** A project-switch winner: shipping the current app to the gallery BEFORE rotating. */
  newProjectShipping(title: string): void;
  /** The pre-rotation ship failed — staying on the current project (never a silent rotate). */
  newProjectShipFailed(): void;

  // ── Wipe-intent save-and-close beat (quick-260716-rll) ───────────────────
  /**
   * A gate-approved winner asked to wipe/reset the whole app, so the project
   * was SAVED to the gallery and CLOSED instead of handed to the build agent
   * (2026-07-16 incident, audit 885-891). Fixed server-composed line, zero
   * interpolation — never chat text. Amber-tier (D2-18) and copy-separation
   * clean (no chance words, no money words).
   */
  projectClosed(): void;

  // ── Swap beats (quick-t8k) ────────────────────────────────────────────────
  // Server-composed; the resolved project_repos.repo_name slug is the ONLY
  // dynamic token. Failure lines are AMBER-TIER (D2-18): matter-of-fact
  // regroup wording, never ERROR/red/alarm vocabulary. Copy stays clear of
  // the copy-separation scan vocabularies (no chance words, no money words).
  /** The SWAP winner landed: transition line + landed line (at most two sends). */
  swapActivated(name: string): void;
  /** The pre-activation ship failed — staying on the current project (amber). */
  swapShipFailed(): void;
  /** No project matched the requested name at drain time (amber). */
  swapUnresolved(): void;
  /** The swap named the project ALREADY on screen — its own honest line (amber). */
  swapAlreadyCurrent(): void;

  // ── Tier-2 info replies (quick-t8k) ──────────────────────────────────────
  // Instant read-only replies through the SAME single rate-budgeted sender
  // (D2-08). The ONLY dynamic tokens are project_repos.repo_name slugs and
  // their derived github.com URLs — already-public post-gate data. Raw chat
  // or prompt text NEVER reaches these methods (T-t8k-03).
  /** !projects — slug + link list, greedily packed to the 500-char cap with a "(+N more)" tail. */
  infoProjects(entries: Array<{ name: string; url: string }>): void;
  /**
   * !current — the ACTIVE generation's repo, or the fixed not-shipped-yet
   * line. quick-1ki: when `playUrl` (the GitHub Pages URL) is present the
   * message PREFERS it; without it the message is byte-identical to before.
   */
  infoCurrent(entry: { name: string; url: string; playUrl?: string } | null): void;
  /** !repo — just the current repo link (same null fallback as infoCurrent). */
  infoRepo(url: string | null): void;
  /** !help / !commands — the FIXED-COPY command list, zero interpolation. */
  infoHelp(): void;
  /**
   * !apps (quick-1ki) — the playable-gallery link. The ONLY dynamic token is
   * the config-derived owner.github.io URL — never chat text.
   */
  infoApps(url: string): void;

  // ── Post-publish playable-link beat (quick-260716-g8p) ───────────────────
  /**
   * The just-completed build's playable GitHub Pages link — fired only after
   * publishNow CONFIRMED (published | no-changes with a repo row). ONE extra
   * transition beat per completed build through the same rate-limited sender
   * (buildDone already posts exactly one). The ONLY dynamic token is the
   * config-owner + sanitized-slug Pages URL — never chat text. `ready=false`
   * is the honest first-publish variant (the Pages build hadn't reported
   * built inside the poll budget). Copy-separation safe: no chance/money words.
   */
  buildPlayable(url: string, ready: boolean): void;
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
      case "pooled-build":
        return `@${displayName} NEW PROJECT idea is in — it competes in the next vote.`;
      case "pooled-revert":
        return `@${displayName} revert request is in — vote for it next round.`;
      case "pooled-swap":
        return `@${displayName} PROJECT SWAP request is in — it competes in the next vote.`;
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
      // quick-q5n kind-aware listing: NEW (project-switch) / TWEAK (suggestion)
      // / the FIXED "REVERT the last change" label (never the candidate text —
      // brevity; both strings are server-composed either way).
      const listing = snap.candidates
        .map((entry) => {
          const option = `[${entry.option}]`;
          if (entry.candidate.kind === "project-switch") {
            return `${option} NEW: ${truncateTitle(entry.candidate.text)}`;
          }
          if (entry.candidate.kind === "revert") {
            return `${option} REVERT the last change`;
          }
          // quick-t8k: swap options render the gate-approved name reference —
          // same display rule as NEW/TWEAK (truncateTitle, approved text only).
          if (entry.candidate.kind === "swap") {
            return `${option} SWAP TO: ${truncateTitle(entry.candidate.text)}`;
          }
          // quick-260711-ly4: the CHAOS ballot option renders a FIXED label
          // (never the candidate text — both are server-composed anyway),
          // mirroring the REVERT listing line.
          if (entry.candidate.kind === "chaos") {
            return `${option} CHAOS — 5 min of mayhem`;
          }
          return `${option} TWEAK: ${truncateTitle(entry.candidate.text)}`;
        })
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
      // Submission acknowledgments ("…idea is in — competes in the next vote")
      // fired on EVERY accepted suggestion and flooded chat; the overlay's
      // suggestion-pool / up-next panels already show it (Ross 2026-07-12).
      // Silenced here — per-user REJECTION/error feedback (rejected, trim, held,
      // duplicate, cooldown: why an idea didn't take) still posts, since that's
      // useful guidance the overlay doesn't convey.
      if (kind === "pooled-build" || kind === "pooled-swap" || kind === "pooled-revert") {
        return;
      }
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

    // quick-0iu: no research turn exists anymore — the pickup beat goes
    // straight to the code, truthful for BOTH a new app and a tweak to the
    // app on screen (the title is the suggestion text either way).
    // Build-progress beats silenced (Ross 2026-07-12): "Building X now",
    // "Plan's coming together", "Writing the code" fired on every build and
    // flooded chat — the overlay's NOW BUILDING panel + builder feed already
    // show all of this. Kept as no-ops so the build-session wiring stays intact.
    buildPickedUp(_title: string): void {
      // intentionally silent — see note above
    },

    stagePlanning(_title: string): void {
      // intentionally silent — see note above
    },

    stageBuilding(_title: string): void {
      // intentionally silent — see note above
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

    // quick-260711-raz (donor privilege): both !build and !suggest work during
    // a window (the interceptor in main.ts aliases them into the SAME funnel),
    // so the open beats announce both. Server-composed template strings only —
    // the donor/user name stays the sole interpolated chat-derived value.
    windowOpenedDonation(donor: string, amount: string, durationMs: number): void {
      void deps.sender.send(
        `@${donor} tipped ${amount} and takes the wheel — free reign for ${formatMmss(durationMs)}! Type !build or !suggest <your instruction> — it goes straight to the build queue.`,
      );
    },

    windowOpenedChannelPoints(user: string, reward: string, durationMs: number): void {
      void deps.sender.send(
        `@${user} redeemed ${reward} — direct control for ${formatMmss(durationMs)}! Type !build or !suggest <your instruction> — it goes straight to the build queue.`,
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

    // ── Pending-window beats (quick-260716-h73 — reviewed copy contract) ─────
    // Server-composed templates; donor/user name is the sole chat-derived
    // interpolation. The promoted-open beat announces BOTH !build and !suggest
    // (quick-260711-raz donor-privilege precedent). No chance/money-mix words
    // (copy-separation invariant, scanned in narration.test.ts).

    windowPendingDonation(donor: string, amount: string, durationMs: number): void {
      void deps.sender.send(
        `@${donor} tipped ${amount} — window granted! It opens the moment this build finishes: ${formatMmss(durationMs)} of free reign, and the clock starts then.`,
      );
    },

    windowPendingChannelPoints(user: string, reward: string, durationMs: number): void {
      void deps.sender.send(
        `@${user} redeemed ${reward} — window granted! It opens the moment this build finishes: ${formatMmss(durationMs)} of direct control, clock starts then.`,
      );
    },

    windowOpenedFromPending(donor: string, durationMs: number): void {
      void deps.sender.send(
        `The build's done — @${donor}'s window is OPEN. Free reign for ${formatMmss(durationMs)}! Type !build or !suggest <your instruction> — it goes straight to the build queue.`,
      );
    },

    windowDeniedPending(donor: string): void {
      void deps.sender.send(
        `Thanks @${donor} — a window is already lined up to open next, so this one can't. One at a time.`,
      );
    },

    windowPendingCancelled(donor: string): void {
      void deps.sender.send(
        `@${donor}'s pending window was cancelled — it won't open. Streamer's call.`,
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

    // ── Chat-voted chaos-mode beats (quick-260711-ly4 — VERBATIM copy contract) ──
    // Server-composed fixed templates only; candidate titles pass through
    // truncateTitle. No gambling-adjacent or money words (copy-separation).

    chaosActivated(durationMs: number): void {
      void deps.sender.send(
        `Chat voted CHAOS — ${formatMmss(durationMs)} of mayhem! No voting: each round, one approved idea from the pool gets picked and built.`,
      );
    },

    chaosModePicked(title: string): void {
      void deps.sender.send(
        `Chaos picked: "${truncateTitle(title)}" — no vote this round, straight to the build queue.`,
      );
    },

    chaosPickRecheck(): void {
      void deps.sender.send(
        "The chaos pick needs a fresh safety check first — it may come back around.",
      );
    },

    chaosExpired(): void {
      void deps.sender.send("Chaos mode is over — voting is back.");
    },

    // ── Auto-cycle suggestion-phase beats (quick-t5k D-01/D-02) ──────────────

    // quick-0iu amendment D: the suggest-window beats invite BOTH new ideas
    // and tweaks to the app currently on screen (same rhythm + seconds
    // interpolation as before).
    // Ross 2026-07-11 (anti-spam): the on-screen SUGGESTIONS-OPEN banner is now
    // the sole participation prompt. These auto-cycle beats fired every window
    // and flooded chat, so they NO LONGER post to chat — kept as no-ops so the
    // main.ts auto-cycle wiring stays intact.
    suggestionsOpen(_seconds: number): void {
      // intentionally silent — see note above
    },

    stillCollecting(_seconds: number): void {
      // intentionally silent — see note above
    },

    buildQueueFull(): void {
      void deps.sender.send("Build queue full — pausing new rounds until it drains.");
    },

    // quick-260716-fdl: the vote-waits-for-build park beat. POSTS (the
    // buildQueueFull precedent, once per park) — NOT one of the anti-spam
    // no-ops above: it fires at most once per build, and chat needs to know
    // why no vote countdown is running.
    waitingForBuild(): void {
      void deps.sender.send(
        "Build in progress — the vote opens the moment it's done. Keep the !suggest ideas coming.",
      );
    },

    // ── Single-suggestion auto-build beats (quick-260711-ly4 — VERBATIM) ──────
    // Distinct wording from a vote win and a chaos pick: it truthfully names the
    // origin (a single idea, built unopposed) and carries no chance/money words.

    soloPicked(title: string): void {
      void deps.sender.send(`Only one idea in — building it: "${truncateTitle(title)}".`);
    },

    soloPickRecheck(): void {
      void deps.sender.send(
        "That idea needs a fresh safety check first — it may come back around.",
      );
    },

    // ── Tier-1 voted-command beats (quick-q5n) ────────────────────────────
    // Server-composed transition beats; the failure lines are AMBER-TIER
    // (D2-18) — regroup wording, no ERROR/red/alarm vocabulary.

    revertApplied(): void {
      void deps.sender.send("Rolled back the last change — previous version is back.");
    },

    revertNothing(): void {
      void deps.sender.send(
        "Nothing to revert — this project has no earlier version. Carrying on.",
      );
    },

    revertFailed(): void {
      void deps.sender.send(
        "Couldn't roll back cleanly — leaving everything as-is. Next round soon.",
      );
    },

    newProjectShipping(title: string): void {
      void deps.sender.send(
        `Chat voted NEW PROJECT: "${truncateTitle(title)}" — shipping the current app to the gallery first…`,
      );
    },

    newProjectShipFailed(): void {
      void deps.sender.send(
        "Couldn't ship the current project to the gallery just now — staying on it for the moment. We'll take the new-project switch again another round.",
      );
    },

    // quick-260716-rll: the wipe-intent save-and-close beat. Fixed
    // server-composed copy — the calm public face of an interception: the
    // project is already safe in the gallery (the last done-build publish),
    // the canvas rotates fresh, and the show loop keeps rolling.
    projectClosed(): void {
      void deps.sender.send(
        "Project saved to the gallery and closed — fresh canvas! Keep the ideas coming.",
      );
    },

    // ── Swap beats (quick-t8k) ──────────────────────────────────────────────
    // The repo slug is the only dynamic token; failure lines are amber-tier.

    swapActivated(name: string): void {
      void deps.sender.send("Swap approved — bringing an earlier project back up…");
      void deps.sender.send(
        `SWAP complete — "${name}" is live on screen again. Tweak it with !suggest.`,
      );
    },

    swapShipFailed(): void {
      void deps.sender.send(
        "Couldn't wrap up the current project for the gallery just now — staying on it. We'll take the swap again another round.",
      );
    },

    swapUnresolved(): void {
      void deps.sender.send(
        "Couldn't find that project by name — try !projects for the list. Next round is coming right up.",
      );
    },

    swapAlreadyCurrent(): void {
      void deps.sender.send(
        "That's the project already on screen — nothing to swap. Keep the tweaks coming with !suggest.",
      );
    },

    // ── Tier-2 info replies (quick-t8k) ────────────────────────────────────
    // Server-composed templates; slugs/URLs are the only dynamic tokens (all
    // post-gate public data). Copy stays clear of the copy-separation scan
    // vocabularies (no chance/money words).

    infoProjects(entries: Array<{ name: string; url: string }>): void {
      if (entries.length === 0) {
        void deps.sender.send(
          "No projects shipped yet — the first finished build starts the list.",
        );
        return;
      }
      const parts = entries.map((e) => `${e.name} — ${e.url}`);
      // Greedy pack to Twitch's 500-char cap. The first entry always ships
      // (a single slug+URL pair is far below the cap by construction:
      // repo names are ≤80-char sanitized slugs). A conservative reserve for
      // the largest possible "(+N more)" tail keeps the final message ≤500.
      const tailReserve = ` (+${entries.length - 1} more)`.length;
      let message = `Projects so far: ${parts[0]}`;
      let included = 1;
      for (let i = 1; i < parts.length; i++) {
        const next = `${message} | ${parts[i]}`;
        const reserve = i + 1 < parts.length ? tailReserve : 0;
        if (next.length + reserve > MESSAGE_MAX_CHARS) break;
        message = next;
        included += 1;
      }
      const remaining = entries.length - included;
      if (remaining > 0) message += ` (+${remaining} more)`;
      void deps.sender.send(message);
    },

    infoCurrent(entry: { name: string; url: string; playUrl?: string } | null): void {
      if (entry === null) {
        void deps.sender.send(
          "The current project hasn't shipped yet — its page appears after the first finished build.",
        );
        return;
      }
      // quick-1ki: prefer the PLAYABLE GitHub Pages URL when present; the
      // no-playUrl message stays byte-identical (backwards compatible).
      if (entry.playUrl !== undefined) {
        void deps.sender.send(
          `On screen now: ${entry.name} — play: ${entry.playUrl} · source: ${entry.url}`,
        );
        return;
      }
      void deps.sender.send(`On screen now: ${entry.name} — ${entry.url}`);
    },

    infoRepo(url: string | null): void {
      if (url === null) {
        void deps.sender.send(
          "The current project hasn't shipped yet — its page appears after the first finished build.",
        );
        return;
      }
      void deps.sender.send(`Current project repo: ${url}`);
    },

    infoHelp(): void {
      void deps.sender.send(
        "How it works: chat decides what this AI builds, live. Pitch a change with !suggest <idea> or start a new app with !build <idea>, then !vote when a round opens — chat's top pick gets built on stream. The full command list is on the COMMANDS panel on screen.",
      );
    },

    // quick-1ki: the playable-gallery link. Fixed server-composed copy; the
    // config-derived URL is the only dynamic token (copy-separation safe: no
    // chance words, no money words).
    infoApps(url: string): void {
      void deps.sender.send(
        `Play everything chat has built: ${url} — every app live-coded by an AI from chat prompts, unreviewed by humans.`,
      );
    },

    // quick-260716-g8p: the post-publish playable-link beat. Two PINNED copy
    // variants (narration.test.ts exact-string contract); the URL is the only
    // dynamic token — server-composed from the config owner + the post-gate
    // repo slug, never chat text.
    buildPlayable(url: string, ready: boolean): void {
      if (ready) {
        void deps.sender.send(`Play it now: ${url}`);
        return;
      }
      void deps.sender.send(`Play it: ${url} (going live in ~1 min)`);
    },
  };
}
