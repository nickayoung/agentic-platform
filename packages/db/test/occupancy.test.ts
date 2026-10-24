import { KairosError } from '@kairos/errors';
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { claimPlatform, GRAIN_MS, ingestMirrorClaim, releaseClaim, type ClaimInput, type ClaimMode, type Db } from '../src/index';
import { MIN, seedResource, T0, withDb } from './helpers';

const claim = (id: string, resourceId: string, fromMin: number, toMin: number, over: Partial<ClaimInput> = {}): ClaimInput => ({
  id, resourceId, ownerType: 'assignment', ownerId: `asg_${id}`,
  start: T0 + fromMin * MIN, end: T0 + toMin * MIN, occStart: T0 + fromMin * MIN, occEnd: T0 + toMin * MIN,
  mode: 'exclusive', domain: 'classes', source: 'platform', ...over,
});

const stateOf = (db: Db, id: string) => db.tx((tx) => tx.one<{ state: string }>('SELECT state FROM claim WHERE id = ?', id).state);
const rowsOf = (db: Db, id: string) => db.tx((tx) => tx.one<{ n: number }>('SELECT count(*) AS n FROM occupancy WHERE claim_id = ?', id).n);

describe('occupancy (§12.3)', () => {
  it('refuses an overlapping exclusive claim on the same person and rolls the batch back', () =>
    withDb((db) => {
      seedResource(db, 'priya');
      db.tx((tx) => claimPlatform(tx, claim('c1', 'priya', 0, 80)));
      try {
        db.tx((tx) => claimPlatform(tx, claim('c2', 'priya', 75, 120, { domain: 'shifts' })));
        expect.unreachable();
      } catch (e) {
        expect((e as KairosError).code).toBe('RESOURCE_CONFLICT');
      }
      expect(db.tx((tx) => tx.maybe('SELECT id FROM claim WHERE id = ?', 'c2'))).toBeUndefined();
      expect(rowsOf(db, 'c1')).toBe(16);
    }));

  it('allows adjacent claims (half-open ranges)', () =>
    withDb((db) => {
      seedResource(db, 'priya');
      db.tx((tx) => claimPlatform(tx, claim('c1', 'priya', 0, 60)));
      db.tx((tx) => claimPlatform(tx, claim('c2', 'priya', 60, 120)));
      expect(rowsOf(db, 'c2')).toBe(12);
    }));

  it('seats two desk workers on a 2-lane desk and refuses a third (D-45)', () =>
    withDb((db) => {
      seedResource(db, 'dumbo_desk', 2);
      const lane = (id: string) => claim(id, 'dumbo_desk', 0, 60, { mode: 'lane', domain: 'shifts' });
      db.tx((tx) => claimPlatform(tx, lane('d1')));
      db.tx((tx) => claimPlatform(tx, lane('d2')));
      expect(() => db.tx((tx) => claimPlatform(tx, lane('d3')))).toThrow(KairosError);
      const lanes = db.tx((tx) => tx.all<{ lane: number }>('SELECT DISTINCT lane FROM occupancy WHERE claim_id = ?', 'd2'));
      expect(lanes).toEqual([{ lane: 1 }]);
    }));

  it('an exclusive claim on a 2-lane resource takes both lanes', () =>
    withDb((db) => {
      seedResource(db, 'room', 2);
      db.tx((tx) => claimPlatform(tx, claim('x', 'room', 0, 30)));
      expect(rowsOf(db, 'x')).toBe(12);
      expect(() => db.tx((tx) => claimPlatform(tx, claim('l', 'room', 0, 30, { mode: 'lane' })))).toThrow(KairosError);
    }));

  it('A.5: a mirrored class over an owned desk shift is stored conflicted and still blocks time', () =>
    withDb((db) => {
      seedResource(db, 'priya');
      db.tx((tx) => claimPlatform(tx, claim('desk', 'priya', 0, 240, { domain: 'shifts' })));
      const st = db.tx((tx) => ingestMirrorClaim(tx, claim('cls', 'priya', 170, 250, { source: 'mirror' })));
      expect(st).toBe('conflicted');
      expect(rowsOf(db, 'cls')).toBe(2);   // 240–250 only
      // releasing the desk shift re-homes the class, which becomes active
      const rehomed = db.tx((tx) => releaseClaim(tx, 'desk'));
      expect(rehomed).toEqual(['cls']);
      expect(stateOf(db, 'cls')).toBe('active');
      expect(rowsOf(db, 'cls')).toBe(16);
    }));

  it('A.5 other order: an owned desk shift over a mirrored class is refused', () =>
    withDb((db) => {
      seedResource(db, 'priya');
      expect(db.tx((tx) => ingestMirrorClaim(tx, claim('cls', 'priya', 170, 250, { source: 'mirror' })))).toBe('active');
      expect(() => db.tx((tx) => claimPlatform(tx, claim('desk', 'priya', 0, 240, { domain: 'shifts' })))).toThrow(KairosError);
    }));

  it('re-homes conflicted claims in occ_start order', () =>
    withDb((db) => {
      seedResource(db, 'p');
      db.tx((tx) => claimPlatform(tx, claim('own', 'p', 0, 120)));
      expect(db.tx((tx) => ingestMirrorClaim(tx, claim('m2', 'p', 30, 90, { source: 'mirror' })))).toBe('conflicted');
      expect(db.tx((tx) => ingestMirrorClaim(tx, claim('m1', 'p', 0, 60, { source: 'mirror' })))).toBe('conflicted');
      // m1 (earlier occ_start) wins 0–60; m2 gets 60–90 only and stays conflicted
      expect(db.tx((tx) => releaseClaim(tx, 'own'))).toEqual(['m1']);
      expect(stateOf(db, 'm2')).toBe('conflicted');
      expect(db.tx((tx) => releaseClaim(tx, 'm1'))).toEqual(['m2']);
    }));
});

