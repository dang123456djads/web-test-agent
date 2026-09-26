/**
 * M6 Unit Tests – Generator Validator Suite
 *
 * Validates TestCase validation rules:
 * 1. Valid test case passes validation
 * 2. Invalid UUID id fails
 * 3. Empty name or description fails
 * 4. Invalid startUrl fails
 * 5. Non-sequential step order fails
 * 6. Missing value for fill/select fails
 * 7. Invalid assertion parameters fail
 * 8. assertValidTestCase throws on error
 */

import { validateTestCase, assertValidTestCase, TestCaseValidationError } from '../../src/generator/validator';
import { TestCase } from '../../src/generator/types';

function createValidTestCase(): TestCase {
  return {
    id: 'a0000000-0000-0000-0000-000000000001',
    name: 'Valid Login Test',
    description: 'Verify login works correctly',
    startUrl: 'https://example.com/login',
    preconditions: ['User account exists'],
    steps: [
      {
        order: 1,
        action: {
          id: 'b0000000-0000-0000-0000-000000000001',
          type: 'fill',
          target_description: '#email',
          value: 'admin@example.com',
        },
        targetDescription: 'Email input',
        locator: '#email',
        value: 'admin@example.com',
        expectedOutcome: 'Fill email with admin@example.com',
      },
      {
        order: 2,
        action: {
          id: 'b0000000-0000-0000-0000-000000000002',
          type: 'click',
          target_description: '#login-btn',
        },
        targetDescription: 'Login button',
        locator: '#login-btn',
        expectedOutcome: 'Click login button',
      },
    ],
    assertions: [
      {
        type: 'url_contains',
        expected: '#dashboard',
        description: 'Verify URL has #dashboard',
      },
      {
        type: 'element_visible',
        target: '#dashboard-page',
        description: 'Verify dashboard is visible',
      },
    ],
    metadata: {
      generatedAt: '2026-09-26T12:00:00.000Z',
      agentGoal: 'Login to dashboard',
      stepCount: 2,
      durationMs: 1500,
      framework: 'playwright',
      tags: ['login', 'smoke'],
    },
  };
}

describe('M6 Unit: Generator Validator', () => {
  it('1. should pass validation for a valid TestCase', () => {
    const tc = createValidTestCase();
    const result = validateTestCase(tc);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('2. should fail if id is not a valid UUID', () => {
    const tc = createValidTestCase();
    tc.id = 'not-a-valid-uuid';
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'id')).toBe(true);
  });

  it('3. should fail if name is empty', () => {
    const tc = createValidTestCase();
    tc.name = '';
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('4. should fail if startUrl is invalid', () => {
    const tc = createValidTestCase();
    tc.startUrl = 'invalid-url-protocol://something';
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'startUrl')).toBe(true);
  });

  it('5. should allow file:/// URLs for local testing', () => {
    const tc = createValidTestCase();
    tc.startUrl = 'file:///D:/NCKH_TestWeb/web-test-agent/demo-site/index.html';
    const result = validateTestCase(tc);
    expect(result.valid).toBe(true);
  });

  it('6. should fail if steps are empty', () => {
    const tc = createValidTestCase();
    tc.steps = [];
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'steps')).toBe(true);
  });

  it('7. should fail if step order is not strictly sequential', () => {
    const tc = createValidTestCase();
    tc.steps[1].order = 5; // Should be 2
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'steps[1].order')).toBe(true);
  });

  it('8. should fail if fill action has missing/empty value', () => {
    const tc = createValidTestCase();
    tc.steps[0].value = '';
    tc.steps[0].action.value = '';
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'steps[0].value')).toBe(true);
  });

  it('9. should fail if assertion parameters are missing', () => {
    const tc = createValidTestCase();
    tc.assertions.push({
      type: 'element_visible',
      target: '', // Missing target!
      description: 'Check empty element',
    });
    const result = validateTestCase(tc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'assertions[2].target')).toBe(true);
  });

  it('10. assertValidTestCase throws TestCaseValidationError on invalid case', () => {
    const tc = createValidTestCase();
    tc.name = '';
    expect(() => assertValidTestCase(tc)).toThrow(TestCaseValidationError);
  });
});
