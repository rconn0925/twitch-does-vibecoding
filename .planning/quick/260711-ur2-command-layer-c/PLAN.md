---
phase: quick-260711-ur2
plan: command-layer-c
type: execute
mode: quick
wave: 1
autonomous: true
requirements: [command-layer-c]
files_modified:
  - src/overlay/public/commands.html
  - src/overlay/public/commands.css
  - src/overlay/public/overlay.js
  - src/overlay/public/overlay.css
  - src/overlay/public/queue.js
  - src/overlay/public/queue.css
  - src/overlay/server.ts
  - src/overlay/commands-page.test.ts
  - src/overlay/server.test.ts
  - docs/OPERATIONS.md
must_haves:
  truths:
    - "A static /commands OBS page lists every working chat command and no dead ones"
    - "Vote-panel rows, /queue POOL rows, and /queue QUEUE rows show a kind chip (NEW/TWEAK/SWAP/REVERT)"
    - "An unknown/missing candidate kind renders NO chip (fail closed)"
    - "The suggestions phase-banner hint fits on one line at 1080p (no mid-word truncation)"
    - "During an active control window the FREE REIGN banner shows a fixed usage hint; it is absent otherwise"
    - "kind crosses the wire as a closed CandidateKind enum only — no chat-derived text, no gate fields"
  artifacts:
    - path: src/overlay/public/commands.html
      provides: "Static command reference page (zero JS, no wire dependency)"
    - path: src/overlay/public/commands.css
      provides: "Command-page styling reusing overlay.css :root tokens"
  key_links:
    - from: src/overlay/server.ts
      to: /commands
      via: "app.get('/commands', ...) sendFile"
    - from: src/overlay/server.ts buildOverlayState
      to: OverlayState.pool / OverlayState.queue
      via: "widened projection carrying candidate.kind"
    - from: src/overlay/public/commands.html
      to: src/ingestion/command-parser.ts
      via: "grep-gate sync test (page tokens ⊆ parser-recognized tokens)"
---

<objective>
Command layer C — the on-screen command surfaces. Four deliverables on the read-only
overlay server, all pure display work (no agent/LLM, no new chat commands):

1. A new static `/commands` OBS browser-source page — a command reference card.
2. Candidate KIND chips on vote-panel rows and both /queue lists.
3. A phase-banner hint truncation fix.
4. A FREE REIGN banner usage hint.

Purpose: give viewers a legible map of what they can type and what each pending item is,
without ever widening the broadcast wire beyond a closed server-composed enum.

Output: new commands.html/commands.css, edits to overlay.js/overlay.css/queue.js/queue.css,
a widened pool+queue projection in server.ts, tests, and an OPERATIONS.md doc entry.
</objective>

<hard_invariant>
The public overlay wire is a NARROW projection. Only server-composed fixed copy or
already-approved display fields ever cross to the public overlay. This plan adds exactly
ONE new wire field — `kind` — and it is a CLOSED SERVER-COMPOSED ENUM (`CandidateKind`:
`"suggestion" | "project-switch" | "revert" | "swap"`, src/shared/types.ts). The chip
LABEL is composed CLIENT-SIDE from that enum via a fixed lookup; the enum string is the
only thing on the wire. No chat-derived free text, no gate rationale/category/decision,
no amount, no message — none of these may ride any field this plan touches. Every server
narrowing test in server.test.ts that proves defence-in-depth MUST continue to pass and be
extended to cover `kind`.
</hard_invariant>

<context>
@src/ingestion/command-parser.ts
@src/shared/types.ts
@src/overlay/server.ts
@src/overlay/public/overlay.js
@src/overlay/public/overlay.css
@src/overlay/public/queue.js
@src/overlay/public/queue.css
@src/overlay/public/queue.html
@src/overlay/server.test.ts

<interfaces>
GROUND-TRUTH command set — parseCommand (src/ingestion/command-parser.ts) recognizes EXACTLY:
  !suggest <text>   !vote 1-5   !build <text>   !swapbuild <name>
  !revert | !undo   !chaos      !projects | !current | !repo | !help | !commands
(!undo is an alias of !revert; !commands is an alias of !help.)

