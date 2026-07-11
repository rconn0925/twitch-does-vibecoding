import { describe, expect, it } from "vitest";
import { BUILDER_FEED_CHANGED } from "../shared/events.js";
import type { PipelineStage } from "../shared/types.js";
import {
  type BuilderFeedLine,
  CONTENT_MAX_CHARS,
  createBuilderFeed,
  DEFAULT_MAX_LINES,
  TOOL_ARG_MAX,
} from "./builder-feed.js";

/**
 * BuilderFeed (quick-x7d, widened by quick-nhv) — the ring-buffer projection
 * between the build session and the /builder broadcast wire. Pure module: no
 * fakes needed. The binding properties: bounded ring (300), clear-on-new-build,
 * CLOSED 7-kind line vocabulary (server-composed text only), the
 * CONTENT_MAX_CHARS per-line memory backstop (T-x7d-07), and one
 * BUILDER_FEED_CHANGED emit per mutation.
 */

const CLOSED_KINDS = new Set([
  "title",
  "stage",
  "stage-warn",
  "activity",
  "reasoning",
  "tool-call",
  "diff",
]);

describe("createBuilderFeed", () => {
  it("is a bounded 300-line ring: 310 appends keep only the newest 300, oldest evicted", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("ring test");
    // 1 title line + 310 stage beats = 311 appends total.
    for (let i = 0; i < 310; i++) {
      feed.stage("building");
    }
    const lines = feed.list();
    expect(DEFAULT_MAX_LINES).toBe(300);
    expect(lines).toHaveLength(300);
    // The title (oldest line) was evicted; every survivor is a stage caption.
    expect(lines[0]).toEqual({ kind: "stage", text: "Writing the code" });
    expect(lines.some((l) => l.kind === "title")).toBe(false);
  });

  it("buildStarted CLEARS the buffer — the list is exactly the one new title line (T-x7d-05)", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("first build");
    feed.stage("researching");
    feed.stage("building");
    feed.contentApproved([
      { type: "file-change", verb: "Writing", path: "app.js", text: "console.log(1)" },
    ]);
    expect(feed.list().length).toBeGreaterThan(1);

    feed.buildStarted("next");
    expect(feed.list()).toEqual([{ kind: "title", text: "NOW BUILDING: next" }]);
  });

  it("truncates the title at 80 chars with the NOW BUILDING prefix", () => {
    const feed = createBuilderFeed();
    const long = "x".repeat(200);
    feed.buildStarted(long);
    const title = feed.list()[0];
    expect(title?.kind).toBe("title");
    expect(title?.text).toBe(`NOW BUILDING: ${"x".repeat(80)}…`);

    // An exactly-80-char title is NOT truncated.
    feed.buildStarted("y".repeat(80));
    expect(feed.list()[0]?.text).toBe(`NOW BUILDING: ${"y".repeat(80)}`);
  });

  it("stage captions come ONLY from the fixed table; queued/unknown append NOTHING (fail closed)", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("caption test");

    feed.stage("queued");
    feed.stage("bogus" as never);
    expect(feed.list()).toHaveLength(1); // still just the title

    const expected: Array<[PipelineStage, BuilderFeedLine]> = [
      ["researching", { kind: "stage", text: "Digging into the idea" }],
      ["planning", { kind: "stage", text: "Drafting the build plan" }],
      ["building", { kind: "stage", text: "Writing the code" }],
      ["done", { kind: "stage", text: "Live on screen now" }],
      ["failed", { kind: "stage-warn", text: "Regrouping…" }],
      ["refused", { kind: "stage-warn", text: "Skipping this one" }],
    ];
    for (const [stage, line] of expected) {
      feed.stage(stage);
      expect(feed.list().at(-1)).toEqual(line);
    }
  });

  it("failed/refused are kind stage-warn (amber client-side), all others kind stage", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("warn test");
    feed.stage("failed");
    feed.stage("refused");
    feed.stage("done");
    const kinds = feed.list().map((l) => l.kind);
    expect(kinds).toEqual(["title", "stage-warn", "stage-warn", "stage"]);
  });

  it("every line kind across all methods is inside the CLOSED 7-value set — 'snippet' is not producible", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("kinds test");
    for (const stage of [
      "researching",
      "planning",
      "building",
      "done",
      "failed",
      "refused",
    ] as const) {
      feed.stage(stage);
    }
    feed.contentApproved([
      { type: "reasoning", text: "thinking about the layout" },
      { type: "tool-call", tool: "Bash", arg: "npm install" },
      { type: "file-change", verb: "Writing", path: "a.js", text: "let a = 1" },
      { type: "file-change", verb: "Editing", path: "b.css", text: "" },
    ]);
    for (const line of feed.list()) {
      expect(CLOSED_KINDS.has(line.kind), `kind "${line.kind}" outside the closed set`).toBe(true);
    }
    // The retired snippet kind is gone from the wire entirely.
    expect(feed.list().some((l) => l.kind === ("snippet" as never))).toBe(false);
  });

  it("contentApproved appends reasoning, tool-call, and file-change lines in order — ONE emit per call", () => {
    const feed = createBuilderFeed();
    let emits = 0;
    feed.on(BUILDER_FEED_CHANGED, () => {
      emits += 1;
    });
    feed.buildStarted("content test");
    expect(emits).toBe(1);

    feed.contentApproved([
      { type: "reasoning", text: "First I'll wire the install step" },
      { type: "tool-call", tool: "Bash", arg: "npm install" },
      { type: "file-change", verb: "Writing", path: "src/app.js", text: "console.log('hi')" },
    ]);

    expect(feed.list().slice(1)).toEqual([
      { kind: "reasoning", text: "First I'll wire the install step" },
      { kind: "tool-call", text: "Bash(npm install)" },
      { kind: "activity", text: "Writing src/app.js" },
      { kind: "diff", text: "console.log('hi')" },
    ]);
    // ONE emit for the whole call, not one per line.
    expect(emits).toBe(2);
  });

  it("contentApproved with empty items appends nothing and does NOT emit", () => {
    const feed = createBuilderFeed();
    let emits = 0;
    feed.on(BUILDER_FEED_CHANGED, () => {
      emits += 1;
    });
    feed.buildStarted("empty test");
    expect(emits).toBe(1);

    feed.contentApproved([]);
    expect(feed.list()).toHaveLength(1);
    expect(emits).toBe(1);
  });

  it("a file-change with empty text lands the activity line only — no empty diff line", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("no-diff test");
    feed.contentApproved([
      { type: "file-change", verb: "Editing", path: "src/style.css", text: "" },
    ]);
    expect(feed.list().slice(1)).toEqual([{ kind: "activity", text: "Editing src/style.css" }]);
  });

  it("a tool-call with an empty arg renders as `Tool()` and a long arg is truncated at TOOL_ARG_MAX", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("arg test");
    const longArg = "a".repeat(500);
    feed.contentApproved([
      { type: "tool-call", tool: "Glob", arg: "" },
      { type: "tool-call", tool: "Bash", arg: longArg },
    ]);
    const lines = feed.list().slice(1);
    expect(lines[0]).toEqual({ kind: "tool-call", text: "Glob()" });
    expect(lines[1]?.text).toBe(`Bash(${"a".repeat(TOOL_ARG_MAX)}…)`);
  });

  it("diff text >200 chars and >3 lines passes through UNCUT below CONTENT_MAX_CHARS (old snippet cap is gone)", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("full-diff test");
    const bigLine = "z".repeat(100);
    const input = Array.from({ length: 10 }, () => bigLine).join("\n"); // 10 lines, >1000 chars
    feed.contentApproved([{ type: "file-change", verb: "Writing", path: "big.js", text: input }]);
    const diff = feed.list().find((l) => l.kind === "diff");
    expect(diff).toBeDefined();
    // Full fidelity: every line and every byte survives (no 3-line/200-char cap).
    expect(diff?.text).toBe(input);
    expect(diff?.text.split("\n")).toHaveLength(10);
  });

  it("diff and reasoning above CONTENT_MAX_CHARS are hard-capped with a trailing ellipsis (T-x7d-07 backstop)", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("backstop test");
    const huge = "q".repeat(CONTENT_MAX_CHARS + 5_000);
    feed.contentApproved([
      { type: "file-change", verb: "Writing", path: "huge.js", text: huge },
      { type: "reasoning", text: huge },
    ]);
    const diff = feed.list().find((l) => l.kind === "diff");
    const reasoning = feed.list().find((l) => l.kind === "reasoning");
    for (const line of [diff, reasoning]) {
      expect(line).toBeDefined();
      expect(line?.text.length).toBe(CONTENT_MAX_CHARS + 1); // capped + ellipsis
      expect(line?.text.endsWith("…")).toBe(true);
    }
  });

  it("emits BUILDER_FEED_CHANGED once per buildStarted/stage/contentApproved mutation", () => {
    const feed = createBuilderFeed();
    let emits = 0;
    feed.on(BUILDER_FEED_CHANGED, () => {
      emits += 1;
    });

    feed.buildStarted("emit test");
    expect(emits).toBe(1);

    feed.stage("researching");
    expect(emits).toBe(2);

    // A no-append stage does NOT emit (nothing changed on the wire).
    feed.stage("queued");
    expect(emits).toBe(2);

    // One emit per contentApproved call, even with multiple items (4 lines here).
    feed.contentApproved([
      { type: "file-change", verb: "Writing", path: "a.js", text: "aa" },
      { type: "file-change", verb: "Writing", path: "b.js", text: "bb" },
    ]);
    expect(emits).toBe(3);
  });
});
