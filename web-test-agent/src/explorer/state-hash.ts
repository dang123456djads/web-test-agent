import * as crypto from 'crypto';

// ============================================================
// State Hash – web-test-agent / src/explorer/state-hash.ts
// Generates a deterministic SHA-256 fingerprint for web states.
// ============================================================

/**
 * Compute a deterministic SHA-256 hash for a web state.
 *
 * @param url Normalized page URL
 * @param content Normalized element signatures or DOM fingerprint
 * @param title Optional page title
 * @returns 64-character hex hash string
 */
export function computeStateHash(
  url: string,
  content: string | string[],
  title: string = ''
): string {
  const normalizedUrl = url.trim().toLowerCase();
  const normalizedTitle = title.trim();

  let body = '';
  if (Array.isArray(content)) {
    // Deterministically sort and join signatures
    body = [...content].sort().join('|');
  } else {
    body = content.trim();
  }

  const payload = `url:${normalizedUrl}#title:${normalizedTitle}#body:${body}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
