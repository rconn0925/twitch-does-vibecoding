import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMatches, collectFiles, type ScannedFile } from "./scan-helpers.js";

/**
 * CHAOS-02 / D-08 paid<->chaos separation invariant — the machine-enforced
 * proof (Phase 4 Success Criterion 5: "verified in the architecture, not just
 * convention") that CHANCE is never wired to PAYMENT. Two comment-stripped
 * source scans plus a sabotage self-test, mirroring
 * tests/invariants/secrets-isolation.test.ts exactly.
 *
 * The two trust boundaries this guards:
 *   - The PAID path (src/control-window/** + src/pipeline/paid-window.ts) must
 *     contain NO RNG — a paid window buys guaranteed SELECTION, never a lottery.
 *   - The CHAOS path (src/chaos/** + src/pipeline/chaos.ts) must reference NO
 *     payment/donation event — the random pick reads only the already-filtered
 *     pool; no money ever reaches the selector.
 *
 * WORD-ANCHORED payment regex (plan-checker W5): the payment tokens are matched
 * only as whole identifiers, so an innocent substring (e.g. "mul-tip-le",
 * "description") can never spuriously fail the chaos scan. `\b` treats `_` as a
 * word char, so `channel_points` anchors correctly. The self-test proves BOTH
 * scans flag a planted offender AND that word-anchoring rejects innocent
 * substrings.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const files = collectFiles(SRC_DIR);

/** Any RNG call-site — forbidden anywhere on the PAID/guaranteed path. */
const RNG_TOKEN = /Math\.random|randomInt|randomUUID|crypto\.random/;

/**
 * Payment/donation identifiers — forbidden anywhere on the CHAOS/random path.
 * WORD-ANCHORED so "tip" never matches "multiple" and "cheer" never matches a
 * larger word; case-insensitive so `StreamElements` / `channel_points` are
 * caught regardless of casing.
 */
const PAYMENT_TOKEN = /\b(donation|tip|cheer|streamelements|redemption|channel_points)\b/i;

const paidFiles = files.filter(
  (f) => f.rel.startsWith("src/control-window/") || f.rel === "src/pipeline/paid-window.ts",
);
const chaosFiles = files.filter(
  (f) => f.rel.startsWith("src/chaos/") || f.rel === "src/pipeline/chaos.ts",
);

describe("CHAOS-02 paid<->chaos separation invariant (source scan)", () => {
  it("scans a plausible source tree and includes both governed module sets", () => {
    expect(files.length).toBeGreaterThan(10);
    // Non-empty guards: a silently-empty scan must never pass as clean.
    expect(paidFiles.length).toBeGreaterThan(0);
    expect(chaosFiles.length).toBeGreaterThan(0);
    // Test files are excluded — the scan governs production source only.
    expect(files.some((f) => f.rel.endsWith(".test.ts"))).toBe(false);
  });

  it("the paid/guaranteed path never references an RNG", () => {
    const offenders = [...allMatches(paidFiles, RNG_TOKEN).values()].flat();
    expect(
      offenders,
      `RNG reference in the paid/guaranteed path — chance must never attach to payment (CHAOS-02/D-08): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("the chaos/random path never references a payment/donation event", () => {
    const offenders = [...allMatches(chaosFiles, PAYMENT_TOKEN).values()].flat();
    expect(
      offenders,
      `payment reference in the chaos/random path — money must never reach the selector (CHAOS-02/D-08): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("self-test: catches planted offenders on both sides AND word-anchoring rejects innocent substrings", () => {
    const synthetic: ScannedFile[] = [
      // Planted offenders — each MUST be flagged.
      { rel: "src/control-window/rogue.ts", stripped: "const pick = Math.random();\n" },
      { rel: "src/pipeline/paid-window-rogue.ts", stripped: "const n = randomInt(0, 10);\n" },
      { rel: "src/chaos/rogue.ts", stripped: "socket.on('tip', () => pickChaos());\n" },
      { rel: "src/pipeline/chaos-rogue.ts", stripped: "import { onRedemption } from '../redemption.js';\n" },
      // Innocent substrings — must NOT be flagged (word-anchor proof).
      { rel: "src/chaos/clean.ts", stripped: "const many = pickMultiple(); // description\n" },
      { rel: "src/control-window/clean.ts", stripped: "const label = formatMmss(durationMs);\n" },
    ];

    const rngHits = allMatches(synthetic, RNG_TOKEN);
    expect(rngHits.has("src/control-window/rogue.ts")).toBe(true);
    expect(rngHits.has("src/pipeline/paid-window-rogue.ts")).toBe(true);
    expect(rngHits.has("src/control-window/clean.ts")).toBe(false);

    const paymentHits = allMatches(synthetic, PAYMENT_TOKEN);
    expect(paymentHits.has("src/chaos/rogue.ts")).toBe(true);
    expect(paymentHits.has("src/pipeline/chaos-rogue.ts")).toBe(true);
    // "multiple"/"description" contain "tip"/"tion" substrings — the word-anchored
    // regex must NOT flag them (the exact W5 false-match guard).
    expect(paymentHits.has("src/chaos/clean.ts")).toBe(false);
  });
});
