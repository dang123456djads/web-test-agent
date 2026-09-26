import { ElementDescriptor, TestAction } from '../models/schemas';
import { GroundingCandidateWithEvidence } from './types';
import { getLogger } from '../logger';

// ============================================================
// Candidate Generator – web-test-agent / src/grounding/candidate-gen.ts
// Generates diverse Playwright candidate locators from ElementDescriptors
// with deterministic similarity signals and explainable evidence.
// ============================================================

const log = getLogger('candidate-gen');

// Stopwords common in natural language instructions
const ACTION_STOPWORDS = new Set([
  'click',
  'press',
  'tap',
  'type',
  'enter',
  'fill',
  'select',
  'choose',
  'the',
  'a',
  'an',
  'on',
  'into',
  'in',
  'to',
  'at',
]);

export class CandidateGenerator {
  /**
   * Generate ranked candidate locators for a target description across all elements.
   */
  generateCandidates(
    targetDescription: string,
    actionType: TestAction['type'],
    elements: ElementDescriptor[]
  ): GroundingCandidateWithEvidence[] {
    const rawTokens = this.tokenize(targetDescription);
    const contentTokens = rawTokens.filter((t) => !ACTION_STOPWORDS.has(t));
    const targetNorm = this.normalize(targetDescription);

    const candidates: GroundingCandidateWithEvidence[] = [];

    for (const el of elements) {
      const elCandidates = this.generateElementLocators(el);
      const { matchScore, evidence } = this.scoreElementRelevance(
        el,
        targetNorm,
        contentTokens,
        rawTokens,
        actionType
      );

      if (matchScore > 0.1) {
        for (const c of elCandidates) {
          candidates.push({
            element: el,
            locator: c.locator,
            strategy: c.strategy,
            score: matchScore,
            evidence: [...evidence, ...c.evidence],
          });
        }
      }
    }

    log.debug(
      { event: 'candidates_generated', count: candidates.length, target: targetDescription },
      `Generated ${candidates.length} candidates`
    );

    return candidates;
  }

