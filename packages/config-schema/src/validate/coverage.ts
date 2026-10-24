// COVERAGE_UNCOVERABLE (§4.6, §6.3, D-45): per coverage rule, studio and weekday, an exact search for a set of that
// day's shift candidates that meets `min` at every 5-minute grain without ever needing more lanes than a fixed
// resource (the desk) has.
import type { CoverageDef, Weekday } from '../schema';
import { durationMinutes } from '../schema';
import { Issues } from '../report';
import { availableIntervals, fitsInside, minutesTime, timeMinutes } from './calendar';
import { lanes, matchingResources, selectorKind, type Model } from './model';

const GRAIN = 5;
const GRAINS = 1440 / GRAIN;
const SEARCH_BUDGET = 200_000;   // nodes; far above what ≤ 30 candidates per studio-day need in practice

interface Candidate {
  template: string;
  from: number;                                       // grain index, inclusive
  to: number;                                         // grain index, exclusive
  supply: number;                                     // people of the coverage role it brings
  claims: { resource: string; lanes: number }[];      // lanes it needs on each fixed resource
}

/** Shift candidates (§4.6) for a coverage rule's studio and weekday. */
export function shiftCandidates(m: Model, c: CoverageDef, weekday: Weekday): Candidate[] {
  const out: Candidate[] = [];
  for (const key of c.shift_templates) {
    const t = m.templates.get(key);
    if (t === undefined || t.scheduling.mode !== 'rostered') continue;
    const supply = t.requirements.filter((q) => q.select.role === c.role).reduce((n, q) => n + (q.count ?? 1), 0);
    if (supply === 0) continue;
    const fixed = t.requirements.filter((q) => q.assign === 'fixed' && selectorKind(m, q) !== 'person');
    const resources = fixed.map((q) => ({ q, r: matchingResources(m, q, c.location)[0] }));
    if (resources.some((x) => x.r === undefined)) continue;   // nothing to claim at this studio, so no candidate
    const minutes = durationMinutes(t.duration);
    for (const s of t.scheduling.starts) {
      if (s.days !== undefined && !s.days.includes(weekday)) continue;
      if (s.locations !== undefined && !s.locations.includes(c.location)) continue;
      const start = timeMinutes(s.at);
      const span: [number, number] = [start, start + minutes];
      if (!resources.every(({ r }) => fitsInside(span, availableIntervals(m.doc.availability, r!, null, weekday)))) continue;
      out.push({
        template: key, from: Math.floor(start / GRAIN), to: Math.min(GRAINS, Math.ceil(span[1] / GRAIN)), supply,
        claims: resources.map(({ q, r }) => ({
          resource: r!.key, lanes: (q.occupancy ?? 'exclusive') === 'lane' ? (q.count ?? 1) : lanes(m, r!),
        })),
      });
    }
  }
  return out;
}

/** Demand per grain on a weekday: the largest `min` of the rule's patterns that cover the grain. */
function demand(c: CoverageDef, weekday: Weekday): number[] {
  const d = new Array<number>(GRAINS).fill(0);
  for (const p of c.pattern) {
    if (!p.days.includes(weekday)) continue;
    for (let g = Math.floor(timeMinutes(p.from) / GRAIN); g < Math.min(GRAINS, Math.ceil(timeMinutes(p.to) / GRAIN)); g++) {
      d[g] = Math.max(d[g]!, p.min);
    }
  }
  return d;
}

type Outcome = { ok: true } | { ok: false; reason: string } | { ok: 'unknown' };

/** Exact cover search. Each candidate is used at most once (one shift session per start, studio and day). */
export function coverable(m: Model, need: number[], cands: Candidate[]): Outcome {
  const capacity = new Map<string, number>();
  for (const c of cands) for (const x of c.claims) capacity.set(x.resource, lanes(m, m.resources.get(x.resource)!));

  // Without the lane limit, is there enough supply at every grain? If not, say where.
  const all = new Array<number>(GRAINS).fill(0);
  for (const c of cands) for (let g = c.from; g < c.to; g++) all[g]! += c.supply;
  const short = need.findIndex((n, g) => all[g]! < n);
  if (short >= 0) return { ok: false, reason: `no shift candidates cover ${minutesTime(short * GRAIN)} (needs ${need[short]})` };

  const supply = new Array<number>(GRAINS).fill(0);
  const used = new Map<string, number[]>();
  for (const r of capacity.keys()) used.set(r, new Array<number>(GRAINS).fill(0));
  const chosen = new Array<boolean>(cands.length).fill(false);
  const seen = new Set<string>();
  let budget = SEARCH_BUDGET;

  const apply = (c: Candidate, sign: 1 | -1): void => {
    for (let g = c.from; g < c.to; g++) {
      supply[g]! += sign * c.supply;
      for (const x of c.claims) used.get(x.resource)![g]! += sign * x.lanes;
    }
  };
  const fitsLanes = (c: Candidate): boolean => c.claims.every((x) => {
    const u = used.get(x.resource)!;
    const cap = capacity.get(x.resource)!;
    for (let g = c.from; g < c.to; g++) if (u[g]! + x.lanes > cap) return false;
    return true;
  });
  const search = (): boolean | 'budget' => {
    if (--budget < 0) return 'budget';
    const key = chosen.map((b) => (b ? '1' : '0')).join('');
    if (seen.has(key)) return false;
    seen.add(key);
    const g = need.findIndex((n, i) => supply[i]! < n);
    if (g < 0) return true;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!;
      if (chosen[i] || c.from > g || c.to <= g || !fitsLanes(c)) continue;
      chosen[i] = true;
      apply(c, 1);
      const r = search();
      apply(c, -1);
      chosen[i] = false;
      if (r !== false) return r;
    }
    return false;
  };
  const r = search();
  if (r === 'budget') return { ok: 'unknown' };
  if (r) return { ok: true };
  const lanesText = [...capacity].map(([k, n]) => `${k}: ${n} lane${n === 1 ? '' : 's'}`).join(', ');
  return { ok: false, reason: `the shift candidates can't meet the minimum without exceeding desk lanes (${lanesText})` };
}

export function checkCoverage(m: Model, out: Issues): void {
  m.doc.coverage.forEach((c, i) => {
    const days = [...new Set(c.pattern.flatMap((p) => p.days))];
    for (const day of days) {
      const r = coverable(m, demand(c, day), shiftCandidates(m, c, day));
      if (r.ok === false) out.error('COVERAGE_UNCOVERABLE', ['coverage', i], `${c.key} on ${day}: ${r.reason}`);
    }
  });
}
