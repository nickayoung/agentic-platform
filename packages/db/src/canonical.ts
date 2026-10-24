// Canonical JSON (RFC 8785) and SHA-256, synchronous so they can run inside a transaction (§19.2).
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw new Error('value cannot be canonicalised');
  return out;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
