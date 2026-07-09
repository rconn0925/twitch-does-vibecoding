/**
 * Rate-limited outbound chat sender — the ONLY module allowed to reference
 * sendChatMessage (D2-08), enforced by tests/invariants/chat-sender.test.ts.
 * Every bot message (round narration, rejection feedback, errors) flows
 * through this one p-queue so the show can never trip Twitch's chat-send
 * lockout: the default 15 msgs/30s budget leaves 85% headroom under the
 * verified 100/30s broadcaster tier (RESEARCH.md Pattern 2; T-02-06).
 *
 * Defaults come from env in the composition root (CHAT_SEND_INTERVAL_CAP /
 * CHAT_SEND_INTERVAL_MS) — this module takes plain numbers, no process.env
 * reads. p-queue strict mode closes the window-boundary burst gotcha
 * (fixed-interval buckets allow bursting at window edges otherwise).
 *
 * Fail-closed: a rejecting sink is logged and swallowed — a failed chat
 * message never throws into round-narration callers (same never-throw
 * discipline as gate.ts's classify()).
 */

import PQueue from "p-queue";
import type { Logger } from "pino";

/**
 * Structural subset of twurple's ApiClient.chat — the REAL ApiClient
 * satisfies it; tests inject a fake. Keeping this structural means this
 * module never imports @twurple/api (composition root constructs the client).
 */
export interface ChatMessageSink {
  sendChatMessage(broadcasterId: string, text: string): Promise<unknown>;
}

export interface ChatSenderDeps {
  sink: ChatMessageSink;
  broadcasterId: string;
  logger?: Logger;
  /** Max messages per interval window. Default 15 (wide margin under 100/30s). */
  intervalCap?: number;
  /** Interval window in ms. Default 30_000 (Twitch's rate-limit window). */
  intervalMs?: number;
}

export interface ChatSender {
  /** Queue a message for delivery. Resolves once the send attempt completed (or failed and was logged). */
  send(text: string): Promise<void>;
  /** Messages waiting or in flight — observability for the operator console. */
  readonly pending: number;
}

/** Twitch hard cap on chat message length (UI-SPEC narration contract). */
const TWITCH_MESSAGE_MAX_CHARS = 500;

const DEFAULT_INTERVAL_CAP = 15;
const DEFAULT_INTERVAL_MS = 30_000;

export function createChatSender(deps: ChatSenderDeps): ChatSender {
  const queue = new PQueue({
    concurrency: 1,
    intervalCap: deps.intervalCap ?? DEFAULT_INTERVAL_CAP,
    interval: deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    strict: true,
  });

  return {
    async send(text: string): Promise<void> {
      const message =
        text.length > TWITCH_MESSAGE_MAX_CHARS ? text.slice(0, TWITCH_MESSAGE_MAX_CHARS) : text;
      await queue.add(async () => {
        try {
          await deps.sink.sendChatMessage(deps.broadcasterId, message);
        } catch (err) {
          // Fail-closed: log and drop — never throw into the caller.
          deps.logger?.error(
            { err, messageLength: message.length },
            "chat send failed — message dropped (bot stays up, D2-08 fail-closed)",
          );
        }
      });
    },
    get pending(): number {
      return queue.size + queue.pending;
    },
  };
}
