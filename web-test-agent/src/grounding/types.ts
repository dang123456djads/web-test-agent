import { z } from 'zod';
import {
  ElementDescriptor,
  GroundingCandidate,
  GroundingCandidateSchema,
  GroundingResult,
  GroundingResultSchema,
  TestAction,
} from '../models/schemas';
import { Observation } from '../observer/types';
import { Page } from 'playwright';

// ============================================================
// Grounding Types – web-test-agent / src/grounding/types.ts
// Interfaces, schemas, and metrics for Grounding Engine.
// ============================================================

export interface GroundingCandidateWithEvidence extends GroundingCandidate {
  evidence: string[];
}

export interface GroundingRequest {
  /** Natural language target description (e.g., "Login button", "email input") */
  targetDescription: string;
  /** Action type to be performed on the target */
  actionType: TestAction['type'];
  /** Current observation containing interactive elements and page metadata */
  observation: Observation;
  /** Optional action ID for correlation */
  actionId?: string;
  /** Optional live Playwright Page for candidate validation */
  page?: Page;
}

export interface GroundingConfig {
  /** Score difference threshold below which candidates are considered ambiguous (default: 0.15) */
  ambiguityThreshold?: number;
  /** Minimum score required to select a candidate (default: 0.75) */
  confidenceThreshold?: number;
  /** Maximum number of candidates to evaluate (default: 10) */
  maxCandidates?: number;
  /** Whether to use Claude LLM when heuristic grounding is ambiguous or low confidence (default: true) */
  enableLlmFallback?: boolean;
  /** Whether to use SQLite memory to retrieve previously successful locators (default: true) */
  enableMemory?: boolean;
}

// ─── LLM Fallback Contract ────────────────────────────────────
export const LLMGroundingProposalSchema = z.object({
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
  locator: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});
export type LLMGroundingProposal = z.infer<typeof LLMGroundingProposalSchema>;

// ─── Research & Evaluation Metrics ────────────────────────────
export interface GroundingMetrics {
  targetDescription: string;
  numCandidates: number;
  strategiesUsed: string[];
  topScore: number;
  ambiguous: boolean;
  usedLlm: boolean;
  validationPassed: boolean;
  durationMs: number;
  memoryHit: boolean;
  selectedLocator?: string;
}

export interface GroundingOutput {
  success: boolean;
  result: GroundingResult;
  metrics: GroundingMetrics;
}
