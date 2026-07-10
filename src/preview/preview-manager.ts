import { Socket } from "node:net";
import type { DevServerProbe } from "../orchestrator/types.js";

/**
 * Preview manager (03-08, PRES-03 / D3-12) — the host-side seam that answers
 * the one and only dynamic question the app-under-construction preview surface
 * is allowed to ask: "is the sandboxed dev server answering yet?"
 *
 * The sandboxed app-under-construction binds a FIXED port
 * (PREVIEW_DEV_SERVER_PORT, default 5555 per SANDBOX-SETUP.md) inside the WSL2
 * build distro; WSL2 NAT localhostForwarding makes that port reachable from the
 * Windows host at http://127.0.0.1:<port> ONE-WAY (host → sandbox). Nothing
 * about the host or orchestrator is exposed back the other direction.
 *
 * Isolation (D3-12): this manager touches ONLY 127.0.0.1:<devServerPort>. It
 * holds no orchestrator connection, reads no chat text, and knows nothing about
 * build state — its sole output is a boolean reachability signal plus the fixed
 * dev-server URL the preview page frames.
 *
 * DI seam (KeyEventSource / SandboxAdapter pattern): the real TCP probe is
 * injected as `connect` so vitest fakes reachability deterministically and
 * never opens a real socket. The real default (openTcpConnection) is used only
 * when main.ts constructs the manager for the live process.
 */

/** Default fixed dev-server port the sandboxed app binds to (SANDBOX-SETUP.md). */
export const DEFAULT_PREVIEW_DEV_SERVER_PORT = 5555;

/** Default reachability-probe timeout: short, so a poll never stalls the page. */
export const DEFAULT_PROBE_TIMEOUT_MS = 750;

/**
 * The injected TCP-probe seam. Resolves true if a connection to
 * 127.0.0.1:<port> is established within `timeoutMs`, false otherwise. A real
 * implementation MUST fail closed (resolve false, never reject) so a probe
 * error can never surface as an uncaught rejection on stream.
 */
export type TcpConnectProbe = (port: number, timeoutMs: number) => Promise<boolean>;

export interface PreviewManagerOptions {
  /** Fixed dev-server port; defaults to PREVIEW_DEV_SERVER_PORT (5555). */
  port?: number;
  /** Per-probe timeout in ms; defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injected TCP probe; defaults to the real loopback socket probe. */
  connect?: TcpConnectProbe;
}

export interface PreviewManager extends DevServerProbe {
  /** The fixed loopback dev-server URL the preview page frames — nothing else. */
  readonly devServerUrl: string;
  /** The fixed dev-server port (cosmetic; for logging/diagnostics). */
  readonly port: number;
}

/**
 * Real loopback TCP probe. Opens a socket to 127.0.0.1:<port>, resolves true on
 * `connect`, false on error/timeout. Fail-closed by construction: every failure
 * path resolves false and the socket is always destroyed — it never throws and
 * never leaks a handle. Bound to 127.0.0.1 explicitly (never a hostname that
 * could resolve off-machine).
 */
export function openTcpConnection(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Construct a preview manager. The returned `reachable()` is fail-closed: any
 * probe error (or a throwing injected probe) resolves to `false` — an
 * unreachable dev server is a normal, expected between-builds condition, never
 * an exception. The manager is stateless across a distro relaunch: after a veto
 * teardown + relaunch the port re-establishes via NAT localhostForwarding and
 * the very next `reachable()` sees it again — no manual reset step.
 */
export function createPreviewManager(options: PreviewManagerOptions = {}): PreviewManager {
  const port = options.port ?? DEFAULT_PREVIEW_DEV_SERVER_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connect = options.connect ?? openTcpConnection;
  const devServerUrl = `http://localhost:${port}`;

  return {
    devServerUrl,
    port,
    async reachable(): Promise<boolean> {
      try {
        return await connect(port, timeoutMs);
      } catch {
        // Fail closed: a probe that rejects reads as "not up yet", never an
        // error on the broadcast surface (T-03-19).
        return false;
      }
    },
  };
}

/**
 * Resolve the fixed dev-server port from the environment, falling back to the
 * SANDBOX-SETUP.md default (5555). Invalid/absent values fall back — the
 * preview surface must always have a port to frame, so it builds against the
 * documented default regardless of the pending Wave-0 sandbox verdict.
 */
export function resolvePreviewDevServerPort(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536
    ? parsed
    : DEFAULT_PREVIEW_DEV_SERVER_PORT;
}
