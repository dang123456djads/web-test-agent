import { Page } from 'playwright';
import { getLogger } from '../logger';
import { ElementDescriptor, ElementDescriptorSchema } from '../models/schemas';
import { PageObservation, ObserverConfig } from './types';

// ============================================================
// DOM Observer – web-test-agent / src/observer/dom-observer.ts
// Extracts URL, Title, DOM HTML snapshot, and visible interactive elements.
// ============================================================

const log = getLogger('dom-observer');

const DEFAULT_MAX_DOM_LENGTH = 200_000;
const DEFAULT_MAX_ELEMENTS = 150;

export class DomObserver {
  private readonly maxDomLength: number;
  private readonly maxElements: number;
  private readonly captureDom: boolean;

  constructor(config: ObserverConfig = {}) {
    this.maxDomLength = config.maxDomLength ?? DEFAULT_MAX_DOM_LENGTH;
    this.maxElements = config.maxElements ?? DEFAULT_MAX_ELEMENTS;
    this.captureDom = config.captureDom ?? true;
  }

  /**
   * Observe page metadata and DOM content.
   */
  async observePage(page: Page): Promise<PageObservation> {
    const url = page.url();
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '';
    }

    let dom = '';
    if (this.captureDom) {
      try {
        const fullContent = await page.content();
        if (fullContent.length > this.maxDomLength) {
          dom = fullContent.slice(0, this.maxDomLength) + '\n<!-- DOM TRUNCATED -->';
        } else {
          dom = fullContent;
        }
      } catch (err) {
        log.warn({ event: 'dom_capture_error', error: String(err) }, 'Failed to capture DOM HTML');
        dom = '';
      }
    }

    return { url, title, dom };
  }

  /**
   * Extract visible interactive elements from the page.
   * Elements match standard interactive criteria (buttons, links, inputs, selects, ARIA roles).
   */
  async observeInteractiveElements(page: Page): Promise<ElementDescriptor[]> {
    try {
      const rawElements = await page.evaluate((maxCount) => {
        const interactiveSelector = [
          'button',
          'a[href]',
          'input',
          'select',
          'textarea',
          '[role="button"]',
          '[role="link"]',
          '[role="menuitem"]',
          '[role="tab"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[tabindex]:not([tabindex="-1"])',
        ].join(', ');

        const candidateNodes = Array.from(document.querySelectorAll(interactiveSelector));
        const results: any[] = [];

        function isVisible(el: HTMLElement): boolean {
          if (!el || !(el instanceof HTMLElement)) return false;
          if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          return true;
        }

        function buildCssSelector(el: HTMLElement): string {
          if (el.id) return `#${CSS.escape(el.id)}`;
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute('name');
          if (name) return `${tag}[name="${CSS.escape(name)}"]`;
          const type = el.getAttribute('type');
          if (type) return `${tag}[type="${CSS.escape(type)}"]`;
          const role = el.getAttribute('role');
          if (role) return `${tag}[role="${CSS.escape(role)}"]`;
          if (el.className && typeof el.className === 'string') {
            const firstClass = el.className.trim().split(/\s+/)[0];
            if (firstClass) return `${tag}.${CSS.escape(firstClass)}`;
          }
          return tag;
        }

        for (const node of candidateNodes) {
          if (results.length >= maxCount) break;
          const el = node as HTMLElement;
          if (!isVisible(el)) continue;

          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
          const classes = Array.from(el.classList).filter(Boolean);

          results.push({
            tag,
            id: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            text: text || undefined,
            aria_label: el.getAttribute('aria-label') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            role: el.getAttribute('role') || undefined,
            type: el.getAttribute('type') || undefined,
            classes: classes.length > 0 ? classes : undefined,
            css_selector: buildCssSelector(el),
            bounding_box: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
        }

        return results;
      }, this.maxElements);

      // Validate through ElementDescriptorSchema
      const validated: ElementDescriptor[] = [];
      for (const item of rawElements) {
        const parseResult = ElementDescriptorSchema.safeParse(item);
        if (parseResult.success) {
          validated.push(parseResult.data);
        } else {
          log.warn(
            { event: 'element_validation_warning', error: parseResult.error.message },
            'Element descriptor failed validation'
          );
        }
      }

      log.debug(
        { event: 'dom_elements_observed', count: validated.length },
        `Extracted ${validated.length} interactive elements`
      );

      return validated;
    } catch (err) {
      log.error({ event: 'dom_elements_error', error: String(err) }, 'Failed to extract interactive elements');
      return [];
    }
  }
}
