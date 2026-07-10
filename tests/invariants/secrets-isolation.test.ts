import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMatches, collectFiles, type ScannedFile } from "./scan-helpers.js";

/**
 * SAND-03 secrets-isolation invariant — the machine-enforced half of "host
 * secrets never cross into the WSL2 sandbox". The sandbox spawn env
 * (src/orchestrator/sandbox-process.ts) MUST be an explicit allowlist: no
 * wholesale `...process.env` / `...opts.env` spread, and no host-secret
 * identifier (TWITCH_*, the host ANTHROPIC_API_KEY, generic SECRET/TOKEN)
 * referenced in that construction. The single deliberate exception is the
 * distinct, sandbox-scoped SANDBOX_ANTHROPIC_API_KEY fallback (T-03-04).
 *
 * Comment-stripped scan (prose in comments must neither satisfy nor violate the
 * invariant), mirroring tests/invariants/chat-sender.test.ts.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const files = collectFiles(SRC_DIR);

/** The one file whose env construction this invariant governs. */
const SANDBOX_FILE = "src/orchestrator/sandbox-process.ts";

/** Wholesale environment spread — forbidden in the sandbox env construction. */
const ENV_SPREAD = /\.\.\.\s*(process\.env|opts\.env|deps\.env)/;

/**
 * Host-secret identifiers that must never be referenced in the sandbox env.
 * The negative lookbehind allows ONLY the deliberate SANDBOX_ANTHROPIC_API_KEY
 * fallback token — a bare ANTHROPIC_API_KEY (the host key) is still flagged.
 */
const HOST_SECRET = /TWITCH_|SECRET|TOKEN|(?<!SANDBOX_)ANTHROPIC_API_KEY/;

const sandboxFiles = files.filter((f) => f.rel === SANDBOX_FILE);

describe("SAND-03 secrets-isolation invariant (source scan)", () => {
  it("scans a plausible source tree and includes the sandbox env-construction file", () => {
    expect(files.length).toBeGreaterThan(10);
    // Non-empty guard: a silently-empty scan must never pass as clean.
    expect(sandboxFiles).toHaveLength(1);
    expect(files.some((f) => f.rel.endsWith(".test.ts"))).toBe(false);
  });

  it("never spreads process.env / opts.env into the sandbox env", () => {
    const offenders = [...allMatches(sandboxFiles, ENV_SPREAD).values()].flat();
    expect(
      offenders,
      `wholesale env spread in the sandbox env construction (SAND-03): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("references no host-secret identifier (only the deliberate SANDBOX_ANTHROPIC_API_KEY fallback)", () => {
    const offenders = [...allMatches(sandboxFiles, HOST_SECRET).values()].flat();
    expect(
      offenders,
      `host-secret identifier referenced in the sandbox env construction: ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("self-test: the scan catches synthetic offenders and passes clean/allowlisted input", () => {
    const synthetic: ScannedFile[] = [
      {
        rel: "src/rogue/spread-env.ts",
        stripped: "const env = { ...process.env, PATH: '/bin' };\n",
      },
      {
        rel: "src/rogue/host-token.ts",
        stripped: "env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;\n",
      },
      {
        rel: "src/rogue/twitch-leak.ts",
        stripped: "env.TWITCH_CLIENT_SECRET = cfg.secret;\n",
      },
      {
        rel: "src/ok/clean.ts",
        stripped: "const env = { PATH: '/usr/bin:/bin' };\n",
      },
      {
        rel: "src/ok/sandbox-key.ts",
        stripped: "const k = process.env.SANDBOX_ANTHROPIC_API_KEY;\n",
      },
    ];

    const spreadHits = allMatches(synthetic, ENV_SPREAD);
    expect(spreadHits.has("src/rogue/spread-env.ts")).toBe(true);
    expect(spreadHits.has("src/ok/clean.ts")).toBe(false);

    const secretHits = allMatches(synthetic, HOST_SECRET);
    expect(secretHits.has("src/rogue/host-token.ts")).toBe(true);
    expect(secretHits.has("src/rogue/twitch-leak.ts")).toBe(true);
    expect(secretHits.has("src/ok/clean.ts")).toBe(false);
    // The distinct sandbox-scoped fallback token is deliberately NOT flagged.
    expect(secretHits.has("src/ok/sandbox-key.ts")).toBe(false);
  });
});
