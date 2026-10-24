import { KairosError } from '@kairos/errors';
import { describe, expect, it } from 'vitest';
import { TxDefect } from '../src/index';
import { withDb } from './helpers';

describe('Db.tx (§12.2, §19.2)', () => {
  it('commits every write in the body', () =>
    withDb((db) => {
      db.tx((tx) => {
        tx.run(`INSERT INTO limit_counter (key, count, max, window_end) VALUES ('a', 1, 5, 0)`);
        tx.run(`INSERT INTO limit_counter (key, count, max, window_end) VALUES ('b', 1, 5, 0)`);
      });
      expect(db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM limit_counter').n)).toBe(2);
    }));

  it('rolls back every write when a check throws', () =>
    withDb((db) => {
      expect(() =>
        db.tx((tx) => {
          tx.run(`INSERT INTO limit_counter (key, count, max, window_end) VALUES ('a', 1, 5, 0)`);
          throw new KairosError('PLACE_TAKEN');
        }),
      ).toThrow(KairosError);
      expect(db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM limit_counter').n)).toBe(0);
    }));

  it('maps a constraint violation to the reason code of its table', () =>
    withDb((db) => {
      db.tx((tx) => tx.run(`INSERT INTO entitlement_balance (entitlement_id, unit, balance) VALUES ('e', 'credit', 1)`));
      try {
        db.tx((tx) => tx.run(`UPDATE entitlement_balance SET balance = balance - 2 WHERE entitlement_id = 'e'`));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(KairosError);
        expect((e as KairosError).code).toBe('INSUFFICIENT_UNITS');
      }
      expect(db.tx((tx) => tx.one<{ balance: number }>('SELECT balance FROM entitlement_balance').balance)).toBe(1);
    }));

  it('rejects a body that returns a promise, and rolls it back', () =>
    withDb((db) => {
      const asyncBody = async () => 1;
      // @ts-expect-error a promise-returning body does not type-check
      expect(() => db.tx(asyncBody)).toThrow(TxDefect);

      expect(() =>
        // @ts-expect-error same for an async arrow that writes before awaiting (deliberately breaks the lint rule too)
        db.tx(async (tx) => { // eslint-disable-line kairos/no-async-in-tx
          tx.run(`INSERT INTO limit_counter (key, count, max, window_end) VALUES ('x', 1, 5, 0)`);
          await Promise.resolve();
        }),
      ).toThrow(TxDefect);
      expect(db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM limit_counter').n)).toBe(0);
    }));

  it('one() and maybe() enforce cardinality', () =>
    withDb((db) => {
      expect(() => db.tx((tx) => tx.one('SELECT y FROM lanes'))).toThrow(TxDefect);
      expect(db.tx((tx) => tx.maybe('SELECT y FROM lanes WHERE y = 99'))).toBeUndefined();
    }));
});
