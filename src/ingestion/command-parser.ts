/**
 * Command parser — the first parse of raw viewer-authored chat text
 * (adversarial by design; T-02-05).
 *
 * Pure transform: imports nothing but zod, does no I/O, and is TOTAL over
 * all input strings — anything unrecognized (including malformed !vote and
 * bare !suggest) returns null with no throw, matching D2-15's silence rule
 * and the project's never-throw-into-caller pattern. A malformed chat
 * message must never crash the EventSub listener.
 *
 * The 2000-char suggestion cap mirrors submitCandidate's CandidateSchema
 * bound so a parse-accepted suggestion can never fail the funnel's own
 * length validation downstream.
 */

import { z } from "zod";

const SuggestCommand = z.object({
  kind: z.literal("suggest"),
  text: z.string().min(1).max(2000),
});

/**
 * quick-q5n tier-1 voted command: `!build <idea>` — the new-project intent.
 * Mirrors SuggestCommand's shape and 2000-char cap; the regex below is the
 * SAME shape as main.ts's BUILD_COMMAND so both surfaces agree on what a
 * !build token is.
 */
const BuildCommand = z.object({
  kind: z.literal("build"),
  text: z.string().min(1).max(2000),
});

/**
 * quick-q5n tier-1 voted command: `!revert` / `!undo` — the undo-last-change
 * intent. STRICT no-arg match: trailing text → null, so no chat-derived free
 * text can ever ride a revert (T-q5n-02).
 */
const RevertCommand = z.object({
  kind: z.literal("revert"),
});

/**
 * The ONLY text a revert candidate ever carries — server-composed, zero
 * chat-derived bytes (T-q5n-02). Every viewer's revert request is byte-identical,
 * so intake's duplicate check naturally dedups once one is pooled/pending.
 */
export const REVERT_REQUEST_TEXT = "Revert the last change to the current project";

// Why 5: matches DEFAULT_ROUND_MAX_OPTIONS (state-machine/round.ts, quick-l2a
// user amendment — vote options cap at 5 even when the pool holds 10).
// recordVote() remains the authoritative bound against the LIVE option count:
// an in-range-but-unused vote (e.g. "!vote 5" in a 3-option round) is silently
// ignored per D2-15, so a custom ROUND_MAX_OPTIONS below 5 stays safe.
const VoteCommand = z.object({
  kind: z.literal("vote"),
  option: z.number().int().min(1).max(5),
});

/**
 * quick-260711-ly4 chat-voted CHAOS ballot option: `!chaos` — submits a single
 * server-composed CHAOS candidate that competes in the normal vote round (like
 * !revert/!swapbuild). STRICT no-arg match (RevertCommand idiom): trailing text
 * → null, so chaos can never carry chat-derived text (T-rs3-01).
 */
const ChaosCommand = z.object({
  kind: z.literal("chaos"),
});

/**
 * The ONLY text a CHAOS candidate ever carries — server-composed, zero
 * chat-derived bytes (mirrors REVERT_REQUEST_TEXT). Every viewer's !chaos
 * produces this byte-identical text, so the pool's duplicate check naturally
 * dedups to at most ONE pooled CHAOS candidate at a time (quick-260711-ly4).
 */
export const CHAOS_CANDIDATE_TEXT = "CHAOS — 5 minutes of mayhem";

/**
 * quick-t8k tier-1 voted command: `!swapbuild <name>` — the portfolio-swap
 * intent. The name is a project reference but still chat-derived text, so it
 * mirrors SuggestCommand's funnel-bound 2000-char cap and is gate-screened
 * before pooling like every other tier-1 command.
 */
const SwapbuildCommand = z.object({
  kind: z.literal("swapbuild"),
  text: z.string().min(1).max(2000),
});

/**
 * quick-t8k tier-2 instant info commands: !projects / !current / !repo /
 * !help (!commands aliases to help) / !apps (quick-1ki — the playable-gallery
 * link). STRICT no-arg (RevertCommand idiom) — trailing text → null.
 * Read-only: dispatch calls an optional seam and returns; NO gate call, NO
 * vote, NO state change ever rides one of these.
 */
