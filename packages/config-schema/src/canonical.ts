// Canonical JSON (RFC 8785) and the content hash of a config document (§4). Synchronous `node:crypto` only, so it runs
// on Workers with `nodejs_compat` and inside a transaction (§19.2).
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error('value cannot be canonicalised');
  return out;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** SHA-256 hex of the document's canonical JSON. Key order and YAML formatting do not affect it. */
export const contentHash = (doc: unknown): string => sha256Hex(canonicalJson(doc));
