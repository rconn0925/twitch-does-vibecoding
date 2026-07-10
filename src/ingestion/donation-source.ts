/**
 * StreamElements donation ingestion (PAID-01, D-01/D-10).
 *
 * This module imports NOTHING from socket.io-client at load time in the
 * hot path used by tests — the DonationEventSource is an injected seam
 * (twitch-chat.ts's ChatEventSource pattern) so vitest never opens a
 * network socket. `connectStreamElements` is the ONLY production adapter
 * that touches socket.io-client; it is dynamically imported at the
 * composition root (04-07), never wired here.
 *
 * Safety: the StreamElements realtime socket is untrusted third-party input
 * (the tip payload carries attacker-controlled username/displayName/message).
 * Every incoming activity is zod-validated before any field use, and the
 * dispatch is wrapped so a hostile payload or a downstream throw can never
 * kill the socket handler (T-04-04, fail-closed — mirrors twitch-chat.ts's
 * T-02-15). A socket disconnect is transient: log a warn and let
 * socket.io-client auto-reconnect (like twurple's EventSub), never crash.
 */

import { z } from "zod";

/**
 * zod at the untrusted StreamElements boundary: shape-validate the tip
 * payload before any field use (T-04-04). The `message` field is
 * attacker-controlled donor text — it is surfaced (PAID-01) but is only ever
 * a SuggestionCandidate downstream, never an instruction, and is re-screened
 * at the single funnel (04-06).
 */
export const TipEventSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  message: z.string(),
  tipId: z.string(),
});

export type TipEvent = z.infer<typeof TipEventSchema>;

/**
 * StreamElements wraps every activity in `{ type, data }`; only `type: "tip"`
 * is in scope for PAID-01. A non-tip activity (cheer/follow/raid/subscriber)
 * or a malformed payload fails this parse and is dropped without throwing.
 */
const TipActivitySchema = z.object({
  type: z.literal("tip"),
  data: TipEventSchema,
});

/**
 * Minimal structural logger — pino's Logger satisfies this (twitch-chat.ts
 * ChatIngestLogger pattern). Injected so the adapter never hard-depends on a
 * concrete logger and tests can capture log lines.
 */
export interface DonationIngestLogger {
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

/**
 * Injected seam — mirrors twitch-chat.ts's ChatEventSource. Tests construct a
 * fake with zero network; main.ts (04-07) adapts the real socket behind it
 * via connectStreamElements.
 */
export interface DonationEventSource {
  onTip(handler: (tip: TipEvent) => void): void;
  onDisconnect(handler: () => void): void;
  onReady(handler: () => void): void;
}

/**
 * Minimal structural subset of socket.io-client's Socket — lets the tip
 * dispatch logic (dispatchTipActivity) be unit-tested against a fake socket
 * with no real connection, and keeps the socket.io-client import confined to
 * connectStreamElements.
 */
export interface DonationSocket {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

/**
 * The fail-closed tip dispatcher, factored out so both the production adapter
 * and tests exercise the SAME safeParse + try/catch discipline. A malformed
 * or non-tip payload is dropped (early return); a throw from a handler is
 * logged and swallowed so the socket stays up (T-04-04).
 */
function dispatchTipActivity(
  raw: unknown,
  handlers: Array<(tip: TipEvent) => void>,
  logger?: DonationIngestLogger,
): void {
  let parsed: ReturnType<typeof TipActivitySchema.safeParse>;
  try {
    parsed = TipActivitySchema.safeParse(raw);
  } catch (err) {
    // safeParse itself should not throw, but a hostile getter on `raw` could —
    // stay fail-closed (T-04-04).
    logger?.error({ err }, "donation tip parse failed — socket stays up");
    return;
  }
  if (!parsed.success) return; // non-tip activity or malformed — drop, never throw
  const tip = parsed.data.data;
  // Isolate each handler: one throwing consumer must not starve the others,
  // and never kills the socket handler (T-04-04, fail-closed).
  for (const handler of handlers) {
    try {
      handler(tip);
    } catch (err) {
      logger?.error({ err }, "donation tip handler failed — socket stays up");
    }
  }
}

/**
 * Wire a DonationEventSource onto an already-constructed socket. Split from
 * connectStreamElements so the wiring (authenticate handshake, event
 * dispatch, reconnect logging) is testable against a fake DonationSocket
 * without socket.io-client. Returns the seam.
 */
export function makeDonationSource(
  socket: DonationSocket,
  jwt: string,
  logger?: DonationIngestLogger,
): DonationEventSource {
  const tipHandlers: Array<(tip: TipEvent) => void> = [];

  // On (re)connect, authenticate; StreamElements requires the handshake
  // before it will stream events. socket.io-client re-fires "connect" on
  // every auto-reconnect, so this re-authenticates transparently.
  socket.on("connect", () => {
    socket.emit("authenticate", { method: "jwt", token: jwt });
  });

  socket.on("event", (raw: unknown) => {
    dispatchTipActivity(raw, tipHandlers, logger);
  });

  // Treat a disconnect as transient (RESEARCH Pitfall: never fatal) —
  // socket.io-client auto-reconnects with backoff, like twurple's EventSub.
  socket.on("disconnect", (reason: unknown) => {
    logger?.warn(
      { reason },
      "StreamElements socket disconnected — socket.io-client will auto-reconnect",
    );
  });

  return {
    onTip: (handler) => {
      tipHandlers.push(handler);
    },
    onDisconnect: (handler) => {
      socket.on("disconnect", handler);
    },
    onReady: (handler) => {
      socket.on("connect", handler);
    },
  };
}

/**
 * Production adapter — opens the real StreamElements realtime socket and
 * returns the injected seam. socket.io-client is imported dynamically so the
 * network dependency is loaded ONLY at the composition root (04-07), never in
 * the test path. Source: StreamElements/api-docs Websockets.md (connection
 * URL, websocket transport, jwt authenticate handshake).
 */
export async function connectStreamElements(
  jwt: string,
  logger?: DonationIngestLogger,
): Promise<DonationEventSource> {
  const { io } = await import("socket.io-client");
  const socket = io("https://realtime.streamelements.com", {
    transports: ["websocket"],
  });
  return makeDonationSource(socket as unknown as DonationSocket, jwt, logger);
}
