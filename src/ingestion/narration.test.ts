import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORY_META } from "../compliance/categories.js";
import type { RoundCandidate, RoundSnapshot } from "../shared/types.js";
import type { ChatSender } from "./chat-sender.js";
import { createNarrator } from "./narration.js";

function capturingSender(): { sent: string[]; sender: ChatSender } {
  const sent: string[] = [];
  return {
    sent,
    sender: {
      send(text: string): Promise<void> {
        sent.push(text);
        return Promise.resolve();
      },
      get pending(): number {
        return 0;
      },
    },
  };
}

function roundCandidate(
  option: number,
  text: string,
  votes = 0,
  kind: RoundCandidate["candidate"]["kind"] = "suggestion",
): RoundCandidate {
  return {
    option,
    candidate: {
      id: `c${option}`,
      source: "chat",
      kind,
      twitchUsername: "viewer",
      text,
      submittedAtMs: 1_000,
    },
    result: { decision: "approved", category: null, rationale: "fine" },
    votes,
  };
}

function snapshot(overrides: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    roundId: 1,
    status: "open",
    frozen: false,
    candidates: [
      roundCandidate(1, "Title A"),
      roundCandidate(2, "Title B"),
      roundCandidate(3, "Title C"),
    ],
    openedAtMs: 0,
    endsAtMs: 60_000,
    remainingMs: null,
    winnerOption: null,
    tiebreak: false,
    totalVotes: 0,
    winnerQueued: false,
    ...overrides,
  };
}

