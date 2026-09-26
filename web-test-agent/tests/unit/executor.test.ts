/**
 * M1 Unit Tests – Executor
 *
 * Tests Executor logic with a mocked Playwright Page object.
 * Does NOT launch a real browser – focus on:
 *   1. Correct dispatch per action type
 *   2. Retry logic on failure
 *   3. ExecutionResult structure (status, duration, locator_used)
 *   4. Invalid action handling
 *   5. Assert / oracle handling
 */

import { Executor } from '../../src/executor/executor';
import { TestAction } from '../../src/models/schemas';

// ─── Mock Playwright Page ──────────────────────────────────────
function makeMockPage(overrides: Record<string, jest.Mock> = {}): any {
  const defaultLocator: any = {
    click: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    press: jest.fn().mockResolvedValue(undefined),
    hover: jest.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(undefined),
    selectOption: jest.fn().mockResolvedValue(undefined),
    waitFor: jest.fn().mockResolvedValue(undefined),
    innerText: jest.fn().mockResolvedValue('Expected Text'),
    count: jest.fn().mockResolvedValue(0),
    first: jest.fn().mockReturnValue({ innerText: jest.fn().mockResolvedValue('') }),
  };
  // filter() chains – returns itself so .filter({ visible: true }).count() etc. work
  defaultLocator.filter = jest.fn().mockReturnValue(defaultLocator);

  return {
    goto: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    waitForURL: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue(defaultLocator),
    ...overrides,
  };
}

// ─── Action factory ────────────────────────────────────────────
function makeAction(overrides: Partial<TestAction>): TestAction {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'click',
    target_description: '#login-btn',
    ...overrides,
  } as TestAction;
}

const TEST_CASE_ID = '00000000-0000-0000-0000-000000000099';

// ─── Suite ─────────────────────────────────────────────────────
describe('M1 Unit: Executor – Action Dispatch', () => {
  let executor: Executor;

  beforeEach(() => {
    executor = new Executor({
      timeoutMs: 5000,
      retryCount: 1,       // no retry in unit tests
      retryDelayMs: 0,
      screenshotOnFailure: false,
    });
  });

  // ── navigate ──────────────────────────────────────────────
  it('navigate: calls page.goto with value as URL', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'navigate', target_description: 'https://example.com', value: 'https://example.com' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect(result.status).toBe('passed');
    expect(result.action_id).toBe(action.id);
    expect(result.test_case_id).toBe(TEST_CASE_ID);
    expect(result.locator_used).toBe('https://example.com');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ── click ─────────────────────────────────────────────────
  it('click: calls locator().click()', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'click', target_description: '#login-btn' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(page.locator).toHaveBeenCalledWith('#login-btn');
    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.click).toHaveBeenCalled();
    expect(result.status).toBe('passed');
  });

  // ── fill ──────────────────────────────────────────────────
  it('fill: calls locator().fill() with value', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'fill', target_description: '#email', value: 'admin@example.com' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(page.locator).toHaveBeenCalledWith('#email');
    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.fill).toHaveBeenCalledWith('admin@example.com', expect.any(Object));
    expect(result.status).toBe('passed');
  });

  // ── press ─────────────────────────────────────────────────
  it('press: calls locator().press() with key', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'press', target_description: '#password', value: 'Enter' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.press).toHaveBeenCalledWith('Enter', expect.any(Object));
    expect(result.status).toBe('passed');
  });

  // ── hover ─────────────────────────────────────────────────
  it('hover: calls locator().hover()', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'hover', target_description: '#about-link' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.hover).toHaveBeenCalled();
    expect(result.status).toBe('passed');
  });

  // ── wait (ms) ─────────────────────────────────────────────
  it('wait: calls page.waitForTimeout when value is a number', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'wait', target_description: 'wait', value: '500' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(result.status).toBe('passed');
  });

  // ── wait (selector) ───────────────────────────────────────
  it('wait: calls locator().waitFor when value is a selector string', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'wait', target_description: '#dashboard-page', value: '#dashboard-page' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }));
    expect(result.status).toBe('passed');
  });

  // ── scroll ────────────────────────────────────────────────
  it('scroll: calls locator().scrollIntoViewIfNeeded()', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'scroll', target_description: '#logout-btn' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(result.status).toBe('passed');
  });

  // ── select ────────────────────────────────────────────────
  it('select: calls locator().selectOption() with value', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'select', target_description: '#role-select', value: 'admin' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.selectOption).toHaveBeenCalledWith('admin', expect.any(Object));
    expect(result.status).toBe('passed');
  });
});

