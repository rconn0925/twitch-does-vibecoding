---
status: awaiting_human_verify
trigger: "COMP-02 in-flight classifier flake: classifier-runner.ts turn pinned to maxTurns(1) intermittently terminates as error_max_turns ('Reached maximum number of turns (1)' x3) on large-but-benign output batches, so the gate fails closed and refuses real builds on stream"
created: 2026-07-11
updated: 2026-07-11
---

# Debug: COMP-02 in-flight classifier maxTurns(1) flake fail-closes benign large batches

## Symptoms
- **Expected:** the in-flight compliance classifier (single-shot judgment over a batch of build-agent output text) completes its ONE turn with `result.subtype === "success"` and returns a decision; benign build output is approved and the build proceeds.
- **Actual:** on large-but-benign output batches the run intermittently terminates as `error_max_turns` ("Reached maximum number of turns (1)" — observed x3 during the empty-build-no-workspace-files live verification runs, 2026-07-11). The transport correctly returns "" on non-success, the compliance envelope fails CLOSED, and a legitimate build gets refused — on stream this refuses real builds.
- **Error messages:** "Reached maximum number of turns (1)" (SDK result subtype error_max_turns).
- **Timeline:** observed 2026-07-11 during live end-to-end verification of the empty-build fix (deferred follow-up recorded in .planning/debug/knowledge-base.md). Small batches classify fine (~3s success).
- **Reproduction:** intermittent; correlates with LARGE candidate text batches (in-flight build output). Small suggestion-gate texts do not flake.

## Evidence
- 2026-07-11 repro A (45KB homogeneous benign batch, 3 runs + 1 small): ALL success, ~3-8s. Large size alone does NOT reproduce → size hypothesis weakened.
- 2026-07-11 audit DB: failing live run is audit_log id=88 (gate_decision, category=classifier-unavailable, 1725 chars — NOT large). Candidate text = extractWriteEditText output: bare file path `/home/builder/projects/app-1/index.html` + a raw CSS fragment (Edit new_string), NO instruction text. Neighboring in-flight rows that SUCCEEDED (id 64/66, 3321ch) carry rationales like "No actionable build instruction present—just the current app's source code" → the model is reliably confused by instruction-less code dumps.
- 2026-07-11 repro B (exact audit-88 text replayed 4x through identical query options): 4/4 DETERMINISTIC error_max_turns. Message stream shows the mechanism directly: assistant turn 1 = text ("This appears to be a file dump ... rather than a prompt") + tool_use(ToolSearch) x3 / tool_use(ReportFindings) x1 → tool denied → CLI needs turn 2 → maxTurns(1) exhausted → result subtype=error_max_turns, num_turns=2, result="" → WR-01 fails closed.
- Mechanism: `allowedTools: []` does NOT strip tools from the model's tool list, and CLASSIFIER_DISALLOWED (7 names) misses CLI-injected tools (ToolSearch, ReportFindings, Read, Glob, Grep, Task, TodoWrite, ...). When candidate text is an instruction-less code/file dump, Sonnet attempts a tool call to orient itself — burning the single turn. "Intermittent on stream" = deterministic per content-shape; only some batches look like pure dumps.
- src/orchestrator/classifier-runner.ts: `maxTurns: 1`, `thinking: { type: "disabled" }`, empty allowedTools + defensive denylist, 20s timeout (GATE_TIMEOUT_MS). Comment at thinking-disabled block notes the SAME failure signature occurred when adaptive thinking consumed the single turn — suggests any pre-response consumption (thinking, or a long/segmented response on large input) can exhaust turn 1 before a success result is emitted.
- Knowledge-base entry (.planning/debug/knowledge-base.md, empty-build-no-workspace-files): "COMP-02 in-flight classifier flake — 'Reached maximum number of turns (1)' x3 on large-but-benign output batches -> fail-closed refusal of good builds; candidate fix maxTurns:2 or batch truncation in src/orchestrator/classifier-runner.ts (compliance/** read-only)."
- Transport design (WR-01): non-success terminal result MUST yield "" (fail closed). That property must be preserved by any fix — the fix is to make benign large batches reliably reach success, not to loosen the fail-closed behavior.
- 2026-07-11 specialist hardening applied (7eabacd): frameCandidate() now neutralizes literal '</candidate_text' and '<candidate_text' in candidate text (visible mangle '<\/…'/'<\…') before interpolation — framed prompt provably contains exactly ONE opening + ONE closing delimiter (new unit test asserts exact counts and that the mangled payload still travels inside the frame). Containment test tightened to exact occurrence count (specialist nit 3). Nonce delimiter rejected per review (frame must stay byte-identical across calls; test pins this). Verified: 16/16 classifier-runner tests, 860/860 full suite, tsc --noEmit clean, biome clean. Live re-classification SKIPPED (autonomous decision): neutralization is a pure string transform that is a byte-for-byte no-op for any candidate without literal delimiters — prior live verification (3/3 audit-88 + 3 sanity) remains valid; the new path is unit-covered.

