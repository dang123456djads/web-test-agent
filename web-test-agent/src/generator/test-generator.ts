import { getLogger } from '../logger';
import { LLMClient, LLMRequest } from '../llm/types';
import { AgentRunResult, AgentStep } from '../agent/types';
import { Observation } from '../observer/types';
import {
  TestCase,
  TestStep,
  TestAssertion,
  TestCaseMetadata,
  GeneratorInput,
  GeneratorOptions,
} from './types';
import { normalizeTestCase } from './normalizer';
import { assertValidTestCase } from './validator';

// ============================================================
// Test Generator – web-test-agent / src/generator/test-generator.ts
// Converts AgentRunResult + execution history + observations into
// validated, replayable, human-readable TestCase structures.
// ============================================================

const log = getLogger('test-generator');

export class TestGenerationError extends Error {
  public readonly reason: string;
  public readonly agentStatus?: string;
  public readonly terminationReason?: string;

  constructor(message: string, reason: string, agentStatus?: string, terminationReason?: string) {
    super(message);
    this.name = 'TestGenerationError';
    this.reason = reason;
    this.agentStatus = agentStatus;
    this.terminationReason = terminationReason;
  }
}

interface LlmEnhancementResponse {
  name?: string;
  description?: string;
  preconditions?: string[];
  stepOutcomes?: string[];
}

export class TestGenerator {
  private readonly llmClient?: LLMClient;

