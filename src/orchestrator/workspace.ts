/**
 * quick-0iu persistent workspace state — the SQLite-backed WorkspaceView.
 *
 * Design: ROTATION, NOT DELETION. The build workspace is
 * `/home/builder/projects/app-<generation>` (POSIX-absolute inside the WSL2
 * distro). "New project" allocates a FRESH generation — the next build cds
 * into a fresh empty dir and scaffolds; the previous dir stays on disk
 * untouched (archive-by-construction: zero destructive commands, zero new
 * wsl.exe exec surface, zero new dependencies).
 *
 * quick-t8k MONOTONIC ALLOCATION: `top_generation` is the all-time high-water
 * mark. newProject() allocates `top_generation + 1` and moves BOTH columns;
 * activateExisting() (the chat-voted portfolio swap) moves ONLY the
 * `generation` pointer. Without the mark, a backward swap followed by a
 * new-project would re-allocate an existing generation — colliding with its
 * app-N dir (HI-01 continue-mode corruption) and its project_repos row
 * (publishing the new project into the OLD repo).
 *
 * Why durable state and not in-memory: which generation is live and whether
 * the next build scaffolds vs. continues MUST survive a host-process crash
 * mid-stream (same rationale as the task queue — better-sqlite3, synchronous,
 * single-row). Persistence of the workspace FILES across `wsl --terminate` is
 * plain filesystem behavior — terminate only stops the VM; nothing anywhere
 * wipes the distro per task.
 *
 * `scaffolded` flips to 1 ONLY when a build finalizes `done` in the current
 * generation (build-session finalize()) — or when activateExisting() points
 * at an existing generation (its dir already holds a built project, so the
 * next build must CONTINUE, never scaffold over it).
 *
 * The directory path is built from an internally-generated INTEGER — never
 * user/chat text (the only templating in this module).
 */

import type Database from "better-sqlite3";
import type { WorkspaceView } from "./types.js";

/** Create (or resume) the single-row workspace state. Idempotent on boot. */
export function createWorkspaceState(db: Database.Database): WorkspaceView {
  // quick-t8k guarded additive migration for EXISTING DBs: workspace_state is
  // CREATE TABLE IF NOT EXISTS in schema.sql, so a db created before t8k will
  // never pick up top_generation from schema.sql alone — add it here.
  const columns = db.prepare("PRAGMA table_info(workspace_state)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "top_generation")) {
    db.exec("ALTER TABLE workspace_state ADD COLUMN top_generation INTEGER NOT NULL DEFAULT 0");
  }

  // Boot: seed generation 1 if this is a fresh ledger; an existing row is
  // NEVER reset (crash/restart resumes exactly where the stream left off).
  db.prepare(
    `INSERT OR IGNORE INTO workspace_state (id, generation, scaffolded, updated_at_ms)
     VALUES (1, 1, 0, @now)`,
  ).run({ now: Date.now() });

  // ALWAYS seed the high-water mark idempotently: covers both the migration
  // path (legacy row lands with top_generation = 0 < generation) and the
  // fresh-insert path (DEFAULT 0 → seeded to 1). Never lowers an existing
  // mark — high-water semantics by the WHERE clause.
  db.prepare(
    "UPDATE workspace_state SET top_generation = generation WHERE id = 1 AND top_generation < generation",
  ).run();

  const read = db.prepare(
    "SELECT generation, scaffolded, top_generation FROM workspace_state WHERE id = 1",
  );

  function row(): { generation: number; scaffolded: number; top_generation: number } {
    return read.get() as { generation: number; scaffolded: number; top_generation: number };
  }

  // quick-260717-093 (D093-1): the ONE place the app-<N> path template exists.
  // dir() delegates here; main.ts's holdover-aware supervisor workspaceDir
  // closure calls it for the held-over generation — never duplicating the
  // template. Number.isInteger guard (activateExisting's validation style,
  // T-093-01): the input is only ever an internally-generated integer, and a
  // non-integer throws BEFORE any templating.
  function dirFor(generation: number): string {
    if (!Number.isInteger(generation)) {
      throw new Error(`dirFor: generation ${generation} is not an integer`);
    }
    return `/home/builder/projects/app-${generation}`;
  }

  return {
    dir(): string {
      // Internally-generated integer only — never chat text.
      return dirFor(row().generation);
    },
    dirFor,
    generation(): number {
      return row().generation;
    },
    scaffolded(): boolean {
      return row().scaffolded === 1;
    },
    markBuilt(): void {
      db.prepare(
        "UPDATE workspace_state SET scaffolded = 1, updated_at_ms = @now WHERE id = 1",
      ).run({ now: Date.now() });
    },
    newProject(): number {
      // MONOTONIC (quick-t8k): allocate ABOVE the all-time high-water mark,
      // never `generation + 1` off the (possibly swapped-back) pointer. SQLite
      // evaluates both right-hand sides against the PRE-update row, so the two
      // columns land equal.
      db.prepare(
        `UPDATE workspace_state
         SET top_generation = top_generation + 1, generation = top_generation + 1,
             scaffolded = 0, updated_at_ms = @now
         WHERE id = 1`,
      ).run({ now: Date.now() });
      return row().generation;
    },
    activateExisting(target: number): void {
      // Belt-and-braces in-method validation (quick-t8k BLOCKER 2): this is a
      // public WorkspaceView method — an unvalidated target would park the
      // pointer at a dir-less generation with scaffolded=1 (continue mode into
      // nothing). Caller-side project_repos resolution remains the PRIMARY
      // resolver; every rejection here throws BEFORE any write.
      const current = row();
      if (!Number.isInteger(target)) {
        throw new Error(`activateExisting: target ${target} is not an integer`);
      }
      if (target < 1) {
        throw new Error(`activateExisting: target ${target} is below generation 1`);
      }
      if (target > current.top_generation) {
        throw new Error(
          `activateExisting: target ${target} exceeds top_generation ${current.top_generation}`,
        );
      }
      if (target === current.generation) {
        throw new Error(`activateExisting: target ${target} is already the current generation`);
      }
      // Non-destructive by construction: a pointer-only move — no filesystem
      // touch, no deletion path, top_generation UNTOUCHED. scaffolded = 1
      // because the target generation holds an existing project (continue mode).
      db.prepare(
        `UPDATE workspace_state
         SET generation = @target, scaffolded = 1, updated_at_ms = @now
         WHERE id = 1`,
      ).run({ target, now: Date.now() });
    },
  };
}
