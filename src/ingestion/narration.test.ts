import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        candidates: [
          roundCandidate(1, "Title A", 3),
          roundCandidate(2, "Title B", 5),
          roundCandidate(3, "Title C", 0),
        ],
      }),
    );
    expect(sent).toEqual(['Round over — "Title B" wins with 5 votes. Queued for the build.']);
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
        candidates: [roundCandidate(1, "Title A", 3), roundCandidate(2, "Title B", 3)],
      }),
    );
    expect(sent).toEqual(['Dead heat! Coin flip says… "Title A". Queued for the build.']);
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
    expect(Object.keys(narrator).sort()).toEqual([
      "error",
      "feedback",
      "roundClosed",
      "roundOpened",
    ]);
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