  constructor(llmClient?: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Check whether an AgentRunResult is eligible for test generation.
   * Fails if the agent failed, stopped prematurely, or did not achieve its goal.
   */
  canGenerate(result: AgentRunResult | GeneratorInput): boolean {
    if (!result.goalAchieved) return false;
    if (result.history.length === 0) return false;
    if ('status' in result && result.status !== 'completed') return false;
    return true;
  }

  /**
   * Generates a validated TestCase from an AgentRunResult or GeneratorInput.
   * Throws TestGenerationError if input represents a failed or un-generatable run.
   */
  async generate(
    input: AgentRunResult | GeneratorInput,
    options: GeneratorOptions = {}
  ): Promise<TestCase> {
    log.info({ event: 'generator_start', goal: input.goal }, `Starting test generation for goal: "${input.goal}"`);

    // 1. Strict guard: Never generate a PASS test case from a failed agent run
    if (!input.goalAchieved) {
      const status = 'status' in input ? input.status : undefined;
      const termReason = input.terminationReason;
      log.warn(
        { event: 'generator_rejected', goalAchieved: false, terminationReason: termReason },
        'Rejecting test generation: agent goal was not achieved'
      );
      throw new TestGenerationError(
        `Cannot generate test case from failed or incomplete agent run (reason: ${termReason})`,
        'goal_not_achieved',
        status,
        termReason
      );
    }

    if (input.history.length === 0) {
      throw new TestGenerationError(
        'Cannot generate test case: execution history is empty',
        'empty_history'
      );
    }

    // 2. Determine start URL from initial observation or first history step
    const initialObs =
      ('initialObservation' in input ? input.initialObservation : null) ??
      input.history[0]?.observation ??
      null;
    const finalObs = input.finalObservation ?? input.history[input.history.length - 1]?.observation ?? null;

    const startUrl =
      initialObs?.page?.url ||
      input.history[0]?.observation?.page?.url ||
      'about:blank';

    // 3. Convert AgentSteps to TestSteps
    // Filter only steps that were successfully executed (or relevant)
    const successfulSteps = input.history.filter((s) => s.status === 'success');
    const stepsToConvert = successfulSteps.length > 0 ? successfulSteps : input.history;

    const testSteps: TestStep[] = stepsToConvert.map((step, index) => {
      const order = index + 1;
      const targetDescription = step.plannedAction.target_description;
      // Preserve grounded locator from step.groundedAction without guessing
      const locator = step.groundedAction?.target_description;
      const value = step.plannedAction.value ?? step.groundedAction?.value;

      const action = {
        id: step.plannedAction.id ?? crypto.randomUUID(),
        type: step.plannedAction.type,
        target_description: locator ?? targetDescription,
        value,
      };

      return {
        order,
        action,
        targetDescription,
        locator,
        value,
        expectedOutcome: this.createStepOutcome(step),
      };
    });

    // 4. Generate evidence-based assertions
    const assertions = options.includeAssertions !== false
      ? this.generateAssertions(input.goal, initialObs, finalObs)
      : [];

    // 5. Default Name and Description
    let name = options.testCaseName ?? this.createDefaultName(input.goal);
    let description = options.testCaseDescription ?? `Automated test verifying: "${input.goal}"`;
    let preconditions = this.createDefaultPreconditions(startUrl);

    // 6. Optional LLM Enhancement (human-readable naming & description)
    if (this.llmClient) {
      try {
        const enhanced = await this.enhanceWithLlm(input.goal, testSteps, assertions);
        if (enhanced) {
          if (enhanced.name && !options.testCaseName) name = enhanced.name;
          if (enhanced.description && !options.testCaseDescription) description = enhanced.description;
          if (enhanced.preconditions && enhanced.preconditions.length > 0) preconditions = enhanced.preconditions;
          if (enhanced.stepOutcomes && enhanced.stepOutcomes.length === testSteps.length) {
            testSteps.forEach((s, idx) => {
              s.expectedOutcome = enhanced.stepOutcomes![idx];
            });
          }
        }
      } catch (err) {
        log.warn(
          { event: 'generator_llm_warning', error: String(err) },
          'LLM enhancement failed or timed out; falling back to deterministic template'
        );
      }
    }

    // 7. Assemble Raw TestCase
    const metadata: TestCaseMetadata = {
      generatedAt: new Date().toISOString(),
      agentGoal: input.goal,
      stepCount: testSteps.length,
      durationMs: input.durationMs ?? 0,
      framework: 'playwright',
      tags: options.tags ?? ['automated', 'ai-generated'],
    };

    const rawTestCase: TestCase = {
      id: crypto.randomUUID(),
      name,
      description,
      startUrl,
      preconditions,
      steps: testSteps,
      assertions,
      metadata,
    };

    // 8. Normalization
    const normalizedTestCase = options.normalizeSteps !== false
      ? normalizeTestCase(rawTestCase)
      : rawTestCase;

    // 9. Validation
    const validatedTestCase = assertValidTestCase(normalizedTestCase);

    log.info(
      {
        event: 'generator_complete',
        testCaseId: validatedTestCase.id,
        steps: validatedTestCase.steps.length,
        assertions: validatedTestCase.assertions.length,
      },
      `Generated test case: "${validatedTestCase.name}" (${validatedTestCase.steps.length} steps)`
    );

    return validatedTestCase;
  }

  // ─── Evidence-based Assertion Generation ───────────────────
  private generateAssertions(
    goal: string,
    initialObs: Observation | null,
    finalObs: Observation | null
  ): TestAssertion[] {
    const assertions: TestAssertion[] = [];
    if (!finalObs) return assertions;

    const lowerGoal = goal.toLowerCase();
    const finalUrl = finalObs.page?.url ?? '';
    const finalTitle = finalObs.page?.title ?? '';

    // Evidence 1: URL Hash or Path changes
    try {
      const urlObj = new URL(finalUrl);
      if (urlObj.hash && urlObj.hash.length > 1) {
        const hash = urlObj.hash; // e.g. #dashboard or #about
        assertions.push({
          type: 'url_contains',
          expected: hash,
          description: `Verify URL contains hash "${hash}"`,
        });
      }
    } catch {
      // Fallback string matching if not valid URL
      if (finalUrl.includes('#')) {
        const hash = '#' + finalUrl.split('#')[1];
        assertions.push({
          type: 'url_contains',
          expected: hash,
          description: `Verify URL contains "${hash}"`,
        });
      }
    }

    // Evidence 2: Target section/page visibility from DOM observation
    const elementIds = new Set(
      finalObs.elements.map((el) => el.id).filter(Boolean) as string[]
    );

    if (elementIds.has('dashboard-page') || finalTitle.toLowerCase().includes('dashboard')) {
      if (lowerGoal.includes('login') || lowerGoal.includes('dashboard')) {
        assertions.push({
          type: 'element_visible',
          target: '#dashboard-page',
          description: 'Verify Dashboard section is visible after login',
        });
      }
    }

    if (elementIds.has('about-section') || finalTitle.toLowerCase().includes('about')) {
      if (lowerGoal.includes('about')) {
        assertions.push({
          type: 'element_visible',
          target: '#about-section',
          description: 'Verify About section is visible',
        });
      }
    }

    if (elementIds.has('settings-section') || finalTitle.toLowerCase().includes('settings')) {
      if (lowerGoal.includes('settings')) {
        assertions.push({
          type: 'element_visible',
          target: '#settings-section',
          description: 'Verify Settings section is visible',
        });
      }
    }

    // Evidence 3: Element text if specific success message or indicator exists
    const successMsg = finalObs.elements.find(
      (el) => el.id === 'message' || el.id === 'role-message' || el.id === 'current-page'
    );
    if (successMsg && successMsg.text && successMsg.text.trim()) {
      assertions.push({
        type: 'element_text',
        target: `#${successMsg.id}`,
        expected: successMsg.text.trim(),
        description: `Verify text of #${successMsg.id} is "${successMsg.text.trim()}"`,
      });
    }

    return assertions;
  }

  // ─── Step Outcome Description ──────────────────────────────
  private createStepOutcome(step: AgentStep): string {
    const target = step.plannedAction.target_description;
    const value = step.plannedAction.value;
    switch (step.plannedAction.type) {
      case 'click':
        return `Click "${target}"`;
      case 'fill':
        return `Fill "${target}" with "${value ?? ''}"`;
      case 'select':
        return `Select "${value ?? ''}" in "${target}"`;
      case 'press':
        return `Press "${value ?? ''}" on "${target}"`;
      default:
        return `${step.plannedAction.type} on "${target}"`;
    }
  }

  // ─── Default Generators ────────────────────────────────────
  private createDefaultName(goal: string): string {
    const cleaned = goal.replace(/^(should|to|verify|test)\s+/i, '').trim();
    // Capitalize first letter
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  private createDefaultPreconditions(startUrl: string): string[] {
    return [`Web application is running and accessible at "${startUrl}"`];
  }

  // ─── Optional LLM Enhancement ──────────────────────────────
  private async enhanceWithLlm(
    goal: string,
    steps: TestStep[],
    assertions: TestAssertion[]
  ): Promise<LlmEnhancementResponse | null> {
    if (!this.llmClient) return null;

    const prompt = `You are a test case documentation assistant.
Given an automated web test execution, produce concise, professional documentation.

GOAL: ${goal}

STEPS:
${steps.map((s) => `${s.order}. [${s.action.type}] ${s.targetDescription ?? s.action.target_description} (value: ${s.value ?? 'none'})`).join('\n')}

ASSERTIONS:
${assertions.map((a) => `- [${a.type}] ${a.description}`).join('\n') || '(none)'}

Respond with valid JSON only in this format:
{
  "name": "<concise title, e.g. 'Successful Admin Login'>",
  "description": "<1-2 sentence description of test case purpose>",
  "preconditions": ["<precondition 1>"],
  "stepOutcomes": ["<human readable outcome for step 1>", "..."]
}`;

    const request: LLMRequest = {
      systemPrompt: 'You are a test documentation specialist. Output JSON only without markdown formatting.',
      userPrompt: prompt,
      temperature: 0.1,
      maxTokens: 512,
    };

    const response = await this.llmClient.complete(request);
    const cleaned = response.content
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/\s*```$/m, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);
      return {
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined,
        description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : undefined,
        preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions.map(String) : undefined,
        stepOutcomes: Array.isArray(parsed.stepOutcomes) ? parsed.stepOutcomes.map(String) : undefined,
      };
    } catch {
      return null;
    }
  }
}
