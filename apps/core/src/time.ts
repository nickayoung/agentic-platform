// Local wall time ↔ UTC for a studio's IANA zone (§7.10), using Intl only. Shift starts and coverage patterns are
// local wall times, so they keep their local time across DST.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const fmt = (zone: string) => {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(zone, f);
  }
  return f;
};

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface LocalParts {
  date: string;      // "2027-03-08"
  time: string;      // "06:15"
  weekday: Weekday;
  minutes: number;   // minutes since local midnight
}

export function toLocal(ms: number, zone: string): LocalParts {
  const p = Object.fromEntries(fmt(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return {
    date: `${p.year}-${p.month}-${p.day}`, time,
    weekday: (p.weekday ?? 'Mon').toLowerCase().slice(0, 3) as Weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Offset of `zone` from UTC at instant `ms`, in minutes (New York in winter: -300). */
function offsetMinutes(ms: number, zone: string): number {
  const p = Object.fromEntries(fmt(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant of a local date and time. In the spring-forward gap the time moves forward by the gap; in the
 * fall-back overlap the first (earlier) instant is used (§7.10).
 */
export function fromLocal(date: string, time: string, zone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = offsetMinutes(naive, zone);
  let t = naive - o1 * 60_000;
  const o2 = offsetMinutes(t, zone);
  if (o2 !== o1) {
    const t2 = naive - o2 * 60_000;
    t = toLocal(t2, zone).time === time ? Math.min(t, t2) : Math.max(t, t2);
  }
  return t;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

/** The first day of the week containing `date`, for a tenant whose weeks start on `weekStart`. */
export function weekStartOf(date: string, weekStart: Weekday = 'mon'): string {
  const back = (WEEKDAYS.indexOf(weekdayOf(date)) - WEEKDAYS.indexOf(weekStart) + 7) % 7;
  return addDays(date, -back);
}

export const hhmmToMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export const minutesToHhmm = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** Config durations ("6h30m", "40m", "10h", "2d", "1w") in milliseconds. */
export function durationMs(d: string): number {
  const re = /(\d+)([wdhm])/g;
  let total = 0;
  let matched = '';
  for (let m = re.exec(d); m; m = re.exec(d)) {
    matched += m[0];
    const n = Number(m[1]);
    total += n * { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'w' | 'd' | 'h' | 'm'];
  }
  if (matched !== d || d === '') throw new Error(`bad duration ${d}`);
  return total;
}
