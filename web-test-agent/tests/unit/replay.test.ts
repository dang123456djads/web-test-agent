/**
 * M6 Unit Tests – TestCaseReplayer Suite
 *
 * Validates replay behavior with mocked dependencies:
 * 1. Successful replay of all steps and assertions
 * 2. Step failure stops replay and reports status='failed'
 * 3. Fallback to GroundingEngine when direct locator fails
 * 4. Assertion evaluation (url_contains, element_visible, element_text, no_error)
 * 5. Assertion failure marks test as failed
 * 6. Navigation failure handling
 */

import { Page } from 'playwright';
import { TestCaseReplayer } from '../../src/generator/replay';
import { TestCase } from '../../src/generator/types';
import { Executor } from '../../src/executor/executor';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { ExecutionResult } from '../../src/models/schemas';
import { Observation } from '../../src/observer/types';

function makeMockTestCase(): TestCase {
  return {
    id: 'a0000000-0000-0000-0000-000000000001',
    name: 'Sample Test Case',
    description: 'Sample description',
    startUrl: 'https://example.com/app',
    preconditions: [],
    steps: [
      {
        order: 1,
        action: {
          id: 'b0000000-0000-0000-0000-000000000001',
          type: 'fill',
          target_description: '#email',
          value: 'user@test.com',
        },
        locator: '#email',
        targetDescription: 'Email field',
        value: 'user@test.com',
      },
      {
        order: 2,
        action: {
          id: 'b0000000-0000-0000-0000-000000000002',
          type: 'click',
          target_description: '#login-btn',
        },
        locator: '#login-btn',
        targetDescription: 'Login button',
      },
    ],
    assertions: [
      {
        type: 'url_contains',
        expected: '#dashboard',
        description: 'Check dashboard URL',
      },
      {
        type: 'element_visible',
        target: '#dashboard-page',
        description: 'Check dashboard visible',
      },
    ],
    metadata: {
      generatedAt: '2026-09-26T12:00:00.000Z',
      agentGoal: 'Sample goal',
      stepCount: 2,
      durationMs: 500,
      framework: 'playwright',
      tags: [],
    },
  };
}

describe('M6 Unit: TestCaseReplayer', () => {
  let mockPage: jest.Mocked<Page>;
  let mockExecutor: jest.Mocked<Executor>;
  let mockObserver: jest.Mocked<Observer>;
  let mockGroundingEngine: jest.Mocked<GroundingEngine>;

  beforeEach(() => {
    mockPage = {
      url: jest.fn().mockReturnValue('https://example.com/app#dashboard'),
      goto: jest.fn().mockResolvedValue(null as any),
      locator: jest.fn().mockReturnValue({
        isVisible: jest.fn().mockResolvedValue(true),
        textContent: jest.fn().mockResolvedValue('Dashboard text'),
        count: jest.fn().mockResolvedValue(0),
      } as any),
    } as unknown as jest.Mocked<Page>;

    mockExecutor = {
      execute: jest.fn().mockResolvedValue({
        action_id: 'b0000000-0000-0000-0000-000000000001',
        test_case_id: 'a0000000-0000-0000-0000-000000000001',
        status: 'passed',
        duration_ms: 25,
        executed_at: new Date().toISOString(),
      } as ExecutionResult),
    } as unknown as jest.Mocked<Executor>;

    mockObserver = {
      observe: jest.fn().mockResolvedValue({
        page: { url: 'https://example.com/app', title: 'App', dom: '<html></html>' },
        elements: [],
        network: [],
        console: [],
        captured_at: new Date().toISOString(),
      } as Observation),
    } as unknown as jest.Mocked<Observer>;

    mockGroundingEngine = {
      groundAction: jest.fn().mockResolvedValue({
        success: true,
        action: {
          id: 'b0000000-0000-0000-0000-000000000002',
          type: 'click',
          target_description: '#resolved-btn',
        },
      } as any),
    } as unknown as jest.Mocked<GroundingEngine>;
  });

  it('1. should successfully replay all steps and assertions', async () => {
    const replayer = new TestCaseReplayer(mockExecutor, mockObserver, mockGroundingEngine);
    const tc = makeMockTestCase();

    const result = await replayer.replay(tc, mockPage, { stepDelayMs: 0 });

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].status).toBe('passed');
    expect(result.steps[1].status).toBe('passed');
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0].passed).toBe(true);
    expect(result.assertions[1].passed).toBe(true);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
  });

  it('2. should stop and report failure when a step fails without grounding fallback', async () => {
    const replayer = new TestCaseReplayer(mockExecutor, mockObserver); // No grounding engine
    const tc = makeMockTestCase();

    // Step 1 fails
    mockExecutor.execute.mockResolvedValueOnce({
      action_id: 'b0000000-0000-0000-0000-000000000001',
      test_case_id: 'a0000000-0000-0000-0000-000000000001',
      status: 'failed',
      error_message: 'Element not found',
      duration_ms: 30,
      executed_at: new Date().toISOString(),
    });

    const result = await replayer.replay(tc, mockPage, { stepDelayMs: 0 });

    expect(result.status).toBe('failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('failed');
    expect(result.error).toContain('failed: Element not found');
    // Step 2 should not have been executed
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('3. should fall back to GroundingEngine when direct locator fails', async () => {
    const replayer = new TestCaseReplayer(mockExecutor, mockObserver, mockGroundingEngine);
    const tc = makeMockTestCase();

    // Step 1 direct execution fails, but retry with grounded action passes
    mockExecutor.execute
      .mockResolvedValueOnce({
        action_id: 'b0000000-0000-0000-0000-000000000001',
        test_case_id: 'a0000000-0000-0000-0000-000000000001',
        status: 'failed',
        error_message: 'Stale locator #email',
        duration_ms: 20,
        executed_at: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        action_id: 'b0000000-0000-0000-0000-000000000001',
        test_case_id: 'a0000000-0000-0000-0000-000000000001',
        status: 'passed',
        duration_ms: 25,
        executed_at: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        action_id: 'b0000000-0000-0000-0000-000000000002',
        test_case_id: 'a0000000-0000-0000-0000-000000000001',
        status: 'passed',
        duration_ms: 20,
        executed_at: new Date().toISOString(),
      });

    const result = await replayer.replay(tc, mockPage, { stepDelayMs: 0 });

    expect(mockGroundingEngine.groundAction).toHaveBeenCalled();
    expect(result.status).toBe('passed');
    expect(result.steps[0].status).toBe('passed');
  });

  it('4. should fail replay when an assertion fails', async () => {
    const replayer = new TestCaseReplayer(mockExecutor, mockObserver, mockGroundingEngine);
    const tc = makeMockTestCase();

    // URL does NOT contain #dashboard
    mockPage.url.mockReturnValue('https://example.com/app#login');

    const result = await replayer.replay(tc, mockPage, { stepDelayMs: 0 });

    expect(result.status).toBe('failed');
    expect(result.assertions[0].passed).toBe(false);
    expect(result.error).toContain('Expected URL to contain "#dashboard"');
  });

  it('5. should handle navigation failure to startUrl gracefully', async () => {
    const replayer = new TestCaseReplayer(mockExecutor, mockObserver);
    const tc = makeMockTestCase();

    mockPage.url.mockReturnValue('about:blank');
    mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));

    const result = await replayer.replay(tc, mockPage, { stepDelayMs: 0 });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Navigation to startUrl failed');
    expect(result.steps).toHaveLength(0);
  });
});
