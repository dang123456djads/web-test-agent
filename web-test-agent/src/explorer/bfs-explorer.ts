import { Page } from 'playwright';
import { getLogger } from '../logger';
import { Executor } from '../executor/executor';
import { Observer } from '../observer/observer';
import { GroundingEngine } from '../grounding/grounding-engine';
import { TestAction } from '../models/schemas';
import { ActionDiscovery } from './action-discovery';
import { FrontierQueue } from './frontier';
import { createStateNode } from './state';
import {
  ExplorationConfig,
  ExplorationMetrics,
  ExplorationResult,
  StateNode,
  StateTransition,
} from './types';

// ============================================================
// BFS Explorer – web-test-agent / src/explorer/bfs-explorer.ts
// Breadth-First Search web application exploration engine.
// Orchestrates Observer, Grounding, Executor, State Deduplication,
// and Deterministic Path Replay.
// ============================================================

const log = getLogger('bfs-explorer');

const DEFAULT_CONFIG: Required<ExplorationConfig> = {
  maxDepth: 3,
  maxStates: 30,
  maxActionsPerState: 8,
  actionTimeoutMs: 10_000,
};

export class BfsExplorer {
  private readonly config: Required<ExplorationConfig>;
  private readonly observer: Observer;
  private readonly groundingEngine: GroundingEngine;
  private readonly executor: Executor;
  private readonly actionDiscovery: ActionDiscovery;

  constructor(
    observer: Observer,
    groundingEngine: GroundingEngine,
    executor: Executor,
    config: ExplorationConfig = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.observer = observer;
    this.groundingEngine = groundingEngine;
    this.executor = executor;
    this.actionDiscovery = new ActionDiscovery();
  }

  /**
   * Run BFS state exploration on the target page starting from its current state or startUrl.
   */
  async explore(page: Page, startUrl?: string): Promise<ExplorationResult> {
    const startTime = Date.now();
    const frontier = new FrontierQueue();
    const visitedStates = new Map<string, StateNode>();
    const visitedActionKeys = new Set<string>();
    const transitions: StateTransition[] = [];

    let actionsDiscovered = 0;
    let actionsAttempted = 0;
    let actionsSucceeded = 0;
    let actionsFailed = 0;
    let duplicateStates = 0;
    let duplicateActions = 0;
    let maxDepthReached = 0;

    log.info(
      {
        event: 'exploration_start',
        maxDepth: this.config.maxDepth,
        maxStates: this.config.maxStates,
      },
      'Starting BFS web application exploration'
    );

    // ─── 1. Initialize Root State ──────────────────────────────
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    }

    const entryUrl = page.url();
    const rootObs = await this.observer.observe(page);
    const rootNode = createStateNode(rootObs, 0, []);

    visitedStates.set(rootNode.stateId, rootNode);
    frontier.enqueue(rootNode);

    log.info(
      {
        event: 'state_discovered',
        stateId: rootNode.stateId,
        url: rootNode.url,
        title: rootNode.title,
        depth: 0,
      },
      `Discovered initial state: "${rootNode.title}"`
    );

    // ─── 2. BFS Main Loop ──────────────────────────────────────
    let currentStateId: string = rootNode.stateId;

