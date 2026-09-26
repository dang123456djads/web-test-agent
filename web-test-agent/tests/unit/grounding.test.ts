/**
 * M3 Unit Tests – Grounding Engine Suite
 *
 * Validates:
 * 1. Candidate generation (ID, role, text, aria-label, placeholder, CSS)
 * 2. Deterministic ranking and scoring with explainable evidence
 * 3. Deduplication of equivalent locators
 * 4. Ambiguity detection between distinct elements
 * 5. Page validation (uniqueness, count check, rejection of non-existent elements)
 * 6. Confidence threshold enforcement
 * 7. LLM Fallback (mocked): Zod validation, dangerous code rejection, malformed response handling
 * 8. Locator memory CRUD, URL matching, and reuse
 * 9. Non-existent target handling (success = false)
 * 10. Deterministic grounding operates without LLM invocation
 */

import { CandidateGenerator } from '../../src/grounding/candidate-gen';
import { CandidateRanker } from '../../src/grounding/ranking';
import { LlmFallback } from '../../src/grounding/llm-fallback';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { LocatorMemory } from '../../src/memory/locator-memory';
import { ElementDescriptor } from '../../src/models/schemas';
import { Observation } from '../../src/observer/types';
import { LLMClient } from '../../src/llm/types';

// ─── Test Fixtures ─────────────────────────────────────────────

const mockElements: ElementDescriptor[] = [
  {
    tag: 'button',
    id: 'login-btn',
    name: 'login',
    text: 'Đăng nhập',
    role: 'button',
    css_selector: '#login-btn',
    bounding_box: { x: 100, y: 200, width: 120, height: 40 },
  },
  {
    tag: 'input',
    id: 'email',
    name: 'email',
    type: 'email',
    placeholder: 'Nhập email của bạn',
    aria_label: 'Địa chỉ Email',
    css_selector: '#email',
    bounding_box: { x: 100, y: 100, width: 250, height: 35 },
  },
  {
    tag: 'input',
    id: 'password',
    name: 'password',
    type: 'password',
    placeholder: 'Nhập mật khẩu',
    aria_label: 'Mật khẩu',
    css_selector: '#password',
    bounding_box: { x: 100, y: 150, width: 250, height: 35 },
  },
  {
    tag: 'a',
    id: 'about-link',
    text: 'About Us',
    css_selector: '#about-link',
    bounding_box: { x: 50, y: 400, width: 80, height: 25 },
  },
];

const mockObservation: Observation = {
  page: {
    url: 'https://example.com/login',
    title: 'Login Page',
    dom: '<html><body>...</body></html>',
  },
  elements: mockElements,
  network: [],
  console: [],
  captured_at: new Date().toISOString(),
};

