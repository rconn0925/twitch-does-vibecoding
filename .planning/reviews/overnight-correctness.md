---
review: overnight-correctness
reviewed: 2026-07-11
depth: deep
scope: 50e7838..HEAD (orchestrator rewrite + persistent workspace + gallery publisher)
files_reviewed:
  - src/orchestrator/build-session.ts
  - src/orchestrator/workspace.ts
  - src/orchestrator/gallery-publisher.ts
  - src/orchestrator/turn-options.ts
  - src/orchestrator/sdk-runner.ts
  - src/orchestrator/prompt-boundary.ts
  - src/orchestrator/sandbox-process.ts
  - src/orchestrator/types.ts
  - src/overlay/builder-feed.ts
  - src/state-machine/round.ts
  - src/ingestion/suggest-intake.ts
  - src/main.ts
  - src/operator-console/server.ts (workspace route)
findings:
  blocker: 1
  high: 3
  medium: 3
  low: 3
status: issues_found
---

# Overnight Correctness Review — Orchestrator / Persistent Workspace / Gallery

Adversarial pass over tonight's straight-to-build rewrite, the SQLite-backed
persistent workspace, the host-side gallery publisher, the MCP-lockdown turn
options, and the loser-drop round change. Weighted toward live-broadcast
crash-safety, fail-closed behavior, and multi-hour resource leaks per the brief.

The fail-closed/never-throw discipline in `build-session.ts` is genuinely
solid — the terminal-exit, abort, and close-drain paths are careful and the
`onBuildDone` isolation claim holds (see notes). The problems are concentrated
in the NEW persistent-workspace seam, which has never run live end-to-end
(the sandbox debug session ran with `--cd ~`, before `workspaceDir` was wired).

---

## BLOCKER

### BL-01 — The persistent workspace directory is never created inside the distro; `wsl --cd` targets a non-existent path

**Files:** `src/orchestrator/workspace.ts:45-48`, `src/orchestrator/sandbox-process.ts:184-193`, `src/main.ts:295` (+ `SANDBOX-SETUP.md`)

`workspace.dir()` returns `/home/builder/projects/app-<generation>` derived
purely from a SQLite integer. That string flows: `runBuildAttempt` →
`AgentRunSpec.workspaceDir` → `Options.cwd` → `SpawnOptions.cwd` →
`sandbox-process.ts` `const cd = opts.cwd?.startsWith("/") ? opts.cwd : "~"` →
`wsl.exe … --cd /home/builder/projects/app-<N>`.

**Nothing ever creates that directory inside the distro.** `workspace.ts` only
mutates a row; `SANDBOX-SETUP.md` provisions the distro but has no
`mkdir -p /home/builder/projects/app-*` step; there is no `mkdir` for it
anywhere in `src/` (grep confirms). `wsl.exe --cd` does NOT create the target.

**Failure scenario (deterministic, every generation ≥ the first missing dir):**
- generation 1's `app-1` almost certainly does not exist → the first live build
  either aborts at spawn (`chdir: No such file or directory`, exit non-zero →
  the fail-closed `failed` path fires) or, depending on WSL build, silently
  falls back to `/home/builder`.
- Every `POST /api/workspace/new-project` rotation (`app-2`, `app-3`, …) points
  at a fresh integer whose directory has never been created → same failure.
- If WSL falls back to `~` instead of erroring, the feature is still broken a
  different way: all builds share `/home/builder`, so "continue mode" and "New
  project" rotation are no-ops, and the gallery publisher's
  `\\wsl.localhost\…\projects\app-<N>` source (`gallery-publisher.ts:196`) is
  empty/absent → every publish is `no-changes` or `failed`.

Either branch means the headline feature of tonight's work does not function
live. **Fix:** ensure the generation dir exists before the build turn — e.g. a
one-shot `wsl -d <distro> -u <user> -- mkdir -p <dir>` in the sandbox adapter
before spawn, or a `workspace.ensureDir()` seam invoked in `runBuildAttempt`
prior to `runTurn`. Verify live that `--cd` into a freshly-created dir succeeds.

---

## HIGH

### HI-01 — Scaffold-vs-continue is keyed on the "was a build ever done" flag, not on directory emptiness → scaffold prompt runs over a non-empty dir

