# Deferred Items — Phase 3

Out-of-scope discoveries logged during execution. NOT fixed (SCOPE BOUNDARY: only
auto-fix issues directly caused by the current task's changes).

## Pre-existing biome lint failures (discovered during 03-02)

`npm run lint` reports 5 "Formatter would have printed" (CRLF line-ending / format)
errors on Phase 1 files that this plan never touched:

- `src/audit/db.ts`
- `src/compliance/categories.ts`
- `src/compliance/fixtures/feasibility.fixtures.ts`
- `src/compliance/fixtures/taxonomy.fixtures.ts`
- `src/state-machine/stream-mode.ts`

All 03-02 source files pass `biome check` cleanly. These pre-existing failures are
CRLF/formatting only (no logic), likely from a Windows checkout with `autocrlf`. Left
untouched to avoid churning unrelated files; a repo-wide `biome check --write` (or an
`.gitattributes` `* text=auto eol=lf` normalization pass) should resolve them in a
dedicated chore, not inside a feature plan.
