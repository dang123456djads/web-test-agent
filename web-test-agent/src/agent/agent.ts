import { Page } from 'playwright';
import { getLogger } from '../logger';
import { Observer } from '../observer/observer';
import { GroundingEngine } from '../grounding/grounding-engine';
import { Executor } from '../executor/executor';
import { BfsExplorer } from '../explorer/bfs-explorer';
import { Planner } from './planner';
import { createStateNode } from '../explorer/state';
import {
  AgentConfig,
  AgentRunResult,
  AgentState,
  AgentStatus,
  AgentStep,
  TerminationReason,
} from './types';

// ============================================================
// Agent – web-test-agent / src/agent/agent.ts
// M5: Central orchestration controller.
//
// Dependency direction:
//   Agent → Planner → LLMClient
//   Agent → Observer
//   Agent → GroundingEngine
//   Agent → Executor
//   Agent → BfsExplorer (optional)
//
// Agent NEVER re-implements logic from M1-M4 modules.
// Agent NEVER produces Playwright locators directly.
// All actions flow through: Planner → Grounding → Executor.
// ============================================================

const log = getLogger('agent');

const DEFAULT_CONFIG: Required<AgentConfig> = {
  maxSteps: 20,
  maxGroundingFailures: 3,
  maxExecutionFailures: 3,
  continueOnExecutionFailure: true,
  stepDelayMs: 200,
  testCaseId: '00000000-0000-0000-0000-000000000000',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Agent {
  private readonly observer: Observer;
  private readonly planner: Planner;
  private readonly groundingEngine: GroundingEngine;
  private readonly executor: Executor;
  private readonly explorer?: BfsExplorer;
  private readonly config: Required<AgentConfig>;

  /** Internal agent state – reset on each run() call */
  private state!: AgentState;

  /** Whether a stop has been externally requested */
  private stopRequested = false;

  constructor(
    observer: Observer,
    planner: Planner,
    groundingEngine: GroundingEngine,
    executor: Executor,
    config: AgentConfig = {},
    explorer?: BfsExplorer
  ) {
    this.observer = observer;
    this.planner = planner;
    this.groundingEngine = groundingEngine;
    this.executor = executor;
    this.explorer = explorer;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Request the agent to stop after the current step completes.
   */
  stop(): void {
    this.stopRequested = true;
    log.info({ event: 'agent.stop' }, 'Agent stop requested');
  }

  /**
   * Run the agent loop to achieve the given goal on the given page.
   */
  async run(goal: string, page: Page): Promise<AgentRunResult> {
    const runStart = Date.now();

    const testCaseId =
      this.config.testCaseId !== DEFAULT_CONFIG.testCaseId
        ? this.config.testCaseId
        : crypto.randomUUID();

    // ── Initialize agent state ──────────────────────────────────
    this.state = {
      goal,
      currentObservation: null,
      currentStateId: null,
      plannedAction: null,
      groundedAction: null,
      executionResult: null,
      history: [],
      status: 'idle',
      stepCount: 0,
      maxSteps: this.config.maxSteps,
    };

    // If stop was requested before run started
    if (this.stopRequested) {
      this.stopRequested = false;
      return this.terminate('stopped', 'user_stopped', runStart);
    }

    log.info(
      {
        event: 'agent.start',
        goal,
        maxSteps: this.config.maxSteps,
        url: page.url(),
      },
      `Agent starting. Goal: "${goal}"`
    );

    let consecutiveGroundingFailures = 0;
    let consecutiveExecutionFailures = 0;

    // ── Main agent loop ─────────────────────────────────────────
    while (this.state.status === 'idle' || this.state.status === 'observing' ||
           this.state.status === 'planning' || this.state.status === 'grounding' ||
           this.state.status === 'executing') {

      // Guard: stop requested
      if (this.stopRequested) {
        return this.terminate('stopped', 'user_stopped', runStart);
      }

      // Guard: max steps
      if (this.state.stepCount >= this.config.maxSteps) {
        log.info(
          { event: 'agent.stop', reason: 'max_steps_reached', steps: this.state.stepCount },
          `Agent reached maxSteps (${this.config.maxSteps}), stopping`
        );
        return this.terminate('stopped', 'max_steps_reached', runStart);
      }

      const stepStart = Date.now();
      this.state.stepCount++;

      // ── 1. OBSERVE ────────────────────────────────────────────
      this.state.status = 'observing';
      log.info(
        { event: 'agent.observe', step: this.state.stepCount, url: page.url() },
        `[Step ${this.state.stepCount}] Observing page: ${page.url()}`
      );

      let observation;
      try {
        observation = await this.observer.observe(page);
      } catch (err) {
        log.error(
          { event: 'agent.error', step: this.state.stepCount, error: String(err) },
          `Fatal: Observer failed – ${String(err)}`
        );
        return this.terminate('failed', 'fatal_error', runStart);
      }

      this.state.currentObservation = observation;

      // Compute state ID from M4 state hashing
      const stateNode = createStateNode(observation, 0, []);
      this.state.currentStateId = stateNode.stateId;

      // ── 2. PLAN ───────────────────────────────────────────────
      this.state.status = 'planning';
      log.info(
        { event: 'agent.plan', step: this.state.stepCount },
        `[Step ${this.state.stepCount}] Planning next action`
      );

      let plannerResponse;
      try {
        plannerResponse = await this.planner.plan({
          goal,
          observation,
          history: this.state.history,
        });
      } catch (err) {
        log.error(
          { event: 'agent.error', step: this.state.stepCount, error: String(err) },
          `Planner threw unexpected error: ${String(err)}`
        );
        return this.terminate('failed', 'planner_error', runStart);
      }

      // Check if goal is achieved per planner
      if (plannerResponse.goalAchieved) {
        log.info(
          {
            event: 'agent.goal.reached',
            step: this.state.stepCount,
            reasoning: plannerResponse.reasoning,
          },
          `Agent achieved goal: "${goal}"`
        );
        return this.terminate('completed', 'goal_achieved', runStart, true);
      }

      // No action planned → cannot progress
      if (!plannerResponse.nextAction) {
        log.warn(
          {
            event: 'agent.stop',
            step: this.state.stepCount,
            reason: 'no_actions_planned',
            reasoning: plannerResponse.reasoning,
          },
          `Planner returned no action – cannot progress toward goal`
        );
        return this.terminate('failed', 'no_actions_planned', runStart);
      }

      const plannedAction = plannerResponse.nextAction;
      this.state.plannedAction = plannedAction;

      // ── 3. GROUND ─────────────────────────────────────────────
      this.state.status = 'grounding';
      log.info(
        {
          event: 'agent.ground',
          step: this.state.stepCount,
          type: plannedAction.type,
          target: plannedAction.target_description,
        },
        `[Step ${this.state.stepCount}] Grounding: ${plannedAction.type} "${plannedAction.target_description}"`
      );

      let groundingOutput;
      try {
        groundingOutput = await this.groundingEngine.groundAction(
          plannedAction,
          observation,
          page
        );
      } catch (err) {
        log.error(
          { event: 'agent.error', step: this.state.stepCount, error: String(err) },
          `GroundingEngine threw: ${String(err)}`
        );
        const agentStep: AgentStep = {
          stepNumber: this.state.stepCount,
          observation,
          plannedAction,
          durationMs: Date.now() - stepStart,
          status: 'failed',
          error: `Grounding error: ${String(err)}`,
        };
        this.state.history.push(agentStep);
        return this.terminate('failed', 'grounding_failed', runStart);
      }

      if (!groundingOutput.success || !groundingOutput.action) {
        consecutiveGroundingFailures++;
        const stepError = `Grounding failed for "${plannedAction.target_description}" (consecutive: ${consecutiveGroundingFailures})`;
        log.warn(
          { event: 'agent.step.failure', step: this.state.stepCount, error: stepError },
          stepError
        );

        const agentStep: AgentStep = {
          stepNumber: this.state.stepCount,
          observation,
          plannedAction,
          durationMs: Date.now() - stepStart,
          status: 'failed',
          error: stepError,
        };
        this.state.history.push(agentStep);

        if (consecutiveGroundingFailures >= this.config.maxGroundingFailures) {
          log.error(
            { event: 'agent.stop', reason: 'grounding_failed', consecutive: consecutiveGroundingFailures },
            `Too many consecutive grounding failures (${consecutiveGroundingFailures}), stopping agent`
          );
          return this.terminate('failed', 'grounding_failed', runStart);
        }

        // Step delay before retry
        if (this.config.stepDelayMs > 0) await sleep(this.config.stepDelayMs);
        this.state.status = 'idle';
        continue;
      }

      consecutiveGroundingFailures = 0;
      const groundedAction = groundingOutput.action;
      this.state.groundedAction = groundedAction;

      // ── 4. EXECUTE ────────────────────────────────────────────
      this.state.status = 'executing';
      log.info(
        {
          event: 'agent.execute',
          step: this.state.stepCount,
          type: groundedAction.type,
          locator: groundedAction.target_description,
        },
        `[Step ${this.state.stepCount}] Executing: ${groundedAction.type} on "${groundedAction.target_description}"`
      );

      let execResult;
      try {
        execResult = await this.executor.execute(groundedAction, page, testCaseId);
      } catch (err) {
        log.error(
          { event: 'agent.error', step: this.state.stepCount, error: String(err) },
          `Executor threw: ${String(err)}`
        );
        const agentStep: AgentStep = {
          stepNumber: this.state.stepCount,
          observation,
          plannedAction,
          groundedAction,
          durationMs: Date.now() - stepStart,
          status: 'failed',
          error: `Executor error: ${String(err)}`,
        };
        this.state.history.push(agentStep);
        return this.terminate('failed', 'fatal_error', runStart);
      }

      this.state.executionResult = execResult;

      if (execResult.status !== 'passed') {
        consecutiveExecutionFailures++;
        const stepError = execResult.error_message ?? 'Unknown execution error';
        log.warn(
          {
            event: 'agent.step.failure',
            step: this.state.stepCount,
            error: stepError,
            consecutive: consecutiveExecutionFailures,
          },
          `Execution failed: ${stepError}`
        );

        const agentStep: AgentStep = {
          stepNumber: this.state.stepCount,
          observation,
          plannedAction,
          groundedAction,
          executionResult: execResult,
          durationMs: Date.now() - stepStart,
          status: 'failed',
          error: stepError,
        };
        this.state.history.push(agentStep);

        if (consecutiveExecutionFailures >= this.config.maxExecutionFailures) {
          log.error(
            { event: 'agent.stop', reason: 'execution_failed', consecutive: consecutiveExecutionFailures },
            `Too many consecutive execution failures, stopping agent`
          );
          return this.terminate('failed', 'execution_failed', runStart);
        }

        if (!this.config.continueOnExecutionFailure) {
          return this.terminate('failed', 'execution_failed', runStart);
        }

        if (this.config.stepDelayMs > 0) await sleep(this.config.stepDelayMs);
        this.state.status = 'idle';
        continue;
      }

      consecutiveExecutionFailures = 0;

      log.info(
        {
          event: 'agent.step.success',
          step: this.state.stepCount,
          type: groundedAction.type,
          locator: groundedAction.target_description,
          duration_ms: execResult.duration_ms,
        },
        `[Step ${this.state.stepCount}] ✓ Action succeeded`
      );

      const agentStep: AgentStep = {
        stepNumber: this.state.stepCount,
        observation,
        plannedAction,
        groundedAction,
        executionResult: execResult,
        durationMs: Date.now() - stepStart,
        status: 'success',
      };
      this.state.history.push(agentStep);

      // Step delay to let DOM stabilize
      if (this.config.stepDelayMs > 0) await sleep(this.config.stepDelayMs);

      this.state.status = 'idle';
    }

    // Should not reach here – handled above
    return this.terminate('stopped', 'max_steps_reached', runStart);
  }

  /** Get a snapshot of the current agent state (read-only) */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  // ─── Private helpers ────────────────────────────────────────
  private terminate(
    status: AgentStatus,
    reason: TerminationReason,
    startTime: number,
    goalAchieved = false
  ): AgentRunResult {
    this.stopRequested = false;
    this.state.status = status;
    this.state.terminationReason = reason;

    const durationMs = Date.now() - startTime;

    log.info(
      {
        event: 'agent.stop',
        status,
        reason,
        steps: this.state.stepCount,
        goalAchieved,
        duration_ms: durationMs,
      },
      `Agent stopped: status=${status}, reason=${reason}, steps=${this.state.stepCount}`
    );

    return {
      status,
      terminationReason: reason,
      goal: this.state.goal,
      history: this.state.history,
      stepCount: this.state.stepCount,
      durationMs,
      goalAchieved,
      finalObservation: this.state.currentObservation,
    };
  }
}
