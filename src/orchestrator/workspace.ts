/**
 * quick-0iu persistent workspace state — the SQLite-backed WorkspaceView.
 *
 * Design: ROTATION, NOT DELETION. The build workspace is
 * `/home/builder/projects/app-<generation>` (POSIX-absolute inside the WSL2
 * distro). "New project" INCREMENTS the generation — the next build cds into a
 * fresh empty dir and scaffolds; the previous dir stays on disk untouched
 * (archive-by-construction: zero destructive commands, zero new wsl.exe exec
 * surface, zero new dependencies).
 *
 * Why durable state and not in-memory: which generation is live and whether
 * the next build scaffolds vs. continues MUST survive a host-process crash
 * mid-stream (same rationale as the task queue — better-sqlite3, synchronous,
 * single-row). Persistence of the workspace FILES across `wsl --terminate` is
 * plain filesystem behavior — terminate only stops the VM; nothing anywhere
 * wipes the distro per task.
 *
 * `scaffolded` flips to 1 ONLY when a build finalizes `done` in the current
 * generation (build-session finalize()): a failed/refused/vetoed first build
 * leaves the next attempt in scaffold mode — nothing meaningful was built.
 *
 * The directory path is built from an internally-generated INTEGER — never
 * user/chat text (the only templating in this module).
 */

import type Database from "better-sqlite3";
import type { WorkspaceView } from "./types.js";

/** Create (or resume) the single-row workspace state. Idempotent on boot. */
export function createWorkspaceState(db: Database.Database): WorkspaceView {
  // Boot: seed generation 1 if this is a fresh ledger; an existing row is
  // NEVER reset (crash/restart resumes exactly where the stream left off).
  db.prepare(
    `INSERT OR IGNORE INTO workspace_state (id, generation, scaffolded, updated_at_ms)
     VALUES (1, 1, 0, @now)`,
  ).run({ now: Date.now() });

  const read = db.prepare(
    "SELECT generation, scaffolded FROM workspace_state WHERE id = 1",
  );

  function row(): { generation: number; scaffolded: number } {
    return read.get() as { generation: number; scaffolded: number };
  }

  return {
    dir(): string {
      // Internally-generated integer only — never chat text.
      return `/home/builder/projects/app-${row().generation}`;
    },
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
      db.prepare(
        `UPDATE workspace_state
         SET generation = generation + 1, scaffolded = 0, updated_at_ms = @now
         WHERE id = 1`,
      ).run({ now: Date.now() });
      return row().generation;
    },
  };
}
