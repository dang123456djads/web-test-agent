/**
 * M2 E2E Integration Test – Observer on Demo Site
 *
 * Runs REAL Chromium browser against demo-site/index.html.
 * Verifies:
 * 1. Page URL, Title, and DOM HTML snapshot captured
 * 2. Visible interactive elements extracted and validated against ElementDescriptorSchema
 * 3. Console messages (log, warn, error) captured
 * 4. Network requests captured
 * 5. Full Observation validated against ObservationSchema and JSON-serializable
 * 6. Observer captures state change after M1 Executor action
 */

import * as path from 'path';
import * as fs from 'fs';
import { PageManager } from '../../src/executor/page-manager';
import { Executor } from '../../src/executor/executor';
import { Observer } from '../../src/observer/observer';
import { ObservationSchema } from '../../src/observer/types';
import { ElementDescriptorSchema, TestAction } from '../../src/models/schemas';

const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

describe('M2 E2E: Observer on Demo Site', () => {
  let pageManager: PageManager;
  let observer: Observer;
  let executor: Executor;

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

    const page = await pageManager.launch();
    observer.attach(page);
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  });

  afterAll(async () => {
    observer.detach();
    await pageManager.close();
  });

  it('1. should capture page URL and Title', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    expect(obs.page.url).toContain('demo-site/index.html');
    expect(obs.page.title).toBe('Demo Site – Web Test Agent');
  });

  it('2. should capture DOM HTML snapshot', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    expect(obs.page.dom).toBeDefined();
    expect(obs.page.dom).toContain('<!DOCTYPE html>');
    expect(obs.page.dom).toContain('id="login-page"');
    expect(obs.page.dom).toContain('id="login-btn"');
  });

  it('3. should capture visible interactive elements matching ElementDescriptorSchema', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    expect(obs.elements.length).toBeGreaterThan(0);

    // Verify all captured elements pass Zod schema validation
    for (const el of obs.elements) {
      const res = ElementDescriptorSchema.safeParse(el);
      expect(res.success).toBe(true);
      expect(el.tag).toBeDefined();
      expect(el.bounding_box).toBeDefined();
    }

    // Check specific elements on demo-site login page
    const emailInput = obs.elements.find((e) => e.id === 'email');
    expect(emailInput).toBeDefined();
    expect(emailInput?.tag).toBe('input');
    expect(emailInput?.type).toBe('email');

    const passwordInput = obs.elements.find((e) => e.id === 'password');
    expect(passwordInput).toBeDefined();
    expect(passwordInput?.tag).toBe('input');
    expect(passwordInput?.type).toBe('password');

    const loginBtn = obs.elements.find((e) => e.id === 'login-btn');
    expect(loginBtn).toBeDefined();
    expect(loginBtn?.tag).toBe('button');
    expect(loginBtn?.text).toContain('Đăng nhập');
  });

  it('4. should capture console events (log, warn, error)', async () => {
    const page = pageManager.getPage();

    // Trigger in-page console statements
    await page.evaluate(() => {
      console.log('E2E info log');
      console.warn('E2E warning message');
      console.error('E2E deliberate error');
    });

    const obs = await observer.observe(page);

    expect(obs.console.length).toBeGreaterThanOrEqual(3);
    const logMsg = obs.console.find((c) => c.text === 'E2E info log');
    const warnMsg = obs.console.find((c) => c.text === 'E2E warning message');
    const errorMsg = obs.console.find((c) => c.text === 'E2E deliberate error');

    expect(logMsg).toBeDefined();
    expect(warnMsg).toBeDefined();
    expect(warnMsg?.type).toBe('warn');
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.type).toBe('error');

    expect(observer.hasConsoleErrors()).toBe(true);
    expect(observer.getConsoleErrors().length).toBeGreaterThanOrEqual(1);
  });

  it('5. should capture network requests generated in browser', async () => {
    const page = pageManager.getPage();

    // Clear previous requests and trigger page reload to generate network request
    observer.clearBuffers();
    await page.reload({ waitUntil: 'domcontentloaded' });

    const obs = await observer.observe(page);
    expect(obs.network.length).toBeGreaterThanOrEqual(1);
    expect(obs.network[0].url).toContain('demo-site/index.html');
    expect(obs.network[0].method).toBe('GET');
  });

  it('6. should validate complete Observation through ObservationSchema and serialize to JSON', async () => {
    const page = pageManager.getPage();
    const obs = await observer.observe(page);

    // Validate with Zod
    const validationResult = ObservationSchema.safeParse(obs);
    expect(validationResult.success).toBe(true);

    // Validate JSON serialization (for LLM ingestion)
    const jsonString = JSON.stringify(obs);
    expect(typeof jsonString).toBe('string');
    const restored = JSON.parse(jsonString);
    expect(restored.page.title).toBe('Demo Site – Web Test Agent');
    expect(Array.isArray(restored.elements)).toBe(true);
  });

  it('7. should observe updated DOM and elements after M1 Executor performs login action', async () => {
    const page = pageManager.getPage();

    // Perform login actions using Executor
    const fillEmail: TestAction = {
      id: crypto.randomUUID(),
      type: 'fill',
      target_description: '#email',
      value: 'admin@example.com',
    };
    const fillPassword: TestAction = {
      id: crypto.randomUUID(),
      type: 'fill',
      target_description: '#password',
      value: 'password123',
    };
    const clickLogin: TestAction = {
      id: crypto.randomUUID(),
      type: 'click',
      target_description: '#login-btn',
    };

    const r1 = await executor.execute(fillEmail, page);
    const r2 = await executor.execute(fillPassword, page);
    const r3 = await executor.execute(clickLogin, page);

    expect(r1.status).toBe('passed');
    expect(r2.status).toBe('passed');
    expect(r3.status).toBe('passed');

    // Now observe new state
    const obsAfterLogin = await observer.observe(page);

    expect(obsAfterLogin.page.title).toBe('Dashboard – Web Test Agent');
    expect(obsAfterLogin.page.dom).toContain('id="dashboard-page"');

    // Dashboard elements should now be visible
    const logoutBtn = obsAfterLogin.elements.find((e) => e.id === 'logout-btn');
    const incrementBtn = obsAfterLogin.elements.find((e) => e.id === 'increment-btn');
    const roleSelect = obsAfterLogin.elements.find((e) => e.id === 'role-select');

    expect(logoutBtn).toBeDefined();
    expect(incrementBtn).toBeDefined();
    expect(roleSelect).toBeDefined();
  });
});
