/**
 * OBS control CLI (quick-260711-ly4) — the deploy/verify seam for the
 * operator-owned overlay surfaces.
 *
 * Restarting the Node app reloads only the SERVER; OBS's embedded browser (CEF)
 * caches each browser source's client JS/CSS, so a client-file deploy
 * (overlay.js/css, preview.js, commands.html, builder.js/css, queue.js/css)
 * only shows up after the source is refreshed WITH cache bypass. This tool is
 * how the assistant does that refresh itself — no throwaway helper per deploy —
 * plus screenshotting a source to verify the result on-stream.
 *
 * Runtime EVENTS (suggestions, votes, builds) never need this: the overlay is
 * a live WebSocket push, the preview auto-reloads its iframe each build, the
 * builder terminal is a live feed. Refresh is a DEPLOY action, not a per-event
 * one.
 *
 * Talks obs-websocket v5 (default ws://127.0.0.1:4455). Auth is OFF by default
 * on the streamer's machine; if a password is set in OBS, export OBS_WS_PASSWORD
 * (and optionally OBS_WS_URL) and the v5 SHA256 challenge handshake is done
 * automatically. This tool is READ + REFRESH + SCREENSHOT only — it never
 * starts/stops the stream, switches scenes, or mutates source settings.
 *
 * Commands:
 *   list                          list every input (name + kind)
 *   refresh <name...>             refresh (no-cache) the named browser source(s)
 *   refresh-all                   refresh (no-cache) every browser_source input
 *   screenshot <name> <path>      save a PNG screenshot of a source
 *
 * Run:
 *   npx tsx scripts/obs.ts list
 *   npx tsx scripts/obs.ts refresh vibe-live-overlay vibe-commands
 *   npx tsx scripts/obs.ts refresh-all
 *   npx tsx scripts/obs.ts screenshot vibe-app-preview C:/tmp/shot.png
 */

import { createHash } from "node:crypto";
import { WebSocket } from "ws";

const OBS_WS_URL = process.env.OBS_WS_URL ?? "ws://127.0.0.1:4455";
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD ?? "";
const CONNECT_TIMEOUT_MS = 8_000;

// obs-websocket v5 opcodes.
const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

interface HelloAuth {
  challenge: string;
  salt: string;
}

/** v5 auth string: base64( sha256( base64(sha256(password+salt)) + challenge ) ). */
function authString(password: string, auth: HelloAuth): string {
  const secret = createHash("sha256")
    .update(password + auth.salt)
    .digest("base64");
  return createHash("sha256")
    .update(secret + auth.challenge)
    .digest("base64");
}

interface ObsClient {
  request<T = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

function connect(): Promise<ObsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(OBS_WS_URL);
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let counter = 0;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`OBS connect timed out after ${CONNECT_TIMEOUT_MS}ms at ${OBS_WS_URL}`));
    }, CONNECT_TIMEOUT_MS);

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { op: number; d: Record<string, unknown> };
      if (msg.op === OP_HELLO) {
        const d = msg.d as { authentication?: HelloAuth; rpcVersion?: number };
        const identify: Record<string, unknown> = { rpcVersion: 1 };
        if (d.authentication) {
          if (!OBS_WS_PASSWORD) {
            clearTimeout(timeout);
            ws.close();
            reject(
              new Error(
                "OBS requires authentication but OBS_WS_PASSWORD is not set. Export it (and optionally OBS_WS_URL).",
              ),
            );
            return;
          }
          identify.authentication = authString(OBS_WS_PASSWORD, d.authentication);
        }
        ws.send(JSON.stringify({ op: OP_IDENTIFY, d: identify }));
      } else if (msg.op === OP_IDENTIFIED) {
        clearTimeout(timeout);
        resolve({
          request<T>(requestType: string, requestData: Record<string, unknown> = {}) {
            return new Promise<T>((res, rej) => {
              const requestId = `r${++counter}`;
              pending.set(requestId, {
                resolve: (v) => res(v as T),
                reject: rej,
              });
              ws.send(
                JSON.stringify({
                  op: OP_REQUEST,
                  d: { requestType, requestId, requestData },
                }),
              );
            });
          },
          close: () => ws.close(),
        });
      } else if (msg.op === OP_REQUEST_RESPONSE) {
        const d = msg.d as {
          requestId: string;
          requestStatus: { result: boolean; code: number; comment?: string };
          responseData?: Record<string, unknown>;
        };
        const p = pending.get(d.requestId);
        if (!p) return;
        pending.delete(d.requestId);
        if (d.requestStatus.result) {
          p.resolve(d.responseData ?? {});
        } else {
          p.reject(
            new Error(
              `OBS request failed (code ${d.requestStatus.code}): ${d.requestStatus.comment ?? "no comment"}`,
            ),
          );
        }
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface InputListEntry {
  inputName: string;
  inputKind: string;
}

async function listInputs(client: ObsClient): Promise<InputListEntry[]> {
  const res = await client.request<{ inputs: InputListEntry[] }>("GetInputList");
  return res.inputs;
}

/** Refresh a single browser source with cache bypass (the "refreshnocache" button). */
async function refreshSource(client: ObsClient, inputName: string): Promise<void> {
  await client.request("PressInputPropertiesButton", {
    inputName,
    propertyName: "refreshnocache",
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.error("usage: obs <list | refresh <name...> | refresh-all | screenshot <name> <path>>");
    process.exit(2);
  }

  const client = await connect();
  try {
    switch (command) {
      case "list": {
        const inputs = await listInputs(client);
        for (const i of inputs) {
          console.log(`${i.inputName}\t(${i.inputKind})`);
        }
        break;
      }
      case "refresh": {
        if (rest.length === 0) {
          console.error("refresh needs at least one source name");
          process.exitCode = 2;
          break;
        }
        for (const name of rest) {
          await refreshSource(client, name);
          console.log(`refreshed: ${name}`);
        }
        break;
      }
      case "refresh-all": {
        const inputs = await listInputs(client);
        const browsers = inputs.filter((i) => i.inputKind === "browser_source");
        if (browsers.length === 0) {
          console.log("no browser_source inputs found");
          break;
        }
        for (const b of browsers) {
          await refreshSource(client, b.inputName);
          console.log(`refreshed: ${b.inputName}`);
        }
        break;
      }
      case "screenshot": {
        const [name, path] = rest;
        if (!name || !path) {
          console.error("usage: obs screenshot <name> <path>");
          process.exitCode = 2;
          break;
        }
        await client.request("SaveSourceScreenshot", {
          sourceName: name,
          imageFormat: "png",
          imageFilePath: path,
        });
        console.log(`saved: ${path}`);
        break;
      }
      default:
        console.error(`unknown command: ${command}`);
        process.exitCode = 2;
    }
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