CandidateKind → chip label map (src/shared/types.ts):
  "project-switch" → NEW   "suggestion" → TWEAK   "swap" → SWAP   "revert" → REVERT
  anything else / missing  → NO chip (fail closed).

Wire facts verified in the repo:
- Vote rows: kind is ALREADY on the wire. server.ts buildOverlayState does
  `round: round.snapshot()` (line ~416); RoundSnapshot.candidates[i].candidate is a full
  SuggestionCandidate with `kind`. NO server change for vote-row chips.
- /queue POOL: OverlayState.pool is projected at server.ts ~line 431-433 as
  `{ text, username }`. Widen to `{ text, username, kind }`. OverlayPoolSource.list()
  (server.ts ~line 268-271) returns `{ candidate: { text, twitchUsername } }` — widen the
  candidate shape to also carry `kind: CandidateKind`.
- /queue QUEUE: OverlayState.queue is projected at server.ts ~line 436-439 as `string[]`.
  Widen to `{ text, kind }[]`. OverlayQueueSource.list() (server.ts ~line 163-165) returns
  `{ text }[]` — widen to `{ text, kind }[]`. LEAVE `nextUp` (server.ts ~line 423-426) as
  `string[]` — the main-overlay up-next strip is OUT of chip scope.
- main.ts passes the REAL `pool` (line 1983) and `taskQueue` (line 1952) instances directly.
  CandidatePool.list() returns ApprovedCandidate whose `.candidate` is a full
  SuggestionCandidate (has kind); TaskQueue.list() returns QueuedTask (extends
  SuggestionCandidate → has kind). So the widened interfaces are ALREADY structurally
  satisfied by the real sources — NO src/main.ts edit is required. (main.ts stays in the
  allowed-files fence only as a safety net; do not edit it unless a narrowing wrapper is
  actually discovered there — none exists today.)

Chip idiom to reuse:
- overlay.js already builds `.provenance-chip` (chip-freereign / chip-chaos) on the build
  header. overlay.css `.provenance-chip` (line ~456) = secondary bg + muted text. Add a
  sibling `.kind-chip` class the same way (secondary bg, muted text, NO new accent, NEVER red).
- queue.css: add a `.wc-chip` class (secondary bg, muted text) reusing the `--secondary`
  / `--muted` :root tokens already used there.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>T1: /commands static page + route + parser sync grep-gate test</name>
  <files>src/overlay/public/commands.html, src/overlay/public/commands.css, src/overlay/server.ts, src/overlay/commands-page.test.ts, src/overlay/server.test.ts</files>
  <action>
Create `src/overlay/public/commands.html` — a PURE STATIC page (zero JS, no /api/state, no
ws): fixed server-authored copy baked as textContent-in-markup (allowed here because it is a
static file, not chat-derived). Link `/overlay.css` then `/commands.css` (same pattern as
queue.html). Two visually separated groups, each command a bolded token + one terse
one-line what-it-does (reference, not tutorial):
  VOTE COMMANDS:  !build <idea> · !suggest <tweak> · !swapbuild "name" · !revert (alias !undo)
  INSTANT COMMANDS: !vote 1-5 · !chaos · !projects · !current · !repo · !help
Advertise ONLY parser-recognized tokens (no dead commands). Design-language rules: a backed
`--dominant` panel per group (no bare text over video), 60/30/10 palette from overlay.css
:root tokens ONLY (no new colors, never red), nothing under 16px font.

Create `src/overlay/public/commands.css` — layout + type for the two groups, reusing the
overlay.css :root tokens (`--dominant`, `--secondary`, `--text`, `--muted`, `--safe-margin`,
`--panel-pad`). Transparent body (inherits overlay.css). Command tokens use `--text`,
descriptions `--muted`.

In `src/overlay/server.ts` add the route EXACTLY like /queue and /builder (~line 454-465):
  `app.get("/commands", (_req, res) => res.sendFile("commands.html", { root: publicDir }));`
It inherits the app-level loopback Host allowlist automatically.

