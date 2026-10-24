// Daily maintenance (§12.9, §19.7): pruning and archival to R2. Runs from the scheduler at the maintenance slot,
// in small transactions (≤ about 500 rows each, §19.2).
import type { Db } from '@kairos/db';
import type { Scope } from './scope';

export const DAY_MS = 86_400_000;
export const MAINTENANCE_HOUR_UTC = 7;   // ≈ 02:00–03:00 in America/New_York
const CHUNK = 500;

export const RETENTION = {
  occupancyMs: 7 * DAY_MS,
  eventsMs: 90 * DAY_MS,
  idempotencyMs: 72 * 3_600_000,
  auditHotMs: 90 * DAY_MS,
  decisionHotMs: 400 * DAY_MS,
} as const;

export function nextMaintenanceSlot(now: number): number {
  const d = new Date(now);
  const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), MAINTENANCE_HOUR_UTC);
  return slot > now ? slot : slot + DAY_MS;
}

function chunked(db: Db, sql: string, ...params: (string | number)[]): number {
  let total = 0;
  for (;;) {
    const n = db.tx((tx) => tx.run(sql, ...params, CHUNK));
    total += n;
    if (n < CHUNK) return total;
  }
}

export interface MaintenanceReport {
  occupancy: number;
  events: number;
  idempotency: number;
  auditArchived: number;
  decisionsArchived: number;
}

export async function runMaintenance(db: Db, now: number, scope: Scope, archive: R2Bucket | undefined): Promise<MaintenanceReport> {
  const grainCut = Math.floor((now - RETENTION.occupancyMs) / 300_000);
  const occupancy = chunked(db,
    `DELETE FROM occupancy WHERE (resource_id, grain, lane) IN
       (SELECT resource_id, grain, lane FROM occupancy WHERE grain < ? LIMIT ?)`, grainCut);
  const events = chunked(db,
    `DELETE FROM domain_event WHERE seq IN (SELECT seq FROM domain_event WHERE at < ? AND dispatched = 1 LIMIT ?)`,
    now - RETENTION.eventsMs);
  const idempotency = chunked(db,
    `DELETE FROM idempotency WHERE key IN (SELECT key FROM idempotency WHERE created_at < ? LIMIT ?)`,
    now - RETENTION.idempotencyMs);

  // Archival needs the bucket; without it nothing is deleted.
  const auditArchived = archive ? await archiveAudit(db, now, scope, archive) : 0;
  const decisionsArchived = archive ? await archiveDecisions(db, now, scope, archive) : 0;
  return { occupancy, events, idempotency, auditArchived, decisionsArchived };
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Moves whole UTC days of audit rows older than 90 days to the locked archive bucket, oldest first. Each segment
 * carries its first prev_hash and last hash, so the chain stays verifiable across hot and archived rows (§19.7).
 */
async function archiveAudit(db: Db, now: number, scope: Scope, bucket: R2Bucket): Promise<number> {
  let moved = 0;
  for (let i = 0; i < 30; i++) {
    const first = db.tx((tx) => tx.maybe<{ at: number }>(`SELECT at FROM audit ORDER BY seq LIMIT 1`));
    if (!first || first.at >= now - RETENTION.auditHotMs) break;
    const day = dayOf(first.at);
    const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
    if (end > now - RETENTION.auditHotMs) break;   // only complete days
    const rows = db.tx((tx) => tx.all(`SELECT * FROM audit WHERE at < ? ORDER BY seq`, end));
    if (rows.length === 0) break;
    const head = rows[0]!;
    const tail = rows[rows.length - 1]!;
    const key = `audit/${scope.tenant}/${scope.env}/${day}.ndjson`;
    await bucket.put(key, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', {
      customMetadata: { first_seq: String(head.seq), last_seq: String(tail.seq), prev_hash: String(head.prev_hash), tail_hash: String(tail.hash) },
    });
    db.tx((tx) => {
      tx.run(`DELETE FROM audit WHERE seq <= ?`, tail.seq as number);
      tx.run(`INSERT INTO scheduler_state (key, value) VALUES ('audit_archived_tail', ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify({ seq: tail.seq, hash: tail.hash, key }));
    });
    moved += rows.length;
  }
  return moved;
}

async function archiveDecisions(db: Db, now: number, scope: Scope, bucket: R2Bucket): Promise<number> {
  const cut = now - RETENTION.decisionHotMs;
  let moved = 0;
  for (let i = 0; i < 20; i++) {
    const rows = db.tx((tx) => tx.all(`SELECT * FROM decision WHERE at < ? ORDER BY at, id LIMIT ?`, cut, CHUNK));
    if (rows.length === 0) break;
    const key = `decisions/${scope.tenant}/${scope.env}/${dayOf(rows[0]!.at as number)}-${rows[0]!.id}.ndjson`;
    await bucket.put(key, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // same selection as above; rows newer than `cut` can't have appeared during the await (statements are
    // limited to 100 bound parameters, so ids are not listed)
    db.tx((tx) => tx.run(`DELETE FROM decision WHERE id IN (SELECT id FROM decision WHERE at < ? ORDER BY at, id LIMIT ?)`, cut, rows.length));
    moved += rows.length;
  }
  return moved;
}
