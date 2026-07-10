import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADVERSARIAL_FIXTURES } from "../../src/compliance/fixtures/adversarial.fixtures.js";
import {
  buildBuildPrompt,
  buildResearchPrompt,
  RESEARCH_SYSTEM_PROMPT,
} from "../../src/orchestrator/prompt-boundary.js";
import type { SuggestionCandidate } from "../../src/shared/types.js";
import { allMatches, collectFiles, type ScannedFile } from "./scan-helpers.js";

/**
 * SAND-04 / D3-05 prompt-injection boundary invariant — the machine-enforced
 * form of Phase 2's accepted T-02-18 ("chat-as-instructions"). Two concerns:
 *
 *   (1) PROMPT-BOUNDARY FIXTURE SUITE — reuses Phase 1's adversarial injection
 *       fixtures (D3-05, do NOT reinvent the fixture format) and proves, for
 *       every one, that the orchestrator-authored system prompt is unchanged
 *       and the fixture text lands ONLY inside the delimiter frame of the user
 *       turn. An "ignore your instructions" suggestion therefore can never move
 *       into instruction position.
 *
 *   (2) AGENT-SDK-CONFINEMENT SOURCE SCAN — defense-in-depth mirror of
 *       single-funnel check (c). Check (c) confines "@anthropic-ai/sdk" (the
 *       classifier SDK) to src/compliance/; this confines
 *       "@anthropic-ai/claude-agent-sdk" (the `query`/`spawnClaudeCodeProcess`
 *       tool-use authority) to src/orchestrator/. Previously convention-only
 *       (the checker's noted gap); now a verified invariant with a
 *       non-empty-scan guard and a synthetic-offender self-test so it can never
 *       pass by scanning nothing or by trivially matching nothing.
 *
 * Comment-stripped before matching (via scan-helpers), same discipline as the
 * sibling source-scan invariants.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** Build a chat-sourced candidate from raw untrusted text. */
function candidateFrom(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "adv_viewer",
    text,
    submittedAtMs: 1_700_000_000_000,
  };
}

/** Extract the text between an open/close delimiter, or null if not framed. */
function between(haystack: string, open: string, close: string): string | null {
  const afterOpen = haystack.split(open)[1];
  if (afterOpen === undefined) return null;
  const inner = afterOpen.split(close)[0];
  return inner ?? null;
}

// ─── (1) Prompt-boundary fixture suite (reused Phase 1 adversarial fixtures) ──

