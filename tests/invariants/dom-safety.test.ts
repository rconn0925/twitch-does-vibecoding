import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMatches, collectFiles } from "./scan-helpers.js";

/**
 * DOM-safety invariant (T-02-19, plan 02-05) — the machine-checked form of
 * the textContent-only rule Phase 1 enforced by hand-grep (T-01-04), extended
 * to the broadcast surface: chat-derived text renders LIVE ON STREAM in the
 * overlay, so an HTML-injection sink there is a stored XSS broadcast to the
 * whole audience.
 *
 * The scan DISCOVERS every .js file under any src/**\/public/ directory
 * (console.js + overlay.js today, and whatever future surfaces appear) —
 * it never hardcodes filenames, so a new public dir is covered automatically.
 *
 * Comment-stripped before matching (prose in comments must neither satisfy
 * nor violate the invariant), same discipline as the sibling scans.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** Forbidden HTML/code-injection sinks in browser-facing JS. */
const DANGEROUS_SINKS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/;

/** Every non-test .js file under a src/**\/public/ directory, comment-stripped. */
function collectPublicJs() {
  return collectFiles(SRC_DIR, { extensions: [".js"] }).filter((file) =>
    /^src\/.+\/public\/.+\.js$/.test(file.rel),
  );
}

describe("DOM-safety invariant: no HTML-injection sinks in any public/ JS (source scan)", () => {
  const files = collectPublicJs();

  it("discovers BOTH browser surfaces (console + overlay) without hardcoding names", () => {
    const rels = files.map((f) => f.rel);
    expect(rels).toContain("src/operator-console/public/console.js");
    expect(rels).toContain("src/overlay/public/overlay.js");
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("zero innerHTML/outerHTML/insertAdjacentHTML/document.write/eval across all public JS", () => {
    const hits = allMatches(files, DANGEROUS_SINKS);
    const offenders = [...hits.values()].flat();
    expect(
      offenders,
      `HTML-injection sink in browser-facing JS (textContent-only rule, T-02-19): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("self-test: the scan catches an offender and names file:line", () => {
    const synthetic = [
      {
        rel: "src/rogue/public/bad.js",
        stripped: 'node.innerHTML = userText;\nnode.insertAdjacentHTML("beforeend", x);\n',
      },
      {
        rel: "src/rogue/public/fine.js",
        // Already comment-stripped input: only safe textContent assignment.
        stripped: "node.textContent = userText;\n",
      },
    ];
    const hits = allMatches(synthetic, DANGEROUS_SINKS);
    expect(hits.get("src/rogue/public/bad.js")).toEqual([
      "src/rogue/public/bad.js:1",
      "src/rogue/public/bad.js:2",
    ]);
    expect(hits.has("src/rogue/public/fine.js")).toBe(false);
  });

  it("self-test: document.write and eval( are caught; retrieval( is not a false positive", () => {
    const synthetic = [
      { rel: "src/rogue/public/writer.js", stripped: "document.write(payload);\n" },
      { rel: "src/rogue/public/evaler.js", stripped: "eval(code);\n" },
      { rel: "src/rogue/public/ok.js", stripped: "retrieval(code); const x = 1;\n" },
    ];
    const hits = allMatches(synthetic, DANGEROUS_SINKS);
    expect(hits.has("src/rogue/public/writer.js")).toBe(true);
    expect(hits.has("src/rogue/public/evaler.js")).toBe(true);
    expect(hits.has("src/rogue/public/ok.js")).toBe(false);
  });
});
