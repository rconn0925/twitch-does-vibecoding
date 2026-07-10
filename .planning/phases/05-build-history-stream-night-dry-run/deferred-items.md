# Deferred items — Phase 05

Out-of-scope discoveries logged during execution (not fixed — see execute-plan scope boundary).

## Pre-existing biome formatter errors (CRLF line endings)

Discovered during 05-02 execution while running the project-wide `biome check src tests scripts`.
Four files fail the biome formatter with CRLF (`\r\n`) line endings where LF is expected:

- `src/audit/db.ts`
- `src/compliance/categories.ts`
- `src/compliance/fixtures/feasibility.fixtures.ts`
- `src/compliance/fixtures/taxonomy.fixtures.ts`

These are NOT touched by plan 05-02 (my files — `src/history/*`, `src/main.ts`,
`tests/e2e/build-history.e2e.test.ts` — all pass `biome check` cleanly). The errors are
line-ending artifacts unrelated to this plan's changes (likely a git checkout / autocrlf
interaction on Windows). Left as-is per the scope boundary (only auto-fix issues directly
caused by the current task). A follow-up formatting/normalization pass (or a
`.gitattributes` `* text=auto eol=lf`) should resolve them repo-wide.
