/**
 * M1 E2E Integration Test – Executor trên Demo Site
 *
 * Chạy THẬT với Chromium (headless) trên demo-site/index.html.
 * Kiểm tra toàn bộ login flow + các action cơ bản.
 *
 * Demo site credentials:
 *   email:    admin@example.com
 *   password: password123
 */

import * as path from 'path';
import * as fs from 'fs';
import { Executor } from '../../src/executor/executor';
import { PageManager } from '../../src/executor/page-manager';
import { TestAction } from '../../src/models/schemas';

// ─── Helpers ──────────────────────────────────────────────────
const DEMO_SITE_PATH = path.resolve(__dirname, '../../demo-site/index.html');
const DEMO_URL = `file:///${DEMO_SITE_PATH.replace(/\\/g, '/')}`;

const TEST_CASE_ID = '00000000-0000-0000-0000-000000000010';

function action(
  type: TestAction['type'],
  target_description: string,
  value?: string,
  expected_oracle?: TestAction['expected_oracle']
): TestAction {
  return {
    id: crypto.randomUUID(),
    type,
    target_description,
    value,
    expected_oracle,
  };
}

// ─── Suite ─────────────────────────────────────────────────────
describe('M1 E2E: Executor on Demo Site', () => {
  let pageManager: PageManager;
  let executor: Executor;

  beforeAll(async () => {
    // Verify demo-site exists before launching browser
    expect(fs.existsSync(DEMO_SITE_PATH)).toBe(true);

    pageManager = new PageManager({
      headless: true,
      viewport: { width: 1280, height: 720 },
      screenshotDir: 'reports/screenshots',
    });
    executor = new Executor({
      timeoutMs: 15_000,
      retryCount: 2,
      retryDelayMs: 500,
      screenshotOnFailure: true,
    });

    await pageManager.launch();
  }, 30_000);

  afterAll(async () => {
    await pageManager.close();
  }, 15_000);

  // ── 1. Navigate to demo site ────────────────────────────────
  it('1. navigate: opens demo site successfully', async () => {
    const page = pageManager.getPage();
    const act = action('navigate', DEMO_URL, DEMO_URL);

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
    expect(page.url()).toContain('index.html');
  });

  // ── 2. Assert login page visible ───────────────────────────
  it('2. assert: login page elements are visible', async () => {
    const page = pageManager.getPage();

    const assertEmail = action('assert', 'page', undefined, {
      type: 'element_visible',
      value: '#email',
    });
    const assertPassword = action('assert', 'page', undefined, {
      type: 'element_visible',
      value: '#password',
    });
    const assertLoginBtn = action('assert', 'page', undefined, {
      type: 'element_visible',
      value: '#login-btn',
    });

    expect((await executor.execute(assertEmail, page, TEST_CASE_ID)).status).toBe('passed');
    expect((await executor.execute(assertPassword, page, TEST_CASE_ID)).status).toBe('passed');
    expect((await executor.execute(assertLoginBtn, page, TEST_CASE_ID)).status).toBe('passed');
  });

  // ── 3. Fill email ───────────────────────────────────────────
  it('3. fill: types email into email input', async () => {
    const page = pageManager.getPage();
    const act = action('fill', '#email', 'admin@example.com');

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
    const value = await page.inputValue('#email');
    expect(value).toBe('admin@example.com');
  });

  // ── 4. Fill password ────────────────────────────────────────
  it('4. fill: types password into password input', async () => {
    const page = pageManager.getPage();
    const act = action('fill', '#password', 'password123');

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
    const value = await page.inputValue('#password');
    expect(value).toBe('password123');
  });

  // ── 5. Click login button ───────────────────────────────────
  it('5. click: clicks the login button', async () => {
    const page = pageManager.getPage();
    const act = action('click', '#login-btn');

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
  });

  // ── 6. Assert dashboard visible ─────────────────────────────
  it('6. assert: dashboard appears after successful login', async () => {
    const page = pageManager.getPage();

    const assertDashboard = action('assert', 'page', undefined, {
      type: 'element_visible',
      value: '#dashboard-page',
    });
    const assertLogout = action('assert', 'page', undefined, {
      type: 'element_visible',
      value: '#logout-btn',
    });

    const r1 = await executor.execute(assertDashboard, page, TEST_CASE_ID);
    const r2 = await executor.execute(assertLogout, page, TEST_CASE_ID);

    expect(r1.status).toBe('passed');
    expect(r2.status).toBe('passed');
  });

  // ── 7. Assert no error on success ───────────────────────────
  it('7. assert no_error: no error shown after successful login', async () => {
    const page = pageManager.getPage();
    const act = action('assert', 'page', undefined, {
      type: 'no_error',
      value: '',
    });

    const result = await executor.execute(act, page, TEST_CASE_ID);
    expect(result.status).toBe('passed');
  });

  // ── 8. Counter increment ────────────────────────────────────
  it('8. click: increments counter on dashboard', async () => {
    const page = pageManager.getPage();

    const beforeText = await page.locator('#counter-value').innerText();
    const before = parseInt(beforeText, 10);

    const act = action('click', '#increment-btn');
    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');

    const afterText = await page.locator('#counter-value').innerText();
    const after = parseInt(afterText, 10);
    expect(after).toBe(before + 1);
  });

  // ── 9. Select dropdown option ──────────────────────────────
  it('9. select: selects a role from dropdown', async () => {
    const page = pageManager.getPage();
    const act = action('select', '#role-select', 'admin');

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
    const selected = await page.locator('#role-select').inputValue();
    expect(selected).toBe('admin');
  });

  // ── 10. Hover link ─────────────────────────────────────────
  it('10. hover: hovers over about link', async () => {
    const page = pageManager.getPage();
    const act = action('hover', '#about-link');

    const result = await executor.execute(act, page, TEST_CASE_ID);
    expect(result.status).toBe('passed');
  });

  // ── 11. Wait ms ────────────────────────────────────────────
  it('11. wait: waits for 300ms without error', async () => {
    const page = pageManager.getPage();
    const act = action('wait', 'wait', '300');

    const start = Date.now();
    const result = await executor.execute(act, page, TEST_CASE_ID);
    const elapsed = Date.now() - start;

    expect(result.status).toBe('passed');
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  // ── 12. Scroll into view ────────────────────────────────────
  it('12. scroll: scrolls logout button into view', async () => {
    const page = pageManager.getPage();
    const act = action('scroll', '#logout-btn');

    const result = await executor.execute(act, page, TEST_CASE_ID);
    expect(result.status).toBe('passed');
  });

  // ── 13. Logout flow ─────────────────────────────────────────
  it('13. click: logout returns to login page', async () => {
    const page = pageManager.getPage();
    const act = action('click', '#logout-btn');

    const result = await executor.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('passed');
    // Login page should be visible again
    const loginVisible = await page.locator('#login-page').isVisible();
    expect(loginVisible).toBe(true);
  });

  // ── 14. Wrong credentials → error ──────────────────────────
  it('14. fill+click: wrong credentials shows error message', async () => {
    const page = pageManager.getPage();

    await executor.execute(action('fill', '#email', 'wrong@example.com'), page, TEST_CASE_ID);
    await executor.execute(action('fill', '#password', 'wrongpassword'), page, TEST_CASE_ID);
    await executor.execute(action('click', '#login-btn'), page, TEST_CASE_ID);

    // Error message should be visible
    const errorVisible = await page.locator('#error-message').isVisible();
    expect(errorVisible).toBe(true);

    const errorText = await page.locator('#error-message').innerText();
    expect(errorText).toContain('không đúng');
  });

  // ── 15. Non-existent element → failed result ────────────────
  it('15. click on non-existent element returns failed result', async () => {
    const executor_fast = new Executor({
      timeoutMs: 2000,
      retryCount: 1,
      retryDelayMs: 0,
      screenshotOnFailure: false,
    });
    const page = pageManager.getPage();
    const act = action('click', '#this-element-does-not-exist-xyz');

    const result = await executor_fast.execute(act, page, TEST_CASE_ID);

    expect(result.status).toBe('failed');
    expect(result.error_message).toBeDefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  }, 30_000);

  // ── 16. Screenshot via PageManager ─────────────────────────
  it('16. screenshot: PageManager.screenshot() saves a file', async () => {
    const screenshotPath = await pageManager.screenshot('m1-e2e-final');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    // cleanup
    fs.unlinkSync(screenshotPath);
  });
});
