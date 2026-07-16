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
 *  - quick-260716-fdl: the waiting-for-build banner copy + its voteWaiting /
 *    BUILDING-pill gating (no waiting banner during HALT/window/chaos)
 */

const FREE_REIGN_HINT = "!build or !suggest — straight to the queue";

function readOverlayJs(): string {
  return readFileSync(fileURLToPath(new URL("./public/overlay.js", import.meta.url)), "utf8");
}

describe("overlay fixed copy (quick-ur2)", () => {
  it("the suggestions phase hint is the vague, one-line participation nudge", () => {
    const src = readOverlayJs();
    // Vague copy (Ross 2026-07-11): nudges participation without naming a single
    // command; short enough to fit one line in the 900px banner.
    expect(src).toContain("type a command to jump in");
    // The old suggest-only copies (both the truncating original and the ur2
    // interim) must be gone.
    expect(src).not.toContain("new idea or a tweak to what's on screen");
    expect(src).not.toContain("type !suggest — an idea or a tweak");
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

  describe("NOW BUILDING suggester attribution (quick-260716-g8p)", () => {
    const SUGGESTER_PREFIX = "suggested by @";

    it("the attribution template appears exactly once, inside renderBuildPanel after the NOW BUILDING header", () => {
      const src = readOverlayJs();
      const occurrences = src.split(SUGGESTER_PREFIX).length - 1;
      expect(occurrences, "suggester template must appear exactly once").toBe(1);

      // Index-ordering (the FREE_REIGN_HINT idiom): the line renders inside
      // renderBuildPanel, positioned AFTER the panel header strings.
      const headerIdx = src.indexOf('"NOW BUILDING"');
      const suggesterIdx = src.indexOf(SUGGESTER_PREFIX);
      expect(headerIdx).toBeGreaterThan(-1);
      expect(suggesterIdx).toBeGreaterThan(headerIdx);
    });

    it("renders textContent-only via el() with the build-suggester class, fail-closed on missing/empty", () => {
      const src = readOverlayJs();
      // The el() helper is textContent-only construction; the class name is the
      // CSS hook. Fail-closed gate: ONLY a non-empty string renders the line —
      // null/undefined/empty yields no element, no placeholder.
      expect(src).toContain('"build-suggester"');
      expect(src).toContain('typeof bs.suggestedBy === "string" && bs.suggestedBy.length > 0');
    });
  });

  describe("done-beat PLAY IT line (quick-260716-g8p)", () => {
    const PLAY_TEMPLATE = "PLAY IT → ";

    it("the template appears exactly once, index-ordered AFTER the done-beat BUILT IT header (done-beat scoping)", () => {
      const src = readOverlayJs();
      const occurrences = src.split(PLAY_TEMPLATE).length - 1;
      expect(occurrences, "PLAY IT template must appear exactly once").toBe(1);

      // The FREE_REIGN_HINT scoping idiom: the line lives in renderBuildPanel's
      // done-beat tail — after the beat's "BUILT IT" header string.
      const builtItIdx = src.indexOf('"BUILT IT"');
      const playIdx = src.indexOf(PLAY_TEMPLATE);
      expect(builtItIdx).toBeGreaterThan(-1);
      expect(playIdx).toBeGreaterThan(builtItIdx);
    });

    it("renders ONLY on the done beat, gated on beatActive AND a playable url (fail-closed)", () => {
      const src = readOverlayJs();
      // The exact guard: beatActive (the 8s BUILT IT beat) AND a non-null
      // playable url — a live build or a null playable renders nothing.
      expect(src).toContain("beatActive && latest?.playable?.url");
      expect(src).toContain('"build-play"');
    });
  });

  describe("waiting-for-build banner (quick-260716-fdl)", () => {
    const WAITING_TITLE = "BUILDING — vote opens when it's done";
    const WAITING_HINT = "keep the !suggest ideas coming";

    it("pins the exact waiting copy — fixed title and hint, never chat-derived", () => {
      const src = readOverlayJs();
      expect(src).toContain(WAITING_TITLE);
      expect(src).toContain(WAITING_HINT);
    });

    it("the branch is gated on voteWaiting AND the BUILDING pill, sits between VOTE NOW and the suggest banner (priority: VOTE NOW > waiting > suggestions)", () => {
      const src = readOverlayJs();
      const titleIdx = src.indexOf(WAITING_TITLE);
      expect(titleIdx).toBeGreaterThan(-1);

      // Gated on the wire boolean AND the BUILDING pill: while HALTED the pill
      // reads ON HOLD (and FREE REIGN / CHAOS own the show), so the waiting
      // banner never renders outside a live build.
      const gateIdx = src.indexOf("voteWaiting");
      const pillGateIdx = src.indexOf('pill === "BUILDING"');
      expect(gateIdx, "banner must be gated on latest.voteWaiting").toBeGreaterThan(-1);
      expect(pillGateIdx, "banner must be gated on the BUILDING pill").toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(titleIdx);
      expect(pillGateIdx).toBeLessThan(titleIdx);

      // Slot priority inside renderPhaseBanner: the live-round VOTE NOW branch
      // returns first, the waiting branch second, the suggest countdown third.
      const voteNowIdx = src.indexOf('"VOTE NOW"');
      const suggestTitleIdx = src.indexOf('"Suggestions open:"');
      expect(voteNowIdx).toBeGreaterThan(-1);
      expect(suggestTitleIdx).toBeGreaterThan(-1);
      expect(voteNowIdx).toBeLessThan(titleIdx);
      expect(titleIdx).toBeLessThan(suggestTitleIdx);
    });

    it("the existing suggest-banner and T4 hint pins are undisturbed by the new branch", () => {
      const src = readOverlayJs();
      expect(src).toContain('"Suggestions open:"');
      expect(src).toContain("type a command to jump in");
      // The waiting banner renders NO countdown element (no deadline exists) —
      // exactly one hint per banner branch, fixed copy only.
      const occurrences = src.split(WAITING_HINT).length - 1;
      expect(occurrences, "waiting hint must appear exactly once").toBe(1);
    });
  });
});
