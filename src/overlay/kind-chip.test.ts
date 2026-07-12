import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CandidateKind } from "../shared/types.js";

/**
 * Kind-chip mapping guard (quick-ur2, command layer C). The overlay is vanilla
 * JS in an IIFE (no export), and the project's vitest env is `node` (no jsdom),
 * so this is a PURE unit test of the closed-enum → chip-label lookup and its
 * fail-closed skip rule, PLUS a drift guard that both client files (overlay.js
 * for vote rows, queue.js for the /queue lists) inline the SAME mapping.
 *
 * The invariant under test: the enum string is the only thing on the wire; the
 * chip LABEL is composed client-side from this fixed lookup, and an
 * unknown/missing kind yields NO chip (undefined → skip).
 */

// The canonical mapping — must match the KIND_CHIP const inlined in overlay.js
// and queue.js (asserted below).
const KIND_CHIP: Record<string, string> = {
  "project-switch": "NEW",
  suggestion: "TWEAK",
  swap: "SWAP",
  revert: "REVERT",
};

/** The client's skip rule: label falsy → no chip. */
function chipLabelFor(kind: string | undefined | null): string | undefined {
  return kind == null ? undefined : KIND_CHIP[kind];
}

function readClient(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)), "utf8");
}

describe("kind chip mapping (quick-ur2)", () => {
  it("maps every CandidateKind to its fixed chip label", () => {
    const expected: Record<CandidateKind, string> = {
      "project-switch": "NEW",
      suggestion: "TWEAK",
      swap: "SWAP",
      revert: "REVERT",
    };
    for (const [kind, label] of Object.entries(expected)) {
      expect(chipLabelFor(kind)).toBe(label);
    }
  });

  it("yields NO label for an unknown or missing kind (fail closed → no chip)", () => {
    expect(chipLabelFor("banana")).toBeUndefined();
    expect(chipLabelFor("")).toBeUndefined();
    expect(chipLabelFor(undefined)).toBeUndefined();
    expect(chipLabelFor(null)).toBeUndefined();
    // A falsy label is what the client tests before appending a chip.
    expect(Boolean(chipLabelFor("banana"))).toBe(false);
  });

  it("overlay.js and queue.js inline the SAME four-entry KIND_CHIP mapping (no drift)", () => {
    for (const file of ["overlay.js", "queue.js"]) {
      const src = readClient(file);
      expect(src, `${file} must define KIND_CHIP`).toContain("KIND_CHIP");
      expect(src, `${file} project-switch → NEW`).toContain('"project-switch": "NEW"');
      expect(src, `${file} suggestion → TWEAK`).toContain('suggestion: "TWEAK"');
      expect(src, `${file} swap → SWAP`).toContain('swap: "SWAP"');
      expect(src, `${file} revert → REVERT`).toContain('revert: "REVERT"');
    }
  });

  it("the chip CSS never introduces red or a new accent (Secondary/muted only)", () => {
    // overlay.css .kind-chip and queue.css .wc-chip must use the neutral tokens.
    const overlayCss = readClient("overlay.css");
    const queueCss = readClient("queue.css");
    for (const [name, css, cls] of [
      ["overlay.css", overlayCss, ".kind-chip"],
      ["queue.css", queueCss, ".wc-chip"],
    ] as const) {
      const block = css.slice(css.indexOf(cls), css.indexOf("}", css.indexOf(cls)) + 1);
      expect(block, `${name} ${cls} must exist`).toContain(cls);
      expect(block, `${name} ${cls} uses Secondary bg`).toContain("var(--secondary)");
      expect(block, `${name} ${cls} uses muted text`).toContain("var(--muted)");
      // No red, and no accent/urgency/winner/paid token — Secondary/muted only.
      for (const banned of ["red", "--accent", "--urgency", "--winner", "--paid-control"]) {
        expect(block, `${name} ${cls} must not use ${banned}`).not.toContain(banned);
      }
    }
  });
});
