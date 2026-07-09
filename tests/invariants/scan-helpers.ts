import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared source-scan helpers for invariant tests — adapted from the private
 * helpers in single-funnel.test.ts (owned by plan 02-03; deliberately NOT
 * edited here). New invariant scans (chat-sender sole-caller, DOM safety)
 * import these instead of re-rolling the comment stripper.
 *
 * KNOWN LIMIT (inherited from single-funnel.test.ts): the comment stripper
 * treats `//` inside regex literals as a line comment, so a violation sharing
 * a line with such a regex could hide; none of the enforced tokens plausibly
 * co-occur with one.
 */

/** Repo root, derived from this file's location (tests/invariants/ → ../..). */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface ScannedFile {
  /** Posix-style path relative to the repo root, e.g. "src/ingestion/chat-sender.ts". */
  rel: string;
  /** File contents with line and block comments stripped (newlines preserved). */
  stripped: string;
}

/** Strip // and /* *\/ comments while respecting string/template literals. */
export function stripComments(source: string): string {
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

/**
 * Recursively collect files under `rootAbs`, comment-stripped, with repo-root
 * relative posix paths. Defaults: .ts files only, *.test.ts excluded.
 */
export function collectFiles(
  rootAbs: string,
  opts?: { extensions?: string[]; includeTests?: boolean },
): ScannedFile[] {
  const extensions = opts?.extensions ?? [".ts"];
  const includeTests = opts?.includeTests ?? false;
  const entries = readdirSync(rootAbs, { recursive: true, withFileTypes: true });
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
    if (!includeTests && /\.test\.[jt]s$/.test(entry.name)) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
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

/** Map of file rel path → "file:line" hits for every file matching `pattern`. */
export function allMatches(files: ScannedFile[], pattern: RegExp): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const hits = matchLocations(file, pattern);
    if (hits.length > 0) byFile.set(file.rel, hits);
  }
  return byFile;
}
