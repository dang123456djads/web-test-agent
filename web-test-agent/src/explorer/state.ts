import { ElementDescriptor, TestAction } from '../models/schemas';
import { Observation } from '../observer/types';
import { computeStateHash } from './state-hash';
import { StateNode } from './types';

// ============================================================
// State Representation – web-test-agent / src/explorer/state.ts
// Normalization, element signatures, and StateNode factory.
// ============================================================

const EPHEMERAL_QUERY_PARAMS = new Set([
  'timestamp',
  'time',
  't',
  '_',
  'nonce',
  'random',
  'cache',
  'v',
]);

/**
 * Normalize a URL by stripping ephemeral query params while preserving
 * path and routing hash (SPA hash-based routes).
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    // If it's a file:// URL or invalid standard URL, normalize manually
    if (rawUrl.startsWith('file://')) {
      const hashIndex = rawUrl.indexOf('#');
      const hash = hashIndex !== -1 ? rawUrl.slice(hashIndex) : '';
      const base = hashIndex !== -1 ? rawUrl.slice(0, hashIndex) : rawUrl;
      return `${base.replace(/\\/g, '/').toLowerCase()}${hash.toLowerCase()}`;
    }

    const parsed = new URL(rawUrl);
    // Remove ephemeral parameters
    const searchParams = new URLSearchParams(parsed.search);
    for (const key of Array.from(searchParams.keys())) {
      if (EPHEMERAL_QUERY_PARAMS.has(key.toLowerCase())) {
        searchParams.delete(key);
      }
    }
    const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : '';
    return `${parsed.origin}${parsed.pathname.toLowerCase()}${cleanSearch}${parsed.hash.toLowerCase()}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Extract stable element signatures from interactive element descriptors.
 * Ignores dynamic IDs or random classes; focuses on tag, role, id, name, text, and type.
 */
export function extractElementSignatures(elements: ElementDescriptor[]): string[] {
  return elements.map((el) => {
    const tag = el.tag.toLowerCase();
    const role = (el.role || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    const text = el.text ? el.text.trim().toLowerCase().slice(0, 40) : '';

    return `${tag}|${role}|${id}|${name}|${type}|${text}`;
  });
}

/**
 * Factory to create a StateNode from an Observation.
 */
export function createStateNode(
  observation: Observation,
  depth: number = 0,
  pathFromRoot: TestAction[] = [],
  parentStateId?: string,
  actionFromParent?: TestAction
): StateNode {
  const normUrl = normalizeUrl(observation.page.url);
  const elementSignatures = extractElementSignatures(observation.elements);
  const stateId = computeStateHash(normUrl, elementSignatures, observation.page.title);

  return {
    stateId,
    url: observation.page.url,
    normalizedUrl: normUrl,
    title: observation.page.title,
    depth,
    parentStateId,
    actionFromParent,
    pathFromRoot,
    observation,
    discoveredAt: new Date().toISOString(),
  };
}
