import { z } from 'zod';

// ============================================================
// CORE SCHEMAS – Source of Truth for Data Contracts
// web-test-agent / src/models/schemas.ts
// ============================================================

// ─── UserRequest ────────────────────────────────────────────
export const UserRequestSchema = z.object({
  id: z.string().uuid(),
  target_url: z.string().url(),
  description: z.string().optional(),
  constraints: z
    .object({
      max_depth: z.number().int().positive().optional(),
      max_states: z.number().int().positive().optional(),
      max_llm_calls: z.number().int().positive().optional(),
    })
    .optional(),
  created_at: z.string().datetime(),
});
export type UserRequest = z.infer<typeof UserRequestSchema>;

// ─── TestPlan ────────────────────────────────────────────────
export const TestPlanSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  objectives: z.array(z.string()),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ─── ElementDescriptor ───────────────────────────────────────
export const ElementDescriptorSchema = z.object({
  tag: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  aria_label: z.string().optional(),
  placeholder: z.string().optional(),
  role: z.string().optional(),
  type: z.string().optional(),            // input type attribute
  classes: z.array(z.string()).optional(),
  xpath: z.string().optional(),
  css_selector: z.string().optional(),
  bounding_box: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

// ─── State ───────────────────────────────────────────────────
export const StateSchema = z.object({
  id: z.string(),                          // deterministic hash of the page
  url: z.string().url(),
  title: z.string(),
  dom_snapshot: z.string().optional(),     // raw DOM HTML (may be large)
  interactive_elements: z.array(ElementDescriptorSchema),
  screenshot_path: z.string().optional(),
  visited_at: z.string().datetime(),
});
export type State = z.infer<typeof StateSchema>;

// ─── StateGraph ──────────────────────────────────────────────
export const StateGraphSchema = z.object({
  states: z.record(z.string(), StateSchema),        // state_id → State
  edges: z.array(
    z.object({
      from_state: z.string(),
      to_state: z.string(),
      action: z.string(),                           // description of triggering action
    })
  ),
  entry_state_id: z.string(),
});
export type StateGraph = z.infer<typeof StateGraphSchema>;

// ─── ExpectedOracle ──────────────────────────────────────────
export const ExpectedOracleSchema = z.object({
  type: z.enum(['url_contains', 'element_visible', 'element_text', 'no_error', 'custom']),
  value: z.string(),
  description: z.string().optional(),
});
export type ExpectedOracle = z.infer<typeof ExpectedOracleSchema>;

// ─── TestAction ──────────────────────────────────────────────
export const TestActionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    'click',
    'fill',
    'select',
    'hover',
    'press',
    'navigate',
    'wait',
    'assert',
    'scroll',
  ]),
  target_description: z.string(),           // natural language / grounding input
  value: z.string().optional(),             // e.g. text to fill, key to press
  expected_oracle: ExpectedOracleSchema.optional(),
});
export type TestAction = z.infer<typeof TestActionSchema>;

// ─── TestCase ────────────────────────────────────────────────
export const TestCaseSchema = z.object({
  id: z.string().uuid(),
  plan_id: z.string().uuid(),
  title: z.string(),
  description: z.string().optional(),
  steps: z.array(TestActionSchema),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  tags: z.array(z.string()).optional(),
  created_at: z.string().datetime(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

// ─── GroundingCandidate ──────────────────────────────────────
export const GroundingCandidateSchema = z.object({
  element: ElementDescriptorSchema,
  locator: z.string(),                      // Playwright locator string
  strategy: z.enum([
    'aria_label',
    'role',
    'text',
    'placeholder',
    'id',
    'css',
    'xpath',
    'llm',
  ]),
  score: z.number().min(0).max(1),          // confidence [0,1]
});
export type GroundingCandidate = z.infer<typeof GroundingCandidateSchema>;

// ─── GroundingResult ─────────────────────────────────────────
export const GroundingResultSchema = z.object({
  action_id: z.string().uuid(),
  target_description: z.string(),
  candidates: z.array(GroundingCandidateSchema),
  selected: GroundingCandidateSchema.nullable(),
  ambiguous: z.boolean(),
  used_llm_fallback: z.boolean(),
  grounded_at: z.string().datetime(),
});
export type GroundingResult = z.infer<typeof GroundingResultSchema>;

// ─── ExecutionResult ─────────────────────────────────────────
export const ExecutionResultSchema = z.object({
  action_id: z.string().uuid(),
  test_case_id: z.string().uuid(),
  status: z.enum(['passed', 'failed', 'skipped', 'error']),
  locator_used: z.string().optional(),
  error_message: z.string().optional(),
  screenshot_path: z.string().optional(),
  duration_ms: z.number().int().nonnegative(),
  executed_at: z.string().datetime(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

// ─── ObservationRecord ───────────────────────────────────────
export const ObservationRecordSchema = z.object({
  id: z.string().uuid(),
  test_case_id: z.string().uuid(),
  action_id: z.string().uuid(),
  state_before: z.string(),               // state_id
  state_after: z.string().optional(),     // state_id after action
  dom_diff: z.string().optional(),        // summary of DOM changes
  network_requests: z.array(z.string()).optional(),
  console_errors: z.array(z.string()).optional(),
  observed_at: z.string().datetime(),
});
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;

// ─── EvaluationResult ────────────────────────────────────────
export const EvaluationResultSchema = z.object({
  id: z.string().uuid(),
  test_case_id: z.string().uuid(),
  oracle_type: ExpectedOracleSchema.shape.type,
  passed: z.boolean(),
  expected: z.string(),
  actual: z.string().optional(),
  rule_violations: z.array(z.string()).optional(),
  evaluated_at: z.string().datetime(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

// ─── LocatorMemoryEntry ──────────────────────────────────────
export const LocatorMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  url_pattern: z.string(),                // URL or pattern where locator was used
  target_description: z.string(),
  locator: z.string(),                    // Playwright locator string
  strategy: GroundingCandidateSchema.shape.strategy,
  success_count: z.number().int().nonnegative().default(0),
  failure_count: z.number().int().nonnegative().default(0),
  last_used_at: z.string().datetime(),
  created_at: z.string().datetime(),
});
export type LocatorMemoryEntry = z.infer<typeof LocatorMemoryEntrySchema>;
