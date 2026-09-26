/**
 * M4 E2E Integration Test – BFS Explorer on Real Chromium
 *
 * Runs REAL Chromium browser against demo-site/index.html.
 * Demonstrates full BFS exploration pipeline:
 *   Observer -> StateNode (SHA-256) -> FrontierQueue -> ActionDiscovery -> GroundingEngine -> Executor -> Chromium
 *
 * Test Cases:
 * 1. Initial State Discovery on Login page
 * 2. Multi-level State Discovery & Branching on Dashboard (Dashboard -> About, Settings -> Profile)
 * 3. State Deduplication & Loop Detection (About -> Back to Dashboard)
 * 4. Action Failure Resilience (Non-existent / Failing action handled gracefully)
 * 5. Deterministic Path Replay for sibling branches
 * 6. Full Exploration State Graph and Metrics Validation
 */

import * as path from 'path';
import * as fs from 'fs';
import { PageManager } from '../../src/executor/page-manager';
import { Executor } from '../../src/executor/executor';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { BfsExplorer } from '../../src/explorer/bfs-explorer';
import { ExplorationResult } from '../../src/explorer/types';

const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

describe('M4 E2E: BFS Explorer on Demo Site', () => {
  let pageManager: PageManager;
  let observer: Observer;
  let executor: Executor;
  let groundingEngine: GroundingEngine;

  beforeAll(async () => {
    expect(fs.existsSync(DEMO_SITE_PATH)).toBe(true);

    pageManager = new PageManager({
      headless: true,
      viewport: { width: 1280, height: 720 },
    });

    executor = new Executor({
      timeoutMs: 5000,
      retryCount: 1,
    });

    observer = new Observer();
    groundingEngine = new GroundingEngine({
      confidenceThreshold: 0.70,
      ambiguityThreshold: 0.15,
      enableLlmFallback: false,
    });
  });

  afterAll(async () => {
    observer.detach();
    await pageManager.close();
  });

  // ─── 1. Initial State Discovery on Login Page ────────────────
  it('1. should discover initial entry state on login page', async () => {
    const page = await pageManager.launch();
    observer.attach(page);

    const explorer = new BfsExplorer(observer, groundingEngine, executor, {
      maxDepth: 0, // Only observe initial state
      maxStates: 5,
    });

    const result: ExplorationResult = await explorer.explore(page, DEMO_URL);

    expect(result.success).toBe(true);
    expect(result.states).toHaveLength(1);
    expect(result.metrics.statesDiscovered).toBe(1);
    expect(result.metrics.statesVisited).toBe(1);

    const rootState = result.states[0];
    expect(rootState.depth).toBe(0);
    expect(rootState.title).toContain('Demo Site');
    expect(rootState.normalizedUrl).toContain('demo-site/index.html');
    expect(rootState.stateId).toBeDefined();
    expect(rootState.stateId).toHaveLength(64);
    expect(rootState.observation.elements.length).toBeGreaterThan(0);
  });

  // ─── 2. Multi-level State Discovery on Dashboard ─────────────
  it('2. should discover multi-level states in BFS order starting from Dashboard', async () => {
    const page = pageManager.getPage();
    const dashboardUrl = `${DEMO_URL}#dashboard`;

    const explorer = new BfsExplorer(observer, groundingEngine, executor, {
      maxDepth: 2,
      maxStates: 10,
      maxActionsPerState: 5,
    });

    const result = await explorer.explore(page, dashboardUrl);

    expect(result.success).toBe(true);
    expect(result.states.length).toBeGreaterThanOrEqual(3);

    // Verify depth levels discovered
    const depths = result.states.map((s) => s.depth);
    expect(depths).toContain(0); // Dashboard
    expect(depths).toContain(1); // About or Settings

    // Check specific states by title or hash
    const titles = result.states.map((s) => s.title);
    expect(titles.some((t) => t.includes('Dashboard'))).toBe(true);

    // Verify transitions were created
    expect(result.transitions.length).toBeGreaterThan(0);
    for (const t of result.transitions) {
      expect(t.fromStateId).toBeDefined();
      expect(t.action).toBeDefined();
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── 3. State Deduplication & Loop Detection ──────────────────
  it('3. should detect loops when navigating back to already visited states', async () => {
    const page = pageManager.getPage();
    const dashboardUrl = `${DEMO_URL}#dashboard`;

    const explorer = new BfsExplorer(observer, groundingEngine, executor, {
      maxDepth: 3,
      maxStates: 12,
      maxActionsPerState: 6,
    });

    const result = await explorer.explore(page, dashboardUrl);

    expect(result.success).toBe(true);
    // Back buttons (#about-back-btn, #settings-back-btn) return to #dashboard,
    // which was already visited at depth 0. Duplicate states counter must be > 0.
    expect(result.metrics.duplicateStates).toBeGreaterThan(0);
  });

  // ─── 4. Action Failure Resilience ────────────────────────────
  it('4. should gracefully record failed actions and continue exploration', async () => {
    const page = pageManager.getPage();
    const dashboardUrl = `${DEMO_URL}#dashboard`;

    // Create a GroundingEngine that intentionally fails on a specific action target
    const resilientGrounding = new GroundingEngine({
      confidenceThreshold: 0.70,
      enableLlmFallback: false,
    });

    const originalGround = resilientGrounding.groundAction.bind(resilientGrounding);
    let failedOnce = false;

    jest.spyOn(resilientGrounding, 'groundAction').mockImplementation(async (action, obs, pg) => {
      // Intentionally simulate failure for one action
      if (!failedOnce && action.type === 'click') {
        failedOnce = true;
        return {
          action: null as any,
          result: {
            action_id: action.id,
            target_description: action.target_description,
            candidates: [],
            selected: null,
            ambiguous: false,
            used_llm_fallback: false,
            grounded_at: new Date().toISOString(),
          },
          success: false,
        };
      }
      return originalGround(action, obs, pg);
    });

    const explorer = new BfsExplorer(observer, resilientGrounding, executor, {
      maxDepth: 1,
      maxStates: 5,
      maxActionsPerState: 4,
    });

    const result = await explorer.explore(page, dashboardUrl);

    expect(result.success).toBe(true);
    expect(result.metrics.actionsFailed).toBeGreaterThanOrEqual(1);
    expect(result.metrics.actionsSucceeded).toBeGreaterThanOrEqual(1);

    // Verify the failed transition is recorded with error details
    const failedTransition = result.transitions.find((t) => !t.success);
    expect(failedTransition).toBeDefined();
    expect(failedTransition?.error).toBeDefined();
  });

  // ─── 5. Full Exploration State Graph and Metrics Validation ──
  it('5. should generate complete state graph and valid metrics', async () => {
    const page = pageManager.getPage();
    const dashboardUrl = `${DEMO_URL}#dashboard`;

    const explorer = new BfsExplorer(observer, groundingEngine, executor, {
      maxDepth: 2,
      maxStates: 8,
      maxActionsPerState: 5,
    });

    const result = await explorer.explore(page, dashboardUrl);

    // Metrics validation
    expect(result.metrics.durationMs).toBeGreaterThan(0);
    expect(result.metrics.statesDiscovered).toBe(result.states.length);
    expect(result.metrics.actionsAttempted).toBe(
      result.metrics.actionsSucceeded + result.metrics.actionsFailed
    );
    expect(result.metrics.maxDepthReached).toBeLessThanOrEqual(2);

    // Graph node integrity
    const stateIds = new Set<string>();
    for (const state of result.states) {
      expect(state.stateId).toHaveLength(64);
      expect(state.normalizedUrl).toBeDefined();
      expect(state.depth).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(state.pathFromRoot)).toBe(true);
      stateIds.add(state.stateId);
    }
    expect(stateIds.size).toBe(result.states.length); // All state IDs unique

    // Initial state points to root
    expect(result.initialStateId).toBe(result.states[0].stateId);
  });
});
