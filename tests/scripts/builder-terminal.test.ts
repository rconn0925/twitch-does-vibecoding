import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  DIFF_MAX,
  diffFeed,
  paceCharsPerTick,
  renderLine,
  sanitizeWireText,
  splitAnsiChunks,
} from "../../scripts/builder-terminal.js";

/**
 * Unit tests for the AI-scene terminal viewer's pure core (quick-260711-ly4,
 * widened by quick-nhv to the 7-kind screened wire + typewriter pacing).
 *
 * The CLI is a second client of the SAME screened /builder wire the browser
 * page consumes — these tests pin the safety-relevant rendering rules:
 *  - T-ly4-01: wire text can NEVER restyle the terminal (ESC/C0/C1 stripped
 *    before any styling is applied) — for ALL 7 kinds incl. multi-KB diffs;
 *  - fail-closed closed-kind vocabulary (unknown AND retired kinds render
 *    nothing — "snippet" is retired);
 *  - stage-warn is AMBER, never red (D2-18) — and no kind ever emits red;
 *  - diffFeed mirrors the server ring-buffer semantics (new title ⇒ reset);
 *  - backoffDelay mirrors builder.js reconnect backoff exactly;
 *  - paceCharsPerTick bounds typing lag (backlog-proportional catch-up).
 */

const ESC = "\u001b";
const AMBER_SGR = "38;5;214";
/** Red SGR sequences that must NEVER appear in any output (D2-18). */
const RED_CODES = [`${ESC}[31m`, `${ESC}[38;5;196m`];

const ALL_KINDS = ["title", "stage", "stage-warn", "activity", "reasoning", "tool-call", "diff"];

function expectNoRed(out: string | null): void {
  for (const red of RED_CODES) {
    expect(out).not.toContain(red);
  }
}

describe("sanitizeWireText", () => {
  it("strips ESC bytes so smuggled ANSI can never restyle the terminal", () => {
    const out = sanitizeWireText(`${ESC}[31mred${ESC}[0m`);
    expect(out).not.toContain(ESC);
    expect(out).toContain("red");
  });

  it("strips all C0 control characters except \\n", () => {
    const out = sanitizeWireText("a\u0000b\u0007c\u0008d\u000be\u001ff");
    expect(out).toBe("abcdef");
  });

  it("strips C1 control characters (e.g. 8-bit CSI)", () => {
    expect(sanitizeWireText("a\u009bb\u0090c")).toBe("abc");
  });

  it("neutralizes tabs (no raw \\t reaches the terminal)", () => {
    expect(sanitizeWireText("a\tb")).not.toContain("\t");
  });

  it("passes plain text through unchanged", () => {
    expect(sanitizeWireText("Writing src/app.ts")).toBe("Writing src/app.ts");
  });

  it("keeps \\n in multi-line diff text", () => {
    expect(sanitizeWireText("line one\nline two\nline three")).toBe(
      "line one\nline two\nline three",
    );
  });
});

