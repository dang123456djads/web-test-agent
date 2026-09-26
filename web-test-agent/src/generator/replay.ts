import { Page } from 'playwright';
import { getLogger } from '../logger';
import { Executor } from '../executor/executor';
import { Observer } from '../observer/observer';
import { GroundingEngine } from '../grounding/grounding-engine';
import { TestAction } from '../models/schemas';
import {
  TestCase,
  TestStep,
  TestAssertion,
  TestReplayResult,
  ReplayStepResult,
  AssertionResult,
} from './types';

// ============================================================
// TestCase Replayer – web-test-agent / src/generator/replay.ts
// Replays generated TestCase objects on a real browser page
// using Executor (M1), Observer (M2), and GroundingEngine (M3).
// ============================================================

const log = getLogger('test-replayer');

export interface ReplayOptions {
  stepDelayMs?: number;
  testCaseId?: string;
  navigateStartUrl?: boolean;
}

export class TestCaseReplayer {
  private readonly executor: Executor;
  private readonly observer: Observer;
  private readonly groundingEngine?: GroundingEngine;

  constructor(
    executor: Executor,
    observer: Observer,
    groundingEngine?: GroundingEngine
  ) {
    this.executor = executor;
    this.observer = observer;
    this.groundingEngine = groundingEngine;
  }

