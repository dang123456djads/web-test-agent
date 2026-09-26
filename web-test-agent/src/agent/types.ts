import { z } from 'zod';
import { TestAction, ExecutionResult } from '../models/schemas';
import { Observation } from '../observer/types';

// ============================================================
// Agent Types – web-test-agent / src/agent/types.ts
// Data contracts for M5 Agent Orchestration Layer.
// ============================================================

// ─── Agent Status ────────────────────────────────────────────
export type AgentStatus =
  | 'idle'
  | 'observing'
  | 'planning'
  | 'grounding'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'stopped';

// ─── Termination Reason ──────────────────────────────────────
export type TerminationReason =
  | 'goal_achieved'
  | 'grounding_failed'
  | 'execution_failed'
  | 'max_steps_reached'
  | 'planner_error'
  | 'no_actions_planned'
  | 'user_stopped'
  | 'fatal_error';

// ─── Agent Step ──────────────────────────────────────────────
export interface AgentStep {
  /** 1-indexed step number in this run */
  stepNumber: number;
  /** Page observation captured at the start of this step */
  observation: Observation;
  /** Raw semantic action returned by the Planner */
  plannedAction: TestAction;
  /** Grounded action with verified Playwright locator (if grounding succeeded) */
  groundedAction?: TestAction;
  /** Execution result (if execution was attempted) */
  executionResult?: ExecutionResult;
  /** Wall-clock duration of the step in milliseconds */
  durationMs: number;
  /** Step outcome */
  status: 'success' | 'failed' | 'skipped';
  /** Error message if status is failed */
  error?: string;
}

// ─── Agent State ─────────────────────────────────────────────
export interface AgentState {
  /** Natural language goal provided by the caller */
  goal: string;
  /** Most recent page observation, updated after each action */
  currentObservation: Observation | null;
  /** SHA-256 state ID of current page (from M4 state hashing) */
  currentStateId: string | null;
  /** Current semantic action planned for the next step */
  plannedAction: TestAction | null;
  /** Grounded action with verified locator */
  groundedAction: TestAction | null;
  /** Result of the most recent execution */
  executionResult: ExecutionResult | null;
  /** Ordered history of all completed steps */
  history: AgentStep[];
  /** Current lifecycle status of the agent */
  status: AgentStatus;
  /** Reason for termination (set when status becomes completed/failed/stopped) */
  terminationReason?: TerminationReason;
  /** Total number of steps completed so far */
  stepCount: number;
  /** Maximum allowed steps before forced termination */
  maxSteps: number;
}

// ─── Agent Run Config ─────────────────────────────────────────
export interface AgentConfig {
  /** Max steps before agent auto-stops. Default: 20 */
  maxSteps?: number;
  /** Max consecutive grounding failures before stopping. Default: 3 */
  maxGroundingFailures?: number;
  /** Max consecutive execution failures before stopping. Default: 3 */
  maxExecutionFailures?: number;
  /** Whether to continue after a single execution failure. Default: true */
  continueOnExecutionFailure?: boolean;
  /** Milliseconds delay between steps. Default: 200 */
  stepDelayMs?: number;
  /** Test case ID to attach to execution records. Default: auto-generated UUID */
  testCaseId?: string;
}

// ─── Agent Run Result ─────────────────────────────────────────
export interface AgentRunResult {
  /** Final agent status */
  status: AgentStatus;
  /** Reason the agent stopped */
  terminationReason: TerminationReason;
  /** User goal that was attempted */
  goal: string;
  /** Ordered list of all steps executed */
  history: AgentStep[];
  /** Total steps executed */
  stepCount: number;
  /** Total wall-clock duration in milliseconds */
  durationMs: number;
  /** Whether the goal was achieved */
  goalAchieved: boolean;
  /** Final page observation */
  finalObservation: Observation | null;
}

// ─── Planner Request ─────────────────────────────────────────
export interface PlannerRequest {
  /** Natural language goal */
  goal: string;
  /** Current page observation */
  observation: Observation;
  /** History of previous steps for context */
  history: AgentStep[];
}

// ─── Planner Response ─────────────────────────────────────────
export interface PlannerResponse {
  /** Next action to attempt (or null if goal is complete / impossible) */
  nextAction: TestAction | null;
  /** Planner's textual reasoning (for logging/debugging) */
  reasoning: string;
  /** Whether the planner believes the goal has been achieved */
  goalAchieved: boolean;
}
