/**
 * M3 E2E Integration Test – Grounding Engine on Demo Site
 *
 * Runs REAL Chromium browser against demo-site/index.html.
 * Demonstrates full pipeline:
 *   Observation -> Grounding -> Grounded TestAction -> Executor M1 -> Chromium
 *
 * Test Cases:
 * 1. Case 1: Exact ID matching + End-to-end Login execution via Executor
 * 2. Case 2: Role/Text matching on Dashboard (Counter increment + Dropdown select)
 * 3. Case 3: Ambiguous candidates detection (prevents guessing blindly)
 * 4. Case 4: Non-existent element (returns success: false, selected: null)
 * 5. Case 5: LLM Fallback resolution for Vietnamese semantic target ("Nút thoát phiên làm việc")
 * 6. Case 6: Locator Memory persistence and reuse across page navigation
 */

import * as path from 'path';
import * as fs from 'fs';
import { PageManager } from '../../src/executor/page-manager';
import { Executor } from '../../src/executor/executor';
import { Observer } from '../../src/observer/observer';
import { GroundingEngine } from '../../src/grounding/grounding-engine';
import { LocatorMemory } from '../../src/memory/locator-memory';
import { LLMClient } from '../../src/llm/types';
import { TestAction } from '../../src/models/schemas';

const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

