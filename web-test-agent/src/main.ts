import 'dotenv/config';
import { getLogger } from './logger';
import { getDb, closeDb } from './db/db';

// ============================================================
// Main Entry Point – web-test-agent / src/main.ts
// M0: Bootstraps logger + DB and exits cleanly.
// Full orchestration will be wired in M1+.
// ============================================================

const log = getLogger('main');

async function main(): Promise<void> {
  log.info({ event: 'startup' }, 'web-test-agent starting (M0 skeleton)');

  // Initialize database (creates data/agent.db on first run)
  const db = getDb();
  const row = db.prepare("SELECT sqlite_version() as version").get() as { version: string };
  log.info({ event: 'db_ok', sqlite_version: row.version }, 'SQLite OK');

  log.info({ event: 'shutdown' }, 'M0 bootstrap complete – shutting down');
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
