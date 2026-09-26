import { LLMClient } from '../llm/types';
import { ElementDescriptor, TestAction } from '../models/schemas';
import {
  GroundingCandidateWithEvidence,
  LLMGroundingProposal,
  LLMGroundingProposalSchema,
} from './types';
import { getLogger } from '../logger';

// ============================================================
// LLM Fallback – web-test-agent / src/grounding/llm-fallback.ts
// Fallback resolver using Claude LLM with strict JSON validation
// and protection against dangerous JavaScript outputs.
// ============================================================

const log = getLogger('llm-fallback');

export class LlmFallback {
  private readonly llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Request LLM to resolve a target description to the most appropriate element.
   *
   * @param targetDescription Natural language description of intended target
   * @param actionType Action to be performed
   * @param elements Available interactive elements from Observation
   * @returns Proposed candidate with evidence or null if resolution fails
   */
  async resolve(
    targetDescription: string,
    actionType: TestAction['type'],
    elements: ElementDescriptor[]
  ): Promise<{ candidate: GroundingCandidateWithEvidence | null; reasoning?: string }> {
    // 1. Prepare compact, token-safe element representation
    const compactElements = elements.slice(0, 40).map((el, index) => ({
      index,
      tag: el.tag,
      id: el.id,
      name: el.name,
      text: el.text ? el.text.slice(0, 50) : undefined,
      role: el.role,
      aria_label: el.aria_label,
      placeholder: el.placeholder,
      css_selector: el.css_selector,
    }));

    const systemPrompt = `You are an AI Web Test Grounding Engine.
Your task is to identify which element in the provided list corresponds to the user's target description, and propose a reliable Playwright locator.

CRITICAL CONSTRAINTS:
1. You MUST respond with ONLY a single valid JSON object. No explanation text, no markdown code blocks outside JSON.
2. The JSON MUST strictly follow this schema:
   {
     "strategy": "id" | "role" | "text" | "placeholder" | "aria_label" | "css" | "xpath" | "llm",
     "locator": string (valid Playwright selector, e.g. "#login-btn", "role=button[name='Login']"),
     "confidence": number between 0.0 and 1.0,
     "reasoning": string explaining why this element matches
   }
3. DANGEROUS CODE IS STRICTLY FORBIDDEN: Do NOT return "page.evaluate", "eval", "javascript:", or any script. Only return standard Playwright locator strings.
4. If no element matches, return confidence 0.0 with locator "".`;

    const userPrompt = `Target Description: "${targetDescription}"
Action to perform: "${actionType}"

Available interactive elements on the page:
${JSON.stringify(compactElements, null, 2)}

Identify the best element and return the JSON object.`;

    log.info(
      { event: 'llm_fallback_start', target: targetDescription, elementCount: compactElements.length },
      'Invoking LLM fallback for grounding'
    );

    try {
      const response = await this.llmClient.complete({
        systemPrompt,
        userPrompt,
        temperature: 0.0,
        maxTokens: 500,
      });

      // 2. Parse and validate JSON
      const proposal = this.parseAndValidateResponse(response.content);
      if (!proposal) {
        log.warn({ event: 'llm_fallback_invalid_json', raw: response.content }, 'LLM response failed validation');
        return { candidate: null, reasoning: 'Failed to parse valid JSON from LLM' };
      }

      // Check for forbidden javascript patterns
      if (this.containsDangerousCode(proposal.locator)) {
        log.error(
          { event: 'llm_dangerous_code_rejected', locator: proposal.locator },
          'Rejected dangerous code in LLM locator output'
        );
        return { candidate: null, reasoning: 'Security violation: forbidden JavaScript pattern detected' };
      }

      if (proposal.confidence < 0.4 || !proposal.locator.trim()) {
        log.info({ event: 'llm_fallback_low_confidence', confidence: proposal.confidence }, 'LLM could not match target');
        return { candidate: null, reasoning: proposal.reasoning ?? 'Low confidence from LLM' };
      }

      // Find matching element descriptor if available
      const matchingElement = this.findMatchingElement(proposal.locator, elements) ?? elements[0];

      const candidate: GroundingCandidateWithEvidence = {
        element: matchingElement,
        locator: proposal.locator,
        strategy: proposal.strategy,
        score: proposal.confidence,
        evidence: [
          `LLM Fallback resolution (confidence: ${proposal.confidence})`,
          proposal.reasoning ?? 'LLM heuristic match',
        ],
      };

      log.info(
        {
          event: 'llm_fallback_success',
          locator: candidate.locator,
          strategy: candidate.strategy,
          confidence: candidate.score,
        },
        'LLM fallback successfully resolved target'
      );

      return { candidate, reasoning: proposal.reasoning };
    } catch (err) {
      log.error({ event: 'llm_fallback_error', error: String(err) }, 'LLM fallback failed');
      return { candidate: null, reasoning: String(err) };
    }
  }

  /**
   * Safely parse and validate the LLM JSON response.
   */
  private parseAndValidateResponse(rawText: string): LLMGroundingProposal | null {
    try {
      // Clean possible markdown code fences (```json ... ```)
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(cleaned);
      const validation = LLMGroundingProposalSchema.safeParse(parsed);
      if (validation.success) {
        return validation.data;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Reject arbitrary executable code in the locator string.
   */
  private containsDangerousCode(locator: string): boolean {
    const dangerousPatterns = [
      /page\./i,
      /evaluate/i,
      /eval\(/i,
      /function\s*\(/i,
      /=>/i,
      /javascript:/i,
      /<script/i,
      /document\./i,
      /window\./i,
    ];
    return dangerousPatterns.some((pattern) => pattern.test(locator));
  }

  private findMatchingElement(locator: string, elements: ElementDescriptor[]): ElementDescriptor | null {
    if (locator.startsWith('#')) {
      const id = locator.slice(1);
      return elements.find((e) => e.id === id) ?? null;
    }
    return elements.find((e) => e.css_selector === locator) ?? null;
  }
}
