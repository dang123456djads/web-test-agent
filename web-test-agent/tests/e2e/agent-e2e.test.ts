/**
 * M5 E2E Integration Tests – Agent on Real Chromium
 *
 * Uses REAL Chromium browser, but mocks the LLM (Planner) to avoid calling
 * the real Anthropic API. All other components (Observer, GroundingEngine,
 * Executor) are real and run against demo-site/index.html.
 *
 * Scenarios:
 * E2E 1: Login to dashboard – full pipeline: observe→plan→ground→execute→complete
 * E2E 2: Navigate to About page
 * E2E 3: Click non-existent "Delete Account Forever" button – Agent fails gracefully
 * E2E 4: maxSteps protection – Agent stops safely without infinite loop
 */

import * as path from 'path';
import * as fs from 'fs';
import { PageManager } from '../../src/executor/page-manager';
import { Executor } from '../../src/executor/executor';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { Agent } from '../../src/agent/agent';
import { Planner } from '../../src/agent/planner';
import { LLMClient, LLMResponse } from '../../src/llm/types';
import { TestAction } from '../../src/models/schemas';
import { PlannerResponse } from '../../src/agent/types';
import { Observation } from '../../src/observer/types';

const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

// ─── Helpers ──────────────────────────────────────────────────
function makeSemanticAction(
  type: TestAction['type'],
  target: string,
  value?: string
): TestAction {
  return {
    id: crypto.randomUUID(),
    type,
    target_description: target,
    value,
  };
}

/**
 * Create a scripted LLM mock that returns planned actions in sequence,
 * then signals goalAchieved once the sequence is exhausted.
 * This lets E2E tests drive a real browser without a real LLM.
 */
function createScriptedPlanner(sequence: Array<TestAction | 'GOAL_ACHIEVED' | 'NO_ACTION'>): Planner {
  let callIndex = 0;

  const mockLlm: LLMClient = {
    complete: jest.fn().mockImplementation(async (): Promise<LLMResponse> => {
      const item = sequence[callIndex] ?? 'GOAL_ACHIEVED';
      callIndex++;

      let response: PlannerResponse;
      if (item === 'GOAL_ACHIEVED') {
        response = { nextAction: null, reasoning: 'Goal achieved', goalAchieved: true };
      } else if (item === 'NO_ACTION') {
        response = { nextAction: null, reasoning: 'Cannot progress', goalAchieved: false };
      } else {
        response = { nextAction: item, reasoning: `Execute: ${item.type}`, goalAchieved: false };
      }

      return {
        content: JSON.stringify(response),
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: 'end_turn',
      };
    }),
  };

  return new Planner(mockLlm);
}

