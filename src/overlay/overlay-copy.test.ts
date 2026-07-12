import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fixed-copy pins for the overlay client (quick-ur2, command layer C). overlay.js
 * is vanilla JS in an IIFE (no export) and the vitest env is `node` (no jsdom),
 * so these guard the exact orchestrator-authored strings by reading the source.
 *
 * Covers:
 *  - T4: the shortened suggestions phase-hint (one line at 1080p, no mid-word cut)
 */

function readOverlayJs(): string {
  return readFileSync(fileURLToPath(new URL("./public/overlay.js", import.meta.url)), "utf8");
}

describe("overlay fixed copy (quick-ur2)", () => {
  it("T4: the suggestions phase hint is the shortened one-line copy (no mid-word truncation)", () => {
    const src = readOverlayJs();
    // The exact new string — short enough to fit one line in the 900px banner.
    expect(src).toContain("type !suggest — an idea or a tweak");
    // The old copy that truncated mid-word at 1080p must be gone.
    expect(src).not.toContain("new idea or a tweak to what's on screen");
  });
});
