import { TestCase, TestStep, TestAssertion } from './types';

// ============================================================
// TestCase Normalizer – web-test-agent / src/generator/normalizer.ts
// Normalizes and cleans generated TestCase structures:
// - Removes consecutive redundant retry steps
// - Re-indexes step order to 1..N
// - Trims and standardizes action values & target descriptions
// - Cleans and deduplicates assertions
// ============================================================

export interface NormalizerOptions {
  removeDuplicateSteps?: boolean;
  trimStrings?: boolean;
  deduplicateAssertions?: boolean;
}

const DEFAULT_OPTIONS: Required<NormalizerOptions> = {
  removeDuplicateSteps: true,
  trimStrings: true,
  deduplicateAssertions: true,
};

/**
 * Check if two test steps are redundant duplicates (e.g. agent retried the same fill/click).
 */
function areDuplicateSteps(a: TestStep, b: TestStep): boolean {
  if (a.action.type !== b.action.type) return false;

  const locA = (a.locator ?? a.action.target_description ?? '').trim().toLowerCase();
  const locB = (b.locator ?? b.action.target_description ?? '').trim().toLowerCase();
  if (locA !== locB) return false;

  const valA = (a.value ?? a.action.value ?? '').trim();
  const valB = (b.value ?? b.action.value ?? '').trim();
  if (valA !== valB) return false;

  return true;
}

/**
 * Generates a clean human-readable outcome description for a step.
 */
function buildExpectedOutcome(step: TestStep): string {
  const target = step.targetDescription ?? step.locator ?? step.action.target_description;
  const value = step.value ?? step.action.value;

  switch (step.action.type) {
    case 'click':
      return `Click on "${target}"`;
    case 'fill':
      return `Fill "${target}" with "${value ?? ''}"`;
    case 'select':
      return `Select option "${value ?? ''}" in "${target}"`;
    case 'press':
      return `Press key "${value ?? ''}" on "${target}"`;
    case 'hover':
      return `Hover over "${target}"`;
    case 'navigate':
      return `Navigate to "${value ?? target}"`;
    case 'wait':
      return `Wait for "${target}"`;
    case 'assert':
      return `Verify "${target}"`;
    case 'scroll':
      return `Scroll on "${target}"`;
    default:
      return `${step.action.type} on "${target}"`;
  }
}

/**
 * Normalizes a TestCase:
 * - Deduplicates consecutive identical actions
 * - Re-indexes step order (1, 2, 3...)
 * - Synchronizes action fields (locator, value, targetDescription)
 * - Standardizes string values and trims whitespace
 * - Deduplicates assertions
 */
export function normalizeTestCase(
  testCase: TestCase,
  options: NormalizerOptions = {}
): TestCase {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 1. Normalize steps
  let rawSteps = [...testCase.steps];

  if (opts.removeDuplicateSteps && rawSteps.length > 1) {
    const filtered: TestStep[] = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const current = rawSteps[i];
      const prev = filtered[filtered.length - 1];

      if (prev && areDuplicateSteps(prev, current)) {
        // Skip duplicate step (e.g. repeated identical fill/click)
        continue;
      }
      filtered.push(current);
    }
    rawSteps = filtered;
  }

  // 2. Re-index and clean steps
  const normalizedSteps: TestStep[] = rawSteps.map((step, index) => {
    const order = index + 1;
    const targetDescription = opts.trimStrings
      ? step.targetDescription?.trim() ?? step.action.target_description?.trim()
      : step.targetDescription ?? step.action.target_description;

    const locator = opts.trimStrings ? step.locator?.trim() : step.locator;
    const value = opts.trimStrings
      ? step.value !== undefined ? String(step.value).trim() : step.action.value !== undefined ? String(step.action.value).trim() : undefined
      : step.value ?? step.action.value;

    const action = {
      ...step.action,
      target_description: locator ?? targetDescription ?? step.action.target_description,
      value,
    };

    const expectedOutcome =
      step.expectedOutcome?.trim() ||
      buildExpectedOutcome({ ...step, targetDescription, locator, value, action });

    return {
      order,
      action,
      targetDescription,
      locator,
      value,
      expectedOutcome,
    };
  });

  // 3. Normalize assertions
  let normalizedAssertions = [...testCase.assertions];
  if (opts.trimStrings) {
    normalizedAssertions = normalizedAssertions.map((a) => ({
      ...a,
      target: a.target?.trim(),
      expected: a.expected?.trim(),
      description: a.description.trim(),
    }));
  }

  if (opts.deduplicateAssertions) {
    const seen = new Set<string>();
    normalizedAssertions = normalizedAssertions.filter((a) => {
      const key = `${a.type}:${a.target ?? ''}:${a.expected ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 4. Normalize preconditions
  const normalizedPreconditions = Array.from(
    new Set(
      testCase.preconditions
        .map((p) => (opts.trimStrings ? p.trim() : p))
        .filter((p) => p.length > 0)
    )
  );

  return {
    ...testCase,
    name: opts.trimStrings ? testCase.name.trim() : testCase.name,
    description: opts.trimStrings ? testCase.description.trim() : testCase.description,
    startUrl: opts.trimStrings ? testCase.startUrl.trim() : testCase.startUrl,
    preconditions: normalizedPreconditions,
    steps: normalizedSteps,
    assertions: normalizedAssertions,
    metadata: {
      ...testCase.metadata,
      stepCount: normalizedSteps.length,
    },
  };
}
