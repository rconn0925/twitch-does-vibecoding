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

function roundCandidate(option: number, text: string, votes = 0): RoundCandidate {
  return {
    option,
    candidate: {
      id: `c${option}`,
      source: "chat",
      kind: "suggestion",
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
  it("roundOpened with 3 candidates sends exactly one message on the UI-SPEC template", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(snapshot());
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1, 2 or 3: [1] Title A [2] Title B [3] Title C — 60s on the clock.",
    ]);
  });

  it("a 2-candidate round says '1 or 2'", () => {
    const { sent, sender } = capturingSender();
    const narrator = createNarrator({ sender });
    narrator.roundOpened(
      snapshot({ candidates: [roundCandidate(1, "Title A"), roundCandidate(2, "Title B")] }),
    );
    expect(sent).toEqual([
      "Voting is OPEN — !vote 1 or 2: [1] Title A [2] Title B — 60s on the clock.",
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
    expect(message).toContain(`[1] ${"x".repeat(59)}…`);
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
      ].sort(),
    );
  });

  describe("build-pipeline narration (BUILD-03 / D3-08 / D3-09 — 03-UI-SPEC copy)", () => {
    it("emits each build-event template VERBATIM through the sender", () => {
      const { sent, sender } = capturingSender();
      const n = createNarrator({ sender });
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
        'Building "a counter app" now — researching how to pull it off.',
        'Plan\'s coming together for "a counter app"…',
        'Writing the code for "a counter app" now — watch it come alive.',
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
        "@alice tipped $5.00 and takes the wheel — free reign for 1:00! Type !build <your instruction> to use it.",
        "@bob redeemed Take the Wheel — direct control for 0:30! Type !build <your instruction> to use it.",
      ]);
      // A channel-points redeemer is NEVER labelled a "donor"/"tipped".
      expect(sent[1]).not.toContain("tipped");
      expect(sent[1]).toContain("redeemed");
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

      // Chaos template strings.
      sent.length = 0;
      n.chaosOn();
      n.chaosOff();
      n.chaosPick("a build");
      const MONEY = /money|tip|donation|points|pay/i;
      for (const message of sent) {
        expect(message, `chaos copy mentions money: "${message}"`).not.toMatch(MONEY);
      }
    });
  });

  describe("auto-cycle suggestion-phase narration (quick-t5k D-01/D-02)", () => {
    it("suggestionsOpen renders the fresh-window template with the seconds count", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.suggestionsOpen(40);
      expect(sent).toEqual(["Suggestions open — type !suggest <your idea>. 40s until voting."]);
    });

    it("stillCollecting renders the pool-too-small restart template with the seconds count", () => {
      const { sent, sender } = capturingSender();
      const narrator = createNarrator({ sender });
      narrator.stillCollecting(40);
      expect(sent).toEqual([
        "Still collecting suggestions — type !suggest <your idea>. Another 40s.",
      ]);
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
