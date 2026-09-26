/**
 * M4 Unit Tests – BFS Explorer Engine Suite
 *
 * Validates:
 * 1. State Normalization (ephemeral param stripping, SPA hash preservation, file URLs)
 * 2. Deterministic State Hash computation (order invariance, collision resistance)
 * 3. Element signature extraction from ElementDescriptors
 * 4. StateNode factory and metadata binding
 * 5. FrontierQueue FIFO ordering, peek, size, isEmpty, and clear
 * 6. ActionDiscovery (buttons, links, inputs, selects, actionKey, maxActions)
 * 7. BFS traversal order, depth limit enforcement, maxStates cap
 * 8. State deduplication and loop detection (A -> B -> A)
 * 9. Action failure resilience (grounding failure, execution failure)
 * 10. Exploration metrics calculation
 */

import { normalizeUrl, extractElementSignatures, createStateNode } from '../../src/explorer/state';
import { computeStateHash } from '../../src/explorer/state-hash';
import { FrontierQueue } from '../../src/explorer/frontier';
import { ActionDiscovery } from '../../src/explorer/action-discovery';
import { BfsExplorer } from '../../src/explorer/bfs-explorer';
import { ElementDescriptor, ExecutionResult, TestAction } from '../../src/models/schemas';
import { Observation } from '../../src/observer/types';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { Executor } from '../../src/executor/executor';

// ─── Test Fixtures ─────────────────────────────────────────────

function createMockObservation(
  url: string,
  title: string,
  elements: ElementDescriptor[] = []
): Observation {
  return {
    page: {
      url,
      title,
      dom: '<html></html>',
    },
    elements,
    network: [],
    console: [],
    captured_at: new Date().toISOString(),
  };
}

function mockPassResult(actionId: string = 'test', durationMs: number = 30): ExecutionResult {
  return {
    action_id: actionId,
    test_case_id: 'tc-1',
    status: 'passed',
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
  };
}

function mockFailResult(
  actionId: string = 'test',
  error: string = 'Element click intercepted',
  durationMs: number = 100
): ExecutionResult {
  return {
    action_id: actionId,
    test_case_id: 'tc-1',
    status: 'failed',
    error_message: error,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
  };
}

const mockButtons: ElementDescriptor[] = [
  {
    tag: 'button',
    id: 'login-btn',
    name: 'login',
    text: 'Đăng nhập',
    role: 'button',
    css_selector: '#login-btn',
    bounding_box: { x: 10, y: 10, width: 100, height: 40 },
  },
  {
    tag: 'a',
    id: 'about-link',
    text: 'About Us',
    role: 'link',
    css_selector: '#about-link',
    bounding_box: { x: 10, y: 60, width: 80, height: 20 },
  },
  {
    tag: 'input',
    id: 'email-input',
    name: 'email',
    type: 'email',
    placeholder: 'Enter email',
    css_selector: '#email-input',
    bounding_box: { x: 10, y: 90, width: 200, height: 30 },
  },
  {
    tag: 'select',
    id: 'role-select',
    name: 'role',
    role: 'combobox',
    css_selector: '#role-select',
    bounding_box: { x: 10, y: 130, width: 120, height: 30 },
  },
];