  /**
   * Replays a generated TestCase on the given Playwright Page.
   */
  async replay(testCase: TestCase, page: Page, options: ReplayOptions = {}): Promise<TestReplayResult> {
    const startTime = Date.now();
    const testCaseId = options.testCaseId ?? testCase.id;
    const stepDelayMs = options.stepDelayMs ?? 100;
    const stepResults: ReplayStepResult[] = [];
    const assertionResults: AssertionResult[] = [];

    log.info(
      { event: 'replay_start', testCaseId, name: testCase.name, steps: testCase.steps.length },
      `Replaying test case: "${testCase.name}" (${testCase.steps.length} steps)`
    );

    // 1. Navigate to startUrl if requested or if page is not on startUrl
    if (options.navigateStartUrl !== false && testCase.startUrl && testCase.startUrl !== 'about:blank') {
      try {
        const currentUrl = page.url();
        if (currentUrl !== testCase.startUrl) {
          log.info({ event: 'replay_navigate', url: testCase.startUrl }, `Navigating to startUrl: ${testCase.startUrl}`);
          await page.goto(testCase.startUrl, { waitUntil: 'domcontentloaded' });
        }
      } catch (err) {
        log.error({ event: 'replay_navigate_error', error: String(err) }, 'Failed to navigate to startUrl');
        return {
          testCaseId,
          status: 'failed',
          steps: [],
          assertions: [],
          durationMs: Date.now() - startTime,
          error: `Navigation to startUrl failed: ${String(err)}`,
        };
      }
    }

    // 2. Execute Steps sequentially
    let allStepsPassed = true;
    let replayError: string | undefined;

    for (const step of testCase.steps) {
      const stepStart = Date.now();
      let stepPassed = false;
      let usedLocator = step.locator;
      let stepErrorMessage: string | undefined;

      // Strategy A: Execute using existing verified locator
      if (step.locator) {
        const action: TestAction = {
          id: step.action.id ?? crypto.randomUUID(),
          type: step.action.type,
          target_description: step.locator,
          value: step.value ?? step.action.value,
        };

        const res = await this.executor.execute(action, page, testCaseId);
        if (res.status === 'passed') {
          stepPassed = true;
        } else {
          stepErrorMessage = res.error_message;
          log.warn(
            { event: 'replay_step_locator_failed', order: step.order, locator: step.locator, error: res.error_message },
            `Direct locator "${step.locator}" failed on step ${step.order}`
          );
        }
      }

      // Strategy B: Fallback to GroundingEngine if direct locator failed or was not provided
      if (!stepPassed && this.groundingEngine && step.targetDescription) {
        log.info(
          { event: 'replay_step_grounding_fallback', order: step.order, target: step.targetDescription },
          `Attempting grounding fallback for step ${step.order}: "${step.targetDescription}"`
        );

        try {
          const obs = await this.observer.observe(page);
          const nlAction: TestAction = {
            id: step.action.id ?? crypto.randomUUID(),
            type: step.action.type,
            target_description: step.targetDescription,
            value: step.value ?? step.action.value,
          };

          const grounded = await this.groundingEngine.groundAction(nlAction, obs, page);
          if (grounded.success && grounded.action) {
            usedLocator = grounded.action.target_description;
            const retryRes = await this.executor.execute(grounded.action, page, testCaseId);
            if (retryRes.status === 'passed') {
              stepPassed = true;
              stepErrorMessage = undefined;
            } else {
              stepErrorMessage = retryRes.error_message;
            }
          } else {
            stepErrorMessage = `Grounding failed to resolve "${step.targetDescription}"`;
          }
        } catch (err) {
          stepErrorMessage = `Grounding error: ${String(err)}`;
        }
      }

      const durationMs = Date.now() - stepStart;
      stepResults.push({
        order: step.order,
        status: stepPassed ? 'passed' : 'failed',
        locator: usedLocator,
        durationMs,
        error: stepErrorMessage,
      });

      if (!stepPassed) {
        allStepsPassed = false;
        replayError = `Step ${step.order} (${step.action.type} "${step.targetDescription ?? step.locator}") failed: ${stepErrorMessage}`;
        log.error({ event: 'replay_step_failed', order: step.order, error: replayError }, replayError);
        break; // Stop execution on first failed step
      }

      if (stepDelayMs > 0) {
        await new Promise((r) => setTimeout(r, stepDelayMs));
      }
    }

    // 3. Evaluate Assertions if all steps succeeded
    let allAssertionsPassed = true;

    if (allStepsPassed && testCase.assertions.length > 0) {
      for (const assertion of testCase.assertions) {
        const res = await this.evaluateAssertion(assertion, page);
        assertionResults.push(res);
        if (!res.passed) {
          allAssertionsPassed = false;
          if (!replayError) {
            replayError = `Assertion failed: ${res.error}`;
          }
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const finalStatus: 'passed' | 'failed' = allStepsPassed && allAssertionsPassed ? 'passed' : 'failed';

    log.info(
      {
        event: 'replay_complete',
        testCaseId,
        status: finalStatus,
        stepsExecuted: stepResults.length,
        assertionsEvaluated: assertionResults.length,
        durationMs: totalDuration,
      },
      `Test replay ${finalStatus.toUpperCase()} (${totalDuration}ms)`
    );

    return {
      testCaseId,
      status: finalStatus,
      steps: stepResults,
      assertions: assertionResults,
      durationMs: totalDuration,
      error: replayError,
    };
  }

  // ─── Assertion Evaluator ───────────────────────────────────
  private async evaluateAssertion(assertion: TestAssertion, page: Page): Promise<AssertionResult> {
    try {
      switch (assertion.type) {
        case 'url_contains': {
          const currentUrl = page.url();
          const expected = assertion.expected ?? '';
          const passed = currentUrl.includes(expected);
          return {
            assertion,
            passed,
            actual: currentUrl,
            error: passed ? undefined : `Expected URL to contain "${expected}", but got "${currentUrl}"`,
          };
        }

        case 'element_visible': {
          const target = assertion.target!;
          const locator = page.locator(target);
          const isVisible = await locator.isVisible().catch(() => false);
          return {
            assertion,
            passed: isVisible,
            actual: isVisible ? 'visible' : 'hidden',
            error: isVisible ? undefined : `Expected element "${target}" to be visible, but it was not`,
          };
        }

        case 'element_text': {
          const target = assertion.target!;
          const expected = assertion.expected ?? '';
          const locator = page.locator(target);
          const isVisible = await locator.isVisible().catch(() => false);
          if (!isVisible) {
            return {
              assertion,
              passed: false,
              actual: 'element not visible',
              error: `Element "${target}" not visible for text verification`,
            };
          }
          const actualText = (await locator.textContent().catch(() => '')) ?? '';
          const passed = actualText.includes(expected);
          return {
            assertion,
            passed,
            actual: actualText.trim(),
            error: passed ? undefined : `Expected element "${target}" to contain "${expected}", got "${actualText.trim()}"`,
          };
        }

        case 'no_error': {
          // Check for visible error banner elements
          const errorEl = page.locator('#error-message, .error, [role="alert"]');
          const count = await errorEl.count().catch(() => 0);
          let hasVisibleError = false;
          let errorText = '';

          for (let i = 0; i < count; i++) {
            const el = errorEl.nth(i);
            if (await el.isVisible().catch(() => false)) {
              hasVisibleError = true;
              errorText = (await el.textContent().catch(() => '')) ?? '';
              break;
            }
          }

          return {
            assertion,
            passed: !hasVisibleError,
            actual: hasVisibleError ? `error displayed: "${errorText.trim()}"` : 'no errors',
            error: hasVisibleError ? `Found unexpected error message: "${errorText.trim()}"` : undefined,
          };
        }

        default:
          return {
            assertion,
            passed: false,
            error: `Unsupported assertion type: ${(assertion as any).type}`,
          };
      }
    } catch (err) {
      return {
        assertion,
        passed: false,
        error: `Assertion evaluation error: ${String(err)}`,
      };
    }
  }
}
