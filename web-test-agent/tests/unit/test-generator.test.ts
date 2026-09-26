/**
 * M6 Unit Tests – TestGenerator Suite
 *
 * Validates:
 * 1. Generating TestCase from successful AgentRun
 * 2. Step conversion and order
 * 3. Preservation of grounded locators
 * 4. Preservation of action values
 * 5. Assertion generation from evidence (URL hash, title, visible elements)
 * 6. Missing evidence results in no guessed assertions
 * 7. Rejection of failed or incomplete AgentRun (no false positives)
 * 8. Rejection of empty execution history
 * 9. Normalization and removal of redundant retry steps
 * 10. LLM enhancement with valid JSON
 * 11. LLM failure/invalid JSON fallback gracefully
 * 12. Serialization & Deserialization with TestCaseStorage
 * 13. Formatter output verification
 */

import * as fs from 'fs';
import * as path from 'path';
import { TestGenerator, TestGenerationError } from '../../src/generator/test-generator';
import { normalizeTestCase } from '../../src/generator/normalizer';
import { TestCaseStorage } from '../../src/generator/storage';
import { formatTestCase, formatReplayResult } from '../../src/generator/formatter';
import { AgentRunResult, AgentStep } from '../../src/agent/types';
import { Observation } from '../../src/observer/types';
import { LLMClient, LLMResponse } from '../../src/llm/types';

function makeMockObservation(url = 'https://app.test/login', title = 'Login', elementIds: string[] = ['email', 'password', 'login-btn']): Observation {
  return {
    page: {
      url,
      title,
      dom: '<html><body></body></html>',
    },
    elements: elementIds.map((id) => ({
      tag: id.includes('btn') ? 'button' : 'input',
      id,
      text: id,
      type: id === 'password' ? 'password' : 'text',
    })),
    network: [],
    console: [],
    captured_at: new Date().toISOString(),
  };
}

function makeMockStep(
  stepNumber: number,
  type: 'click' | 'fill',
  target: string,
  groundedLocator?: string,
  value?: string,
  status: 'success' | 'failed' = 'success'
): AgentStep {
  return {
    stepNumber,
    observation: makeMockObservation(),
    plannedAction: {
      id: crypto.randomUUID(),
      type,
      target_description: target,
      value,
    },
    groundedAction: groundedLocator
      ? {
          id: crypto.randomUUID(),
          type,
          target_description: groundedLocator,
          value,
        }
      : undefined,
    durationMs: 40,
    status,
  };
}

function makeSuccessfulLoginRun(): AgentRunResult {
  const finalObs = makeMockObservation(
    'https://app.test/demo#dashboard',
    'Dashboard – Web Test Agent',
    ['dashboard-page', 'decrement-btn', 'increment-btn', 'about-link']
  );

  return {
    status: 'completed',
    terminationReason: 'goal_achieved',
    goal: 'Login to the dashboard using admin@example.com and password123',
    stepCount: 3,
    durationMs: 1200,
    goalAchieved: true,
    finalObservation: finalObs,
    history: [
      makeMockStep(1, 'fill', 'Enter email address', '#email', 'admin@example.com'),
      makeMockStep(2, 'fill', 'Enter password', '#password', 'password123'),
      makeMockStep(3, 'click', 'Click Login button', '#login-btn'),
    ],
  };
}

