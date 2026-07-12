---
phase: quick-260711-raz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main.ts
  - src/ingestion/narration.ts
  - src/ingestion/narration.test.ts
  - tests/e2e/tier1-commands.e2e.test.ts
autonomous: true
requirements: [QUICK-RAZ-01]

must_haves:
  truths:
    - "During an ACTIVE control window, `!suggest <text>` routes through the SAME window funnel as `!build <text>` (gate classify → build queue) — never the pool, never the vote, NEVER skipping the compliance gate"
    - "An in-window !suggest consumes ZERO intake state: no suggestion cooldown, no per-user pooled cap (explicitly test-asserted, not just implied by the bypass)"
    - "A gate-rejected in-window !suggest gets the existing narrated denial; nothing is queued, nothing is pooled, the window stays open (D-12 time budget untouched)"
    - "Outside a window, !suggest is byte-compatible: parser → intake.check → classify → pool, source 'chat', kind 'suggestion', cooldown consumed"
    - "In-window !build behavior is byte-compatible: the existing tier1 e2e block (describe at tests/e2e/tier1-commands.e2e.test.ts:603) passes UNCHANGED"
    - "Window-open narration tells chat both commands work — server-composed strings only, copy-separation invariant intact (no chance/luck/odds/random/roll words in paid copy)"
  artifacts:
    - path: "src/main.ts"
      provides: "SUGGEST_COMMAND regex + extended buildAwareChatSource interceptor routing in-window !suggest through routeWindowInstruction"
      contains: "SUGGEST_COMMAND"
    - path: "src/ingestion/narration.ts"
      provides: "windowOpenedDonation + windowOpenedChannelPoints beats mentioning both !build and !suggest"
      contains: "!suggest"
    - path: "tests/e2e/tier1-commands.e2e.test.ts"
      provides: "New describe block covering the full in-window !suggest matrix + intake-exemption assertion + !build regression"
      contains: "!suggest"
  key_links:
    - from: "src/main.ts (buildAwareChatSource)"
      to: "routeWindowInstruction → controlWindow.submitInstruction → submitDuringWindow → gate → queue"
      via: "SUGGEST_COMMAND match while controlWindow.snapshot() !== null"
      pattern: "SUGGEST_COMMAND"
    - from: "src/ingestion/narration.ts window-open beats"
      to: "chat sender"
      via: "server-composed template strings"
      pattern: "!build.*!suggest|!suggest.*!build"
---

<objective>
Free-reign donor privileges (Ross directive 2026-07-11): during an ACTIVE control
window, `!suggest <text>` gains the same direct path the window `!build <text>`
already has — interceptor → gate classify → straight onto the build queue on
approve; narrated denial on reject/hold. The pool and the vote are skipped; the
compliance gate is NEVER skipped. Intake exemption (no cooldown, no per-user cap)
falls out of the interceptor consuming the message before startTwitchChat's
parser/intake path — but is asserted explicitly in tests. Window-open narration
is extended so chat knows both commands work.

