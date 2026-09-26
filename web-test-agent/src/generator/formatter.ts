import { TestCase, TestReplayResult } from './types';

// ============================================================
// TestCase Formatter – web-test-agent / src/generator/formatter.ts
// Renders TestCase and TestReplayResult into human-readable text.
// ============================================================

export function formatTestCase(testCase: TestCase): string {
  const lines: string[] = [];

  lines.push(`TEST CASE: ${testCase.name}`);
  lines.push('');
  lines.push('Description:');
  lines.push(testCase.description);
  lines.push('');

  if (testCase.preconditions.length > 0) {
    lines.push('PRECONDITIONS:');
    for (const pre of testCase.preconditions) {
      lines.push(`- ${pre}`);
    }
    lines.push('');
  }

  lines.push('STEPS:');
  if (testCase.steps.length === 0) {
    lines.push('(no steps)');
  } else {
    for (const step of testCase.steps) {
      const outcome = step.expectedOutcome || `${step.action.type} "${step.locator ?? step.targetDescription}"`;
      lines.push(`${step.order}. ${outcome}`);
    }
  }
  lines.push('');

  lines.push('ASSERTIONS:');
  if (testCase.assertions.length === 0) {
    lines.push('(none)');
  } else {
    testCase.assertions.forEach((a, idx) => {
      lines.push(`${idx + 1}. [${a.type}] ${a.description}`);
    });
  }
  lines.push('');

  lines.push('METADATA:');
  lines.push(`- ID: ${testCase.id}`);
  lines.push(`- Start URL: ${testCase.startUrl}`);
  lines.push(`- Generated: ${testCase.metadata.generatedAt}`);
  lines.push(`- Goal: ${testCase.metadata.agentGoal}`);
  lines.push('');
  lines.push('RESULT:');
  lines.push('Generated successfully');

  return lines.join('\n');
}

export function formatReplayResult(result: TestReplayResult): string {
  const lines: string[] = [];

  lines.push(`REPLAY REPORT: Test Case ${result.testCaseId}`);
  lines.push(`Status: ${result.status.toUpperCase()} (${result.durationMs}ms)`);
  lines.push('');

  lines.push('STEP RESULTS:');
  for (const s of result.steps) {
    const symbol = s.status === 'passed' ? '✓' : '✗';
    const loc = s.locator ? ` [${s.locator}]` : '';
    const err = s.error ? ` - Error: ${s.error}` : '';
    lines.push(`  Step ${s.order}: ${symbol} ${s.status.toUpperCase()}${loc} (${s.durationMs}ms)${err}`);
  }
  lines.push('');

  if (result.assertions.length > 0) {
    lines.push('ASSERTION RESULTS:');
    for (const a of result.assertions) {
      const symbol = a.passed ? '✓' : '✗';
      const err = a.error ? ` - Error: ${a.error}` : '';
      lines.push(`  ${symbol} [${a.assertion.type}] ${a.assertion.description}${err}`);
    }
    lines.push('');
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
    lines.push('');
  }

  return lines.join('\n');
}
