import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMatches, collectFiles } from "./scan-helpers.js";

/**
 * D2-08 chat-sender sole-caller invariant — the machine-enforced half of
 * "no direct sendChatMessage calls scattered around". Every outbound chat
 * message flows through src/ingestion/chat-sender.ts's rate-budgeted queue;
 * this scan fails the build if any other src/ module references the Helix
 * send call, and confines @twurple/api imports to the ingestion layer and
 * the composition root (src/main.ts constructs the real ApiClient).
 *
 * Comment-stripped scan (prose in comments must neither satisfy nor violate
 * the invariant), mirroring tests/invariants/single-funnel.test.ts.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const files = collectFiles(SRC_DIR);

describe("D2-08 chat-sender sole-caller invariant (source scan)", () => {
  it("scans a plausible source tree (every non-test src/**/*.ts file)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.rel === "src/ingestion/chat-sender.ts")).toBe(true);
    expect(files.some((f) => f.rel === "src/compliance/gate.ts")).toBe(true);
    expect(files.some((f) => f.rel.endsWith(".test.ts"))).toBe(false);
  });

  it("sendChatMessage is referenced only in src/ingestion/chat-sender.ts", () => {
    const hits = allMatches(files, /sendChatMessage/);
    const offenders = [...hits.entries()]
      .filter(([rel]) => rel !== "src/ingestion/chat-sender.ts")
      .flatMap(([, locs]) => locs);
    expect(
      offenders,
      `direct sendChatMessage outside the sanctioned sender queue (D2-08): ${offenders.join(", ")}`,
    ).toHaveLength(0);
    expect(
      hits.has("src/ingestion/chat-sender.ts"),
      "src/ingestion/chat-sender.ts must contain the sanctioned sendChatMessage call",
    ).toBe(true);
  });

  it("@twurple/api is imported only from src/ingestion/ or src/main.ts", () => {
    const hits = allMatches(files, /["']@twurple\/api["']/);
    const offenders = [...hits.entries()]
      .filter(([rel]) => !rel.startsWith("src/ingestion/") && rel !== "src/main.ts")
      .flatMap(([, locs]) => locs);
    expect(
      offenders,
      `@twurple/api imported outside src/ingestion/ or the composition root: ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("self-test: the scan logic catches an offender in a synthetic tree", () => {
    const synthetic = [
      {
        rel: "src/rogue/direct-send.ts",
        stripped: 'await api.chat.sendChatMessage("123", "bypassing the queue");\n',
      },
      {
        rel: "src/rogue/commented-only.ts",
        // Already comment-stripped input: an empty line where prose was.
        stripped: "\nconst fine = 1;\n",
      },
    ];
    const hits = allMatches(synthetic, /sendChatMessage/);
    expect(hits.get("src/rogue/direct-send.ts")).toEqual(["src/rogue/direct-send.ts:1"]);
    expect(hits.has("src/rogue/commented-only.ts")).toBe(false);
  });
});
