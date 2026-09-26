import { TestCase, TestCaseSchema, ValidationError, ValidationResult } from './types';

// ============================================================
// TestCase Validator – web-test-agent / src/generator/validator.ts
// Validates structured TestCase objects against schema and
// semantic constraints.
// ============================================================

export class TestCaseValidationError extends Error {
  public readonly errors: ValidationError[];

  constructor(message: string, errors: ValidationError[]) {
    super(`${message}: ${errors.map((e) => `[${e.path}] ${e.message}`).join(', ')}`);
    this.name = 'TestCaseValidationError';
    this.errors = errors;
  }
}

/**
 * Validates a TestCase against schema and semantic constraints.
 *
 * Checks:
 * 1. Zod schema validation (id is UUID, types, required fields)
 * 2. Non-empty name and description
 * 3. Valid startUrl (http, https, or file:///)
 * 4. steps.order must be strictly ascending (1, 2, 3, ...)
 * 5. Actions with fill/select must have a defined value
 * 6. Action type must be valid
 * 7. Assertions must have valid parameters per type
 */
export function validateTestCase(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Zod schema validation
  const parseResult = TestCaseSchema.safeParse(input);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      });
    }
    // Return early if basic schema structure is broken
    return { valid: false, errors };
  }

  const tc = parseResult.data;

  // 2. steps.order strictly ascending positive integers (1, 2, 3, ...)
  if (tc.steps.length === 0) {
    errors.push({
      path: 'steps',
      message: 'TestCase must contain at least one step',
      code: 'empty_steps',
    });
  } else {
    for (let i = 0; i < tc.steps.length; i++) {
      const step = tc.steps[i];
      const expectedOrder = i + 1;

      if (step.order !== expectedOrder) {
        errors.push({
          path: `steps[${i}].order`,
          message: `Step order must be strictly sequential (expected ${expectedOrder}, got ${step.order})`,
          code: 'invalid_step_order',
        });
      }

      // 3. Required value check for fill & select
      const actionType = step.action?.type;
      const stepVal = step.value ?? step.action?.value;

      if ((actionType === 'fill' || actionType === 'select') && (stepVal === undefined || stepVal === null || stepVal === '')) {
        errors.push({
          path: `steps[${i}].value`,
          message: `Action of type "${actionType}" requires a non-empty value`,
          code: 'missing_required_value',
        });
      }
    }
  }

  // 4. Assertion parameter validation
  for (let i = 0; i < tc.assertions.length; i++) {
    const assertion = tc.assertions[i];
    switch (assertion.type) {
      case 'url_contains':
        if (!assertion.expected || assertion.expected.trim() === '') {
          errors.push({
            path: `assertions[${i}].expected`,
            message: 'Assertion "url_contains" requires a non-empty "expected" string',
            code: 'missing_assertion_expected',
          });
        }
        break;
      case 'element_visible':
        if (!assertion.target || assertion.target.trim() === '') {
          errors.push({
            path: `assertions[${i}].target`,
            message: 'Assertion "element_visible" requires a non-empty "target" locator',
            code: 'missing_assertion_target',
          });
        }
        break;
      case 'element_text':
        if (!assertion.target || assertion.target.trim() === '') {
          errors.push({
            path: `assertions[${i}].target`,
            message: 'Assertion "element_text" requires a non-empty "target" locator',
            code: 'missing_assertion_target',
          });
        }
        if (assertion.expected === undefined || assertion.expected === null) {
          errors.push({
            path: `assertions[${i}].expected`,
            message: 'Assertion "element_text" requires an "expected" text value',
            code: 'missing_assertion_expected',
          });
        }
        break;
      case 'no_error':
        // no extra required fields beyond description
        break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Throws a TestCaseValidationError if validation fails, otherwise returns typed TestCase.
 */
export function assertValidTestCase(input: unknown): TestCase {
  const result = validateTestCase(input);
  if (!result.valid) {
    throw new TestCaseValidationError('TestCase validation failed', result.errors);
  }
  return input as TestCase;
}
