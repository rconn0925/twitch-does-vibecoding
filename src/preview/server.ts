import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import type { DevServerProbe } from "../orchestrator/types.js";
import { isLoopbackHostHeader } from "../shared/loopback.js";

/**
 * App-under-construction preview server (PRES-03 / D3-12) — the THIRD localhost
 * surface, alongside the operator console and public overlay. It frames the
 * sandboxed dev server so viewers watch the app come alive.
 *
 * Strictly isolated by construction (D3-12): unlike the overlay, this server
 * opens no ws push channel and holds no orchestrator connection of any kind. It
 * serves exactly two things:
 *  - the static preview page (express.static), and
 *  - GET /api/reachable — a thin proxy over the injected DevServerProbe that
 *    returns only { reachable, url }. No orchestrator state, no chat text, no
 *    host/console surface ever crosses this boundary (T-03-17).
 *
 * Read-only by construction: there is no express.json() and no POST/PUT/DELETE/
 * PATCH handler at all — a mutation route that doesn't exist is the strongest
 * possible control. The first middleware is the shared loopback Host-allowlist
 * (DNS-rebinding defense, T-03-18), and the listen host is pinned to 127.0.0.1.
 */

export interface PreviewServerDeps {
  /** Reachability seam (03-08 preview-manager); proxied by GET /api/reachable. */
  probe: DevServerProbe;
  /** The fixed dev-server URL the preview page frames — the ONLY dynamic-ish
   *  value exposed, and it is a static cosmetic config, not orchestrator state. */
  devServerUrl: string;
  /** Listen port for THIS surface (not the dev-server port). */
  port: number;
  logger?: Logger;
}

export interface PreviewServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the read-only preview server. Same bootstrap/teardown shape as the
 * overlay server (its verified precedent), minus the WebSocketServer entirely.
 *
 * The explicit "127.0.0.1" listen host is deliberate: the preview is reachable
 * by the local OBS browser source only (D3-12). Never change the host argument.
 */
export function startPreviewServer(deps: PreviewServerDeps): Promise<PreviewServerHandle> {
  const { probe, devServerUrl, logger } = deps;
  const app = express();

  // ── DNS-rebinding defense (T-03-18, shared with console + overlay) ──────
  // FIRST middleware, all methods: the Host header must name a loopback host.
  // A remote page whose DNS is rebound to 127.0.0.1 would otherwise reach this
  // surface. Shared isLoopbackHostHeader — the THIRD surface to import it, so
  // the three can never drift apart.
  app.use((req, res, next) => {
    if (!isLoopbackHostHeader(req.get("host"))) {
      res.status(403).json({ error: "forbidden host" });
      return;
    }
    next();
  });

  // The preview page is preview.html (not index.html): serve it at "/" so a
  // dedicated OBS Browser Source can point at the bare origin.
  const publicDir = fileURLToPath(new URL("./public", import.meta.url));
  app.use(express.static(publicDir, { index: "preview.html" }));

  // The ONLY dynamic route: a thin proxy over the DevServerProbe. It exposes a
  // boolean + the fixed dev-server URL and NOTHING else — no orchestrator
  // state, no chat text, no error detail (T-03-17/T-03-19). Fail-closed: a
  // probe that somehow rejects reads as "not up yet", never a 500 on stream.
  app.get("/api/reachable", async (_req, res) => {
    let reachable = false;
    try {
      reachable = await probe.reachable();
    } catch {
      reachable = false;
    }
    res.json({ reachable, url: devServerUrl });
  });

  const server = createServer(app);

  return new Promise((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(deps.port, "127.0.0.1", () => {
      const boundPort = (server.address() as AddressInfo).port;
      logger?.info(
        { port: boundPort },
        "app-under-construction preview listening at http://127.0.0.1:%d",
        boundPort,
      );
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