// ---- Property test: the SQL against an in-memory model, over many random operations (§15 Phase 0 acceptance 3) ----

type Op =
  | { k: 'platform' | 'mirror'; r: number; g0: number; len: number; mode: ClaimMode }
  | { k: 'release'; pick: number };

const RES = [{ id: 'r0', conc: 1 }, { id: 'r1', conc: 2 }, { id: 'r2', conc: 3 }];

class Model {
  occ = new Map<string, string>();   // `${res}|${grain}|${lane}` → claim
  claims = new Map<string, { res: number; g0: number; g1: number; mode: ClaimMode; state: string; seq: number }>();
  seq = 0;

  private key = (r: number, g: number, l: number) => `${r}|${g}|${l}`;
  private free = (r: number, g: number, l: number) => !this.occ.has(this.key(r, g, l));
  private expected(c: { g0: number; g1: number; mode: ClaimMode; res: number }) {
    return c.mode === 'exclusive' ? (c.g1 - c.g0) * RES[c.res]!.conc : c.g1 - c.g0;
  }
  private rows(id: string) {
    let n = 0;
    for (const v of this.occ.values()) if (v === id) n++;
    return n;
  }
  private lenient(id: string) {
    const c = this.claims.get(id)!;
    const conc = RES[c.res]!.conc;
    for (let g = c.g0; g < c.g1; g++) {
      if (c.mode === 'exclusive') {
        for (let l = 0; l < conc; l++) if (this.free(c.res, g, l)) this.occ.set(this.key(c.res, g, l), id);
      } else {
        let has = false;
        for (let l = 0; l < conc; l++) if (this.occ.get(this.key(c.res, g, l)) === id) has = true;
        if (has) continue;
        for (let l = 0; l < conc; l++) if (this.free(c.res, g, l)) { this.occ.set(this.key(c.res, g, l), id); break; }
      }
    }
    c.state = this.rows(id) === this.expected(c) ? 'active' : 'conflicted';
  }

