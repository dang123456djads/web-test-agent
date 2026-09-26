import { Page } from 'playwright';
import { getLogger } from '../logger';
import { DomObserver } from './dom-observer';
import { NetworkObserver } from './network-observer';
import { ConsoleObserver } from './console-observer';
import {
  Observation,
  ObservationSchema,
  ObserverConfig,
  ConsoleMessage,
  NetworkRequest,
} from './types';

// ============================================================
// Observer – web-test-agent / src/observer/observer.ts
// Orchestrates DOM, Network, and Console observers.
// Provides unified Observation contract serialized for Planner/LLM.
// ============================================================

const log = getLogger('observer');

export class Observer {
  private readonly domObserver: DomObserver;
  private readonly networkObserver: NetworkObserver;
  private readonly consoleObserver: ConsoleObserver;
  private currentPage: Page | null = null;

  constructor(config: ObserverConfig = {}) {
    this.domObserver = new DomObserver(config);
    this.networkObserver = new NetworkObserver();
    this.consoleObserver = new ConsoleObserver();
  }

  /**
   * Attach observers to a Playwright page.
   * Starts listening to console and network events.
   */
  attach(page: Page): void {
    this.currentPage = page;
    this.networkObserver.attach(page);
    this.consoleObserver.attach(page);
    log.info({ event: 'observer_attached' }, 'Observer attached to browser page');
  }

  /**
   * Detach all observers from the page.
   */
  detach(): void {
    this.networkObserver.detach();
    this.consoleObserver.detach();
    this.currentPage = null;
    log.info({ event: 'observer_detached' }, 'Observer detached from browser page');
  }

  /**
   * Capture a full observation of the current page state.
   * If a page is passed, it attaches to it first if not already attached.
   */
  async observe(page?: Page): Promise<Observation> {
    const targetPage = page ?? this.currentPage;
    if (!targetPage) {
      throw new Error('Observer: No active page to observe. Call attach(page) or pass page to observe().');
    }

    if (page && page !== this.currentPage) {
      this.attach(page);
    }

    const start = Date.now();

    // 1. Capture Page metadata and DOM snapshot
    const pageObservation = await this.domObserver.observePage(targetPage);

    // 2. Extract visible interactive elements
    const elements = await this.domObserver.observeInteractiveElements(targetPage);

    // 3. Get network requests
    const network = this.networkObserver.getRequests();

    // 4. Get console messages
    const console = this.consoleObserver.getMessages();

    const rawObservation: Observation = {
      page: pageObservation,
      elements,
      network,
      console,
      captured_at: new Date().toISOString(),
    };

    // Validate against central ObservationSchema
    const observation = ObservationSchema.parse(rawObservation);

    const durationMs = Date.now() - start;
    log.info(
      {
        event: 'observation_captured',
        url: observation.page.url,
        title: observation.page.title,
        element_count: observation.elements.length,
        network_count: observation.network.length,
        console_count: observation.console.length,
        duration_ms: durationMs,
      },
      'Observation captured successfully'
    );

    return observation;
  }

  /**
   * Check whether any console errors were recorded.
   */
  hasConsoleErrors(): boolean {
    return this.consoleObserver.hasErrors();
  }

  /**
   * Retrieve all recorded console errors.
   */
  getConsoleErrors(): ConsoleMessage[] {
    return this.consoleObserver.getErrors();
  }

  /**
   * Retrieve all recorded console messages.
   */
  getConsoleMessages(): ConsoleMessage[] {
    return this.consoleObserver.getMessages();
  }

  /**
   * Retrieve all recorded network requests.
   */
  getNetworkRequests(): NetworkRequest[] {
    return this.networkObserver.getRequests();
  }

  /**
   * Reset console and network event buffers between actions.
   */
  clearBuffers(): void {
    this.networkObserver.clear();
    this.consoleObserver.clear();
    log.debug({ event: 'buffers_cleared' }, 'Network and console buffers cleared');
  }
}

export * from './types';
export * from './dom-observer';
export * from './network-observer';
export * from './console-observer';
