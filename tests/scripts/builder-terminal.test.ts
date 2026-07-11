import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  diffFeed,
  renderLine,
  sanitizeWireText,
} from "../../scripts/builder-terminal.js";

/**
 * Unit tests for the AI-scene terminal viewer's pure core (quick-260711-ly4).
 *
 * The CLI is a second client of the SAME screened /builder wire the browser
 * page consumes — these tests pin the safety-relevant rendering rules:
 *  - T-ly4-01: wire text can NEVER restyle the terminal (ESC/C0/C1 stripped
 *    before any styling is applied);
 *  - fail-closed closed-kind vocabulary (unknown kinds render nothing);
 *  - stage-warn is AMBER, never red (D2-18);
 *  - diffFeed mirrors the server ring-buffer semantics (new title ⇒ reset);
 *  - backoffDelay mirrors builder.js reconnect backoff exactly.
 */

const ESC = "\u001b";
const AMBER_SGR = "38;5;214";
/** Red SGR sequences that must NEVER appear in any output (D2-18). */
const RED_CODES = [`${ESC}[31m`, `${ESC}[38;5;196m`];

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

  it("keeps \\n in multi-line snippet text", () => {
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

  it("returns null for undefined-ish / malformed shapes", () => {
    expect(renderLine(null)).toBeNull();
    expect(renderLine(undefined)).toBeNull();
    expect(renderLine({})).toBeNull();
    expect(renderLine({ kind: "stage" })).toBeNull();
    expect(renderLine({ kind: 7, text: "x" })).toBeNull();
    expect(renderLine({ kind: "stage", text: 7 })).toBeNull();
  });

  it("produces a distinct styled string for each of the 5 kinds", () => {
    const kinds = ["title", "stage", "stage-warn", "activity", "snippet"];
    const outputs = kinds.map((kind) => renderLine({ kind, text: "same text" }));
    for (const out of outputs) {
      expect(out).toBeTypeOf("string");
    }
    expect(new Set(outputs).size).toBe(5);
  });

  it("renders stage-warn AMBER (38;5;214) and never red (D2-18)", () => {
    const out = renderLine({ kind: "stage-warn", text: "Regrouping…" });
    expect(out).toContain(AMBER_SGR);
    expectNoRed(out);
  });

  it("never emits red for any kind", () => {
    for (const kind of ["title", "stage", "stage-warn", "activity", "snippet"]) {
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

  it("sanitizes wire text BEFORE styling — a smuggled ESC never survives", () => {
    for (const kind of ["title", "stage", "stage-warn", "activity", "snippet"]) {
      const out = renderLine({ kind, text: `a${ESC}[31mb${ESC}[2Jc` });
      expect(out).toBeTypeOf("string");
      // No red SGR and no smuggled clear-screen sequence in the output.
      expectNoRed(out);
      expect(out).not.toContain(`${ESC}[2J`);
    }
  });

  it("styles each line of a multi-line snippet", () => {
    const out = renderLine({ kind: "snippet", text: "one\ntwo\nthree" });
    expect(out).toBeTypeOf("string");
    const rows = (out as string).split("\n");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row).toContain("│");
    }
  });

  it("caps non-snippet lines at 120 chars (backstop, mirrors builder.js)", () => {
    const long = "x".repeat(500);
    const out = renderLine({ kind: "activity", text: long }) as string;
    expect(out).toContain(`${"x".repeat(120)}…`);
    expect(out).not.toContain("x".repeat(121));
  });

  it("caps snippet text at 200 chars (backstop, mirrors builder.js)", () => {
    const long = "y".repeat(500);
    const out = renderLine({ kind: "snippet", text: long }) as string;
    expect(out).toContain(`${"y".repeat(200)}…`);
    expect(out).not.toContain("y".repeat(201));
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
