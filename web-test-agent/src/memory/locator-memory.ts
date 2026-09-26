import { getDb } from '../db/db';
import { getLogger } from '../logger';
import { LocatorMemoryEntry, LocatorMemoryEntrySchema } from '../models/schemas';

// ============================================================
// Locator Memory – web-test-agent / src/memory/locator-memory.ts
// Persists successful locators in SQLite to enable reuse across runs.
// ============================================================

const log = getLogger('locator-memory');

export class LocatorMemory {
  /**
   * Look up a previously successful locator for a given target description and URL pattern.
   * Prioritizes entries with higher success rates and recent usage.
   */
  lookup(url: string, targetDescription: string): LocatorMemoryEntry | null {
    try {
      const db = getDb();
      const normalizedTarget = targetDescription.trim().toLowerCase();

      // Find matching entries ordered by success count and last_used_at
      const stmt = db.prepare(`
        SELECT * FROM locator_memory
        WHERE lower(target_description) = ?
        ORDER BY (success_count - failure_count) DESC, last_used_at DESC
        LIMIT 10
      `);

      const rows = stmt.all(normalizedTarget) as any[];

      for (const row of rows) {
        // Simple pattern matching: exact, wildcard, or URL prefix
        if (this.urlMatches(row.url_pattern, url)) {
          const parsed = LocatorMemoryEntrySchema.safeParse(row);
          if (parsed.success && parsed.data.success_count > parsed.data.failure_count) {
            log.debug(
              { event: 'memory_hit', locator: parsed.data.locator, target: targetDescription },
              'Found valid locator in memory'
            );
            return parsed.data;
          }
        }
      }

      return null;
    } catch (err) {
      log.warn({ event: 'memory_lookup_error', error: String(err) }, 'Failed to lookup locator from memory');
      return null;
    }
  }

  /**
   * Record a successful locator execution in memory.
   */
  recordSuccess(
    urlPattern: string,
    targetDescription: string,
    locator: string,
    strategy: LocatorMemoryEntry['strategy']
  ): void {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const normalizedTarget = targetDescription.trim().toLowerCase();

      const existingStmt = db.prepare(`
        SELECT id, success_count FROM locator_memory
        WHERE url_pattern = ? AND lower(target_description) = ? AND locator = ?
      `);

      const existing = existingStmt.get(urlPattern, normalizedTarget, locator) as
        | { id: string; success_count: number }
        | undefined;

      if (existing) {
        const updateStmt = db.prepare(`
          UPDATE locator_memory
          SET success_count = success_count + 1, last_used_at = ?
          WHERE id = ?
        `);
        updateStmt.run(now, existing.id);
      } else {
        const insertStmt = db.prepare(`
          INSERT INTO locator_memory (
            id, url_pattern, target_description, locator, strategy,
            success_count, failure_count, last_used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
        `);
        const id = crypto.randomUUID();
        insertStmt.run(id, urlPattern, normalizedTarget, locator, strategy, now, now);
      }

      log.debug(
        { event: 'memory_recorded', locator, target: targetDescription },
        'Recorded locator success in memory'
      );
    } catch (err) {
      log.warn({ event: 'memory_record_error', error: String(err) }, 'Failed to record locator in memory');
    }
  }

  /**
   * Record a failed locator execution in memory.
   */
  recordFailure(urlPattern: string, targetDescription: string, locator: string): void {
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const normalizedTarget = targetDescription.trim().toLowerCase();

      const updateStmt = db.prepare(`
        UPDATE locator_memory
        SET failure_count = failure_count + 1, last_used_at = ?
        WHERE url_pattern = ? AND lower(target_description) = ? AND locator = ?
      `);
      updateStmt.run(now, urlPattern, normalizedTarget, locator);
    } catch (err) {
      log.warn({ event: 'memory_failure_record_error', error: String(err) }, 'Failed to record locator failure in memory');
    }
  }

  /**
   * Clear all records (useful for test resets).
   */
  clear(): void {
    try {
      const db = getDb();
      db.prepare('DELETE FROM locator_memory').run();
    } catch (err) {
      log.warn({ event: 'memory_clear_error', error: String(err) }, 'Failed to clear locator memory');
    }
  }

  /**
   * Simple URL pattern matching supporting wildcards (*).
   */
  private urlMatches(pattern: string, actualUrl: string): boolean {
    if (pattern === '*' || pattern === actualUrl) return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return actualUrl.startsWith(prefix);
    }
    return actualUrl.includes(pattern);
  }
}
