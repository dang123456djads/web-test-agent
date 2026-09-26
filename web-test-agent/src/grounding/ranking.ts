import { GroundingCandidateWithEvidence, GroundingConfig } from './types';
import { getLogger } from '../logger';

// ============================================================
// Candidate Ranker – web-test-agent / src/grounding/ranking.ts
// Deterministic multi-signal candidate scoring, deduplication,
// and ambiguity detection.
// ============================================================

const log = getLogger('ranking');

// Deterministic strategy stability weights [0, 1]
const STRATEGY_STABILITY_WEIGHTS: Record<GroundingCandidateWithEvidence['strategy'], number> = {
  id: 1.0,
  role: 0.9,
  aria_label: 0.85,
  placeholder: 0.8,
  text: 0.75,
  css: 0.65,
  xpath: 0.55,
  llm: 0.7,
};

export interface RankingResult {
  ranked: GroundingCandidateWithEvidence[];
  ambiguous: boolean;
  scoreGap: number;
}

export class CandidateRanker {
  private readonly ambiguityThreshold: number;
  private readonly maxCandidates: number;

  constructor(config: GroundingConfig = {}) {
    this.ambiguityThreshold = config.ambiguityThreshold ?? 0.15;
    this.maxCandidates = config.maxCandidates ?? 10;
  }

  /**
   * Rank, score, and detect ambiguity among generated candidates.
   */
  rankCandidates(candidates: GroundingCandidateWithEvidence[]): RankingResult {
    if (candidates.length === 0) {
      return { ranked: [], ambiguous: false, scoreGap: 0 };
    }

    // 1. Calculate weighted score for each candidate
    const scoredCandidates: GroundingCandidateWithEvidence[] = candidates.map((c) => {
      const strategyWeight = STRATEGY_STABILITY_WEIGHTS[c.strategy] ?? 0.5;
      // Formula: 70% relevance match + 30% strategy stability
      const finalScore = Math.min(1.0, c.score * 0.7 + strategyWeight * 0.3);
      const roundedScore = Math.round(finalScore * 1000) / 1000;

      return {
        ...c,
        score: roundedScore,
        evidence: [
          `Strategy stability (${c.strategy}): ${strategyWeight}`,
          ...c.evidence,
        ],
      };
    });

    // 2. Deduplicate equivalent locators (keep highest score)
    const locatorMap = new Map<string, GroundingCandidateWithEvidence>();
    for (const c of scoredCandidates) {
      const existing = locatorMap.get(c.locator);
      if (!existing || c.score > existing.score) {
        locatorMap.set(c.locator, c);
      }
    }

    // 3. Sort descending by score
    const ranked = Array.from(locatorMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxCandidates);

    // 4. Ambiguity Detection
    let ambiguous = false;
    let scoreGap = 1.0;

    if (ranked.length >= 2) {
      scoreGap = ranked[0].score - ranked[1].score;

      // Check if top 2 candidates point to different physical elements
      const isDifferentElement = this.isDifferentElement(ranked[0].element, ranked[1].element);

      if (isDifferentElement && scoreGap < this.ambiguityThreshold && ranked[0].score >= 0.5) {
        ambiguous = true;
        log.warn(
          {
            event: 'ambiguity_detected',
            top1: { locator: ranked[0].locator, score: ranked[0].score },
            top2: { locator: ranked[1].locator, score: ranked[1].score },
            scoreGap,
          },
          'Ambiguous candidates detected pointing to distinct elements'
        );
      }
    }

    log.debug(
      { event: 'ranking_done', count: ranked.length, topScore: ranked[0]?.score, ambiguous },
      `Ranked ${ranked.length} candidates`
    );

    return { ranked, ambiguous, scoreGap };
  }

  /**
   * Check if two ElementDescriptors represent different physical DOM nodes.
   */
  private isDifferentElement(a: any, b: any): boolean {
    if (!a || !b) return true;
    if (a.id && b.id) return a.id !== b.id;
    if (a.css_selector && b.css_selector) return a.css_selector !== b.css_selector;
    if (a.bounding_box && b.bounding_box) {
      return (
        a.bounding_box.x !== b.bounding_box.x ||
        a.bounding_box.y !== b.bounding_box.y ||
        a.bounding_box.width !== b.bounding_box.width ||
        a.bounding_box.height !== b.bounding_box.height
      );
    }
    return true;
  }
}
