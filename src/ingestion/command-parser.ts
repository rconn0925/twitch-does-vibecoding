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

// Why 5: matches DEFAULT_ROUND_MAX_OPTIONS (state-machine/round.ts, quick-l2a
// user amendment — vote options cap at 5 even when the pool holds 10).
// recordVote() remains the authoritative bound against the LIVE option count:
// an in-range-but-unused vote (e.g. "!vote 5" in a 3-option round) is silently
// ignored per D2-15, so a custom ROUND_MAX_OPTIONS below 5 stays safe.
const VoteCommand = z.object({
  kind: z.literal("vote"),
  option: z.number().int().min(1).max(5),
});

/** Discriminated result of parsing a chat message as a command. */
export type ParsedCommand = { kind: "suggest"; text: string } | { kind: "vote"; option: number };

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

  // Not a recognized command — ignored, no feedback (D2-15 chat-noise rule).
  return null;
}
