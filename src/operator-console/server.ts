import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import express from "express";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { listAuditRecords, recordHalt } from "../audit/record.js";
import { STATE_CHANGED } from "../shared/events.js";
import type { StateSnapshot } from "../shared/types.js";
import { triggerHalt } from "../state-machine/halt.js";
import type { StreamModeMachine } from "../state-machine/stream-mode.js";

export interface ConsoleServerDeps {
  machine: StreamModeMachine;
  db: Database.Database;
  port: number;
  logger?: Logger;
}

export interface ConsoleServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

// zod v4 validation at every untrusted boundary (ASVS V5): terse 400s, never stack traces.
const HaltBodySchema = z
  .object({
    reasonTag: z.enum(["tos-risk", "boring", "too-big", "gut-feeling", "other"]).optional(),
  })
  .strict();

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Localhost-only operator console: static UI + JSON API + ws state push.
 *
 * The explicit "127.0.0.1" listen host is this surface's ONLY access control
 * (T-01-01) — no auth exists here, so binding to 0.0.0.0 would hand the
 * kill switch to the network. Never change the host argument.
 */
export function startConsoleServer(deps: ConsoleServerDeps): Promise<ConsoleServerHandle> {
  const { machine, db, logger } = deps;
  const app = express();
  app.use(express.json());

  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir));

  app.get("/api/state", (_req, res) => {
    res.json(machine.snapshot());
  });

  app.post("/api/halt", (req, res) => {
    const parsed = HaltBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid halt request body" });
      return;
    }
    const reasonTag = parsed.data.reasonTag ?? null;

    if (machine.mode === "HALTED") {
      // Already halted: the D-18 reason-tag follow-up lands here. Record the tag
      // as its own append-only row but do NOT re-force the transition — that
      // would overwrite the frozen pre-halt snapshot the D-04 triage view needs.
      recordHalt(db, { source: "console", priorMode: "HALTED", reasonTag });
      const frozen: StateSnapshot = machine.snapshot().haltContext?.frozen ?? machine.snapshot();
      res.json(frozen);
      return;
    }

    const frozen = triggerHalt(machine, { db }, "console", reasonTag);
    res.json(frozen);
  });

  app.get("/api/audit", (req, res) => {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid audit query" });
      return;
    }
    res.json(listAuditRecords(db, { limit: parsed.data.limit }));
  });

  // Terse error boundary: invalid JSON bodies and unexpected errors must never
  // leak a stack trace to the response (T-01-03).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status: unknown }).status) || 500
          : 500;
      logger?.error({ err }, "console request failed");
      res.status(status >= 400 && status < 500 ? 400 : 500).json({ error: "request failed" });
    },
  );

  const server = createServer(app);

  // Full-state-on-connect, then push on every change (OBS overlay pattern from CLAUDE.md).
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify(machine.snapshot()));
  });
  machine.on(STATE_CHANGED, (snapshot) => {
    const payload = JSON.stringify(snapshot);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
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
