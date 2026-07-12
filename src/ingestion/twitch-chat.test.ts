import { describe, expect, it, vi } from "vitest";
import type { SubmitResult } from "../pipeline/submit.js";
import type { SuggestionCandidate } from "../shared/types.js";
import { REVERT_REQUEST_TEXT } from "./command-parser.js";
import type { FeedbackKind, Narrator } from "./narration.js";
import type { IntakeVerdict, SuggestIntake } from "./suggest-intake.js";
import {
  type ChatEventSource,
  type ChatMessageEvent,
  startTwitchChat,
  type TwitchChatDeps,
} from "./twitch-chat.js";

interface FakeSource {
  source: ChatEventSource;
  emitMessage(event: unknown): void;
  emitReady(userId: string, sessionId: string): void;
  emitDisconnect(userId: string, error?: Error): void;
  subscribeArgs: string[][];
  startCount(): number;
  stopCount(): number;
}

function fakeSource(): FakeSource {
  const messageHandlers: ((e: ChatMessageEvent) => void)[] = [];
  const readyHandlers: ((userId: string, sessionId: string) => void)[] = [];
  const disconnectHandlers: ((userId: string, error?: Error) => void)[] = [];
  const subscribeArgs: string[][] = [];
  let started = 0;
  let stopped = 0;
  return {
    source: {
      onChannelChatMessage(broadcasterId, userId, handler) {
        subscribeArgs.push([broadcasterId, userId]);
        messageHandlers.push(handler);
        return {};
      },
      onUserSocketReady(handler) {
        readyHandlers.push(handler);
        return {};
      },
      onUserSocketDisconnect(handler) {
        disconnectHandlers.push(handler);
        return {};
      },
      start() {
        started += 1;
      },
      stop() {
        stopped += 1;
      },
    },
    emitMessage(event: unknown) {
      for (const handler of messageHandlers) handler(event as ChatMessageEvent);
    },
    emitReady(userId, sessionId) {
      for (const handler of readyHandlers) handler(userId, sessionId);
    },
    emitDisconnect(userId, error) {
      for (const handler of disconnectHandlers) handler(userId, error);
    },
    subscribeArgs,
    startCount: () => started,
    stopCount: () => stopped,
  };
}

function fakeNarrator(): Narrator & { feedbackCalls: [FeedbackKind, string, string?][] } {
  const feedbackCalls: [FeedbackKind, string, string?][] = [];
  return {
    feedbackCalls,
    roundOpened: vi.fn(),
    roundClosed: vi.fn(),
    feedback(kind, displayName, categoryLabel) {
      feedbackCalls.push([kind, displayName, categoryLabel]);
    },
    error: vi.fn(),
    // Build-pipeline beats (unused by the chat listener; present to satisfy Narrator).
    buildPickedUp: vi.fn(),
    stagePlanning: vi.fn(),
    stageBuilding: vi.fn(),
    buildDone: vi.fn(),
    buildRefused: vi.fn(),
    buildRetryingOnce: vi.fn(),
    buildDeciding: vi.fn(),
    buildRetryChosen: vi.fn(),
    buildSkipped: vi.fn(),
    comp02Rejected: vi.fn(),
    buildHeld: vi.fn(),
    buildVetoed: vi.fn(),
    // Phase 4 window/chaos beats (unused by the chat listener; present to satisfy Narrator).
    windowOpenedDonation: vi.fn(),
    windowOpenedChannelPoints: vi.fn(),
    windowDeniedActive: vi.fn(),
    windowDeniedCooldown: vi.fn(),
    windowDeniedNotIdle: vi.fn(),
    instructionRejected: vi.fn(),
    instructionHeld: vi.fn(),
    instructionAccepted: vi.fn(),
    instructionQueued: vi.fn(),
    window30sLeft: vi.fn(),
    windowExpired: vi.fn(),
    windowRevoked: vi.fn(),
    chaosOn: vi.fn(),
    chaosOff: vi.fn(),
    chaosPick: vi.fn(),
    // Chat-activated chaos-mode beats (quick-rs3; unused by the chat listener).
    chaosTallyProgress: vi.fn(),
    chaosActivated: vi.fn(),
    chaosModePicked: vi.fn(),
    chaosPickRecheck: vi.fn(),
    chaosExpired: vi.fn(),
    suggestionsOpen: vi.fn(),
    stillCollecting: vi.fn(),
    buildQueueFull: vi.fn(),
    // Tier-1 voted-command beats (quick-q5n; unused by the chat listener).
    revertApplied: vi.fn(),
    revertNothing: vi.fn(),
    revertFailed: vi.fn(),
    newProjectShipping: vi.fn(),
    newProjectShipFailed: vi.fn(),
    // Tier-2 info replies (quick-t8k; routed via the infoCommand seam, not here).
    infoProjects: vi.fn(),
    infoCurrent: vi.fn(),
    infoRepo: vi.fn(),
    infoHelp: vi.fn(),
  };
}

