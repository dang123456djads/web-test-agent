import { z } from 'zod';
import { TestActionSchema, TestAction } from '../models/schemas';
import { Observation } from '../observer/types';
import { AgentRunResult, AgentStep } from '../agent/types';

// ============================================================
// Generator Types – web-test-agent / src/generator/types.ts
// Data contracts and Zod schemas for M6 Test Generator.
// ============================================================

// ─── Test Assertion ──────────────────────────────────────────
export const TestAssertionTypeSchema = z.enum([
  'url_contains',
  'element_visible',
  'element_text',
  'no_error',
]);
export type TestAssertionType = z.infer<typeof TestAssertionTypeSchema>;

export const TestAssertionSchema = z.object({
  type: TestAssertionTypeSchema,
  target: z.string().optional(),
  expected: z.string().optional(),
  description: z.string().min(1),
});
export type TestAssertion = z.infer<typeof TestAssertionSchema>;

// ─── Test Step ───────────────────────────────────────────────
export const TestStepSchema = z.object({
  order: z.number().int().positive(),
  action: TestActionSchema,
  targetDescription: z.string().optional(),
  locator: z.string().optional(),
  value: z.string().optional(),
  expectedOutcome: z.string().optional(),
});
export type TestStep = z.infer<typeof TestStepSchema>;

// ─── Test Case Metadata ──────────────────────────────────────
export const TestCaseMetadataSchema = z.object({
  generatedAt: z.string().datetime(),
  agentGoal: z.string(),
  stepCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  framework: z.string().optional().default('playwright'),
  tags: z.array(z.string()).optional().default([]),
});
export type TestCaseMetadata = z.infer<typeof TestCaseMetadataSchema>;

// Helper to validate URL (supports http, https, and file:///)
const isValidUrl = (val: string): boolean => {
  if (val.startsWith('file:///')) return true;
  try {
    const parsed = new URL(val);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
  } catch {
    return false;
  }
};

// ─── Test Case ───────────────────────────────────────────────
export const TestCaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1),
  startUrl: z.string().refine(isValidUrl, { message: 'startUrl must be a valid http, https, or file URL' }),
  preconditions: z.array(z.string()),
  steps: z.array(TestStepSchema),
  assertions: z.array(TestAssertionSchema),
  metadata: TestCaseMetadataSchema,
});
export type TestCase = z.infer<typeof TestCaseSchema>;

// ─── Validation Error ────────────────────────────────────────
export interface ValidationError {
  path: string;
  message: string;
  code?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ─── Replay Contracts ────────────────────────────────────────
export const ReplayStepResultSchema = z.object({
  order: z.number().int().positive(),
  status: z.enum(['passed', 'failed']),
  locator: z.string().optional(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type ReplayStepResult = z.infer<typeof ReplayStepResultSchema>;

export const AssertionResultSchema = z.object({
  assertion: TestAssertionSchema,
  passed: z.boolean(),
  actual: z.string().optional(),
  error: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const TestReplayResultSchema = z.object({
  testCaseId: z.string(),
  status: z.enum(['passed', 'failed']),
  steps: z.array(ReplayStepResultSchema),
  assertions: z.array(AssertionResultSchema),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type TestReplayResult = z.infer<typeof TestReplayResultSchema>;

// ─── Generator Input & Options ───────────────────────────────
export interface GeneratorInput {
  goal: string;
  initialObservation?: Observation | null;
  history: AgentStep[];
  finalObservation?: Observation | null;
  terminationReason: string;
  goalAchieved: boolean;
  durationMs?: number;
}

export interface GeneratorOptions {
  includeAssertions?: boolean;
  normalizeSteps?: boolean;
  testCaseName?: string;
  testCaseDescription?: string;
  tags?: string[];
}
