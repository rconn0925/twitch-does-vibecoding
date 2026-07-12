/**
 * EventSub chat listener wiring (CHAT-01, D2-15, INFRA-02).
 *
 * This module imports NOTHING from the Twitch SDK. The EventSub listener is
 * an injected dependency (ChatEventSource — hotkey.ts's KeyEventSource
 * pattern) so vitest never loads network code; src/main.ts's entrypoint
 * branch adapts the real EventSubWsListener behind this interface.
 *
 * Dispatch contract:
 *  - !suggest / !build / !swapbuild / !revert / !chaos (quick-q5n, quick-t8k,
 *    quick-260711-ly4) → ONE shared path: derive the candidate text (command
 *    text for suggest/build/swapbuild, the fixed REVERT_REQUEST_TEXT for revert,
 *    the fixed CHAOS_CANDIDATE_TEXT for chaos) and kind ("suggestion" /
 *    "project-switch" / "swap" / "revert" / "chaos"), then intake.check()
 *    (D2-11/D2-12, BEFORE any classifier call) → deps.submit(), which is
 *    submitCandidate pre-bound in main.ts — the ONLY intake path (COMP-01). The
 *    funnel itself is untouched. A swap's text is a project-name reference but
 *    chat-derived, so it is gate-screened like all tier-1 text (T-t8k-01).
 *  - !vote → round.recordVote(chatterId, option); invalid votes are ignored
 *    silently (D2-15 — no chat noise).
 *  - !chaos (quick-260711-ly4) rides the shared submission path above with a
 *    fixed server-composed CHAOS candidate (kind "chaos") — winning that
 *    candidate in a normal vote round is the ONLY chat path to the chaos window.
 *    Two chaos-specific rules: (1) while a chaos window is ALREADY live
 *    (deps.chaosActive) the command is a silent no-op — chaos is already
 *    running; (2) intake refusals (cooldown / duplicate-when-one-is-pooled) are
 *    SILENT for chaos, so a second !chaos while one is pooled coalesces to a
 *    quiet no-op (the pool's identical-text dedupe caps it at one).
 *  - !projects / !current / !repo / !help / !commands (quick-t8k tier-2) →
 *    deps.infoCommand?.(kind) and return. READ-ONLY contract: no gate call,
 *    no vote, no state change, no intake state touched — the seam replies
 *    from post-gate public data (project_repos slugs) only, and suppressed
 *    repeats inside the per-command cooldown window stay silent per D2-15.
 *
 * Funnel decision (quick-q5n): !revert's FIXED server-composed text still
 * passes classify(). CandidatePool.add and toQueuedTask structurally require
 * an approved GateResult, and minting one outside gate.ts would need a second
 * brand path — violating the machine-enforced single-funnel invariant
 * (tests/invariants/single-funnel.test.ts). Funnel-pass is therefore both the
 * SAFER and the SIMPLER option. Cost: one classification per pooled revert —
 * naturally deduped, because every viewer's revert carries identical text, so
 * intake refuses "duplicate" once one is pooled/pending.
 *
 * Safety: EventSub payloads are network input — twurple's TS types are
 * compile-time fiction, so the event object is zod-validated before any
 * field use, and the whole handler is wrapped so a hostile payload or a
 * downstream throw can never kill the listener (T-02-15, fail-closed).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SubmitResult } from "../pipeline/submit.js";
import type { CandidateKind, SuggestionCandidate } from "../shared/types.js";
import {
  CHAOS_CANDIDATE_TEXT,
  type InfoCommandKind,
  parseCommand,
  REVERT_REQUEST_TEXT,
} from "./command-parser.js";
import type { FeedbackKind, Narrator } from "./narration.js";
import type { SuggestIntake } from "./suggest-intake.js";

/** The chat-message fields this module consumes — EventSubChannelChatMessageEvent satisfies it. */
export interface ChatMessageEvent {
  chatterId: string;
  chatterDisplayName: string;
  messageText: string;
}

/**
 * Minimal structural subset of twurple's EventSubWsListener — the real
 * listener satisfies it via a thin adapter in main.ts; tests inject a fake
 * (mirrors hotkey.ts's KeyEventSource).
 */
export interface ChatEventSource {
  onChannelChatMessage(
    broadcasterId: string,
    userId: string,
    handler: (e: ChatMessageEvent) => void,
  ): unknown;
  onUserSocketReady(handler: (userId: string, sessionId: string) => void): unknown;
  onUserSocketDisconnect(handler: (userId: string, error?: Error) => void): unknown;
  start(): void;
  stop(): void;
}