describe("renderLine", () => {
  it("returns null for unknown kinds (fail closed)", () => {
    expect(renderLine({ kind: "bogus", text: "x" })).toBeNull();
    expect(renderLine({ kind: "", text: "x" })).toBeNull();
  });

  it("returns null for the RETIRED 'snippet' kind (fails closed like any unknown)", () => {
    expect(renderLine({ kind: "snippet", text: "old wire" })).toBeNull();
  });

  it("returns null for undefined-ish / malformed shapes", () => {
    expect(renderLine(null)).toBeNull();
    expect(renderLine(undefined)).toBeNull();
    expect(renderLine({})).toBeNull();
    expect(renderLine({ kind: "stage" })).toBeNull();
    expect(renderLine({ kind: 7, text: "x" })).toBeNull();
    expect(renderLine({ kind: "stage", text: 7 })).toBeNull();
  });

  it("produces a distinct styled string for each of the 7 kinds", () => {
    const outputs = ALL_KINDS.map((kind) => renderLine({ kind, text: "same text" }));
    for (const out of outputs) {
      expect(out).toBeTypeOf("string");
    }
    expect(new Set(outputs).size).toBe(7);
  });

  it("renders stage-warn AMBER (38;5;214) and never red (D2-18)", () => {
    const out = renderLine({ kind: "stage-warn", text: "Regrouping…" });
    expect(out).toContain(AMBER_SGR);
    expectNoRed(out);
  });

  it("never emits red for ANY of the 7 kinds", () => {
    for (const kind of ALL_KINDS) {
      const out = renderLine({ kind, text: "text" });
      expectNoRed(out);
    }
  });

  it("gives title the header treatment (rule + bold)", () => {
    const out = renderLine({ kind: "title", text: "NOW BUILDING: snake but the snake is a train" });
    expect(out).toContain("─");
    expect(out).toContain(`${ESC}[1m`);
    expect(out).toContain("NOW BUILDING: snake but the snake is a train");
  });

  it("renders reasoning as plain sanitized prose — no bullet, no marker", () => {
    const out = renderLine({ kind: "reasoning", text: "I'll wire the click handler next." });
    expect(out).toBeTypeOf("string");
    expect(out).toContain("I'll wire the click handler next.");
    expect(out).not.toContain("●");
    expect(out).not.toContain("⏺");
  });

  it("renders tool-call with the ⏺ marker, styled DISTINCTLY from activity", () => {
    const toolCall = renderLine({ kind: "tool-call", text: "Bash(npm install)" });
    const activity = renderLine({ kind: "activity", text: "Bash(npm install)" });
    expect(toolCall).toBeTypeOf("string");
    expect(toolCall).toContain("⏺");
    expect(toolCall).toContain("Bash(npm install)");
    expect(toolCall).not.toBe(activity);
  });

  it("sanitizes wire text BEFORE styling — a smuggled ESC never survives, in ANY kind", () => {
    for (const kind of ALL_KINDS) {
      const out = renderLine({ kind, text: `a${ESC}[31mb${ESC}[2Jc` });
      expect(out).toBeTypeOf("string");
      // No red SGR and no smuggled clear-screen sequence in the output.
      expectNoRed(out);
      expect(out).not.toContain(`${ESC}[2J`);
    }
  });

  it("styles each line of a multi-line diff with the gutter", () => {
    const out = renderLine({ kind: "diff", text: "one\ntwo\nthree" });
    expect(out).toBeTypeOf("string");
    const rows = (out as string).split("\n");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row).toContain("│");
    }
  });

  it("diff has NO 200-char truncation: a 5000-char input survives intact", () => {
    const long = "y".repeat(5000);
    const out = renderLine({ kind: "diff", text: long }) as string;
    expect(out).toContain("y".repeat(5000));
  });

  it("diff is backstop-capped at DIFF_MAX (16000): a larger input is truncated with an ellipsis", () => {
    expect(DIFF_MAX).toBe(16_000);
    const huge = "z".repeat(20_000);
    const out = renderLine({ kind: "diff", text: huge }) as string;
    expect(out).toContain(`${"z".repeat(16_000)}…`);
    expect(out).not.toContain("z".repeat(16_001));
  });

  it("reasoning uses the DIFF_MAX backstop too (multi-line kind, not the 120-char line cap)", () => {
    const long = "w".repeat(5000);
    const out = renderLine({ kind: "reasoning", text: long }) as string;
    expect(out).toContain("w".repeat(5000));
    const huge = "v".repeat(20_000);
    const capped = renderLine({ kind: "reasoning", text: huge }) as string;
    expect(capped).toContain(`${"v".repeat(16_000)}…`);
  });

  it("caps single-line kinds at 120 chars (backstop) — incl. tool-call", () => {
    const long = "x".repeat(500);
    for (const kind of ["activity", "tool-call"]) {
      const out = renderLine({ kind, text: long }) as string;
      expect(out).toContain(`${"x".repeat(120)}…`);
      expect(out).not.toContain("x".repeat(121));
    }
  });
});

