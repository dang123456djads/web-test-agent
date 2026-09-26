import { Page } from 'playwright';
import { getLogger } from '../logger';
import { LLMClient } from '../llm/types';
import {
  GroundingResult,
  GroundingResultSchema,
  TestAction,
} from '../models/schemas';
import { Observation } from '../observer/types';
import { CandidateGenerator } from './candidate-gen';
import { CandidateRanker } from './ranking';
import { LlmFallback } from './llm-fallback';
import { LocatorMemory } from '../memory/locator-memory';
import {
  GroundingConfig,
  GroundingMetrics,
  GroundingOutput,
  GroundingRequest,
  GroundingCandidateWithEvidence,
} from './types';

// ============================================================
// Grounding Engine – web-test-agent / src/grounding/grounding-engine.ts
// Orchestrates Memory Lookup -> Candidate Generation ->
// Ranking & Validation -> Optional LLM Fallback -> Grounded Target.
// ============================================================

const log = getLogger('grounding-engine');

const DEFAULT_CONFIG: Required<GroundingConfig> = {
  ambiguityThreshold: 0.15,
  confidenceThreshold: 0.75,
  maxCandidates: 10,
  enableLlmFallback: true,
  enableMemory: true,
};

export class GroundingEngine {
  private readonly config: Required<GroundingConfig>;
  private readonly generator: CandidateGenerator;
  private readonly ranker: CandidateRanker;
  private readonly llmFallback: LlmFallback | null = null;
  private readonly locatorMemory: LocatorMemory;

  constructor(config: GroundingConfig = {}, llmClient?: LLMClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.generator = new CandidateGenerator();
    this.ranker = new CandidateRanker(this.config);
    this.locatorMemory = new LocatorMemory();

    if (llmClient) {
      this.llmFallback = new LlmFallback(llmClient);
    }
  }