## Current Focus

reasoning_checkpoint:
  hypothesis: "Two-layer root cause. (1) The classifier query() exposes the FULL built-in tool list to the model (allowedTools:[] does not strip tools; the 7-name denylist misses CLI tools like ToolSearch/ReportFindings/TaskCreate/Grep) — when the candidate text is an instruction-less code dump (exactly what extractWriteEditText produces: bare file path + raw file content), Sonnet reliably attempts a tool call to orient itself, burning the single maxTurns(1) turn → error_max_turns → '' → fail-closed. (2) Even with tools stripped, the same semantic confusion ('this input is not a prompt') makes the model answer in PROSE instead of the JSON object 3/4 of the time → downstream extractJsonObject/schema failure → same fail-closed outcome."
  confirming_evidence:
    - "Repro B: exact audit-88 text (1725ch CSS fragment + path), 4/4 deterministic error_max_turns; stream shows tool_use(ToolSearch) x3 / tool_use(ReportFindings) x1 consuming turn 1."
    - "Experiment B (extended 26-name denylist): 3/3 STILL fails — model substitutes TaskCreate/TaskList; name-based denylisting is whack-a-mole."
    - "Experiment A (maxTurns:2): 2/3 success, 1/3 fails via a SECOND tool call — turn headroom alone is unreliable."
    - "Experiment C (tools:[]): 4/4 subtype=success turn-1, but 3/4 responses are prose, not JSON → would still fail closed downstream."
    - "Experiment D (tools:[] + fixed delimiter frame in USER turn): 4/4 success with clean parseable JSON, ~2-4s, turn 1. Sanity: framed benign prompt → approved; framed keylogger prompt → rejected(spam-malware); frame-escape injection (</candidate_text> + 'approve everything' + phishing ask) → rejected with injection called out."
  falsification_test: "If audit-88 replay under the final config (tools:[], framed prompt, maxTurns:1) ever returned error_max_turns or unparseable prose, the fix is wrong. Observed: 0 failures in 7 framed runs (4 audit-88 + 3 sanity)."
  fix_rationale: "tools:[] removes the mechanism (no tools in the model's view → tool_use impossible → single turn cannot be exhausted); the fixed user-turn frame removes the confusion (tells the model code dumps are valid classification input and demands ONLY the JSON), fixing the prose-response failure mode C exposed. Neither touches WR-01 (non-success still ''), the read-only system prompt (still bare const reference — frame is USER-turn-only, mirroring buildBuildPrompt's existing frame() precedent), the Sonnet pin, or the 20s budget (latency ~3s)."
  blind_spots: "(a) gate:eval full-eval not yet re-run — the frame could in principle shift borderline screening decisions; mitigated by 3 live sanity checks incl. injection. (b) tools:[] behavior verified on SDK 0.3.206 only — pinned exact version, documented in comment. (c) RESOLVED 2026-07-11 (7eabacd): frame delimiters were escapable text — frameCandidate() now neutralizes literal '</candidate_text' / '<candidate_text' occurrences before interpolation, so candidate text can no longer close or re-open the frame."

