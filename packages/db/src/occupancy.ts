// Occupancy: the shared calendar (§12.3). One row per (resource, 5-minute grain, lane); the primary key makes
// it impossible for one resource lane to hold two claims, whatever their domain or source.
import { KairosError } from '@kairos/errors';
import type { Tx } from './tx';

export const GRAIN_MS = 300_000;
export const grainOf = (ms: number): number => Math.floor(ms / GRAIN_MS);

export type ClaimMode = 'exclusive' | 'lane';
export type ClaimDomain = 'classes' | 'shifts' | 'blocks';
export type ClaimSource = 'platform' | 'mirror';
export type ClaimState = 'active' | 'conflicted' | 'released';

export interface ClaimInput {
  id: string;
  resourceId: string;
  ownerType: 'assignment' | 'block';
  ownerId: string;
  start: number;
  end: number;
  occStart: number;   // widened by buffers, grain-aligned
  occEnd: number;
  mode: ClaimMode;
  domain: ClaimDomain;
  source: ClaimSource;
}

interface ClaimRow {
  id: string;
  resource_id: string;
  occ_start: number;
  occ_end: number;
  mode: ClaimMode;
  state: ClaimState;
  [k: string]: SqlStorageValue;
}

function concurrencyOf(tx: Tx, resourceId: string): number {
  const r = tx.maybe<{ concurrency: number }>('SELECT concurrency FROM resource WHERE id = ?', resourceId);
  if (!r) throw new KairosError('NOT_FOUND', { message: `resource ${resourceId}` });
  return r.concurrency;
}

const expectedRows = (mode: ClaimMode, g0: number, g1: number, concurrency: number): number =>
  mode === 'exclusive' ? (g1 - g0) * concurrency : g1 - g0;

const GRAINS = 'WITH RECURSIVE g(x) AS (SELECT ? UNION ALL SELECT x + 1 FROM g WHERE x + 1 < ?)';

/** Inserts the occupancy rows strictly: any taken row aborts the transaction (RESOURCE_CONFLICT). */
function insertStrict(tx: Tx, c: { id: string; resourceId: string; mode: ClaimMode }, g0: number, g1: number, conc: number): void {
  if (c.mode === 'exclusive') {
    tx.run(
      `INSERT INTO occupancy (resource_id, grain, lane, claim_id) ${GRAINS}
       SELECT ?, g.x, lanes.y, ? FROM g JOIN lanes ON lanes.y < ?`,
      g0, g1, c.resourceId, c.id, conc,
    );
  } else {
    tx.run(
      `INSERT INTO occupancy (resource_id, grain, lane, claim_id) ${GRAINS}
       SELECT ?, g.x,
         (SELECT min(l.y) FROM lanes l WHERE l.y < ? AND NOT EXISTS
            (SELECT 1 FROM occupancy o WHERE o.resource_id = ? AND o.grain = g.x AND o.lane = l.y)),
         ?
       FROM g`,
      g0, g1, c.resourceId, conc, c.resourceId, c.id,
    );
  }
}

/** Inserts whatever rows are free and skips the rest (mirror ingestion and re-homing). */
function insertLenient(tx: Tx, c: { id: string; resourceId: string; mode: ClaimMode }, g0: number, g1: number, conc: number): void {
  if (c.mode === 'exclusive') {
    tx.run(
      `INSERT INTO occupancy (resource_id, grain, lane, claim_id) ${GRAINS}
       SELECT ?, g.x, lanes.y, ? FROM g JOIN lanes ON lanes.y < ?
       WHERE true ON CONFLICT DO NOTHING`,
      g0, g1, c.resourceId, c.id, conc,
    );
  } else {
    // one lane per grain; skip grains that already hold this claim or have no free lane
    tx.run(
      `INSERT INTO occupancy (resource_id, grain, lane, claim_id) ${GRAINS}
       SELECT * FROM (
         SELECT ? AS resource_id, g.x AS grain,
           (SELECT min(l.y) FROM lanes l WHERE l.y < ? AND NOT EXISTS
              (SELECT 1 FROM occupancy o WHERE o.resource_id = ? AND o.grain = g.x AND o.lane = l.y)) AS lane,
           ? AS claim_id
         FROM g
         WHERE NOT EXISTS (SELECT 1 FROM occupancy o2 WHERE o2.claim_id = ? AND o2.grain = g.x))
       WHERE lane IS NOT NULL ON CONFLICT DO NOTHING`,
      g0, g1, c.resourceId, conc, c.resourceId, c.id, c.id,
    );
  }
}

