import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

const logger = pino({ name: "DB" });

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(dbPath = "./polyarb.db"): Database.Database {
  if (_db) return _db;

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Run migrations
  const sql = readFileSync(resolve(__dirname, "migrations.sql"), "utf-8");
  _db.exec(sql);

  logger.info({ dbPath }, "Database initialized");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info("Database closed");
  }
}
