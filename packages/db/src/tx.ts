// The batch is one synchronous SQLite transaction inside the tenant's Durable Object (§12.2, §19.2).
// A transaction body may not await: `tx()` rejects a promise-returning callback by type and at runtime.

import { KairosError, type ReasonCode } from '@kairos/errors';

export type SqlValue = string | number | null | ArrayBuffer;
export type Row = Record<string, SqlStorageValue>;

/** Synchronous SQL handle, valid only inside `Db.tx`. */
export interface Tx {
  all<R extends Row = Row>(sql: string, ...params: SqlValue[]): R[];
  /** Exactly one row, else a defect. */
  one<R extends Row = Row>(sql: string, ...params: SqlValue[]): R;
  /** Zero or one row. */
  maybe<R extends Row = Row>(sql: string, ...params: SqlValue[]): R | undefined;
  /** A write; returns the number of rows written. */
  run(sql: string, ...params: SqlValue[]): number;
}

type NotThenable<T> = T extends PromiseLike<unknown> ? never : T;

/** Maps a constraint name (table or index, as SQLite reports it) to a reason code. */
export type ConstraintMap = Record<string, ReasonCode>;

export interface Db {
  tx<T>(fn: (tx: Tx) => NotThenable<T>): T;
}

export class TxDefect extends Error {
  override name = 'TxDefect';
}

function makeTx(sql: SqlStorage): Tx {
  return {
    all: <R extends Row>(q: string, ...p: SqlValue[]) => sql.exec<R>(q, ...p).toArray(),
    one: <R extends Row>(q: string, ...p: SqlValue[]) => {
      const rows = sql.exec<R>(q, ...p).toArray();
      if (rows.length !== 1) throw new TxDefect(`expected one row, got ${rows.length}: ${q.slice(0, 80)}`);
      return rows[0]!;
    },
    maybe: <R extends Row>(q: string, ...p: SqlValue[]) => {
      const rows = sql.exec<R>(q, ...p).toArray();
      if (rows.length > 1) throw new TxDefect(`expected at most one row, got ${rows.length}: ${q.slice(0, 80)}`);
      return rows[0];
    },
    run: (q: string, ...p: SqlValue[]) => sql.exec(q, ...p).rowsWritten,
  };
}

const isThenable = (v: unknown): boolean =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';

/**
 * Maps a SQLite constraint failure to a reason code using the table or index named in the message,
 * e.g. "UNIQUE constraint failed: occupancy.resource_id, …" or "CHECK constraint failed: balance >= 0".
 */
export function mapConstraint(e: unknown, map: ConstraintMap): KairosError | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /(UNIQUE|CHECK|NOT NULL|PRIMARY KEY|FOREIGN KEY) constraint failed: ([^\s,:]+)/.exec(msg);
  if (!m) return undefined;
  const subject = m[2]!;
  const table = subject.split('.')[0]!;
  const code = map[subject] ?? map[table];
  return code ? new KairosError(code, { message: msg }) : undefined;
}

export function createDb(storage: DurableObjectStorage, constraints: ConstraintMap = {}): Db {
  const tx = makeTx(storage.sql);
  return {
    tx<T>(fn: (tx: Tx) => NotThenable<T>): T {
      try {
        return storage.transactionSync(() => {
          const out = fn(tx);
          if (isThenable(out)) throw new TxDefect('transaction body returned a promise; bodies must be synchronous (§19.2)');
          return out;
        });
      } catch (e) {
        if (e instanceof KairosError || e instanceof TxDefect) throw e;
        throw mapConstraint(e, constraints) ?? e;
      }
    },
  };
}
