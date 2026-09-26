import { TestAction } from '../models/schemas';
import { Observation } from '../observer/types';

// ============================================================
// BFS Explorer Types – web-test-agent / src/explorer/types.ts
// Data contracts for State Nodes, Transitions, and Metrics.
// ============================================================

export interface StateNode {
  /** Deterministic SHA-256 fingerprint of the state */
  stateId: string;
  /** Actual page URL */
  url: string;
  /** Normalized URL */
  normalizedUrl: string;
  /** Page title */
  title: string;
  /** Breadth-First depth level (root = 0) */
  depth: number;
  /** State ID of the parent node */
  parentStateId?: string;
  /** The action from the parent that led to this state */
  actionFromParent?: TestAction;
  /** Sequence of actions from entry state to reproduce this state */
  pathFromRoot: TestAction[];
  /** Full observation snapshot of the page */
  observation: Observation;
  /** Discovered timestamp in ISO format */
  discoveredAt: string;
}

export interface StateTransition {
  /** Source state ID */
  fromStateId: string;
  /** Resulting state ID (if action succeeded and state was observed) */
  toStateId?: string;
  /** The action executed */
  action: TestAction;
  /** Whether the action execution succeeded */
  success: boolean;
  /** Error message if action failed */
  error?: string;
  /** Execution duration in ms */
  durationMs: number;
}

export interface ExplorationConfig {
  /** Maximum BFS depth limit (default: 3) */
  maxDepth?: number;
  /** Maximum number of unique states to discover (default: 30) */
  maxStates?: number;
  /** Maximum number of interactive actions to explore per state (default: 10) */
  maxActionsPerState?: number;
  /** Timeout for action execution in ms (default: 10000) */
  actionTimeoutMs?: number;
}

export interface ExplorationMetrics {
  statesDiscovered: number;
  statesVisited: number;
  actionsDiscovered: number;
  actionsAttempted: number;
  actionsSucceeded: number;
  actionsFailed: number;
  duplicateStates: number;
  duplicateActions: number;
  maxDepthReached: number;
  durationMs: number;
}

export interface ExplorationResult {
  success: boolean;
  initialStateId: string;
  states: StateNode[];
  transitions: StateTransition[];
  metrics: ExplorationMetrics;
}
