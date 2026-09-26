import { ElementDescriptor, TestAction } from '../models/schemas';
import { Observation } from '../observer/types';
import { getLogger } from '../logger';

// ============================================================
// Action Discovery – web-test-agent / src/explorer/action-discovery.ts
// Enumerates valid interactive actions from observed DOM elements
// without requiring an LLM Planner.
// ============================================================

const log = getLogger('action-discovery');

export class ActionDiscovery {
  /**
   * Discover viable TestActions from observed interactive elements.
   *
   * @param observation Current page observation
   * @param maxActions Maximum actions to generate per state
   */
  discoverActions(observation: Observation, maxActions: number = 10): TestAction[] {
    const actions: TestAction[] = [];
    const elements = observation.elements;

    for (const el of elements) {
      if (actions.length >= maxActions) break;

      const action = this.createActionForElement(el);
      if (action) {
        actions.push(action);
      }
    }

    log.debug(
      { event: 'actions_discovered', count: actions.length, url: observation.page.url },
      `Discovered ${actions.length} interactive actions`
    );

    return actions;
  }

  /**
   * Compute a deterministic key for an action within a state to prevent duplicate executions.
   */
  computeActionKey(stateId: string, action: TestAction): string {
    const normTarget = action.target_description.trim().toLowerCase();
    const val = (action.value || '').trim().toLowerCase();
    return `${stateId}::${action.type}::${normTarget}::${val}`;
  }

  /**
   * Create a TestAction suitable for an ElementDescriptor.
   */
  private createActionForElement(el: ElementDescriptor): TestAction | null {
    const role = (el.role || '').toLowerCase();
    const tag = el.tag.toLowerCase();

    // 1. Buttons (click)
    if (tag === 'button' || role === 'button') {
      const desc = el.text || el.id || el.name || 'button';
      return {
        id: crypto.randomUUID(),
        type: 'click',
        target_description: desc,
      };
    }

    // 2. Links (click)
    if (tag === 'a' || role === 'link') {
      const desc = el.text ? `${el.text} link` : (el.id || el.name || 'link');
      return {
        id: crypto.randomUUID(),
        type: 'click',
        target_description: desc,
      };
    }

    // 3. Select dropdowns (select)
    if (tag === 'select' || role === 'combobox') {
      const desc = el.name ? `${el.name} dropdown` : (el.id || 'select dropdown');
      return {
        id: crypto.randomUUID(),
        type: 'select',
        target_description: desc,
        value: 'tester', // Default safe test option
      };
    }

    // 4. Inputs & Textareas (fill)
    if (tag === 'input' || tag === 'textarea' || role === 'textbox') {
      const type = (el.type || '').toLowerCase();

      if (type === 'submit' || type === 'button' || type === 'reset') {
        return {
          id: crypto.randomUUID(),
          type: 'click',
          target_description: el.id || el.name || 'submit button',
        };
      }

      if (type === 'password') {
        return {
          id: crypto.randomUUID(),
          type: 'fill',
          target_description: el.name || el.id || 'password input',
          value: 'password123',
        };
      }

      if (type === 'email') {
        return {
          id: crypto.randomUUID(),
          type: 'fill',
          target_description: el.name || el.id || 'email input',
          value: 'admin@example.com',
        };
      }

      return {
        id: crypto.randomUUID(),
        type: 'fill',
        target_description: el.name || el.id || 'text input',
        value: 'test',
      };
    }

    return null;
  }
}
