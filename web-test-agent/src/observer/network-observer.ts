import { Page, Request, Response } from 'playwright';
import { getLogger } from '../logger';
import { NetworkRequest } from './types';

// ============================================================
// Network Observer – web-test-agent / src/observer/network-observer.ts
// Tracks network activity (URL, method, status, resourceType).
// Does NOT store headers, cookies, or sensitive tokens.
// ============================================================

const log = getLogger('network-observer');

export class NetworkObserver {
  private requests: NetworkRequest[] = [];
  private activePage: Page | null = null;
  private maxRequests: number;

  private requestListener: ((req: Request) => void) | null = null;
  private responseListener: ((res: Response) => void) | null = null;

  constructor(maxRequests: number = 200) {
    this.maxRequests = maxRequests;
  }

  /**
   * Attach network listeners to the given Playwright Page.
   */
  attach(page: Page): void {
    if (this.activePage === page) return;
    if (this.activePage) {
      this.detach();
    }

    this.activePage = page;

    // Track request
    this.requestListener = (req: Request) => {
      try {
        const item: NetworkRequest = {
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          timestamp: new Date().toISOString(),
        };

        if (this.requests.length >= this.maxRequests) {
          this.requests.shift(); // Evict oldest
        }
        this.requests.push(item);
      } catch (err) {
        log.debug({ event: 'network_request_error', error: String(err) }, 'Failed to record network request');
      }
    };

    // Update status on response
    this.responseListener = (res: Response) => {
      try {
        const url = res.url();
        // Find most recent request with matching URL without status
        for (let i = this.requests.length - 1; i >= 0; i--) {
          const req = this.requests[i];
          if (req.url === url && req.status === undefined) {
            req.status = res.status();
            break;
          }
        }
      } catch (err) {
        log.debug({ event: 'network_response_error', error: String(err) }, 'Failed to update network response');
      }
    };

    page.on('request', this.requestListener);
    page.on('response', this.responseListener);

    log.debug({ event: 'network_observer_attached' }, 'Network observer attached to page');
  }

  /**
   * Detach listeners from the page.
   */
  detach(): void {
    if (this.activePage) {
      if (this.requestListener) {
        this.activePage.off('request', this.requestListener);
        this.requestListener = null;
      }
      if (this.responseListener) {
        this.activePage.off('response', this.responseListener);
        this.responseListener = null;
      }
      log.debug({ event: 'network_observer_detached' }, 'Network observer detached');
      this.activePage = null;
    }
  }

  /**
   * Get all captured network requests.
   */
  getRequests(): NetworkRequest[] {
    return [...this.requests];
  }

  /**
   * Clear recorded network requests.
   */
  clear(): void {
    this.requests = [];
  }
}
