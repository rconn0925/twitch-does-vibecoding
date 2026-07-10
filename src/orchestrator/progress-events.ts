/**
 * BUILD-02 / PRES-04 progress translation layer.
 *
 * translate() is the SINGLE, PURE inspector of raw Agent SDK message/hook shapes
 * and the ONLY place they map into the small, stable PipelineStage vocabulary.
 * This is the PILL_BY_MODE analog (src/overlay/server.ts): exactly as raw
 * internal StreamMode words never leak past PILL_BY_MODE, raw SDK message types
 * never leak past this file — nothing downstream imports an SDK message type.
 *
 * Fail-closed discipline (classifier.ts / gate.ts): an unknown or malformed
 * message returns null (no stage change) and NEVER throws. The parameter is
 * typed `unknown` on purpose — translate does its own structural narrowing, so
 * no raw SDK type appears in this module's public signature at all.
 */

import type { PipelineStage } from "../shared/types.js";

/**
 * Fixed agent-type → stage table (the PILL_BY_MODE analog). Only these three
 * known agent/subagent types map to a stage; any other value is unrecognized
 * and fails closed to null. Extending the pipeline means editing THIS table,
 * never scattering shape-inspection across the orchestrator.
 */
const STAGE_BY_AGENT: Record<string, PipelineStage> = {
  research: "researching",
  plan: "planning",
  build: "building",
};

/** A model refusal is a first-class narrated event (D3-08) — refused, not failed. */
const REFUSAL_SUBTYPES = new Set([
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "refusal",
]);

function stageForAgent(agentType: unknown): PipelineStage | null {
  if (typeof agentType !== "string") return null;
  return STAGE_BY_AGENT[agentType] ?? null;
}

/**
 * Translate one raw SDK message or subagent-lifecycle hook input into a
 * PipelineStage, or null when the message carries no stage transition.
 *
 * Precedence matters: a refusal is checked BEFORE the generic result handling so
 * it maps to `refused`, never `failed` (D3-08).
 */
export function translate(message: unknown): PipelineStage | null {
  if (message === null || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;

  // 1) Model refusal → refused (first-class narrated event, before result).
  if (typeof m.subtype === "string" && REFUSAL_SUBTYPES.has(m.subtype)) {
    return "refused";
  }

  // 2) Terminal result message → done | failed.
  if (m.type === "result") {
    if (m.subtype === "success") return "done";
    // Every SDKResultError subtype starts with "error"; anything else on a
    // result frame is treated as a failure too (fail-closed, never a silent pass).
    return "failed";
  }

  // 3) Subagent lifecycle hook events → stage by agent_type.
  if (m.hook_event_name === "SubagentStart" || m.hook_event_name === "SubagentStop") {
    return stageForAgent(m.agent_type);
  }

  // 4) task_progress system message → stage by subagent_type.
  if (m.type === "system" && m.subtype === "task_progress") {
    return stageForAgent(m.subagent_type);
  }

  // 5) Unrecognized → no stage change. Raw SDK types never leak past here.
  return null;
}
