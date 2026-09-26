import { Browser, BrowserContext, Page, chromium, LaunchOptions } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logger';

// ============================================================
// PageManager – web-test-agent / src/executor/page-manager.ts
// Manages Playwright browser/context/page lifecycle.
// One PageManager instance = one browser session.
// ============================================================

const log = getLogger('page-manager');

export interface PageManagerOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  screenshotDir?: string;
  slowMo?: number;
}

const DEFAULT_OPTIONS: Required<PageManagerOptions> = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  screenshotDir: 'reports/screenshots',
  slowMo: 0,
};

export class PageManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly opts: Required<PageManagerOptions>;

  constructor(options: PageManagerOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Launch browser and create a new page.
   * Idempotent – safe to call multiple times.
   */
  async launch(): Promise<Page> {
    if (this.page) {
      log.debug({ event: 'reuse_page' }, 'Reusing existing page');
      return this.page;
    }

    log.info(
      { event: 'browser_launch', headless: this.opts.headless },
      'Launching Chromium browser'
    );

    const launchOptions: LaunchOptions = {
      headless: this.opts.headless,
      slowMo: this.opts.slowMo,
    };

    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      ignoreHTTPSErrors: true,
    });
    this.page = await this.context.newPage();

    // Ensure screenshot directory exists
    if (!fs.existsSync(this.opts.screenshotDir)) {
      fs.mkdirSync(this.opts.screenshotDir, { recursive: true });
    }

    log.info({ event: 'browser_ready' }, 'Browser ready');
    return this.page;
  }

  /**
   * Returns the current page. Throws if not launched yet.
   */
  getPage(): Page {
    if (!this.page) {
      throw new Error('PageManager: browser not launched. Call launch() first.');
    }
    return this.page;
  }

  /**
   * Take a screenshot and save to screenshotDir.
   * Returns the absolute file path.
   */
  async screenshot(name: string): Promise<string> {
    const page = this.getPage();
    const filename = `${name}-${Date.now()}.png`;
    const filepath = path.resolve(this.opts.screenshotDir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    log.info({ event: 'screenshot', path: filepath }, 'Screenshot saved');
    return filepath;
  }

  /**
   * Close all browser resources.
   */
  async close(): Promise<void> {
    log.info({ event: 'browser_close' }, 'Closing browser');
    try {
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }

  /**
   * Whether the browser is currently open.
   */
  isOpen(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }
}
