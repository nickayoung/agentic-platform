import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sign, verifySignature, type Page } from '../src/index';

let n = 0;
const fresh = () => {
  const scope = { tenant: `lotus-${n++}`, env: 'preview' as const };
  return { scope, stub: env.TENANT_SYNC.get(env.TENANT_SYNC.idFromName(`${scope.tenant}:${scope.env}`)) };
};
afterEach(() => vi.restoreAllMocks());

function gateway(pages: Record<string, Page>, status = 200) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname + url.search);
    if (status !== 200) return new Response(null, { status });
    const page = pages[url.pathname + (url.searchParams.get('cursor') ? `?${url.searchParams.get('cursor')}` : '')];
    return Response.json(page ?? { records: [], next_cursor: null });
  });
  return calls;
}

describe('TenantSync (Phase 0 skeleton)', () => {
  it('polls through the gateway, follows cursors and stores changed snapshots only', async () => {
    const { scope, stub } = fresh();
    const calls = gateway({
      '/v1/booking_vendor/classes': { records: [{ external_id: 'c1', data: { t: 'VIN60', at: 1 } }], next_cursor: 'p2' },
      '/v1/booking_vendor/classes?p2': { records: [{ external_id: 'c2', data: { t: 'HOT75', at: 2 } }], next_cursor: null },
    });
    await stub.init(scope, { firstPollAt: Date.now() + 3_600_000 });
    const r1 = await stub.poll(scope, 'booking_vendor', 'classes');
    expect(r1).toMatchObject({ records: 2, changed: 2 });
    expect(calls).toEqual(['/v1/booking_vendor/classes', '/v1/booking_vendor/classes?cursor=p2']);
    // the cursor was kept; a re-read of the same page with the same data changes nothing
    const r2 = await stub.poll(scope, 'booking_vendor', 'classes');
    expect(r2.changed).toBe(0);
  });

  it('records a gateway failure and backs off without losing the cursor', async () => {
    const { scope, stub } = fresh();
    gateway({}, 503);
    await stub.init(scope, { firstPollAt: Date.now() + 3_600_000 });
    const r = await stub.poll(scope, 'shift_tool', 'shifts');
    expect(r.error).toMatch(/503/);
    const s = await stub.status(scope);
    const c = s.cursors.find((x) => x.entity_type === 'shifts')!;
    expect(c.consecutive_failures).toBe(1);
    expect(Number(c.next_poll_at)).toBeGreaterThan(Date.now());
  });

  it('deduplicates inbound events by (system, event_id) (§12.6)', async () => {
    const { scope, stub } = fresh();
    await stub.init(scope, { firstPollAt: Date.now() + 3_600_000 });
    expect(await stub.receive(scope, 'booking_vendor', 'evt_1', { kind: 'booking.created' })).toBe(true);
    expect(await stub.receive(scope, 'booking_vendor', 'evt_1', { kind: 'booking.created' })).toBe(false);
    expect((await stub.status(scope)).inboundPending).toBe(1);
  });

  it('the alarm polls every adapter entity that is due', async () => {
    const { scope, stub } = fresh();
    const calls = gateway({});
    await stub.init(scope, { firstPollAt: Date.now() + 3_600_000 });
    await runInDurableObject(stub, (obj) => obj.db.tx((tx) => tx.run('UPDATE adapter_cursor SET next_poll_at = 0')));
    await runInDurableObject(stub, (obj) => obj.alarm());
    expect([...new Set(calls.map((c) => c.split('?')[0]))].sort()).toEqual([
      '/v1/booking_vendor/bookings', '/v1/booking_vendor/classes', '/v1/booking_vendor/members', '/v1/shift_tool/shifts',
    ]);
  });
});

describe('inbound signatures (§13.7, §18.3)', () => {
  it('accepts a fresh, correctly signed body and refuses stale or tampered ones', async () => {
    const body = '{"event_id":"e1"}';
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const header = `t=${t},v1=${await sign('s3cret', t, body)}`;
    expect(await verifySignature('s3cret', header, body, now)).toBe(true);
    expect(await verifySignature('s3cret', header, body + ' ', now)).toBe(false);
    expect(await verifySignature('other', header, body, now)).toBe(false);
    expect(await verifySignature('s3cret', header, body, now + 301_000)).toBe(false);
    expect(await verifySignature('s3cret', null, body, now)).toBe(false);
  });
});
