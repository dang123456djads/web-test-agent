import { Page } from 'playwright';
import { getLogger } from '../logger';
import { TestAction, ExecutionResult } from '../models/schemas';

// ============================================================
// Executor – web-test-agent / src/executor/executor.ts
// M1: Executes TestActions directly on a Playwright Page.
//
// IMPORTANT – M1 contract:
//   action.target_description is used AS the Playwright locator string.
//   Grounding (NL → locator resolution) is NOT implemented here.
//   That belongs to M3 GroundingEngine.
//
// Supported action types: navigate | click | fill | press |
//                          hover   | wait  | scroll | assert
// ============================================================

const log = getLogger('executor');

export interface ExecutorConfig {
  /** Action timeout in milliseconds. Default: 30000 */
  timeoutMs: number;
  /** Number of retry attempts on failure. Default: 3 */
  retryCount: number;
  /** Delay between retries in milliseconds. Default: 1000 */
  retryDelayMs: number;
  /** Directory to save failure screenshots. Default: reports/screenshots */
  screenshotDir: string;
  /** Whether to take a screenshot on action failure. Default: true */
  screenshotOnFailure: boolean;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  timeoutMs: 30_000,
  retryCount: 3,
  retryDelayMs: 1_000,
  screenshotDir: 'reports/screenshots',
  screenshotOnFailure: true,
};

// ─── Helper ───────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Executor ─────────────────────────────────────────────────
export class Executor {
  private readonly config: ExecutorConfig;

  constructor(config: Partial<ExecutorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a single TestAction on a Playwright page.
   *
   * In M1, `action.target_description` is used directly as the Playwright
   * locator string (e.g. "text=Login", "#email", "[name=password]").
   *
   * Returns an ExecutionResult indicating pass/fail/error.
   */
  async execute(
    action: TestAction,
    page: Page,
    testCaseId: string = '00000000-0000-0000-0000-000000000000'
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();

    log.info(
      { event: 'action_start', action_id: action.id, type: action.type, target: action.target_description },
      `Executing action: ${action.type}`
    );

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryCount; attempt++) {
      try {
        await this.runAction(action, page);

        const durationMs = Date.now() - startedAt;
        log.info(
          { event: 'action_pass', action_id: action.id, attempt, duration_ms: durationMs },
          `Action passed`
        );

        return this.buildResult(action, 'passed', durationMs, undefined, undefined, testCaseId);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(
          { event: 'action_retry', action_id: action.id, attempt, error: lastError.message },
          `Action failed on attempt ${attempt}, ${attempt < this.config.retryCount ? 'retrying...' : 'giving up.'}`
        );

        if (attempt < this.config.retryCount) {
          await sleep(this.config.retryDelayMs);
        }
      }
    }

    // All retries exhausted
    const durationMs = Date.now() - startedAt;
    const errorMessage = lastError?.message ?? 'Unknown error';

    log.error(
      { event: 'action_fail', action_id: action.id, error: errorMessage, duration_ms: durationMs },
      `Action failed after ${this.config.retryCount} attempts`
    );

    // Optional: take failure screenshot
    let screenshotPath: string | undefined;
    if (this.config.screenshotOnFailure) {
      screenshotPath = await this.takeFailureScreenshot(page, action.id);
    }

    return this.buildResult(action, 'failed', durationMs, errorMessage, screenshotPath, testCaseId);
  }