Create `src/overlay/commands-page.test.ts` — a SYNC-GUARD grep-gate (no server needed; read
the file with node:fs from the public dir). Define
`RECOGNIZED = ["!suggest","!vote","!build","!swapbuild","!revert","!undo","!chaos","!projects","!current","!repo","!help","!commands"]`
and `ALIASES = new Set(["!undo","!commands"])`. Three assertions:
  (a) RECOGNIZED is accurate against the parser — for each token, feed parseCommand a minimal
      valid message (e.g. `!suggest x`, `!vote 1`, `!build x`, `!swapbuild x`, bare `!revert`
      etc.) and assert it returns NON-null. (Catches a removed parser branch.)
  (b) No dead commands on the page — extract every distinct `/![a-z]+/gi` token from
      commands.html and assert each is in RECOGNIZED. (The fail-closed direction: the page
      can never advertise a token parseCommand would return null for.)
  (c) Coverage — for each PRIMARY token (RECOGNIZED minus ALIASES) assert it appears as a
      substring in commands.html. (The page lists every working command.)
Add a header comment explaining that adding a parser command requires updating RECOGNIZED +
the page, and this test is the guard that the panel can never drift from the parser.

In `src/overlay/server.test.ts` extend the existing route tests: add `/commands` to the
positive-serve check and to the DNS-rebound 403 iteration (the list at ~line 585 that already
covers `/queue`,`/builder`), mirroring the `/queue` serving test at ~line 950.
  </action>
  <verify>
    <automated>npx vitest run src/overlay/commands-page.test.ts src/overlay/server.test.ts</automated>
  </verify>
  <done>
GET /commands 200s and serves the static card; a DNS-rebound GET /commands 403s. The grep-gate
test passes: page tokens ⊆ parser-recognized set, every primary command present, RECOGNIZED
validated against parseCommand. commands.html has zero &lt;script&gt; tags.
  </done>
</task>

<task type="auto" tdd="true">
  <name>T2: Widen pool + queue projection to carry kind (server + defence-in-depth tests + keep /queue page green)</name>
  <files>src/overlay/server.ts, src/overlay/public/queue.js, src/overlay/server.test.ts</files>
  <behavior>
    - buildOverlayState projects pool items as EXACTLY {text, username, kind} — no
      GateResult/rationale/category/decision/addedAtMs, even from a rich source (T-v4e-01).
    - buildOverlayState projects queue items as EXACTLY {text, kind} — no ids/vote provenance,
      even from a rich source. nextUp stays string[] (unchanged).
    - kind on both projections is one of the four CandidateKind enum values.
    - The forbidden-fields scan (server.test.ts ~line 855-865) still finds none of
      rationale/category/decision/addedAtMs on the pool/queue wire fields.
  </behavior>
  <action>
In `src/overlay/server.ts`:
- Import `CandidateKind` from `../shared/types.js` (the import at line ~21 already pulls from
  that module — extend it).
- Widen `OverlayQueueSource.list()` (~line 163-165) to `readonly { text: string; kind: CandidateKind }[]`.
- Widen `OverlayPoolSource.list()` (~line 268-271) candidate shape to
  `{ text: string; twitchUsername: string | null; kind: CandidateKind }`.
- Widen `OverlayState.pool` (~line 117) to `{ text: string; username: string | null; kind: CandidateKind }[]`
  and `OverlayState.queue` (~line 125) to `{ text: string; kind: CandidateKind }[]`. Keep the
  narrow-projection doc comments; note kind is the one closed-enum addition.
- In buildOverlayState: pool map (~line 431-433) → `{ text: item.candidate.text, username: item.candidate.twitchUsername, kind: item.candidate.kind }`.
  queue map (~line 436-439) → `.map((task) => ({ text: task.text, kind: task.kind }))`.
  LEAVE nextUp (~line 423-426) as `.map((task) => task.text)`.
- Do NOT edit src/main.ts — the real pool/taskQueue already satisfy the widened interfaces
  structurally (verified). Confirm `npx tsc --noEmit` is clean.

