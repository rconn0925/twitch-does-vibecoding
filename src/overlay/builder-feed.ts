/**
 * Builder-view feed projection (quick-x7d, widened by quick-nhv) — the ring
 * buffer between the build session and the /builder broadcast wire.
 *
 * SAFETY MODEL (binding — see the quick-x7d + quick-nhv threat registers):
 *  - This module receives ONLY display-shaped data. Zero SDK types cross into
 *    this file: the build session (the declared SDK-shape containment
 *    boundary) narrows every message down to ApprovedContentItem BEFORE
 *    calling in. Tool NAMES now cross deliberately — as already-SCREENED
 *    display data narrowed by build-session's extractApprovedContent — but
 *    raw SDK shapes/input keys (tool_use, input, file_path, new_string, …)
 *    still never reach here (T-x7d-02, updated by T-nhv-02).
 *  - Every call site of the sink is post-screening by CONTROL FLOW: the title
 *    is the same gate-approved, already-broadcast string the overlay build
 *    panel shows; reasoning/tool-call/diff content comes ONLY from messages
 *    that screenOutputBatch APPROVED — contentApproved() sits strictly after
 *    the `!screen.proceed → break` guard in build-session.ts, so rejected
 *    content is unreachable (T-x7d-01, extended by T-nhv-01 to cover
 *    reasoning and tool calls too).
 *  - The line vocabulary is a CLOSED 7-kind set with server-composed text:
 *    fixed captions + the truncated title + "Writing/Editing <path>" +
 *    reasoning prose + "Tool(arg)" calls + full-fidelity diffs. Nothing else
 *    can be constructed (T-nhv-02).
 *  - buildStarted() clears the buffer, so a killed/vetoed build's lines never
 *    leak into the next build's feed (T-x7d-05). There is deliberately NO
 *    clear-on-terminal-stage and NO abort method: a halted build's feed just
 *    stops (consistent with never emitting a false "BUILT IT").
 *  - The buffer is a bounded ring (300 lines) and every reasoning/diff line
 *    is hard-capped at CONTENT_MAX_CHARS — a MEMORY backstop, not a display
 *    cap: full screened batches below it pass byte-for-byte, so memory can
 *    never grow without bound under a long build (T-x7d-07, updated).
 */

import { EventEmitter } from "node:events";
import { BUILDER_FEED_CHANGED } from "../shared/events.js";
import type { PipelineStage } from "../shared/types.js";

/**
 * One wire line. `text` is ALWAYS server-composed (fixed copy + already-
 * screened data); the kind set is closed — `stage-warn` (failed/refused) is
 * what the client renders amber (never red, D2-18). quick-nhv widened the
 * set: `reasoning` (assistant prose), `tool-call` ("Tool(arg)"), and `diff`
 * (full-fidelity file content) replaced the retired `snippet` kind.
 */
export interface BuilderFeedLine {
  kind: "title" | "stage" | "stage-warn" | "activity" | "reasoning" | "tool-call" | "diff";
  text: string;
}

/**
 * A COMP-02-APPROVED content item, already narrowed to display shape by
 * extractApprovedContent (build-session.ts). Defined FEED-side — never an SDK
 * shape. Write → "Writing"; Edit/MultiEdit/NotebookEdit → "Editing". A
 * tool-call's `arg` is the screened primary argument (may be "").
 */
export type ApprovedContentItem =
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; tool: string; arg: string }
  | { type: "file-change"; verb: "Writing" | "Editing"; path: string; text: string };

/** The sink side the build session drives (every call is post-screening). */
export interface BuilderFeedSink {
  /** A fresh pipeline started: CLEAR the buffer, announce the title. */
  buildStarted(title: string): void;
  /** A pipeline-stage beat — mapped onto the FIXED caption table only. */
  stage(stage: PipelineStage): void;
  /** COMP-02-approved message content — the only source of reasoning/tool-call/diff lines. */
  contentApproved(items: ApprovedContentItem[]): void;
}

/** Sink + the source side the overlay server consumes (list + on). */
export interface BuilderFeed extends BuilderFeedSink {
  list(): readonly BuilderFeedLine[];
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/** Ring bound: oldest lines beyond this are dropped (T-x7d-07). */
export const DEFAULT_MAX_LINES = 300;
/** The SAME 80-char cap the overlay build panel applies to this SAME string. */
export const TITLE_MAX = 80;
/**
 * Per-line MEMORY backstop for reasoning/diff text (T-x7d-07) — NOT a display
 * cap. Full screened batches below it pass byte-for-byte; only pathological
 * multi-KB lines are hard-capped with an ellipsis.
 */
export const CONTENT_MAX_CHARS = 16_000;
/** Tool-call primary-arg display truncation ("Tool(arg…)"). */
export const TOOL_ARG_MAX = 160;

/**
 * FIXED stage caption table — overlay.js STAGE_CAPTION wording verbatim.
 * failed/refused are `stage-warn` (amber client-side, never red). `queued` is
 * deliberately absent, and ANY unknown value falls through to no-append —
 * fail closed: an unrecognized stage can never invent a wire line.
 */
const STAGE_LINES: Partial<Record<PipelineStage, BuilderFeedLine>> = {
  researching: { kind: "stage", text: "Digging into the idea" },
  planning: { kind: "stage", text: "Drafting the build plan" },
  building: { kind: "stage", text: "Writing the code" },
  done: { kind: "stage", text: "Live on screen now" },
  failed: { kind: "stage-warn", text: "Regrouping…" },
  refused: { kind: "stage-warn", text: "Skipping this one" },
};

/** JS-side truncation with an ellipsis (overlay.js truncate pattern). */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Construct the builder feed — one instance is both sink and source. */
export function createBuilderFeed(opts?: { maxLines?: number }): BuilderFeed {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const emitter = new EventEmitter();
  let lines: BuilderFeedLine[] = [];

  function append(line: BuilderFeedLine): void {
    lines.push(line);
    // Ring bound: drop oldest beyond maxLines.
    if (lines.length > maxLines) {
      lines = lines.slice(lines.length - maxLines);
    }
  }

  return {
    buildStarted(title: string): void {
      // T-x7d-05: the next build starts CLEAN — a killed build's lines can
      // never leak forward into this build's feed.
      lines = [];
      append({ kind: "title", text: `NOW BUILDING: ${truncate(title, TITLE_MAX)}` });
      emitter.emit(BUILDER_FEED_CHANGED);
    },

    stage(stage: PipelineStage): void {
      const line = STAGE_LINES[stage];
      if (!line) return; // queued / unknown → nothing appended (fail closed)
      append({ ...line });
      emitter.emit(BUILDER_FEED_CHANGED);
    },

    contentApproved(items: ApprovedContentItem[]): void {
      if (items.length === 0) return; // nothing screened in → no append, no emit
      for (const item of items) {
        switch (item.type) {
          case "reasoning":
            append({ kind: "reasoning", text: truncate(item.text, CONTENT_MAX_CHARS) });
            break;
          case "tool-call":
            append({ kind: "tool-call", text: `${item.tool}(${truncate(item.arg, TOOL_ARG_MAX)})` });
            break;
          case "file-change":
            append({ kind: "activity", text: `${item.verb} ${item.path}` });
            if (item.text.length > 0) {
              append({ kind: "diff", text: truncate(item.text, CONTENT_MAX_CHARS) });
            }
            break;
        }
      }
      // ONE emit per approved message, not per line.
      emitter.emit(BUILDER_FEED_CHANGED);
    },

    list(): readonly BuilderFeedLine[] {
      return lines;
    },

    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
  };
}
