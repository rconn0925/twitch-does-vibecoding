import { describe, expect, it } from "vitest";
import {
  BURST_DRAIN_CHARS,
  backoffDelay,
  DIFF_MAX,
  diffFeed,
  fileStatsFromFeed,
  formatElapsed,
  isBuildInFlight,
  LINE_MAX,
  paceCharsPerTick,
  renderLine,
  sanitizeWireText,
  splitAnsiChunks,
  THINKING_QUIET_MS,
  thinkingStatusLine,
} from "../../scripts/builder-terminal.js";
import { createBuilderFeed } from "../../src/overlay/builder-feed.js";

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

describe("paceCharsPerTick (burst-drain rework, quick-rtd)", () => {
  it("returns the 7-char floor for small backlogs (≤280 chars)", () => {
    expect(paceCharsPerTick(0)).toBe(7);
    expect(paceCharsPerTick(1)).toBe(7);
    expect(paceCharsPerTick(140)).toBe(7);
    expect(paceCharsPerTick(280)).toBe(7);
  });

  it("grows ceil(backlog/40) beyond the floor — ≈2s decay constant", () => {
    expect(paceCharsPerTick(281)).toBe(8);
    expect(paceCharsPerTick(400)).toBe(10);
    expect(paceCharsPerTick(2000)).toBe(50);
    expect(paceCharsPerTick(7999)).toBe(200);
  });

  it("blits huge bursts instantly: backlog ≥ BURST_DRAIN_CHARS drains in one tick", () => {
    expect(BURST_DRAIN_CHARS).toBe(8_000);
    expect(paceCharsPerTick(8_000)).toBe(8_000);
    expect(paceCharsPerTick(16_000)).toBe(16_000);
  });

  it("is monotonically non-decreasing in backlog size — including across the 8000 jump", () => {
    let prev = 0;
    for (const backlog of [0, 100, 280, 281, 3000, 7999, 8000, 16_000, 100_000]) {
      const rate = paceCharsPerTick(backlog);
      expect(rate).toBeGreaterThanOrEqual(prev);
      prev = rate;
    }
  });

  it("drains ANY backlog within ≤10s of ticks — seconds, not minutes", () => {
    const TICK_MS = 50;
    for (const start of [16_000, 7_999]) {
      let backlog = start;
      let ticks = 0;
      while (backlog > 0) {
        backlog -= paceCharsPerTick(backlog);
        ticks += 1;
      }
      expect(ticks * TICK_MS).toBeLessThanOrEqual(10_000);
    }
  });
});