describe("createNarrator — UI-SPEC copy contract (CHAT-05/COMP-03/D2-06/D2-07)", () => {
  it("roundOpened with 3 suggestion candidates sends one kind-aware TWEAK-prefixed message", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(snapshot());
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1, 2 or 3: [1] TWEAK: Title A [2] TWEAK: Title B [3] TWEAK: Title C — 60s on the clock.",
    ]);
  });

  it("a 2-candidate round says '1 or 2'", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(
      snapshot({ candidates: [roundCandidate(1, "Title A"), roundCandidate(2, "Title B")] }),
    );
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1 or 2: [1] TWEAK: Title A [2] TWEAK: Title B — 60s on the clock.",
    ]);
  });

  it("a mixed round renders NEW / TWEAK / REVERT wording in ONE round-open line (quick-q5n)", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(
      snapshot({
        candidates: [
          roundCandidate(1, "make a snake game", 0, "project-switch"),
          roundCandidate(2, "add a dark theme", 0, "suggestion"),
          roundCandidate(3, "Revert the last change to the current project", 0, "revert"),
        ],
      }),
    );
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1, 2 or 3: [1] NEW: make a snake game [2] TWEAK: add a dark theme [3] REVERT the last change — 60s on the clock.",
    ]);
    // The revert option renders the FIXED label, never the candidate text.
    expect(sent[0]).not.toContain("Revert the last change to the current project");
  });

  it("roundOpened renders a CHAOS candidate as [N] CHAOS — 5 min of mayhem (fixed label, quick-260711-ly4)", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(
      snapshot({
        candidates: [
          roundCandidate(1, "add a dark theme", 0, "suggestion"),
          roundCandidate(2, "CHAOS — 5 minutes of mayhem", 0, "chaos"),
        ],
      }),
    );
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1 or 2: [1] TWEAK: add a dark theme [2] CHAOS — 5 min of mayhem — 60s on the clock.",
    ]);
  });

  it("candidate titles truncate to 60 chars in chat messages", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    const long = "x".repeat(100);
    narrator.roundOpened(
      snapshot({ candidates: [roundCandidate(1, long), roundCandidate(2, "Title B")] }),
    );
    const message = sent[0] ?? "";
    expect(message).toContain(`[1] TWEAK: ${"x".repeat(59)}…`);
    expect(message).not.toContain("x".repeat(60));
  });

  it("roundClosed with a winner uses the winner template with its vote count", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(
      snapshot({
        status: "closed",
        winnerOption: 2,
        totalVotes: 8,
        winnerQueued: true,
        candidates: [
          roundCandidate(1, "Title A", 3),
          roundCandidate(2, "Title B", 5),
          roundCandidate(3, "Title C", 0),
        ],
      }),
    );
    expect(sent).toEqual(['Round over — "Title B" wins with 5 votes. Queued for the build.']);
  });

  it("roundClosed with an UN-queued winner never says 'Queued for the build' (WR-02 honesty)", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(
      snapshot({
        status: "closed",
        winnerOption: 2,
        totalVotes: 8,
        winnerQueued: false, // funnel refused: halted or stale → re-check
        candidates: [
          roundCandidate(1, "Title A", 3),
          roundCandidate(2, "Title B", 5),
          roundCandidate(3, "Title C", 0),
        ],
      }),
    );
    expect(sent).toEqual([
      'Round over — "Title B" wins with 5 votes. It\'s being re-checked before the build.',
    ]);
  });

  it("roundClosed with a tiebreak uses the dead-heat template", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(
      snapshot({
        status: "closed",
        winnerOption: 1,
        tiebreak: true,
        totalVotes: 6,
        winnerQueued: true,
        candidates: [roundCandidate(1, "Title A", 3), roundCandidate(2, "Title B", 3)],
      }),
    );
    expect(sent).toEqual(['Dead heat! Coin flip says… "Title A". Queued for the build.']);
  });

  it("a tiebreak with an UN-queued winner also gets the honest re-check variant (WR-02)", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(
      snapshot({
        status: "closed",
        winnerOption: 1,
        tiebreak: true,
        totalVotes: 6,
        winnerQueued: false,
        candidates: [roundCandidate(1, "Title A", 3), roundCandidate(2, "Title B", 3)],
      }),
    );
    expect(sent).toEqual([
      'Dead heat! Coin flip says… "Title A". It\'s being re-checked before the build.',
    ]);
  });

  it("roundClosed with zero votes uses the run-it-back template", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(snapshot({ status: "closed", winnerOption: null, totalVotes: 0 }));
    expect(sent).toEqual([
      "No votes this round — candidates return to the pool. We'll run it back.",
    ]);
  });

  it("a discarded round (halt triage chose discard) narrates nothing", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundClosed(snapshot({ status: "discarded", winnerOption: null }));
    expect(sent).toEqual([]);
  });

  it("error(text) sends the given line through the sender", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.error(
      "Suggestion check is backed up — hold your ideas for a minute, votes still count.",
    );
    expect(sent).toEqual([
      "Suggestion check is backed up — hold your ideas for a minute, votes still count.",
    ]);
  });

  it("the Narrator interface has no tally-shaped input (rate-budget doctrine is structural)", () => {
    const { sender } = capturingSender();
    const narrator = createNarrator({ sender });
    // Round/feedback beats + build-pipeline beats (BUILD-03/D3-08/D3-09). Every
    // method is a transition (title string at most) — none takes a vote tally,
    // so the rate-budget doctrine stays structural even with the build events.
    expect(Object.keys(narrator).sort()).toEqual(
      [
        "buildDeciding",
        "buildDone",
        "buildPickedUp",
        "buildRefused",
        "buildRetryChosen",
        "buildRetryingOnce",
        "buildSkipped",
        "buildHeld",
        "buildVetoed",
        "comp02Rejected",
        "error",
        "feedback",
        "roundClosed",
        "roundOpened",
        "stageBuilding",
        "stagePlanning",
        // Phase 4 window/chaos beats — each is a transition (donor/title string
        // at most), so the rate-budget doctrine stays structural.
        "windowOpenedDonation",
        "windowOpenedChannelPoints",
        "windowDeniedActive",
        "windowDeniedCooldown",
        "windowDeniedNotIdle",
        "instructionRejected",
        "instructionHeld",
        "instructionAccepted",
        "instructionQueued",
        "window30sLeft",
        "windowExpired",
        "windowRevoked",
        "chaosOn",
        "chaosOff",
        "chaosPick",
        // Chat-voted chaos-mode beats (quick-260711-ly4) — a formatted duration
        // and titles at most; never a tally-shaped input.
        "chaosActivated",
        "chaosModePicked",
        "chaosPickRecheck",
        "chaosExpired",
        // Auto-cycle suggestion-phase beats (quick-t5k) — seconds counts and a
        // fixed park line, never a tally.
        "suggestionsOpen",
        "stillCollecting",
        "buildQueueFull",
        // Single-suggestion auto-build beats (quick-260711-ly4) — a title string
        // at most and a fixed recheck line; never a tally.
        "soloPicked",
        "soloPickRecheck",
        // Tier-1 voted-command beats (quick-q5n) — fixed server-composed lines,
        // title string at most; never a tally.
        "revertApplied",
        "revertNothing",
        "revertFailed",
        "newProjectShipping",
        "newProjectShipFailed",
        // Tier-2 info replies (quick-t8k) — post-gate repo slugs/URLs at most;
        // never a tally.
        "infoProjects",
        "infoCurrent",
        "infoRepo",
        "infoHelp",
        // quick-1ki: the playable-gallery link (fixed copy + config URL).
        "infoApps",
        // Swap beats (quick-t8k) — the resolved repo slug at most; never a tally.
        "swapActivated",
        "swapShipFailed",
        "swapUnresolved",
        "swapAlreadyCurrent",
      ].sort(),
    );
  });

  describe("tier-1 voted-command narration (quick-q5n — server-composed, amber-tier D2-18)", () => {
    it("pooled submission acks are SILENT — they flooded chat and the overlay shows the pool (Ross 2026-07-12)", () => {
      vi.useFakeTimers();
      try {
        const { sent, sender } = capturingSender();
        const narrator = createNarrator({ sender, coalesceMs: 3_000 });
        narrator.feedback("pooled-build", "alice");
        narrator.feedback("pooled-revert", "bob");
        narrator.feedback("pooled-swap", "carol");
        vi.advanceTimersByTime(3_000);
        expect(sent).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("per-user REJECTION/error feedback still posts (that's useful guidance, not spam)", () => {
      vi.useFakeTimers();
      try {
        const { sent, sender } = capturingSender();
        const narrator = createNarrator({ sender, coalesceMs: 3_000, cooldownSeconds: 30 });
        narrator.feedback("rejected", "alice", "not allowed here");
        narrator.feedback("cooldown", "bob");
        vi.advanceTimersByTime(3_000);
        expect(sent).toEqual([
          "@alice that one can't run on stream: not allowed here. Different idea? " +
            "@bob easy there — one suggestion per 30s.",
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("revert-outcome and ship beats render verbatim, one message each", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.revertApplied();
      n.revertNothing();
      n.revertFailed();
      n.newProjectShipping("make a snake game");
      n.newProjectShipFailed();
      expect(sent).toEqual([
        "Rolled back the last change — previous version is back.",
        "Nothing to revert — this project has no earlier version. Carrying on.",
        "Couldn't roll back cleanly — leaving everything as-is. Next round soon.",
        'Chat voted NEW PROJECT: "make a snake game" — shipping the current app to the gallery first…',
        "Couldn't ship the current project to the gallery just now — staying on it for the moment. We'll take the new-project switch again another round.",
      ]);
    });

    it("newProjectShipping truncates the gate-approved title to 60 chars", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      const long = "w".repeat(100);
      n.newProjectShipping(long);
      expect(sent[0]).toContain(`"${"w".repeat(59)}…"`);
      expect(sent[0]).not.toContain("w".repeat(60));
    });

    it("AMBER-TIER INVARIANT (D2-18): failure beats carry no red/alarm wording", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.revertFailed();
      n.newProjectShipFailed();
      n.revertNothing();
      const ALARM = /error|alarm|crash|panic|fatal|broken|emergency|urgent/i;
      for (const message of sent) {
        expect(message, `alarm wording leaked: "${message}"`).not.toMatch(ALARM);
      }
    });
  });

  describe("build-pipeline narration (BUILD-03 / D3-08 / D3-09 — 03-UI-SPEC copy)", () => {
    it("emits each build-event template VERBATIM through the sender", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      // Build-PROGRESS beats (buildPickedUp/stagePlanning/stageBuilding) are
      // silenced (Ross 2026-07-12) — they emit nothing; the outcome/decision
      // beats below still render verbatim.
      n.buildPickedUp("a counter app");
      n.stagePlanning("a counter app");
      n.stageBuilding("a counter app");
      n.buildDone("a counter app");
      n.buildRefused("a counter app");
      n.buildRetryingOnce("a counter app");
      n.buildDeciding("a counter app");
      n.buildRetryChosen("a counter app");
      n.buildSkipped("a counter app");
      n.comp02Rejected("a counter app");
      n.buildHeld("a counter app");
      n.buildVetoed("a counter app");
      expect(sent).toEqual([
        '"a counter app" is built — it\'s live on screen. GG.',
        'Heads up — the build agent won\'t build "a counter app". Moving on to the next one.',
        '"a counter app" hit a snag — giving it one more shot.',
        "\"a counter app\" won't build cleanly — streamer's calling retry or skip.",
        'Another go at "a counter app" — here we go.',
        'Skipping "a counter app" — on to the next idea.',
        "\"a counter app\" didn't pass the second safety check — can't build that one. Next up.",
        '"a counter app" needs a human look before it can build — held for streamer review. Next up.',
        'Build stopped — pulling the plug on "a counter app". Standing by.',
      ]);
    });

    it("truncates the task title to 60 chars in every build-event message", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      const long = "y".repeat(100);
      n.buildPickedUp(long);
      n.buildDone(long);
      n.buildVetoed(long);
      for (const message of sent) {
        expect(message).toContain(`"${"y".repeat(59)}…"`);
        expect(message).not.toContain("y".repeat(60));
      }
    });

    it("each build event is exactly one message (one transition → one send)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.buildRefused("x");
      expect(sent).toHaveLength(1);
    });
  });

  describe("window/chaos narration (PAID-01/02/03, CHAOS-01 — 04-UI-SPEC copy)", () => {
    it("distinct donation vs channel-points window-opened templates (trigger-appropriate wording)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.windowOpenedDonation("alice", "$5.00", 60_000);
      n.windowOpenedChannelPoints("bob", "Take the Wheel", 30_000);
      expect(sent).toEqual([
        "@alice tipped $5.00 and takes the wheel — free reign for 1:00! Type !build or !suggest <your instruction> — it goes straight to the build queue.",
        "@bob redeemed Take the Wheel — direct control for 0:30! Type !build or !suggest <your instruction> — it goes straight to the build queue.",
      ]);
      // A channel-points redeemer is NEVER labelled a "donor"/"tipped".
      expect(sent[1]).not.toContain("tipped");
      expect(sent[1]).toContain("redeemed");
      // Donor-privilege directive (quick-260711-raz): BOTH commands are
      // announced on window open — !suggest aliases !build during a window.
      for (const message of sent) {
        expect(message).toContain("!build");
        expect(message).toContain("!suggest");
      }
    });

    it("renders denial, held, accepted, 30s, expiry, revoke templates verbatim", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.windowDeniedActive("carol");
      n.windowDeniedCooldown("dave");
      n.instructionHeld("erin");
      n.instructionAccepted("frank", "a counter app");
      n.window30sLeft("grace");
      n.windowExpired("heidi");
      n.windowRevoked();
      expect(sent).toEqual([
        "Thanks @carol — a control window is already running, so this one can't open. One window at a time.",
        "Thanks @dave — you're on cooldown from your last window. Try again in a bit.",
        "That one needs a human look first, @erin — the streamer's checking it. Your window's still open.",
        'Locked in — building @frank\'s pick: "a counter app".',
        "30 seconds left on @grace's window.",
        "Time's up — @heidi's window is closed. Back to the regular show.",
        "Streamer's call — the control window is closed early. Back to the regular show.",
      ]);
    });

    it("rejected-instruction copy carries the CATEGORY_META label, never the internal code", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      // Pass the viewer-safe label; the internal code ("hateful-conduct") must not leak.
      n.instructionRejected("mallory", CATEGORY_META["hateful-conduct"].label);
      const message = sent[0] ?? "";
      expect(message).toContain("Hateful conduct");
      expect(message).not.toContain("hateful-conduct");
      expect(message).toContain("Your window's still open");
    });

    it("chaos on/off/pick templates render verbatim, title truncated to 60 chars", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.chaosOn();
      n.chaosOff();
      n.chaosPick("a counter app");
      expect(sent).toEqual([
        "CHAOS MODE ON — the next build is a random pick from the approved pool. No votes.",
        "Chaos mode off — voting is back.",
        'Chaos pick: "a counter app" — no vote needed, building it now.',
      ]);
      const long = "z".repeat(100);
      n.chaosPick(long);
      expect(sent[3]).toContain(`"${"z".repeat(59)}…"`);
      expect(sent[3]).not.toContain("z".repeat(60));
    });

    it("chat-voted chaos-mode beats render verbatim (quick-260711-ly4 — reviewed copy contract)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.chaosActivated(300_000);
      n.chaosModePicked("a counter app");
      n.chaosPickRecheck();
      n.chaosExpired();
      expect(sent).toEqual([
        "Chat voted CHAOS — 5:00 of mayhem! No voting: each round, one approved idea from the pool gets picked and built.",
        'Chaos picked: "a counter app" — no vote this round, straight to the build queue.',
        "The chaos pick needs a fresh safety check first — it may come back around.",
        "Chaos mode is over — voting is back.",
      ]);
    });

    it("chaosModePicked truncates the gate-approved title to 60 chars", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      const long = "q".repeat(100);
      n.chaosModePicked(long);
      expect(sent[0]).toContain(`"${"q".repeat(59)}…"`);
      expect(sent[0]).not.toContain("q".repeat(60));
    });

    it("COPY-SEPARATION INVARIANT (D-08): paid copy has no chance words; chaos copy has no money words", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      // Paid-window template strings — rendered with neutral sample args.
      n.windowOpenedDonation("u", "$5.00", 60_000);
      n.windowOpenedChannelPoints("u", "Wheel", 60_000);
      n.windowDeniedActive("u");
      n.windowDeniedCooldown("u");
      n.windowDeniedNotIdle("u");
      n.instructionRejected("u", CATEGORY_META.harassment.label);
      n.instructionHeld("u");
      n.instructionAccepted("u", "a build");
      n.instructionQueued("u", "a build");
      n.window30sLeft("u");
      n.windowExpired("u");
      n.windowRevoked();
      const paidStrings = [...sent];
      const CHANCE = /chance|luck|odds|random|roll|lottery/i;
      for (const message of paidStrings) {
        expect(message, `paid copy mentions chance: "${message}"`).not.toMatch(CHANCE);
      }

      // Chaos template strings — ALL of them: the console-toggle beats AND the
      // chat-activated chaos-mode beats (quick-rs3). Scanned against MONEY and
      // the GAMBLING word list (directive: no gambling-adjacent copy anywhere
      // near the chance mechanic — sweepstakes-law separation, T-rs3-05).
      sent.length = 0;
      n.chaosOn();
      n.chaosOff();
      n.chaosPick("a build");
      n.chaosActivated(300_000);
      n.chaosModePicked("a build");
      n.chaosPickRecheck();
      n.chaosExpired();
      const MONEY = /money|tip|donation|points|pay/i;
      const GAMBLING = /\b(luck|odds|roll|gamble)\b/i;
      for (const message of sent) {
        expect(message, `chaos copy mentions money: "${message}"`).not.toMatch(MONEY);
        expect(message, `chaos copy sounds gambling-adjacent: "${message}"`).not.toMatch(GAMBLING);
      }
    });
  });

  describe("auto-cycle suggestion-phase narration (quick-t5k D-01/D-02)", () => {
    it("suggestionsOpen is silent — the on-screen banner is the prompt, not chat (anti-spam)", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.suggestionsOpen(40);
      expect(sent).toEqual([]);
    });

    it("stillCollecting is silent — no periodic chat spam (Ross 2026-07-11)", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.stillCollecting(40);
      expect(sent).toEqual([]);
    });

    it("buildQueueFull renders the queue-cap park template (VOTE_QUEUE_MAX amendment)", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.buildQueueFull();
      expect(sent).toEqual(["Build queue full — pausing new rounds until it drains."]);
    });
  });

  describe("swap narration (quick-t8k — server-composed, amber-tier failures D2-18)", () => {
    it("pooled-swap submission ack is SILENT (Ross 2026-07-12 — overlay shows the pool)", () => {
      vi.useFakeTimers();
      try {
        const { sent, sender } = capturingSender();
        const narrator = createNarrator({ sender, coalesceMs: 3_000 });
        narrator.feedback("pooled-swap", "alice");
        vi.advanceTimersByTime(3_000);
        expect(sent).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("roundOpened renders a swap candidate as [N] SWAP TO: <text> (gate-approved text)", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.roundOpened(
        snapshot({
          candidates: [
            roundCandidate(1, "snake game", 0, "swap"),
            roundCandidate(2, "add a dark theme", 0, "suggestion"),
          ],
        }),
      );
      expect(sent).toEqual([
        "Voting is OPEN — !vote 1 or 2: [1] SWAP TO: snake game [2] TWEAK: add a dark theme — 60s on the clock.",
      ]);
    });

    it("swapActivated sends at most two lines — a transition line and a landed line with the repo slug", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.swapActivated("snake-game");
      expect(sent).toEqual([
        "Swap approved — bringing an earlier project back up…",
        'SWAP complete — "snake-game" is live on screen again. Tweak it with !suggest.',
      ]);
    });

    it("failure beats render verbatim: ship-failed / unresolved / already-current (distinct honest lines)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.swapShipFailed();
      n.swapUnresolved();
      n.swapAlreadyCurrent();
      expect(sent).toEqual([
        "Couldn't wrap up the current project for the gallery just now — staying on it. We'll take the swap again another round.",
        "Couldn't find that project by name — try !projects for the list. Next round is coming right up.",
        "That's the project already on screen — nothing to swap. Keep the tweaks coming with !suggest.",
      ]);
      // already-current is its OWN honest line, never the misleading not-found copy.
      expect(sent[2]).not.toContain("Couldn't find");
    });

    it("swap copy is amber-tier and scan-clean: no red/alarm words, no chance words, no money words", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.swapActivated("snake-game");
      n.swapShipFailed();
      n.swapUnresolved();
      n.swapAlreadyCurrent();
      const RED = /error|alarm|crash|panic|fatal|broken/i;
      const CHANCE = /\b(chance|luck|odds|roll|lottery|gamble)\b/i;
      const MONEY = /\b(money|tip|donation|points|pay)\b/i;
      for (const message of sent) {
        expect(message, `swap copy sounds alarming: "${message}"`).not.toMatch(RED);
        expect(message, `swap copy mentions chance: "${message}"`).not.toMatch(CHANCE);
        expect(message, `swap copy mentions money: "${message}"`).not.toMatch(MONEY);
      }
    });
  });

  describe("tier-2 info replies (quick-t8k — post-gate repo slugs/links ONLY)", () => {
    const entry = (name: string) => ({
      name,
      url: `https://github.com/TwitchVibecodes/${name}`,
    });

    it("infoProjects lists slug — link pairs in the order given, one message", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoProjects([entry("snake-game"), entry("dark-theme")]);
      expect(sent).toEqual([
        "Projects so far: snake-game — https://github.com/TwitchVibecodes/snake-game | dark-theme — https://github.com/TwitchVibecodes/dark-theme",
      ]);
    });

    it("infoProjects with an empty table sends the fixed no-projects line", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoProjects([]);
      expect(sent).toEqual(["No projects shipped yet — the first finished build starts the list."]);
    });

    it("infoProjects greedy-packs to Twitch's 500-char cap with a (+N more) tail", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      const entries = Array.from({ length: 12 }, (_, i) =>
        entry(`project-number-${i}-with-a-fairly-long-slug-name`),
      );
      n.infoProjects(entries);
      expect(sent).toHaveLength(1);
      const message = sent[0] ?? "";
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message).toMatch(/\(\+\d+ more\)$/);
      // The first (most recent) entry always makes the cut.
      expect(message).toContain("project-number-0-with-a-fairly-long-slug-name");
    });

    it("infoCurrent names the active project's repo; null gets the fixed not-shipped line", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoCurrent(entry("snake-game"));
      n.infoCurrent(null);
      expect(sent).toEqual([
        "On screen now: snake-game — https://github.com/TwitchVibecodes/snake-game",
        "The current project hasn't shipped yet — its page appears after the first finished build.",
      ]);
    });

    it("infoCurrent WITH a playUrl PREFERS it (quick-1ki) — play link first, source second", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoCurrent({
        ...entry("snake-game"),
        playUrl: "https://twitchvibecodes.github.io/snake-game/",
      });
      expect(sent).toEqual([
        "On screen now: snake-game — play: https://twitchvibecodes.github.io/snake-game/ · source: https://github.com/TwitchVibecodes/snake-game",
      ]);
    });

    it("infoApps sends the gallery URL through the shared sender (quick-1ki)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoApps("https://twitchvibecodes.github.io/");
      expect(sent).toEqual([
        "Play everything chat has built: https://twitchvibecodes.github.io/ — every app live-coded by an AI from chat prompts, unreviewed by humans.",
      ]);
    });

    it("infoRepo replies with just the current link; null gets the same not-shipped fallback", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoRepo("https://github.com/TwitchVibecodes/snake-game");
      n.infoRepo(null);
      expect(sent).toEqual([
        "Current project repo: https://github.com/TwitchVibecodes/snake-game",
        "The current project hasn't shipped yet — its page appears after the first finished build.",
      ]);
    });

    it("infoHelp EXPLAINS how to interact — server-composed fixed copy, zero interpolation", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoHelp();
      expect(sent).toEqual([
        "How it works: chat decides what this AI builds, live. Pitch a change with !suggest <idea> or start a new app with !build <idea>, then !vote when a round opens — chat's top pick gets built on stream. The full command list is on the COMMANDS panel on screen.",
      ]);
    });

    it("info copy stays clear of the copy-separation vocabularies (no chance words, no money words)", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
      n.infoProjects([entry("snake-game")]);
      n.infoProjects([]);
      n.infoCurrent(entry("snake-game"));
      n.infoCurrent(null);
      n.infoRepo("https://github.com/TwitchVibecodes/snake-game");
      n.infoRepo(null);
      n.infoHelp();
      n.infoApps("https://twitchvibecodes.github.io/");
      n.infoCurrent({
        ...entry("snake-game"),
        playUrl: "https://twitchvibecodes.github.io/snake-game/",
      });
      const CHANCE = /\b(chance|luck|odds|roll|lottery|gamble)\b/i;
      const MONEY = /\b(money|tip|donation|points|pay)\b/i;
      for (const message of sent) {
        expect(message, `info copy mentions chance: "${message}"`).not.toMatch(CHANCE);
        expect(message, `info copy mentions money: "${message}"`).not.toMatch(MONEY);
      }
    });
  });

  describe("feedback burst coalescing (D2-07, fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("three feedback() calls within coalesceMs produce ONE combined ≤500-char message", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender, coalesceMs: 3_000, cooldownSeconds: 60 });
      narrator.feedback("rejected", "user1", "Harassment");
      narrator.feedback("held", "user2");
      narrator.feedback("cooldown", "user3");
      expect(sent).toEqual([]);

      vi.advanceTimersByTime(3_000);
      expect(sent).toHaveLength(1);
      const message = sent[0] ?? "";
      expect(message).toBe(
        "@user1 that one can't run on stream: Harassment. Different idea? " +
          "@user2 that idea is held for streamer review — it may join a later round. " +
          "@user3 easy there — one suggestion per 60s.",
      );
      expect(message.length).toBeLessThanOrEqual(500);
    });

    it("renders the trim and duplicate templates verbatim", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender, coalesceMs: 3_000 });
      narrator.feedback("trim", "user4");
      narrator.feedback("duplicate", "user5");
      vi.advanceTimersByTime(3_000);
      expect(sent).toEqual([
        "@user4 too big for a live build — try a smaller version of that idea. " +
          "@user5 that one's already in the pool — vote for it when it comes up!",
      ]);
    });

    it("overflowing entries flush in a second message, each ≤500 chars", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender, coalesceMs: 3_000 });
      for (let i = 0; i < 12; i++) {
        narrator.feedback("held", `viewer_with_a_long_name_${i}`);
      }
      vi.advanceTimersByTime(3_000);
      expect(sent.length).toBeGreaterThan(1);
      for (const message of sent) {
        expect(message.length).toBeLessThanOrEqual(500);
      }
      // Nothing lost: every viewer is @-mentioned exactly once across the batch.
      const combined = sent.join(" ");
      for (let i = 0; i < 12; i++) {
        expect(combined).toContain(`@viewer_with_a_long_name_${i} `);
      }
    });

    it("a burst arriving after a flush starts a fresh coalesce window", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender, coalesceMs: 3_000 });
      narrator.feedback("held", "early");
      vi.advanceTimersByTime(3_000);
      expect(sent).toHaveLength(1);
      narrator.feedback("held", "late");
      vi.advanceTimersByTime(3_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain("@late ");
    });
  });
});