// ─── Test Suite ───────────────────────────────────────────────
describe('M5 E2E: Agent on Demo Site (Real Chromium + Mocked LLM)', () => {
  let pageManager: PageManager;
  let observer: Observer;
  let executor: Executor;
  let groundingEngine: GroundingEngine;

  beforeAll(async () => {
    expect(fs.existsSync(DEMO_SITE_PATH)).toBe(true);

    pageManager = new PageManager({
      headless: true,
      viewport: { width: 1280, height: 720 },
    });

    executor = new Executor({
      timeoutMs: 8000,
      retryCount: 1,
    });

    observer = new Observer();
    groundingEngine = new GroundingEngine({
      confidenceThreshold: 0.70,
      ambiguityThreshold: 0.15,
      enableLlmFallback: false, // No real LLM
    });

    const page = await pageManager.launch();
    observer.attach(page);
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  });

  afterAll(async () => {
    observer.detach();
    await pageManager.close();
  });

  // ── E2E 1: Login scenario ─────────────────────────────────────
  it('E2E 1: should login to dashboard using full observe→plan→ground→execute pipeline', async () => {
    const page = pageManager.getPage();
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    // Scripted plan: fill email → fill password → click login → signal complete
    const planner = createScriptedPlanner([
      makeSemanticAction('fill', 'Enter email address', 'admin@example.com'),
      makeSemanticAction('fill', 'Enter password', 'password123'),
      makeSemanticAction('click', 'Click Login button'),
      'GOAL_ACHIEVED',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 10,
      stepDelayMs: 100,
    });

    const result = await agent.run(
      'Login to the dashboard using admin@example.com and password123',
      page
    );

    // Verify agent completed successfully
    expect(result.status).toBe('completed');
    expect(result.goalAchieved).toBe(true);
    expect(result.terminationReason).toBe('goal_achieved');

    // Verify execution history
    expect(result.history).toHaveLength(3); // fill email, fill password, click login
    expect(result.history[0].status).toBe('success');
    expect(result.history[1].status).toBe('success');
    expect(result.history[2].status).toBe('success');

    // Verify browser actually navigated to dashboard
    const title = await page.title();
    expect(title).toBe('Dashboard – Web Test Agent');

    // Verify all steps have valid metadata
    for (const step of result.history) {
      expect(step.stepNumber).toBeGreaterThan(0);
      expect(step.observation).toBeDefined();
      expect(step.plannedAction).toBeDefined();
      expect(step.groundedAction).toBeDefined();
      expect(step.executionResult).toBeDefined();
      expect(step.executionResult!.status).toBe('passed');
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }

    expect(result.durationMs).toBeGreaterThan(0);
  });

  // ── E2E 2: Navigation to About page ──────────────────────────
  it('E2E 2: should open the About page after logging in', async () => {
    const page = pageManager.getPage();

    // Page is on Dashboard from E2E 1. Plan: click About link → signal complete
    const planner = createScriptedPlanner([
      makeSemanticAction('click', 'About link'),
      'GOAL_ACHIEVED',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 5,
      stepDelayMs: 100,
    });

    const result = await agent.run('Open the About page', page);

    expect(result.status).toBe('completed');
    expect(result.goalAchieved).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].status).toBe('success');

    // Browser should now show About section
    const title = await page.title();
    expect(title).toContain('About');
  });

  // ── E2E 3: Failure scenario (non-existent element) ────────────
  it('E2E 3: should handle non-existent element gracefully without crashing', async () => {
    const page = pageManager.getPage();

    // Plan: try to click a non-existent element
    const planner = createScriptedPlanner([
      makeSemanticAction('click', 'Delete Account Forever button'),
      'NO_ACTION', // After grounding failure, planner gives up
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 5,
      maxGroundingFailures: 1, // Stop after 1 grounding failure
      stepDelayMs: 50,
    });

    const result = await agent.run(
      'Click the Delete Account Forever button',
      page
    );

    // Agent should NOT crash, and should fail gracefully
    expect(result).toBeDefined();
    expect(result.status).toBe('failed');
    expect(result.goalAchieved).toBe(false);
    expect(result.history.length).toBeGreaterThanOrEqual(1);

    const failedStep = result.history.find((s) => s.status === 'failed');
    expect(failedStep).toBeDefined();
    expect(failedStep!.error).toBeDefined();
  });

  // ── E2E 4: maxSteps enforcement ───────────────────────────────
  it('E2E 4: should stop safely after maxSteps without looping infinitely', async () => {
    const page = pageManager.getPage();

    // Planner always returns an action but never signals complete
    // (Each step succeeds but there's always a "next" action planned)
    const planner = createScriptedPlanner([
      makeSemanticAction('click', 'About link'),
      makeSemanticAction('click', 'Settings link'),
      makeSemanticAction('click', 'About link'),
      makeSemanticAction('click', 'Settings link'),
      makeSemanticAction('click', 'About link'),
      // No GOAL_ACHIEVED → agent will hit maxSteps
    ]);

    const MAX = 3;
    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: MAX,
      stepDelayMs: 50,
    });

    const startTime = Date.now();
    const result = await agent.run('Click forever', page);
    const elapsed = Date.now() - startTime;

    // Agent must stop, not loop forever
    expect(result.status).toBe('stopped');
    expect(result.terminationReason).toBe('max_steps_reached');
    expect(result.stepCount).toBeLessThanOrEqual(MAX);
    // Should complete in reasonable time (< 30 seconds)
    expect(elapsed).toBeLessThan(30_000);
  });
});