describe('M3 Unit: Grounding Engine', () => {
  describe('CandidateGenerator', () => {
    const generator = new CandidateGenerator();

    it('should generate ID, role, and text candidates for a button', () => {
      const candidates = generator.generateCandidates('Login button', 'click', mockElements);

      expect(candidates.length).toBeGreaterThan(0);
      const idCandidate = candidates.find((c) => c.strategy === 'id');
      expect(idCandidate).toBeDefined();
      expect(idCandidate?.locator).toBe('#login-btn');

      const roleCandidate = candidates.find((c) => c.strategy === 'role');
      expect(roleCandidate).toBeDefined();
      expect(roleCandidate?.locator).toContain('role=button');
    });

    it('should generate placeholder and aria-label candidates for input', () => {
      const candidates = generator.generateCandidates('email input', 'fill', mockElements);

      const placeholderCandidate = candidates.find((c) => c.strategy === 'placeholder');
      expect(placeholderCandidate).toBeDefined();
      expect(placeholderCandidate?.locator).toContain('Nhập email của bạn');

      const ariaCandidate = candidates.find((c) => c.strategy === 'aria_label');
      expect(ariaCandidate).toBeDefined();
      expect(ariaCandidate?.locator).toContain('Địa chỉ Email');
    });

    it('should award action-affinity bonus when action matches tag', () => {
      const clickCandidates = generator.generateCandidates('login', 'click', mockElements);
      const fillCandidates = generator.generateCandidates('login', 'fill', mockElements);

      const clickButton = clickCandidates.find((c) => c.locator === '#login-btn');
      const fillButton = fillCandidates.find((c) => c.locator === '#login-btn');

      expect(clickButton?.score).toBeGreaterThan(fillButton?.score ?? 0);
    });
  });

  describe('CandidateRanker', () => {
    const ranker = new CandidateRanker({ ambiguityThreshold: 0.15, maxCandidates: 5 });

    it('should rank higher-stability strategies above lower ones given similar relevance', () => {
      const candidates = [
        {
          element: mockElements[0],
          locator: 'text="Đăng nhập"',
          strategy: 'text' as const,
          score: 0.8,
          evidence: ['Text match'],
        },
        {
          element: mockElements[0],
          locator: '#login-btn',
          strategy: 'id' as const,
          score: 0.8,
          evidence: ['ID match'],
        },
      ];

      const { ranked } = ranker.rankCandidates(candidates);
      expect(ranked[0].strategy).toBe('id');
      expect(ranked[0].locator).toBe('#login-btn');
    });

    it('should deduplicate equivalent locators keeping the highest score', () => {
      const candidates = [
        {
          element: mockElements[0],
          locator: '#login-btn',
          strategy: 'id' as const,
          score: 0.6,
          evidence: ['Partial match'],
        },
        {
          element: mockElements[0],
          locator: '#login-btn',
          strategy: 'id' as const,
          score: 0.95,
          evidence: ['Exact match'],
        },
      ];

      const { ranked } = ranker.rankCandidates(candidates);
      expect(ranked).toHaveLength(1);
      expect(ranked[0].score).toBeGreaterThan(0.9);
    });

    it('should detect ambiguity when two distinct elements have close scores', () => {
      const distinctElement: ElementDescriptor = {
        tag: 'button',
        id: 'submit-btn',
        text: 'Login Now',
        bounding_box: { x: 300, y: 200, width: 120, height: 40 },
      };

      const candidates = [
        {
          element: mockElements[0],
          locator: '#login-btn',
          strategy: 'id' as const,
          score: 0.85,
          evidence: ['Match login'],
        },
        {
          element: distinctElement,
          locator: '#submit-btn',
          strategy: 'id' as const,
          score: 0.83, // Gap = 0.02 < 0.15
          evidence: ['Match login now'],
        },
      ];

      const { ambiguous, scoreGap } = ranker.rankCandidates(candidates);
      expect(ambiguous).toBe(true);
      expect(scoreGap).toBeLessThan(0.15);
    });

    it('should NOT flag ambiguity when two candidates point to the same physical element', () => {
      const candidates = [
        {
          element: mockElements[0],
          locator: '#login-btn',
          strategy: 'id' as const,
          score: 0.9,
          evidence: ['ID match'],
        },
        {
          element: mockElements[0], // Same element!
          locator: 'role=button[name="Đăng nhập"]',
          strategy: 'role' as const,
          score: 0.88,
          evidence: ['Role match'],
        },
      ];

      const { ambiguous } = ranker.rankCandidates(candidates);
      expect(ambiguous).toBe(false);
    });
  });

  describe('LlmFallback', () => {
    it('should parse valid JSON proposal and construct candidate', async () => {
      const mockLlmClient: LLMClient = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            strategy: 'id',
            locator: '#login-btn',
            confidence: 0.95,
            reasoning: 'The login-btn ID exactly matches the request',
          }),
          model: 'claude-3-5-sonnet-20241022',
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        }),
      };

      const fallback = new LlmFallback(mockLlmClient);
      const res = await fallback.resolve('Click login button', 'click', mockElements);

      expect(res.candidate).not.toBeNull();
      expect(res.candidate?.locator).toBe('#login-btn');
      expect(res.candidate?.score).toBe(0.95);
      expect(res.candidate?.evidence).toContain(
        'The login-btn ID exactly matches the request'
      );
    });

    it('should strip markdown code fences from LLM response', async () => {
      const mockLlmClient: LLMClient = {
        complete: jest.fn().mockResolvedValue({
          content: '```json\n{\n  "strategy": "id",\n  "locator": "#email",\n  "confidence": 0.9\n}\n```',
          model: 'claude-3-5-sonnet-20241022',
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        }),
      };

      const fallback = new LlmFallback(mockLlmClient);
      const res = await fallback.resolve('type email', 'fill', mockElements);

      expect(res.candidate).not.toBeNull();
      expect(res.candidate?.locator).toBe('#email');
    });

    it('should reject dangerous javascript code in locator output', async () => {
      const mockLlmClient: LLMClient = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            strategy: 'css',
            locator: 'page.evaluate(() => alert(1))',
            confidence: 0.99,
          }),
          model: 'claude-3-5-sonnet-20241022',
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        }),
      };

      const fallback = new LlmFallback(mockLlmClient);
      const res = await fallback.resolve('hack page', 'click', mockElements);

      expect(res.candidate).toBeNull();
      expect(res.reasoning).toContain('forbidden JavaScript pattern');
    });

    it('should handle malformed JSON gracefully', async () => {
      const mockLlmClient: LLMClient = {
        complete: jest.fn().mockResolvedValue({
          content: 'This is not JSON at all',
          model: 'claude-3-5-sonnet-20241022',
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        }),
      };

      const fallback = new LlmFallback(mockLlmClient);
      const res = await fallback.resolve('something', 'click', mockElements);

      expect(res.candidate).toBeNull();
      expect(res.reasoning).toContain('Failed to parse valid JSON');
    });
  });

  describe('LocatorMemory', () => {
    const memory = new LocatorMemory();

    beforeEach(() => {
      memory.clear();
    });

    it('should record success and retrieve matching locator', () => {
      memory.recordSuccess('https://example.com/login', 'Login button', '#login-btn', 'id');

      const entry = memory.lookup('https://example.com/login', 'Login button');
      expect(entry).not.toBeNull();
      expect(entry?.locator).toBe('#login-btn');
      expect(entry?.success_count).toBe(1);
    });

    it('should support wildcard URL pattern matching', () => {
      memory.recordSuccess('https://example.com/*', 'Search input', '#search', 'id');

      const entry = memory.lookup('https://example.com/products/item1', 'Search input');
      expect(entry).not.toBeNull();
      expect(entry?.locator).toBe('#search');
    });

    it('should not return entries where failure_count >= success_count', () => {
      memory.recordSuccess('https://example.com/test', 'bad target', '#bad', 'id');
      memory.recordFailure('https://example.com/test', 'bad target', '#bad');
      memory.recordFailure('https://example.com/test', 'bad target', '#bad');

      const entry = memory.lookup('https://example.com/test', 'bad target');
      expect(entry).toBeNull();
    });
  });

  describe('GroundingEngine Pipeline', () => {
    it('should resolve clear deterministic targets without calling LLM', async () => {
      const mockLlmComplete = jest.fn();
      const mockLlmClient: LLMClient = { complete: mockLlmComplete };

      const engine = new GroundingEngine(
        { confidenceThreshold: 0.75, enableMemory: false },
        mockLlmClient
      );

      const output = await engine.ground({
        targetDescription: 'Click Login button',
        actionType: 'click',
        observation: mockObservation,
      });

      expect(output.success).toBe(true);
      expect(output.result.selected).not.toBeNull();
      expect(output.result.selected?.locator).toBe('#login-btn');
      expect(output.metrics.usedLlm).toBe(false);
      expect(mockLlmComplete).not.toHaveBeenCalled();
    });

    it('should fail when target element does not exist in observation', async () => {
      const engine = new GroundingEngine({ confidenceThreshold: 0.75, enableLlmFallback: false });

      const output = await engine.ground({
        targetDescription: 'Click Delete Account Forever Button',
        actionType: 'click',
        observation: mockObservation,
      });

      expect(output.success).toBe(false);
      expect(output.result.selected).toBeNull();
    });

    it('should validate candidate using live Playwright page mock', async () => {
      const mockPage = {
        locator: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(1),
        }),
      };

      const engine = new GroundingEngine({ confidenceThreshold: 0.75, enableMemory: false });

      const output = await engine.ground({
        targetDescription: 'About link',
        actionType: 'click',
        observation: mockObservation,
        page: mockPage as any,
      });

      expect(output.success).toBe(true);
      expect(output.metrics.validationPassed).toBe(true);
      expect(mockPage.locator).toHaveBeenCalled();
    });

    it('should reject candidate when live page validation finds 0 matching elements', async () => {
      const mockPage = {
        locator: jest.fn().mockReturnValue({
          count: jest.fn().mockResolvedValue(0), // Element missing in live DOM
        }),
      };

      const engine = new GroundingEngine({
        confidenceThreshold: 0.75,
        enableLlmFallback: false,
        enableMemory: false,
      });

      const output = await engine.ground({
        targetDescription: 'About link',
        actionType: 'click',
        observation: mockObservation,
        page: mockPage as any,
      });

      expect(output.success).toBe(false);
    });

    it('should trigger LLM fallback when heuristic is ambiguous', async () => {
      const ambiguousElements: ElementDescriptor[] = [
        {
          tag: 'button',
          id: 'btn-1',
          text: 'Submit Order',
          bounding_box: { x: 10, y: 10, width: 100, height: 30 },
        },
        {
          tag: 'button',
          id: 'btn-2',
          text: 'Submit Form',
          bounding_box: { x: 10, y: 50, width: 100, height: 30 },
        },
      ];

      const ambiguousObs: Observation = {
        ...mockObservation,
        elements: ambiguousElements,
      };

      const mockLlmClient: LLMClient = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            strategy: 'id',
            locator: '#btn-1',
            confidence: 0.95,
            reasoning: 'Selected btn-1 based on order context',
          }),
          model: 'claude-3-5-sonnet-20241022',
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        }),
      };

      const engine = new GroundingEngine(
        { ambiguityThreshold: 0.2, enableMemory: false, confidenceThreshold: 0.75 },
        mockLlmClient
      );

      const output = await engine.ground({
        targetDescription: 'Submit',
        actionType: 'click',
        observation: ambiguousObs,
      });

      expect(output.success).toBe(true);
      expect(output.metrics.usedLlm).toBe(true);
      expect(output.result.selected?.locator).toBe('#btn-1');
    });

    it('groundAction should transform TestAction with natural language target to resolved locator', async () => {
      const engine = new GroundingEngine({ confidenceThreshold: 0.75, enableMemory: false });

      const nlAction = {
        id: '00000000-0000-0000-0000-000000000001',
        type: 'click' as const,
        target_description: 'Click Login button',
      };

      const grounded = await engine.groundAction(nlAction, mockObservation);

      expect(grounded.success).toBe(true);
      expect(grounded.action.target_description).toBe('#login-btn');
    });
  });
});