In `src/overlay/public/queue.js` (data-access only in THIS task, no chip yet — chips are T3):
- `renderQueue` (~line 82-87) currently treats `state.queue` entries as strings. Update the
  `.forEach((text, index) => ...)` to read `item.text` from the new `{text, kind}` object:
  `.forEach((item, index) => { ... truncate(item.text, TEXT_MAX) ... })`. This keeps the page
  rendering correctly after the wire shape changes (atomic-commit discipline: page stays green).
  renderPool already reads `item.text`/`item.username` — leave it (kind chip is T3).

In `src/overlay/server.test.ts`:
- Update the fake taskQueue (~line 392-393) so list() items carry kind, e.g.
  `.map((text) => ({ text, kind: "suggestion" as const }))`, or add a rich-queue fake mirroring
  makeFakePool's rich-item trick (items with kind PLUS extra keys that must not leak).
- Add a QUEUE narrowing test mirroring the POOL test at ~line 843: a rich queue source's
  extra keys never reach the wire; `state.queue[0]` keys sort to `["kind","text"]` and kind is
  an enum value.
- Update the POOL projection test (~line 843-865): assert `state.pool[0]` keys sort to
  `["kind","text","username"]` and value includes `kind`; the forbidden-fields scan is unchanged.
- Update the POOL_CHANGED push test (~line 870-882) and the FIFO queue test (~line 940-948)
  to the new object shapes ({text,username,kind} for pool; {text,kind} for queue). nextUp
  assertions (~line 438, 816) stay unchanged (still string[]).
  </action>
  <verify>
    <automated>npx vitest run src/overlay/server.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>
Pool wire = {text,username,kind}; queue wire = {text,kind}; nextUp still string[]. Rich
pool/queue sources leak no extra keys; kind is an enum value. The /queue page still renders
(queue.js reads item.text). tsc clean with no src/main.ts edit.
  </done>
</task>

<task type="auto">
  <name>T3: Kind chips on vote rows + /queue pool/queue rows + chip CSS</name>
  <files>src/overlay/public/overlay.js, src/overlay/public/overlay.css, src/overlay/public/queue.js, src/overlay/public/queue.css</files>
  <action>
Define a shared fixed lookup (client-side chip label from the closed enum), in each client
that renders chips (overlay.js and queue.js each get their own const — no shared module needed):
  `const KIND_CHIP = { "project-switch": "NEW", suggestion: "TWEAK", swap: "SWAP", revert: "REVERT" };`
Helper rule: `const label = KIND_CHIP[kind]; if (label) append chip;` — a missing/unknown kind
yields undefined → NO chip (fail closed). Never build a chip for an unrecognized kind.

overlay.js — vote-row builder `candidateRow` (~line 262-288): kind is already on the wire at
`entry.candidate.kind`. In the `top` row (near the title append, ~line 272-273) append
`el("span", "kind-chip", label)` when `KIND_CHIP[entry.candidate.kind]` is truthy. textContent
via el() only. No server change (RoundSnapshot already carries kind).

queue.js — renderPool (~line 57-66): append `el("span", "wc-chip", label)` to the stacked row
when `KIND_CHIP[item.kind]` is truthy. renderQueue (~line 82-87, now reading item objects from
T2): append `el("span", "wc-chip", label)` when `KIND_CHIP[item.kind]` is truthy.

overlay.css — add `.kind-chip` mirroring `.provenance-chip` (~line 456-472): `--secondary`
background, `--muted` text, small rounded, small font (>=16px is fine for a chip label as it
sits inside a panel; keep it legible). NO new accent color, NEVER red.

queue.css — add `.wc-chip`: `--secondary` background, `--muted` text, small rounded. NO red.

Add tests (extend commands-page/queue coverage OR add a small pure-DOM test file
`src/overlay/kind-chip.test.ts` using the KIND_CHIP mapping): assert the mapping produces
NEW/TWEAK/SWAP/REVERT for the four kinds, and that an unknown/missing kind yields no label
(undefined → skip). Keep it a pure unit test of the lookup + skip rule (jsdom not required if
you export/inline the map; if you assert against the actual DOM builders, use vitest's jsdom
environment already available).
  </action>
  <verify>
    <automated>npx vitest run src/overlay/</automated>
  </verify>
  <done>