  // ─── Private: dispatch action ──────────────────────────────
  private async runAction(action: TestAction, page: Page): Promise<void> {
    const locator = action.target_description;
    const timeout = this.config.timeoutMs;

    switch (action.type) {
      case 'navigate': {
        // For navigate, target_description is the URL to navigate to
        const url = action.value ?? locator;
        log.debug({ event: 'navigate', url }, 'Navigating to URL');
        await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        break;
      }

      case 'click': {
        log.debug({ event: 'click', locator }, 'Clicking element');
        await page.locator(locator).click({ timeout });
        break;
      }

      case 'fill': {
        const value = action.value ?? '';
        log.debug({ event: 'fill', locator, value }, 'Filling input');
        await page.locator(locator).fill(value, { timeout });
        break;
      }

      case 'press': {
        const key = action.value ?? 'Enter';
        log.debug({ event: 'press', locator, key }, 'Pressing key');
        await page.locator(locator).press(key, { timeout });
        break;
      }

      case 'hover': {
        log.debug({ event: 'hover', locator }, 'Hovering element');
        await page.locator(locator).hover({ timeout });
        break;
      }

      case 'wait': {
        // value = milliseconds to wait OR a CSS/text selector to wait for
        const waitValue = action.value ?? '1000';
        const ms = parseInt(waitValue, 10);
        if (!isNaN(ms)) {
          log.debug({ event: 'wait_ms', ms }, 'Waiting for duration');
          await page.waitForTimeout(ms);
        } else {
          log.debug({ event: 'wait_selector', selector: waitValue }, 'Waiting for element');
          await page.locator(waitValue).waitFor({ state: 'visible', timeout });
        }
        break;
      }

      case 'scroll': {
        log.debug({ event: 'scroll', locator }, 'Scrolling element into view');
        await page.locator(locator).scrollIntoViewIfNeeded({ timeout });
        break;
      }

      case 'assert': {
        // Oracle-based assertion
        await this.runAssert(action, page, timeout);
        break;
      }

      case 'select': {
        const value = action.value ?? '';
        log.debug({ event: 'select', locator, value }, 'Selecting option');
        await page.locator(locator).selectOption(value, { timeout });
        break;
      }

      default: {
        // TypeScript exhaustive check guard
        const exhaustive: never = action.type;
        throw new Error(`Unsupported action type: ${exhaustive}`);
      }
    }
  }

  // ─── Private: assertion logic ──────────────────────────────
  private async runAssert(action: TestAction, page: Page, timeout: number): Promise<void> {
    const oracle = action.expected_oracle;
    if (!oracle) {
      throw new Error(`Action type 'assert' requires expected_oracle to be set`);
    }

    log.debug(
      { event: 'assert', oracle_type: oracle.type, value: oracle.value },
      'Running assertion'
    );

    switch (oracle.type) {
      case 'url_contains': {
        await page.waitForURL(new RegExp(oracle.value), { timeout });
        break;
      }

      case 'element_visible': {
        await page.locator(oracle.value).waitFor({ state: 'visible', timeout });
        break;
      }

      case 'element_text': {
        // target_description = locator, oracle.value = expected text
        const locator = action.target_description;
        const actualText = await page.locator(locator).innerText({ timeout });
        if (!actualText.includes(oracle.value)) {
          throw new Error(
            `element_text assertion failed: expected "${oracle.value}" in "${actualText}"`
          );
        }
        break;
      }

      case 'no_error': {
        // Only count VISIBLE error elements – hidden ones (display:none) are ignored
        const errorLocator = page
          .locator('[role="alert"], .error, .alert-error, #error-message')
          .filter({ visible: true });
        const count = await errorLocator.count();
        if (count > 0) {
          const text = await errorLocator.first().innerText({ timeout });
          throw new Error(`no_error assertion failed: found error element with text "${text}"`);
        }
        break;
      }

      case 'custom': {
        // Custom assertions are evaluated as-is (future: pass to LLM evaluator)
        log.warn(
          { event: 'assert_custom_skip', value: oracle.value },
          'Custom assertion skipped in M1 – will be evaluated in M7'
        );
        break;
      }

      default: {
        const exhaustive: never = oracle.type;
        throw new Error(`Unsupported oracle type: ${exhaustive}`);
      }
    }
  }

  // ─── Private: failure screenshot ───────────────────────────
  private async takeFailureScreenshot(page: Page, actionId: string): Promise<string | undefined> {
    try {
      const fs = await import('fs');
      const path = await import('path');

      if (!fs.existsSync(this.config.screenshotDir)) {
        fs.mkdirSync(this.config.screenshotDir, { recursive: true });
      }

      const filename = `failure-${actionId}-${Date.now()}.png`;
      const filepath = path.resolve(this.config.screenshotDir, filename);
      await page.screenshot({ path: filepath });

      log.info({ event: 'screenshot_failure', path: filepath }, 'Failure screenshot saved');
      return filepath;
    } catch (e) {
      log.warn({ event: 'screenshot_error', error: String(e) }, 'Could not take failure screenshot');
      return undefined;
    }
  }

  // ─── Private: build result ─────────────────────────────────
  private buildResult(
    action: TestAction,
    status: ExecutionResult['status'],
    durationMs: number,
    errorMessage?: string,
    screenshotPath?: string,
    testCaseId: string = '00000000-0000-0000-0000-000000000000'
  ): ExecutionResult {
    return {
      action_id: action.id,
      test_case_id: testCaseId,
      status,
      locator_used: action.target_description,
      error_message: errorMessage,
      screenshot_path: screenshotPath,
      duration_ms: durationMs,
      executed_at: new Date().toISOString(),
    };
  }
}
