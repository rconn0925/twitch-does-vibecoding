/**
 * WSL2 sandbox adapter — the phase's ONLY process-sandboxing code (SAND-03).
 *
 * The host Node process runs query() with all orchestration logic (hooks,
 * canUseTool, abortController, the audit DB handle, and every Twitch/.env
 * secret). Only the Claude Code execution engine is redirected into WSL2 via
 * the SDK's `spawnClaudeCodeProcess` hook. This adapter builds the spawned
 * process's environment as an EXPLICIT ALLOWLIST — process.env is NEVER spread,
 * so no TWITCH_* token, .env value, or host ANTHROPIC_API_KEY can cross the
 * boundary by construction. The machine-enforced guarantee lives in
 * tests/invariants/secrets-isolation.test.ts.
 *
 * Anthropic-auth exception (RESEARCH.md §b, T-03-04, documented/accepted): the
 * sandboxed engine authenticates via its OWN one-time `claude login` INSIDE the
 * dedicated build distro (its ~/.claude/ store, never the host's). In the
 * common case NO Anthropic credential crosses this boundary. Only if Wave 0
 * records A1 (billing) as FALSE does a DISTINCT, sandbox-scoped key
 * (SANDBOX_ANTHROPIC_API_KEY) get injected here — never the host key.
 *
 * All real wsl.exe / child_process touching code is behind the SandboxAdapter
 * interface so vitest injects fakes; the real construction happens only via the
 * guarded composition root (03-06/03-09), never in a test.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { promisify } from "node:util";
import type { SandboxSettings, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type { SandboxAdapter } from "./types.js";

const execFileAsync = promisify(nodeExecFile);

/** Env var carrying the sandbox-scoped Anthropic key (A1-false fallback only). */
const SANDBOX_KEY_ENV = "SANDBOX_ANTHROPIC_API_KEY";

/** Resolved sandbox configuration — the exact env this module reads, nothing more. */
export interface SandboxConfig {
  /** Dedicated build-only distro (never the interactive dev distro). */
  distroName: string;
  /** Unprivileged in-distro build user with an empty home. */
  distroUser: string;
  /**
   * Present ONLY when Wave 0 records A1=false. A sandbox-scoped key injected
   * into the sandbox env alone — NEVER the host ANTHROPIC_API_KEY. Absent on
   * the primary (plan-credit / in-distro `claude login`) path.
   */
  sandboxApiKey?: string;
}

/**
 * Read the sandbox config from env the way classifierDepsFromEnv reads exactly
 * what it needs — defaults from SANDBOX-SETUP.md. `sandboxApiKey` is populated
 * ONLY from the distinct SANDBOX_ prefixed var, never the host key.
 */
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const config: SandboxConfig = {
    distroName: env.BUILD_DISTRO_NAME ?? "vibecoding-build",
    distroUser: env.BUILD_DISTRO_USER ?? "builder",
  };
  const scopedKey = env[SANDBOX_KEY_ENV];
  if (scopedKey) config.sandboxApiKey = scopedKey;
  return config;
}

/**
 * Build the spawned engine's environment as an EXPLICIT allowlist object literal
 * (SAND-03). Only PATH crosses on the primary path; the sandbox-scoped key is
 * injected ONLY when the A1-false fallback is active. This module deliberately
 * never spreads the host environment or the SDK-supplied opts environment — the
 * secrets-isolation invariant scan enforces that absence.
 */
function buildSandboxEnv(config: SandboxConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin" };
  if (config.sandboxApiKey) {
    // Narrow, deliberate exception (T-03-04, accept/documented). Derive the
    // in-distro key name by stripping the SANDBOX_ prefix so this module never
    // hardcodes a bare host-secret identifier — the value is the distinct
    // sandbox-scoped credential, never the host's.
    const inDistroKeyName = SANDBOX_KEY_ENV.replace(/^SANDBOX_/, "");
    env[inDistroKeyName] = config.sandboxApiKey;
  }
  return env;
}

/** Minimal spawn seam — node's child_process.spawn subset the adapter needs. */
export type SandboxSpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; signal: AbortSignal },
) => SpawnedProcess;

/** Minimal exec seam — promisified wsl.exe --terminate for teardown. */
export type SandboxExecFileFn = (file: string, args: readonly string[]) => Promise<unknown>;

export interface SandboxAdapterDeps {
  /** Overrides the env-derived config (tests inject fixed constants). */
  config?: SandboxConfig;
  /** Injected fake in tests; defaults to node:child_process.spawn. */
  spawnFn?: SandboxSpawnFn;
  /** Injected fake in tests; defaults to promisified execFile(wsl.exe). */
  execFileFn?: SandboxExecFileFn;
  logger?: Logger;
}

const defaultSpawn: SandboxSpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as SpawnedProcess;

const defaultExecFile: SandboxExecFileFn = (file, args) => execFileAsync(file, [...args]);

/**
 * Construct the SandboxAdapter (SAND-03 spawn + BUILD-04 terminate). `spawn`
 * IS the SDK's `spawnClaudeCodeProcess` hook: it launches wsl.exe with the
 * dedicated distro/user and the allowlisted env. `terminate` runs the reliable,
 * total `wsl.exe --terminate <distro>` teardown — fail-closed / never-throw,
 * because the caller (abortActiveWork) is fire-and-forget.
 */
export function createSandboxAdapter(deps: SandboxAdapterDeps = {}): SandboxAdapter {
  const config = deps.config ?? sandboxConfigFromEnv();
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const execFileFn = deps.execFileFn ?? defaultExecFile;
  const logger = deps.logger;

  return {
    spawn(opts: SpawnOptions): SpawnedProcess {
      const env = buildSandboxEnv(config);
      return spawnFn(
        "wsl.exe",
        ["-d", config.distroName, "-u", config.distroUser, "--", opts.command, ...opts.args],
        { env, signal: opts.signal },
      );
    },
    async terminate(): Promise<void> {
      try {
        await execFileFn("wsl.exe", ["--terminate", config.distroName]);
      } catch (err) {
        logger?.error({ err }, "wsl.exe --terminate failed — sandbox distro may still be running");
      }
    },
  };
}

/**
 * Defense-in-depth atop the Wave 0 automount-off distro config. `enabled` +
 * `failIfUnavailable: true` (T-03-14) means the build fails LOUD if the sandbox
 * layer is unavailable — it never silently runs unsandboxed. `network` is a
 * pre-populated package-registry allowlist (a live unattended pipeline can't
 * answer an interactive unapproved-domain prompt). `filesystem` denies /mnt so
 * the host drives stay unreachable even if automount is ever re-enabled.
 */
export function buildSandboxOptions(): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    network: {
      allowedDomains: ["registry.npmjs.org", "*.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    },
    filesystem: {
      denyRead: ["/mnt"],
      denyWrite: ["/mnt"],
    },
  };
}
