import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import { ROUND_CLOSED, ROUND_OPENED, STATE_CHANGED, VOTE_RECORDED } from "../shared/events.js";
import { isLoopbackHostHeader, isLoopbackOrigin } from "../shared/loopback.js";
import type { RoundSnapshot, StreamMode } from "../shared/types.js";

/**
 * Public OBS overlay server (PRES-01) — a PHYSICALLY separate localhost
 * surface from the operator console (D2-17). Read-only by construction: the
 * only routes that exist are express.static and GET /api/state. There is no
 * express.json(), no POST/PUT/DELETE/PATCH handler of any kind — a mutation
 * route that doesn't exist is the strongest possible control (T-02-20).
 *
 * Push cadence (T-02-22, UI-SPEC motion contract):
 *  - lifecycle events (STATE_CHANGED, ROUND_OPENED, ROUND_CLOSED) push
 *    immediately — they're low-frequency show beats;
 *  - VOTE_RECORDED is debounced at 300ms so a vote flood never flickers the
 *    OBS CEF render. The debounce lives HERE, on the push side — RoundManager
 *    just emits (02-RESEARCH.md Pitfall 3).
 *
 * Every push is the FULL state (full-state-on-connect + full-state diffs):
 * the payload is small, and full snapshots keep the client trivial and
 * OBS-scene-switch-reload safe (D2-18, CLAUDE.md overlay pattern).
 */

/** Public pill vocabulary — the ONLY state words that ever reach the stream (D2-18). */
export type OverlayPill = "STANDBY" | "VOTING OPEN" | "BUILDING" | "ON HOLD";

/** The full overlay state, pushed on connect and on every change. */
export interface OverlayState {
  pill: OverlayPill;
  round: RoundSnapshot | null;
  /** First 3 queued task texts, untruncated — the client truncates (UI-SPEC). */
  nextUp: string[];
}

/**
 * Structural seams (hotkey.ts KeyEventSource pattern): the overlay needs only
 * these slivers of StreamModeMachine / RoundManager / TaskQueue, so tests
 * inject plain fakes and never construct the SQLite-backed real things.
 */
export interface OverlayModeSource {
  readonly mode: StreamMode;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface OverlayRoundSource {
  snapshot(): RoundSnapshot | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface OverlayQueueSource {
  list(): readonly { text: string }[];
}

export interface OverlayServerDeps {
  machine: OverlayModeSource;
  round: OverlayRoundSource;
  taskQueue: OverlayQueueSource;
  port: number;
  /** Tally push debounce; defaults to the UI-SPEC 300ms. */
  debounceMs?: number;
  logger?: Logger;
}

export interface OverlayServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_TALLY_DEBOUNCE_MS = 300;

/**
 * Internal mode → public pill wording. The internal word "HALTED" is mapped
 * FROM here and never emitted: the broadcast surface says "ON HOLD" — honest,
 * non-alarming, never red (D2-18, T-02-21). FREE_REIGN_WINDOW / CHAOS_MODE
 * are unreachable this phase and read as STANDBY.
 */
const PILL_BY_MODE: Record<StreamMode, OverlayPill> = {
  IDLE: "STANDBY",
  VOTING_ROUND: "VOTING OPEN",
  BUILD_IN_PROGRESS: "BUILDING",
  FREE_REIGN_WINDOW: "STANDBY",
  CHAOS_MODE: "STANDBY",
  HALTED: "ON HOLD",
};

/**
 * Start the read-only overlay server. Same bootstrap/teardown shape as the
 * operator console (its verified precedent), minus everything that mutates.
 *
 * The explicit "127.0.0.1" listen host is deliberate: the overlay is reachable
 * by the local OBS browser source only (D2-17). Never change the host argument.
 */
export function startOverlayServer(deps: OverlayServerDeps): Promise<OverlayServerHandle> {
  const { machine, round, taskQueue, logger } = deps;
  const app = express();

  // ── DNS-rebinding defense (CR-02, shared with the console) ──────────
  // FIRST middleware, all methods: the Host header must name a loopback
  // host. A remote page whose DNS is rebound to 127.0.0.1 would otherwise
  // read overlay state (round candidates, queue titles) from off-machine.
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.get("host"))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir));

  /** Compose the public overlay state — round snapshot + queue titles ONLY (T-02-21). */
  function buildOverlayState(): OverlayState {
    return {
      pill: PILL_BY_MODE[machine.mode],
      round: round.snapshot(),
      nextUp: taskQueue
        .list()
        .slice(0, 3)
        .map((task) => task.text),
    };
  }

  app.get("/api/state", (_req, res) => {
    res.json(buildOverlayState());
  });

  const server = createServer(app);

  // WR-01 Origin check shared with the console: a foreign browser page must
  // not read overlay state over ws (handshakes bypass CORS). Non-browser
  // clients (no Origin) and the same-origin OBS CEF page are accepted.
  // CR-02: the Host header must ALSO be a loopback host — a DNS-rebound
  // page's Origin and Host agree with each other, so a self-referential
  // comparison alone would validate the attacker against themselves.
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: IncomingMessage }) =>
      isLoopbackHostHeader(info.req.headers.host) &&
      (info.origin === undefined ||
        (isLoopbackOrigin(info.origin) && info.origin === `http://${info.req.headers.host}`)),
  });

  function pushState(roundOverride?: RoundSnapshot): void {
    const state = buildOverlayState();
    if (roundOverride !== undefined) {
      state.round = roundOverride;
    }
    const payload = JSON.stringify(state);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(buildOverlayState()));
  });

  // Low-frequency lifecycle events push immediately. These pushes carry the
  // EVENT's own snapshot: RoundManager nulls its live round BEFORE emitting
  // ROUND_CLOSED, so snapshot() would drop the closed round (winnerOption and
  // final tally) that the client's 8-second winner beat renders from.
  machine.on(STATE_CHANGED, () => {
    pushState();
  });
  for (const roundEvent of [ROUND_OPENED, ROUND_CLOSED]) {
    round.on(roundEvent, (...args) => {
      pushState(args[0] as RoundSnapshot | undefined);
    });
  }

  // High-frequency tally events collapse into one push per debounce window:
  // the first vote arms ONE unref'd timer; every vote inside the window rides
  // the same pending push (max one tally push per 300ms under any flood).
  const debounceMs = deps.debounceMs ?? DEFAULT_TALLY_DEBOUNCE_MS;
  let tallyTimer: NodeJS.Timeout | null = null;
  round.on(VOTE_RECORDED, () => {
    if (tallyTimer !== null) return;
    tallyTimer = setTimeout(() => {
      tallyTimer = null;
      pushState();
    }, debounceMs);
    tallyTimer.unref();
  });

  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      logger?.info(
        { port: boundPort },
        "public overlay listening at http://127.0.0.1:%d",
        boundPort,
      );
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            if (tallyTimer !== null) {
              clearTimeout(tallyTimer);
              tallyTimer = null;
            }
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
