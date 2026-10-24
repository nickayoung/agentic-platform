// Domain events, written in the same transaction as the change (I-29, §12.6).
import type { Tx } from '@kairos/db';
import { canonicalJson } from '@kairos/db';

export interface EventInput {
  name: string;                          // e.g. "flag.changed"
  subject?: { type: string; id: string };
  reason?: string;
  data?: unknown;
  causationDepth?: number;
}

export function emitEvent(tx: Tx, e: EventInput, now: number): string {
  const id = `evt_${crypto.randomUUID().replaceAll('-', '')}`;
  tx.run(
    `INSERT INTO domain_event (id, name, subject_type, subject_id, reason, data, causation_depth, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, e.name, e.subject?.type ?? null, e.subject?.id ?? null, e.reason ?? null, canonicalJson(e.data ?? {}),
    e.causationDepth ?? 0, now,
  );
  return id;
}