describe('M4 Unit Tests: BFS Explorer Engine', () => {

  // ─── 1. State Normalization & URL Handling ───────────────────
  describe('State Normalization', () => {
    it('1.1 should strip ephemeral query parameters from HTTP URLs', () => {
      const url = 'https://example.com/app?user=admin&t=1690000000&nonce=xyz123&session=active';
      const normalized = normalizeUrl(url);
      expect(normalized).toContain('user=admin');
      expect(normalized).toContain('session=active');
      expect(normalized).not.toContain('t=1690000000');
      expect(normalized).not.toContain('nonce=xyz123');
    });

    it('1.2 should preserve routing hashes for SPA navigation', () => {
      const url = 'https://example.com/app?timestamp=999#dashboard/settings';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/app#dashboard/settings');
    });

    it('1.3 should correctly normalize file:// URLs with hash routes', () => {
      const fileUrl = 'file:///D:/app/index.html#settings';
      const normalized = normalizeUrl(fileUrl);
      expect(normalized).toBe('file:///d:/app/index.html#settings');
    });

    it('1.4 should handle clean URLs without query parameters or hash', () => {
      const url = 'https://example.com/about';
      const normalized = normalizeUrl(url);
      expect(normalized).toBe('https://example.com/about');
    });
  });

  // ─── 2. State Hash Computation ───────────────────────────────
  describe('State Hash Computation', () => {
    it('2.1 should compute identical hashes for identical states', () => {
      const signatures = ['button|button|btn-1|||submit', 'input||user|user|text|'];
      const hash1 = computeStateHash('https://app.test/page', signatures, 'Dashboard');
      const hash2 = computeStateHash('https://app.test/page', signatures, 'Dashboard');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex string
    });

    it('2.2 should be sort-invariant with respect to element order', () => {
      const sigsA = ['input||a||text|', 'button|button|b|||ok', 'a|link|c|||home'];
      const sigsB = ['a|link|c|||home', 'input||a||text|', 'button|button|b|||ok'];
      const hashA = computeStateHash('https://app.test/page', sigsA, 'Title');
      const hashB = computeStateHash('https://app.test/page', sigsB, 'Title');
      expect(hashA).toBe(hashB);
    });

    it('2.3 should produce different hashes for different URLs', () => {
      const signatures = ['button|button|btn-1|||submit'];
      const hash1 = computeStateHash('https://app.test/page1', signatures, 'Title');
      const hash2 = computeStateHash('https://app.test/page2', signatures, 'Title');
      expect(hash1).not.toBe(hash2);
    });

    it('2.4 should produce different hashes for different titles', () => {
      const signatures = ['button|button|btn-1|||submit'];
      const hash1 = computeStateHash('https://app.test/page', signatures, 'Title A');
      const hash2 = computeStateHash('https://app.test/page', signatures, 'Title B');
      expect(hash1).not.toBe(hash2);
    });

    it('2.5 should produce different hashes when interactive elements change', () => {
      const sigs1 = ['button|button|login|||login'];
      const sigs2 = ['button|button|logout|||logout'];
      const hash1 = computeStateHash('https://app.test/page', sigs1, 'Title');
      const hash2 = computeStateHash('https://app.test/page', sigs2, 'Title');
      expect(hash1).not.toBe(hash2);
    });
  });

  // ─── 3. Element Signatures & StateNode Factory ───────────────
  describe('Element Signatures & StateNode Creation', () => {
    it('3.1 should extract deterministic signatures from element descriptors', () => {
      const elements: ElementDescriptor[] = [
        { tag: 'BUTTON', role: 'button', id: 'SUBMIT', name: 'btn', text: '  Submit Form  ' },
        { tag: 'input', type: 'password', id: 'pwd' },
      ];
      const signatures = extractElementSignatures(elements);
      expect(signatures).toEqual([
        'button|button|submit|btn||submit form',
        'input||pwd||password|',
      ]);
    });

    it('3.2 should create a valid StateNode with correct initial depth and metadata', () => {
      const obs = createMockObservation('https://app.test/home', 'Home Page', mockButtons);
      const node = createStateNode(obs, 0, []);

      expect(node.stateId).toBeDefined();
      expect(node.stateId).toHaveLength(64);
      expect(node.url).toBe('https://app.test/home');
      expect(node.normalizedUrl).toBe('https://app.test/home');
      expect(node.title).toBe('Home Page');
      expect(node.depth).toBe(0);
      expect(node.parentStateId).toBeUndefined();
      expect(node.pathFromRoot).toEqual([]);
      expect(node.discoveredAt).toBeDefined();
    });

    it('3.3 should properly record parentStateId and actionFromParent on child node', () => {
      const obs = createMockObservation('https://app.test/settings', 'Settings', []);
      const parentAction: TestAction = {
        id: 'act-1',
        type: 'click',
        target_description: '#settings-btn',
      };
      const node = createStateNode(obs, 2, [parentAction], 'parent-state-id', parentAction);

      expect(node.depth).toBe(2);
      expect(node.parentStateId).toBe('parent-state-id');
      expect(node.actionFromParent).toEqual(parentAction);
      expect(node.pathFromRoot).toHaveLength(1);
    });
  });

  // ─── 4. FrontierQueue (FIFO) ─────────────────────────────────
  describe('FrontierQueue', () => {
    let queue: FrontierQueue;

    beforeEach(() => {
      queue = new FrontierQueue();
    });

    it('4.1 should initialize empty', () => {
      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.peek()).toBeUndefined();
      expect(queue.dequeue()).toBeUndefined();
    });

    it('4.2 should maintain strict FIFO ordering', () => {
      const obs = createMockObservation('https://app.test/1', '1');
      const node1 = createStateNode(obs, 0);
      const node2 = createStateNode(obs, 1);
      const node3 = createStateNode(obs, 2);

      queue.enqueue(node1);
      queue.enqueue(node2);
      queue.enqueue(node3);

      expect(queue.size()).toBe(3);
      expect(queue.isEmpty()).toBe(false);
      expect(queue.peek()?.depth).toBe(0);

      expect(queue.dequeue()?.depth).toBe(0);
      expect(queue.dequeue()?.depth).toBe(1);
      expect(queue.dequeue()?.depth).toBe(2);
      expect(queue.isEmpty()).toBe(true);
    });

    it('4.3 should clear all queued nodes', () => {
      const obs = createMockObservation('https://app.test/1', '1');
      queue.enqueue(createStateNode(obs, 0));
      queue.enqueue(createStateNode(obs, 1));
      expect(queue.size()).toBe(2);

      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  // ─── 5. Action Discovery ─────────────────────────────────────
  describe('ActionDiscovery', () => {
    let discovery: ActionDiscovery;

    beforeEach(() => {
      discovery = new ActionDiscovery();
    });

    it('5.1 should discover click actions for buttons and links', () => {
      const obs = createMockObservation('https://app.test', 'Test', [
        mockButtons[0], // button
        mockButtons[1], // a link
      ]);

      const actions = discovery.discoverActions(obs);
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('click');
      expect(actions[0].target_description).toBe('Đăng nhập');
      expect(actions[1].type).toBe('click');
      expect(actions[1].target_description).toBe('About Us link');
    });

    it('5.2 should discover fill actions for inputs', () => {
      const obs = createMockObservation('https://app.test', 'Test', [
        mockButtons[2], // email input
      ]);

      const actions = discovery.discoverActions(obs);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('fill');
      expect(actions[0].value).toBe('admin@example.com');
    });

    it('5.3 should discover select actions for dropdowns', () => {
      const obs = createMockObservation('https://app.test', 'Test', [
        mockButtons[3], // select role
      ]);

      const actions = discovery.discoverActions(obs);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('select');
      expect(actions[0].value).toBe('tester');
    });

    it('5.4 should respect maxActions limit', () => {
      const obs = createMockObservation('https://app.test', 'Test', mockButtons);
      const actions = discovery.discoverActions(obs, 2);
      expect(actions).toHaveLength(2);
    });

    it('5.5 should generate deterministic actionKey for deduplication', () => {
      const action: TestAction = {
        id: '123',
        type: 'click',
        target_description: '  Login Button  ',
      };
      const key1 = discovery.computeActionKey('state-abc', action);
      const key2 = discovery.computeActionKey('state-abc', {
        ...action,
        id: '456',
        target_description: 'login button',
      });
      expect(key1).toBe(key2);
      expect(key1).toBe('state-abc::click::login button::');
    });
  });

  // ─── 6. BFS Exploration Traversal & Logic ─────────────────────
  describe('BFS Traversal, Deduplication & Resilience', () => {
    let mockObserver: jest.Mocked<Observer>;
    let mockGrounding: jest.Mocked<GroundingEngine>;
    let mockExecutor: jest.Mocked<Executor>;

    beforeEach(() => {
      mockObserver = {
        observe: jest.fn(),
        attach: jest.fn(),
        detach: jest.fn(),
      } as any;

      mockGrounding = {
        groundAction: jest.fn(),
      } as any;

      mockExecutor = {
        execute: jest.fn(),
      } as any;
    });

    it('6.1 should explore states in BFS order and obey maxDepth limit', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://app.test/root'),
        title: jest.fn().mockResolvedValue('Root'),
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      } as any;

      const rootObs = createMockObservation('https://app.test/root', 'Root State', [
        { tag: 'button', id: 'btn-depth1', text: 'To Depth 1' },
      ]);
      const depth1Obs = createMockObservation('https://app.test/d1', 'Depth 1 State', [
        { tag: 'button', id: 'btn-depth2', text: 'To Depth 2' },
      ]);

      mockObserver.observe
        .mockResolvedValueOnce(rootObs)    // Initial root observation
        .mockResolvedValueOnce(depth1Obs);  // Observation after btn-depth1

      mockGrounding.groundAction.mockImplementation(async (action) => ({
        success: true,
        action: { ...action, target_description: `#${action.target_description}` },
        result: {} as any,
      }));

      mockExecutor.execute.mockResolvedValue(mockPassResult('test', 50));

      const explorer = new BfsExplorer(mockObserver, mockGrounding, mockExecutor, {
        maxDepth: 1, // Stop child expansion at depth 1
        maxStates: 10,
      });

      const result = await explorer.explore(mockPage);

      expect(result.success).toBe(true);
      expect(result.states).toHaveLength(2); // Root (0) + Depth 1 (1)
      expect(result.metrics.maxDepthReached).toBe(1);
      expect(result.states[0].depth).toBe(0);
      expect(result.states[1].depth).toBe(1);
      expect(result.metrics.actionsAttempted).toBe(1);
    });

    it('6.2 should detect loops and avoid infinite cycles (A -> B -> A)', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://app.test/a'),
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      } as any;

      const obsA = createMockObservation('https://app.test/a', 'State A', [
        { tag: 'button', id: 'go-b', text: 'Go To B' },
      ]);
      const obsB = createMockObservation('https://app.test/b', 'State B', [
        { tag: 'button', id: 'back-a', text: 'Back To A' },
      ]);

      mockObserver.observe
        .mockResolvedValueOnce(obsA) // initial root
        .mockResolvedValueOnce(obsB) // after go-b
        .mockResolvedValueOnce(obsA); // after back-a (returns to A)

      mockGrounding.groundAction.mockImplementation(async (action) => ({
        success: true,
        action,
        result: {} as any,
      }));

      mockExecutor.execute.mockResolvedValue(mockPassResult('test', 30));

      const explorer = new BfsExplorer(mockObserver, mockGrounding, mockExecutor, {
        maxDepth: 5,
        maxStates: 10,
      });

      const result = await explorer.explore(mockPage);

      expect(result.success).toBe(true);
      expect(result.states).toHaveLength(2);
      expect(result.metrics.duplicateStates).toBe(1);
      expect(result.transitions).toHaveLength(2);
      expect(result.transitions[0].toStateId).toBe(result.states[1].stateId);
      expect(result.transitions[1].toStateId).toBe(result.states[0].stateId);
    });

    it('6.3 should respect maxStates limit and halt exploration', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://app.test/start'),
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      } as any;

      const obsRoot = createMockObservation('https://app.test/start', 'Root', [
        { tag: 'button', id: 'btn-1', text: 'One' },
        { tag: 'button', id: 'btn-2', text: 'Two' },
        { tag: 'button', id: 'btn-3', text: 'Three' },
      ]);

      mockObserver.observe
        .mockResolvedValueOnce(obsRoot)
        .mockResolvedValueOnce(createMockObservation('https://app.test/1', 'State 1'))
        .mockResolvedValueOnce(createMockObservation('https://app.test/2', 'State 2'));

      mockGrounding.groundAction.mockImplementation(async (action) => ({
        success: true,
        action,
        result: {} as any,
      }));

      mockExecutor.execute.mockResolvedValue(mockPassResult('test', 10));

      const explorer = new BfsExplorer(mockObserver, mockGrounding, mockExecutor, {
        maxStates: 2, // Stop when 2 states are reached (Root + 1 child)
        maxDepth: 5,
      });

      const result = await explorer.explore(mockPage);

      expect(result.states).toHaveLength(2);
      expect(result.metrics.statesDiscovered).toBe(2);
    });

    it('6.4 should handle action grounding failure gracefully and continue BFS', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://app.test/root'),
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      } as any;

      const obsRoot = createMockObservation('https://app.test/root', 'Root', [
        { tag: 'button', id: 'bad-btn', text: 'Unresolvable Button' },
        { tag: 'button', id: 'good-btn', text: 'Valid Button' },
      ]);
      const obsNext = createMockObservation('https://app.test/next', 'Next State');

      mockObserver.observe
        .mockResolvedValueOnce(obsRoot)
        .mockResolvedValueOnce(obsNext);

      mockGrounding.groundAction
        .mockResolvedValueOnce({ success: false, action: null as any, result: {} as any })
        .mockResolvedValueOnce({
          success: true,
          action: { id: '2', type: 'click', target_description: '#good-btn' },
          result: {} as any,
        });

      mockExecutor.execute.mockResolvedValue(mockPassResult('2', 20));

      const explorer = new BfsExplorer(mockObserver, mockGrounding, mockExecutor, {
        maxDepth: 2,
        maxStates: 10,
      });

      const result = await explorer.explore(mockPage);

      expect(result.success).toBe(true);
      expect(result.metrics.actionsAttempted).toBe(2);
      expect(result.metrics.actionsFailed).toBe(1);
      expect(result.metrics.actionsSucceeded).toBe(1);
      expect(result.transitions[0].success).toBe(false);
      expect(result.transitions[0].error).toContain('Grounding resolution failed');
      expect(result.transitions[1].success).toBe(true);
      expect(result.states).toHaveLength(2);
    });

    it('6.5 should handle action execution failure gracefully and continue BFS', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://app.test/root'),
        goto: jest.fn().mockResolvedValue(undefined),
        waitForTimeout: jest.fn().mockResolvedValue(undefined),
      } as any;

      const obsRoot = createMockObservation('https://app.test/root', 'Root', [
        { tag: 'button', id: 'broken-btn', text: 'Broken Button' },
        { tag: 'button', id: 'working-btn', text: 'Working Button' },
      ]);
      const obsNext = createMockObservation('https://app.test/next', 'Next State');

      mockObserver.observe
        .mockResolvedValueOnce(obsRoot)
        .mockResolvedValueOnce(obsNext);

      mockGrounding.groundAction.mockImplementation(async (action) => ({
        success: true,
        action,
        result: {} as any,
      }));

      mockExecutor.execute
        .mockResolvedValueOnce(mockFailResult('1', 'Element click intercepted', 100))
        .mockResolvedValueOnce(mockPassResult('2', 30));

      const explorer = new BfsExplorer(mockObserver, mockGrounding, mockExecutor, {
        maxDepth: 2,
        maxStates: 10,
      });

      const result = await explorer.explore(mockPage);

      expect(result.success).toBe(true);
      expect(result.metrics.actionsFailed).toBe(1);
      expect(result.metrics.actionsSucceeded).toBe(1);
      expect(result.transitions[0].success).toBe(false);
      expect(result.transitions[0].error).toBe('Element click intercepted');
      expect(result.transitions[1].success).toBe(true);
      expect(result.states).toHaveLength(2);
    });
  });
});
