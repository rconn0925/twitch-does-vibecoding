/**
 * Builder-view feed projection (quick-x7d) — the ring buffer between the build
 * session and the /builder broadcast wire.
 *
 * SAFETY MODEL (binding — see the quick-x7d threat register):
 *  - This module receives ONLY display-shaped data. Zero SDK types cross into
 *    this file: the build session (the declared SDK-shape containment
 *    boundary) narrows tool_use blocks down to ApprovedBatchDisplay BEFORE
 *    calling in — raw tool names / input keys never reach here (T-x7d-02).
 *  - Every call site of the sink is post-screening by construction: the title
 *    is the same gate-approved, already-broadcast string the overlay build
 *    panel shows; paths/snippets come ONLY from output batches that
 *    screenOutputBatch APPROVED — the tap sits after the proceed guard in
 *    build-session.ts, so rejected content is unreachable by control flow
 *    (T-x7d-01).
 *  - The line vocabulary is a CLOSED 5-kind set with server-composed text:
 *    fixed captions + the truncated title + "Writing/Editing <path>" +
 *    capped snippets. Nothing else can be constructed (T-x7d-02).
 *  - buildStarted() clears the buffer, so a killed/vetoed build's lines never
 *    leak into the next build's feed (T-x7d-05). There is deliberately NO
 *    clear-on-terminal-stage and NO abort method: a halted build's feed just
 *    stops (consistent with never emitting a false "BUILT IT").
 *  - The buffer is a bounded ring (50 lines) — memory can never grow without
 *    bound under a long build (T-x7d-07).
 */

import { EventEmitter } from "node:events";
import { BUILDER_FEED_CHANGED } from "../shared/events.js";
import type { PipelineStage } from "../shared/types.js";

/**
 * One wire line. `text` is ALWAYS server-composed (fixed copy + already-
 * screened data); the kind set is closed — `stage-warn` (failed/refused) is
 * what the client renders amber (never red, D2-18).
 */
export interface BuilderFeedLine {
  kind: "title" | "stage" | "stage-warn" | "activity" | "snippet";
  text: string;
}

/**
 * A COMP-02-APPROVED output batch, already narrowed to display shape by
 * extractApprovedBatchDisplays (build-session.ts). Raw tool names never cross:
 * Write → "Writing"; Edit/MultiEdit/NotebookEdit → "Editing".
 */
export interface ApprovedBatchDisplay {
  verb: "Writing" | "Editing";
  path: string;
  text: string;
}

/** The sink side the build session drives (every call is post-screening). */
export interface BuilderFeedSink {
  /** A fresh pipeline started: CLEAR the buffer, announce the title. */
  buildStarted(title: string): void;
  /** A pipeline-stage beat — mapped onto the FIXED caption table only. */
  stage(stage: PipelineStage): void;
  /** COMP-02-approved Write/Edit batches — the only source of paths/snippets. */
  batchApproved(displays: ApprovedBatchDisplay[]): void;
}

/** Sink + the source side the overlay server consumes (list + on). */
export interface BuilderFeed extends BuilderFeedSink {
  list(): readonly BuilderFeedLine[];
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/** Ring bound: oldest lines beyond this are dropped (T-x7d-07). */
export const DEFAULT_MAX_LINES = 50;
/** The SAME 80-char cap the overlay build panel applies to this SAME string. */
export const TITLE_MAX = 80;
export const SNIPPET_MAX_CHARS = 200;
export const SNIPPET_MAX_LINES = 3;

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

/**
 * Server-side snippet cap (authoritative; the CSS max-height is only the
 * backstop): first SNIPPET_MAX_LINES lines, then hard-sliced to
 * SNIPPET_MAX_CHARS chars, with a trailing ellipsis when truncated.
 */
function capSnippet(text: string): string {
  const lines = text.split("\n");
  let out = text;
  let truncated = false;
  if (lines.length > SNIPPET_MAX_LINES) {
    out = lines.slice(0, SNIPPET_MAX_LINES).join("\n");
    truncated = true;
  }
  if (out.length > SNIPPET_MAX_CHARS) {
    out = out.slice(0, SNIPPET_MAX_CHARS);
    truncated = true;
  }
  return truncated ? `${out}…` : out;
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

    batchApproved(displays: ApprovedBatchDisplay[]): void {
      if (displays.length === 0) return;
      for (const display of displays) {
        append({ kind: "activity", text: `${display.verb} ${display.path}` });
        if (display.text.length > 0) {
          append({ kind: "snippet", text: capSnippet(display.text) });
        }
      }
      // ONE emit per approved batch, not per line.
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
