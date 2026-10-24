import { env, runInDurableObject } from 'cloudflare:test';
import type { Db } from '../src/index';

let n = 0;
/** Runs `fn` inside a fresh, migrated SQLite-backed object. */
export async function withDb<T>(fn: (db: Db, storage: DurableObjectStorage) => T | Promise<T>): Promise<T> {
  const stub = env.TEST_DB.get(env.TEST_DB.idFromName(`test-${Date.now()}-${n++}`));
  return runInDurableObject(stub, (obj, state) => fn(obj.db, state.storage));
}

export const T0 = Date.UTC(2027, 2, 9, 12, 0, 0);   // grain-aligned
export const MIN = 60_000;

export function seedResource(db: Db, id: string, concurrency = 1): void {
  db.tx((tx) => {
    tx.run(
      `INSERT INTO resource (id, kind, type_key, name, timezone, concurrency, source, created_at, updated_at)
       VALUES (?, 'person', 'teacher', ?, 'America/New_York', ?, 'platform', 0, 0)`,
      id, id, concurrency,
    );
  });
}
