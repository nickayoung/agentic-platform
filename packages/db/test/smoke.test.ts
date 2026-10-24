import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('applies the core migration in a SQLite-backed object', async () => {
  const stub = env.TEST_DB.get(env.TEST_DB.idFromName('t:preview'));
  await runInDurableObject(stub, (obj) => {
    const n = obj.db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM lanes').n);
    expect(n).toBe(16);
  });
});
