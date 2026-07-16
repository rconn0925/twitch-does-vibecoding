import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../ingestion/command-parser.js";

/**
 * Sync-guard for the static /commands reference page (quick-ur2, command layer
 * C). The page lists chat commands as fixed baked copy — it has no runtime tie
 * to the parser, so it CAN drift: a removed parser branch, or a renamed/dead
 * token advertised on stream. This test is the guard against both directions.
 *
 * MAINTENANCE CONTRACT: adding (or removing) a chat command in
 * src/ingestion/command-parser.ts REQUIRES a matching update to BOTH:
 *   1. `RECOGNIZED` below (the parser's true token set), and
 *   2. src/overlay/public/commands.html (the on-screen card).
 * If you change one without the other, one of the three assertions below fails.
 * The page can NEVER advertise a token parseCommand would return null for
 * (fail-closed), and every working primary command MUST appear on the card.
 */

// The EXACT set of tokens parseCommand recognizes today (command-parser.ts).
const RECOGNIZED = [
  "!suggest",
  "!vote",
  "!build",
  "!swapbuild",
  "!revert",
  "!undo",
  "!chaos",
  "!projects",
  "!current",
  "!repo",
  "!help",
  "!commands",
  "!apps",
] as const;

// Aliases need not appear on the card (they map onto a primary token):
//  !undo → !revert, !commands → !help.
const ALIASES = new Set<string>(["!undo", "!commands"]);

// A minimal valid message per token — parseCommand MUST return non-null for
// each. Catches a removed/renamed parser branch (assertion (a)).
const SAMPLE_MESSAGE: Record<string, string> = {
  "!suggest": "!suggest add a dark mode",
  "!vote": "!vote 1",
  "!build": "!build a snake game",
  "!swapbuild": "!swapbuild paint app",
  "!revert": "!revert",
  "!undo": "!undo",
  "!chaos": "!chaos",
  "!projects": "!projects",
  "!current": "!current",
  "!repo": "!repo",
  "!help": "!help",
  "!commands": "!commands",
  "!apps": "!apps",
};

function readCommandsHtml(): string {
  return readFileSync(fileURLToPath(new URL("./public/commands.html", import.meta.url)), "utf8");
}

/**
 * Extract every distinct command-shaped token from the page. The negative
 * lookbehind for `<` skips `<!doctype …>` (and any tag/markup that opens with
 * `!`) so only real chat-command tokens in the visible copy are scanned.
 */
function pageTokens(html: string): string[] {
  const matches = html.match(/(?<!<)![a-z]+/gi) ?? [];
  return [...new Set(matches.map((t) => t.toLowerCase()))];
}

describe("commands.html stays in sync with the command parser (quick-ur2)", () => {
  it("(a) every RECOGNIZED token is a real parseCommand branch (no dead entry in the list)", () => {
    for (const token of RECOGNIZED) {
      const sample = SAMPLE_MESSAGE[token];
      expect(sample, `missing sample message for ${token}`).toBeDefined();
      expect(parseCommand(sample as string), `${token} must parse to a command`).not.toBeNull();
    }
  });

  it("(b) the page advertises ONLY parser-recognized tokens (fail-closed: no dead commands)", () => {
    const html = readCommandsHtml();
    const recognizedSet = new Set<string>(RECOGNIZED);
    for (const token of pageTokens(html)) {
      expect(recognizedSet.has(token), `commands.html advertises unrecognized token ${token}`).toBe(
        true,
      );
    }
  });

  it("(c) the page lists every working PRIMARY command", () => {
    const html = readCommandsHtml();
    const primaries = RECOGNIZED.filter((t) => !ALIASES.has(t));
    for (const token of primaries) {
      expect(html.includes(token), `commands.html is missing primary command ${token}`).toBe(true);
    }
  });

  it("has zero <script> tags — it is a pure static card with no wire dependency", () => {
    const html = readCommandsHtml();
    expect(html.toLowerCase()).not.toContain("<script");
  });
});