    while (!frontier.isEmpty() && visitedStates.size < this.config.maxStates) {
      const current = frontier.dequeue()!;

      log.info(
        {
          event: 'state_dequeued',
          stateId: current.stateId,
          depth: current.depth,
          remainingQueue: frontier.size(),
        },
        `Dequeued state (depth ${current.depth}) for expansion`
      );

      // Check depth limit
      if (current.depth >= this.config.maxDepth) {
        log.info(
          { event: 'depth_limit', depth: current.depth, stateId: current.stateId },
          `Reached maxDepth limit (${this.config.maxDepth}), skipping child expansion`
        );
        continue;
      }

      // Discover candidate interactive actions from current state's observation
      const actions = this.actionDiscovery.discoverActions(
        current.observation,
        this.config.maxActionsPerState
      );
      actionsDiscovered += actions.length;

      for (const action of actions) {
        if (visitedStates.size >= this.config.maxStates) {
          log.info({ event: 'max_states_limit' }, 'Reached maxStates limit, halting BFS');
          break;
        }

        // Action Deduplication
        const actionKey = this.actionDiscovery.computeActionKey(current.stateId, action);
        if (visitedActionKeys.has(actionKey)) {
          duplicateActions++;
          continue;
        }
        visitedActionKeys.add(actionKey);
        actionsAttempted++;

        const actionStart = Date.now();

        // Ensure browser is at the target state via deterministic replay
        if (currentStateId !== current.stateId) {
          await this.replayPath(page, entryUrl, current.pathFromRoot);
          currentStateId = current.stateId;
        }

        // Ground action using GroundingEngine M3
        const grounded = await this.groundingEngine.groundAction(
          action,
          current.observation,
          page
        );

        if (!grounded.success || !grounded.action) {
          actionsFailed++;
          const durationMs = Date.now() - actionStart;
          transitions.push({
            fromStateId: current.stateId,
            action,
            success: false,
            error: 'Grounding resolution failed',
            durationMs,
          });
          log.warn(
            { event: 'action_grounding_failed', action: action.target_description },
            'Action failed grounding resolution'
          );
          continue;
        }

        // Execute action via Executor M1
        log.info(
          {
            event: 'action_started',
            stateId: current.stateId,
            action: grounded.action.type,
            target: grounded.action.target_description,
          },
          `Executing action: ${grounded.action.type} -> ${grounded.action.target_description}`
        );

        const execResult = await this.executor.execute(grounded.action, page);
        const actionDuration = Date.now() - actionStart;

        if (execResult.status !== 'passed') {
          actionsFailed++;
          transitions.push({
            fromStateId: current.stateId,
            action: grounded.action,
            success: false,
            error: execResult.error_message,
            durationMs: actionDuration,
          });
          log.warn(
            { event: 'action_failed', error: execResult.error_message },
            'Action execution failed, continuing BFS'
          );
          // Invalidate current browser state after failure
          currentStateId = 'invalidated';
          continue;
        }

        actionsSucceeded++;

        // Brief delay for DOM transitions to stabilize
        await page.waitForTimeout(100);

        // Capture resulting state via Observer M2
        const nextObs = await this.observer.observe(page);
        const nextDepth = current.depth + 1;
        const nextPath = [...current.pathFromRoot, grounded.action];
        const nextNode = createStateNode(
          nextObs,
          nextDepth,
          nextPath,
          current.stateId,
          grounded.action
        );

        currentStateId = nextNode.stateId;

        // Record State Transition Edge
        transitions.push({
          fromStateId: current.stateId,
          toStateId: nextNode.stateId,
          action: grounded.action,
          success: true,
          durationMs: actionDuration,
        });

        // State Deduplication & Loop Detection
        if (visitedStates.has(nextNode.stateId)) {
          duplicateStates++;
          log.info(
            {
              event: 'state_duplicate',
              from: current.stateId,
              to: nextNode.stateId,
              title: nextNode.title,
            },
            `Encountered previously visited state / loop (${nextNode.title}), skipping enqueue`
          );
        } else {
          visitedStates.set(nextNode.stateId, nextNode);
          frontier.enqueue(nextNode);
          maxDepthReached = Math.max(maxDepthReached, nextDepth);

          log.info(
            {
              event: 'state_discovered',
              stateId: nextNode.stateId,
              title: nextNode.title,
              depth: nextDepth,
              totalDiscovered: visitedStates.size,
            },
            `Discovered new state at depth ${nextDepth}: "${nextNode.title}"`
          );
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const metrics: ExplorationMetrics = {
      statesDiscovered: visitedStates.size,
      statesVisited: visitedStates.size - frontier.size(),
      actionsDiscovered,
      actionsAttempted,
      actionsSucceeded,
      actionsFailed,
      duplicateStates,
      duplicateActions,
      maxDepthReached,
      durationMs,
    };

    log.info(
      {
        event: 'exploration_complete',
        states: visitedStates.size,
        transitions: transitions.length,
        duration_ms: durationMs,
      },
      'BFS web exploration completed'
    );

    return {
      success: true,
      initialStateId: rootNode.stateId,
      states: Array.from(visitedStates.values()),
      transitions,
      metrics,
    };
  }

  /**
   * Deterministically reset and replay actions from entry URL to reach a specific state.
   */
  private async replayPath(page: Page, entryUrl: string, path: TestAction[]): Promise<void> {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    for (const step of path) {
      await this.executor.execute(step, page);
      await page.waitForTimeout(50);
    }
  }
}