  /**
   * Produce Playwright locators for a specific element across supported strategies.
   */
  private generateElementLocators(el: ElementDescriptor): Array<{
    locator: string;
    strategy: GroundingCandidateWithEvidence['strategy'];
    evidence: string[];
  }> {
    const locators: Array<{
      locator: string;
      strategy: GroundingCandidateWithEvidence['strategy'];
      evidence: string[];
    }> = [];

    // 1. ID Strategy (Highest stability)
    if (el.id) {
      locators.push({
        locator: `#${el.id}`,
        strategy: 'id',
        evidence: [`ID locator: #${el.id}`],
      });
    }

    // 2. Role Strategy (Accessible role + name)
    const effectiveRole = this.getEffectiveRole(el);
    const accessibleName = el.text || el.aria_label || el.name;
    if (effectiveRole && accessibleName) {
      const cleanName = accessibleName.replace(/"/g, '\\"');
      locators.push({
        locator: `role=${effectiveRole}[name="${cleanName}"]`,
        strategy: 'role',
        evidence: [`Accessible role: ${effectiveRole} with name "${cleanName}"`],
      });
    } else if (effectiveRole) {
      locators.push({
        locator: `role=${effectiveRole}`,
        strategy: 'role',
        evidence: [`Accessible role: ${effectiveRole}`],
      });
    }

    // 3. Aria-label Strategy
    if (el.aria_label) {
      const cleanLabel = el.aria_label.replace(/"/g, '\\"');
      locators.push({
        locator: `[aria-label="${cleanLabel}"]`,
        strategy: 'aria_label',
        evidence: [`Aria-label: "${cleanLabel}"`],
      });
    }

    // 4. Placeholder Strategy
    if (el.placeholder) {
      const cleanPlaceholder = el.placeholder.replace(/"/g, '\\"');
      locators.push({
        locator: `[placeholder="${cleanPlaceholder}"]`,
        strategy: 'placeholder',
        evidence: [`Placeholder: "${cleanPlaceholder}"`],
      });
    }

    // 5. Visible Text Strategy
    if (el.text && el.text.length <= 60) {
      const cleanText = el.text.replace(/"/g, '\\"');
      locators.push({
        locator: `text="${cleanText}"`,
        strategy: 'text',
        evidence: [`Visible text: "${cleanText}"`],
      });
    }

    // 6. Name attribute Strategy
    if (el.name) {
      locators.push({
        locator: `${el.tag}[name="${el.name}"]`,
        strategy: 'css',
        evidence: [`Name attribute: ${el.tag}[name="${el.name}"]`],
      });
    }

    // 7. Stable CSS Selector Strategy
    if (el.css_selector && !el.id && !el.name) {
      locators.push({
        locator: el.css_selector,
        strategy: 'css',
        evidence: [`CSS selector: ${el.css_selector}`],
      });
    }

    return locators;
  }

  /**
   * Determine the effective ARIA role from tag and role attribute.
   */
  private getEffectiveRole(el: ElementDescriptor): string | null {
    if (el.role) return el.role;
    switch (el.tag) {
      case 'button':
        return 'button';
      case 'a':
        return 'link';
      case 'select':
        return 'combobox';
      case 'textarea':
        return 'textbox';
      case 'input': {
        if (el.type === 'checkbox') return 'checkbox';
        if (el.type === 'radio') return 'radio';
        if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') return 'button';
        return 'textbox';
      }
      default:
        return null;
    }
  }

  /**
   * Calculate text matching and action-type affinity scores between target and element.
   */
  private scoreElementRelevance(
    el: ElementDescriptor,
    targetNorm: string,
    contentTokens: string[],
    rawTokens: string[],
    actionType: TestAction['type']
  ): { matchScore: number; evidence: string[] } {
    let score = 0;
    const evidence: string[] = [];

    // Collect all text attributes of element
    const attrTexts = [
      { name: 'id', val: el.id },
      { name: 'name', val: el.name },
      { name: 'text', val: el.text },
      { name: 'aria_label', val: el.aria_label },
      { name: 'placeholder', val: el.placeholder },
    ].filter((a) => Boolean(a.val));

    // 1. Exact attribute matches
    for (const attr of attrTexts) {
      const normVal = this.normalize(attr.val!);
      if (!normVal || normVal.length < 2) continue;

      if (normVal === targetNorm) {
        score = Math.max(score, 0.85);
        evidence.push(`Exact match on ${attr.name}: "${attr.val}"`);
      } else if (
        normVal.length >= 3 &&
        targetNorm.length >= 3 &&
        (normVal.includes(targetNorm) || targetNorm.includes(normVal))
      ) {
        score = Math.max(score, 0.70);
        evidence.push(`Substring match on ${attr.name}: "${attr.val}"`);
      }
    }

    // 2. Token overlap matches
    const searchTokens = (contentTokens.length > 0 ? contentTokens : rawTokens).filter(
      (t) => t.length >= 2
    );
    let maxTokenRatio = 0;

    for (const attr of attrTexts) {
      const elTokens = new Set(this.tokenize(attr.val!).filter((t) => t.length >= 2));
      let matches = 0;
      for (const t of searchTokens) {
        if (
          elTokens.has(t) ||
          Array.from(elTokens).some(
            (et) =>
              et.length >= 2 &&
              (et.includes(t) ||
                t.includes(et) ||
                this.isSynonym(t, et))
          )
        ) {
          matches++;
        }
      }
      const ratio = searchTokens.length > 0 ? matches / searchTokens.length : 0;
      if (ratio > maxTokenRatio) {
        maxTokenRatio = ratio;
        evidence.push(`Token overlap ${Math.round(ratio * 100)}% on ${attr.name}`);
      }
    }

    if (maxTokenRatio > 0) {
      score = Math.max(score, maxTokenRatio * 0.8);
    }

    // 3. Action Affinity (Only apply if element has positive textual relevance)
    if (score > 0) {
      const affinity = this.checkActionAffinity(el, actionType, rawTokens);
      if (affinity > 0) {
        score = Math.min(1.0, score + affinity);
        evidence.push(`Action affinity bonus for ${actionType} -> <${el.tag}>`);
      }
    }

    return { matchScore: score, evidence };
  }

  /**
   * Check whether element tag/type matches expected action.
   */
  private checkActionAffinity(
    el: ElementDescriptor,
    actionType: TestAction['type'],
    rawTokens: string[]
  ): number {
    const role = this.getEffectiveRole(el);

    if (actionType === 'click') {
      if (el.tag === 'button' || role === 'button' || el.tag === 'a' || role === 'link') {
        return 0.15;
      }
    } else if (actionType === 'fill') {
      if (el.tag === 'input' || el.tag === 'textarea' || role === 'textbox') {
        return 0.15;
      }
    } else if (actionType === 'select') {
      if (el.tag === 'select' || role === 'combobox') {
        return 0.15;
      }
    }

    // Check if target description contains tag name (e.g. "button", "link", "input", "dropdown")
    if (rawTokens.includes('button') && (el.tag === 'button' || role === 'button')) return 0.1;
    if (rawTokens.includes('link') && (el.tag === 'a' || role === 'link')) return 0.1;
    if (rawTokens.includes('input') && el.tag === 'input') return 0.1;
    if (rawTokens.includes('select') && el.tag === 'select') return 0.1;

    return 0;
  }

  private isSynonym(a: string, b: string): boolean {
    const pairs: [string, string][] = [
      ['btn', 'button'],
      ['txt', 'text'],
      ['inp', 'input'],
      ['pwd', 'password'],
      ['pass', 'password'],
      ['msg', 'message'],
      ['img', 'image'],
      ['nav', 'navigation'],
      ['sel', 'select'],
      ['inc', 'increment'],
      ['dec', 'decrement'],
    ];

    return pairs.some(
      ([p1, p2]) => (a === p1 && b === p2) || (a === p2 && b === p1)
    );
  }

  private normalize(str: string): string {
    return str
      .toLowerCase()
      .replace(/[-_]/g, ' ')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(str: string): string[] {
    return this.normalize(str)
      .split(' ')
      .filter((s) => s.length > 0);
  }
}