describe("paceCharsPerTick", () => {
  it("returns the 7-char floor for small backlogs (≤1400 chars)", () => {
    expect(paceCharsPerTick(0)).toBe(7);
    expect(paceCharsPerTick(1)).toBe(7);
    expect(paceCharsPerTick(700)).toBe(7);
    expect(paceCharsPerTick(1400)).toBe(7);
  });

  it("grows ceil(backlog/200) beyond the floor — bounded catch-up", () => {
    expect(paceCharsPerTick(1401)).toBe(8);
    expect(paceCharsPerTick(2000)).toBe(10);
    expect(paceCharsPerTick(20_000)).toBe(100);
  });

  it("is monotonically non-decreasing in backlog size", () => {
    let prev = 0;
    for (const backlog of [0, 100, 1400, 1401, 3000, 10_000, 20_000, 100_000]) {
      const rate = paceCharsPerTick(backlog);
      expect(rate).toBeGreaterThanOrEqual(prev);
      prev = rate;
    }
  });
});

describe("splitAnsiChunks", () => {
  it("keeps complete SGR escape sequences as atomic chunks (never split mid-sequence)", () => {
    const chunks = splitAnsiChunks(`${ESC}[1mhello${ESC}[0m`);
    expect(chunks).toEqual([`${ESC}[1m`, "hello", `${ESC}[0m`]);
  });

  it("passes plain text through as one chunk", () => {
    expect(splitAnsiChunks("plain text")).toEqual(["plain text"]);
  });

  it("round-trips: joining the chunks reproduces the input exactly", () => {
    const styled = `${ESC}[38;5;214m● Regrouping…${ESC}[0m\nplain`;
    expect(splitAnsiChunks(styled).join("")).toBe(styled);
  });
});

describe("diffFeed", () => {
  const A = { kind: "title", text: "NOW BUILDING: app" };
  const B = { kind: "stage", text: "Writing the code" };
  const C = { kind: "title", text: "NOW BUILDING: other app" };
  const D = { kind: "stage", text: "Drafting the build plan" };

  it("appends only the tail when prev is a strict prefix of next", () => {
    const result = diffFeed([A], [A, B]);
    expect(result.reset).toBe(false);
    expect(result.appended).toEqual([B]);
  });

  it("treats an empty prev as a prefix (initial full paint appends all)", () => {
    const result = diffFeed([], [A, B]);
    expect(result.reset).toBe(false);
    expect(result.appended).toEqual([A, B]);
  });

  it("is a no-op for identical feeds (votes/pool pushes with unchanged builderFeed)", () => {
    const result = diffFeed([A, B], [A, B]);
    expect(result.reset).toBe(false);
    expect(result.appended).toEqual([]);
  });

  it("resets when next is shorter (new title cleared the server buffer)", () => {
    const result = diffFeed([A, B], [C]);
    expect(result.reset).toBe(true);
    expect(result.appended).toEqual([C]);
  });

  it("resets when the first elements differ (ring-buffer drop / reconnect replay)", () => {
    const result = diffFeed([A, B], [C, D]);
    expect(result.reset).toBe(true);
    expect(result.appended).toEqual([C, D]);
  });

  it("resets when a middle element differs even at equal length", () => {
    const result = diffFeed([A, B], [A, D]);
    expect(result.reset).toBe(true);
    expect(result.appended).toEqual([A, D]);
  });
});

describe("backoffDelay", () => {
  it("mirrors builder.js: Math.min(500 * 2 ** attempts, 8000)", () => {
    expect(backoffDelay(0)).toBe(500);
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(4)).toBe(8000);
    expect(backoffDelay(10)).toBe(8000);
  });
});
