/**
 * AI-scene terminal viewer (quick-260711-ly4, widened by quick-nhv) — a
 * claude-code-styled CLI client of the SAME screened /builder feed the
 * browser page consumes.
 *
 * Ross launches this in a real Windows Terminal window and OBS window-captures
 * it (docs/OPERATIONS.md §10). The wire is now the CLOSED 7-kind screened
 * vocabulary (title/stage/stage-warn/activity/reasoning/tool-call/diff) —
 * the build agent's real reasoning prose, tool calls, and full-fidelity file
 * diffs, every byte COMP-02-approved before it reached the wire. The viewer
 * trails real time by the per-message COMP-02 screening latency plus a
 * BOUNDED typewriter debt: pacing decays the backlog in ~2s and any burst
 * ≥ BURST_DRAIN_CHARS (8K) plain chars blits instantly, so typing debt is
 * ≤ ~10s worst case (quick-rtd). That small lag is normal, not a stall.
 *
 * LIVENESS HEARTBEAT (quick-rtd): during a build, ≥10s of render quiet shows
 * ONE ephemeral dim status line ("· the AI is thinking — 2m 40s in…" + a
 * files ticker once files exist), repainted IN PLACE (\r + ESC[2K) on a 1s
 * tick and erased before any real output writes. It is composed entirely
 * client-side (elapsed time + counters + already-screened activity paths,
 * re-sanitized) — it NEVER enters lastFeed, the backlog, or any wire-facing
 * structure, so the append-only frame is never dirtied and zero new bytes
 * cross the wire. DIM only, calm copy, never red, never error wording.
 *
 * SAFETY MODEL (mirrors builder.js, plus terminal-specific hardening —
 * T-ly4-01/T-ly4-02 wording stays binding):
 *  - T-ly4-01: wire text can never restyle the terminal — sanitizeWireText
 *    strips ESC and ALL C0/C1 control characters (except \n) BEFORE any
 *    styling is applied, on every wire string — including multi-KB diffs.
 *  - T-ly4-02: render-only by construction — nothing here evals, execs,
 *    fetches, or re-parses wire content; the CLOSED 7-kind vocabulary is
 *    consumed via a fixed style map and unknown kinds (including the RETIRED
 *    "snippet") render NOTHING.
 *  - Broadcast rules (D2-18): stage-warn is AMBER, never red; on disconnect
 *    the last render freezes and reconnection retries silently with the
 *    builder.js backoff curve — no error text, nothing red, ever.
 *
 * Run:  npm run builder:terminal          (OVERLAY_PORT default 4901)
 *       npx tsx scripts/builder-terminal.ts --port 4999   (e.g. the harness)
 */

import { pathToFileURL } from "node:url";
import WebSocket from "ws";

/** One wire line — the shape of `OverlayState.builderFeed` entries. */
export interface FeedLine {
  kind: string;
  text: string;
}