function settleState(tx: Tx, claimId: string, expected: number): ClaimState {
  tx.run(
    `UPDATE claim SET state = CASE WHEN (SELECT count(*) FROM occupancy WHERE claim_id = ?1) = ?2
                                   THEN 'active' ELSE 'conflicted' END,
                      version = version + 1
     WHERE id = ?1`,
    claimId, expected,
  );
  return tx.one<{ state: ClaimState }>('SELECT state FROM claim WHERE id = ?', claimId).state;
}

function insertClaimRow(tx: Tx, c: ClaimInput, state: ClaimState): void {
  if (c.occStart % GRAIN_MS !== 0 || c.occEnd % GRAIN_MS !== 0 || c.occStart >= c.occEnd) {
    throw new Error(`claim ${c.id}: occupancy range must be grain-aligned and non-empty`);
  }
  tx.run(
    `INSERT INTO claim (id, resource_id, owner_type, owner_id, start_at, end_at, occ_start, occ_end, mode, domain, source, state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.id, c.resourceId, c.ownerType, c.ownerId, c.start, c.end, c.occStart, c.occEnd, c.mode, c.domain, c.source, state,
  );
}

/**
 * A platform claim (an owned assignment or block). Throws RESOURCE_CONFLICT, rolling back the transaction,
 * if any lane-grain it needs is taken.
 */
export function claimPlatform(tx: Tx, c: ClaimInput): void {
  const conc = concurrencyOf(tx, c.resourceId);
  insertClaimRow(tx, c, 'active');
  try {
    insertStrict(tx, c, grainOf(c.occStart), grainOf(c.occEnd), conc);
  } catch (e) {
    throw conflictOrRethrow(e, c);
  }
}

/**
 * A mirrored claim. Never refused: it takes the free rows and is stored `conflicted` if any row is missing,
 * so its time stays blocked and a `cross_domain_conflict` drift item can be raised by the caller.
 */
export function ingestMirrorClaim(tx: Tx, c: ClaimInput): ClaimState {
  const conc = concurrencyOf(tx, c.resourceId);
  insertClaimRow(tx, { ...c, source: 'mirror' }, 'conflicted');
  const g0 = grainOf(c.occStart);
  const g1 = grainOf(c.occEnd);
  insertLenient(tx, c, g0, g1, conc);
  return settleState(tx, c.id, expectedRows(c.mode, g0, g1, conc));
}

/**
 * Releases a claim and re-homes conflicted claims on the same resource that overlap the freed range,
 * in occ_start order (§12.3 "Release and re-home"). Returns the ids of claims that became active.
 */
export function releaseClaim(tx: Tx, claimId: string): string[] {
  const c = tx.maybe<ClaimRow>('SELECT * FROM claim WHERE id = ?', claimId);
  if (!c) throw new KairosError('NOT_FOUND', { message: `claim ${claimId}` });
  if (c.state === 'released') return [];
  tx.run('DELETE FROM occupancy WHERE claim_id = ?', claimId);
  tx.run(`UPDATE claim SET state = 'released', version = version + 1 WHERE id = ?`, claimId);

  const conc = concurrencyOf(tx, c.resource_id);
  const rehomed: string[] = [];
  const waiting = tx.all<ClaimRow>(
    `SELECT * FROM claim WHERE resource_id = ? AND state = 'conflicted' AND occ_start < ? AND occ_end > ?
     ORDER BY occ_start, id`,
    c.resource_id, c.occ_end, c.occ_start,
  );
  for (const w of waiting) {
    const g0 = grainOf(w.occ_start);
    const g1 = grainOf(w.occ_end);
    insertLenient(tx, { id: w.id, resourceId: w.resource_id, mode: w.mode }, g0, g1, conc);
    if (settleState(tx, w.id, expectedRows(w.mode, g0, g1, conc)) === 'active') rehomed.push(w.id);
  }
  return rehomed;
}

function conflictOrRethrow(e: unknown, c: ClaimInput): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (/constraint failed: occupancy\./.test(msg)) {
    return new KairosError('RESOURCE_CONFLICT', {
      message: `resource ${c.resourceId} is already claimed in [${c.occStart}, ${c.occEnd})`,
      reasons: [{ code: 'RESOURCE_CONFLICT', facts: { resource_id: c.resourceId, occ_start: c.occStart, occ_end: c.occEnd } }],
    });
  }
  return e;
}
