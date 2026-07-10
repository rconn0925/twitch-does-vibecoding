import { describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords, recordPipelineStage } from "../audit/record.js";
import { translate } from "./progress-events.js";

/**
 * BUILD-02 translation-layer contract: translate() is the SOLE inspector of raw
 * Agent SDK message/hook shapes and the ONLY place they map into the small,
 * stable PipelineStage vocabulary (PILL_BY_MODE analog). Fixtures are hand-built
 * fake SDK messages — no real SDK session, no network.
 */
describe("progress-events translate() — raw SDK stream → PipelineStage", () => {
  it("maps a SubagentStart for the research agent to 'researching'", () => {
    expect(translate({ hook_event_name: "SubagentStart", agent_type: "research" })).toBe(
      "researching",
    );
  });

  it("maps a SubagentStop for the build agent to 'building'", () => {
    expect(translate({ hook_event_name: "SubagentStop", agent_type: "build" })).toBe("building");
  });

  it("maps a task_progress system message by subagent_type (research → researching)", () => {
    expect(
      translate({ type: "system", subtype: "task_progress", subagent_type: "research" }),
    ).toBe("researching");
  });

  it("maps the plan step to 'planning'", () => {
    expect(translate({ type: "system", subtype: "task_progress", subagent_type: "plan" })).toBe(
      "planning",
    );
    expect(translate({ hook_event_name: "SubagentStart", agent_type: "plan" })).toBe("planning");
  });

  it("maps a SubagentStart for the build agent to 'building'", () => {
    expect(translate({ hook_event_name: "SubagentStart", agent_type: "build" })).toBe("building");
  });

  it("maps a clean result completion to 'done'", () => {
    expect(translate({ type: "result", subtype: "success", is_error: false })).toBe("done");
  });

  it("maps error result subtypes to 'failed'", () => {
    expect(translate({ type: "result", subtype: "error_during_execution" })).toBe("failed");
    expect(translate({ type: "result", subtype: "error_max_turns" })).toBe("failed");
    expect(translate({ type: "result", subtype: "error_max_budget_usd" })).toBe("failed");
  });

  it("maps a model refusal to 'refused' (not 'failed') — D3-08 first-class event", () => {
    expect(translate({ type: "system", subtype: "model_refusal_fallback", trigger: "refusal" })).toBe(
      "refused",
    );
    expect(translate({ type: "system", subtype: "model_refusal_no_fallback" })).toBe("refused");
    // The RESEARCH.md code-example shape (result + refusal) also maps to refused.
    expect(translate({ type: "result", subtype: "refusal" })).toBe("refused");
  });

  it("returns null for an unrecognized raw SDK message type — raw types never leak", () => {
    expect(translate({ type: "system", subtype: "commands_changed" })).toBeNull();
    expect(translate({ type: "assistant" })).toBeNull();
    expect(translate({ type: "stream_event" })).toBeNull();
  });

  it("returns null (fail-closed) for an unknown agent_type — never throws", () => {
    expect(translate({ hook_event_name: "SubagentStart", agent_type: "mystery" })).toBeNull();
    expect(
      translate({ type: "system", subtype: "task_progress", subagent_type: "mystery" }),
    ).toBeNull();
  });

  it("returns null (never throws) for junk / non-object input", () => {
    expect(translate(null)).toBeNull();
    expect(translate(undefined)).toBeNull();
    expect(translate(42)).toBeNull();
    expect(translate("SubagentStart")).toBeNull();
    expect(translate({})).toBeNull();
  });
});

describe("recordPipelineStage — one audit row per stage transition (D3-13)", () => {
  it("writes exactly one pipeline_stage row with source 'orchestrator' and the task id", () => {
    const db = openDb(":memory:");
    recordPipelineStage(db, {
      taskId: "task-42",
      stage: "building",
      streamMode: "BUILD_IN_PROGRESS",
    });
    const rows = listAuditRecords(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("pipeline_stage");
    expect(rows[0]?.source).toBe("orchestrator");
    expect(rows[0]?.decision).toBe("building");
    expect(rows[0]?.task_id).toBe("task-42");
    expect(rows[0]?.stream_mode).toBe("BUILD_IN_PROGRESS");
    db.close();
  });
});
