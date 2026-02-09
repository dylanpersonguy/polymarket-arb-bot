import pino from "pino";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const logger = pino({ name: "Database" });

export function initializeDatabase(dbPath: string = "arb.db"): Database.Database {
  const db = new Database(dbPath);

  // Enable foreign keys
  db.pragma("foreign_keys = ON");

  // Create tables if they don't exist
  const migrations = fs.readFileSync(path.join(process.cwd(), "src/storage/migrations.sql"), "utf-8");
  db.exec(migrations);

  logger.info({ dbPath }, "Database initialized");
  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
  logger.info("Database closed");
}