describe("SAND-04 prompt-boundary: chat text never reaches instruction position", () => {
  it("reuses a NON-EMPTY set of Phase 1 adversarial fixtures", () => {
    // Fail-loud guard: a silently-empty fixture array would make every
    // it.each below vacuously pass.
    expect(ADVERSARIAL_FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(
    ADVERSARIAL_FIXTURES,
  )("$id: research systemPrompt is injection-invariant + text is delimited-only", (fixture) => {
    const { systemPrompt, userPrompt } = buildResearchPrompt(
      candidateFrom(fixture.id, fixture.text),
    );

    // (a) system prompt unchanged from the injection-free baseline.
    expect(systemPrompt).toBe(RESEARCH_SYSTEM_PROMPT);
    // The untrusted fixture text never leaks into the system prompt.
    expect(systemPrompt).not.toContain(fixture.text);

    // (b) the fixture text is fully contained within the delimiter frame of
    // the user turn, and nowhere else in the user prompt.
    const inner = between(userPrompt, '<task_description source="chat">', "</task_description>");
    expect(inner).not.toBeNull();
    expect(inner).toContain(fixture.text);

    // Removing the delimited region leaves NO trace of the fixture text.
    const outsideFrame = userPrompt.replace(
      `<task_description source="chat">\n${fixture.text}\n</task_description>`,
      "",
    );
    expect(outsideFrame).not.toContain(fixture.text);
  });

  it.each(
    ADVERSARIAL_FIXTURES,
  )("$id: build systemPrompt is injection-invariant when the SAME text is a plan", (fixture) => {
    // Same discipline for the build agent: even a malicious "plan" text can
    // only ever appear inside the <build_plan> data frame.
    const baseline = buildBuildPrompt("a benign approved plan").systemPrompt;
    const { systemPrompt, userPrompt } = buildBuildPrompt(fixture.text);

    expect(systemPrompt).toBe(baseline);
    expect(systemPrompt).not.toContain(fixture.text);

    const inner = between(userPrompt, '<build_plan source="orchestrator">', "</build_plan>");
    expect(inner).not.toBeNull();
    expect(inner).toContain(fixture.text);
  });
});

// ─── (2) Agent-SDK-confinement source scan (mirrors single-funnel check (c)) ──

/** The package whose `query`/`spawnClaudeCodeProcess` surface is the agent's tool-use authority. */
const AGENT_SDK_IMPORT = /["']@anthropic-ai\/claude-agent-sdk["']/;

/** Only files under this prefix may import the agent SDK (the query() boundary). */
const ALLOWED_PREFIX = "src/orchestrator/";

/**
 * Offenders = every "file:line" where the agent SDK is imported OUTSIDE
 * src/orchestrator/. A pure function of the scanned files so the same logic
 * runs on the real tree AND on a synthetic planted offender (self-test).
 */
function sdkImportOffenders(files: ScannedFile[]): string[] {
  const hits = allMatches(files, AGENT_SDK_IMPORT);
  return [...hits.entries()]
    .filter(([rel]) => !rel.startsWith(ALLOWED_PREFIX))
    .flatMap(([, locs]) => locs);
}

/**
 * Prompt-source guard: within src/orchestrator/, no agent system prompt is
 * built by interpolating untrusted text — a `system`/`systemPrompt` field
 * assigned an INTERPOLATING template literal (`${…}`) is the exact anti-pattern
 * prompt-boundary.ts exists to prevent (its system prompts are fixed consts,
 * assigned by bare reference). `[^`]*` spans newlines, so a multi-line template
 * literal is covered too.
 */
const INTERPOLATED_SYSTEM_PROMPT = /system(Prompt)?\s*:\s*`[^`]*\$\{/;

function interpolatedSystemPromptOffenders(files: ScannedFile[]): string[] {
  return files
    .filter((f) => f.rel.startsWith(ALLOWED_PREFIX))
    .filter((f) => INTERPOLATED_SYSTEM_PROMPT.test(f.stripped))
    .map((f) => f.rel);
}

describe("SAND-04 agent-SDK confinement: query() authority lives only under src/orchestrator/", () => {
  const files = collectFiles(SRC_DIR);

  it("scans a plausible, non-empty source tree (guard against scanning nothing)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.rel === "src/orchestrator/prompt-boundary.ts")).toBe(true);
  });

  it("(confinement) @anthropic-ai/claude-agent-sdk is imported ONLY under src/orchestrator/", () => {
    const offenders = sdkImportOffenders(files);
    expect(
      offenders,
      `agent SDK (query()/spawnClaudeCodeProcess) imported outside the orchestrator boundary (${ALLOWED_PREFIX}): ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("(self-test) the confinement scan FLAGS a planted src/ingestion/rogue.ts SDK import", () => {
    const rogue: ScannedFile = {
      rel: "src/ingestion/rogue.ts",
      stripped: `import { query } from "@anthropic-ai/claude-agent-sdk";\n`,
    };
    const offenders = sdkImportOffenders([...files, rogue]);
    // Proves the scan actually catches a violation (fails-loud, not a silent pass).
    expect(offenders).toContain("src/ingestion/rogue.ts:1");
  });

  it("(prompt-source guard) no orchestrator file interpolates text into a system prompt", () => {
    const offenders = interpolatedSystemPromptOffenders(files);
    expect(
      offenders,
      `system prompt built by string interpolation in src/orchestrator/ — chat/plan text must reach agents ONLY via prompt-boundary.ts delimited frames: ${offenders.join(", ")}`,
    ).toHaveLength(0);
  });

  it("(self-test) the prompt-source guard FLAGS a planted interpolated system prompt", () => {
    const rogue: ScannedFile = {
      rel: "src/orchestrator/rogue-prompt.ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${task.text} is the offending source line this self-test plants.
      stripped: "const spec = { systemPrompt: `You are an agent. ${task.text}` };\n",
    };
    const offenders = interpolatedSystemPromptOffenders([rogue]);
    expect(offenders).toContain("src/orchestrator/rogue-prompt.ts");
  });
});
