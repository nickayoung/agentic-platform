// Errors as application/problem+json (§11.2, §11.4). A KairosError is a reason code; anything else is a bug.
import { KairosError, REASON_STATUS, type ReasonCode } from '@kairos/errors';
import type { Context } from 'hono';

/** Errors thrown inside a Durable Object arrive over RPC as plain Errors carrying the KairosError fields. */
function asKairos(e: unknown): KairosError | undefined {
  if (e instanceof KairosError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code in REASON_STATUS) {
    const x = e as { message?: string; reasons?: KairosError['reasons']; alternatives?: unknown[] };
    return new KairosError(code as ReasonCode, { message: x.message ?? code, reasons: x.reasons ?? [], alternatives: x.alternatives ?? [] });
  }
  return undefined;
}

export function problem(c: Context, e: unknown): Response {
  const k = asKairos(e);
  const requestId = c.get('requestId' as never) as string | undefined;
  if (!k) {
    console.error(JSON.stringify({ msg: 'unhandled', request_id: requestId, error: String(e), stack: (e as Error)?.stack }));
    return c.json({ type: 'about:blank', title: 'Internal error', status: 500, code: 'INTERNAL', request_id: requestId }, 500, {
      'content-type': 'application/problem+json',
    });
  }
  return c.json(
    { type: 'about:blank', title: k.code, status: k.status, code: k.code, detail: k.message, reasons: k.reasons, alternatives: k.alternatives, request_id: requestId },
    k.status as 400,
    { 'content-type': 'application/problem+json' },
  );
}
