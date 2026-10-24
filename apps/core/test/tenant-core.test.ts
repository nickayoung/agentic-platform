import { env, runInDurableObject } from 'cloudflare:test';
import { KairosError } from '@kairos/errors';
import { enqueue, RETRY_DELAYS_MS } from '@kairos/scheduler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, Scope } from '../src/index';

let n = 0;
const fresh = () => {
  const scope: Scope = { tenant: `lotus-${n++}`, env: 'preview' };
  return { scope, stub: env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`${scope.tenant}:${scope.env}`)) };
};
const ctxOf = (scope: Scope): CallContext => ({ scope, actor: { type: 'service', name: 'test' }, requestId: 'req_1' });
/** RPC promises are not plain promises; resolve them to the thrown error explicitly. */
const failure = (p: Promise<unknown>) => Promise.resolve(p).then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as Error & { code?: string });

afterEach(() => vi.restoreAllMocks());

describe('TenantCore', () => {
  it('init seeds all four domains in mirror (§18.2) and arms the alarm', async () => {
    const { scope, stub } = fresh();
    const { modes } = await stub.init(ctxOf(scope));
    expect(modes.map((m) => [m.domain, m.mode])).toEqual([
      ['bookings', 'mirror'], ['classes', 'mirror'], ['members', 'mirror'], ['shifts', 'mirror'],
    ]);
    const h = await stub.health(scope);
    expect(h.migrations).toEqual(['0001_core']);
    expect(h.alarm).not.toBeNull();
    await stub.init(ctxOf(scope));   // idempotent
    expect((await stub.getDomainModes(scope)).length).toBe(4);
  });

  it('refuses a call naming another tenant (§13.1)', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    expect((await failure(stub.health({ tenant: 'someone-else', env: 'preview' }))).code).toBe('TENANT_MISMATCH');
    expect((await failure(stub.health({ tenant: scope.tenant, env: 'production' }))).code).toBe('TENANT_MISMATCH');
  });

  it('setFlag writes the flag, its audit entry and its event in one transaction, with If-Match', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    const f = await stub.setFlag(ctxOf(scope), { key: 'sync.shifts.owner', enabled: false, owner: 'ops', remove_by: '2027-06-01' }, null);
    expect(f).toMatchObject({ key: 'sync.shifts.owner', enabled: false, version: 1 });
    expect((await failure(stub.setFlag(ctxOf(scope), { key: 'sync.shifts.owner', enabled: true, owner: 'ops', remove_by: '2027-06-01' }, 7))).code)
      .toBe('STALE_VERSION');
    const f2 = await stub.setFlag(ctxOf(scope), { key: 'sync.shifts.owner', enabled: true, owner: 'ops', remove_by: '2027-06-01' }, 1);
    expect(f2.version).toBe(2);
    await runInDurableObject(stub, (obj) => {
      const audit = obj.db.tx((tx) => tx.all<{ action: string }>('SELECT action FROM audit ORDER BY seq'));
      expect(audit.map((a) => a.action)).toEqual(['flag.changed', 'flag.changed']);
      const events = obj.db.tx((tx) => tx.all<{ name: string }>('SELECT name FROM domain_event'));
      expect(events).toHaveLength(2);
    });
  });

  it('delivers due outbox rows from the alarm with the idempotency key, and retries on 5xx (§19.6)', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    const seen: { url: string; key: string | null }[] = [];
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, key: new Headers(init?.headers).get('idempotency-key') });
      return new Response(null, { status: fail ? 503 : 200 });
    });
    await runInDurableObject(stub, async (obj) => {
      obj.db.tx((tx) => {
        enqueue(tx, { id: 'o1', topic: 'refund', target: 'gateway.payments', idempotencyKey: 'refund:bkg_1:timely', payload: { amount: 10 }, priority: 0 }, Date.now());
        enqueue(tx, { id: 'o2', topic: 'notify', target: 'notification', idempotencyKey: 'act_1', payload: {} }, Date.now());
        // a duplicate key is a no-op (§9.5)
        enqueue(tx, { id: 'o3', topic: 'notify', target: 'notification', idempotencyKey: 'act_1', payload: {} }, Date.now());
      });
      await obj.alarm();
    });
    expect(seen.map((s) => s.url)).toEqual(['https://gateway.test/v1/payments/refund', 'https://notify.test/v1/messages']);
    expect(seen[0]!.key).toBe('refund:bkg_1:timely');
    await runInDurableObject(stub, async (obj) => {
      const rows = obj.db.tx((tx) => tx.all<{ id: string; state: string; attempts: number; next_attempt_at: number }>(
        'SELECT id, state, attempts, next_attempt_at FROM outbox ORDER BY id'));
      expect(rows.map((r) => [r.id, r.state, r.attempts])).toEqual([['o1', 'pending', 1], ['o2', 'pending', 1]]);
      expect(rows[0]!.next_attempt_at - Date.now()).toBeGreaterThan(RETRY_DELAYS_MS[0] - 5_000);
      // the next alarm is the retry, not later
      const alarm = await obj.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(rows[0]!.next_attempt_at);
      // make the retry due now and succeed
      obj.db.tx((tx) => tx.run('UPDATE outbox SET next_attempt_at = 0'));
      fail = false;
      await obj.alarm();
      expect(obj.db.tx((tx) => tx.all<{ state: string }>('SELECT state FROM outbox')).map((r) => r.state)).toEqual(['sent', 'sent']);
    });
  });

  it('marks a row dead after the last retry and emits outbox.dead (§3A.1 C5)', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 500 }));
    await runInDurableObject(stub, async (obj) => {
      obj.db.tx((tx) => {
        enqueue(tx, { id: 'o1', topic: 'fee', target: 'gateway.payments', idempotencyKey: 'fee:b:late', payload: {} }, Date.now());
        tx.run(`UPDATE outbox SET attempts = ?`, RETRY_DELAYS_MS.length);
      });
      await obj.alarm();
      expect(obj.db.tx((tx) => tx.one<{ state: string }>('SELECT state FROM outbox')).state).toBe('dead');
      expect(obj.db.tx((tx) => tx.all('SELECT 1 FROM domain_event WHERE name = ?', 'outbox.dead'))).toHaveLength(1);
    });
  });

  it('a 4xx is not retried', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 422 }));
    await runInDurableObject(stub, async (obj) => {
      obj.db.tx((tx) => enqueue(tx, { id: 'o1', topic: 'notify', target: 'notification', idempotencyKey: 'k', payload: {} }, Date.now()));
      await obj.alarm();
      expect(obj.db.tx((tx) => tx.one<{ state: string }>('SELECT state FROM outbox')).state).toBe('dead');
    });
  });

  it('the backstop re-arms a cleared alarm and reports it (§19.5)', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    await runInDurableObject(stub, (_obj, state) => state.storage.deleteAlarm());
    expect(await stub.ensureAlarm(scope)).toEqual({ wasMissing: true });
    expect(await stub.ensureAlarm(scope)).toEqual({ wasMissing: false });
  });

  it('an idle object wakes only for maintenance, not every minute', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    const h = await stub.health(scope);
    expect(h.alarm! - Date.now()).toBeGreaterThan(60_000);
  });

  it('KairosError crosses the RPC boundary with its code in the message', async () => {
    const { scope, stub } = fresh();
    await stub.init(ctxOf(scope));
    const e = await failure(stub.setFlag(ctxOf(scope), { key: 'Bad Key', enabled: false, owner: 'x', remove_by: '2027-01-01' }, null));
    expect(e.code).toBe('SCHEMA_INVALID');
    expect(e.message).toMatch(/flag key/);
    void KairosError;
  });
});
