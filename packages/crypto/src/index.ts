// Per-tenant data and blind-index keys (§13.3, §19.13). AES-256-GCM through WebCrypto. Keys are wrapped by the
// key-encryption key (KEK) from Secrets Store; only wrapped keys are stored. All of this is async, so it runs
// before or after a transaction, never inside one (§19.2).

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(s));

const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Imports a base64 KEK (32 random bytes) as an AES-GCM wrapping key. */
export async function importKek(base64: string): Promise<CryptoKey> {
  const raw = unb64(base64);
  if (raw.byteLength !== 32) throw new Error('KEK must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A new random 32-byte key, wrapped by the KEK. Format: "v1.<iv>.<ciphertext>". */
export async function newWrappedKey(kek: CryptoKey): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)));
  return seal(kek, raw);
}

export async function unwrapDataKey(kek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await open(kek, wrapped), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function unwrapIndexKey(kek: CryptoKey, wrapped: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await open(kek, wrapped), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Encrypts one PII field value. The column name is bound as associated data so values can't be swapped. */
export async function encryptField(dek: CryptoKey, column: string, plaintext: string): Promise<string> {
  return seal(dek, bytes(plaintext), bytes(column));
}

export async function decryptField(dek: CryptoKey, column: string, sealed: string): Promise<string> {
  return dec.decode(await open(dek, sealed, bytes(column)));
}

/** Blind index for equality lookup (e.g. email). Input is normalised by the caller. */
export async function blindIndex(indexKey: CryptoKey, column: string, normalised: string): Promise<string> {
  return b64(await crypto.subtle.sign('HMAC', indexKey, enc.encode(`${column}\u0000${normalised}`)));
}

async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>, aad?: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) }, key, data);
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function open(key: CryptoKey, sealed: string, aad?: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unknown sealed format');
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), ...(aad ? { additionalData: aad } : {}) }, key, unb64(ct));
}