// --- ANSI SGR palette (hand-rolled; no chalk, no new dependencies) ---------

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const BRIGHT_WHITE = `${ESC}[97m`;
/** 256-color amber for stage-warn — NEVER a red code (D2-18). */
const AMBER = `${ESC}[38;5;214m`;
/** Muted gray for diff gutters/body. */
const MUTED = `${ESC}[38;5;246m`;
/** Soft green for the tool-call marker (claude-code style) — not red (D2-18). */
const TOOL_GREEN = `${ESC}[38;5;114m`;
// [2J erases the viewport, [3J erases the SCROLLBACK too, [H homes the cursor —
// so a repaint (new build / reconnect-to-idle) leaves a truly blank terminal on
// THE AI scene, never old lines lingering in scrollback (Ross 2026-07-12).
const CLEAR_SCREEN = `${ESC}[2J${ESC}[3J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

// Defensive JS caps behind the server-side authoritative caps.
// LINE_MAX guards single-line kinds (title/stage/stage-warn/activity/tool-call);
// DIFF_MAX mirrors the server's CONTENT_MAX_CHARS memory backstop for the
// multi-line kinds (reasoning/diff) — NOT a display cap: full screened
// content below it renders byte-for-byte.
export const LINE_MAX = 120;
export const DIFF_MAX = 16_000;

/** JS-side truncation with an ellipsis (builder.js truncate pattern). */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Strip ESC and every C0/C1 control character except \n; tabs become a
 * single space. Wire text is server-composed, but a stray ESC byte must
 * never restyle the terminal — applied BEFORE any styling, on every wire
 * string (T-ly4-01). Char-code loop rather than a regex so no control
 * characters appear in source patterns.
 */
export function sanitizeWireText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      out += ch; // \n survives (multi-line snippets)
      continue;
    }
    if (code === 0x09) {
      out += " "; // tab → space
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue; // C0, DEL, C1 — dropped
    }
    out += ch;
  }
  return out;
}

/**
 * Render one wire line to a styled terminal string, or null for anything
 * outside the CLOSED 7-kind vocabulary (fail closed). The retired "snippet"
 * kind falls through to null like any unknown. Text is sanitized BEFORE
 * styling and truncated with the backstop caps above.
 */
export function renderLine(line: unknown): string | null {
  if (typeof line !== "object" || line === null) return null;
  const { kind, text } = line as { kind?: unknown; text?: unknown };
  if (typeof kind !== "string" || typeof text !== "string") return null;

  const clean = sanitizeWireText(text);
  switch (kind) {
    case "title": {
      // New-build header: blank line, dim rule, bold bright title, dim rule.
      // A title implies the server buffer was just cleared (buildStarted).
      const rule = `${DIM}${"─".repeat(60)}${RESET}`;
      return `\n${rule}\n${BOLD}${BRIGHT_WHITE}${truncate(clean, LINE_MAX)}${RESET}\n${rule}`;
    }
    case "stage":
      return `${DIM}● ${truncate(clean, LINE_MAX)}${RESET}`;
    case "stage-warn":
      // AMBER, never red (D2-18).
      return `${AMBER}● ${truncate(clean, LINE_MAX)}${RESET}`;
    case "activity":
      // Text already contains the verb ("Writing/Editing <path>") — no re-parse.
      return `${DIM}⏺${RESET} ${truncate(clean, LINE_MAX)}`;
    case "reasoning":
      // The agent's own prose — plain sanitized text, no bullet/marker
      // (reads like Claude talking in the terminal). Multi-line kind:
      // DIFF_MAX memory backstop only, never the 120-char line cap.
      return truncate(clean, DIFF_MAX);
    case "tool-call":
      // Green ⏺ marker + the server-composed "Tool(arg)" — distinct from the
      // dim activity marker (claude-code tool-call look).
      return `${TOOL_GREEN}⏺${RESET} ${truncate(clean, LINE_MAX)}`;
    case "diff":
      // Full-fidelity gutter block: 2-space indent + dim gray gutter per
      // line. NO 200-char display cap — only the DIFF_MAX memory backstop.
      return truncate(clean, DIFF_MAX)
        .split("\n")
        .map((row) => `  ${DIM}${MUTED}│ ${row}${RESET}`)
        .join("\n");
    default:
      return null; // unknown / retired kind → render NOTHING (fail closed)
  }
}

/**
 * Backlogs at/above this many plain characters blit in ONE tick instead of
 * typing out — a 16KB screened diff lands on screen in seconds, not minutes
 * (quick-rtd; T-rtd-03 accepts the one-shot write as trivial for a real
 * terminal, bounded by DIFF_MAX per line + the 300-line ring anyway).
 */
export const BURST_DRAIN_CHARS = 8_000;

/**
 * Typewriter pacing rate: characters to emit per ~50ms tick given the current
 * plain-character backlog. Floor of 7 chars/tick (≈140 chars/s baseline);
 * below BURST_DRAIN_CHARS catch-up accelerates with ceil(backlog/40) (≈2s
 * decay constant), and at/above it the WHOLE backlog drains in one tick —
 * worst-case typing debt is bounded ≤ ~10s for ANY backlog size. Pure +
 * exported for tests.
 */
export function paceCharsPerTick(backlogChars: number): number {
  if (backlogChars >= BURST_DRAIN_CHARS) return backlogChars;
  return Math.max(7, Math.ceil(backlogChars / 40));
}

// --- Liveness heartbeat helpers (quick-rtd) ---------------------------------
// Pure client-side composition ONLY: the thinking status line never enters
// lastFeed, the backlog, or any wire-facing structure — it is written straight
// to stdout by the CLI shell and repainted in place. Zero new wire bytes.

/** Quiet-gap threshold before the thinking status line appears. */
export const THINKING_QUIET_MS = 10_000;

/**
 * Human elapsed-time formatting for the thinking line: "40s" under a minute,
 * "2m 40s" under an hour, "1h 5m" beyond. Negative/NaN clamp to "0s".
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** The kinds whose presence as the LAST feed line means a build is running. */
const IN_FLIGHT_KINDS = new Set(["title", "stage", "activity", "reasoning", "tool-call", "diff"]);

/**
 * The server's `done` stage caption (src/overlay/builder-feed.ts STAGE_LINES,
 * which is module-private) — pinned by a caption-sync test that drives a REAL
 * createBuilderFeed instance, so caption drift breaks CI instead of silently
 * rotting this predicate (T-rtd-04).
 */
const DONE_CAPTION = "Live on screen now";

/**
 * Fail-closed in-progress predicate on the LAST feed line only:
 *  - undefined (empty feed / idle) → false;
 *  - stage-warn (Regrouping… / Skipping this one) → false — terminal states;
 *  - the done caption → false;
 *  - any other line of the closed 7-kind vocabulary → true;
 *  - any unknown kind → false (fail closed).
 */
export function isBuildInFlight(lastLine: FeedLine | undefined): boolean {
  if (lastLine === undefined) return false;
  if (lastLine.kind === "stage-warn") return false;
  if (lastLine.kind === "stage" && lastLine.text === DONE_CAPTION) return false;
  return IN_FLIGHT_KINDS.has(lastLine.kind);
}

/**
 * File-activity stats recomputed WHOLESALE from the current feed (≤300 lines,
 * cheap; naturally correct across reset diffs and ring drops). Parses ONLY
 * kind "activity" lines with the exact server-composed prefixes "Writing " /
 * "Editing "; counts DISTINCT paths per verb; lastPath is the path of the
 * last activity line (null when none). Malformed activity text and every
 * non-activity kind contribute nothing.
 */
export function fileStatsFromFeed(feed: readonly FeedLine[]): {
  written: number;
  edited: number;
  lastPath: string | null;
} {
  const written = new Set<string>();
  const edited = new Set<string>();
  let lastPath: string | null = null;
  for (const line of feed) {
    if (line.kind !== "activity") continue;
    let path: string | null = null;
    if (line.text.startsWith("Writing ")) {
      path = line.text.slice("Writing ".length);
      if (path.length > 0) written.add(path);
    } else if (line.text.startsWith("Editing ")) {
      path = line.text.slice("Editing ".length);
      if (path.length > 0) edited.add(path);
    }
    if (path !== null && path.length > 0) lastPath = path;
  }
  return { written: written.size, edited: edited.size, lastPath };
}

/**
 * Compose the ephemeral thinking status line, or null while the quiet gap is
 * under THINKING_QUIET_MS. ONE dim line, no trailing newline, DIM open +
 * RESET close ONLY — calm copy, never red, never error wording. lastPath
 * re-passes sanitizeWireText before composition (T-rtd-01), is shortened to
 * its basename, and the total plain text is truncated to the LIVE terminal
 * width (maxCols, capped by LINE_MAX). A line that reaches the terminal's
 * last column would soft-wrap, and the `\r` + ESC[2K repaint then clears
 * only the final wrapped row — leaking one stale row per tick (live incident
 * 2026-07-17: leaked a line every second on the 900px OBS window). The
 * single-row guarantee is width-relative, so the caller passes the live
 * column count each tick.
 */
export function thinkingStatusLine(
  quietMs: number,
  stats: { written: number; edited: number; lastPath: string | null },
  maxCols: number = LINE_MAX,
): string | null {
  if (!(quietMs >= THINKING_QUIET_MS)) return null; // NaN falls through to null
  let plain = `· the AI is thinking — ${formatElapsed(quietMs)} in…`;
  if (stats.written + stats.edited > 0) {
    plain += ` · files: ${stats.written} written`;
    if (stats.edited > 0) plain += `, ${stats.edited} edited`;
  }
  if (stats.lastPath !== null) {
    // Basename only: the full /home/builder/projects/app-N/… prefix is what
    // pushed the line past the window width; the filename carries the signal.
    const base = sanitizeWireText(stats.lastPath).split("/").pop() ?? "";
    if (base.length > 0) plain += ` · last: ${base}`;
  }
  const cap = Math.max(8, Math.min(LINE_MAX, Math.floor(maxCols)));
  // truncate() appends "…" AFTER the slice (max+1 chars) — feed it cap-1 so
  // the final payload never exceeds cap cells (the single-row guarantee).
  const fitted = plain.length > cap ? truncate(plain, cap - 1) : plain;
  return `${DIM}${fitted}${RESET}`;
}

/**
 * Split a styled string into chunks that are either ONE complete ESC sequence
 * or a run of plain characters. The pacer writes escape chunks atomically
 * (never splitting an SGR sequence mid-emission) and counts only plain
 * characters against the per-tick budget. Pure + exported for tests.
 */
export function splitAnsiChunks(text: string): string[] {
  const chunks: string[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      if (plain.length > 0) {
        chunks.push(plain);
        plain = "";
      }
      let j = i + 1;
      if (text[j] === "[") {
        // CSI: ESC [ <params/intermediates 0x20-0x3f> <final 0x40-0x7e>
        j += 1;
        while (j < text.length) {
          const code = text.charCodeAt(j);
          j += 1;
          if (code >= 0x40 && code <= 0x7e) break; // final byte consumed
        }
      } else if (j < text.length) {
        j += 1; // two-char escape (ESC X)
      }
      chunks.push(text.slice(i, j));
      i = j;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain.length > 0) chunks.push(plain);
  return chunks;
}

/**
 * Prefix diff between the last-rendered feed and the incoming one, so the
 * terminal appends incrementally instead of repainting on every push:
 *  - strict prefix  ⇒ append only the tail;
 *  - identical      ⇒ no-op (votes/pool pushes carry an unchanged builderFeed);
 *  - anything else  ⇒ reset (new title cleared the server buffer, the ring
 *    dropped oldest lines, or a reconnect replayed the full state).
 */
export function diffFeed(
  prev: readonly FeedLine[],
  next: readonly FeedLine[],
): { reset: boolean; appended: FeedLine[] } {
  if (next.length >= prev.length) {
    let isPrefix = true;
    for (let i = 0; i < prev.length; i += 1) {
      const a = prev[i];
      const b = next[i];
      if (!a || !b || a.kind !== b.kind || a.text !== b.text) {
        isPrefix = false;
        break;
      }
    }
    if (isPrefix) return { reset: false, appended: next.slice(prev.length) };
  }
  return { reset: true, appended: next.slice() };
}

/** Reconnect backoff, mirroring builder.js exactly. */
export function backoffDelay(attempts: number): number {
  return Math.min(500 * 2 ** attempts, 8000);
}

/**
 * Pull a validated builderFeed out of an OverlayState-shaped push. Returns
 * null when the message isn't shaped like OverlayState; entries that aren't
 * {kind,text} strings are dropped. Everything else in the state is ignored.
 */
function extractFeed(state: unknown): FeedLine[] | null {
  if (typeof state !== "object" || state === null) return null;
  const feed = (state as { builderFeed?: unknown }).builderFeed;
  if (!Array.isArray(feed)) return null;
  const lines: FeedLine[] = [];
  for (const entry of feed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, text } = entry as { kind?: unknown; text?: unknown };
    if (typeof kind !== "string" || typeof text !== "string") continue;
    lines.push({ kind, text });
  }
  return lines;
}

// --- CLI shell (thin I/O layer — not unit-tested) ---------------------------

function main(): void {
  const portFlagIdx = process.argv.indexOf("--port");
  const portArg = portFlagIdx !== -1 ? process.argv[portFlagIdx + 1] : undefined;
  const parsed = Number(portArg ?? process.env.OVERLAY_PORT ?? 4901);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 4901;

  const out = process.stdout;
  let lastFeed: FeedLine[] = [];
  let needsRepaint = true; // first message always paints; also set after a status line
  let attempts = 0;
  let waitingShown = false;

  // Liveness heartbeat state (quick-rtd). The thinking line is ephemeral and
  // terminal-local: statusActive tracks whether the CURRENT terminal row holds
  // it, so it can be erased in place before any real output writes. It never
  // touches lastFeed/backlog/needsRepaint.
  let connected = false;
  let lastRenderActivityAt = Date.now();
  let statusActive = false;
  let stats = fileStatsFromFeed([]);

  function clearStatus(): void {
    if (!statusActive) return;
    out.write(`\r${ESC}[2K`); // erase the in-place status row, column 0
    statusActive = false;
  }

  // Typewriter pacing (quick-nhv): appended rendered lines land in a chunked
  // character backlog drained on a ~50ms tick. Each chunk is either ONE
  // complete ESC sequence (written atomically, budget-free) or plain
  // characters (counted against paceCharsPerTick's budget) — an SGR sequence
  // is never split mid-emission. A reset diff flushes the backlog and
  // repaints instantly.
  let backlog: string[] = [];
  const TICK_MS = 50;

  function backlogPlainChars(): number {
    let n = 0;
    for (const chunk of backlog) {
      if (!chunk.startsWith(ESC)) n += chunk.length;
    }
    return n;
  }

  function enqueueStyled(styled: string): void {
    for (const chunk of splitAnsiChunks(styled)) backlog.push(chunk);
  }

  function drainTick(): void {
    if (backlog.length === 0) return;
    clearStatus(); // the thinking line self-erases before any real output
    let budget = paceCharsPerTick(backlogPlainChars());
    while (backlog.length > 0) {
      const chunk = backlog[0] as string;
      if (chunk.startsWith(ESC)) {
        out.write(chunk); // whole escape sequence, atomic, budget-free
        backlog.shift();
        continue;
      }
      if (budget <= 0) break;
      if (chunk.length <= budget) {
        out.write(chunk);
        budget -= chunk.length;
        backlog.shift();
      } else {
        out.write(chunk.slice(0, budget));
        backlog[0] = chunk.slice(budget);
        budget = 0;
      }
    }
  }
  setInterval(drainTick, TICK_MS);

  out.write(HIDE_CURSOR);
  process.on("exit", () => {
    out.write(SHOW_CURSOR);
  });
  process.on("SIGINT", () => {
    process.exit(0);
  });

  function paintIdle(): void {
    clearStatus();
    out.write(CLEAR_SCREEN);
    out.write(`${DIM}THE AI${RESET}\n\n`);
    out.write(`${DIM}  standing by…${RESET}\n`);
  }

  function paintAll(feed: readonly FeedLine[]): void {
    if (feed.length === 0) {
      paintIdle();
      return;
    }
    clearStatus();
    out.write(CLEAR_SCREEN);
    out.write(`${DIM}THE AI${RESET}\n`);
    writeLines(feed);
  }

  function writeLines(lines: readonly FeedLine[]): void {
    for (const line of lines) {
      const rendered = renderLine(line);
      if (rendered !== null) out.write(`${rendered}\n`);
    }
  }

  function handleMessage(raw: unknown): void {
    let state: unknown;
    try {
      state = JSON.parse(String(raw));
    } catch {
      return; // malformed frame: ignore; the next push resyncs (builder.js)
    }
    const feed = extractFeed(state);
    if (feed === null) return;
    const { reset, appended } = diffFeed(lastFeed, feed);
    if (needsRepaint || reset) {
      // A reset (new build title / ring drop / reconnect replay) FLUSHES the
      // typing backlog and repaints the full feed instantly — a fresh build
      // starts near-empty, so like-live typing resumes from there.
      backlog = [];
      paintAll(feed);
      lastRenderActivityAt = Date.now();
    } else if (appended.length > 0) {
      // Appended lines type out at the paced rate instead of blitting.
      let renderedAny = false;
      for (const line of appended) {
        const rendered = renderLine(line);
        if (rendered !== null) {
          enqueueStyled(`${rendered}\n`);
          renderedAny = true;
        }
      }
      if (renderedAny) lastRenderActivityAt = Date.now();
    }
    lastFeed = feed;
    stats = fileStatsFromFeed(feed); // wholesale recompute on every accepted push
    needsRepaint = false;
  }

  // Liveness heartbeat tick (quick-rtd): 1s cadence, fully self-erasing.
  // Only fires when connected, the typing backlog is EMPTY (cursor sits at
  // column 0 after a completed \n; cursor already hidden), and the last feed
  // line says a build is in flight. Never sets needsRepaint.
  function statusTick(): void {
    if (!connected || backlog.length > 0 || !isBuildInFlight(lastFeed[lastFeed.length - 1])) {
      clearStatus();
      return;
    }
    // Live column read each tick (resize-safe): one column of headroom so the
    // cursor never touches the last cell (which would trigger soft-wrap).
    const cols = (out.columns ?? 80) - 1;
    const line = thinkingStatusLine(Date.now() - lastRenderActivityAt, stats, cols);
    if (line === null) {
      clearStatus();
      return;
    }
    out.write(`\r${ESC}[2K${line}`); // in-place repaint, NO trailing newline
    statusActive = true;
  }
  setInterval(statusTick, 1000);

  function connect(): void {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on("open", () => {
      connected = true;
      attempts = 0;
      waitingShown = false;
    });
    socket.on("message", (data) => {
      handleMessage(data);
    });
    socket.on("close", () => {
      connected = false;
      clearStatus(); // the thinking line never survives a disconnect
      // Broadcast rule: freeze the last render; at most ONE dim status line,
      // no error text, nothing red — then silent backoff retry.
      if (!waitingShown) {
        out.write(`${DIM}· waiting for overlay server…${RESET}\n`);
        waitingShown = true;
        needsRepaint = true; // the status line dirtied the frame
      }
      const delay = backoffDelay(attempts);
      attempts += 1;
      setTimeout(connect, delay);
    });
    socket.on("error", () => {
      socket.terminate(); // triggers 'close' → backoff path
    });
  }

  paintIdle();
  connect();
}

// Windows-safe isMain guard: compare file URLs, never raw paths
// (drive-letter case / slash direction mismatches).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
