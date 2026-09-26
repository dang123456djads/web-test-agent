import { getLogger } from '../logger';
import { LLMClient, LLMRequest } from '../llm/types';
import { TestAction } from '../models/schemas';
import { Observation } from '../observer/types';
import { PlannerRequest, PlannerResponse, AgentStep } from './types';

// ============================================================
// Planner – web-test-agent / src/agent/planner.ts
// M5: LLM-driven semantic action planner.
//
// Responsibilities:
//   - Convert user Goal + current Observation + history → next TestAction
//   - Use LLMClient (M2) for semantic understanding
//   - Return structured PlannerResponse (nextAction | goalAchieved)
//   - NEVER produce Playwright locators (that is GroundingEngine's job)
//   - NEVER directly execute browser code
// ============================================================

const log = getLogger('planner');

/** Maximum tokens for LLM planner call */
const MAX_TOKENS = 1024;

/** System prompt instructing LLM how to behave as a web-test action planner */
const SYSTEM_PROMPT = `You are an AI web-testing action planner. Your job is to determine the single next action a browser automation agent should take to achieve a stated goal on a web page.

RULES:
1. Respond ONLY with valid JSON matching the specified schema. No markdown, no code fences.
2. "nextAction" must be ONE of: click | fill | select | hover | navigate | wait | assert | scroll | null
3. "target_description" MUST be a natural language description (e.g. "Login button", "Email input field"). NEVER a CSS selector, NEVER a Playwright locator.
4. "value" is only needed for fill/select/navigate/press/wait/assert actions.
5. If the goal is already achieved based on the current page state, set "goalAchieved": true and "nextAction": null.
6. If the goal cannot be achieved (target element does not exist), set "nextAction": null and "goalAchieved": false.
7. Consider the previous steps in history to avoid repeating failed actions.
8. Generate a new UUID for each action id.

RESPONSE SCHEMA:
{
  "nextAction": {
    "id": "<uuid v4>",
    "type": "click" | "fill" | "select" | "hover" | "navigate" | "wait" | "assert" | "scroll" | null,
    "target_description": "<natural language target>",
    "value": "<optional value>"
  } | null,
  "reasoning": "<brief explanation of your decision>",
  "goalAchieved": true | false
}`;

function buildUserPrompt(request: PlannerRequest): string {
  const { goal, observation, history } = request;

  const pageInfo = [
    `URL: ${observation.page.url}`,
    `Title: ${observation.page.title}`,
  ].join('\n');

  const elementsSummary = observation.elements
    .slice(0, 20) // Limit to avoid huge prompts
    .map((el) => {
      const parts = [el.tag];
      if (el.role) parts.push(`role="${el.role}"`);
      if (el.id) parts.push(`id="${el.id}"`);
      if (el.name) parts.push(`name="${el.name}"`);
      if (el.text) parts.push(`text="${el.text.slice(0, 40)}"`);
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      return `  <${parts.join(' ')}>`;
    })
    .join('\n');

  const historyText =
    history.length === 0
      ? 'No steps taken yet.'
      : history
          .slice(-5) // Only last 5 steps for context
          .map(
            (step) =>
              `Step ${step.stepNumber}: ${step.status.toUpperCase()} – ${step.plannedAction.type} "${step.plannedAction.target_description}"${step.error ? ` [ERROR: ${step.error}]` : ''}`
          )
          .join('\n');

  return `GOAL: ${goal}

CURRENT PAGE:
${pageInfo}

INTERACTIVE ELEMENTS (up to 20):
${elementsSummary || '  (none detected)'}

PREVIOUS STEPS:
${historyText}

Based on the current page state and previous steps, what is the SINGLE NEXT ACTION to take to progress toward the goal? Respond with valid JSON only.`;
}

function parseAction(rawJson: string): PlannerResponse {
  try {
    // Strip any accidental markdown fences
    const cleaned = rawJson
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/\s*```$/m, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    const goalAchieved = Boolean(parsed.goalAchieved);
    const reasoning = String(parsed.reasoning ?? '');

    if (!parsed.nextAction || parsed.nextAction === null) {
      return { nextAction: null, reasoning, goalAchieved };
    }

    const raw = parsed.nextAction;

    // Validate action type
    const VALID_TYPES = ['click', 'fill', 'select', 'hover', 'navigate', 'wait', 'assert', 'scroll', 'press'];
    const actionType = raw.type;
    if (!VALID_TYPES.includes(actionType)) {
      log.warn(
        { event: 'planner_invalid_action_type', type: actionType },
        `LLM returned invalid action type: ${actionType}`
      );
      return { nextAction: null, reasoning: `Invalid action type: ${actionType}`, goalAchieved: false };
    }

    const nextAction: TestAction = {
      id: raw.id && /^[0-9a-f-]{36}$/.test(raw.id) ? raw.id : crypto.randomUUID(),
      type: actionType as TestAction['type'],
      target_description: String(raw.target_description ?? '').trim(),
      value: raw.value ? String(raw.value) : undefined,
    };

    if (!nextAction.target_description) {
      return { nextAction: null, reasoning: 'Empty target_description from LLM', goalAchieved: false };
    }

    return { nextAction, reasoning, goalAchieved };
  } catch (err) {
    log.warn(
      { event: 'planner_parse_error', error: String(err), raw: rawJson.slice(0, 200) },
      'Failed to parse LLM planner response'
    );
    return {
      nextAction: null,
      reasoning: `Parse error: ${String(err)}`,
      goalAchieved: false,
    };
  }
}

// ─── Planner Class ────────────────────────────────────────────
export class Planner {
  private readonly llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * Plan the next single action to take given current state and goal.
   *
   * @param request - goal, current observation, and history
   * @returns PlannerResponse with nextAction and goalAchieved flag
   */
  async plan(request: PlannerRequest): Promise<PlannerResponse> {
    const { goal, observation, history } = request;

    log.info(
      {
        event: 'planner_start',
        goal,
        url: observation.page.url,
        title: observation.page.title,
        elements: observation.elements.length,
        historySteps: history.length,
      },
      `Planning next action for goal: "${goal}"`
    );

    const userPrompt = buildUserPrompt(request);

    const llmRequest: LLMRequest = {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: MAX_TOKENS,
      temperature: 0.0,
    };

    let rawResponse: string;
    try {
      const llmResponse = await this.llmClient.complete(llmRequest);
      rawResponse = llmResponse.content;
    } catch (err) {
      log.error(
        { event: 'planner_llm_error', error: String(err) },
        `LLM call failed during planning: ${String(err)}`
      );
      return {
        nextAction: null,
        reasoning: `LLM error: ${String(err)}`,
        goalAchieved: false,
      };
    }

    const result = parseAction(rawResponse);

    log.info(
      {
        event: 'planner_result',
        goalAchieved: result.goalAchieved,
        nextActionType: result.nextAction?.type ?? null,
        nextActionTarget: result.nextAction?.target_description ?? null,
        reasoning: result.reasoning.slice(0, 120),
      },
      `Planner decision: ${result.goalAchieved ? 'GOAL ACHIEVED' : result.nextAction ? `${result.nextAction.type} "${result.nextAction.target_description}"` : 'NO ACTION'}`
    );

    return result;
  }
}