**BINDING RESOLUTION — identity semantics (read before implementing):**
The directive's constraint mandates "the exact same check the window !build
interceptor already uses — no new identity-matching logic." That existing check
is D-11 OPEN-SLOT: `controlWindow.snapshot() !== null`, with explicitly NO
donor-ownership guard (src/main.ts:896-899 comment: "there is NO donor-identity
gate (an open sponsored slot)"; control-window.ts:306-307 doc: "no
donor-ownership guard"; test-asserted at tier1-commands.e2e.test.ts:633-642
where chatter "donorfan" — not the tip's donor — routes through the funnel).
D-11 exists because a StreamElements tip identity is not reliably matchable to
a Twitch chatter identity. Therefore:

- In-window `!suggest` uses EXACTLY `controlWindow.snapshot() !== null` — the
  same condition, the same funnel, no identity comparison of any kind.
- Consequence: during a window, ANY chatter's !suggest routes to the queue —
  identical to what ANY chatter's !build already does today. This grants
  non-donors nothing they don't already have via !build; it unifies the command
  surface during the sponsored slot.
- The directive's scenario (c) as literally worded ("non-donor !suggest during
  window → normal intake→pool") is unsatisfiable simultaneously with the
  binding same-check constraint + !build byte-compatibility + D-11. It is
  reinterpreted per the constraint: (c1) non-command chat during a window is
  dispatched normally (untouched); (c2) in-window !suggest from a chatter who
  is not the tip donor travels the SAME open-slot path as !build (matching the
  established "donorfan" idiom). If Ross wants a literal donor-identity gate,
  that is a separate directive that must also amend D-11 and the !build path.

Purpose: the donor paid for the window — their ideas should hit the queue
without cooldown friction or vote latency, with zero new classifier paths.
Output: extended interceptor in src/main.ts, extended narration open beats,
new e2e coverage block; non-donor/non-window paths byte-compatible.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/main.ts (interceptor: lines ~895-975 — BUILD_COMMAND, routeWindowInstruction, buildAwareChatSource)
@src/ingestion/twitch-chat.ts (normal dispatch — MUST NOT change)
@src/ingestion/narration.ts (windowOpenedDonation :345-349, windowOpenedChannelPoints :351-355)
@src/ingestion/command-parser.ts (reference only — MUST NOT change; !suggest regex shape: /^!suggest\s+(.+)$/i)
@src/control-window/control-window.ts (submitInstruction :311-322 — MUST NOT change)
@tests/e2e/tier1-commands.e2e.test.ts (describe :603-664 — the byte-compat reference + fixture idioms: fakeChatSource, fakeDonationSource, capturingSink, tip(), until())

<interfaces>
From src/main.ts (existing — the path !suggest must join):
```typescript
const BUILD_COMMAND = /^!build\s+(.+)$/i;
const routeWindowInstruction = async (displayName: string, text: string): Promise<void> => {
  // builds SuggestionCandidate{ source: controlWindow.snapshot()?.trigger ?? "donation", kind: "suggestion", ... }
  // → controlWindow.submitInstruction(candidate)
  // queued → driveWindowBuild / narrator.instructionAccepted | instructionQueued
  // rejected → narrator.instructionRejected(displayName); held → narrator.instructionHeld(displayName)
};
// buildAwareChatSource wraps chatSource.onChannelChatMessage; on BUILD_COMMAND match
// AND controlWindow.snapshot() !== null → routeWindowInstruction(...) and return;
// otherwise handler(event) → startTwitchChat's normal parser/intake path.
```

From src/ingestion/narration.ts (current verbatim open beats — to extend):
```typescript
`@${donor} tipped ${amount} and takes the wheel — free reign for ${formatMmss(durationMs)}! Type !build <your instruction> to use it.`
`@${user} redeemed ${reward} — direct control for ${formatMmss(durationMs)}! Type !build <your instruction> to use it.`
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend the window interceptor to !suggest + narration open beats</name>
  <files>src/main.ts, src/ingestion/narration.ts, src/ingestion/narration.test.ts</files>
  <behavior>
    - In-window `!suggest idea` → routeWindowInstruction called with the captured text; queue grows; pool untouched; classify invoked exactly once (single funnel)
    - In-window `!build idea` → behavior identical to pre-change (same funnel, same beats)
    - Outside a window, both `!suggest` and `!build` fall through to handler(event) — normal parser → intake → classify → pool
    - Non-command messages during a window fall through to handler(event) unchanged
    - windowOpenedDonation/windowOpenedChannelPoints verbatim strings mention BOTH !build and !suggest; paid copy still contains no chance/luck/odds/random/roll words
  </behavior>
  <action>
    In src/main.ts, next to BUILD_COMMAND (~line 904), add
    `const SUGGEST_COMMAND = /^!suggest\s+(.+)$/i;` — the SAME regex shape as
    command-parser.ts's suggest match, mirroring the existing BUILD_COMMAND/parser
    agreement comment. In buildAwareChatSource's onChannelChatMessage wrapper,
    extend the match to `BUILD_COMMAND.exec(trimmed) ?? SUGGEST_COMMAND.exec(trimmed)`
    with the EXISTING window condition unchanged: route to
    `routeWindowInstruction(event.chatterDisplayName, match[1])` only when
    `controlWindow.snapshot() !== null`; otherwise fall through to `handler(event)`.
    Do NOT add any identity comparison (D-11 open-slot — see objective's binding
    resolution). Do NOT touch routeWindowInstruction itself: candidate kind stays
    "suggestion", source stays the window trigger, submitInstruction/gate/queue
    path stays byte-identical — the gate_decision audit row keeps its
    window-source provenance for free. Update the D-11 comment block (~896-903)
    to document that !suggest and !build are aliases during a window (donor
    privilege directive 260711-raz), both consumed by the interceptor so NO
    intake state (cooldown/per-user cap) is ever touched in-window.

    In src/ingestion/narration.ts, extend the two window-open beats (lines
    ~345-355) so both commands are announced, e.g.:
    "@{donor} tipped {amount} and takes the wheel — free reign for {mm:ss}!
    Type !build or !suggest <your instruction> — it goes straight to the build
    queue." (channel-points line analogous with "redeemed {reward} — direct
    control"). Server-composed template strings ONLY (donor name remains the
    only interpolated attacker-influenced value, exactly as today). Preserve the
    copy-separation invariant: no chance/luck/odds/random/roll words in paid
    copy. Update src/ingestion/narration.test.ts's verbatim assertions (lines
    ~389-393) to the new strings; the copy-separation test (~line 453) must
    still pass against the new copy. Write the updated narration unit
    assertions FIRST (red), then change the strings (green).

    Explicitly out of scope: command-parser.ts, twitch-chat.ts,
    control-window.ts, paid-window.ts, gate/state-machine/halt code, overlay
    panels, chaos mode, !swapbuild/info.
  </action>
  <verify>
    <automated>npx vitest run src/ingestion/narration.test.ts src/ingestion/twitch-chat.test.ts tests/invariants && npx tsc --noEmit</automated>
  </verify>
  <done>
    SUGGEST_COMMAND exists in src/main.ts and in-window !suggest routes through
    routeWindowInstruction under the exact `controlWindow.snapshot() !== null`
    check; both narration open beats name !build and !suggest; narration unit
    tests (including copy-separation) green; invariant suite (single-funnel)
    green; tsc clean. Zero changes to command-parser.ts / twitch-chat.ts /
    control-window internals.
  </done>
</task>

<task type="auto">
  <name>Task 2: E2E matrix for in-window !suggest + intake exemption + !build regression</name>
  <files>tests/e2e/tier1-commands.e2e.test.ts</files>
  <action>
    Add a new describe block modeled directly on the existing free-reign
    byte-compat block (:603-664 — reuse fakeChatSource, fakeDonationSource,
    capturingSink, tip(), until(), classify-sequence recorder). Cover, in order:

    (a) Direct-to-queue post-gate: open a window via donation.emitTip(tip());
    chat.say from a chatter, "!suggest add a dark mode". Assert taskQueue grows
    to include it, pool.list() stays empty, the classify recorder shows the text
    WAS classified (gate never skipped), and the honest "queued" beat is
    narrated (no build engine composed in this fixture).

    (b) Gate-rejected denial: with a fakeClassifier returning rejected for a
    marker text, in-window "!suggest <marker>" → the narrated rejection beat is
    sent, taskQueue does NOT grow, pool stays empty, and
    controlWindow.snapshot() is still non-null (window not consumed, D-12).

    (c) Intake exemption asserted EXPLICITLY: after the in-window !suggest from
    chatter id X, close the window (controlWindow.revoke()), then the SAME
    chatter id X sends a normal "!suggest fresh idea" — it must pool
    successfully (no cooldown refusal beat, no per-user-cap refusal), proving
    the in-window submission consumed zero intake state. Also assert the
    in-window candidate's audit/gate row carries the WINDOW trigger source
    (e.g. "donation"), not "chat".

    (d) Outside-window normal path: with no window active, "!suggest normal
    idea" pools with source "chat", kind "suggestion", and the queue does not
    grow — byte-compatible with today.

    (e) Open-slot parity + !build regression: during a window, a chatter whose
    name differs from the tip's donor sends !suggest → same funnel treatment
    (documents the D-11 resolution, mirrors the existing "donorfan" idiom);
    and the EXISTING describe block at :603 must pass UNCHANGED — do not edit
    it (byte-compat proof for !build).

    Also assert a plain non-command message during a window still reaches the
    normal handler (e.g. it is silently ignored without touching queue/pool —
    or reuse an existing dispatch probe idiom if one exists in the file).

    Finish with the full gate: whole suite + tsc + biome.
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>
    New e2e block green covering (a)-(e); existing :603 free-reign block passes
    without modification; full suite green (baseline 980+ tests, plus new),
    tsc + biome clean.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Twitch chat → interceptor | Attacker-authored `!suggest` text now has an in-window route toward the build queue |
| Window funnel → narration/chat sender | Donor display names + chat text echoed into narrated beats |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-raz-01 | Elevation of privilege | in-window !suggest → queue | mitigate | The route reuses routeWindowInstruction → submitDuringWindow → gate classify; single-funnel invariant suite must stay green; e2e (a) asserts classify runs before queue |
| T-raz-02 | Tampering | intake bypass (cooldown/cap) | accept | Bypass is scoped to `controlWindow.snapshot() !== null` — a paid, streamer-revocable, time-boxed slot identical in exposure to the existing !build path; gate still screens every byte |
| T-raz-03 | Spoofing | "donor" identity during window | accept | D-11 open-slot by design (SE identity ≠ Twitch identity); no new identity logic added; documented in objective, test-asserted in e2e (e) |
| T-raz-04 | Information disclosure | narration beats | mitigate | Server-composed template strings only; no new chat-derived interpolation beyond the existing donor display name; verbatim narration tests updated |
| T-raz-SC | Tampering | package installs | accept | No new packages installed by this plan |
</threat_model>

<verification>
- Full suite green: `npx vitest run` (baseline 980+; existing tier1 free-reign block at :603 UNCHANGED and passing)
- `npx tsc --noEmit` clean, `npx biome check .` clean
- Invariant suite green (single-funnel: gate.ts remains the only `as QueuedTask` mint)
- grep gates: `grep -c "SUGGEST_COMMAND" src/main.ts` ≥ 2 (declaration + use); `grep -c "!suggest" src/ingestion/narration.ts` ≥ 2 (both open beats)
- No diff in: src/ingestion/command-parser.ts, src/ingestion/twitch-chat.ts, src/control-window/control-window.ts, src/pipeline/paid-window.ts
</verification>

<success_criteria>
- In-window !suggest → gate → queue (pool/vote skipped, gate never skipped), narrated queued/accepted beat
- In-window gate-rejected !suggest → narrated denial, nothing queued/pooled, window time untouched
- Intake exemption explicitly proven (post-window !suggest from the same chatter pools without cooldown/cap refusal)
- Outside-window !suggest and all !build behavior byte-compatible (existing tests pass unmodified)
- Narration open beats announce both commands, server-composed, copy-separation intact
- Audit rows for in-window suggestions carry the window trigger source via the existing path
</success_criteria>

<output>
Create `.planning/quick/260711-raz-free-reign-donor-privileges/260711-raz-SUMMARY.md` when done
</output>