// ─── Assert / Oracle tests ─────────────────────────────────────
describe('M1 Unit: Executor – Assert / Oracle', () => {
  let executor: Executor;

  beforeEach(() => {
    executor = new Executor({ timeoutMs: 5000, retryCount: 1, retryDelayMs: 0, screenshotOnFailure: false });
  });

  it('assert url_contains: calls page.waitForURL', async () => {
    const page = makeMockPage();
    const action = makeAction({
      type: 'assert',
      target_description: 'page',
      expected_oracle: { type: 'url_contains', value: 'dashboard' },
    });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(page.waitForURL).toHaveBeenCalledWith(expect.any(RegExp), expect.any(Object));
    expect(result.status).toBe('passed');
  });

  it('assert element_visible: calls locator().waitFor with visible state', async () => {
    const page = makeMockPage();
    const action = makeAction({
      type: 'assert',
      target_description: 'page',
      expected_oracle: { type: 'element_visible', value: '#dashboard-page' },
    });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    const locatorMock = page.locator.mock.results[0].value;
    expect(locatorMock.waitFor).toHaveBeenCalledWith(expect.objectContaining({ state: 'visible' }));
    expect(result.status).toBe('passed');
  });

  it('assert element_text: passes when text matches', async () => {
    const page = makeMockPage();
    // innerText mock returns 'Expected Text'
    const action = makeAction({
      type: 'assert',
      target_description: '#counter-value',
      expected_oracle: { type: 'element_text', value: 'Expected Text' },
    });

    const result = await executor.execute(action, page, TEST_CASE_ID);
    expect(result.status).toBe('passed');
  });

  it('assert element_text: fails when text does NOT match', async () => {
    const locatorMock = {
      click: jest.fn(),
      fill: jest.fn(),
      press: jest.fn(),
      hover: jest.fn(),
      scrollIntoViewIfNeeded: jest.fn(),
      selectOption: jest.fn(),
      waitFor: jest.fn(),
      innerText: jest.fn().mockResolvedValue('Wrong text'),
      count: jest.fn().mockResolvedValue(0),
      first: jest.fn(),
    };
    const page = makeMockPage({ locator: jest.fn().mockReturnValue(locatorMock) });

    const action = makeAction({
      type: 'assert',
      target_description: '#counter-value',
      expected_oracle: { type: 'element_text', value: 'Expected Text' },
    });

    const result = await executor.execute(action, page, TEST_CASE_ID);
    expect(result.status).toBe('failed');
    expect(result.error_message).toContain('element_text assertion failed');
  });

  it('assert no_error: passes when no error elements found', async () => {
    const page = makeMockPage(); // count() defaults to 0
    const action = makeAction({
      type: 'assert',
      target_description: 'page',
      expected_oracle: { type: 'no_error', value: '' },
    });

    const result = await executor.execute(action, page, TEST_CASE_ID);
    expect(result.status).toBe('passed');
  });

  it('assert without oracle: fails with descriptive error', async () => {
    const page = makeMockPage();
    const action = makeAction({ type: 'assert', target_description: '#something' });

    const result = await executor.execute(action, page, TEST_CASE_ID);
    expect(result.status).toBe('failed');
    expect(result.error_message).toContain('expected_oracle');
  });
});

// ─── Retry logic ──────────────────────────────────────────────
describe('M1 Unit: Executor – Retry Logic', () => {
  it('retries failed action up to retryCount times', async () => {
    const executor = new Executor({ timeoutMs: 1000, retryCount: 3, retryDelayMs: 0, screenshotOnFailure: false });

    let callCount = 0;
    const locatorMock = {
      click: jest.fn().mockImplementation(() => {
        callCount++;
        throw new Error('Element not found');
      }),
      fill: jest.fn(), press: jest.fn(), hover: jest.fn(),
      scrollIntoViewIfNeeded: jest.fn(), selectOption: jest.fn(),
      waitFor: jest.fn(), innerText: jest.fn(), count: jest.fn(), first: jest.fn(),
    };
    const page = makeMockPage({ locator: jest.fn().mockReturnValue(locatorMock) });

    const action = makeAction({ type: 'click', target_description: '#missing-btn' });
    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(callCount).toBe(3);
    expect(result.status).toBe('failed');
    expect(result.error_message).toContain('Element not found');
  }, 15_000);

  it('succeeds on second attempt (retry recovers from transient error)', async () => {
    const executor = new Executor({ timeoutMs: 1000, retryCount: 3, retryDelayMs: 0, screenshotOnFailure: false });

    let callCount = 0;
    const locatorMock = {
      click: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) throw new Error('Transient error');
        return Promise.resolve();
      }),
      fill: jest.fn(), press: jest.fn(), hover: jest.fn(),
      scrollIntoViewIfNeeded: jest.fn(), selectOption: jest.fn(),
      waitFor: jest.fn(), innerText: jest.fn(), count: jest.fn(), first: jest.fn(),
    };
    const page = makeMockPage({ locator: jest.fn().mockReturnValue(locatorMock) });

    const action = makeAction({ type: 'click', target_description: '#flaky-btn' });
    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(callCount).toBe(2);
    expect(result.status).toBe('passed');
  }, 15_000);
});

// ─── ExecutionResult structure ─────────────────────────────────
describe('M1 Unit: Executor – Result Structure', () => {
  it('result has all required fields', async () => {
    const executor = new Executor({ retryCount: 1, retryDelayMs: 0, screenshotOnFailure: false });
    const page = makeMockPage();
    const action = makeAction({ type: 'click', target_description: '#login-btn' });

    const result = await executor.execute(action, page, TEST_CASE_ID);

    expect(result).toMatchObject({
      action_id: action.id,
      test_case_id: TEST_CASE_ID,
      status: 'passed',
      locator_used: '#login-btn',
      duration_ms: expect.any(Number),
      executed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
