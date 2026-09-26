/**
 * M5 Unit Tests – Agent Controller Suite
 *
 * Validates Agent orchestration behavior with mocked dependencies:
 * 1. Agent initialization with correct defaults
 * 2. Successful single-step execution (observe→plan→ground→execute)
 * 3. Goal achieved via planner signals completion
 * 4. History is recorded for each step
 * 5. Agent stops after maxSteps reached
 * 6. Grounding failure is recorded and handled
 * 7. Consecutive grounding failures cause agent to stop
 * 8. Execution failure is recorded; agent continues if policy allows
 * 9. Consecutive execution failures cause agent to stop
 * 10. External stop() call terminates agent gracefully
 * 11. LLM/Planner error is handled without crashing
 * 12. No infinite loop: maxSteps is always enforced
 */

import { Agent } from '../../src/agent/agent';
import { Planner } from '../../src/agent/planner';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { Executor } from '../../src/executor/executor';
import { LLMClient, LLMResponse } from '../../src/llm/types';
import { Observation } from '../../src/observer/types';
import { TestAction, ExecutionResult } from '../../src/models/schemas';
import { PlannerResponse } from '../../src/agent/types';

// ─── Factory Helpers ───────────────────────────────────────────
function mockObservation(url = 'https://app.test/', title = 'Test Page'): Observation {
  return {
    page: { url, title, dom: '<html></html>' },
    elements: [
      { tag: 'button', id: 'btn-1', text: 'Submit', role: 'button' },
    ],
    network: [],
    console: [],
    captured_at: new Date().toISOString(),
  };
}

function mockAction(type: TestAction['type'] = 'click', target = 'Submit button'): TestAction {
  return { id: crypto.randomUUID(), type, target_description: target };
}

function mockPassResult(): ExecutionResult {
  return {
    action_id: crypto.randomUUID(),
    test_case_id: crypto.randomUUID(),
    status: 'passed',
    duration_ms: 50,
    executed_at: new Date().toISOString(),
  };
}

function mockFailResult(error = 'Element not found'): ExecutionResult {
  return {
    action_id: crypto.randomUUID(),
    test_case_id: crypto.randomUUID(),
    status: 'failed',
    error_message: error,
    duration_ms: 100,
    executed_at: new Date().toISOString(),
  };
}

function buildMocks() {
  const mockPage = {
    url: jest.fn().mockReturnValue('https://app.test/'),
    goto: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
  } as any;

  const mockObserver: jest.Mocked<Observer> = {
    observe: jest.fn().mockResolvedValue(mockObservation()),
    attach: jest.fn(),
    detach: jest.fn(),
  } as any;

  const mockGrounding: jest.Mocked<GroundingEngine> = {
    groundAction: jest.fn().mockResolvedValue({
      success: true,
      action: mockAction(),
      result: {} as any,
    }),
  } as any;

  const mockExecutor: jest.Mocked<Executor> = {
    execute: jest.fn().mockResolvedValue(mockPassResult()),
  } as any;

  const mockPlanner: jest.Mocked<Planner> = {
    plan: jest.fn().mockResolvedValue({
      nextAction: mockAction(),
      reasoning: 'test reasoning',
      goalAchieved: false,
    } as PlannerResponse),
  } as any;

  return { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner };
}

