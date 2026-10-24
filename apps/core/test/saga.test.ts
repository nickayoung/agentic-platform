// Saga runner (§3A.1 C6, §12.7), driven by the scheduler inside a real TenantCore object.
import { env, runInDurableObject } from 'cloudflare:test';
import { sagaSource, SAGA_MAX_ATTEMPTS, startSaga, type SagaDefinition } from '@kairos/scheduler';
import { describe, expect, it } from 'vitest';

let n = 0;
const stub = () => env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`saga-${n++}:preview`));

const counter = (tx: { run(sql: string, ...p: (string | number)[]): number }, key: string) =>
  tx.run(`INSERT INTO limit_counter (key, count, max, window_end) VALUES (?, 1, 1000, 0)
          ON CONFLICT (key) DO UPDATE SET count = count + 1`, key);

describe('saga runner', () => {
  it('runs each step once, in order, one transaction per step', async () => {
    await runInDurableObject(stub(), async (obj) => {
      const def: SagaDefinition<{ seen: number[] }> = {
        kind: 'test',
        steps: [0, 1, 2].map((i) => (tx, ctx) => {
          counter(tx, `step${i}`);
          ctx.setPayload({ seen: [...ctx.payload.seen, i] });
          return 'next';
        }),
      };
      const src = sagaSource(obj.db, [def as SagaDefinition<never>]);
      obj.db.tx((tx) => startSaga(tx, { id: 's1', kind: 'test', payload: { seen: [] } }, 0));
      await src.run(Date.now(), 200);
      await src.run(Date.now(), 200);   // a second tick finds nothing to do
      const s = obj.db.tx((tx) => tx.one<{ state: string; step: number; payload: string }>('SELECT state, step, payload FROM saga'));
      expect(s.state).toBe('done');
      expect(JSON.parse(s.payload)).toEqual({ seen: [0, 1, 2] });
      const counts = obj.db.tx((tx) => tx.all<{ key: string; count: number }>('SELECT key, count FROM limit_counter ORDER BY key'));
      expect(counts).toEqual([{ key: 'step0', count: 1 }, { key: 'step1', count: 1 }, { key: 'step2', count: 1 }]);
    });
  });

  it('a step that waits keeps its place; a failing step rolls back and parks after the last attempt', async () => {
    await runInDurableObject(stub(), async (obj) => {
      let parked: string | null = null;
      let waits = 1;
      const def: SagaDefinition<object> = {
        kind: 'flaky',
        steps: [
          () => (waits-- > 0 ? { wait: 0 } : 'next'),
          (tx) => { counter(tx, 'partial'); throw new Error('outside refused'); },
        ],
        onPark: (tx, _ctx, reason) => { parked = reason; counter(tx, 'compensated'); },
      };
      const src = sagaSource(obj.db, [def as SagaDefinition<never>]);
      obj.db.tx((tx) => startSaga(tx, { id: 's2', kind: 'flaky', payload: {} }, 0));
      await src.run(Date.now(), 200);
      expect(obj.db.tx((tx) => tx.one<{ step: number }>('SELECT step FROM saga')).step).toBe(0);
      for (let i = 0; i < SAGA_MAX_ATTEMPTS + 1; i++) {
        obj.db.tx((tx) => tx.run(`UPDATE saga SET lease_until = 0 WHERE state = 'running'`));
        await src.run(Date.now(), 200);
      }
      const s = obj.db.tx((tx) => tx.one<{ state: string; step: number; attempts: number }>('SELECT state, step, attempts FROM saga'));
      expect(s).toEqual({ state: 'parked', step: 1, attempts: SAGA_MAX_ATTEMPTS });
      expect(parked).toMatch(/outside refused/);
      const keys = obj.db.tx((tx) => tx.all<{ key: string }>('SELECT key FROM limit_counter')).map((r) => r.key);
      expect(keys).toEqual(['compensated']);   // the failing step's write was rolled back every time
    });
  });
});