  platform(id: string, res: number, g0: number, g1: number, mode: ClaimMode): boolean {
    const conc = RES[res]!.conc;
    const want: [number, number][] = [];
    for (let g = g0; g < g1; g++) {
      if (mode === 'exclusive') {
        for (let l = 0; l < conc; l++) { if (!this.free(res, g, l)) return false; want.push([g, l]); }
      } else {
        let l = 0;
        while (l < conc && !this.free(res, g, l)) l++;
        if (l === conc) return false;
        want.push([g, l]);
      }
    }
    for (const [g, l] of want) this.occ.set(this.key(res, g, l), id);
    this.claims.set(id, { res, g0, g1, mode, state: 'active', seq: this.seq++ });
    return true;
  }
  mirror(id: string, res: number, g0: number, g1: number, mode: ClaimMode): string {
    this.claims.set(id, { res, g0, g1, mode, state: 'conflicted', seq: this.seq++ });
    this.lenient(id);
    return this.claims.get(id)!.state;
  }
  release(id: string): string[] {
    const c = this.claims.get(id)!;
    if (c.state === 'released') return [];
    for (const [k, v] of [...this.occ]) if (v === id) this.occ.delete(k);
    c.state = 'released';
    const waiting = [...this.claims.entries()]
      .filter(([, w]) => w.res === c.res && w.state === 'conflicted' && w.g0 < c.g1 && w.g1 > c.g0)
      .sort(([ia, a], [ib, b]) => a.g0 - b.g0 || (ia < ib ? -1 : 1));
    const out: string[] = [];
    for (const [wid] of waiting) {
      this.lenient(wid);
      if (this.claims.get(wid)!.state === 'active') out.push(wid);
    }
    return out;
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('platform' as const), r: fc.nat(2), g0: fc.nat(20), len: fc.integer({ min: 1, max: 8 }), mode: fc.constantFrom<ClaimMode>('exclusive', 'lane') }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('mirror' as const), r: fc.nat(2), g0: fc.nat(20), len: fc.integer({ min: 1, max: 8 }), mode: fc.constantFrom<ClaimMode>('exclusive', 'lane') }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('release' as const), pick: fc.nat() }) },
);

const RUNS = inject('occRuns');   // default 200 × 500 = 10⁵ operations (vitest.config.ts)
const OPS = inject('occOps');

describe('occupancy property test', () => {
  it(`matches the model over ${RUNS} × ${OPS} random operations`, { timeout: 600_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: OPS, maxLength: OPS }), (ops) =>
        withDb((db) => {
          for (const r of RES) seedResource(db, r.id, r.conc);
          const m = new Model();
          let n = 0;
          for (const op of ops) {
            if (op.k === 'release') {
              const ids = [...m.claims.keys()];
              if (ids.length === 0) continue;
              const id = ids[op.pick % ids.length]!;
              expect(db.tx((tx) => releaseClaim(tx, id))).toEqual(m.release(id));
              continue;
            }
            const id = `c${n++}`;
            const c = claim(id, RES[op.r]!.id, 0, 0, {
              occStart: T0 + op.g0 * GRAIN_MS, occEnd: T0 + (op.g0 + op.len) * GRAIN_MS,
              start: T0 + op.g0 * GRAIN_MS, end: T0 + (op.g0 + op.len) * GRAIN_MS, mode: op.mode,
              source: op.k === 'mirror' ? 'mirror' : 'platform',
            });
            const g0 = Math.floor(c.occStart / GRAIN_MS);
            const g1 = Math.floor(c.occEnd / GRAIN_MS);
            if (op.k === 'platform') {
              let ok = true;
              try { db.tx((tx) => claimPlatform(tx, c)); } catch (e) { ok = false; expect((e as KairosError).code).toBe('RESOURCE_CONFLICT'); }
              expect(ok).toBe(m.platform(id, op.r, g0, g1, op.mode));
            } else {
              expect(db.tx((tx) => ingestMirrorClaim(tx, c))).toBe(m.mirror(id, op.r, g0, g1, op.mode));
            }
          }
          // final state: the occupancy table equals the model exactly
          const rows = db.tx((tx) => tx.all<{ resource_id: string; grain: number; lane: number; claim_id: string }>(
            'SELECT resource_id, grain, lane, claim_id FROM occupancy'));
          const actual = new Map(rows.map((r) => [`${RES.findIndex((x) => x.id === r.resource_id)}|${r.grain}|${r.lane}`, r.claim_id]));
          expect(actual).toEqual(m.occ);
        }),
      ),
      { numRuns: RUNS },
    );
  });
});
