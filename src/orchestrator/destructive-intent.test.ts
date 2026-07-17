import { describe, expect, it } from "vitest";
import { REVERT_REQUEST_TEXT } from "../ingestion/command-parser.js";
import { isDestructiveIntent } from "./destructive-intent.js";

/**
 * Destructive-intent matcher (quick-260716-rll). Live incident 2026-07-16
 * ~19:41 (audit ids 885-891): "I want you to delete the whole app" passed the
 * gate (correctly — nothing ToS-violating about it), was solo-picked, and only
 * an unrelated infra failure stopped the build agent from wiping the VOIDFARER
 * workspace.
 *
 * Policy under test (asymmetric by design):
 *  - false NEGATIVES are acceptable — the text falls through to a normal build
 *    (today's behavior);
 *  - the mandated false-POSITIVE shapes are NOT acceptable — a save-and-close
 *    is non-destructive and recoverable, but it must not fire on ordinary
 *    feature asks ("add a reset button to the app").
 */

describe("isDestructiveIntent — mandated positive table (wipe-intent MUST intercept)", () => {
  const positives = [
    "I want you to delete the whole app", // the live incident text (audit 885-891)
    "delete the app",
    "wipe the repo",
    "please nuke the project",
    "erase everything",
    "reset the whole project",
    "destroy the codebase",
    "clear it all",
    "wipe all of it",
    "DELETE EVERYTHING", // case-insensitivity
    "remove the entire repository",
  ];

  for (const text of positives) {
    it(`matches: ${JSON.stringify(text)}`, () => {
      expect(isDestructiveIntent(text)).toBe(true);
    });
  }
});

describe("isDestructiveIntent — mandated negative table (ordinary asks must build)", () => {
  const negatives = [
    // verb+noun-in-between must not bridge to a distant target
    "add a reset button to the app",
    // possessive target — the app is the OWNER, not the object
    "remove the app's dark mode",
    "remove the red button",
    "delete the second todo item",
    "clear the scoreboard when the game ends",
    "make a nuke-themed tower defense game",
    "reset the score to zero",
    "", // empty string
    // the fixed server-composed revert text is a rollback, never a wipe
    REVERT_REQUEST_TEXT,
  ];

  for (const text of negatives) {
    it(`does NOT match: ${JSON.stringify(text)}`, () => {
      expect(isDestructiveIntent(text)).toBe(false);
    });
  }
});

describe("isDestructiveIntent — total, deterministic, never throws (T-rll-01)", () => {
  it("handles a very long input without throwing (bounded linear patterns only)", () => {
    const long = `${"add a shiny button ".repeat(10_000)}and a footer`;
    expect(isDestructiveIntent(long)).toBe(false);
  });

  it("a long input that ENDS with the incident text still matches", () => {
    const long = `${"make the header blue ".repeat(5_000)}now delete the whole app`;
    expect(isDestructiveIntent(long)).toBe(true);
  });

  it("is deterministic: repeated calls agree (no lastIndex/global-flag state leaks)", () => {
    for (let i = 0; i < 3; i++) {
      expect(isDestructiveIntent("wipe the repo")).toBe(true);
      expect(isDestructiveIntent("remove the red button")).toBe(false);
    }
  });

  it("possessive with a typographic apostrophe is ALSO a negative (remove the app’s dark mode)", () => {
    expect(isDestructiveIntent("remove the app’s dark mode")).toBe(false);
  });

  it("never throws on whitespace-only / punctuation-only input", () => {
    expect(isDestructiveIntent("   ")).toBe(false);
    expect(isDestructiveIntent("!!!")).toBe(false);
  });
});
