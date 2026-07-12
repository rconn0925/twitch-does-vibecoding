import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DevServerProbe } from "../orchestrator/types.js";
import { type PreviewServerHandle, startPreviewServer } from "./server.js";

/**
 * Preview server behavior (03-08, PRES-03 / D3-12): a read-only, no-ws third
 * surface that serves the static preview page and a thin /api/reachable proxy
 * over the injected DevServerProbe. Fake probe, ephemeral port, no real dev
 * server — the isolation contract is asserted, not the network.
 */

function fakeProbe(
  reachable: boolean | (() => Promise<boolean>),
  appReady?: boolean | (() => Promise<boolean>),
): DevServerProbe {
  const probe: DevServerProbe = {
    reachable: typeof reachable === "function" ? reachable : async () => reachable,
  };
  // Only attach appReady when explicitly supplied, so the default keeps
  // exercising the reachable()-fallback path.
  if (appReady !== undefined) {
    probe.appReady = typeof appReady === "function" ? appReady : async () => appReady;
  }
  return probe;
}

describe("preview server (read-only, isolated surface)", () => {
  const handles: PreviewServerHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
  });

  async function start(
    opts: { probe?: DevServerProbe; devServerUrl?: string } = {},
  ): Promise<PreviewServerHandle> {
    const handle = await startPreviewServer({
      probe: opts.probe ?? fakeProbe(false),
      devServerUrl: opts.devServerUrl ?? "http://localhost:5555",
      port: 0,
    });
    handles.push(handle);
    return handle;
  }

  it("serves the static preview page", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /api/reachable proxies the probe result and the fixed dev-server URL", async () => {
    const handle = await start({ probe: fakeProbe(true), devServerUrl: "http://localhost:5555" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; url: string };
    expect(body).toEqual({ reachable: true, url: "http://localhost:5555" });
  });

  it("GET /api/reachable reports false when the dev server is unreachable", async () => {
    const handle = await start({ probe: fakeProbe(false) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    const body = (await res.json()) as { reachable: boolean; url: string };
    expect(body.reachable).toBe(false);
  });

  it("prefers appReady() over reachable() when present (appReady true wins)", async () => {
    // Directory-listing boot is the inverse: reachable(TCP)=true while the app
    // isn't ready. Here appReady() true must win over reachable() false.
    const handle = await start({ probe: fakeProbe(false, true) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    const body = (await res.json()) as { reachable: boolean; url: string };
    expect(body.reachable).toBe(true);
  });

  it("reports reachable:false for a directory-listing boot (appReady false, reachable true)", async () => {
    const handle = await start({
      probe: fakeProbe(true, false),
      devServerUrl: "http://127.0.0.1:5555",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; url: string };
    expect(body).toEqual({ reachable: false, url: "http://127.0.0.1:5555" });
  });

  it("falls back to reachable() when the probe has no appReady()", async () => {
    const handle = await start({ probe: fakeProbe(true) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    const body = (await res.json()) as { reachable: boolean };
    expect(body.reachable).toBe(true);
  });

  it("fails closed: a rejecting appReady() yields { reachable: false } at HTTP 200", async () => {
    const handle = await start({
      probe: fakeProbe(true, async () => {
        throw new Error("appReady blew up");
      }),
      devServerUrl: "http://127.0.0.1:5555",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; url: string };
    // Body stays exactly { reachable, url } — no leaked error text (T-ofs-01).
    expect(body).toEqual({ reachable: false, url: "http://127.0.0.1:5555" });
  });

  it("fails closed: a rejecting probe yields { reachable: false }, never a 500", async () => {
    const handle = await start({
      probe: fakeProbe(async () => {
        throw new Error("probe blew up");
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/reachable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean };
    expect(body.reachable).toBe(false);
  });

  it("rejects a non-loopback Host header with 403 (DNS-rebinding defense, T-03-18)", async () => {
    const handle = await start({ probe: fakeProbe(true) });
    const http = await import("node:http");
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/api/reachable",
          headers: { host: `attacker.example:${handle.port}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += String(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebound.status).toBe(403);
    // No probe result / dev-server URL leaks to a rebound caller.
    expect(rebound.body).not.toContain('reachable":true');
  });

  it("has NO mutation routes — every POST/PUT/DELETE/PATCH 404s (read-only)", async () => {
    const handle = await start();
    const base = `http://127.0.0.1:${handle.port}`;
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/api/reachable", "/", "/anything"]) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "DELETE" ? undefined : "{}",
        });
        expect(res.status, `${method} ${path} must 404`).toBe(404);
      }
    }
  });

  it("binds 127.0.0.1 and close() resolves", async () => {
    const handle = await start();
    expect((handle.server.address() as AddressInfo).address).toBe("127.0.0.1");
    handles.splice(handles.indexOf(handle), 1); // closed here, not in afterEach
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("constructs NO WebSocketServer — the source imports no ws (D3-12 isolation)", () => {
    const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
    // Strip line comments so prose can't satisfy or violate the invariant.
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/WebSocketServer/);
    expect(code).not.toMatch(/from "ws"/);
    // And no orchestrator-state push: the preview holds zero orchestrator
    // connection. It may import the DevServerProbe TYPE only.
    expect(code).not.toMatch(/pushState/);
  });
});