Vote rows, /queue POOL rows, and /queue QUEUE rows render a NEW/TWEAK/SWAP/REVERT chip per
kind. Unknown/missing kind → no chip. Chips use --secondary/--muted only, never red. All
overlay tests pass.
  </done>
</task>

<task type="auto">
  <name>T4: Phase-banner hint truncation fix (one line at 1080p)</name>
  <files>src/overlay/public/overlay.js, src/overlay/public/overlay.css</files>
  <action>
The SUGGESTIONS phase hint is client-composed fixed copy in overlay.js (~line 320-322):
`el("span","phase-hint","type !suggest — new idea or a tweak to what's on screen")`, styled by
`.phase-hint` (white-space:nowrap + ellipsis, overlay.css ~line 234-244) inside `.phase-banner`
(max-width 900px, ~line 220). At 1080p the 24px hint truncates mid-word.

Pick ONE clean fix (do NOT introduce a second line):
  PRIMARY (recommended, deterministic to test): shorten the hint copy so it fits one line
  within the 900px banner — e.g. `type !suggest — an idea or a tweak`. Pin the EXACT chosen
  string in a test.
  ALT: widen `.phase-banner` max-width (e.g. 900px → 1100px; stays centered via translateX,
  well inside 1920 with safe margins) and pin the max-width value + assert the hint length
  fits. Only if you prefer to keep the fuller wording.
This is the OVERLAY hint only — do NOT touch narration.ts (that is chat copy, separate surface).

Add/extend a test pinning the fix: assert the exact new hint string (PRIMARY) — read overlay.js
via node:fs and assert it contains the new string and NOT the old truncating one; or (ALT)
assert the widened max-width in overlay.css and a hint-length bound.
  </action>
  <verify>
    <automated>npx vitest run src/overlay/</automated>
  </verify>
  <done>
The suggestions hint renders on ONE line at 1080p with no mid-word cut. The chosen fix is
pinned by a test (exact string or max-width value). narration.ts is untouched.
  </done>
</task>

<task type="auto">
  <name>T5: FREE REIGN banner usage hint</name>
  <files>src/overlay/public/overlay.js, src/overlay/public/overlay.css</files>
  <action>
In overlay.js `renderBanner()` FREE REIGN branch (~line 208-224, after the donor name and
countdown appends), append a fixed muted usage-hint line/suffix: client-composed copy
`!build or !suggest — straight to the queue` via `el("span","banner-hint","...")` (textContent
only). It appears ONLY in the FREE REIGN branch — i.e. only when `latest.controlWindow` is
non-null. Do NOT add it to the CHAOS MODE or DEMOCRATIC branches. Donor name + countdown stay
UNCHANGED. Fixed copy only: NO amount, NO donation message text (rules T-04-12/13 hold).

Add `.banner-hint` to overlay.css: `--muted` text, small font (>=16px), fits under/next to the
existing banner content. No red, no new accent.

Add a test: assert the hint text is PRESENT when the overlay state has a controlWindow (FREE
REIGN), and ABSENT in DEMOCRATIC (no controlWindow, no chaosMode) and CHAOS (chaosMode active,
no controlWindow) states. Use the jsdom render path or assert the branch structure; mirror how
existing overlay banner behavior is exercised.
  </action>
  <verify>
    <automated>npx vitest run src/overlay/</automated>
  </verify>
  <done>
FREE REIGN banner shows the fixed `!build or !suggest — straight to the queue` hint while a
control window is active; the hint is absent in DEMOCRATIC and CHAOS states. Donor name and
countdown unchanged. No amount/message ever rendered.
  </done>
</task>

<task type="auto">
  <name>T6: Document /commands OBS browser source in OPERATIONS.md</name>
  <files>docs/OPERATIONS.md</files>
  <action>
