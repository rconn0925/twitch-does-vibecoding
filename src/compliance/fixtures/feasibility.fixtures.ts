/**
 * Feasibility fixtures — ≥5 cases anchored on D-13/D-14.
 *
 * The feasibility yardstick judges suggestions as increments to the one big
 * ongoing project ("buildable as one demoable step"), not as whole apps.
 *
 * Too-large/expensive/tedious → rejected/feasibility with suggest-trim
 * feedback in the rationale (D-13).
 */

import type { GateCategory, GateDecision } from "../../shared/types.js";

export interface GateFixture {
  id: string;
  text: string;
  expected: GateDecision;
  expectedCategory?: GateCategory;
  note: string;
}

const fixtures: GateFixture[] = [
  // ─── Rejected: too big ─────────────────────────────────────────────
  {
    id: "feat-01-chess",
    text: "Research every possible chess position and catalog the optimal move for each",
    expected: "rejected",
    expectedCategory: "feasibility",
    note: "User's canonical oversized-task example — 10^120 positions, not one demoable step",
  },
  {
    id: "feat-02-rust-rewrite",
    text: "Rewrite the whole app in Rust",
    expected: "rejected",
    expectedCategory: "feasibility",
    note: "Full-language rewrite is a project, not an increment",
  },
  {
    id: "feat-03-full-ml",
    text: "Build a full machine learning pipeline that trains a custom model on chat sentiment data",
    expected: "rejected",
    expectedCategory: "feasibility",
    note: "ML pipeline with model training — far too much for a live build step",
  },
  {
    id: "feat-04-social-network",
    text: "Build a full social network with profiles, feeds, messaging, and notifications",
    expected: "rejected",
    expectedCategory: "feasibility",
    note: "A complete product, not a single increment to the ongoing project",
  },

  // ─── Approved: feasible increments ─────────────────────────────────
  {
    id: "feat-05-dark-mode",
    text: "Add a dark-mode toggle to the dashboard",
    expected: "approved",
    expectedCategory: undefined,
    note: "Simple feature toggle — clearly buildable as one demoable step",
  },
  {
    id: "feat-06-counter",
    text: "Add a viewer count badge that shows how many people are watching right now",
    expected: "approved",
    expectedCategory: undefined,
    note: "Small, well-scoped API call — one demoable step",
  },
  {
    id: "feat-07-emoji",
    text: "Add a reaction emoji bar where viewers can click emojis to react to the current build",
    expected: "approved",
    expectedCategory: undefined,
    note: "Feature with clear scope — one increment to the existing project",
  },
];

export { fixtures as FEASIBILITY_FIXTURES };
export default fixtures;