export type InfoCommandKind = "projects" | "current" | "repo" | "help" | "apps";

const InfoCommand = z.object({
  kind: z.literal("info"),
  info: z.enum(["projects", "current", "repo", "help", "apps"]),
});

/** Discriminated result of parsing a chat message as a command. No fork command exists (quick-q5n scope gate). */
export type ParsedCommand =
  | { kind: "suggest"; text: string }
  | { kind: "vote"; option: number }
  | { kind: "build"; text: string }
  | { kind: "revert" }
  | { kind: "chaos" }
  | { kind: "swapbuild"; text: string }
  | { kind: "info"; info: InfoCommandKind };

/**
 * Parse a raw chat message into a typed command, or null when the message
 * is not a recognized command. Never throws (safeParse at this untrusted
 * boundary — fail-closed-to-null).
 */
export function parseCommand(messageText: string): ParsedCommand | null {
  const trimmed = messageText.trim();

  const suggestMatch = /^!suggest\s+(.+)$/i.exec(trimmed);
  if (suggestMatch?.[1]) {
    const parsed = SuggestCommand.safeParse({ kind: "suggest", text: suggestMatch[1] });
    return parsed.success ? parsed.data : null;
  }

  const voteMatch = /^!vote\s+([1-5])$/i.exec(trimmed);
  if (voteMatch?.[1]) {
    const parsed = VoteCommand.safeParse({ kind: "vote", option: Number(voteMatch[1]) });
    return parsed.success ? parsed.data : null;
  }

  // quick-q5n: !build <idea> — same regex shape as main.ts's BUILD_COMMAND so
  // the free-reign interceptor and this parser agree on what a !build token is.
  const buildMatch = /^!build\s+(.+)$/i.exec(trimmed);
  if (buildMatch?.[1]) {
    const parsed = BuildCommand.safeParse({ kind: "build", text: buildMatch[1] });
    return parsed.success ? parsed.data : null;
  }

  // quick-t8k: !swapbuild <name> — quoted AND unquoted names both parse; ONE
  // pair of surrounding double quotes is stripped, then re-trimmed (an empty
  // quoted name → null). The text stays funnel-bound (min 1 / max 2000).
  const swapMatch = /^!swapbuild\s+(.+)$/i.exec(trimmed);
  if (swapMatch?.[1]) {
    let text = swapMatch[1].trim();
    const quoted = /^"([\s\S]*)"$/.exec(text);
    if (quoted) text = (quoted[1] ?? "").trim();
    const parsed = SwapbuildCommand.safeParse({ kind: "swapbuild", text });
    return parsed.success ? parsed.data : null;
  }

  // quick-q5n: !revert / !undo — strict no-arg; "!revert something" is NOT a
  // command (null), so revert candidates can never carry chat-derived text.
  if (/^!(revert|undo)$/i.test(trimmed)) {
    const parsed = RevertCommand.safeParse({ kind: "revert" });
    return parsed.success ? parsed.data : null;
  }

  // quick-260711-ly4: !chaos — strict no-arg; "!chaos anything" is NOT a command
  // (null), so the CHAOS ballot candidate can never smuggle chat text anywhere.
  if (/^!chaos$/i.test(trimmed)) {
    const parsed = ChaosCommand.safeParse({ kind: "chaos" });
    return parsed.success ? parsed.data : null;
  }

  // quick-t8k tier-2 info commands — strict no-arg; "!projects list" is NOT a
  // command (null). "!commands" is an alias of "!help".
  const infoMatch = /^!(projects|current|repo|help|commands|apps)$/i.exec(trimmed);
  if (infoMatch?.[1]) {
    const token = infoMatch[1].toLowerCase();
    const parsed = InfoCommand.safeParse({
      kind: "info",
      info: token === "commands" ? "help" : token,
    });
    return parsed.success ? parsed.data : null;
  }

  // Not a recognized command — ignored, no feedback (D2-15 chat-noise rule).
  return null;
}
