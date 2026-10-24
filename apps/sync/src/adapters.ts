// Read-only adapters for outside systems (§18.5). Phase 0 only reads, through the gateway, and stores raw
// snapshots; mirror ingestion into TenantCore starts in Phase 1. BookingVendor's and ShiftTool's real API details
// are open (Q-11), so each adapter reads a normalised gateway contract: GET /{system}/{entity}?cursor=… returns
// { records: [{ external_id, external_version?, data }], next_cursor }.

export interface OutsideRecord {
  external_id: string;
  external_version?: string | null;
  data: Record<string, unknown>;
}

export interface Page {
  records: OutsideRecord[];
  next_cursor: string | null;
}

export interface AdapterDef {
  system: 'booking_vendor' | 'shift_tool';
  entities: readonly string[];
  /** Poll interval per entity (Phase 0: flat; §18.5 windows arrive with mirror ingestion in Phase 1). */
  pollEveryMs: number;
}

export const ADAPTERS: readonly AdapterDef[] = [
  { system: 'booking_vendor', entities: ['classes', 'bookings', 'members'], pollEveryMs: 5 * 60_000 },
  { system: 'shift_tool', entities: ['shifts'], pollEveryMs: 5 * 60_000 },
];

export interface GatewayEnv {
  GATEWAY_URL?: string;
  SERVICE_TOKEN?: string;
  /** Preview only: the demo gateway Worker, bound because Workers can't fetch each other over workers.dev. */
  GATEWAY?: Fetcher;
}

export const READ_TIMEOUT_MS = 5_000;   // §7.12

export async function readPage(env: GatewayEnv, scope: { tenant: string; env: string }, system: string, entity: string, cursor: string | null): Promise<Page> {
  if (!env.GATEWAY_URL) throw new Error('GATEWAY_URL is not set');
  const url = new URL(`${env.GATEWAY_URL}/${system}/${entity}`);
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await (env.GATEWAY ? env.GATEWAY.fetch.bind(env.GATEWAY) : globalThis.fetch)(url, {
    headers: { authorization: `Bearer ${env.SERVICE_TOKEN ?? ''}`, 'x-kairos-tenant': scope.tenant, 'x-kairos-env': scope.env },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway ${system}/${entity}: HTTP ${res.status}`);
  const body = (await res.json()) as Page;
  if (!Array.isArray(body.records)) throw new Error(`gateway ${system}/${entity}: malformed page`);
  return body;
}
