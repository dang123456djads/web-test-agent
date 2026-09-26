import { Page, ConsoleMessage as PlaywrightConsoleMessage } from 'playwright';
import { getLogger } from '../logger';
import { ConsoleMessage } from './types';

// ============================================================
// Console Observer – web-test-agent / src/observer/console-observer.ts
// Captures console messages and uncaught page errors.
// ============================================================

const log = getLogger('console-observer');

export class ConsoleObserver {
  private messages: ConsoleMessage[] = [];
  private activePage: Page | null = null;
  private maxMessages: number;

  private consoleListener: ((msg: PlaywrightConsoleMessage) => void) | null = null;
  private pageErrorListener: ((error: Error) => void) | null = null;

  constructor(maxMessages: number = 200) {
    this.maxMessages = maxMessages;
  }

  /**
   * Attach console and page error listeners to the Playwright Page.
   */
  attach(page: Page): void {
    if (this.activePage === page) return;
    if (this.activePage) {
      this.detach();
    }

    this.activePage = page;

    // Listen to console API events
    this.consoleListener = (msg: PlaywrightConsoleMessage) => {
      try {
        const rawType = msg.type();
        let type: ConsoleMessage['type'] = 'log';

        if (rawType === 'error') type = 'error';
        else if (rawType === 'warning') type = 'warn';
        else if (rawType === 'info') type = 'info';
        else if (rawType === 'debug') type = 'debug';
        else type = 'log';

        const item: ConsoleMessage = {
          type,
          text: msg.text(),
          timestamp: new Date().toISOString(),
        };

        if (this.messages.length >= this.maxMessages) {
          this.messages.shift();
        }
        this.messages.push(item);
      } catch (err) {
        log.debug({ event: 'console_capture_error', error: String(err) }, 'Failed to record console message');
      }
    };

    // Listen to uncaught page exceptions (window.onerror)
    this.pageErrorListener = (error: Error) => {
      try {
        const item: ConsoleMessage = {
          type: 'error',
          text: error.message || String(error),
          timestamp: new Date().toISOString(),
        };

        if (this.messages.length >= this.maxMessages) {
          this.messages.shift();
        }
        this.messages.push(item);

        log.debug({ event: 'page_error_captured', error: item.text }, 'Captured uncaught page error');
      } catch (err) {
        log.debug({ event: 'page_error_handling_error', error: String(err) }, 'Failed to record page error');
      }
    };

    page.on('console', this.consoleListener);
    page.on('pageerror', this.pageErrorListener);

    log.debug({ event: 'console_observer_attached' }, 'Console observer attached to page');
  }

  /**
   * Detach listeners from the page.
   */
  detach(): void {
    if (this.activePage) {
      if (this.consoleListener) {
        this.activePage.off('console', this.consoleListener);
        this.consoleListener = null;
      }
      if (this.pageErrorListener) {
        this.activePage.off('pageerror', this.pageErrorListener);
        this.pageErrorListener = null;
      }
      log.debug({ event: 'console_observer_detached' }, 'Console observer detached');
      this.activePage = null;
    }
  }

  /**
   * Get all captured console messages.
   */
  getMessages(): ConsoleMessage[] {
    return [...this.messages];
  }

  /**
   * Filter and return only error messages.
   */
  getErrors(): ConsoleMessage[] {
    return this.messages.filter((m) => m.type === 'error');
  }

  /**
   * Check whether any error messages have been captured.
   */
  hasErrors(): boolean {
    return this.messages.some((m) => m.type === 'error');
  }

  /**
   * Clear recorded console messages.
   */
  clear(): void {
    this.messages = [];
  }
}