**Files:** `src/orchestrator/build-session.ts:721`, `src/orchestrator/workspace.ts:52-59`, `src/orchestrator/prompt-boundary.ts:50-54`

`const mode = deps.workspace.scaffolded() ? "continue" : "scaffold"`.
`scaffolded` flips to 1 ONLY on a `done` finalize (`markBuilt()`), and the
`BUILD_SYSTEM_PROMPT_SCAFFOLD` asserts to the agent: *"Your workspace is empty —
scaffold the project from scratch."*

**Failure scenario:** generation 1, first build. `scaffolded=0` → scaffold
mode. The agent writes many files, then the build fails / is refused / trips the
watchdog (HI-03). `markBuilt()` is never called → `scaffolded` stays 0, but
`app-1` now contains a half-written project. The next winner (or a streamer
retry) computes `scaffolded()===false` again → **scaffold mode over a
non-empty, debris-filled directory**, while the system prompt lies that the
workspace is empty. The agent scaffolds on top of conflicting files, or is
confused into overwriting/duplicating.

The empty-vs-non-empty detection the brief asked about is not actually an
emptiness check — it is a success-history flag, and the two diverge on every
failed first build (a routine event over a multi-hour run). **Fix:** base the
mode on real directory state (does `app-<N>` contain files?) or clear/rotate the
generation dir on a non-`done` terminal exit so scaffold mode always meets an
empty dir.

### HI-02 — In-flight COMP-02 only re-screens Write/Edit tool outputs; Bash-written content bypasses the output re-screen and can reach the live preview

**Files:** `src/orchestrator/build-session.ts:191,254-277,573-598`, `src/orchestrator/turn-options.ts:61-81`

`WRITE_EDIT_TOOLS` = `{Write, Edit, MultiEdit, NotebookEdit}`. The D3-07
in-flight re-screen only extracts and screens those tool inputs. The sandboxed
build turn (`assembleSandboxedBuildOptions`) imposes **no `allowedTools` /
`disallowedTools` restriction** — WSL2 isolation is the boundary, so the agent
has `Bash`. Content written via `Bash` (`cat > index.html <<EOF …`, `sed`,
`printf >`, `tee`) produces no Write/Edit `tool_use` batch, so
`extractWriteEditText` returns null and `screenOutputBatch` is never called for
it.

**Failure scenario:** a benign-looking suggestion clears the pre-build screen,
but the agent (or an injection surviving as data) emits ToS-violating text into
`index.html` via a Bash heredoc. The app-under-construction preview
(`PREVIEW_PORT`, an OBS browser source) renders it live on stream, having never
passed the in-flight compliance check that the module header promises covers
"each Write/Edit output batch." The stated D3-07 guarantee has a hole equal to
the entire Bash tool surface.

Mitigations that lower but do not close the risk: sandbox network is allow-listed
to package registries; the builder is Fable following a benign prompt. Still, on
a live broadcast this is an unscreened-output-to-air path. **Fix:** either
disallow `Bash` file mutation on the build turn, or add an
independent screen of workspace file changes (e.g. diff the workspace after the
turn / a filesystem-watch screen) rather than relying on tool-call introspection.

### HI-03 — The per-turn watchdog is a hard total-turn cap, not a stall detector; it aborts healthy long builds and leaves a corrupt workspace

**Files:** `src/orchestrator/build-session.ts:551-563,627-633`, `src/main.ts:1058-1060`

The watchdog is a single `setTimeout(turnTimeoutMs)` armed once at turn start and
never reset on stream activity. The comment and header call it a stall guard
("If the stream stalls without yielding"), but it fires on **any** turn whose
total wall-time exceeds the budget, regardless of steady progress. The prior
5-min value already "aborted an otherwise-progressing real build" (per
`.planning/debug/sandbox-build-spawn-binary.md`); the new 900s value is larger
but still a fixed ceiling on a legitimately long build.

When it fires: `ac.abort()` → `sandboxAdapter.terminate()` (`wsl --terminate`)
kills the VM mid-write → `app-<N>` is left half-written. Because this is a
non-`done` exit, `scaffolded` does not flip, so the next attempt scaffolds over
the debris (HI-01), and in continue-mode the partial/broken files (e.g. a
truncated source file with a syntax error) can break the dev server / the next
build. There is no transactional rollback of the workspace on abort.