/** Minimal structural logger — pino's Logger satisfies this (hotkey.ts pattern). */
export interface ChatIngestLogger {
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

export interface TwitchChatDeps {
  source: ChatEventSource;
  broadcasterUserId: string;
  intake: SuggestIntake;
  /** submitCandidate pre-bound with its deps in main.ts — the ONLY intake path (COMP-01). */
  submit: (candidate: SuggestionCandidate) => SubmitResult;
  round: { recordVote(id: string, option: number): boolean };
  /**
   * quick-260711-ly4: is a chat-voted chaos window CURRENTLY live? When it
   * returns true, !chaos is a silent no-op (chaos is already running, so there
   * is nothing to submit). main.ts closes over the ChaosModeController snapshot.
   * Optional — an absent seam means "never active", so !chaos always attempts to
   * pool its CHAOS candidate.
   */
  chaosActive?: () => boolean;
  /**
   * quick-t8k tier-2 info commands: !projects/!current/!repo/!help route the
   * parsed InfoCommandKind here (main.ts closes over the narrator + a
   * read-only project_repos statement + the per-command cooldown map).
   * Optional — an absent seam makes info commands a silent no-op.
   */
  infoCommand?: (kind: InfoCommandKind) => void;
  narrator: Narrator;
  /** D2-14 reconciliation, run on every EventSub (re)connect. */
  reconcile: () => void;
  logger: ChatIngestLogger;
}

/** zod at the untrusted EventSub boundary: shape-validate before any field use (T-02-15). */
const ChatMessageEventSchema = z.object({
  chatterId: z.string().min(1),
  chatterDisplayName: z.string(),
  messageText: z.string(),
});

/** Intake refusals map to quiet coalesced notices; pending-exists reads as the cooldown line. */
const INTAKE_FEEDBACK: Record<"cooldown" | "pending-exists" | "duplicate", FeedbackKind> = {
  cooldown: "cooldown",
  "pending-exists": "cooldown",
  duplicate: "duplicate",
};

export function startTwitchChat(deps: TwitchChatDeps): { stop(): void } {
  const handleMessage = (raw: ChatMessageEvent): void => {
    try {
      const parsedEvent = ChatMessageEventSchema.safeParse(raw);
      if (!parsedEvent.success) return; // malformed EventSub payload — drop, never crash
      const { chatterId, chatterDisplayName, messageText } = parsedEvent.data;

      const command = parseCommand(messageText);
      if (command === null) return; // not a command — ignored (D2-15)

      if (command.kind === "vote") {
        // Return value deliberately ignored: invalid votes are silent (D2-15).
        deps.round.recordVote(chatterId, command.option);
        return;
      }

      // Tier-2 info commands (quick-t8k) — immediately after the vote branch,
      // BEFORE !chaos and the shared tier-1 path: read-only, no intake, no
      // gate, no state change (the seam owns cooldown + HALTED silence).
      if (command.kind === "info") {
        deps.infoCommand?.(command.info);
        return;
      }

      // !chaos (quick-260711-ly4) — while a chaos window is ALREADY live, the
      // command is a silent no-op: chaos is already running, so there is
      // nothing to submit (mirrors the old already-active behavior). Otherwise
      // it falls through to the shared submission path below with kind "chaos".
      if (command.kind === "chaos" && deps.chaosActive?.()) {
        return;
      }

      // !suggest / !build / !swapbuild / !revert / !chaos — ONE shared path
      // (quick-q5n, quick-t8k, quick-260711-ly4). The text is the command text
      // for suggest/build/swapbuild, the FIXED server-composed REVERT_REQUEST_TEXT
      // for revert, and the FIXED CHAOS_CANDIDATE_TEXT for chaos (both zero
      // chat-derived bytes, T-q5n-02).
      const text =
        command.kind === "revert"
          ? REVERT_REQUEST_TEXT
          : command.kind === "chaos"
            ? CHAOS_CANDIDATE_TEXT
            : command.text;
      const kind: CandidateKind =
        command.kind === "suggest"
          ? "suggestion"
          : command.kind === "build"
            ? "project-switch"
            : command.kind === "swapbuild"
              ? "swap"
              : command.kind === "chaos"
                ? "chaos"
                : "revert";

      // Per-user limits run BEFORE classification (D2-11, closes T-01-11).
      const verdict = deps.intake.check(chatterId, text);
      if (!verdict.ok) {
        // quick-260711-ly4: !chaos dedup/cooldown refusals are SILENT — a second
        // !chaos while one is already pooled coalesces to a quiet no-op (the
        // pool's identical-text dedupe caps CHAOS at one candidate). Every other
        // tier-1 command still gets its coalesced cooldown/duplicate notice.
        if (command.kind !== "chaos") {
          deps.narrator.feedback(INTAKE_FEEDBACK[verdict.reason], chatterDisplayName);
        }
        return;
      }

      const candidate: SuggestionCandidate = {
        id: randomUUID(),
        source: "chat",
        kind,
        twitchUsername: chatterDisplayName,
        text,
        submittedAtMs: Date.now(),
      };
      const result = deps.submit(candidate);
      if (!result.accepted) {
        // D-02: the refusal is already audited by submitCandidate — no chat
        // noise while halted, and no cooldown charged for a refused attempt.
        return;
      }
      deps.intake.registerAccepted(chatterId, candidate.id);
    } catch (err) {
      // Fail-closed: a hostile payload or downstream throw must never kill
      // the listener — log and keep consuming chat (T-02-15).
      deps.logger.error({ err }, "chat message handler failed — listener stays up");
    }
  };

  // Pitfall 4: the channel.chat.message condition needs BOTH broadcaster_user_id
  // and user_id — the single-token self-subscription passes the SAME id twice.
  deps.source.onChannelChatMessage(deps.broadcasterUserId, deps.broadcasterUserId, handleMessage);

  // INFRA-02 observability (RESEARCH.md Pattern 1): twurple reconnects and
  // resubscribes on its own — we log the transitions and reconcile round
  // state against SQLite on every (re)connect.
  deps.source.onUserSocketDisconnect((userId, error) => {
    deps.logger.warn(
      { userId, err: error },
      "EventSub socket disconnected — twurple will auto-reconnect",
    );
  });
  deps.source.onUserSocketReady((userId, sessionId) => {
    deps.logger.info({ userId, sessionId }, "EventSub socket (re)connected and ready");
    deps.reconcile();
  });

  deps.source.start();
  return {
    stop(): void {
      deps.source.stop();
    },
  };
}
