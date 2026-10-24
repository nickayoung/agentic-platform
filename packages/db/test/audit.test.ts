import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH, verifyAudit } from '../src/index';
import { withDb } from './helpers';

const entry = (i: number) => ({
  id: `aud_${i}`, at: 1000 + i, actor: { type: 'system', component: 'lifecycle' }, action: 'booking.confirmed',
  target: { type: 'booking', id: `bkg_${i}` }, before_hash: null, after: { state: 'confirmed', n: i },
  request_id: `req_${i}`, config_version: 1,
});

describe('audit chain (§13.4)', () => {
  it('chains each entry to the previous one and verifies', () =>
    withDb((db) => {
      const rows = [1, 2, 3].map((i) => db.tx((tx) => appendAudit(tx, entry(i))));
      expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
      expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(db.tx((tx) => verifyAudit(tx))).toBeNull();
    }));

  it('detects a tampered entry', () =>
    withDb((db) => {
      for (const i of [1, 2, 3]) db.tx((tx) => appendAudit(tx, entry(i)));
      db.tx((tx) => tx.run(`UPDATE audit SET after = '{"state":"cancelled"}' WHERE seq = 2`));
      expect(db.tx((tx) => verifyAudit(tx))).toBe(2);
    }));

  it('a rolled-back change leaves no audit row', () =>
    withDb((db) => {
      expect(() =>
        db.tx((tx) => {
          appendAudit(tx, entry(1));
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect(db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM audit').n)).toBe(0);
    }));
});
