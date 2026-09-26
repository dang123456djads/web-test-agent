/**
 * M0 Smoke Test Suite
 *
 * Validates that all core M0 components are operational:
 * 1. Zod schemas can be imported and parsed
 * 2. SQLite database can be created and queried
 * 3. Logger initializes without error
 * 4. Playwright can launch a browser (Chromium)
 * 5. Config file is valid JSON and readable
 */

import * as path from 'path';
import * as fs from 'fs';

// ─── 1. Zod Schemas ──────────────────────────────────────────
describe('M0 Smoke: Zod Schemas', () => {
  it('should import and parse UserRequestSchema', async () => {
    const { UserRequestSchema } = await import('../../src/models/schemas');
    const result = UserRequestSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000001',
      target_url: 'https://example.com',
      description: 'Smoke test',
      created_at: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('should import and parse LocatorMemoryEntrySchema', async () => {
    const { LocatorMemoryEntrySchema } = await import('../../src/models/schemas');
    const now = new Date().toISOString();
    const result = LocatorMemoryEntrySchema.safeParse({
      id: '00000000-0000-0000-0000-000000000002',
      url_pattern: 'https://example.com/*',
      target_description: 'Login button',
      locator: 'role=button[name="Login"]',
      strategy: 'role',
      success_count: 1,
      failure_count: 0,
      last_used_at: now,
      created_at: now,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid UserRequestSchema (bad URL)', async () => {
    const { UserRequestSchema } = await import('../../src/models/schemas');
    const result = UserRequestSchema.safeParse({
      id: '00000000-0000-0000-0000-000000000003',
      target_url: 'not-a-valid-url',
      created_at: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('should export all 14 core schemas', async () => {
    const schemas = await import('../../src/models/schemas');
    const expectedExports = [
      'UserRequestSchema',
      'TestPlanSchema',
      'ElementDescriptorSchema',
      'StateSchema',
      'StateGraphSchema',
      'ExpectedOracleSchema',
      'TestActionSchema',
      'TestCaseSchema',
      'GroundingCandidateSchema',
      'GroundingResultSchema',
      'ExecutionResultSchema',
      'ObservationRecordSchema',
      'EvaluationResultSchema',
      'LocatorMemoryEntrySchema',
    ];
    for (const name of expectedExports) {
      expect(schemas).toHaveProperty(name);
    }
  });
});

// ─── 2. SQLite Database ───────────────────────────────────────
describe('M0 Smoke: SQLite Database', () => {
  const testDbPath = path.resolve(__dirname, '../../data/smoke-test.db');

  afterAll(() => {
    // Clean up test DB
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should create a SQLite database and run a query', async () => {
    process.env['DB_PATH'] = testDbPath;

    // Reset module singleton for isolated test
    jest.resetModules();
    const { getDb, closeDb } = await import('../../src/db/db');

    try {
      const db = getDb();
      const row = db
        .prepare("SELECT sqlite_version() as version")
        .get() as { version: string };
      expect(row.version).toMatch(/^\d+\.\d+/);
      closeDb();
    } finally {
      delete process.env['DB_PATH'];
    }
  });

  it('should create data directory if it does not exist', () => {
    const dataDir = path.resolve(__dirname, '../../data');
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('should have locator_memory and test_runs tables after init', async () => {
    process.env['DB_PATH'] = testDbPath;
    jest.resetModules();

    const { getDb, closeDb } = await import('../../src/db/db');

    try {
      const db = getDb();
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name IN ('locator_memory', 'test_runs', 'schema_migrations')`
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('locator_memory');
      expect(tableNames).toContain('test_runs');
      expect(tableNames).toContain('schema_migrations');
      closeDb();
    } finally {
      delete process.env['DB_PATH'];
    }
  });
});

// ─── 3. Logger ───────────────────────────────────────────────
describe('M0 Smoke: Logger', () => {
  it('should create a module-scoped logger without throwing', async () => {
    const { getLogger } = await import('../../src/logger');
    expect(() => {
      const log = getLogger('smoke-test');
      log.info({ event: 'smoke_test' }, 'Logger smoke test OK');
    }).not.toThrow();
  });
});

// ─── 4. Playwright ───────────────────────────────────────────
describe('M0 Smoke: Playwright', () => {
  it('should launch Chromium, open about:blank, and close', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('about:blank');

    const title = await page.title();
    expect(title).toBe('');

    await browser.close();
  }, 60_000);
});

// ─── 5. Config ───────────────────────────────────────────────
describe('M0 Smoke: Config', () => {
  it('should read and parse configs/default.json', () => {
    const configPath = path.resolve(__dirname, '../../configs/default.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    expect(config).toHaveProperty('explorer.max_depth');
    expect(config).toHaveProperty('explorer.max_states');
    expect(config).toHaveProperty('llm.max_llm_calls');
    expect(config).toHaveProperty('grounding.confidence_threshold');
    expect(config).toHaveProperty('grounding.ambiguity_threshold');
    expect(config).toHaveProperty('executor.timeout_ms');
    expect(config).toHaveProperty('executor.retry_count');
  });
});
