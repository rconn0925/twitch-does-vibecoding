/**
 * Twitch channel-points redemption ingestion (PAID-02, D-02/D-10).
 *
 * The channel-points redemption stream rides the SAME @twurple/eventsub-ws
 * session Phase 2 already runs for chat — this file constructs NO second
 * EventSubWsListener. It exports only the boundary vocabulary: the
 * RedemptionEvent zod schema, an injected RedemptionEventSource seam
 * (mirrors twitch-chat.ts's ChatEventSource), a fail-closed raw-event
 * handler, and a toCandidate mapper into the shared SuggestionCandidate.
 * main.ts (04-08) registers the actual
 * `onChannelPointsCustomRewardRedemptionAdd`-style subscription onto the
 * existing listener and forwards each raw event into this seam's handleRaw.
 *
 * Safety: an EventSub redemption payload is untrusted third-party input
 * (attacker-controlled user_name / user_input). It is zod-validated before
 * any field use, and dispatch is wrapped so a hostile payload or a
 * downstream throw can never kill the listener (T-04-04, fail-closed —
 * mirrors twitch-chat.ts's T-02-15).
 *
 * Scope: the subscription requires `channel:read:redemptions`, which
 * Phase 2's token does NOT carry (see twitch-auth.ts). Until the broadcaster
 * re-authorizes (a deferred live gate, 04-08), the real subscription fails —
 * that failure must be surfaced LOUDLY as a degraded state (04-05 console
 * missing-scope pill), never swallowed. isMissingRedemptionScopeError is the
 * detection primitive 04-08 wires that degraded state from.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SuggestionCandidate } from "../shared/types.js";

/**
 * The OAuth scope this subscription requires. Kept here (the module that
 * needs it) and independently added to twitch-auth.ts's TWITCH_SCOPES; a unit
 * test asserts the two stay in sync so a scope drop is caught at build time.
 */
export const REDEMPTION_SCOPE = "channel:read:redemptions" as const;

/**
 * zod at the untrusted EventSub boundary — the snake_case shape Twitch's
 * `channel.channel_points_custom_reward_redemption.add` (v1) delivers
 * (04-RESEARCH Code Example 2). Validated before any field use (T-04-04).
 */
export const RedemptionEventSchema = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
  user_input: z.string(),
  status: z.string(),
  reward: z.object({
    id: z.string(),
    title: z.string(),
    cost: z.number(),
  }),
  redeemed_at: z.string(),
});

export type RedemptionEvent = z.infer<typeof RedemptionEventSchema>;

/** Minimal structural logger — pino's Logger satisfies this (twitch-chat.ts pattern). */
export interface RedemptionIngestLogger {
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

/**
 * Injected seam — mirrors twitch-chat.ts's ChatEventSource. Tests register an
 * onRedemption handler and drive it via handleRaw with zero network; main.ts
 * (04-08) forwards the real EventSub callback's payload into handleRaw.
 */
export interface RedemptionEventSource {
  onRedemption(handler: (redemption: RedemptionEvent) => void): void;
}

/**
 * Build a RedemptionEventSource plus the fail-closed `handleRaw` sink that the
 * EXISTING EventSub listener feeds. No listener is constructed here — 04-08
 * calls `listener.onChannelPointsCustomRewardRedemptionAdd(...)` on the Phase 2
 * session and passes each raw event to handleRaw.
 */
export function makeRedemptionSource(
  logger?: RedemptionIngestLogger,
): RedemptionEventSource & { handleRaw(raw: unknown): void } {
  const handlers: Array<(redemption: RedemptionEvent) => void> = [];
  return {
    onRedemption(handler) {
      handlers.push(handler);
    },
    handleRaw(raw: unknown) {
      dispatchRedemption(raw, handlers, logger);
    },
  };
}

/**
 * Fail-closed dispatch: safeParse the raw redemption, drop-with-log on a
 * malformed payload, and isolate each handler so one throwing consumer can
 * neither starve the others nor kill the listener (T-04-04).
 */
function dispatchRedemption(
  raw: unknown,
  handlers: Array<(redemption: RedemptionEvent) => void>,
  logger?: RedemptionIngestLogger,
): void {
  let parsed: ReturnType<typeof RedemptionEventSchema.safeParse>;
  try {
    parsed = RedemptionEventSchema.safeParse(raw);
  } catch (err) {
    logger?.error({ err }, "redemption parse failed — listener stays up");
    return;
  }
  if (!parsed.success) return; // malformed EventSub payload — drop, never crash
  const redemption = parsed.data;
  for (const handler of handlers) {
    try {
      handler(redemption);
    } catch (err) {
      logger?.error({ err }, "redemption handler failed — listener stays up");
    }
  }
}

/**
 * Map a validated redemption into the shared SuggestionCandidate vocabulary —
 * the SAME shape the chat path produces, so both funnel through the one gate
 * (COMP-01). The redeemer's free-text `user_input` becomes the candidate text;
 * `user_id` is the stable donor identifier (control-window cooldown keying,
 * 04-03 — display names are mutable/spoofable). No new candidate type.
 */
export function toCandidate(redemption: RedemptionEvent): SuggestionCandidate {
  return {
    id: randomUUID(),
    source: "channel_points",
    kind: "suggestion",
    twitchUsername: redemption.user_id,
    text: redemption.user_input,
    submittedAtMs: Date.now(),
  };
}

/**
 * Detect the Twitch EventSub failure raised when the redemption subscription
 * is attempted without `channel:read:redemptions` on the token. 04-08 uses
 * this to raise a LOUD degraded state (missing-scope) rather than letting the
 * subscription fail silently — the console renders a missing-scope pill
 * (04-05). Matches on the scope name and the standard 401/403 + "scope"
 * wording twurple surfaces, without depending on a twurple error class.
 */
export function isMissingRedemptionScopeError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes(REDEMPTION_SCOPE) ||
    (lower.includes("scope") &&
      (lower.includes("missing") ||
        lower.includes("required") ||
        lower.includes("401") ||
        lower.includes("403") ||
        lower.includes("unauthorized") ||
        lower.includes("forbidden")))
  );
}
