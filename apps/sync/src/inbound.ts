// Inbound events arrive from the gateway, signed with a timestamp (§18.3). Anything older than 5 minutes or with a
// bad signature is refused (§13.7). Header: `x-gateway-signature: t=<unix seconds>,v1=<hex hmac-sha256>` over
// `${t}.${body}`.

const enc = new TextEncoder();
export const MAX_SKEW_S = 300;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sign(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
}

export async function verifySignature(secret: string, header: string | null, body: string, nowMs: number): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(nowMs / 1000 - t) > MAX_SKEW_S) return false;
  const want = await sign(secret, t, body);
  if (want.length !== parts.v1.length) return false;
  return crypto.subtle.timingSafeEqual(enc.encode(want), enc.encode(parts.v1));
}
