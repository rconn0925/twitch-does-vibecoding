/**
 * quick-t8k orchestrator-owned preview dev-server supervisor.
 *
 * Fixes the real 260711 outage class: the manually-started 5555 http.server
 * died silently and nobody restarted it. The orchestrator now OWNS the
 * server's lifecycle: reroot() runs stop → start(workspaceDir()) → settle →
 * probe → ONE retry → fail-open, and main.ts invokes it at boot plus every
 * generation change (console new-project, project-switch rotation, swap
 * activation).
 *
 * Safety posture:
 *  - reroot() NEVER rejects and NEVER throws into any caller — every failure
 *    path resolves after a LOUD log. The preview page's standing-by state
 *    covers an unreachable server on the broadcast surface (fail-open); a
 *    supervisor failure can never crash the app or touch the halt path.
 *  - The ONLY process control used is the SandboxAdapter's optional
 *    start/stopPreviewDevServer pair (the EXISTING execFileFn seam,
 *    end-anchored pkill-by-port). The wsl distro-terminate teardown — the
 *    halt path's tool — is structurally absent from this module (T-t8k-06).
 *  - Adapters WITHOUT the optional methods (every pre-t8k test fake) get a
 *    single warn and a silent no-op — existing suites run unchanged.
 *  - Overlapping reroots serialize on an internal promise chain (the
 *    gallery-publisher chain idiom); the chain never breaks because reroot
 *    never rejects.
 */

import type { SandboxAdapter } from "../orchestrator/types.js";

/** Minimal structural logger — pino's Logger satisfies this (hotkey.ts pattern). */
export interface DevServerSupervisorLogger {
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

export interface DevServerSupervisorDeps {
  adapter: SandboxAdapter;
  /** The resolved preview dev-server port (resolvePreviewDevServerPort) — internally derived, never chat text. */
  port: number;
  /** The ACTIVE workspace dir, read at reroot time (late-bound — swap/rotation move it). */
  workspaceDir: () => string;
  /** The existing preview-manager TCP probe (fail-closed: resolves false, never rejects). */
  probeReachable: () => Promise<boolean>;
  logger: DevServerSupervisorLogger;
  /** Post-start settle before the first probe; default ~1500ms, inject 0 in tests. */
  settleMs?: number;
}

export interface DevServerSupervisor {
  /** Stop → start at the CURRENT workspace dir → probe (retry once) → fail-open. Never rejects. */
  reroot(): Promise<void>;
}

const DEFAULT_SETTLE_MS = 1_500;

export function createDevServerSupervisor(deps: DevServerSupervisorDeps): DevServerSupervisor {
  const { adapter, port, workspaceDir, probeReachable, logger } = deps;
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;

  let warnedUnsupported = false;

  async function doReroot(): Promise<void> {
    const stop = adapter.stopPreviewDevServer?.bind(adapter);
    const start = adapter.startPreviewDevServer?.bind(adapter);
    if (!stop || !start) {
      // Adapter absence (pre-t8k fakes / degraded composition): warn ONCE,
      // then silent no-ops — never noise, never a crash.
      if (!warnedUnsupported) {
        warnedUnsupported = true;
        logger.warn(
          { port },
          "sandbox adapter has no preview dev-server methods — supervisor is a no-op",
        );
      }
      return;
    }
    try {
      // The original attempt + exactly ONE retry cycle — never a spin.
      for (let attempt = 0; attempt < 2; attempt++) {
        const dir = workspaceDir(); // CURRENT dir at cycle time (late-bound)
        await stop(port);
        await start(dir, port);
        if (settleMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, settleMs);
            timer.unref();
          });
        }
        if (await probeReachable()) {
          logger.info({ dir, port, attempt }, "preview dev server is up");
          return;
        }
        logger.warn({ dir, port, attempt }, "preview dev server probe failed after start");
      }
      // FAIL-OPEN: loud, resolved — the preview page's standing-by state
      // covers the broadcast; the show loop is untouched.
      logger.error(
        { port },
        "preview dev server did NOT come up after retry — failing open to standing-by",
      );
    } catch (err) {
      logger.error({ err, port }, "preview dev server reroot failed — failing open to standing-by");
    }
  }

  // Serialization chain (gallery-publisher idiom): overlapping reroots run
  // strictly one-after-another; doReroot never rejects, so the chain never
  // breaks — but guard the chain link anyway (belt-and-braces).
  let chain: Promise<unknown> = Promise.resolve();

  return {
    reroot(): Promise<void> {
      const run = chain.then(() => doReroot());
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
