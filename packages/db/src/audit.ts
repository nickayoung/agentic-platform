// Hash-chained audit log (§13.4). Written in the same transaction as the change it records (I-29), so the
// single-writer object guarantees the chain cannot fork (§19.2).
import type { Tx } from './tx';
import { canonicalJson, sha256Hex } from './canonical';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  id: string;
  at: number;
  actor: unknown;          // ActorRef (§3.11)
  action: string;          // "<entity>.<event>"
  target: { type: string; id: string };
  before_hash: string | null;
  after: unknown;          // PII redacted by the caller
  request_id: string;
  config_version: number;
}

export interface AuditRow {
  seq: number;
  id: string;
  at: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  before_hash: string | null;
  after: string;
  request_id: string;
  config_version: number;
  prev_hash: string;
  hash: string;
}

const entryText = (r: Omit<AuditRow, 'seq' | 'prev_hash' | 'hash'>): string =>
  canonicalJson({
    id: r.id, at: r.at, actor: r.actor, action: r.action, target_type: r.target_type, target_id: r.target_id,
    before_hash: r.before_hash, after: r.after, request_id: r.request_id, config_version: r.config_version,
  });

export const chainHash = (prevHash: string, entry: string): string => sha256Hex(prevHash + entry);

export function appendAudit(tx: Tx, e: AuditInput): AuditRow {
  const head = tx.maybe<{ seq: number; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1');
  const prev_hash = head?.hash ?? GENESIS_HASH;
  const seq = (head?.seq ?? 0) + 1;
  const row = {
    id: e.id, at: e.at, actor: canonicalJson(e.actor), action: e.action, target_type: e.target.type,
    target_id: e.target.id, before_hash: e.before_hash, after: canonicalJson(e.after ?? null),
    request_id: e.request_id, config_version: e.config_version,
  };
  const hash = chainHash(prev_hash, entryText(row));
  tx.run(
    `INSERT INTO audit (seq, id, at, actor, action, target_type, target_id, before_hash, after, request_id,
       config_version, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    seq, row.id, row.at, row.actor, row.action, row.target_type, row.target_id, row.before_hash, row.after,
    row.request_id, row.config_version, prev_hash, hash,
  );
  return { seq, ...row, prev_hash, hash };
}

/** Verifies the hot chain from `fromSeq` (inclusive). Returns the first broken seq, or null. */
export function verifyAudit(tx: Tx, fromSeq = 1, expectedPrev?: string): number | null {
  let prev = expectedPrev;
  for (const r of tx.all<AuditRow & Record<string, SqlStorageValue>>('SELECT * FROM audit WHERE seq >= ? ORDER BY seq', fromSeq)) {
    if (prev === undefined) prev = r.seq === 1 ? GENESIS_HASH : r.prev_hash;
    if (r.prev_hash !== prev || chainHash(prev, entryText(r)) !== r.hash) return r.seq;
    prev = r.hash;
  }
  return null;
}
