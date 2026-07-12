import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../audit/db.js";
import { createWorkspaceState } from "./workspace.js";

/**
 * quick-0iu persistent-workspace state (SQLite-backed WorkspaceView).
 *
 * Rotation-not-deletion: newProject() only increments the generation — the
 * previous distro dir is archived by construction (no delete path exists to
 * test because none exists in src/). What IS tested here: boot seeding, the
 * dir() shape (internal integer, never user text), the scaffolded flip,
 * rotation semantics, and crash durability across a close/reopen of the SAME
 * db file plus resume-without-reset on an existing row.
 */

describe("createWorkspaceState (quick-0iu)", () => {
  it("boots a fresh ledger at generation 1, unscaffolded", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    expect(ws.generation()).toBe(1);
    expect(ws.scaffolded()).toBe(false);
    db.close();
  });

  it("dir() is /home/builder/projects/app-<generation> (POSIX-absolute, integer-derived)", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    expect(ws.dir()).toBe("/home/builder/projects/app-1");
    ws.newProject();
    expect(ws.dir()).toBe("/home/builder/projects/app-2");
    db.close();
  });

  it("markBuilt() flips scaffolded to true (a done build makes it an existing project)", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    ws.markBuilt();
    expect(ws.scaffolded()).toBe(true);
    db.close();
  });

  it("newProject() increments the generation, resets scaffolded, and returns the new generation", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    ws.markBuilt();
    expect(ws.scaffolded()).toBe(true);

    const next = ws.newProject();

    expect(next).toBe(2);
    expect(ws.generation()).toBe(2);
    // A fresh generation has never had a done build — back to scaffold mode.
    expect(ws.scaffolded()).toBe(false);
    db.close();
  });

  it("state survives a close/reopen of the same db file (crash durability)", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-state-"));
    const dbPath = join(dir, "audit.db");
    try {
      const db1 = openDb(dbPath);
      const ws1 = createWorkspaceState(db1);
      ws1.newProject(); // generation 2
      ws1.markBuilt(); // scaffolded in generation 2
      db1.close();

      // "Crash" + restart: a fresh handle on the SAME file resumes exactly.
      const db2 = openDb(dbPath);
      const ws2 = createWorkspaceState(db2);
      expect(ws2.generation()).toBe(2);
      expect(ws2.scaffolded()).toBe(true);
      expect(ws2.dir()).toBe("/home/builder/projects/app-2");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second createWorkspaceState on an existing row does NOT reset it (INSERT OR IGNORE boot)", () => {
    const db = openDb(":memory:");
    const ws1 = createWorkspaceState(db);
    ws1.newProject();
    ws1.markBuilt();

    const ws2 = createWorkspaceState(db);
    expect(ws2.generation()).toBe(2);
    expect(ws2.scaffolded()).toBe(true);
    db.close();
  });
});

/** Full workspace_state row incl. the quick-t8k high-water mark. */
function stateRow(db: Database.Database): {
  generation: number;
  scaffolded: number;
  top_generation: number;
} {
  return db
    .prepare("SELECT generation, scaffolded, top_generation FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number; top_generation: number };
}

describe("top_generation high-water mark (quick-t8k — checker BLOCKER 1)", () => {
  it("a fresh boot seeds top_generation = generation = 1", () => {
    const db = openDb(":memory:");
    createWorkspaceState(db);
    expect(stateRow(db)).toEqual({ generation: 1, scaffolded: 0, top_generation: 1 });
    db.close();
  });

  it("newProject() moves BOTH columns and they land equal", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    expect(ws.newProject()).toBe(2);
    expect(stateRow(db)).toMatchObject({ generation: 2, top_generation: 2 });
    expect(ws.newProject()).toBe(3);
    expect(stateRow(db)).toMatchObject({ generation: 3, top_generation: 3 });
    db.close();
  });

  it("MONOTONICITY PIN: activate 3→1, then newProject() → 4 (NEVER 2 — no app-N/repo collision)", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    ws.newProject(); // 2
    ws.newProject(); // 3
    ws.markBuilt();
    expect(stateRow(db).top_generation).toBe(3);

    ws.activateExisting(1);
    expect(stateRow(db)).toMatchObject({ generation: 1, scaffolded: 1, top_generation: 3 });

    // The pre-fix `generation + 1` bug would return 2 here — colliding with
    // app-2's dir (HI-01 continue-mode corruption) and app-2's project_repos
    // row (old-repo publish corruption).
    expect(ws.newProject()).toBe(4);
    expect(stateRow(db)).toMatchObject({ generation: 4, scaffolded: 0, top_generation: 4 });
    db.close();
  });

  it("MIGRATION: a legacy db without top_generation gets the column added + seeded to the current generation (idempotent)", () => {
    // Build the LEGACY table shape directly — schema.sql would create the new
    // shape, and CREATE TABLE IF NOT EXISTS can't add a column to it.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE workspace_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        generation    INTEGER NOT NULL,
        scaffolded    INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO workspace_state (id, generation, scaffolded, updated_at_ms) VALUES (1, 3, 1, 0);
    `);

    const ws = createWorkspaceState(db);
    expect(stateRow(db)).toEqual({ generation: 3, scaffolded: 1, top_generation: 3 });

    // Idempotent: a second boot neither re-adds the column nor regresses the seed.
    const ws2 = createWorkspaceState(db);
    expect(stateRow(db)).toEqual({ generation: 3, scaffolded: 1, top_generation: 3 });

    // The migrated mark is live: next new project allocates ABOVE it.
    expect(ws.newProject()).toBe(4);
    expect(ws2.generation()).toBe(4);
    db.close();
  });

  it("the seed never LOWERS an existing top_generation (idempotent high-water semantics)", () => {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    ws.newProject(); // 2
    ws.newProject(); // 3
    ws.activateExisting(1); // pointer back to 1, top stays 3

    // A restart re-runs the seed UPDATE — top_generation must stay 3.
    createWorkspaceState(db);
    expect(stateRow(db)).toMatchObject({ generation: 1, top_generation: 3 });
    db.close();
  });
});

describe("activateExisting — validating, non-destructive pointer move (quick-t8k BLOCKER 2)", () => {
  function seeded() {
    const db = openDb(":memory:");
    const ws = createWorkspaceState(db);
    ws.newProject(); // 2
    ws.newProject(); // 3
    ws.markBuilt();
    return { db, ws };
  }

  it("moves ONLY the generation pointer, sets scaffolded=1, leaves top_generation untouched", () => {
    const { db, ws } = seeded();
    ws.activateExisting(2);
    expect(stateRow(db)).toMatchObject({ generation: 2, scaffolded: 1, top_generation: 3 });
    expect(ws.dir()).toBe("/home/builder/projects/app-2");
    db.close();
  });

  it.each([
    [1.5, "non-integer"],
    [Number.NaN, "NaN"],
    [0, "zero"],
    [-1, "negative"],
    [4, "> top_generation"],
    [3, "=== current generation"],
  ])("throws on target %s (%s) and leaves the row UNTOUCHED", (target) => {
    const { db, ws } = seeded();
    const before = stateRow(db);
    expect(() => ws.activateExisting(target as number)).toThrow(/activateExisting/);
    expect(stateRow(db)).toEqual(before);
    db.close();
  });

  it("rejection messages are descriptive (exceeds top_generation names both numbers)", () => {
    const { db, ws } = seeded();
    expect(() => ws.activateExisting(9)).toThrow("activateExisting: target 9 exceeds top_generation 3");
    db.close();
  });
});
