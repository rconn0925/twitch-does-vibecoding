import { describe, expect, it } from "vitest";
import { BUILDER_FEED_CHANGED } from "../shared/events.js";
import type { PipelineStage } from "../shared/types.js";
import { type BuilderFeedLine, createBuilderFeed } from "./builder-feed.js";

/**
 * BuilderFeed (quick-x7d) — the ring-buffer projection between the build
 * session and the /builder broadcast wire. Pure module: no fakes needed.
 * The binding properties: bounded ring, clear-on-new-build, CLOSED line
 * vocabulary (fixed captions only), server-side snippet capping, and one
 * BUILDER_FEED_CHANGED emit per mutation.
 */

const CLOSED_KINDS = new Set(["title", "stage", "stage-warn", "activity", "snippet"]);

describe("createBuilderFeed", () => {
  it("is a bounded 50-line ring: 60 appends keep only the newest 50, oldest evicted", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("ring test");
    // 1 title line + 60 stage beats = 61 appends total.
    for (let i = 0; i < 60; i++) {
      feed.stage("building");
    }
    const lines = feed.list();
    expect(lines).toHaveLength(50);
    // The title (oldest line) was evicted; every survivor is a stage caption.
    expect(lines[0]).toEqual({ kind: "stage", text: "Writing the code" });
    expect(lines.some((l) => l.kind === "title")).toBe(false);
  });

  it("buildStarted CLEARS the buffer — the list is exactly the one new title line (T-x7d-05)", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("first build");
    feed.stage("researching");
    feed.stage("building");
    feed.batchApproved([{ verb: "Writing", path: "app.js", text: "console.log(1)" }]);
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

  it("every line kind across all methods is inside the CLOSED 5-value set", () => {
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
    feed.batchApproved([
      { verb: "Writing", path: "a.js", text: "let a = 1" },
      { verb: "Editing", path: "b.css", text: "" },
    ]);
    for (const line of feed.list()) {
      expect(CLOSED_KINDS.has(line.kind), `kind "${line.kind}" outside the closed set`).toBe(true);
    }
  });

  it("batchApproved appends an activity line per display and a snippet only when text is non-empty", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("batch test");
    feed.batchApproved([
      { verb: "Writing", path: "src/app.js", text: "console.log('hi')" },
      { verb: "Editing", path: "src/style.css", text: "" },
    ]);
    expect(feed.list().slice(1)).toEqual([
      { kind: "activity", text: "Writing src/app.js" },
      { kind: "snippet", text: "console.log('hi')" },
      { kind: "activity", text: "Editing src/style.css" },
    ]);
  });

  it("caps snippets server-side: 10-line/1000-char input → ≤3 lines and ≤201 chars", () => {
    const feed = createBuilderFeed();
    feed.buildStarted("snippet cap");
    const bigLine = "z".repeat(100);
    const input = Array.from({ length: 10 }, () => bigLine).join("\n"); // 10 lines, >1000 chars
    feed.batchApproved([{ verb: "Writing", path: "big.js", text: input }]);
    const snippet = feed.list().find((l) => l.kind === "snippet");
    expect(snippet).toBeDefined();
    const text = snippet?.text ?? "";
    expect(text.split("\n").length).toBeLessThanOrEqual(3);
    expect(text.length).toBeLessThanOrEqual(201); // 200 chars + trailing ellipsis
    expect(text.endsWith("…")).toBe(true);
  });

  it("emits BUILDER_FEED_CHANGED once per buildStarted/stage/batchApproved mutation", () => {
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

    // One emit per batch call, even with multiple displays (2 lines each).
    feed.batchApproved([
      { verb: "Writing", path: "a.js", text: "aa" },
      { verb: "Writing", path: "b.js", text: "bb" },
    ]);
    expect(emits).toBe(3);
  });
});
