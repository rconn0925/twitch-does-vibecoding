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
 *  - T5: the FREE REIGN usage hint, scoped to the control-window branch only
 */

const FREE_REIGN_HINT = "!build or !suggest — straight to the queue";

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

  it("T5: the FREE REIGN usage hint exists exactly once and is scoped to the control-window branch", () => {
    const src = readOverlayJs();
    // Present exactly once — no amount/message text, fixed copy only.
    const occurrences = src.split(FREE_REIGN_HINT).length - 1;
    expect(occurrences, "FREE REIGN hint must appear exactly once").toBe(1);

    // renderBanner's DEMOCRATIC and CHAOS branches both live inside the
    // `if (!cw) { … return; }` block and RETURN before the free-reign tail.
    // The hint therefore renders ONLY when a control window is active if it is
    // positioned AFTER those two early-return branches and after the FREE REIGN
    // label. Assert that ordering to prove the FREE-REIGN-only scoping.
    const chaosIdx = src.indexOf('"CHAOS MODE"');
    const democraticIdx = src.indexOf('"DEMOCRATIC MODE"');
    const freeReignLabelIdx = src.indexOf('"FREE REIGN"');
    const hintIdx = src.indexOf(FREE_REIGN_HINT);
    expect(chaosIdx).toBeGreaterThan(-1);
    expect(democraticIdx).toBeGreaterThan(-1);
    expect(freeReignLabelIdx).toBeGreaterThan(-1);
    // Hint sits after the early-returning DEMOCRATIC/CHAOS branches …
    expect(hintIdx).toBeGreaterThan(chaosIdx);
    expect(hintIdx).toBeGreaterThan(democraticIdx);
    // … and after the FREE REIGN label append (i.e. in the cw-only tail).
    expect(hintIdx).toBeGreaterThan(freeReignLabelIdx);
  });
});