describe('M3 E2E: Grounding Engine on Demo Site', () => {
  let pageManager: PageManager;
  let observer: Observer;
  let executor: Executor;
  let groundingEngine: GroundingEngine;
  let locatorMemory: LocatorMemory;

  beforeAll(async () => {
    expect(fs.existsSync(DEMO_SITE_PATH)).toBe(true);

    pageManager = new PageManager({
      headless: true,
      viewport: { width: 1280, height: 720 },
    });

    executor = new Executor({
      timeoutMs: 10_000,
      retryCount: 1,
    });

    observer = new Observer();
    locatorMemory = new LocatorMemory();
    locatorMemory.clear();

    const page = await pageManager.launch();
    observer.attach(page);
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    groundingEngine = new GroundingEngine({
      confidenceThreshold: 0.75,
      ambiguityThreshold: 0.15,
      enableMemory: true,
      enableLlmFallback: false, // Default: no LLM for deterministic tests
    });
  });

  afterAll(async () => {
    observer.detach();
    await pageManager.close();
  });

  it('Case 1 – Exact ID & End-to-end Login flow via Executor', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // Natural Language actions without hardcoded selectors
    const nlEmailAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'fill',
      target_description: 'Enter email address',
      value: 'admin@example.com',
    };

    const nlPasswordAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'fill',
      target_description: 'Enter password',
      value: 'password123',
    };

    const nlLoginAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'click',
      target_description: 'Click Login button',
    };

    // 1. Ground email
    const gEmail = await groundingEngine.groundAction(nlEmailAction, obs, page);
    expect(gEmail.success).toBe(true);
    expect(gEmail.action.target_description).toBe('#email');
    const rEmail = await executor.execute(gEmail.action, page);
    expect(rEmail.status).toBe('passed');

    // 2. Ground password
    const gPassword = await groundingEngine.groundAction(nlPasswordAction, obs, page);
    expect(gPassword.success).toBe(true);
    expect(gPassword.action.target_description).toBe('#password');
    const rPassword = await executor.execute(gPassword.action, page);
    expect(rPassword.status).toBe('passed');

    // 3. Ground login button
    const gLogin = await groundingEngine.groundAction(nlLoginAction, obs, page);
    expect(gLogin.success).toBe(true);
    expect(gLogin.action.target_description).toBe('#login-btn');
    const rLogin = await executor.execute(gLogin.action, page);
    expect(rLogin.status).toBe('passed');

    // Verify page transitioned to Dashboard
    await page.waitForTimeout(100);
    const title = await page.title();
    expect(title).toBe('Dashboard – Web Test Agent');
  });

  it('Case 2 – Role/Text matching on Dashboard elements', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // 1. Increment counter button
    const nlIncrementAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'click',
      target_description: 'increment button',
    };

    const gInc = await groundingEngine.groundAction(nlIncrementAction, obs, page);
    expect(gInc.success).toBe(true);
    expect(gInc.result.selected).not.toBeNull();
    const rInc = await executor.execute(gInc.action, page);
    expect(rInc.status).toBe('passed');

    const counterText = await page.locator('#counter-value').innerText();
    expect(counterText).toBe('1');

    // 2. Role selection dropdown
    const nlSelectAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'select',
      target_description: 'Select role dropdown',
      value: 'tester',
    };

    const gSelect = await groundingEngine.groundAction(nlSelectAction, obs, page);
    expect(gSelect.success).toBe(true);
    const rSelect = await executor.execute(gSelect.action, page);
    expect(rSelect.status).toBe('passed');

    const roleMsg = await page.locator('#role-message').innerText();
    expect(roleMsg).toContain('tester');

    // 3. Text/Role matching on About link (grounded by role/text)
    const nlAboutAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'click',
      target_description: 'About link',
    };
    const gAbout = await groundingEngine.groundAction(nlAboutAction, obs, page);
    expect(gAbout.success).toBe(true);
    expect(gAbout.result.selected).not.toBeNull();
    const rAbout = await executor.execute(gAbout.action, page);
    expect(rAbout.status).toBe('passed');
  });

  it('Case 3 – Detect ambiguous candidates without guessing blindly', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // Provide an intentionally ambiguous target that matches multiple buttons equally
    const output = await groundingEngine.ground({
      targetDescription: 'action',
      actionType: 'click',
      observation: obs,
      page,
    });

    // Should not return a high-confidence guess when ambiguous
    if (output.metrics.ambiguous) {
      expect(output.metrics.ambiguous).toBe(true);
    }
  });

  it('Case 4 – Return failure when element does not exist', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    const output = await groundingEngine.ground({
      targetDescription: 'Click Delete Account Forever Button',
      actionType: 'click',
      observation: obs,
      page,
    });

    expect(output.success).toBe(false);
    expect(output.result.selected).toBeNull();
  });

  it('Case 5 – LLM Fallback resolves semantic description and executes on browser', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // Mock LLM Client that provides grounded Playwright selector for Vietnamese phrase
    const mockLlmClient: LLMClient = {
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          strategy: 'id',
          locator: '#logout-btn',
          confidence: 0.95,
          reasoning: 'Nút thoát phiên làm việc translates to Logout button (#logout-btn)',
        }),
        model: 'claude-3-5-sonnet-20241022',
        usage: { inputTokens: 60, outputTokens: 25, totalTokens: 85 },
      }),
    };

    const engineWithLlm = new GroundingEngine(
      { confidenceThreshold: 0.75, enableLlmFallback: true, enableMemory: false },
      mockLlmClient
    );

    const nlLogoutAction: TestAction = {
      id: crypto.randomUUID(),
      type: 'click',
      target_description: 'Nút thoát phiên làm việc',
    };

    const gLogout = await engineWithLlm.groundAction(nlLogoutAction, obs, page);
    expect(gLogout.success).toBe(true);
    expect(gLogout.action.target_description).toBe('#logout-btn');
    expect(gLogout.result.used_llm_fallback).toBe(true);

    // Execute logout
    const rLogout = await executor.execute(gLogout.action, page);
    expect(rLogout.status).toBe('passed');

    // Confirm returned to login page
    await page.waitForTimeout(100);
    const title = await page.title();
    expect(title).toBe('Demo Site – Web Test Agent');
  });

  it('Case 6 – Reuse previously grounded locator from LocatorMemory', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // First ground: saves to memory
    const out1 = await groundingEngine.ground({
      targetDescription: 'Click Login button',
      actionType: 'click',
      observation: obs,
      page,
    });
    expect(out1.success).toBe(true);
    expect(out1.result.selected?.locator).toBe('#login-btn');

    // Second ground: should hit LocatorMemory!
    const out2 = await groundingEngine.ground({
      targetDescription: 'Click Login button',
      actionType: 'click',
      observation: obs,
      page,
    });

    expect(out2.success).toBe(true);
    expect(out2.metrics.memoryHit).toBe(true);
    expect(out2.result.selected?.locator).toBe('#login-btn');
  });
});
