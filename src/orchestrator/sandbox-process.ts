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
   * Absolute path of the distro's OWN Claude Code CLI (SANDBOX-SETUP.md installs
   * /usr/bin/claude). The SDK hands us the HOST executable (claude.exe or
   * node.exe + cli.js) — with automount and interop off it can never exist or
   * run inside the distro, so spawn() substitutes this path for it.
   */
  distroClaudePath: string;
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
    distroClaudePath: env.BUILD_DISTRO_CLAUDE_PATH ?? "/usr/bin/claude",
  };
  const scopedKey = env[SANDBOX_KEY_ENV];
  if (scopedKey) config.sandboxApiKey = scopedKey;
  return config;
}

/**
 * Absolute path of wsl.exe. The adapter deliberately spawns wsl.exe with an
 * EMPTY Windows-side environment (nothing of the host env exists in the child
 * at all — strictly stronger than an allowlist), which means the child spawn
 * cannot rely on a PATH lookup to find wsl.exe. Resolve it absolutely from the
 * system root instead. (Empirically verified: wsl.exe launches and runs distro
 * commands fine with a completely empty Windows environment block.)
 */
export function resolveWslExePath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${systemRoot}\\System32\\wsl.exe`;
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
 * Detects the SDK's node-launch shape and strips the host-only prefix.
 *
 * The SDK's spawn hook passes one of two shapes (verified against sdk.mjs):
 *   - native-binary mode: command = host claude.exe path, args = CLI flags only
 *   - node mode:          command = node executable,      args = [...nodeExecArgs, <path>/cli.js, ...CLI flags]
 * In both cases only the CLI flags are meaningful inside the distro — the host
 * executable (and cli.js path) are Windows paths that cannot exist there. The
 * presence of a cli.js entry identifies node mode; everything through it is the
 * host launch prefix and is dropped.
 */
function extractCliFlags(args: readonly string[]): string[] {
  const cliJsIndex = args.findIndex((arg) => /(^|[\\/])cli\.js$/i.test(arg));
  return cliJsIndex === -1 ? [...args] : args.slice(cliJsIndex + 1);
}

/**
 * Construct the SandboxAdapter (SAND-03 spawn + BUILD-04 terminate). `spawn`
 * IS the SDK's `spawnClaudeCodeProcess` hook. It TRANSLATES the SDK's host-side
 * launch contract into the distro's, field by field:
 *
 *   - command: the host claude.exe / node.exe+cli.js is substituted with the
 *     distro's own CLI (config.distroClaudePath); the SDK's CLI flags pass
 *     through verbatim.
 *   - argv fidelity: `--exec` bypasses the distro shell so JSON-shaped flags
 *     (--mcp-config etc.) reach the CLI argv byte-for-byte — the `--` form
 *     would route through bash and mangle quotes/backslashes.
 *   - env: the Windows-side child env is EMPTY (host env cannot cross even in
 *     principle; WSLENV is absent so nothing propagates). The sandbox allowlist
 *     env is injected Linux-side via `/usr/bin/env KEY=VAL ...` — the only way
 *     env reaches the distro process at all.
 *   - cwd: the SDK's host cwd is untranslatable with automount off; `--cd`
 *     targets opts.cwd only when it is already a POSIX absolute path, else the
 *     build user's home (`~`, where the workspace and ~/.claude login live).
 *   - wsl.exe itself is spawned by ABSOLUTE path (resolveWslExePath) because
 *     the empty child env leaves no PATH to look it up with.
 *
 * `terminate` runs the reliable, total `wsl.exe --terminate <distro>` teardown
 * — fail-closed / never-throw, because the caller (abortActiveWork) is
 * fire-and-forget.
 */
export function createSandboxAdapter(deps: SandboxAdapterDeps = {}): SandboxAdapter {
  const config = deps.config ?? sandboxConfigFromEnv();
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const execFileFn = deps.execFileFn ?? defaultExecFile;
  const logger = deps.logger;
  const wslExePath = resolveWslExePath();

  return {
    spawn(opts: SpawnOptions): SpawnedProcess {
      const envAssignments = Object.entries(buildSandboxEnv(config))
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`);
      const cd = opts.cwd?.startsWith("/") ? opts.cwd : "~";
      return spawnFn(
        wslExePath,
        [
          "-d",
          config.distroName,
          "-u",
          config.distroUser,
          "--cd",
          cd,
          "--exec",
          "/usr/bin/env",
          ...envAssignments,
          config.distroClaudePath,
          ...extractCliFlags(opts.args),
        ],
        { env: {}, signal: opts.signal },
      );
    },
    async terminate(): Promise<void> {
      try {
        await execFileFn(wslExePath, ["--terminate", config.distroName]);
      } catch (err) {
        logger?.error({ err }, "wsl.exe --terminate failed — sandbox distro may still be running");
      }
    },
    /**
     * BL-01: create the persistent-workspace dir INSIDE the distro before a
     * build turn. `wsl.exe -d <distro> -u <user> -- mkdir -p <dir>` via the
     * SAME distro/user config as spawn() — NO new env, NO widening of
     * buildSandboxEnv (the spawn env allowlist is untouched; this is a distinct
     * wsl invocation, not part of the sandboxed engine spawn). Unlike
     * terminate() (fire-and-forget), a non-zero exit is deliberately NOT
     * swallowed: it REJECTS so build-session fails the build CLOSED rather than
     * spawning into a missing dir or silently sharing one.
     *
     * The WSL boundary already lives in THIS adapter, so dir bootstrap/stat
     * belong here, not in the pure-SQLite workspace.ts.
     */
    async ensureWorkspaceDir(dir: string): Promise<void> {
      await execFileFn(wslExePath, [
        "-d",
        config.distroName,
        "-u",
        config.distroUser,
        "--",
        "mkdir",
        "-p",
        dir,
      ]);
    },
    /**
     * HI-01: is the distro workspace dir non-empty? `ls -A <dir> | head -1` via
     * a login shell; returns true when stdout has any content. A probe FAILURE
     * resolves to true (fail toward continue) — never assert "empty" when
     * unsure, so scaffold never runs over possible debris. Same distro/user
     * config; no env widening (separate wsl invocation from the engine spawn).
     */
    async workspaceHasFiles(dir: string): Promise<boolean> {
      try {
        const result = (await execFileFn(wslExePath, [
          "-d",
          config.distroName,
          "-u",
          config.distroUser,
          "--",
          "sh",
          "-lc",
          `ls -A ${dir} 2>/dev/null | head -1`,
        ])) as { stdout?: string } | undefined;
        return (result?.stdout ?? "").trim().length > 0;
      } catch (err) {
        logger?.error(
          { err, dir },
          "workspaceHasFiles probe failed — assuming non-empty (fail toward continue, HI-01)",
        );
        return true;
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
