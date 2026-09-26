import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger } from '../logger';

// ============================================================
// Database – web-test-agent / src/db/db.ts
// SQLite connection singleton with basic migration/init
// ============================================================

const log = getLogger('db');

// ─── Resolve DB path ─────────────────────────────────────────
function resolveDbPath(): string {
  const envPath = process.env['DB_PATH'];
  if (envPath) {
    return path.resolve(envPath);
  }
  // Default: <project-root>/data/agent.db
  return path.resolve(process.cwd(), 'data', 'agent.db');
}

// ─── Singleton instance ───────────────────────────────────────
let _db: Database.Database | null = null;

/**
 * Returns the singleton SQLite database connection.
 * Creates the database file and runs initial migrations on first call.
 */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolveDbPath();

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info({ event: 'dir_created', path: dir }, 'Created data directory');
  }

  log.info({ event: 'db_connect', path: dbPath }, 'Opening SQLite database');

  _db = new Database(dbPath, {
    verbose: process.env['LOG_LEVEL'] === 'trace'
      ? (msg) => log.trace({ event: 'sql', sql: msg })
      : undefined,
  });

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  runMigrations(_db);

  log.info({ event: 'db_ready' }, 'Database ready');
  return _db;
}

/**
 * Closes the database connection (call on process exit).
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info({ event: 'db_closed' }, 'Database connection closed');
  }
}

// ─── Migrations ───────────────────────────────────────────────
function runMigrations(db: Database.Database): void {
  log.info({ event: 'migrations_start' }, 'Running database migrations');

  db.exec(`
    -- Migration: 001_initial_schema
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Locator Memory table (populated in M3+)
    CREATE TABLE IF NOT EXISTS locator_memory (
      id                  TEXT    PRIMARY KEY,
      url_pattern         TEXT    NOT NULL,
      target_description  TEXT    NOT NULL,
      locator             TEXT    NOT NULL,
      strategy            TEXT    NOT NULL,
      success_count       INTEGER NOT NULL DEFAULT 0,
      failure_count       INTEGER NOT NULL DEFAULT 0,
      last_used_at        TEXT    NOT NULL,
      created_at          TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_locator_url_pattern
      ON locator_memory (url_pattern);

    CREATE INDEX IF NOT EXISTS idx_locator_description
      ON locator_memory (target_description);

    -- Test Run table (basic, expanded in M4+)
    CREATE TABLE IF NOT EXISTS test_runs (
      id          TEXT    PRIMARY KEY,
      request_id  TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',
      started_at  TEXT,
      finished_at TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Record migration
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)`
  );
  stmt.run(1, '001_initial_schema');

  log.info({ event: 'migrations_done' }, 'Migrations applied');
}
