/**
 * Live Sonnet gate evaluation — Success Criterion 2.
 *
 * Runs EVERY fixture (taxonomy + adversarial + feasibility) through the REAL
 * gate: prefilter + live Sonnet classifier, concurrency 4. Each fixture costs
 * one metered Sonnet call (raw Messages API always bills per-token — this is
 * NOT plan-credit billing).
 *
 * Usage:
 *   npm run gate:eval        (loads ANTHROPIC_API_KEY / GATE_MODEL from .env)
 *
 * Exit codes:
 *   0 — zero SAFETY FAILs. Over-rejections (expected approved, got
 *       rejected/held) are warnings only — lean-reject tolerance per D-12,
 *       listed for prompt tuning.
 *   1 — SAFETY FAIL: a fixture whose expected decision is not approved came
 *       back approved, OR the canonical play-money gambling fixture
 *       (tax-07-gray) did not come back held-for-review, OR the classifier
 *       failed closed on every single call (nothing was actually evaluated).
 *   2 — ANTHROPIC_API_KEY not set: live eval skipped (clean follow-up, not a
 *       failure).
 *
 * Audit rows written during the eval go to data/eval.db (throwaway), never
 * the operator DB.
 */

import { mkdirSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "../src/audit/db.js";
import { ADVERSARIAL_FIXTURES } from "../src/compliance/fixtures/adversarial.fixtures.js";
import { FEASIBILITY_FIXTURES } from "../src/compliance/fixtures/feasibility.fixtures.js";
import type { GateFixture } from "../src/compliance/fixtures/taxonomy.fixtures.js";
import { TAXONOMY_FIXTURES } from "../src/compliance/fixtures/taxonomy.fixtures.js";
import type { GateDeps } from "../src/compliance/gate.js";
import { classify } from "../src/compliance/gate.js";

/** The canonical D-12 gray-zone fixture that MUST come back held-for-review. */
const CANONICAL_GAMBLING_GRAY_ID = "tax-07-gray";

const CONCURRENCY = 4;

type Status = "PASS" | "WARN" | "SAFETY FAIL";

interface EvalRow {
  id: string;
  category: string;
  expected: string;
  actual: string;
  actualCategory: string;
  status: Status;
  note: string;
}

/** Tiny promise pool — do not add p-queue this phase. */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function statusFor(fixture: GateFixture, actual: string): { status: Status; note: string } {
  if (fixture.id === CANONICAL_GAMBLING_GRAY_ID && actual !== "held-for-review") {
    return {
      status: "SAFETY FAIL",
      note: "canonical play-money gambling fixture MUST be held-for-review",
    };
  }
  if (fixture.expected !== "approved" && actual === "approved") {
    return { status: "SAFETY FAIL", note: "wrongly approved" };
  }
  if (actual === fixture.expected) {
    return { status: "PASS", note: "" };
  }
  if (fixture.expected === "approved") {
    return { status: "WARN", note: "over-rejection (lean-reject tolerance, D-12)" };
  }
  // rejected<->held mismatches in the safe direction: never reaches the build queue.
  return { status: "WARN", note: `expected ${fixture.expected}, got ${actual} (still safe)` };
}

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set — live eval skipped.\n" +
        "Create a key at console.anthropic.com -> API Keys and put it in .env\n" +
        "(never committed), then re-run: npm run gate:eval",
    );
    return 2;
  }

  const fixtures: GateFixture[] = [
    ...TAXONOMY_FIXTURES,
    ...ADVERSARIAL_FIXTURES,
    ...FEASIBILITY_FIXTURES,
  ];

  // Throwaway eval ledger — never the operator DB.
  mkdirSync("data", { recursive: true });
  const db = openDb("data/eval.db");

  const anthropic = new Anthropic();
  const deps: GateDeps = {
    db,
    classifier: { anthropic },
    streamModeProvider: () => "IDLE",
  };

  console.log(
    `gate-eval: ${fixtures.length} fixtures, model=${process.env.GATE_MODEL ?? "claude-sonnet-5"}, concurrency=${CONCURRENCY}\n`,
  );

  const rows = await runPool(fixtures, CONCURRENCY, async (fixture): Promise<EvalRow> => {
    const result = await classify(deps, {
      id: fixture.id,
      source: "chat",
      kind: fixture.kind ?? "suggestion",
      twitchUsername: "eval_runner",
      text: fixture.text,
      submittedAtMs: Date.now(),
    });
    const { status, note } = statusFor(fixture, result.decision);
    return {
      id: fixture.id,
      category: fixture.expectedCategory ?? "(clean)",
      expected: fixture.expected,
      actual: result.decision,
      actualCategory: result.category ?? "—",
      status,
      note,
    };
  });

  db.close();

  // Per-category table, grouped and sorted.
  const byCategory = new Map<string, EvalRow[]>();
  for (const row of rows) {
    const group = byCategory.get(row.category) ?? [];
    group.push(row);
    byCategory.set(row.category, group);
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  for (const category of [...byCategory.keys()].sort()) {
    console.log(`── ${category} ${"─".repeat(Math.max(1, 60 - category.length))}`);
    for (const row of byCategory.get(category) ?? []) {
      console.log(
        `  ${pad(row.id, 26)} ${pad(row.expected, 16)} -> ${pad(row.actual, 16)} ${pad(row.status, 12)}${row.note ? ` ${row.note}` : ""}`,
      );
    }
  }

  const safetyFails = rows.filter((r) => r.status === "SAFETY FAIL");
  const warns = rows.filter((r) => r.status === "WARN");
  const passes = rows.filter((r) => r.status === "PASS");
  const unavailable = rows.filter((r) => r.actualCategory === "classifier-unavailable");

  console.log(
    `\nSummary: ${passes.length} PASS, ${warns.length} WARN, ${safetyFails.length} SAFETY FAIL (of ${rows.length})`,
  );
  if (warns.length > 0) {
    console.log("\nOver-rejections / safe mismatches (prompt-tuning candidates):");
    for (const row of warns) {
      console.log(`  ${row.id}: expected ${row.expected}, got ${row.actual} — ${row.note}`);
    }
  }
  if (unavailable.length === rows.length) {
    console.error(
      "\nEvery call failed closed (classifier-unavailable) — the API was never reachable, so nothing was actually evaluated. Treating as failure.",
    );
    return 1;
  }
  if (safetyFails.length > 0) {
    console.error("\nSAFETY FAIL — the live gate wrongly admitted or mis-routed:");
    for (const row of safetyFails) {
      console.error(`  ${row.id}: expected ${row.expected}, got ${row.actual} — ${row.note}`);
    }
    console.error(
      "\nIterate the classifier system prompt in src/compliance/classifier.ts and re-run.",
    );
    return 1;
  }

  console.log("\nAll safety bars held: zero wrongly-approved fixtures (Success Criterion 2).");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("gate-eval crashed:", err);
    process.exitCode = 1;
  });
