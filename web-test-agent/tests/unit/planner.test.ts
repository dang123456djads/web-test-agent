/**
 * M5 Unit Tests – Planner Suite
 *
 * Validates Planner behavior with mocked LLMClient:
 * 1. Returns valid nextAction for a normal goal
 * 2. Returns goalAchieved=true when LLM signals completion
 * 3. Returns nextAction=null when LLM signals no action possible
 * 4. Handles LLM failure gracefully (throws → returns null action)
 * 5. Handles malformed LLM JSON gracefully
 * 6. Sanitizes invalid action types returned by LLM
 * 7. Generated action has a valid UUID id
 * 8. Builds correct system prompt (no API key, no hardcoded locators)
 */

import { Planner } from '../../src/agent/planner';
import { LLMClient, LLMResponse } from '../../src/llm/types';
import { Observation } from '../../src/observer/types';

// ─── Mock LLM Client ──────────────────────────────────────────
function mockLlmClient(response: string | Error): LLMClient {
  return {
    complete: jest.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      const r: LLMResponse = {
        content: response,
        model: 'claude-test',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      };
      return r;
    }),
  };
}

// ─── Test Fixtures ─────────────────────────────────────────────
function mockObservation(url = 'https://app.test/login', title = 'Login'): Observation {
  return {
    page: { url, title, dom: '<html></html>' },
    elements: [
      { tag: 'input', id: 'email', name: 'email', type: 'email' },
      { tag: 'input', id: 'password', name: 'password', type: 'password' },
      { tag: 'button', id: 'login-btn', text: 'Đăng nhập', role: 'button' },
    ],
    network: [],
    console: [],
    captured_at: new Date().toISOString(),
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('M5 Unit: Planner Suite', () => {
  it('1. should return a valid nextAction for a normal LLM response', async () => {
    const llmResponse = JSON.stringify({
      nextAction: {
        id: '11111111-1111-1111-1111-111111111111',
        type: 'fill',
        target_description: 'Email input field',
        value: 'admin@example.com',
      },
      reasoning: 'Need to fill the email field first',
      goalAchieved: false,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Login to the dashboard',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).not.toBeNull();
    expect(result.nextAction!.type).toBe('fill');
    expect(result.nextAction!.target_description).toBe('Email input field');
    expect(result.nextAction!.value).toBe('admin@example.com');
    expect(result.goalAchieved).toBe(false);
    expect(result.reasoning).toContain('email');
  });

  it('2. should signal goalAchieved when LLM returns goalAchieved=true', async () => {
    const llmResponse = JSON.stringify({
      nextAction: null,
      reasoning: 'Dashboard is visible, goal achieved',
      goalAchieved: true,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Login to the dashboard',
      observation: mockObservation('https://app.test/dashboard', 'Dashboard'),
      history: [],
    });

    expect(result.goalAchieved).toBe(true);
    expect(result.nextAction).toBeNull();
    expect(result.reasoning).toContain('Dashboard');
  });

  it('3. should return nextAction=null when LLM signals no possible action', async () => {
    const llmResponse = JSON.stringify({
      nextAction: null,
      reasoning: 'Element does not exist on page',
      goalAchieved: false,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Click the Delete Account Forever button',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).toBeNull();
    expect(result.goalAchieved).toBe(false);
    expect(result.reasoning).toContain('does not exist');
  });

  it('4. should handle LLM error gracefully without throwing', async () => {
    const planner = new Planner(mockLlmClient(new Error('API rate limit exceeded')));
    const result = await planner.plan({
      goal: 'Login to dashboard',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).toBeNull();
    expect(result.goalAchieved).toBe(false);
    expect(result.reasoning).toContain('LLM error');
  });

  it('5. should handle malformed LLM JSON gracefully', async () => {
    const planner = new Planner(mockLlmClient('This is not valid JSON { broken'));
    const result = await planner.plan({
      goal: 'Login',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).toBeNull();
    expect(result.goalAchieved).toBe(false);
    expect(result.reasoning).toContain('Parse error');
  });

  it('6. should reject invalid action type from LLM', async () => {
    const llmResponse = JSON.stringify({
      nextAction: {
        id: '22222222-2222-2222-2222-222222222222',
        type: 'eval', // dangerous/invalid type
        target_description: 'Some button',
      },
      reasoning: 'Trying eval',
      goalAchieved: false,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Do something dangerous',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).toBeNull();
    expect(result.goalAchieved).toBe(false);
  });

  it('7. should assign a valid UUID to the generated action', async () => {
    const llmResponse = JSON.stringify({
      nextAction: {
        id: 'not-a-valid-uuid', // will be replaced
        type: 'click',
        target_description: 'Login button',
      },
      reasoning: 'Click login',
      goalAchieved: false,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Login',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).not.toBeNull();
    expect(result.nextAction!.id).toMatch(UUID_REGEX);
  });

  it('8. should include history steps in LLM prompt context', async () => {
    const capturedRequests: string[] = [];
    const capturingClient: LLMClient = {
      complete: jest.fn().mockImplementation(async (req) => {
        capturedRequests.push(req.userPrompt);
        return {
          content: JSON.stringify({ nextAction: null, reasoning: 'done', goalAchieved: true }),
          model: 'test',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }),
    };

    const historySteps = [
      {
        stepNumber: 1,
        observation: mockObservation(),
        plannedAction: {
          id: '33333333-3333-3333-3333-333333333333',
          type: 'fill' as const,
          target_description: 'Email field',
          value: 'admin@example.com',
        },
        durationMs: 200,
        status: 'success' as const,
      },
    ];

    const planner = new Planner(capturingClient);
    await planner.plan({
      goal: 'Login',
      observation: mockObservation(),
      history: historySteps,
    });

    expect(capturedRequests.length).toBe(1);
    // History should be included in the prompt
    expect(capturedRequests[0]).toContain('Step 1');
    expect(capturedRequests[0]).toContain('Email field');
  });

  it('9. should strip markdown code fences from LLM response', async () => {
    const llmResponse = '```json\n' + JSON.stringify({
      nextAction: {
        id: '44444444-4444-4444-4444-444444444444',
        type: 'click',
        target_description: 'Submit button',
      },
      reasoning: 'Submit the form',
      goalAchieved: false,
    }) + '\n```';

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Submit form',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).not.toBeNull();
    expect(result.nextAction!.type).toBe('click');
  });

  it('10. should return null when target_description is empty', async () => {
    const llmResponse = JSON.stringify({
      nextAction: {
        id: '55555555-5555-5555-5555-555555555555',
        type: 'click',
        target_description: '   ', // empty after trim
      },
      reasoning: 'No target',
      goalAchieved: false,
    });

    const planner = new Planner(mockLlmClient(llmResponse));
    const result = await planner.plan({
      goal: 'Do something',
      observation: mockObservation(),
      history: [],
    });

    expect(result.nextAction).toBeNull();
  });
});
