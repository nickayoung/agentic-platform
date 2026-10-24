// Migrations run in the object's constructor inside blockConcurrencyWhile, before any request (§19.8).

export interface Migration {
  id: string;   // "0001_core"
  sql: string;
}

export function applyMigrations(storage: DurableObjectStorage, migrations: readonly Migration[], now: number): string[] {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(sql.exec<{ id: string }>('SELECT id FROM _migrations').toArray().map((r) => r.id));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (done.has(m.id)) continue;
    storage.transactionSync(() => {
      sql.exec(m.sql);
      sql.exec('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, now);
    });
    applied.push(m.id);
  }
  return applied;
}