Add a short subsection documenting the new `/commands` page as an OBS browser source. Place it
near the overlay/source documentation (e.g. a new subsection under the overlay/scene area, or a
new numbered section consistent with the existing §10/§11 style). State:
  - URL: `http://127.0.0.1:<overlayPort>/commands` (same read-only overlay server as /queue,
    /builder; loopback-only).
  - It is a STATIC reference card — pure copy, no live state, no wire dependency (safe to leave
    running on any scene).
  - Suggested size/placement: full-frame (1920x1080) for a dedicated "commands" scene, or a
    side panel (e.g. ~460x1080, matching the /queue what's-coming source) as an always-on rail.
Keep it terse and consistent with the existing OBS-source entries.
  </action>
  <verify>
    <automated>grep -q "/commands" docs/OPERATIONS.md &amp;&amp; echo OK</automated>
  </verify>
  <done>
OPERATIONS.md documents the /commands OBS browser-source URL, that it is a static reference
card, and a suggested size/placement.
  </done>
</task>

</tasks>

<test_mapping>
| Test | Task | Asserts |
|------|------|---------|
| commands.html tokens ⊆ parser-recognized; every primary command present; RECOGNIZED validated vs parseCommand | T1 | Panel can never advertise a dead command or drift from the parser |
| GET /commands serves; DNS-rebound /commands 403s | T1 | Route parity with /queue, loopback posture |
| Pool projection = {text,username,kind}; rich source leaks no gate fields; kind ∈ enum | T2 | Narrow wire + defence-in-depth for pool |
| Queue projection = {text,kind}; rich source leaks nothing; nextUp stays string[] | T2 | Narrow wire + defence-in-depth for queue |
| Chip label per kind = NEW/TWEAK/SWAP/REVERT (all four) | T3 | Correct closed-enum → label mapping |
| Unknown/missing kind → no chip | T3 | Fail-closed chip rendering |
| Phase-hint fix pinned (exact string or widened max-width) | T4 | One-line hint at 1080p |
| FREE REIGN hint present in window state, absent in DEMOCRATIC/CHAOS | T5 | Hint scoped to active control window only |
| /commands documented in OPERATIONS.md | T6 | Operator doc coverage |
</test_mapping>

<scope_fence>
IN SCOPE (only these files may be created/edited):
- src/overlay/public/* — new commands.html, commands.css; edits to overlay.js, overlay.css,
  queue.js, queue.css
- src/overlay/server.ts — add /commands route; widen OverlayPoolSource / OverlayQueueSource /
  OverlayState.pool / OverlayState.queue interfaces and buildOverlayState projection
- test files under src/overlay/ (server.test.ts edits; new commands-page.test.ts; optional
  kind-chip.test.ts)
- docs/OPERATIONS.md — document the /commands OBS source
- src/main.ts — allowed ONLY as a safety net; verified NOT needed (pool/taskQueue passed
  directly and already carry kind). Do not edit unless a real narrowing wrapper is found there.

OUT OF SCOPE (explicitly forbidden):
- Any NEW chat commands.
- ANY change to src/ingestion/command-parser.ts (it is ground truth, read-only here).
- ANY change to the compliance gate/funnel, the kind router, or narration.ts wording
  (the ONLY narration-adjacent edit allowed is shortening the overlay phase-hint copy, which
  lives in overlay.js — NOT narration.ts).
- ANY change to the RoundSnapshot shape (vote-row kind is already on the wire).
- Adding chips to the main-overlay nextUp strip (nextUp stays string[], no chip).
- Any new accent color or ANY red addition anywhere (kind chips + banner hint use
  --secondary / --muted only).
- Widening the wire with anything other than the single closed `kind` enum field.
</scope_fence>

<success_criteria>
- /commands serves a static, JS-free reference card listing exactly the parser-recognized
  commands, guarded by a drift-proof grep-gate test.
- Kind chips (NEW/TWEAK/SWAP/REVERT) render on vote rows and both /queue lists; unknown kind
  renders no chip.
- kind is the only new wire field, typed CandidateKind; all pool/queue defence-in-depth
  narrowing tests pass and cover kind.
- Phase-banner suggestions hint fits one line at 1080p; narration.ts untouched.
- FREE REIGN banner shows the fixed usage hint only during an active control window.
- OPERATIONS.md documents the new /commands source.
- `npx vitest run src/overlay/` and `npx tsc --noEmit` both clean.
</success_criteria>

<output>
Create `.planning/quick/260711-ur2-command-layer-c/SUMMARY.md` when done.
</output>
