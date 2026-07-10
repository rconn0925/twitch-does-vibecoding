import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * COMP-01 single-funnel invariant — the machine-enforced half of Phase 1
 * Success Criterion 1 ("code review confirms no component can enqueue any
 * other way"). Runs in every `npm test`, so Phase 2's chat ingestion and
 * Phase 4's paid paths inherit the check automatically.
 *
 * Enforced properties (all after comment stripping — prose in comments must
 * neither satisfy nor violate the invariant):
 *   (a) the `as QueuedTask` brand assertion exists exactly once, in
 *       src/compliance/gate.ts (toQueuedTask is the sole brand constructor)
 *   (b) `.enqueue(` is called only from src/pipeline/ — no ingestion,
 *       console, or state-machine module feeds the build queue directly
 *   (c) only src/compliance/ imports "@anthropic-ai/sdk" (the classifier
 *       boundary: nothing else talks to the model)
 *   (d) `toQueuedTask` is referenced outside gate.ts only by the two
 *       sanctioned funnel entry points under src/pipeline/: submit.ts
 *       (new-candidate intake) and round.ts (round-winner promotion)
 *   (e) src/audit/purge.ts holds the codebase's only "DELETE FROM" (D-17
 *       append-only exception; T-01-20)
 *
 * KNOWN LIMIT (RESEARCH.md Pattern 1, honest caveat): the QueuedTask brand is
 * compile-time-only fiction — a malicious `as QueuedTask` cast anywhere would
 * satisfy TypeScript. THIS test is what catches it: the scan fails loudly,
 * naming the offending file and line. A secondary limit: the comment stripper
 * treats `//` inside regex literals as a line comment, so a violation sharing
 * a line with such a regex could hide; none of the enforced tokens plausibly
 * co-occur with one.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

interface ScannedFile {
  /** Posix-style path relative to the repo root, e.g. "src/compliance/gate.ts". */
  rel: string;
  /** File contents with line and block comments stripped (newlines preserved). */
  stripped: string;
}

/** Strip // and /* *\/ comments while respecting string/template literals. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        i += 2;
      } else if (ch === "/" && next === "*") {
        state = "block";
        i += 2;
      } else {
        if (ch === "'") state = "single";
        else if (ch === '"') state = "double";
        else if (ch === "`") state = "template";
        out += ch;
        i += 1;
      }
    } else if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        if (ch === "\n") out += ch; // preserve line numbers for reporting
        i += 1;
      }
    } else {
      // Inside a string/template literal: copy verbatim, honor escapes.
      if (ch === "\\") {
        out += ch + next;
        i += 2;
      } else {
        if (
          (state === "single" && ch === "'") ||
          (state === "double" && ch === '"') ||
          (state === "template" && ch === "`")
        ) {
          state = "code";
        }
        out += ch;
        i += 1;
      }
    }
  }
  return out;
}

/** Recursively collect every non-test .ts file under src/. */
function scanSources(): ScannedFile[] {
  const entries = readdirSync(SRC_DIR, { recursive: true, withFileTypes: true });
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = `src/${path.relative(SRC_DIR, abs).split(path.sep).join("/")}`;
    files.push({ rel, stripped: stripComments(readFileSync(abs, "utf8")) });
  }
  return files;
}

/** Every match of `pattern` in `file`, reported as "file:line". */
function matchLocations(file: ScannedFile, pattern: RegExp): string[] {
  const locations: string[] = [];
  const lines = file.stripped.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] ?? "";
    const re = new RegExp(pattern.source, "g");
    while (re.exec(line) !== null) {
      locations.push(`${file.rel}:${lineNo + 1}`);
    }
  }
  return locations;
}

const files = scanSources();

function allMatches(pattern: RegExp): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const hits = matchLocations(file, pattern);
    if (hits.length > 0) byFile.set(file.rel, hits);
  }
  return byFile;
}

describe("COMP-01 single-funnel invariants (source scan)", () => {
  it("scans a plausible source tree", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.rel === "src/compliance/gate.ts")).toBe(true);
  });

  it("(a) the `as QueuedTask` brand assertion exists exactly once, in gate.ts", () => {
    const hits = allMatches(/as QueuedTask/);
    const flat = [...hits.values()].flat();
    expect(
      flat,
      `expected exactly one \`as QueuedTask\`, in src/compliance/gate.ts — found: ${flat.join(", ") || "none"}`,
    ).toHaveLength(1);
    expect(hits.has("src/compliance/gate.ts"), `brand assertion found in: ${flat.join(", ")}`).toBe(
      true,
    );
  });

  it("(b) .enqueue( is called only from src/pipeline/", () => {
    const hits = allMatches(/\.enqueue\(/);
    const offenders = [...hits.entries()]
      .filter(([rel]) => !rel.startsWith("src/pipeline/"))
      .flatMap(([, locs]) => locs);
    expect(
      offenders,
      `direct TaskQueue.enqueue outside src/pipeline/ — the build queue is fed ONLY via the pipeline (COMP-01): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("(c) only src/compliance/ imports @anthropic-ai/sdk", () => {
    const hits = allMatches(/["']@anthropic-ai\/sdk["']/);
    const offenders = [...hits.entries()]
      .filter(([rel]) => !rel.startsWith("src/compliance/"))
      .flatMap(([, locs]) => locs);
    expect(
      offenders,
      `Anthropic SDK imported outside the classifier boundary (src/compliance/): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("(d) toQueuedTask is referenced outside gate.ts only by src/pipeline/{submit,round}.ts", () => {
    const allowed = new Set([
      "src/compliance/gate.ts",
      "src/pipeline/submit.ts",
      "src/pipeline/round.ts",
    ]);
    const hits = allMatches(/toQueuedTask/);
    const offenders = [...hits.entries()]
      .filter(([rel]) => !allowed.has(rel))
      .flatMap(([, locs]) => locs);
    expect(
      offenders,
      `toQueuedTask referenced outside the sanctioned funnel (gate.ts + pipeline/submit.ts): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("(e) src/audit/purge.ts holds the codebase's only DELETE statement (D-17)", () => {
    const hits = allMatches(/DELETE FROM/);
    const flat = [...hits.values()].flat();
    expect(
      flat,
      `expected exactly one DELETE, in src/audit/purge.ts — found: ${flat.join(", ") || "none"}`,
    ).toHaveLength(1);
    expect(hits.has("src/audit/purge.ts"), `DELETE found in: ${flat.join(", ")}`).toBe(true);
  });
});
