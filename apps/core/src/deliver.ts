// Outbox delivery targets (§19.6). Every outside call goes through the gateway or the notification service, with
// the outbox idempotency key; both deduplicate on it for at least 7 days (§18.3).
import type { Deliver, DeliveryResult, OutboxRow } from '@kairos/scheduler';
import type { Scope } from './scope';

export interface DeliveryEnv {
  GATEWAY_URL?: string;        // e.g. https://gateway.example/v1
  NOTIFY_URL?: string;
  SERVICE_TOKEN?: string;      // Kairos's own service identity (§18.3); outside credentials stay in the gateway
}

const classify = (status: number): DeliveryResult =>
  status >= 200 && status < 300
    ? { ok: true }
    : { ok: false, retryable: status === 408 || status === 429 || status >= 500, error: `HTTP ${status}` };

export function httpDeliver(env: DeliveryEnv, scope: () => Scope, fetcher?: typeof fetch): Deliver {
  return async (row: OutboxRow) => {
    let url: string | undefined;
    if (row.target.startsWith('gateway.')) {
      url = env.GATEWAY_URL && `${env.GATEWAY_URL}/${row.target.slice('gateway.'.length)}/${row.topic}`;
    } else if (row.target === 'notification') {
      url = env.NOTIFY_URL && `${env.NOTIFY_URL}/messages`;
    }
    if (!url) return { ok: false, retryable: false, error: `no route for target ${row.target}` };
    const s = scope();
    const res = await (fetcher ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': row.idempotency_key,
        authorization: `Bearer ${env.SERVICE_TOKEN ?? ''}`,
        'x-kairos-tenant': s.tenant,
        'x-kairos-env': s.env,
      },
      body: row.payload,
    });
    return classify(res.status);
  };
}
