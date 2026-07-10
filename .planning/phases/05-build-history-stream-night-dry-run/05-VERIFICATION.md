---
phase: 05-build-history-stream-night-dry-run
verified: 2026-07-10T08:05:00Z
status: human_needed
score: 4/4 must-haves verified (1 code criterion PASS; 3 human-gated criteria DEFERRED to a present, honest runbook)
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
human_verification:
  - test: "Stream-night dry run — full loop on a low-stakes test channel (05-DRY-RUN.md §3)"
    expected: "suggest → filter → vote → build → live preview runs end-to-end; a benign !suggest enters the pool, a disallowed one gets category-level chat feedback (never silent, no raw echo); the winner queues through the gate; the sandboxed build runs and renders in preview; the build appears on /history with a VOTE chip"
    why_human: "Requires a live test channel, a running sandbox, real chat input, and visual confirmation on the overlay/preview/history surfaces — cannot be exercised in vitest against injected fakes (SC-2)"
  - test: "Paid free-reign window + chaos round (05-DRY-RUN.md §4)"
    expected: "a real small donation opens a free-reign window (overlay shows donor name + countdown ONLY — no amount/message/trigger-type); a channel-points redemption opens a smaller window; chaos mode picks and builds with no vote; nothing on the broadcast couples payment to chance"
    why_human: "Requires sending a real tip through the donation platform and a real channel-points redemption on a live test channel (SC-2)"
  - test: "Kill switch vs. a GENUINELY in-progress build (05-DRY-RUN.md §5)"
    expected: "with an agent turn actually running in the sandbox, the veto/Halt aborts cleanly within seconds (wsl.exe --terminate fires), the machine reaches HALTED, there is NO false 'BUILT IT' on the overlay, and NO changelog row is written for the killed build; recovery from HALTED resumes the loop"
    why_human: "Requires timing a halt against a real mid-session agent turn in the WSL2 sandbox and confirming teardown latency + the no-row outcome live (SC-3). The finalizeAborted no-row code path is machine-verified (see below); the live halt-latency + real-teardown behaviour is not."
  - test: "Audit + changelog compliance review (05-DRY-RUN.md §6)"
    expected: "the audit page shows zero unfiltered inputs reached an agent (every candidate has a gate decision) and every rejection produced chat feedback; the /history page shows the night's builds with correct provenance chips + honest results, NO pre-gate/rejected-at-intake text, and NO donor identity or amount"
    why_human: "SC-4 is by definition a human review of the audit log produced by an actual live rehearsal on a test channel"
  - test: "Preconditions: Phase 3 Wave 0 WSL2 GO + Phase 4 live gate GO (05-DRY-RUN.md §1)"
    expected: "both deferred earlier human gates read GO in SANDBOX-SETUP.md and 04-LIVE-GATE.md before the dry run starts; if either is NO-GO the dry run is BLOCKED"
    why_human: "These are the two previously-deferred human gates the dry run consolidates and depends on — they are hardware/account/billing proofs that cannot be automated"
  - test: "Operator doc port correction before the dry run (see WARNING WR-DOC below)"
    expected: "docs/OPERATIONS.md §7.1 should point the operator at the actual history surface (HISTORY_PORT, default 4903) rather than http://127.0.0.1:4900/history / 'same CONSOLE_PORT host process', so §2 of the runbook ('open ... the /history changelog page') opens the right port"
    why_human: "A one-line doc fix; surfaced here because the incorrect port is in the runbook the human operator follows during the dry run"
---

# Phase 5: Build History & Stream Night Dry Run — Verification Report

**Phase Goal:** The format is provably ready for the first real stream night — full loop rehearsed end-to-end on a test channel with zero compliance incidents.
**Verified:** 2026-07-10T08:05:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Framing

