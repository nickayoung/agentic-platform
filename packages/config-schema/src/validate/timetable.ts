// Timetable checks over the materialisation horizon (§6.3): TIMETABLE_CONFLICT, SERIES_OUTSIDE_HOURS and
// DST_SHIFTED_OCCURRENCE. Series whose RRULE the expander doesn't support are skipped (see expandSeries).
import { durationMinutes, type ResourceDef } from '../schema';
import { Issues } from '../report';
import { availableIntervals, dateIndex, expandSeries, fitsInside, indexDate, isNonexistentLocalTime, minutesTime, weekdayOf } from './calendar';
import { isStaffRef, selectorKind, type Model } from './model';

const MAX_COLLISIONS = 10;

export interface TimetableOptions {
  /** First day of the horizon (LocalDate). Default: the earliest `valid_from` in the timetable. */
  asOf?: string;
}

interface Claim { series: number; resource: string; day: number; from: number; to: number; exclusive: boolean }

export function checkTimetable(m: Model, opts: TimetableOptions, out: Issues): void {
  const doc = m.doc;
  if (doc.timetable.length === 0) return;
  const from = dateIndex(opts.asOf ?? doc.timetable.map((s) => s.valid_from).sort()[0]!);
  const to = from + Math.ceil(durationMinutes(doc.tenant.materialize_horizon) / 1440);
  const zones = new Map(doc.locations.map((l) => [l.key, l.timezone]));
  const claims: Claim[] = [];

  doc.timetable.forEach((s, i) => {
    const t = m.templates.get(s.template);
    if (t === undefined) return;
    const days = expandSeries(s, from, to);
    if (days === null) return;
    const start = Number(s.start_local.slice(0, 2)) * 60 + Number(s.start_local.slice(3, 5));
    const end = start + durationMinutes(t.duration);
    const before = (q: (typeof t.requirements)[number]): number => durationMinutes(q.buffers?.before ?? '0m');
    const after = (q: (typeof t.requirements)[number]): number => durationMinutes(q.buffers?.after ?? '0m');

    // Claims on fixed rooms and desks, buffers included.
    const rooms: ResourceDef[] = [];
    for (const q of t.requirements) {
      for (const v of [s.fixed[q.key] ?? []].flat()) {
        const r = isStaffRef(v) ? undefined : m.resources.get(v);
        if (r === undefined) continue;
        if (selectorKind(m, q) === 'space' || m.types.get(r.type)?.kind === 'space') rooms.push(r);
        for (const day of days) {
          claims.push({ series: i, resource: r.key, day, from: start - before(q), to: end + after(q),
            exclusive: (q.occupancy ?? 'exclusive') === 'exclusive' || (r.concurrency ?? 1) === 1 });
        }
      }
    }

    // SERIES_OUTSIDE_HOURS: the occurrence with its room and teacher buffers must fit the room's (or studio's) hours.
    const span: [number, number] = [
      start - Math.max(0, ...t.requirements.map(before)), end + Math.max(0, ...t.requirements.map(after)),
    ];
    const places: ResourceDef[] = rooms.length > 0 ? rooms : [{ key: '', type: '', name: '', location: s.location }];
    outer: for (const day of days) {
      for (const r of places) {
        const open = availableIntervals(doc.availability, r, day, weekdayOf(day), { ignoreDatedClosures: true });
        if (!fitsInside(span, open)) {
          out.error('SERIES_OUTSIDE_HOURS', ['timetable', i], `${s.key} on ${indexDate(day)} needs `
            + `${minutesTime(span[0])}–${minutesTime(span[1])} (buffers included), outside the hours of ${r.key || s.location}`);
          break outer;
        }
      }
    }

    // DST_SHIFTED_OCCURRENCE (informational, §7.10).
    const zone = zones.get(s.location);
    if (zone !== undefined) {
      for (const day of days) {
        if (isNonexistentLocalTime(day, start, zone)) {
          out.add('DST_SHIFTED_OCCURRENCE', 'I', ['timetable', i, 'start_local'],
            `${s.key} on ${indexDate(day)}: ${s.start_local} does not exist in ${zone}`);
        }
      }
    }
  });

  // TIMETABLE_CONFLICT: two series claiming one room at overlapping times on the same day.
  const byRoomDay = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = `${c.resource}@${c.day}`;
    byRoomDay.set(k, [...(byRoomDay.get(k) ?? []), c]);
  }
  let reported = 0;
  for (const group of [...byRoomDay.values()].sort((a, b) => a[0]!.day - b[0]!.day)) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const x = group[a]!;
        const y = group[b]!;
        if (x.series === y.series || x.to <= y.from || y.to <= x.from || !(x.exclusive || y.exclusive)) continue;
        if (reported++ >= MAX_COLLISIONS) return;
        const sx = doc.timetable[x.series]!;
        const sy = doc.timetable[y.series]!;
        out.error('TIMETABLE_CONFLICT', ['timetable', y.series], `${sx.key} and ${sy.key} both claim ${x.resource} on `
          + `${indexDate(x.day)} (${minutesTime(x.from)}–${minutesTime(x.to)} and ${minutesTime(y.from)}–${minutesTime(y.to)})`);
      }
    }
  }
}
