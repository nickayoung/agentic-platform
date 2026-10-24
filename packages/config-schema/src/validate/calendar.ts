// Civil dates, a small RRULE expander and resource availability (§4.7, §4.10), for the timetable and coverage checks.
// Times are wall-clock minutes in the studio's zone; only DST_SHIFTED_OCCURRENCE looks at the zone itself.
import type { AvailabilityRuleDef, ResourceDef, SeriesDef, Weekday } from '../schema';

export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const RRULE_DAYS: Record<string, Weekday> = { MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat', SU: 'sun' };

const DAY_MS = 86_400_000;
export const dateIndex = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;   // days since 1970-01-01
export const indexDate = (i: number): string => new Date(i * DAY_MS).toISOString().slice(0, 10);
export const weekdayOf = (i: number): Weekday => WEEKDAYS[(((i + 3) % 7) + 7) % 7]!;   // 1970-01-01 was a Thursday
export const timeMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const minutesTime = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export type Interval = [number, number];   // [from, to) minutes of the day

// ── RRULE ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Occurrence dates (day indexes) of a series inside [from, to). Supports FREQ=DAILY|WEEKLY with INTERVAL, BYDAY
 * (plain weekdays), COUNT and UNTIL, with DTSTART = valid_from. Returns null for any other rule, which callers skip.
 */
export function expandSeries(s: SeriesDef, from: number, to: number): number[] | null {
  const parts = new Map(s.rrule.split(';').map((p) => p.split('=') as [string, string]));
  for (const k of parts.keys()) if (!['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST'].includes(k)) return null;
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return null;
  const interval = Number(parts.get('INTERVAL') ?? '1');
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : Infinity;
  if (!Number.isInteger(interval) || interval < 1 || Number.isNaN(count)) return null;
  const start = dateIndex(s.valid_from);
  let end = s.valid_until === undefined ? Infinity : dateIndex(s.valid_until) + 1;
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
    if (!m) return null;
    end = Math.min(end, dateIndex(`${m[1]}-${m[2]}-${m[3]}`) + 1);
  }
  let days: Set<Weekday> | null = null;
  const byday = parts.get('BYDAY');
  if (byday !== undefined) {
    days = new Set();
    for (const d of byday.split(',')) {
      const w = RRULE_DAYS[d];
      if (w === undefined) return null;   // ordinal forms such as 1MO
      days.add(w);
    }
  } else if (freq === 'WEEKLY') {
    days = new Set([weekdayOf(start)]);
  }
  const monday = (i: number): number => i - ((WEEKDAYS.indexOf(weekdayOf(i)) + 7) % 7);
  const excluded = new Set((s.exdates ?? []).map(dateIndex));
  const out: number[] = [];
  let n = 0;
  for (let i = start; i < end && i < to && n < count; i++) {
    const inStep = freq === 'DAILY' ? (i - start) % interval === 0 : ((monday(i) - monday(start)) / 7) % interval === 0;
    if (!inStep || (days !== null && !days.has(weekdayOf(i)))) continue;
    n++;
    if (i >= from && !excluded.has(i)) out.push(i);
  }
  return out;
}

// ── Availability (§4.10) ───────────────────────────────────────────────────────────────────────────────────────────

const namesResource = (a: AvailabilityRuleDef, r: ResourceDef): boolean =>
  (a.applies_to.resources?.includes(r.key) ?? false) || (a.applies_to.tags_any?.some((t) => r.tags?.includes(t)) ?? false);
const coversStudio = (a: AvailabilityRuleDef, location: string): boolean => a.applies_to.locations?.includes(location) ?? false;

function ruleIntervals(a: AvailabilityRuleDef, day: number | null, weekday: Weekday): Interval[] {
  const dated = day === null ? undefined : a.dates?.find((d) => dateIndex(d.date) === day);
  if (dated !== undefined) return (dated.intervals ?? [['00:00', '24:00']]).map(([f, t]) => [timeMinutes(f), timeMinutes(t)]);
  return (a.weekly?.[weekday] ?? []).map(([f, t]) => [timeMinutes(f), timeMinutes(t)]);
}

function subtract(open: Interval[], closed: Interval[]): Interval[] {
  let out = open;
  for (const [cf, ct] of closed) {
    out = out.flatMap(([f, t]): Interval[] => {
      if (ct <= f || cf >= t) return [[f, t]];
      return [...(cf > f ? [[f, cf] as Interval] : []), ...(ct < t ? [[ct, t] as Interval] : [])];
    });
  }
  return out;
}

export interface AvailabilityOptions {
  /** Ignore date-specific closures (planned closures suppress occurrences rather than make them invalid). */
  ignoreDatedClosures?: boolean;
}

/**
 * Open intervals of a room or desk on a day. `day` null means "a typical week": weekly rules only. A resource follows
 * its own open rules if any name it, else its studio's; a studio with no open rule is always open.
 */
export function availableIntervals(
  rules: readonly AvailabilityRuleDef[], r: ResourceDef, day: number | null, weekday: Weekday, opts: AvailabilityOptions = {},
): Interval[] {
  const own = rules.filter((a) => a.kind === 'open' && namesResource(a, r));
  const studio = rules.filter((a) => a.kind === 'open' && coversStudio(a, r.location));
  const source = own.length > 0 ? own : studio;
  let open: Interval[] = source.length === 0 ? [[0, 1440]] : source.flatMap((a) => ruleIntervals(a, day, weekday));
  const closing = rules.filter((a) => a.kind === 'closed' && (namesResource(a, r) || coversStudio(a, r.location)));
  for (const a of closing) {
    const dated = day === null || opts.ignoreDatedClosures ? undefined : a.dates?.find((d) => dateIndex(d.date) === day);
    const closed = dated !== undefined
      ? (dated.intervals ?? [['00:00', '24:00']]).map(([f, t]): Interval => [timeMinutes(f), timeMinutes(t)])
      : (a.weekly?.[weekday] ?? []).map(([f, t]): Interval => [timeMinutes(f), timeMinutes(t)]);
    open = subtract(open, closed);
  }
  return open;
}

/** True when a date-specific closed rule closes this resource for the whole day. */
export function closedAllDay(rules: readonly AvailabilityRuleDef[], r: ResourceDef, day: number): boolean {
  return rules.some((a) => a.kind === 'closed' && (namesResource(a, r) || coversStudio(a, r.location))
    && (a.dates?.some((d) => dateIndex(d.date) === day && d.intervals === undefined) ?? false));
}

export const fitsInside = ([f, t]: Interval, open: readonly Interval[]): boolean => open.some(([of, ot]) => of <= f && t <= ot);

// ── Time zones ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** True when the wall-clock time doesn't exist in the zone on that day (skipped by a DST change, §7.10). */
export function isNonexistentLocalTime(day: number, minutes: number, zone: string): boolean {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return false;   // an unknown zone is not this check's concern
  }
  const wall = day * 1440 + minutes;
  const localOf = (utcMs: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    return dateIndex(`${p.year}-${p.month}-${p.day}`) * 1440 + Number(p.hour) * 60 + Number(p.minute);
  };
  // Try both offsets around the instant; if neither maps back to the wall time, the wall time was skipped.
  const guess = wall * 60_000;
  for (const probe of [guess - 14 * 3_600_000, guess + 14 * 3_600_000]) {
    const offset = localOf(probe) - probe / 60_000;
    if (localOf((wall - offset) * 60_000) === wall) return false;
  }
  return true;
}