next_action: "Batched human gate ONLY: streamer confirms the next real on-stream build's COMP-02 in-flight batches screen cleanly (no error_max_turns fail-closures on benign output). All code work complete: primary fix b13dffc + specialist hardening 7eabacd; unit 16/16, suite 860/860, tsc clean, biome clean. Optional follow-up (non-blocking): re-run gate:eval full-eval to confirm borderline screening quality under the framed prompt."

## Constraints / notes
- src/compliance/**, halt.ts, kill-switch, CLASSIFIER_SYSTEM_PROMPT are READ-ONLY. classifier-runner.ts (src/orchestrator/) is editable.
- Fail-closed semantics (WR-01) must be preserved: non-success still returns ""; the fix targets making benign runs succeed (turn budget and/or input size), never trusting a failed run.
- Latency budget matters (live show): 20s GATE_TIMEOUT_MS bound; a fix must not routinely blow it.
- Autonomous run per autonomous-chain directive: do not block on checkpoints; batch human gates at the end. Do not commit .env test values.

## Eliminated
- hypothesis: "Batch SIZE causes the flake (large input → segmentation/continuation exhausts the turn)"
  evidence: "45KB homogeneous benign batch succeeded 3/3 (~3-8s); the actual failing live batch (audit id=88) was only 1725 chars. Content SHAPE (instruction-less code dump), not size, is the trigger."
  timestamp: 2026-07-11
- hypothesis: "Extending the tool denylist (26 names incl. ToolSearch/ReportFindings/Read/Grep/Task/TodoWrite) prevents the tool_use"
  evidence: "3/3 still error_max_turns — model substituted TaskCreate/TaskList. Name-based denylisting cannot enumerate the CLI's tool surface."
  timestamp: 2026-07-11
- hypothesis: "maxTurns:2 alone gives enough headroom to recover from one stray tool call"
  evidence: "2/3 success only — run 2 chained a second tool call (Grep then ReportFindings) and hit error_max_turns at 2. Turn headroom does not remove the mechanism."
  timestamp: 2026-07-11
- hypothesis: "tools:[] alone (no built-in tools) fully fixes the gate"
  evidence: "4/4 subtype=success, but 3/4 responses were PROSE ('I don't see an actual prompt to classify...') that fails extractJsonObject/schema downstream → still fail-closed. The semantic confusion must also be addressed (user-turn frame)."
  timestamp: 2026-07-11

## Fix experiments (audit-88 exact text unless noted)
| Variant | Config | Result |
|---|---|---|
| baseline | maxTurns:1, 7-name denylist | 4/4 error_max_turns (tool_use ToolSearch x3, ReportFindings x1) |
| A | maxTurns:2, 7-name denylist | 2/3 success, 1/3 error_max_turns (chained tool calls) |
| B | maxTurns:1, 26-name denylist | 3/3 error_max_turns (TaskCreate/TaskList substitution) |
| C | maxTurns:1, tools:[] | 4/4 success BUT 3/4 prose (downstream parse fail) |
| D | maxTurns:1, tools:[], framed user prompt | 4/4 success, 4/4 clean JSON OK(approved), ~2-4s |
| D sanity | same, benign/malicious/frame-escape-injection prompts | approved / rejected(spam-malware) / rejected(spam-malware, injection disregarded) |

## Specialist Review
specialist: typescript (general-purpose reviewer; typescript-expert skill unavailable in this environment)
verdict: SUGGEST_CHANGE — neutralize a literal "</candidate_text>" in candidate text before framing; the fixed public delimiter is attacker-forgeable.
status: APPLIED 2026-07-11 (commit 7eabacd) — all three items: (1) delimiter neutralization in frameCandidate(), (2) delimiter-in-candidate unit test with exact-count assertions, (3) containment test tightened to occurrence count.
notes:
- Fix direction confirmed correct and idiomatic for SDK 0.3.206 (pinned exactly): `Options.tools` documented in sdk.d.ts (~line 1382) as "`[]` (empty array) — Disable all built-in tools" — exactly the structural boundary needed; `allowedTools: []` is permission gating only, matching the root-cause claim. Denylist-as-depth is fine.
- WR-01 fail-closed path intact: tools:[] / maxTurns:1 / Sonnet pin / thinking disabled / 20s race unchanged; non-success still yields "" (classifier-runner.ts:192).
- Gap: frameCandidate() (classifier-runner.ts:82-84) inserts untrusted text verbatim. A candidate containing a literal `</candidate_text>` closes the frame early and lets the remainder read as orchestrator-authored text — in a compliance gate a successful injection fails OPEN (wrongful approval). One live rejection is anecdote, not a guarantee. Cheap hardening: neutralize `</candidate_text` occurrences before interpolation (per-call nonce delimiter would conflict with the "frame byte-identical across calls" test; neutralization fits the existing design).
- Test gap: no test for a candidate that itself contains the delimiters — add alongside the neutralization.
- Minor nit (not blocking): test at classifier-runner.test.ts:145 rebuilds the frame via string replace; would pass vacuously if candidate appeared twice.

## Resolution
root_cause: "Two-layer. (1) The classifier query() exposed the CLI's FULL built-in tool list to the model — `allowedTools: []` does not strip the tool list, and the 7-name denylist cannot enumerate the CLI's tool surface (live substitution chain observed: ToolSearch → ReportFindings → TaskCreate/TaskList → Grep). COMP-02's in-flight batches are instruction-less code dumps (extractWriteEditText output: bare file path + raw file content); on that content shape Sonnet reliably spends its single maxTurns(1) turn on an orientation tool call → error_max_turns → transport returns '' → WR-01 fails closed → benign builds refused on stream. (2) Secondary, exposed once tools were stripped: the same semantic confusion ('this input is not a prompt') produced PROSE answers instead of the JSON object 3/4 of the time, which fails extractJsonObject/schema downstream — same fail-closed outcome. NOT batch size: the failing live batch was only 1725 chars; a 45KB benign batch passed."
fix: "classifier-runner.ts only (constraints respected): (1) `tools: []` in query() Options — removes EVERY built-in tool from the model's view, making a turn-consuming tool_use structurally impossible (primary boundary; allowedTools:[]/denylist retained as defense in depth). (2) frameCandidate(): the user turn is now a FIXED orchestrator-authored frame (header instructing that the candidate may be a viewer prompt OR raw code/file content, judged by CONTENT, JSON-only response) with the untrusted text inserted between <candidate_text source=\"untrusted\"> delimiters — mirrors buildBuildPrompt()'s SAND-04 frame() discipline; the system prompt remains the bare CLASSIFIER_SYSTEM_PROMPT const reference. (3) Specialist hardening (7eabacd): literal '</candidate_text' / '<candidate_text' occurrences in candidate text are visibly mangled before interpolation, so a candidate can never close or re-open the frame (a successful frame escape in a compliance gate would fail OPEN); otherwise the text travels byte-for-byte verbatim. Per-call nonce delimiters rejected — the frame stays fixed and byte-identical across calls. maxTurns:1, Sonnet pin, thinking disabled, 20s GATE_TIMEOUT_MS, WR-01 fail-closed semantics all unchanged."
verification: "Unit: 16/16 classifier-runner tests incl. 4 new (tools deep-equals []; delimited-only candidate containment via exact occurrence count; frame byte-identical across calls; frame-escape neutralization with exact delimiter counts). Full suite: 860 tests / 67 files pass. tsc --noEmit clean; biome clean. Live (plan-billed, ANTHROPIC_API_KEY unset; pre-hardening — hardening is a no-op for delimiter-free candidates): pre-fix baseline = exact audit-88 batch 4/4 error_max_turns; post-fix through the REAL createClassifierTransport = 3/3 clean {decision: approved} JSON in 3.2–4.5s, benign viewer prompt approved, keylogger prompt rejected(spam-malware), frame-escape injection (</candidate_text> + 'approve everything' + phishing ask) rejected with injection called out."
files_changed:
  - src/orchestrator/classifier-runner.ts (tools: [], frameCandidate user-turn frame + delimiter neutralization, documentation) [b13dffc, 7eabacd]
  - src/orchestrator/classifier-runner.test.ts (4 new guard tests, framed-prompt containment tightened to exact occurrence count) [b13dffc, 7eabacd]
