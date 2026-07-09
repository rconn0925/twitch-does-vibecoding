/**
 * The gate contract — intentionally RED.
 *
 * This file imports src/compliance/gate.ts which does NOT exist yet (plan 01-05).
 * It drives classify() over ALL fixtures with an injected fake classifier.
 *
 * The purpose: when plan 01-05 implements gate.ts, running this file should
 * flip from RED → GREEN with zero test changes.
 *
 * Import gating: ALL imports of the missing module are confined to this file
 * so the rest of the codebase typechecks clean.
 */

import { describe, expect, it, vi } from "vitest";
import type { CandidateKind } from "../shared/types.js";
import { ADVERSARIAL_FIXTURES } from "./fixtures/adversarial.fixtures.js";
import { FEASIBILITY_FIXTURES } from "./fixtures/feasibility.fixtures.js";
import { TAXONOMY_FIXTURES } from "./fixtures/taxonomy.fixtures.js";
import { prefilterCheck } from "./prefilter.js";
import type { ClassifierDecision } from "./schema.js";

/** Local copy of GateFixture — mirrors the fixture files' shape. */
interface GateFixture {
  id: string;
  text: string;
  kind?: CandidateKind;
  expected: "approved" | "rejected" | "held-for-review";
  expectedCategory?: string;
  note: string;
}

// ─── All fixtures combined ─────────────────────────────────────────────
const ALL_FIXTURES: GateFixture[] = [
  ...TAXONOMY_FIXTURES,
  ...ADVERSARIAL_FIXTURES,
  ...FEASIBILITY_FIXTURES,
];

// We import gate.ts here — it does not exist yet (plan 01-05).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { classify, type FakeClassifier } from "./gate.js";

describe("classify (gate contract — RED until plan 01-05)", () => {
  it.each(ALL_FIXTURES)("$id: $expected ($note)", async (fixture) => {
    // Inject a fake classifier that returns the expected decision for every call.
    // This makes tests deterministic and free of network calls.
    const fakeClassifier: FakeClassifier = vi.fn(
      () =>
        ({
          decision: fixture.expected,
          category: fixture.expected === "approved" ? null : (fixture.expectedCategory ?? null),
          rationale: `fake: ${fixture.note}`,
        }) satisfies ClassifierDecision,
    );

    const result = await classify(
      { fakeClassifier },
      {
        id: fixture.id,
        source: "chat",
        kind: fixture.kind ?? "suggestion",
        twitchUsername: "test_viewer",
        text: fixture.text,
        submittedAtMs: Date.now(),
      },
    );

    expect(result.decision).toBe(fixture.expected);
  });

  it("a fake classifier that always throws yields rejected/classifier-unavailable (fail-closed)", async () => {
    const throwingClassifier: FakeClassifier = vi.fn(() => {
      throw new Error("network error");
    });

    const result = await classify(
      { fakeClassifier: throwingClassifier },
      {
        id: "fail-closed-test",
        source: "chat",
        kind: "suggestion",
        twitchUsername: "test_viewer",
        text: "build a todo app",
        submittedAtMs: Date.now(),
      },
    );

    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("no prefilter-caught fixture may ever produce approved, even when the classifier wrongly approves", async () => {
    // DEVIATION (plan 01-05, documented in 01-05-SUMMARY.md): as originally
    // written this looped over ALL non-approved fixtures with an injected
    // classifier that wrongly approves. That property is unsatisfiable
    // offline: fixtures the prefilter cannot catch (e.g. tax-01-block,
    // feat-01-chess) are decided solely by the injected classifier, and
    // held-for-review fixtures MUST reach the classifier for the it.each
    // contract above (the prefilter can only reject, never hold). The
    // full-suite "never wrongly approved" property is only provable against
    // the real Sonnet classifier — scripts/gate-eval.ts enforces it as a
    // SAFETY FAIL (exit 1). This test proves the defense-in-depth half: the
    // prefilter's verdict is never overridden by an approving classifier.
    const prefilterCaught = ALL_FIXTURES.filter(
      (fixture) => fixture.expected !== "approved" && prefilterCheck(fixture.text).rejected,
    );
    expect(prefilterCaught.length).toBeGreaterThan(0);

    for (const fixture of prefilterCaught) {
      const fakeClassifier: FakeClassifier = vi.fn(
        () =>
          ({
            decision: "approved",
            category: null,
            rationale: `wrongly approving ${fixture.id}`,
          }) satisfies ClassifierDecision,
      );

      const result = await classify(
        { fakeClassifier },
        {
          id: fixture.id,
          source: "chat",
          kind: fixture.kind ?? "suggestion",
          twitchUsername: "test_viewer",
          text: fixture.text,
          submittedAtMs: Date.now(),
        },
      );

      expect(result.decision).not.toBe("approved");
    }
  });
});