Phase 5 has exactly ONE buildable code deliverable — the build-history changelog (HIST-01, ROADMAP success criterion 1) — plus a human dry-run rehearsal (success criteria 2/3/4) that is deliberately NOT automatable. This report gives the code criterion a full PASS against the actual codebase, and marks the three human-gated criteria **DEFERRED-TO-HUMAN-GATE** (not FAILED), confirming that the artifact that gates them — the 05-DRY-RUN.md runbook — exists, is complete, and honestly consolidates the deferred Phase 3 Wave 0 + Phase 4 live gates as preconditions.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (Success Criterion) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Winning suggestions and their build results persist to a browsable changelog page across stream nights | ✓ VERIFIED | Code deliverable HIST-01 — fully traced below (build_history table + record/list + finalize() hook + provenance threading + served read-only page). 663 tests green. |
| 2 | A full dry run on a test channel exercises every mode end-to-end (suggest→filter→vote→build→preview + real donation window + chaos round) | ⏳ DEFERRED-TO-HUMAN-GATE | 05-DRY-RUN.md §3–4 present and complete; verdict intentionally PENDING. Not machine-verifiable (live channel, real tip, sandbox). |
| 3 | The kill switch is exercised against a genuinely in-progress build and halts it cleanly | ⏳ DEFERRED-TO-HUMAN-GATE | 05-DRY-RUN.md §5 present. The no-changelog-row half of the guarantee IS machine-verified (finalizeAborted writes zero rows — see below); live halt latency + real WSL2 teardown are human-gated. |
| 4 | The audit log from the dry run confirms zero unfiltered inputs reached an agent and every rejection produced chat feedback | ⏳ DEFERRED-TO-HUMAN-GATE | 05-DRY-RUN.md §6 present. By definition a human review of an audit log produced by a live rehearsal. |

**Score:** 1/1 code criterion VERIFIED; 3/3 human criteria DEFERRED to a present, honest runbook. No FAILED criteria.

### Code Deliverable (SC-1 / HIST-01) — Sub-Truth Verification

