# Deferred Items — Phase 02 (chat-vote-loop)

Out-of-scope discoveries logged during execution. Not fixed by the discovering
plan (scope boundary: executors only auto-fix issues caused by their own
changes).

## From plan 02-06 execution (2026-07-10)

- **`npm run lint` fails on pre-existing files under biome 2.5.3** — two
  `lint/complexity/useOptionalChain` hits in `src/overlay/public/overlay.js`
  (lines ~147 and ~216, committed by plan 02-05), plus recurring CRLF
  formatter complaints on 5 pre-existing files (`src/audit/db.ts`,
  `src/compliance/categories.ts`, two fixtures, `src/state-machine/stream-mode.ts`)
  caused by worktree checkout line-ending conversion (`git diff` is empty —
  content is identical). Plan 02-06 is tests+docs only (zero src edits is a
  machine-checked acceptance criterion), so these are logged instead of fixed.
  Fix in the next plan that legitimately touches src/, or a dedicated
  `chore: satisfy biome 2.5.3` commit on the main branch.