**Fix:** make the watchdog an idle/stall timer (reset on each yielded message)
so a progressing build is never killed, and/or clean the generation dir on a
timed-out abort so it cannot poison the next build.

---

## MEDIUM

### ME-01 — Gallery snapshot copy races the next continue-mode build writing the same generation dir

**Files:** `src/main.ts:1068-1092`, `src/orchestrator/gallery-publisher.ts:196-199`

The generation *number* is read synchronously while still `BUILD_IN_PROGRESS`
(the isolation claim holds), but `publishNow` is fire-and-forget and the actual
`fsx.cp(\\wsl.localhost\…\app-<N>, mirror)` runs later on the internal `chain`.
By then finalize has transitioned to IDLE and the NEXT winner can start a
continue-mode build writing into the SAME `app-<N>` dir (no rotation happened).
The copy then reads a directory being mutated by the next build → an
inconsistent snapshot (mix of build N and N+1), or `cp` throws on files changing
under it. Not show-fatal — a failed publish is isolated and logged
(`T-22l-04` verified) — but the gallery artifact is unreliable. **Fix:** snapshot
into a staging copy taken synchronously at `done`, or serialize publish before
releasing the workspace for the next build.

### ME-02 — `workspace.markBuilt()` is not wrapped in the `auditIfOpen` db-open guard

**File:** `src/orchestrator/build-session.ts:444-445`

Every other SQLite write in finalize is guarded by `auditIfOpen` for the WR-05
shutdown-drain-resume path, but `deps.workspace.markBuilt()` (a raw SQLite
`UPDATE`) is not. On the narrow shutdown-race (drain exceeds `CLOSE_DRAIN_MS`,
pipeline resumes after `db.close()`), `markBuilt()` throws on the closed handle
and **escapes finalize before the dequeue / IDLE transition / history write** run.
It self-heals via `runPipeline`'s catch → `finalize(task,"failed")`, but that
records a false `failed` build_history row for a build that actually succeeded
and double-emits stages. Inconsistent with the guard discipline the surrounding
comments claim is uniform. **Fix:** `auditIfOpen(() => deps.workspace.markBuilt())`.

### ME-03 — Gallery mirror + git history grow unbounded across generations

**Files:** `src/orchestrator/gallery-publisher.ts:196-217`, `src/main.ts:1719-1733`

Every generation adds a permanent `app-<N>` dir to `data/gallery-mirror` and a
commit, and the local clone is never pruned/gc'd. Over a long multi-hour run
with many "New project" rotations the mirror and its `.git` grow without bound
on the streaming machine's disk. Acceptable for v1 (this is the archive by
design) but there is no cap or cleanup, and it is the one genuinely unbounded
on-disk growth in tonight's work. **Fix (later):** cap retained generations or
shallow-gc the mirror.

---

## LOW / INFO

### LO-01 — Dead defensive branch in `closeRound`

**File:** `src/state-machine/round.ts:451-457`. With ≥2 options and the new
zero-votes→earliest-winner rule, `winnerOption` is provably never null, so the
"repool all" branch is unreachable. It is clearly labeled defensive; harmless,
but it is now dead code left by the loser-drop change. No action required beyond
awareness.

### LO-02 — `workspaceCopyFilter` drops ALL dotfiles, including benign project files

**File:** `src/orchestrator/gallery-publisher.ts:96-102`. Rejecting every
`.`-prefixed basename correctly excludes `.env`/`.git`, but also drops
`.gitignore`, `.eslintrc`, `.npmrc`, etc. from the published snapshot — a
completeness gap, not a security issue. Fine if intentional; worth a comment
that legitimate dotfiles are sacrificed for the secrets guarantee.

### LO-03 — Loser-drop correctness is otherwise clean

**File:** `src/state-machine/round.ts:388,488-491`. Confirmed: dropped losers
leave the pool via the draw-time `pool.remove`, so `suggest-intake.ts`'s lazy
`pendingCandidateIds` reconciliation frees the suggester's slot correctly; the
halt-recovery `#discard()` path still repools intentionally; no remaining code
assumes losers repool. `INTAKE_MAX_POOLED_PER_USER` knob is safe (`envPositive`
floors it at the default of 1; `0` cannot disable the cap). No defect — recorded
so the drop change is on the record as reviewed.

---

_Reviewer: Claude (adversarial code review) — deep pass, READ-ONLY_