| # | Sub-truth | Status | Evidence |
| --- | --- | --- | --- |
| 1a | Durable `build_history` table exists | ✓ VERIFIED | `src/audit/schema.sql:139-147` — `CREATE TABLE IF NOT EXISTS build_history` (id, task_id, title, provenance, result, created_at_ms) + `idx_build_history_created_at`. |
| 1b | Append-only: INSERT/SELECT only, no UPDATE/DELETE | ✓ VERIFIED | `record.ts:558-624` — single `INSERT_BUILD_HISTORY_SQL` + SELECT-only `listBuildHistory`; grep of src for UPDATE/DELETE against build_history is empty; append-only self-test in record.test.ts stays green. |
| 1c | Record written at build completion (never on abort) | ✓ VERIFIED | `build-session.ts:379-386` — `recordBuildHistory` called inside `finalize()` under the `auditIfOpen` shutdown-drain guard; `finalizeAborted()` (416+) writes `recordSandboxTeardown`, NOT a history row. grep confirms `recordBuildHistory` has exactly one call site. |
| 1d | Honest 1:1 result mapping | ✓ VERIFIED | `build-session.ts:358-360` `mapStageToResult`: done→built, failed→failed, refused→refused. |
| 1e | Provenance threaded from all three drivers | ✓ VERIFIED | `main.ts:934` onWinnerQueued→`startBuild(task,"vote")`; `main.ts:956-961` driveWindowBuild→`controlWindow.snapshot()?.trigger` (donation\|channel_points); `main.ts:997` driveChaosBuild→`startBuild(task,"chaos")`. Pinned in `runPipeline` (line 738) under concurrency-1; retry preserves value (line 874). |
| 1f | Survives restart (durability) | ✓ VERIFIED | SQLite file durability; explicit test `record.test.ts:370` "persists across a fresh db handle open of the same file". |
| 1g | Reverse-chronological, night-grouped | ✓ VERIFIED | `record.ts:613` `ORDER BY created_at_ms DESC, id DESC`; `server.ts:135-218` buckets rows into local-calendar-day nights, newest-first, on read (D-02). |
| 1h | Served page: loopback-bound, read-only | ✓ VERIFIED | `server.ts:234-240` isLoopbackHostHeader 403 guard as FIRST middleware; `server.ts:271` listen pinned "127.0.0.1"; no express.json, no POST/PUT/DELETE/PATCH, no WebSocket (source header + tests). Closed before db in main.ts:1108-1110. |
| 1i | Coarse projection — no donor identity/amount/trigger-type | ✓ VERIFIED | `server.ts:129-133` `coarsenProvenance` whitelist (vote/chaos pass, else→paid); wire object carries only {title, provenance, result, timeLabel} + server-formatted night labels (server.ts:196-201). e2e asserts absence in raw serialized bytes. |
| 1j | textContent-only render, no red on the audience surface | ✓ VERIFIED | `history.js` — grep finds zero innerHTML/insertAdjacentHTML/document.write/eval; titles via el()/textContent truncated to 100 chars; empty ("No builds yet") + calm non-red error ("History's taking a break") states present. `history.css` declares no red token (comments confirm; amber for refused/failed). |
| 1k | Killed/aborted build writes NO history row | ✓ VERIFIED | `finalizeAborted` has zero recordBuildHistory calls (source); e2e `build-history.e2e.test.ts:306` drives a vetoed build and asserts it never appears. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/audit/schema.sql` | build_history table | ✓ VERIFIED | Table + index present (lines 139-147). |
| `src/audit/record.ts` | recordBuildHistory + listBuildHistory | ✓ VERIFIED | Both exported; INSERT/SELECT only; camelCase mapping. |
| `src/shared/types.ts` | BuildProvenance / BuildResult / BuildHistoryRow | ✓ VERIFIED | Imported/used across record.ts, build-session.ts, server.ts. |
| `src/orchestrator/build-session.ts` | recordBuildHistory in finalize(), not finalizeAborted() | ✓ VERIFIED | Confirmed by source + unit/e2e tests. |
| `src/history/server.ts` | loopback read-only paginated GET /api/history | ✓ VERIFIED | Copied from preview/server.ts; one validated GET; coarsen+group+paginate. |
| `src/history/public/history.{html,css,js}` | textContent-only page, chips/badges/states, no red | ✓ VERIFIED | All present; dom-safety invariant green. |
| `.planning/.../05-DRY-RUN.md` | dry-run runbook, PENDING verdict, consolidates both prior gates | ✓ VERIFIED | Preconditions §1 cites Phase 3 Wave 0 (SANDBOX-SETUP.md) + Phase 4 (04-LIVE-GATE.md); §3-6 cover full loop, paid+chaos, kill switch, audit review; verdict PENDING as designed. |
| `docs/OPERATIONS.md` §7 | dry-run + changelog operational note | ⚠️ VERIFIED w/ defect | Section present and thorough, but §7.1 states the wrong port (see WR-DOC). |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| build-session finalize() | recordBuildHistory | stored currentProvenance read at terminal completion | ✓ WIRED | build-session.ts:379-386. |
| main.ts driveWindowBuild | startBuild(task, provenance) | ControlWindowSnapshot.trigger | ✓ WIRED | main.ts:956-961. |
| history/server.ts GET /api/history | listBuildHistory | reads build_history, coarsens, buckets by night | ✓ WIRED | server.ts:260-264. |
| history.js | /api/history | fetch on load + Load-older click | ✓ WIRED | history.js:148-177. |
| main.ts | startHistoryServer | composition alongside overlay/preview/console + close-chain teardown | ✓ WIRED | main.ts:1065-1074, close at 1108-1110. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| history.js (rendered nights) | page.nights | fetch GET /api/history | Yes — server reads real build_history rows via listBuildHistory | ✓ FLOWING |
| /api/history response | rows | listBuildHistory(db) over build_history | Yes — real DB SELECT, not static | ✓ FLOWING |
| build_history rows | recordBuildHistory | finalize() with real task.text + threaded provenance | Yes — written on real build completion; e2e drives finalize()→persist→render | ✓ FLOWING |

Full vertical slice (build completes → row persists → page renders) is proven end-to-end by `tests/e2e/build-history.e2e.test.ts` against injected fakes.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full vitest suite | `npx vitest run` | 59 files, 663 tests passed | ✓ PASS |
| build_history table SQL present | grep schema.sql | `CREATE TABLE IF NOT EXISTS build_history` found | ✓ PASS |
| No innerHTML sink on audience page | grep history.js | zero innerHTML/insertAdjacentHTML/document.write/eval | ✓ PASS |
| No red token on history surface | grep history.css | no red hex/keyword as background/badge | ✓ PASS |
| finalizeAborted writes no history row | grep + e2e | single recordBuildHistory call site (finalize only); e2e asserts abort absence | ✓ PASS |

Live-channel behaviors (SC 2/3/4) are intentionally NOT spot-checkable — routed to human verification.

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes declared for this phase; verification uses the vitest suite (663 green) as the runnable check. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| HIST-01 | 05-01, 05-02 | Winning/selected suggestions + build results persist to a browsable, audience-facing changelog that survives restarts and spans stream nights | ✓ SATISFIED | Full code deliverable verified above; SC-1 PASS. |

No orphaned requirements: ROADMAP maps only HIST-01 to Phase 5, and both plans declare it.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| docs/OPERATIONS.md | 233 | Wrong port: "Served at http://127.0.0.1:4900/history (same CONSOLE_PORT host process)" — actual is a SEPARATE surface on HISTORY_PORT (default 4903, main.ts:158) | ⚠️ Warning (WR-DOC) | The operator runbook (05-DRY-RUN.md §2) tells the human to open "the /history changelog page" during the dry run; the OPERATIONS doc points them at port 4900, where the console — not the history server — is listening. Documentation-only; the code is correctly wired. Fix before the dry run. |
| src/main.ts | 910, 915 | `TODO(D-08)` — held-plan review-queue routing deferred | ℹ️ Info | Not the TBD/FIXME/XXX blocker class; references formal deferral D-08; pre-existing Phase-3 deferral surfaced in a Phase-5-touched file; explicitly accepted as IN-04 in the RESOLVED 05-REVIEW.md; behaviour is audited + narrated (never silent). |
| src/shared/types.ts | 57 | `TODO(01-02)` — narrow alias to categories union | ℹ️ Info | Pre-existing Phase-1 marker (TODO, not blocker class); unrelated to this phase's deliverable. |

No BLOCKER-class anti-patterns. No stubs, no hollow data, no unwired artifacts. The prior deep code review (05-REVIEW.md) is RESOLVED (4 warnings + 2 info fixed; 2 info accepted as documented D-08 deferrals).

### Human Verification Required

See the `human_verification` frontmatter block for the full list. In summary:

1. **Preconditions** — Phase 3 Wave 0 WSL2 = GO and Phase 4 live gate = GO must be recorded first (05-DRY-RUN.md §1).
2. **Full-loop rehearsal** (SC-2) — suggest→filter→vote→build→preview on a live test channel (§3).
3. **Paid window + chaos** (SC-2) — real tip + channel-points redemption + chaos round; broadcast shows donor name + countdown only, no amount (§4).
4. **Kill switch vs. in-progress build** (SC-3) — halt a genuinely mid-session build; confirm clean abort, no false "BUILT IT", no changelog row live (§5). The no-row code path is already machine-verified.
5. **Audit + changelog compliance review** (SC-4) — audit log shows zero unfiltered inputs and every rejection got chat feedback; /history shows correct chips, honest results, no pre-gate text, no donor detail (§6).
6. **WR-DOC** — correct the OPERATIONS.md §7.1 port before running the dry run (one-line fix).

### Gaps Summary

**No code gaps.** The single buildable deliverable (HIST-01 / SC-1) is fully achieved and verified against the actual codebase at all four levels (exists, substantive, wired, data flows), with 663 tests green. The append-only ledger, the finalize()-only write path, the abort-writes-nothing guarantee, the three-driver provenance threading, restart durability, night grouping, the loopback read-only coarse-projection page, and textContent-only/no-red rendering all hold in source and are covered by non-vacuous tests.

**Success criteria 2/3/4 remain open by design** — they are the human dry-run rehearsal and CANNOT be closed by code. The artifact that gates them (05-DRY-RUN.md) is present, complete, and honest: it consolidates the two previously-deferred human gates (Phase 3 Wave 0, Phase 4 live gate) as blocking preconditions, walks every required mode, and keeps its GO/NO-GO verdict correctly PENDING. Phase 5's goal ("provably ready for the first real stream night") is therefore code-complete but cannot be declared fully achieved until a human runs the dry run and records GO — which is exactly the intended shape of this finish-line phase.

**One warning to clear before the dry run:** the OPERATIONS.md history-page port is documented incorrectly (4900/console vs. the real 4903/separate surface). It is a documentation defect, not a code defect, but it lives in the runbook path the operator follows, so it should be fixed before the rehearsal to avoid friction.

**Overall verdict:** Code deliverable **PASS**; human dry run **PENDING** (properly gated). Status: **human_needed**.

---

_Verified: 2026-07-10T08:05:00Z_
_Verifier: Claude (gsd-verifier)_
