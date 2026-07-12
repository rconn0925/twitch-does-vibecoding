import { describe, expect, it } from "vitest";
import { parseCommand, REVERT_REQUEST_TEXT } from "./command-parser.js";

describe("parseCommand — !suggest", () => {
  it("parses a basic suggestion", () => {
    expect(parseCommand("!suggest build a snake game")).toEqual({
      kind: "suggest",
      text: "build a snake game",
    });
  });

  it("is case-insensitive on the command word", () => {
    expect(parseCommand("!SUGGEST x")).toEqual({ kind: "suggest", text: "x" });
    expect(parseCommand("!Suggest mixed Case Idea")).toEqual({
      kind: "suggest",
      text: "mixed Case Idea",
    });
  });

  it("trims surrounding whitespace on the message", () => {
    expect(parseCommand("   !suggest a tetris clone   ")).toEqual({
      kind: "suggest",
      text: "a tetris clone",
    });
  });

  it("returns null for !suggest with no text", () => {
    expect(parseCommand("!suggest")).toBeNull();
    expect(parseCommand("!suggest    ")).toBeNull();
  });

  it("returns null for a suggestion body over 2000 chars (CandidateSchema bound)", () => {
    const body = "a".repeat(2001);
    expect(parseCommand(`!suggest ${body}`)).toBeNull();
    // Exactly 2000 is still accepted (boundary).
    const ok = "a".repeat(2000);
    expect(parseCommand(`!suggest ${ok}`)).toEqual({ kind: "suggest", text: ok });
  });
});

describe("parseCommand — !vote", () => {
  it("parses votes for options 1-5 (quick-l2a: matches DEFAULT_ROUND_MAX_OPTIONS)", () => {
    expect(parseCommand("!vote 1")).toEqual({ kind: "vote", option: 1 });
    expect(parseCommand("!vote 2")).toEqual({ kind: "vote", option: 2 });
    expect(parseCommand("!vote 3")).toEqual({ kind: "vote", option: 3 });
    expect(parseCommand("!vote 4")).toEqual({ kind: "vote", option: 4 });
    expect(parseCommand("!vote 5")).toEqual({ kind: "vote", option: 5 });
  });

  it("is case-insensitive on the command word", () => {
    expect(parseCommand("!VOTE 2")).toEqual({ kind: "vote", option: 2 });
  });

  it("rejects out-of-range and malformed votes silently (D2-15)", () => {
    expect(parseCommand("!vote 6")).toBeNull();
    expect(parseCommand("!vote 0")).toBeNull();
    expect(parseCommand("!vote 1.5")).toBeNull();
    expect(parseCommand("!vote abc")).toBeNull();
    expect(parseCommand("!vote")).toBeNull();
    expect(parseCommand("!vote 1 2")).toBeNull();
    expect(parseCommand("!vote -1")).toBeNull();
    expect(parseCommand("!vote 10")).toBeNull();
    expect(parseCommand("!vote 22")).toBeNull();
  });
});

describe("parseCommand — !build (quick-q5n tier-1 new-project intent)", () => {
  it("parses a basic build command", () => {
    expect(parseCommand("!build make a snake game")).toEqual({
      kind: "build",
      text: "make a snake game",
    });
  });

  it("is case-insensitive on the command word", () => {
    expect(parseCommand("!BUILD x")).toEqual({ kind: "build", text: "x" });
    expect(parseCommand("!Build mixed Case Idea")).toEqual({
      kind: "build",
      text: "mixed Case Idea",
    });
  });

  it("trims surrounding whitespace on the message", () => {
    expect(parseCommand("   !build a tetris clone   ")).toEqual({
      kind: "build",
      text: "a tetris clone",
    });
  });

  it("returns null for !build with no text", () => {
    expect(parseCommand("!build")).toBeNull();
    expect(parseCommand("!build    ")).toBeNull();
  });

  it("returns null for a build body over 2000 chars (mirrors the suggest cap)", () => {
    const body = "a".repeat(2001);
    expect(parseCommand(`!build ${body}`)).toBeNull();
    const ok = "a".repeat(2000);
    expect(parseCommand(`!build ${ok}`)).toEqual({ kind: "build", text: ok });
  });
});

describe("parseCommand — !revert / !undo (quick-q5n tier-1 undo-last-change intent)", () => {
  it("parses bare !revert and bare !undo to the same revert command", () => {
    expect(parseCommand("!revert")).toEqual({ kind: "revert" });
    expect(parseCommand("!undo")).toEqual({ kind: "revert" });
  });

  it("is case-insensitive on the command word", () => {
    expect(parseCommand("!REVERT")).toEqual({ kind: "revert" });
    expect(parseCommand("!Undo")).toEqual({ kind: "revert" });
  });

  it("trims surrounding whitespace on the message", () => {
    expect(parseCommand("   !revert   ")).toEqual({ kind: "revert" });
  });

  it("rejects trailing args — no chat-derived free text may ride a revert (T-q5n-02)", () => {
    expect(parseCommand("!revert something")).toBeNull();
    expect(parseCommand("!undo the last thing")).toBeNull();
    expect(parseCommand("!revert 1")).toBeNull();
  });

  it("exports the fixed server-composed REVERT_REQUEST_TEXT constant", () => {
    expect(REVERT_REQUEST_TEXT).toBe("Revert the last change to the current project");
  });
});

describe("parseCommand — no !fork command ships (quick-q5n scope gate)", () => {
  it("returns null for !fork in any shape", () => {
    expect(parseCommand("!fork")).toBeNull();
    expect(parseCommand("!fork my project")).toBeNull();
  });
});

describe("parseCommand — non-commands and hostile input", () => {
  it("returns null for plain chat, other commands, and empty string", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("!lurk")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("suggest without bang")).toBeNull();
  });

  it("never throws on hostile strings (total function)", () => {
    const hostile = [
      "\u0000\u0000!suggest nul",
      "!suggest \u0000embedded nul",
      "!vote ‮1", // RTL override before the digit
      "‮!suggest rtl prefix",
      "!suggest 🐍🔥💀".repeat(300),
      `!suggest ${"💣".repeat(3000)}`,
      "!vote 😀",
      "﻿!vote 1", // BOM prefix
      "!suggest\t\ttabs\there",
      "!suggest\nnewline body",
      "！suggest fullwidth bang", // U+FF01
      "!suggest ".repeat(500),
      String.fromCharCode(0xd800), // lone surrogate
    ];
    for (const input of hostile) {
      expect(() => parseCommand(input)).not.toThrow();
    }
  });
});