  /**
   * Ground a natural language target description into a verified Playwright locator.
   */
  async ground(request: GroundingRequest): Promise<GroundingOutput> {
    const startTime = Date.now();
    const actionId = request.actionId ?? crypto.randomUUID();
    let memoryHit = false;
    let usedLlm = false;
    let validationPassed = false;

    log.info(
      { event: 'grounding_start', target: request.targetDescription, action: request.actionType },
      `Starting grounding for: "${request.targetDescription}"`
    );

    // ─── Step 1: Locator Memory Lookup ─────────────────────────
    if (this.config.enableMemory) {
      const memoryEntry = this.locatorMemory.lookup(
        request.observation.page.url,
        request.targetDescription
      );

      if (memoryEntry) {
        let memoryValid = true;

        // Validate memory locator against live page if provided
        if (request.page) {
          try {
            const count = await request.page.locator(memoryEntry.locator).count();
            memoryValid = count === 1;
          } catch {
            memoryValid = false;
          }
        }

        if (memoryValid) {
          memoryHit = true;
          validationPassed = true;

          const candidate: GroundingCandidateWithEvidence = {
            element: request.observation.elements[0] ?? { tag: 'unknown' },
            locator: memoryEntry.locator,
            strategy: memoryEntry.strategy,
            score: 0.98,
            evidence: [
              `Reused from LocatorMemory (previous success count: ${memoryEntry.success_count})`,
              'Verified in current DOM',
            ],
          };

          const result: GroundingResult = {
            action_id: actionId,
            target_description: request.targetDescription,
            candidates: [candidate],
            selected: candidate,
            ambiguous: false,
            used_llm_fallback: false,
            grounded_at: new Date().toISOString(),
          };

          const durationMs = Date.now() - startTime;
          const metrics: GroundingMetrics = {
            targetDescription: request.targetDescription,
            numCandidates: 1,
            strategiesUsed: [candidate.strategy],
            topScore: candidate.score,
            ambiguous: false,
            usedLlm: false,
            validationPassed: true,
            durationMs,
            memoryHit: true,
            selectedLocator: candidate.locator,
          };

          log.info(
            { event: 'grounding_memory_hit', locator: candidate.locator, duration_ms: durationMs },
            'Grounding resolved via LocatorMemory'
          );

          return { success: true, result, metrics };
        }
      }
    }

    // ─── Step 2: Heuristic Candidate Generation ────────────────
    const rawCandidates = this.generator.generateCandidates(
      request.targetDescription,
      request.actionType,
      request.observation.elements
    );

    // ─── Step 3: Deterministic Candidate Ranking ───────────────
    let rankingResult = this.ranker.rankCandidates(rawCandidates);
    let ranked = rankingResult.ranked;
    let ambiguous = rankingResult.ambiguous;

    // ─── Step 4: Live Validation on Page (if available) ────────
    if (request.page && ranked.length > 0) {
      for (const c of ranked.slice(0, 3)) {
        try {
          const count = await request.page.locator(c.locator).count();
          if (count === 0) {
            c.score = 0;
            c.evidence.push('Live validation: 0 matching elements in DOM (rejected)');
          } else if (count === 1) {
            c.score = Math.min(1.0, c.score + 0.05);
            c.evidence.push('Live validation: unique matching element in DOM');
            validationPassed = true;
          } else {
            c.score = Math.round(c.score * 0.7 * 1000) / 1000;
            c.evidence.push(`Live validation: matched ${count} elements (penalized for non-uniqueness)`);
          }
        } catch (err) {
          c.score = 0;
          c.evidence.push(`Live validation error: ${String(err)}`);
        }
      }

      // Re-rank post-validation
      rankingResult = this.ranker.rankCandidates(ranked);
      ranked = rankingResult.ranked;
      ambiguous = rankingResult.ambiguous;
    }

    // ─── Step 5: Evaluate Top Candidate ───────────────────────
    let selectedCandidate: GroundingCandidateWithEvidence | null = null;
    const topCandidate = ranked[0];

    if (topCandidate && topCandidate.score >= this.config.confidenceThreshold && !ambiguous) {
      selectedCandidate = topCandidate;
    }

    // ─── Step 6: LLM Fallback (if ambiguous or low confidence) ─
    if (
      (!selectedCandidate || ambiguous) &&
      this.config.enableLlmFallback &&
      this.llmFallback
    ) {
      log.info(
        {
          event: 'grounding_trigger_llm',
          topScore: topCandidate?.score ?? 0,
          ambiguous,
        },
        'Heuristic grounding insufficient, triggering LLM fallback'
      );

      const llmResult = await this.llmFallback.resolve(
        request.targetDescription,
        request.actionType,
        request.observation.elements
      );

      if (llmResult.candidate) {
        usedLlm = true;
        let llmValid = true;

        if (request.page) {
          try {
            const count = await request.page.locator(llmResult.candidate.locator).count();
            llmValid = count >= 1;
          } catch {
            llmValid = false;
          }
        }

        if (llmValid && llmResult.candidate.score >= this.config.confidenceThreshold) {
          selectedCandidate = llmResult.candidate;
          ambiguous = false;
          ranked.unshift(selectedCandidate);
        }
      }
    }

    // ─── Step 7: Record Result & Memory ────────────────────────
    const isSuccess = Boolean(
      selectedCandidate && selectedCandidate.score >= this.config.confidenceThreshold && !ambiguous
    );

    if (isSuccess && selectedCandidate && this.config.enableMemory) {
      this.locatorMemory.recordSuccess(
        request.observation.page.url,
        request.targetDescription,
        selectedCandidate.locator,
        selectedCandidate.strategy
      );
    }

    const durationMs = Date.now() - startTime;
    const result: GroundingResult = {
      action_id: actionId,
      target_description: request.targetDescription,
      candidates: ranked,
      selected: isSuccess ? selectedCandidate : null,
      ambiguous,
      used_llm_fallback: usedLlm,
      grounded_at: new Date().toISOString(),
    };

    // Validate against central schema
    const validatedResult = GroundingResultSchema.parse(result);

    const metrics: GroundingMetrics = {
      targetDescription: request.targetDescription,
      numCandidates: ranked.length,
      strategiesUsed: Array.from(new Set(ranked.map((c) => c.strategy))),
      topScore: topCandidate?.score ?? 0,
      ambiguous,
      usedLlm,
      validationPassed,
      durationMs,
      memoryHit,
      selectedLocator: selectedCandidate?.locator,
    };

    log.info(
      {
        event: 'grounding_complete',
        success: isSuccess,
        selected: selectedCandidate?.locator,
        strategy: selectedCandidate?.strategy,
        confidence: selectedCandidate?.score,
        used_llm: usedLlm,
        duration_ms: durationMs,
      },
      `Grounding finished: ${isSuccess ? 'PASS' : 'FAIL'}`
    );

    return { success: isSuccess, result: validatedResult, metrics };
  }

  /**
   * Helper to ground a TestAction's natural language target_description
   * into a concrete Playwright locator for Executor execution.
   */
  async groundAction(
    action: TestAction,
    observation: Observation,
    page?: Page
  ): Promise<{ action: TestAction; result: GroundingResult; success: boolean }> {
    // Navigate actions already contain target URL in value or target_description
    if (action.type === 'navigate') {
      const result: GroundingResult = {
        action_id: action.id,
        target_description: action.target_description,
        candidates: [],
        selected: null,
        ambiguous: false,
        used_llm_fallback: false,
        grounded_at: new Date().toISOString(),
      };
      return { action, result, success: true };
    }

    const output = await this.ground({
      targetDescription: action.target_description,
      actionType: action.type,
      observation,
      actionId: action.id,
      page,
    });

    if (output.success && output.result.selected) {
      // Clone action with resolved Playwright locator
      const groundedAction: TestAction = {
        ...action,
        target_description: output.result.selected.locator,
      };
      return { action: groundedAction, result: output.result, success: true };
    }

    return { action, result: output.result, success: false };
  }
}

export * from './types';
export * from './candidate-gen';
export * from './ranking';
export * from './llm-fallback';