describe('M6 Unit: TestGenerator', () => {
  it('1. should generate a valid TestCase from a successful AgentRun', async () => {
    const generator = new TestGenerator();
    const runResult = makeSuccessfulLoginRun();

    const tc = await generator.generate(runResult);

    expect(tc).toBeDefined();
    expect(tc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tc.name).toBeDefined();
    expect(tc.startUrl).toBe('https://app.test/login');
    expect(tc.steps).toHaveLength(3);
    expect(tc.metadata.agentGoal).toBe(runResult.goal);
    expect(tc.metadata.stepCount).toBe(3);
  });

  it('2. should preserve grounded locators in test steps', async () => {
    const generator = new TestGenerator();
    const runResult = makeSuccessfulLoginRun();

    const tc = await generator.generate(runResult);

    expect(tc.steps[0].locator).toBe('#email');
    expect(tc.steps[1].locator).toBe('#password');
    expect(tc.steps[2].locator).toBe('#login-btn');
  });

  it('3. should preserve action values in test steps', async () => {
    const generator = new TestGenerator();
    const runResult = makeSuccessfulLoginRun();

    const tc = await generator.generate(runResult);

    expect(tc.steps[0].value).toBe('admin@example.com');
    expect(tc.steps[1].value).toBe('password123');
    expect(tc.steps[2].value).toBeUndefined();
  });

  it('4. should generate evidence-based assertions (URL hash and visible element)', async () => {
    const generator = new TestGenerator();
    const runResult = makeSuccessfulLoginRun();

    const tc = await generator.generate(runResult);

    // Final URL was https://app.test/demo#dashboard
    const urlAssertion = tc.assertions.find((a) => a.type === 'url_contains');
    expect(urlAssertion).toBeDefined();
    expect(urlAssertion!.expected).toBe('#dashboard');

    // Dashboard element was in final observation
    const visAssertion = tc.assertions.find((a) => a.type === 'element_visible');
    expect(visAssertion).toBeDefined();
    expect(visAssertion!.target).toBe('#dashboard-page');
  });

  it('5. should produce empty assertions if there is no evidence', async () => {
    const generator = new TestGenerator();
    const runResult = makeSuccessfulLoginRun();

    // Final observation has no hash and unrelated elements
    runResult.finalObservation = makeMockObservation('https://app.test/page', 'Some Page', ['other-element']);
    runResult.goal = 'Some generic goal';

    const tc = await generator.generate(runResult);
    expect(tc.assertions).toEqual([]);
  });

  it('6. should reject a failed AgentRun and throw TestGenerationError', async () => {
    const generator = new TestGenerator();
    const failedRun: AgentRunResult = {
      status: 'failed',
      terminationReason: 'grounding_failed',
      goal: 'Click Delete Account Forever button',
      stepCount: 1,
      durationMs: 100,
      goalAchieved: false,
      finalObservation: null,
      history: [makeMockStep(1, 'click', 'Delete Account Forever', undefined, undefined, 'failed')],
    };

    expect(generator.canGenerate(failedRun)).toBe(false);

    await expect(generator.generate(failedRun)).rejects.toThrow(TestGenerationError);
    await expect(generator.generate(failedRun)).rejects.toThrow(/Cannot generate test case from failed/);
  });

  it('7. should reject an empty execution history', async () => {
    const generator = new TestGenerator();
    const emptyRun: AgentRunResult = {
      status: 'completed',
      terminationReason: 'goal_achieved',
      goal: 'Do nothing',
      stepCount: 0,
      durationMs: 10,
      goalAchieved: true,
      finalObservation: null,
      history: [],
    };

    expect(generator.canGenerate(emptyRun)).toBe(false);
    await expect(generator.generate(emptyRun)).rejects.toThrow(/empty/);
  });

  it('8. should normalize and remove consecutive duplicate retry steps', () => {
    const run = makeSuccessfulLoginRun();
    // Add a duplicate retry of fill email
    const duplicateStep = makeMockStep(2, 'fill', 'Enter email address', '#email', 'admin@example.com');
    const rawTc = {
      id: crypto.randomUUID(),
      name: 'Duplicate test',
      description: 'desc',
      startUrl: 'https://app.test/login',
      preconditions: ['ok'],
      steps: [
        {
          order: 1,
          action: { id: crypto.randomUUID(), type: 'fill' as const, target_description: '#email', value: 'admin@example.com' },
          locator: '#email',
          value: 'admin@example.com',
        },
        {
          order: 2,
          action: { id: crypto.randomUUID(), type: 'fill' as const, target_description: '#email', value: 'admin@example.com' },
          locator: '#email',
          value: 'admin@example.com',
        },
        {
          order: 3,
          action: { id: crypto.randomUUID(), type: 'click' as const, target_description: '#login-btn' },
          locator: '#login-btn',
        },
      ],
      assertions: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        agentGoal: 'goal',
        stepCount: 3,
        durationMs: 100,
        framework: 'playwright',
        tags: [],
      },
    };

    const normalized = normalizeTestCase(rawTc, { removeDuplicateSteps: true });
    expect(normalized.steps).toHaveLength(2);
    expect(normalized.steps[0].order).toBe(1);
    expect(normalized.steps[1].order).toBe(2);
    expect(normalized.steps[1].locator).toBe('#login-btn');
  });

  it('9. should enhance TestCase documentation when LLM is provided', async () => {
    const mockLlm: LLMClient = {
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          name: 'Enhanced Admin Login',
          description: 'A thoroughly documented test for admin authentication.',
          preconditions: ['User database seeded'],
          stepOutcomes: [
            'Input admin email address',
            'Input admin password securely',
            'Submit login form',
          ],
        }),
        model: 'mock',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: 'end_turn',
      }),
    };

    const generator = new TestGenerator(mockLlm);
    const tc = await generator.generate(makeSuccessfulLoginRun());

    expect(tc.name).toBe('Enhanced Admin Login');
    expect(tc.description).toBe('A thoroughly documented test for admin authentication.');
    expect(tc.preconditions).toContain('User database seeded');
    expect(tc.steps[0].expectedOutcome).toBe('Input admin email address');
  });

  it('10. should fall back gracefully if LLM returns malformed JSON or throws', async () => {
    const mockLlm: LLMClient = {
      complete: jest.fn().mockResolvedValue({
        content: 'This is not JSON at all! {broken',
        model: 'mock',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        stopReason: 'end_turn',
      }),
    };

    const generator = new TestGenerator(mockLlm);
    // Should NOT throw, should fall back to deterministic name & description
    const tc = await generator.generate(makeSuccessfulLoginRun());

    expect(tc).toBeDefined();
    expect(tc.name).toBeDefined();
    expect(tc.steps).toHaveLength(3);
  });

  it('11. should save and load TestCase via TestCaseStorage (JSON persistence)', async () => {
    const generator = new TestGenerator();
    const tc = await generator.generate(makeSuccessfulLoginRun());

    const testDir = path.resolve(__dirname, '../../reports/test-cases/test-temp');
    const storage = new TestCaseStorage(testDir);

    const savedPath = await storage.save(tc);
    expect(fs.existsSync(savedPath)).toBe(true);

    const loaded = await storage.load(savedPath);
    expect(loaded.id).toBe(tc.id);
    expect(loaded.name).toBe(tc.name);
    expect(loaded.steps).toHaveLength(tc.steps.length);
    expect(loaded.assertions).toHaveLength(tc.assertions.length);

    // Clean up
    await storage.delete(savedPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('12. should format TestCase into human-readable text', async () => {
    const generator = new TestGenerator();
    const tc = await generator.generate(makeSuccessfulLoginRun());

    const formatted = formatTestCase(tc);
    expect(formatted).toContain('TEST CASE:');
    expect(formatted).toContain('STEPS:');
    expect(formatted).toContain('1. Fill "Enter email address" with "admin@example.com"');
    expect(formatted).toContain('ASSERTIONS:');
    expect(formatted).toContain('RESULT:');
    expect(formatted).toContain('Generated successfully');
  });
});
