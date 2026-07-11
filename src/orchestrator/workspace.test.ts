import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
