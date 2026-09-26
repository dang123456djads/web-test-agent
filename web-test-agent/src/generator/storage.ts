import * as fs from 'fs';
import * as path from 'path';
import { TestCase } from './types';
import { assertValidTestCase } from './validator';
import { getLogger } from '../logger';

// ============================================================
// TestCase Storage – web-test-agent / src/generator/storage.ts
// Handles file-based JSON persistence and retrieval of TestCase objects.
// ============================================================

const log = getLogger('test-storage');

export const DEFAULT_STORAGE_DIR = path.resolve(process.cwd(), 'reports/test-cases');

export class TestCaseStorage {
  private readonly defaultDir: string;

  constructor(defaultDir: string = DEFAULT_STORAGE_DIR) {
    this.defaultDir = defaultDir;
  }

  /**
   * Saves a TestCase to disk as formatted JSON.
   * If targetPathOrDir ends with '.json', it is treated as a full path.
   * Otherwise, it is treated as a directory and `${testCase.id}.json` is used.
   */
  async save(testCase: TestCase, targetPathOrDir?: string): Promise<string> {
    const destination = targetPathOrDir ?? this.defaultDir;
    let filePath: string;

    if (destination.endsWith('.json')) {
      filePath = destination;
    } else {
      filePath = path.join(destination, `${testCase.id}.json`);
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(testCase, null, 2);
    await fs.promises.writeFile(filePath, json, 'utf-8');

    log.info(
      { event: 'storage_saved', testCaseId: testCase.id, path: filePath },
      `Saved TestCase "${testCase.name}" to ${filePath}`
    );

    return filePath;
  }

  /**
   * Loads and validates a TestCase from a JSON file.
   */
  async load(filePath: string): Promise<TestCase> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`TestCase file not found: ${filePath}`);
    }

    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = assertValidTestCase(parsed);

    log.info(
      { event: 'storage_loaded', testCaseId: validated.id, path: filePath },
      `Loaded TestCase "${validated.name}" from ${filePath}`
    );

    return validated;
  }

  /**
   * Lists all test case JSON file paths in the directory.
   */
  async list(directory?: string): Promise<string[]> {
    const dir = directory ?? this.defaultDir;
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = await fs.promises.readdir(dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f));
  }

  /**
   * Deletes a test case JSON file.
   */
  async delete(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;
    await fs.promises.unlink(filePath);
    return true;
  }
}
