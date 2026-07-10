import type { GateResult, SuggestionCandidate } from "../shared/types.js";

export interface Comp02Deps {
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
}

export type Comp02Outcome =
  | { proceed: true }
  | { proceed: false; disposition: "rejected"; category: string | null }
  | { proceed: false; disposition: "held" };

export function screenBuildPlan(
  _deps: Comp02Deps,
  _args: { taskId: string; planText: string },
): Promise<Comp02Outcome> {
  throw new Error("not implemented");
}

export function screenOutputBatch(
  _deps: Comp02Deps,
  _args: { taskId: string; outputText: string },
): Promise<Comp02Outcome> {
  throw new Error("not implemented");
}
