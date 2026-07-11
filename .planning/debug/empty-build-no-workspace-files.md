---
status: investigating
trigger: "Live end-to-end: a straight-to-build reaches stage 'done' in ~50s but writes NO files into the workspace generation dir; the gallery publisher then creates a real but EMPTY public repo"
created: 2026-07-11
updated: 2026-07-11
---

# Debug: build reports 'done' but produces no workspace files (empty repo)

## Symptoms
- **Expected:** a winning prompt ("build a simple digital clock web page") scaffolds files (index.html etc.) INTO the persistent workspace generation dir (/home/builder/projects/app-1), which the host publisher then commits + pushes → a public repo with real code.
- **Actual:** build goes building→done in ~50s; app-1 contains ONLY `.claude/` (the agent's session dir) — zero project files. Publisher creates a real PUBLIC repo `TwitchVibecodes/build-a-simple-digital-clock-web-page` (correctly named, public) but it is EMPTY (GitHub "This repository is empty", no commits).
- **Timeline:** first real end-to-end run after the 260711-hak per-project-publishing merge (2026-07-11 ~19:05Z, taskId 8eb70ba1). BL-01 workspace-dir creation now works (app-1 exists). Never worked end-to-end before (tests use injected fakes).
- **Reproduction:** deterministic so far (1/1). Any winning prompt.

## Evidence
- app-1 tree (excluding .claude): empty. `find /home/builder -maxdepth 4 -name '*.html' -o -name '*.js'` (minus node_modules/.claude) finds ONLY `/home/builder/demos/compliment-button/index.html` — an artifact of the EARLIER sandbox-spawn debug session (which ran with --cd ~, before workspaceDir was wired), NOT this build.
- The `.claude/` dir inside app-1 implies the agent's cwd WAS app-1 for this run (session dir is created in cwd).
- App log: stage building (719326) → done (769179), ~50s, no tool/write activity logged (only stage transitions surface in pino; builder-feed taps write to the feed, not this log).
- Scaffold system prompt (prompt-boundary.ts:50, BUILD_SYSTEM_PROMPT_SCAFFOLD): says "inside your sandboxed workspace", "Your workspace is empty — scaffold the project from scratch", "Work entirely within your workspace and build the described app." It NEVER concretely instructs "create the files in your CURRENT WORKING DIRECTORY" or names the path. "Your workspace" is abstract.
- Prior debug build wrote to `demos/compliment-button/` — a subdir of the agent's OWN choosing — evidence the agent picks its own layout absent a concrete cwd instruction.

## Current Focus
hypothesis: "The build agent completes its turn without persisting files into the cwd (app-1) because the scaffold system prompt is abstract about WHERE to write ('your workspace', not 'the current directory'), and/or the agent's Write tool resolves paths somewhere other than the --cd cwd, and/or the agent did minimal/no work in 50s. Compounding: finalize declares 'done' WITHOUT verifying the workspace is non-empty, and the publisher CREATES an empty repo instead of no-opping when there is nothing to commit."
test: "Re-run one build with verbose agent-message capture (log the SDK stream / tool_use blocks for the build turn) to see EXACTLY what the agent did — did it call Write at all? to what path? did it end early? Then inspect whether the Write path resolved to app-1 or elsewhere."
expecting: "Either (a) the agent never called Write (prompt/behavior issue), or (b) it wrote to a path outside app-1 (cwd/path-resolution issue)."
next_action: "Instrument the build turn to capture agent tool_use activity for one reproduction; confirm write-or-not and the target path."

## Constraints / notes
- src/compliance/**, halt.ts, kill-switch, CLASSIFIER_SYSTEM_PROMPT are READ-ONLY.
- Two fixes likely needed: (A primary) make the agent reliably build INTO the workspace cwd — probably a concrete prompt directive ("Create all files directly in your current working directory") + verify cwd/Write path resolution; (B secondary) finalize should not report a clean 'done' for an empty workspace, and the publisher should NO-OP (not create a repo) when there are no committable files — so failed/empty builds don't litter empty public repos.
- The app is running (bn4087vtd). Distro vibecoding-build up. The empty test repo exists on TwitchVibecodes (token has no delete_repo scope; Ross can delete it via UI, or it fills once a build actually writes).

## Eliminated
- hypothesis: "sandbox spawn / workspace dir missing" — eliminated: app-1 is created (BL-01 fix verified), the agent session ran in it (.claude present), spawn works (prior debug session fix).
- hypothesis: "publisher push mechanism broken" — partially eliminated: the publisher successfully created the repo and pushed (pushed_at set); it just had nothing to commit. Repo creation + auth + naming all work.

## Resolution
root_cause:
fix:
verification:
files_changed:
