import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxOptions,
  createSandboxAdapter,
  type SandboxAdapterDeps,
  type SandboxExecFileFn,
  type SandboxSpawnFn,
  sandboxConfigFromEnv,
} from "./sandbox-process.js";

/** Matches any host-secret-shaped env key we must NEVER forward into the sandbox. */
const HOST_SECRET_KEY = /TWITCH_|ANTHROPIC_API_KEY|SECRET|TOKEN/;

/** A no-op SpawnedProcess stand-in — tests never touch a real wsl.exe. */
const FAKE_CHILD = {} as unknown as SpawnedProcess;

function spawnOpts(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: "claude",
    args: ["--print", "build the thing"],
    env: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

function captureSpawn(): {
  fn: SandboxSpawnFn;
  calls: Array<{
    command: string;
    args: readonly string[];
    options: { env: Record<string, string | undefined>; signal: AbortSignal };
  }>;
} {
  const calls: ReturnType<typeof captureSpawn>["calls"] = [];
  const fn: SandboxSpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return FAKE_CHILD;
  };
  return { fn, calls };
}

describe("sandboxConfigFromEnv", () => {
  it("falls back to the SANDBOX-SETUP.md defaults when env is unset", () => {
    const config = sandboxConfigFromEnv({});
    expect(config.distroName).toBe("vibecoding-build");
    expect(config.distroUser).toBe("builder");
    expect(config.sandboxApiKey).toBeUndefined();
  });

  it("reads exactly the env it needs and nothing else (no host-secret leakage)", () => {
    const config = sandboxConfigFromEnv({
      BUILD_DISTRO_NAME: "custom-distro",
      BUILD_DISTRO_USER: "runner",
      TWITCH_CLIENT_SECRET: "leak-me",
      ANTHROPIC_API_KEY: "host-plan-key",
    });
    expect(config.distroName).toBe("custom-distro");
    expect(config.distroUser).toBe("runner");
    expect(config.sandboxApiKey).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("leak-me");
    expect(JSON.stringify(config)).not.toContain("host-plan-key");
  });

  it("populates the fallback key ONLY from the distinct SANDBOX_ANTHROPIC_API_KEY var", () => {
    const config = sandboxConfigFromEnv({ SANDBOX_ANTHROPIC_API_KEY: "sandbox-scoped" });
    expect(config.sandboxApiKey).toBe("sandbox-scoped");
  });
});

describe("createSandboxAdapter — spawn env allowlist (SAND-03)", () => {
  it("builds an env with EXACTLY the allowlisted keys — no host secrets (primary path)", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: { distroName: "vibecoding-build", distroUser: "builder" },
      spawnFn: fn,
    });

    adapter.spawn(spawnOpts());

    const env = calls[0]?.options.env ?? {};
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(env.PATH).toBe("/usr/bin:/bin");
    for (const key of Object.keys(env)) {
      expect(key, `host-secret-shaped key leaked into sandbox env: ${key}`).not.toMatch(
        HOST_SECRET_KEY,
      );
    }
  });

  it("never leaks a host TWITCH_/ANTHROPIC_API_KEY even when present on process.env-like input", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: { distroName: "vibecoding-build", distroUser: "builder" },
      spawnFn: fn,
    });

    // opts.env carries what the SDK's default spawn would forward — it must be ignored.
    adapter.spawn(
      spawnOpts({
        env: { TWITCH_CLIENT_SECRET: "xyz", ANTHROPIC_API_KEY: "host", PATH: "/host/bin" },
      }),
    );

    const env = calls[0]?.options.env ?? {};
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.TWITCH_CLIENT_SECRET).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("injects ONLY the sandbox-scoped key when the A1-false fallback is active", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: {
        distroName: "vibecoding-build",
        distroUser: "builder",
        sandboxApiKey: "sandbox-scoped-key",
      },
      spawnFn: fn,
    });

    adapter.spawn(spawnOpts());

    const env = calls[0]?.options.env ?? {};
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "PATH"]);
    // The value is the DISTINCT sandbox-scoped credential, never a host key.
    expect(env.ANTHROPIC_API_KEY).toBe("sandbox-scoped-key");
    expect(env.PATH).toBe("/usr/bin:/bin");
  });
});

describe("createSandboxAdapter — wsl.exe argv shape", () => {
  it("spawns wsl.exe with -d <distro> -u <user> -- <command> <args...>", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: { distroName: "vibecoding-build", distroUser: "builder" },
      spawnFn: fn,
    });
    const signal = new AbortController().signal;

    adapter.spawn(spawnOpts({ command: "node", args: ["build.js", "--watch"], signal }));

    expect(calls[0]?.command).toBe("wsl.exe");
    expect(calls[0]?.args).toEqual([
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "node",
      "build.js",
      "--watch",
    ]);
    expect(calls[0]?.options.signal).toBe(signal);
  });
});

describe("createSandboxAdapter — terminate (BUILD-04)", () => {
  it("runs wsl.exe --terminate <distro>", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => undefined);
    const adapter = createSandboxAdapter({
      config: { distroName: "vibecoding-build", distroUser: "builder" },
      execFileFn,
    });

    await adapter.terminate();

    expect(execFileFn).toHaveBeenCalledWith("wsl.exe", ["--terminate", "vibecoding-build"]);
  });

  it("degrades a teardown failure to a logged error, never a throw (fail-closed)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("wsl.exe not found");
    });
    const logger = { error: vi.fn() } as unknown as NonNullable<SandboxAdapterDeps["logger"]>;
    const adapter = createSandboxAdapter({
      config: { distroName: "vibecoding-build", distroUser: "builder" },
      execFileFn,
      logger,
    });

    await expect(adapter.terminate()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("--terminate failed"),
    );
  });
});

describe("buildSandboxOptions — defense-in-depth (T-03-14)", () => {
  it("fails loud if unavailable and never silently runs unsandboxed", () => {
    const opts = buildSandboxOptions();
    expect(opts.enabled).toBe(true);
    expect(opts.failIfUnavailable).toBe(true);
  });

  it("pre-populates a package-registry network allowlist and denies /mnt", () => {
    const opts = buildSandboxOptions();
    expect(opts.network?.allowedDomains).toContain("registry.npmjs.org");
    expect(opts.filesystem?.denyRead).toContain("/mnt");
    expect(opts.filesystem?.denyWrite).toContain("/mnt");
  });
});
