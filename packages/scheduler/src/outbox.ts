// Outbox: side effects written in the same transaction as the change, delivered after commit (§12.6, §19.6).
// Delivery leases rows in one transaction, awaits outside any transaction, and records the result in another.
import type { Db, Tx } from '@kairos/db';
import type { TickSource } from './scheduler';

/** §3A.1 C5: retry at 1 m, 5 m, 30 m, 2 h and 12 h, then dead. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;
export const LEASE_MS = 60_000;
export const MAX_IN_FLIGHT = 6;   // Workers limit on simultaneous outbound connections per invocation

/** Lower runs first. Money jobs (refunds, fees, captures) are 0. */
export type Priority = 0 | 1;

export interface OutboxInput {
  id: string;
  topic: string;            // e.g. "notify", "refund", "push.booking_vendor"
  target: string;           // e.g. "gateway.payments", "notification", "rpc.sync"
  idempotencyKey: string;
  payload: unknown;
  priority?: Priority;
  notBefore?: number;
}

export interface OutboxRow {
  id: string;
  topic: string;
  target: string;
  idempotency_key: string;
  payload: string;
  attempts: number;
  priority: number;
}

export type DeliveryResult = { ok: true } | { ok: false; retryable: boolean; error: string };
export type Deliver = (row: OutboxRow) => Promise<DeliveryResult>;

/** Writes an outbox row inside the caller's transaction. Duplicate idempotency keys are no-ops (§9.5). */
export function enqueue(tx: Tx, o: OutboxInput, now: number): boolean {
  return (
    tx.run(
      `INSERT INTO outbox (id, topic, target, idempotency_key, payload, state, attempts, next_attempt_at, priority, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
      o.id, o.topic, o.target, o.idempotencyKey, JSON.stringify(o.payload ?? null), o.notBefore ?? now, o.priority ?? 1, now,
    ) === 1
  );
}

export interface OutboxSourceOptions {
  db: Db;
  deliver: Deliver;
  /** Called in the transaction that marks a row dead, e.g. to create a manager_inbox task (§3A.1 C5). */
  onDead?: (tx: Tx, row: OutboxRow, error: string, now: number) => void;
}

export function outboxSource(o: OutboxSourceOptions): TickSource {
  return {
    name: 'outbox',
    nextDue: (db) =>
      db.tx((tx) => {
        const r = tx.maybe<{ t: number | null }>(
          `SELECT min(CASE WHEN state = 'pending' THEN next_attempt_at ELSE lease_until END) AS t
           FROM outbox WHERE state IN ('pending','leased')`,
        );
        return r?.t ?? null;
      }),
    async run(now, budget) {
      // expired leases (a tick that died mid-delivery) go back to pending
      o.db.tx((tx) => tx.run(`UPDATE outbox SET state = 'pending' WHERE state = 'leased' AND lease_until <= ?`, now));
      const rows = o.db.tx((tx) => {
        const due = tx.all<OutboxRow & Record<string, SqlStorageValue>>(
          `SELECT id, topic, target, idempotency_key, payload, attempts, priority FROM outbox
           WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY priority, next_attempt_at LIMIT ?`,
          now, budget,
        );
        for (const r of due) tx.run(`UPDATE outbox SET state = 'leased', lease_until = ? WHERE id = ?`, now + LEASE_MS, r.id);
        return due;
      });
      let i = 0;
      const worker = async () => {
        while (i < rows.length) {
          const row = rows[i++]!;
          let res: DeliveryResult;
          try {
            res = await o.deliver(row);
          } catch (e) {
            res = { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
          }
          record(o, row, res, Date.now());
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, rows.length) }, worker));
      return rows.length;
    },
  };
}

function record(o: OutboxSourceOptions, row: OutboxRow, res: DeliveryResult, now: number): void {
  o.db.tx((tx) => {
    if (res.ok) {
      tx.run(`UPDATE outbox SET state = 'sent', attempts = attempts + 1, lease_until = NULL, last_error = NULL WHERE id = ?`, row.id);
      return;
    }
    const attempts = row.attempts + 1;
    const delay = res.retryable ? RETRY_DELAYS_MS[attempts - 1] : undefined;
    if (delay === undefined) {
      tx.run(`UPDATE outbox SET state = 'dead', attempts = ?, lease_until = NULL, last_error = ? WHERE id = ?`, attempts, res.error, row.id);
      o.onDead?.(tx, { ...row, attempts }, res.error, now);
    } else {
      tx.run(
        `UPDATE outbox SET state = 'pending', attempts = ?, next_attempt_at = ?, lease_until = NULL, last_error = ? WHERE id = ?`,
        attempts, now + delay, res.error, row.id,
      );
    }
  });
}
