// Sagas: work larger than one batch, as numbered idempotent steps (§3A.1 C6, §12.7). Each step is one
// transaction that checks `saga.step` and advances it, so a step can never apply twice. A step that needs an
// outside answer enqueues an outbox row and returns `wait`; the step re-runs on a later tick.
import type { Db, Tx } from '@kairos/db';
import { KairosError } from '@kairos/errors';
import type { TickSource } from './scheduler';

export const SAGA_LEASE_MS = 60_000;
export const SAGA_MAX_ATTEMPTS = 5;
export const SAGA_RETRY_MS = 60_000;

export type StepResult = 'next' | 'done' | { wait: number } | { park: string };

export interface SagaStepContext<P> {
  sagaId: string;
  step: number;
  payload: P;
  now: number;
  /** Replaces the payload for later steps (written in the same transaction). */
  setPayload(p: P): void;
}

export interface SagaDefinition<P = unknown> {
  kind: string;
  steps: ReadonlyArray<(tx: Tx, ctx: SagaStepContext<P>) => StepResult>;
  /** Runs once when the saga parks or fails, in the same transaction (§3A.1 C6: each card names its compensation). */
  onPark?: (tx: Tx, ctx: SagaStepContext<P>, reason: string) => void;
}

interface SagaRow {
  id: string;
  kind: string;
  step: number;
  state: string;
  attempts: number;
  payload: string;
  version: number;
  [k: string]: SqlStorageValue;
}

export function startSaga(tx: Tx, s: { id: string; kind: string; subjectId?: string; payload: unknown }, now: number): void {
  tx.run(
    `INSERT INTO saga (id, kind, subject_id, step, state, lease_until, attempts, payload, created_at)
     VALUES (?, ?, ?, 0, 'running', ?, 0, ?, ?)`,
    s.id, s.kind, s.subjectId ?? null, now, JSON.stringify(s.payload), now,
  );
}

export function sagaSource(db: Db, defs: readonly SagaDefinition<never>[], onError?: (sagaId: string, e: unknown) => void): TickSource {
  const byKind = new Map(defs.map((d) => [d.kind, d as unknown as SagaDefinition<unknown>]));
  return {
    name: 'saga',
    nextDue: (d) =>
      d.tx((tx) => tx.maybe<{ t: number | null }>(`SELECT min(lease_until) AS t FROM saga WHERE state = 'running'`)?.t ?? null),
    async run(now, budget) {
      const due = db.tx((tx) =>
        tx.all<SagaRow>(`SELECT * FROM saga WHERE state = 'running' AND lease_until <= ? ORDER BY lease_until LIMIT ?`, now, budget),
      );
      let n = 0;
      for (const row of due) {
        // run consecutive steps until the saga waits, parks or finishes, one transaction per step
        for (let guard = 0; guard < 100; guard++) {
          const r = runOneStep(db, byKind, row.id, now, onError);
          n++;
          if (r !== 'next') break;
        }
      }
      return n;
    },
  };
}

function runOneStep(
  db: Db, byKind: Map<string, SagaDefinition<unknown>>, id: string, now: number, onError?: (sagaId: string, e: unknown) => void,
): 'next' | 'stop' {
  try {
    return db.tx((tx) => {
      const s = tx.one<SagaRow>('SELECT * FROM saga WHERE id = ?', id);
      if (s.state !== 'running') return 'stop';
      const def = byKind.get(s.kind);
      if (!def) throw new Error(`no saga definition for kind ${s.kind}`);
      let payload = JSON.parse(s.payload) as unknown;
      const ctx: SagaStepContext<unknown> = { sagaId: id, step: s.step, payload, now, setPayload: (p) => { payload = p; } };
      const fn = def.steps[s.step];
      const result: StepResult = fn ? fn(tx, ctx) : 'done';
      const advance = (state: string, step: number, lease: number | null) => {
        const w = tx.run(
          `UPDATE saga SET state = ?, step = ?, lease_until = ?, attempts = 0, payload = ?, version = version + 1
           WHERE id = ? AND step = ? AND version = ?`,
          state, step, lease, JSON.stringify(payload), id, s.step, s.version,
        );
        if (w !== 1) throw new KairosError('STALE_VERSION', { message: `saga ${id} step ${s.step} moved` });
      };
      if (result === 'next') {
        const last = s.step + 1 >= def.steps.length;
        advance(last ? 'done' : 'running', s.step + 1, last ? null : now);
        return last ? 'stop' : 'next';
      }
      if (result === 'done') { advance('done', s.step + 1, null); return 'stop'; }
      if ('wait' in result) { advance('running', s.step, result.wait); return 'stop'; }
      advance('parked', s.step, null);
      def.onPark?.(tx, ctx, result.park);
      return 'stop';
    });
  } catch (e) {
    onError?.(id, e);
    // the step's transaction rolled back; count the attempt and retry later, or park (§3A.1 C6)
    db.tx((tx) => {
      const s = tx.one<SagaRow>('SELECT * FROM saga WHERE id = ?', id);
      const attempts = s.attempts + 1;
      if (attempts >= SAGA_MAX_ATTEMPTS) {
        tx.run(`UPDATE saga SET state = 'parked', attempts = ?, lease_until = NULL, version = version + 1 WHERE id = ?`, attempts, id);
        const def = byKind.get(s.kind);
        def?.onPark?.(tx, { sagaId: id, step: s.step, payload: JSON.parse(s.payload), now, setPayload: () => {} }, String(e));
      } else {
        tx.run(`UPDATE saga SET attempts = ?, lease_until = ?, version = version + 1 WHERE id = ?`, attempts, now + SAGA_RETRY_MS, id);
      }
    });
    return 'stop';
  }
}