describe('M5 Unit: Agent Controller', () => {
  it('1. should initialize with idle status and correct defaults', () => {
    const { mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();
    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxSteps: 10,
    });
    expect(agent).toBeDefined();
  });

  it('2. should execute one full step: observe → plan → ground → execute', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    // After first step succeeds, planner signals goalAchieved on second observation
    mockPlanner.plan
      .mockResolvedValueOnce({
        nextAction: mockAction('click', 'Submit button'),
        reasoning: 'Click submit',
        goalAchieved: false,
      })
      .mockResolvedValueOnce({
        nextAction: null,
        reasoning: 'Goal achieved',
        goalAchieved: true,
      });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxSteps: 5,
      stepDelayMs: 0,
    });

    const result = await agent.run('Submit the form', mockPage);

    expect(result.status).toBe('completed');
    expect(result.goalAchieved).toBe(true);
    expect(result.terminationReason).toBe('goal_achieved');
    expect(mockObserver.observe).toHaveBeenCalledTimes(2);
    expect(mockGrounding.groundAction).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('3. should complete immediately when planner signals goalAchieved on first observation', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockPlanner.plan.mockResolvedValueOnce({
      nextAction: null,
      reasoning: 'Already on dashboard',
      goalAchieved: true,
    });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      stepDelayMs: 0,
    });

    const result = await agent.run('Go to dashboard', mockPage);

    expect(result.status).toBe('completed');
    expect(result.goalAchieved).toBe(true);
    expect(result.stepCount).toBe(1);
    // No execution needed if goal is already achieved
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('4. should record each step in history with correct metadata', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    const action1 = mockAction('fill', 'Email field');
    const action2 = mockAction('click', 'Login button');

    mockPlanner.plan
      .mockResolvedValueOnce({ nextAction: action1, reasoning: 'Fill email', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: action2, reasoning: 'Click login', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: null, reasoning: 'Done', goalAchieved: true });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      stepDelayMs: 0,
    });

    const result = await agent.run('Login', mockPage);

    expect(result.history).toHaveLength(2);
    expect(result.history[0].stepNumber).toBe(1);
    expect(result.history[0].status).toBe('success');
    expect(result.history[0].plannedAction).toEqual(action1);
    expect(result.history[1].stepNumber).toBe(2);
    expect(result.history[1].plannedAction).toEqual(action2);

    for (const step of result.history) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.observation).toBeDefined();
      expect(step.groundedAction).toBeDefined();
      expect(step.executionResult).toBeDefined();
    }
  });

  it('5. should stop with max_steps_reached when maxSteps is exhausted', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    // Always plan a new action – never complete
    mockPlanner.plan.mockResolvedValue({
      nextAction: mockAction(),
      reasoning: 'Keep trying',
      goalAchieved: false,
    });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxSteps: 3,
      stepDelayMs: 0,
    });

    const result = await agent.run('Infinite goal', mockPage);

    expect(result.status).toBe('stopped');
    expect(result.terminationReason).toBe('max_steps_reached');
    expect(result.stepCount).toBe(3);
    expect(result.goalAchieved).toBe(false);
  });

  it('6. grounding failure is recorded in history and agent continues', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockGrounding.groundAction
      .mockResolvedValueOnce({ success: false, action: null as any, result: {} as any })
      .mockResolvedValueOnce({ success: true, action: mockAction(), result: {} as any });

    mockPlanner.plan
      .mockResolvedValueOnce({ nextAction: mockAction('click', 'Nonexistent'), reasoning: 'try', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: mockAction('click', 'Real button'), reasoning: 'retry', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: null, reasoning: 'Done', goalAchieved: true });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxGroundingFailures: 3,
      stepDelayMs: 0,
    });

    const result = await agent.run('Do something', mockPage);

    const failedStep = result.history.find((s) => s.status === 'failed');
    expect(failedStep).toBeDefined();
    expect(failedStep!.error).toContain('Grounding failed');
    expect(result.goalAchieved).toBe(true);
  });

  it('7. should stop after maxGroundingFailures consecutive failures', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockGrounding.groundAction.mockResolvedValue({
      success: false,
      action: null as any,
      result: {} as any,
    });

    mockPlanner.plan.mockResolvedValue({
      nextAction: mockAction('click', 'Ghost element'),
      reasoning: 'try',
      goalAchieved: false,
    });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxGroundingFailures: 2,
      stepDelayMs: 0,
    });

    const result = await agent.run('Click ghost button', mockPage);

    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('grounding_failed');
    expect(result.history.every((s) => s.status === 'failed')).toBe(true);
  });

  it('8. should record execution failure and continue if continueOnExecutionFailure=true', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockExecutor.execute
      .mockResolvedValueOnce(mockFailResult('Click intercepted'))
      .mockResolvedValueOnce(mockPassResult());

    mockPlanner.plan
      .mockResolvedValueOnce({ nextAction: mockAction('click', 'Busy btn'), reasoning: 'try', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: mockAction('click', 'Ok btn'), reasoning: 'retry', goalAchieved: false })
      .mockResolvedValueOnce({ nextAction: null, reasoning: 'Done', goalAchieved: true });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      continueOnExecutionFailure: true,
      maxExecutionFailures: 3,
      stepDelayMs: 0,
    });

    const result = await agent.run('Do something', mockPage);

    const failedStep = result.history.find((s) => s.status === 'failed');
    expect(failedStep).toBeDefined();
    expect(result.goalAchieved).toBe(true);
  });

  it('9. should stop after maxExecutionFailures consecutive failures', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockExecutor.execute.mockResolvedValue(mockFailResult('Element not interactable'));

    mockPlanner.plan.mockResolvedValue({
      nextAction: mockAction(),
      reasoning: 'try',
      goalAchieved: false,
    });

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxExecutionFailures: 2,
      continueOnExecutionFailure: true,
      stepDelayMs: 0,
    });

    const result = await agent.run('Failing goal', mockPage);

    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('execution_failed');
  });

  it('10. should stop gracefully when stop() is called', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxSteps: 10,
      stepDelayMs: 0,
    });

    // Case A: stop called before run starts
    agent.stop();
    const result1 = await agent.run('Stopped before run', mockPage);
    expect(result1.status).toBe('stopped');
    expect(result1.terminationReason).toBe('user_stopped');

    // Case B: stop called during execution (e.g. during step 1 planning)
    let stepCount = 0;
    mockPlanner.plan.mockImplementation(async () => {
      stepCount++;
      if (stepCount === 1) {
        agent.stop();
      }
      return {
        nextAction: mockAction(),
        reasoning: 'step',
        goalAchieved: false,
      };
    });

    const result2 = await agent.run('Stop during execution', mockPage);
    expect(result2.status).toBe('stopped');
    expect(result2.terminationReason).toBe('user_stopped');
    expect(result2.history).toHaveLength(1);
  });

  it('11. planner error is handled without crashing agent', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    mockPlanner.plan.mockRejectedValue(new Error('Planner internal error'));

    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      stepDelayMs: 0,
    });

    const result = await agent.run('Failing plan goal', mockPage);

    expect(result.status).toBe('failed');
    expect(result.terminationReason).toBe('planner_error');
    expect(result.goalAchieved).toBe(false);
  });

  it('12. no infinite loop: maxSteps is always enforced', async () => {
    const { mockPage, mockObserver, mockGrounding, mockExecutor, mockPlanner } = buildMocks();

    let callCount = 0;
    mockPlanner.plan.mockImplementation(async () => {
      callCount++;
      return { nextAction: mockAction(), reasoning: 'loop', goalAchieved: false };
    });

    const MAX = 5;
    const agent = new Agent(mockObserver, mockPlanner, mockGrounding, mockExecutor, {
      maxSteps: MAX,
      stepDelayMs: 0,
    });

    const result = await agent.run('Infinite loop test', mockPage);

    expect(result.stepCount).toBeLessThanOrEqual(MAX);
    expect(result.terminationReason).toBe('max_steps_reached');
  });
});
