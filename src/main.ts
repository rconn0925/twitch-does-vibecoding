import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { pino } from "pino";
import { openDb } from "./audit/db.js";
import { type ConsoleServerHandle, startConsoleServer } from "./operator-console/server.js";
import { HALT_TRIGGERED } from "./shared/events.js";
import type { HaltContext } from "./shared/types.js";
import { StreamModeMachine } from "./state-machine/stream-mode.js";

export interface CreateAppOptions {
  dbPath: string;
  port: number;
}

export interface AppHandle {
  server: ConsoleServerHandle["server"];
  port: number;
  machine: StreamModeMachine;
  db: Database.Database;
  close: () => Promise<void>;
}

/**
 * Wires the Walking Skeleton: audit db -> state machine -> operator console.
 * Exported factory so the e2e suite can start a real server on an ephemeral
 * port with an in-memory db. pino is operational logging only — the SQLite
 * audit ledger is the compliance record of truth (COMP-05).
 */
export async function createApp(opts: CreateAppOptions): Promise<AppHandle> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

  if (opts.dbPath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  }
  const db = openDb(opts.dbPath);
  const machine = new StreamModeMachine();

  machine.on(HALT_TRIGGERED, (...args) => {
    const ctx = args[0] as HaltContext;
    logger.warn(
      { source: ctx.source, priorMode: ctx.frozen.mode, reasonTag: ctx.reasonTag },
      "HALT triggered",
    );
  });

  const console_ = await startConsoleServer({ machine, db, port: opts.port, logger });
  logger.info(
    { port: console_.port, dbPath: opts.dbPath },
    "operator console listening at http://127.0.0.1:%d",
    console_.port,
  );

  return {
    server: console_.server,
    port: console_.port,
    machine,
    db,
    close: async () => {
      await console_.close();
      db.close();
    },
  };
}

// Run-as-entrypoint branch (npm run dev): tsx executes this file directly.
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.CONSOLE_PORT ?? 4900);
  const dbPath = process.env.AUDIT_DB_PATH ?? "./data/audit.db";
  createApp({ dbPath, port }).catch((err: unknown) => {
    // Startup failure: log and exit loudly — a silent half-started safety spine
    // is worse than no process at all.
    pino().fatal({ err }, "failed to start");
    process.exit(1);
  });
}