describe("formatElapsed", () => {
  it("renders sub-minute durations as seconds only", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(40_000)).toBe("40s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("renders sub-hour durations as minutes + seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(160_000)).toBe("2m 40s");
    expect(formatElapsed(3_599_999)).toBe("59m 59s");
  });

  it("renders hour-plus durations as hours + minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });

  it("clamps negative and NaN inputs to 0s", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

describe("isBuildInFlight", () => {
  it("is false for an empty feed (undefined last line — idle)", () => {
    expect(isBuildInFlight(undefined)).toBe(false);
  });

  it("is false when the last line is a terminal state (stage-warn / done caption)", () => {
    expect(isBuildInFlight({ kind: "stage-warn", text: "Regrouping…" })).toBe(false);
    expect(isBuildInFlight({ kind: "stage-warn", text: "Skipping this one" })).toBe(false);
    expect(isBuildInFlight({ kind: "stage", text: "Live on screen now" })).toBe(false);
  });

  it("is true for every in-progress kind (title / other stage / activity / reasoning / tool-call / diff)", () => {
    expect(isBuildInFlight({ kind: "title", text: "NOW BUILDING: app" })).toBe(true);
    expect(isBuildInFlight({ kind: "stage", text: "Writing the code" })).toBe(true);
    expect(isBuildInFlight({ kind: "activity", text: "Writing src/app.ts" })).toBe(true);
    expect(isBuildInFlight({ kind: "reasoning", text: "Next I'll wire the handler." })).toBe(true);
    expect(isBuildInFlight({ kind: "tool-call", text: "Bash(npm install)" })).toBe(true);
    expect(isBuildInFlight({ kind: "diff", text: "+const x = 1;" })).toBe(true);
  });

  it("fails closed on unknown kinds", () => {
    expect(isBuildInFlight({ kind: "snippet", text: "retired" })).toBe(false);
    expect(isBuildInFlight({ kind: "bogus", text: "x" })).toBe(false);
    expect(isBuildInFlight({ kind: "", text: "x" })).toBe(false);
  });

  it("caption-sync: tracks the REAL server captions via createBuilderFeed (drift breaks CI)", () => {
    const done = createBuilderFeed();
    done.stage("done");
    const doneLines = done.list();
    expect(isBuildInFlight(doneLines[doneLines.length - 1])).toBe(false);

    const building = createBuilderFeed();
    building.stage("building");
    const buildingLines = building.list();
    expect(isBuildInFlight(buildingLines[buildingLines.length - 1])).toBe(true);

    const failed = createBuilderFeed();
    failed.stage("failed");
    const failedLines = failed.list();
    expect(isBuildInFlight(failedLines[failedLines.length - 1])).toBe(false);
  });
});

describe("fileStatsFromFeed", () => {
  it("returns zeros and null lastPath for an empty feed", () => {
    expect(fileStatsFromFeed([])).toEqual({ written: 0, edited: 0, lastPath: null });
  });

  it("counts DISTINCT paths per verb and tracks the last activity path", () => {
    const stats = fileStatsFromFeed([
      { kind: "activity", text: "Writing src/a.ts" },
      { kind: "activity", text: "Writing src/a.ts" },
      { kind: "activity", text: "Writing src/b.ts" },
      { kind: "activity", text: "Editing src/a.ts" },
    ]);
    expect(stats.written).toBe(2);
    expect(stats.edited).toBe(1);
    expect(stats.lastPath).toBe("src/a.ts");
  });

  it("lastPath follows the LAST activity line regardless of verb", () => {
    const stats = fileStatsFromFeed([
      { kind: "activity", text: "Writing src/a.ts" },
      { kind: "diff", text: "+x" },
      { kind: "activity", text: "Editing src/b.ts" },
      { kind: "reasoning", text: "done with b" },
    ]);
    expect(stats.lastPath).toBe("src/b.ts");
  });

  it("ignores non-activity kinds even when their text mimics an activity line", () => {
    const stats = fileStatsFromFeed([
      { kind: "reasoning", text: "Writing src/fake.ts" },
      { kind: "tool-call", text: "Editing src/fake.ts" },
    ]);
    expect(stats).toEqual({ written: 0, edited: 0, lastPath: null });
  });

  it("malformed activity text contributes nothing (wrong verb / empty path)", () => {
    const stats = fileStatsFromFeed([
      { kind: "activity", text: "Deleted src/x.ts" },
      { kind: "activity", text: "Writing " },
      { kind: "activity", text: "Editing" },
    ]);
    expect(stats).toEqual({ written: 0, edited: 0, lastPath: null });
  });
});

describe("thinkingStatusLine", () => {
  const DIM = `${ESC}[2m`;
  const RESET = `${ESC}[0m`;
  const NO_FILES = { written: 0, edited: 0, lastPath: null };

  /** The plain (unstyled) payload between the DIM open and RESET close. */
  function plainOf(out: string): string {
    expect(out.startsWith(DIM)).toBe(true);
    expect(out.endsWith(RESET)).toBe(true);
    return out.slice(DIM.length, out.length - RESET.length);
  }

  it("is null under the 10s quiet threshold", () => {
    expect(THINKING_QUIET_MS).toBe(10_000);
    expect(thinkingStatusLine(0, NO_FILES)).toBeNull();
    expect(thinkingStatusLine(9_999, NO_FILES)).toBeNull();
  });

  it("shows the calm thinking copy with live elapsed time at/after the threshold", () => {
    const out = thinkingStatusLine(10_000, NO_FILES);
    expect(out).toBeTypeOf("string");
    expect(out).toContain("the AI is thinking — 10s in…");
    const later = thinkingStatusLine(160_000, NO_FILES) as string;
    expect(later).toContain("the AI is thinking — 2m 40s in…");
  });

  it("omits the files ticker when no files exist yet", () => {
    const out = thinkingStatusLine(30_000, NO_FILES) as string;
    expect(out).not.toContain("files:");
    expect(out).not.toContain("last:");
  });

  it("appends the files ticker once files exist (edited part only when > 0)", () => {
    const writtenOnly = thinkingStatusLine(30_000, {
      written: 2,
      edited: 0,
      lastPath: "src/app.ts",
    }) as string;
    expect(writtenOnly).toContain("files: 2 written");
    expect(writtenOnly).not.toContain("edited");
    expect(writtenOnly).toContain("last: src/app.ts");

    const both = thinkingStatusLine(30_000, {
      written: 1,
      edited: 3,
      lastPath: "src/b.ts",
    }) as string;
    expect(both).toContain("files: 1 written, 3 edited");
    expect(both).toContain("last: src/b.ts");
  });

  it("styles with DIM only — never red, never any other SGR (calm, D2-18)", () => {
    const out = thinkingStatusLine(30_000, {
      written: 1,
      edited: 1,
      lastPath: "src/a.ts",
    }) as string;
    expectNoRed(out);
    expect(out.startsWith(DIM)).toBe(true);
    expect(out.endsWith(RESET)).toBe(true);
    // exactly the DIM open + RESET close — no other escapes anywhere
    expect(out.split(ESC).length - 1).toBe(2);
    expect(out).not.toContain("\n");
  });

  it("a hostile lastPath can never smuggle ESC bytes into the line (T-rtd-01)", () => {
    const out = thinkingStatusLine(30_000, {
      written: 1,
      edited: 0,
      lastPath: `evil${ESC}[31mred${ESC}[2Jpath`,
    }) as string;
    expectNoRed(out);
    expect(out).not.toContain(`${ESC}[2J`);
    expect(plainOf(out)).not.toContain(ESC);
    expect(out).toContain("evil");
  });

  it("truncates the plain text to LINE_MAX (long lastPath cannot wrap the line)", () => {
    expect(LINE_MAX).toBe(120);
    const out = thinkingStatusLine(30_000, {
      written: 5,
      edited: 2,
      lastPath: `src/${"very-long-".repeat(30)}file.ts`,
    }) as string;
    const plain = plainOf(out);
    expect(plain.length).toBeLessThanOrEqual(LINE_MAX + 1); // slice(0,120) + "…"
    expect(plain.endsWith("…")).toBe(true);
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
