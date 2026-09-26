/**
 * M6 E2E Integration Tests – Test Generator & Replay on Real Chromium
 *
 * Uses REAL Chromium browser against demo-site/index.html.
 *
 * Scenarios:
 * E2E 1: Agent Login → Generate TestCase → Validate TestCase → Replay TestCase (all PASS)
 * E2E 2: Navigation to About → Generate TestCase → Replay TestCase (PASS)
 * E2E 3: Failed Agent Run → Generator rejects (no false-positive test case)
 * E2E 4: Serialization → Save JSON → Read JSON → Validate → Replay (PASS)
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
import { TestGenerator, TestGenerationError } from '../../src/generator/test-generator';
import { validateTestCase } from '../../src/generator/validator';
import { TestCaseReplayer } from '../../src/generator/replay';
import { TestCaseStorage } from '../../src/generator/storage';

const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

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

describe('M6 E2E: Test Generator & Replay on Demo Site (Real Chromium)', () => {
  let pageManager: PageManager;
  let observer: Observer;
  let executor: Executor;
  let groundingEngine: GroundingEngine;
  let generator: TestGenerator;
  let replayer: TestCaseReplayer;
  const tempDir = path.resolve(__dirname, '../../reports/test-cases/e2e-temp');

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
      enableLlmFallback: false,
    });

    generator = new TestGenerator();
    replayer = new TestCaseReplayer(executor, observer, groundingEngine);

    const page = await pageManager.launch();
    observer.attach(page);
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  });

  afterAll(async () => {
    observer.detach();
    await pageManager.close();

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── E2E 1: Login scenario ─────────────────────────────────────
  it('E2E 1: Agent Login → Generate TestCase → Validate TestCase → Replay TestCase', async () => {
    const page = pageManager.getPage();
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    // Step A: Agent performs login
    const planner = createScriptedPlanner([
      makeSemanticAction('fill', 'Enter email address', 'admin@example.com'),
      makeSemanticAction('fill', 'Enter password', 'password123'),
      makeSemanticAction('click', 'Click Login button'),
      'GOAL_ACHIEVED',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 10,
      stepDelayMs: 50,
    });

    const agentResult = await agent.run(
      'Login to the dashboard using admin@example.com and password123',
      page
    );

    expect(agentResult.status).toBe('completed');
    expect(agentResult.goalAchieved).toBe(true);

    // Step B: Generate TestCase
    const testCase = await generator.generate(agentResult);
    expect(testCase).toBeDefined();
    expect(testCase.steps).toHaveLength(3);

    // Verify grounded locators were preserved
    expect(testCase.steps[0].locator).toBe('#email');
    expect(testCase.steps[1].locator).toBe('#password');
    expect(testCase.steps[2].locator).toBe('#login-btn');

    // Verify values preserved
    expect(testCase.steps[0].value).toBe('admin@example.com');
    expect(testCase.steps[1].value).toBe('password123');

    // Verify evidence-based assertions
    expect(testCase.assertions.length).toBeGreaterThan(0);
    const hasDashboardAssertion = testCase.assertions.some(
      (a) => a.expected === '#dashboard' || a.target === '#dashboard-page'
    );
    expect(hasDashboardAssertion).toBe(true);

    // Step C: Validate TestCase
    const validation = validateTestCase(testCase);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // Step D: Replay TestCase on Chromium
    // Reset page back to login page
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
    expect(await page.title()).toBe('Demo Site – Web Test Agent');

    const replayResult = await replayer.replay(testCase, page, { stepDelayMs: 50 });

    expect(replayResult.status).toBe('passed');
    expect(replayResult.steps).toHaveLength(3);
    expect(replayResult.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(replayResult.assertions.length).toBeGreaterThan(0);
    expect(replayResult.assertions.every((a) => a.passed)).toBe(true);

    // Browser is now on dashboard
    expect(await page.title()).toBe('Dashboard – Web Test Agent');
  });

  // ── E2E 2: Navigation to About page ──────────────────────────
  it('E2E 2: Navigation to About → Generate TestCase → Replay TestCase', async () => {
    const page = pageManager.getPage();

    // Page is on Dashboard. Agent clicks About link
    const planner = createScriptedPlanner([
      makeSemanticAction('click', 'About link'),
      'GOAL_ACHIEVED',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 5,
      stepDelayMs: 50,
    });

    const agentResult = await agent.run('Open the About page', page);
    expect(agentResult.status).toBe('completed');
    expect(agentResult.goalAchieved).toBe(true);

    // Generate TestCase
    const testCase = await generator.generate(agentResult);
    expect(testCase).toBeDefined();
    expect(testCase.steps).toHaveLength(1);
    expect(testCase.steps[0].locator).toBe('#about-link');

    // Verify assertion
    expect(testCase.assertions.some((a) => a.expected === '#about' || a.target === '#about-section')).toBe(true);

    // Validate
    const validation = validateTestCase(testCase);
    expect(validation.valid).toBe(true);

    // Replay
    const replayResult = await replayer.replay(testCase, page, { stepDelayMs: 50 });
    expect(replayResult.status).toBe('passed');
    expect(replayResult.steps[0].status).toBe('passed');
    expect(replayResult.assertions.every((a) => a.passed)).toBe(true);
  });

  // ── E2E 3: Failed Agent Run ──────────────────────────────────
  it('E2E 3: Failed Agent Run does NOT produce a false-positive TestCase', async () => {
    const page = pageManager.getPage();

    const planner = createScriptedPlanner([
      makeSemanticAction('click', 'Delete Account Forever button'),
      'NO_ACTION',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 3,
      maxGroundingFailures: 1,
      stepDelayMs: 50,
    });

    const agentResult = await agent.run('Click the Delete Account Forever button', page);
    expect(agentResult.status).toBe('failed');
    expect(agentResult.goalAchieved).toBe(false);

    // Generator must reject
    expect(generator.canGenerate(agentResult)).toBe(false);
    await expect(generator.generate(agentResult)).rejects.toThrow(TestGenerationError);
  });

  // ── E2E 4: Serialization & Replay ────────────────────────────
  it('E2E 4: Generate → Save JSON → Read JSON → Validate → Replay', async () => {
    const page = pageManager.getPage();
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    // Step 1: Agent Login
    const planner = createScriptedPlanner([
      makeSemanticAction('fill', 'Enter email address', 'admin@example.com'),
      makeSemanticAction('fill', 'Enter password', 'password123'),
      makeSemanticAction('click', 'Click Login button'),
      'GOAL_ACHIEVED',
    ]);

    const agent = new Agent(observer, planner, groundingEngine, executor, {
      maxSteps: 10,
      stepDelayMs: 50,
    });

    const agentResult = await agent.run('Login and save test case', page);
    expect(agentResult.status).toBe('completed');

    // Step 2: Generate TestCase
    const testCase = await generator.generate(agentResult);

    // Step 3: Save to JSON
    const storage = new TestCaseStorage(tempDir);
    const savedPath = await storage.save(testCase);
    expect(fs.existsSync(savedPath)).toBe(true);

    // Step 4: Read from JSON
    const loadedTestCase = await storage.load(savedPath);
    expect(loadedTestCase.id).toBe(testCase.id);
    expect(loadedTestCase.steps).toHaveLength(testCase.steps.length);

    // Step 5: Validate loaded TestCase
    const validation = validateTestCase(loadedTestCase);
    expect(validation.valid).toBe(true);

    // Step 6: Replay loaded TestCase
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
    const replayResult = await replayer.replay(loadedTestCase, page, { stepDelayMs: 50 });

    expect(replayResult.status).toBe('passed');
    expect(replayResult.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(replayResult.assertions.every((a) => a.passed)).toBe(true);
  });
});
