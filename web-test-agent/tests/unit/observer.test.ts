/**
 * M2 Unit Tests – Observer
 *
 * Tests Observer, DomObserver, NetworkObserver, and ConsoleObserver
 * with a mocked Playwright Page object.
 */

import { Observer } from '../../src/observer/observer';
import { DomObserver } from '../../src/observer/dom-observer';
import { NetworkObserver } from '../../src/observer/network-observer';
import { ConsoleObserver } from '../../src/observer/console-observer';
import { ObservationSchema } from '../../src/observer/types';

// ─── Mock Helpers ─────────────────────────────────────────────

function createMockPage() {
  const listeners: Record<string, Function[]> = {};

  return {
    url: jest.fn().mockReturnValue('https://example.com/test'),
    title: jest.fn().mockResolvedValue('Test Page Title'),
    content: jest.fn().mockResolvedValue('<html><body><button id="btn">Click</button></body></html>'),
    evaluate: jest.fn().mockResolvedValue([
      {
        tag: 'button',
        id: 'btn',
        text: 'Click',
        css_selector: '#btn',
        bounding_box: { x: 10, y: 20, width: 80, height: 30 },
      },
      {
        tag: 'input',
        name: 'username',
        type: 'text',
        placeholder: 'Enter username',
        css_selector: 'input[name="username"]',
        bounding_box: { x: 10, y: 60, width: 200, height: 35 },
      },
    ]),
    on: jest.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: jest.fn((event: string, handler: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    emit: (event: string, ...args: any[]) => {
      if (listeners[event]) {
        for (const handler of listeners[event]) {
          handler(...args);
        }
      }
    },
  };
}

describe('M2 Unit: Observer Suite', () => {
  describe('DomObserver', () => {
    it('should observe page url, title, and DOM content', async () => {
      const mockPage = createMockPage();
      const domObserver = new DomObserver();

      const pageObs = await domObserver.observePage(mockPage as any);

      expect(pageObs.url).toBe('https://example.com/test');
      expect(pageObs.title).toBe('Test Page Title');
      expect(pageObs.dom).toContain('<button id="btn">Click</button>');
    });

    it('should truncate DOM if it exceeds maxDomLength', async () => {
      const mockPage = createMockPage();
      mockPage.content.mockResolvedValueOnce('A'.repeat(500));

      const domObserver = new DomObserver({ maxDomLength: 100 });
      const pageObs = await domObserver.observePage(mockPage as any);

      expect(pageObs.dom.length).toBeLessThan(200);
      expect(pageObs.dom).toContain('<!-- DOM TRUNCATED -->');
    });

    it('should extract and validate interactive elements', async () => {
      const mockPage = createMockPage();
      const domObserver = new DomObserver();

      const elements = await domObserver.observeInteractiveElements(mockPage as any);

      expect(elements).toHaveLength(2);
      expect(elements[0].tag).toBe('button');
      expect(elements[0].id).toBe('btn');
      expect(elements[0].text).toBe('Click');
      expect(elements[1].tag).toBe('input');
      expect(elements[1].name).toBe('username');
      expect(elements[1].placeholder).toBe('Enter username');
    });
  });

  describe('NetworkObserver', () => {
    it('should capture network request and matching response status', () => {
      const mockPage = createMockPage();
      const networkObserver = new NetworkObserver();
      networkObserver.attach(mockPage as any);

      // Simulate request
      mockPage.emit('request', {
        url: () => 'https://api.example.com/data',
        method: () => 'GET',
        resourceType: () => 'fetch',
      });

      let requests = networkObserver.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://api.example.com/data');
      expect(requests[0].method).toBe('GET');
      expect(requests[0].resourceType).toBe('fetch');
      expect(requests[0].status).toBeUndefined();

      // Simulate response
      mockPage.emit('response', {
        url: () => 'https://api.example.com/data',
        status: () => 200,
      });

      requests = networkObserver.getRequests();
      expect(requests[0].status).toBe(200);

      // Clear
      networkObserver.clear();
      expect(networkObserver.getRequests()).toHaveLength(0);

      // Detach
      networkObserver.detach();
      expect(mockPage.off).toHaveBeenCalled();
    });
  });

  describe('ConsoleObserver', () => {
    it('should capture console log, warn, and error messages', () => {
      const mockPage = createMockPage();
      const consoleObserver = new ConsoleObserver();
      consoleObserver.attach(mockPage as any);

      mockPage.emit('console', {
        type: () => 'log',
        text: () => 'User clicked submit',
      });

      mockPage.emit('console', {
        type: () => 'error',
        text: () => 'Uncaught TypeError: something failed',
      });

      mockPage.emit('console', {
        type: () => 'warning',
        text: () => 'Deprecation warning',
      });

      const all = consoleObserver.getMessages();
      expect(all).toHaveLength(3);
      expect(consoleObserver.hasErrors()).toBe(true);

      const errors = consoleObserver.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('error');
      expect(errors[0].text).toContain('Uncaught TypeError');
    });

    it('should capture uncaught page errors via pageerror event', () => {
      const mockPage = createMockPage();
      const consoleObserver = new ConsoleObserver();
      consoleObserver.attach(mockPage as any);

      mockPage.emit('pageerror', new Error('Script crash exception'));

      expect(consoleObserver.hasErrors()).toBe(true);
      const errors = consoleObserver.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].text).toContain('Script crash exception');
    });
  });

  describe('Unified Observer', () => {
    it('should capture unified observation conforming to ObservationSchema', async () => {
      const mockPage = createMockPage();
      const observer = new Observer();
      observer.attach(mockPage as any);

      // Emit some network and console events
      mockPage.emit('request', {
        url: () => 'https://example.com/api',
        method: () => 'POST',
        resourceType: () => 'xhr',
      });
      mockPage.emit('response', {
        url: () => 'https://example.com/api',
        status: () => 201,
      });
      mockPage.emit('console', {
        type: () => 'info',
        text: () => 'Application initialized',
      });

      const observation = await observer.observe();

      // Validate schema
      const parseResult = ObservationSchema.safeParse(observation);
      expect(parseResult.success).toBe(true);

      expect(observation.page.url).toBe('https://example.com/test');
      expect(observation.page.title).toBe('Test Page Title');
      expect(observation.elements).toHaveLength(2);
      expect(observation.network).toHaveLength(1);
      expect(observation.network[0].status).toBe(201);
      expect(observation.console).toHaveLength(1);

      // Test JSON serializability
      const json = JSON.stringify(observation);
      const parsedFromJson = JSON.parse(json);
      expect(parsedFromJson.page.title).toBe('Test Page Title');
      expect(parsedFromJson.elements[0].id).toBe('btn');

      // Clear buffers
      observer.clearBuffers();
      expect(observer.getNetworkRequests()).toHaveLength(0);
      expect(observer.getConsoleMessages()).toHaveLength(0);

      observer.detach();
    });

    it('should throw when observe() is called without an attached page', async () => {
      const observer = new Observer();
      await expect(observer.observe()).rejects.toThrow(/No active page/i);
    });
  });
});