function fakeIntake(verdict: IntakeVerdict): SuggestIntake & { registered: string[][] } {
  const registered: string[][] = [];
  return {
    registered,
    check: () => verdict,
    registerAccepted(chatterId, candidateId) {
      registered.push([chatterId, candidateId]);
    },
  };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeDeps(overrides: Partial<TwitchChatDeps> = {}): TwitchChatDeps & {
  submitted: SuggestionCandidate[];
  votes: [string, number][];
} {
  const submitted: SuggestionCandidate[] = [];
  const votes: [string, number][] = [];
  const src = fakeSource();
  const deps: TwitchChatDeps = {
    source: src.source,
    broadcasterUserId: "999",
    intake: fakeIntake({ ok: true }),
    submit(candidate): SubmitResult {
      submitted.push(candidate);
      return { accepted: true, id: candidate.id };
    },
    round: {
      recordVote(id, option) {
        votes.push([id, option]);
        return true;
      },
    },
    narrator: fakeNarrator(),
    reconcile: vi.fn(),
    logger: fakeLogger(),
    ...overrides,
  };
  return Object.assign(deps, { submitted, votes });
}

const CHAT_EVENT = {
  chatterId: "42",
  chatterDisplayName: "viewer1",
  messageText: "!suggest cool idea",
};

describe("startTwitchChat — EventSub listener wiring (CHAT-01/D2-15/T-02-15)", () => {
  it("registers onChannelChatMessage with the broadcaster id passed as BOTH args and starts", () => {
    const src = fakeSource();
    const deps = makeDeps({ source: src.source });
    const handle = startTwitchChat(deps);
    expect(src.subscribeArgs).toEqual([["999", "999"]]);
    expect(src.startCount()).toBe(1);
    handle.stop();
    expect(src.stopCount()).toBe(1);
  });

  it("!suggest with intake ok builds a well-formed candidate, submits it, and registers acceptance", () => {
    const src = fakeSource();
    const intake = fakeIntake({ ok: true });
    const deps = makeDeps({ source: src.source, intake });
    startTwitchChat(deps);
    src.emitMessage(CHAT_EVENT);

    expect(deps.submitted).toHaveLength(1);
    const candidate = deps.submitted[0];
    expect(candidate).toMatchObject({
      source: "chat",
      kind: "suggestion",
      twitchUsername: "viewer1",
      text: "cool idea",
    });
    expect(candidate?.id).toBeTruthy();
    expect(typeof candidate?.submittedAtMs).toBe("number");
    expect(intake.registered).toEqual([["42", candidate?.id]]);
  });

  it.each([
    ["cooldown", "cooldown"],
    ["pending-exists", "cooldown"],
    ["duplicate", "duplicate"],
  ] as const)("intake verdict %s skips submit and sends the %s notice", (reason, kind) => {
    const src = fakeSource();
    const narrator = fakeNarrator();
    const deps = makeDeps({
      source: src.source,
      intake: fakeIntake({ ok: false, reason }),
      narrator,
    });
    startTwitchChat(deps);
    src.emitMessage(CHAT_EVENT);

    expect(deps.submitted).toHaveLength(0);
    expect(narrator.feedbackCalls).toEqual([[kind, "viewer1", undefined]]);
  });

  it("a halted submit result registers nothing and stays silent (D-02)", () => {
    const src = fakeSource();
    const intake = fakeIntake({ ok: true });
    const narrator = fakeNarrator();
    const deps = makeDeps({
      source: src.source,
      intake,
      narrator,
      submit: () => ({ accepted: false, reason: "halted" }),
    });
    startTwitchChat(deps);
    src.emitMessage(CHAT_EVENT);
    expect(intake.registered).toEqual([]);
    expect(narrator.feedbackCalls).toEqual([]);
  });

  describe("tier-1 voted commands (quick-q5n): !build / !revert / !undo through the ONE funnel", () => {
    it("!build builds a project-switch candidate carrying the idea text", () => {
      const src = fakeSource();
      const intake = fakeIntake({ ok: true });
      const deps = makeDeps({ source: src.source, intake });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!build make a snake game" });

      expect(deps.submitted).toHaveLength(1);
      expect(deps.submitted[0]).toMatchObject({
        source: "chat",
        kind: "project-switch",
        twitchUsername: "viewer1",
        text: "make a snake game",
      });
      expect(intake.registered).toEqual([["42", deps.submitted[0]?.id]]);
    });

    it("!revert builds a revert candidate carrying EXACTLY the fixed server-composed text", () => {
      const src = fakeSource();
      const deps = makeDeps({ source: src.source });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!revert" });

      expect(deps.submitted).toHaveLength(1);
      expect(deps.submitted[0]).toMatchObject({
        source: "chat",
        kind: "revert",
        twitchUsername: "viewer1",
        text: REVERT_REQUEST_TEXT,
      });
    });

    it("!undo is an alias for !revert (same candidate shape)", () => {
      const src = fakeSource();
      const deps = makeDeps({ source: src.source });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!undo" });
      expect(deps.submitted).toHaveLength(1);
      expect(deps.submitted[0]).toMatchObject({ kind: "revert", text: REVERT_REQUEST_TEXT });
    });

    it("!build runs intake.check BEFORE submit (D2-11 ordering, sequence-recorded)", () => {
      const src = fakeSource();
      const sequence: string[] = [];
      const intake: SuggestIntake = {
        check: (chatterId, text) => {
          sequence.push(`intake:${chatterId}:${text}`);
          return { ok: true };
        },
        registerAccepted: () => {
          sequence.push("register");
        },
      };
      const deps = makeDeps({
        source: src.source,
        intake,
        submit: (candidate) => {
          sequence.push(`submit:${candidate.text}`);
          return { accepted: true, id: candidate.id };
        },
      });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!build a game" });
      expect(sequence).toEqual(["intake:42:a game", "submit:a game", "register"]);
    });

    it("!revert runs intake.check with the FIXED text before submit (dedup via identical text)", () => {
      const src = fakeSource();
      const sequence: string[] = [];
      const intake: SuggestIntake = {
        check: (chatterId, text) => {
          sequence.push(`intake:${chatterId}:${text}`);
          return { ok: true };
        },
        registerAccepted: () => {
          sequence.push("register");
        },
      };
      const deps = makeDeps({
        source: src.source,
        intake,
        submit: (candidate) => {
          sequence.push(`submit:${candidate.kind}`);
          return { accepted: true, id: candidate.id };
        },
      });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!revert" });
      expect(sequence).toEqual([`intake:42:${REVERT_REQUEST_TEXT}`, "submit:revert", "register"]);
    });

    it("an intake refusal on !build narrates the notice and never submits", () => {
      const src = fakeSource();
      const narrator = fakeNarrator();
      const deps = makeDeps({
        source: src.source,
        intake: fakeIntake({ ok: false, reason: "duplicate" }),
        narrator,
      });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!build a game" });
      expect(deps.submitted).toHaveLength(0);
      expect(narrator.feedbackCalls).toEqual([["duplicate", "viewer1", undefined]]);
    });

    it("!revert with trailing text is NOT a command — ignored silently (strict no-arg)", () => {
      const src = fakeSource();
      const deps = makeDeps({ source: src.source });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!revert that thing" });
      expect(deps.submitted).toHaveLength(0);
      expect(deps.votes).toHaveLength(0);
    });
  });

  describe("!chaos dispatch seam (quick-rs3 — intake-free, gate-free by construction)", () => {
    it("!chaos routes the chatterId to the chaosVote seam and NEVER touches intake or submit", () => {
      const src = fakeSource();
      const chaosVote = vi.fn();
      const checkSpy = vi.fn(() => ({ ok: true }) as const);
      const intake: SuggestIntake = {
        check: checkSpy,
        registerAccepted: vi.fn(),
      };
      const deps = makeDeps({ source: src.source, intake, chaosVote });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!chaos" });
      expect(chaosVote).toHaveBeenCalledExactlyOnceWith("42");
      expect(checkSpy).not.toHaveBeenCalled(); // no gate call, no cooldown charged
      expect(deps.submitted).toHaveLength(0);
      expect(deps.votes).toHaveLength(0);
    });

    it("!chaos with trailing text is NOT a command — ignored silently (strict no-arg)", () => {
      const src = fakeSource();
      const chaosVote = vi.fn();
      const deps = makeDeps({ source: src.source, chaosVote });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!chaos please" });
      expect(chaosVote).not.toHaveBeenCalled();
      expect(deps.submitted).toHaveLength(0);
    });

    it("an absent chaosVote seam makes !chaos a no-op that never throws", () => {
      const src = fakeSource();
      const deps = makeDeps({ source: src.source });
      startTwitchChat(deps);
      expect(() => src.emitMessage({ ...CHAT_EVENT, messageText: "!chaos" })).not.toThrow();
      expect(deps.submitted).toHaveLength(0);
      expect(deps.votes).toHaveLength(0);
    });
  });

  describe("tier-2 info commands (quick-t8k — read-only, ZERO funnel contact)", () => {
    it.each([
      ["!projects", "projects"],
      ["!current", "current"],
      ["!repo", "repo"],
      ["!help", "help"],
      ["!commands", "help"],
    ] as const)("%s routes %s to the infoCommand seam and returns", (messageText, kind) => {
      const src = fakeSource();
      const infoCommand = vi.fn();
      const deps = makeDeps({ source: src.source, infoCommand });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText });
      expect(infoCommand).toHaveBeenCalledExactlyOnceWith(kind);
    });

    it("an info command NEVER touches intake.check, submit, or the vote ledger (no gate call, no cooldown charged)", () => {
      const src = fakeSource();
      const infoCommand = vi.fn();
      const checkSpy = vi.fn(() => ({ ok: true }) as const);
      const registerSpy = vi.fn();
      const intake: SuggestIntake = { check: checkSpy, registerAccepted: registerSpy };
      const deps = makeDeps({ source: src.source, intake, infoCommand });
      startTwitchChat(deps);
      src.emitMessage({ ...CHAT_EVENT, messageText: "!projects" });
      src.emitMessage({ ...CHAT_EVENT, messageText: "!help" });
      expect(infoCommand).toHaveBeenCalledTimes(2);
      expect(checkSpy).not.toHaveBeenCalled();
      expect(registerSpy).not.toHaveBeenCalled();
      expect(deps.submitted).toHaveLength(0);
      expect(deps.votes).toHaveLength(0);
    });

    it("an absent infoCommand seam makes info commands a silent no-op that never throws", () => {
      const src = fakeSource();
      const deps = makeDeps({ source: src.source });
      startTwitchChat(deps);
      expect(() => src.emitMessage({ ...CHAT_EVENT, messageText: "!projects" })).not.toThrow();
      expect(deps.submitted).toHaveLength(0);
      expect(deps.votes).toHaveLength(0);
    });
  });

  it("!vote 2 records a vote keyed by the EventSub chatterId", () => {
    const src = fakeSource();
    const deps = makeDeps({ source: src.source });
    startTwitchChat(deps);
    src.emitMessage({ ...CHAT_EVENT, messageText: "!vote 2" });
    expect(deps.votes).toEqual([["42", 2]]);
    expect(deps.submitted).toHaveLength(0);
  });

  it("a non-command chatter message calls nothing", () => {
    const src = fakeSource();
    const narrator = fakeNarrator();
    const deps = makeDeps({ source: src.source, narrator });
    startTwitchChat(deps);
    src.emitMessage({ ...CHAT_EVENT, messageText: "hello everyone" });
    expect(deps.submitted).toHaveLength(0);
    expect(deps.votes).toHaveLength(0);
    expect(narrator.feedbackCalls).toEqual([]);
  });

  it.each([
    [{ chatterDisplayName: "x", messageText: "!vote 1" }],
    [{ chatterId: "42", chatterDisplayName: "x" }],
    [{ chatterId: "", chatterDisplayName: "x", messageText: "!vote 1" }],
    [null],
    ["not an object"],
  ])("a zod-invalid EventSub payload %j never crashes the listener and calls nothing", (raw) => {
    const src = fakeSource();
    const deps = makeDeps({ source: src.source });
    startTwitchChat(deps);
    expect(() => src.emitMessage(raw)).not.toThrow();
    expect(deps.submitted).toHaveLength(0);
    expect(deps.votes).toHaveLength(0);
  });

  it("a downstream throw (submit throws) is caught and logged — the listener survives", () => {
    const src = fakeSource();
    const logger = fakeLogger();
    const deps = makeDeps({
      source: src.source,
      logger,
      submit: () => {
        throw new Error("boom");
      },
    });
    startTwitchChat(deps);
    expect(() => src.emitMessage(CHAT_EVENT)).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    // A later, valid message still works: the listener is alive.
    src.emitMessage({ ...CHAT_EVENT, messageText: "!vote 1" });
    expect(deps.votes).toEqual([["42", 1]]);
  });

  it("onUserSocketDisconnect logs a warning with the RESEARCH.md wording", () => {
    const src = fakeSource();
    const logger = fakeLogger();
    startTwitchChat(makeDeps({ source: src.source, logger }));
    src.emitDisconnect("999", new Error("gone"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "999" }),
      "EventSub socket disconnected — twurple will auto-reconnect",
    );
  });

  it("onUserSocketReady logs AND invokes deps.reconcile() (INFRA-02)", () => {
    const src = fakeSource();
    const logger = fakeLogger();
    const reconcile = vi.fn();
    startTwitchChat(makeDeps({ source: src.source, logger, reconcile }));
    src.emitReady("999", "session-1");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "999", sessionId: "session-1" }),
      "EventSub socket (re)connected and ready",
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
