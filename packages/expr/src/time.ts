// Timestamps and durations: RFC 3339 and CEL duration strings, and wall-clock parts in an IANA zone.
// All arithmetic is exact (bigint nanoseconds); Intl is used only to read a zone's wall clock.

export const NS_PER_S = 1_000_000_000n;
export const NS_PER_MS = 1_000_000n;
/** 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999999Z (CEL's timestamp range). */
export const TS_MIN_NS = -62_135_596_800n * NS_PER_S;
export const TS_MAX_NS = 253_402_300_799n * NS_PER_S + 999_999_999n;
/** CEL's duration range: ±315,576,000,000 s (about 10,000 years). */
export const DUR_MAX_NS = 315_576_000_000n * NS_PER_S + 999_999_999n;

/** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

const daysInMonth = (y: number, m: number) =>
  m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** RFC 3339 → nanoseconds since the epoch, or null when malformed or out of range. */
export function parseTimestamp(s: string): bigint | null {
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || se > 59) return null;
  let offMin = 0;
  if (!m[8]) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const secs = BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + se) - BigInt(offMin * 60);
  const frac = m[7] ? BigInt(m[7].padEnd(9, '0')) : 0n;
  const ns = secs * NS_PER_S + frac;
  return ns < TS_MIN_NS || ns > TS_MAX_NS ? null : ns;
}

const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Nanoseconds → RFC 3339 in UTC, with 0, 3, 6 or 9 fraction digits. */
export function formatTimestamp(ns: bigint): string {
  const secs = floorDiv(ns, NS_PER_S);
  const frac = ns - secs * NS_PER_S;
  const days = Number(floorDiv(secs, 86400n));
  const sod = Number(secs - BigInt(days) * 86400n);
  const [y, m, d] = civilFromDays(days);
  let f = '';
  if (frac !== 0n) {
    const s9 = frac.toString().padStart(9, '0');
    f = '.' + (s9.endsWith('000000') ? s9.slice(0, 3) : s9.endsWith('000') ? s9.slice(0, 6) : s9);
  }
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(Math.floor(sod / 3600))}:${pad(Math.floor((sod % 3600) / 60))}:${pad(sod % 60)}${f}Z`;
}

const UNITS: [string, bigint][] = [
  ['ns', 1n],
  ['us', 1000n],
  ['µs', 1000n],
  ['ms', NS_PER_MS],
  ['s', NS_PER_S],
  ['m', 60n * NS_PER_S],
  ['h', 3600n * NS_PER_S],
];

/** CEL / Go duration string ("1h30m", "-1.5s", "0") → nanoseconds, or null. */
export function parseDuration(s: string): bigint | null {
  let i = 0;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    i = 1;
  }
  if (s.slice(i) === '0') return 0n;
  if (i >= s.length) return null;
  let total = 0n;
  while (i < s.length) {
    const m = /^(\d*)(?:\.(\d*))?/.exec(s.slice(i))!;
    const whole = m[1] ?? '';
    const frac = m[2] ?? '';
    if (whole === '' && frac === '') return null;
    i += m[0].length;
    const unit = UNITS.slice()
      .sort((a, b) => b[0].length - a[0].length)
      .find(([u]) => s.startsWith(u, i));
    if (!unit) return null;
    i += unit[0].length;
    const [, mult] = unit;
    total += BigInt(whole || '0') * mult;
    if (frac) total += (BigInt(frac) * mult) / 10n ** BigInt(frac.length);
    if (total > DUR_MAX_NS) return null;
  }
  return neg ? -total : total;
}

/** CEL's string form of a duration: seconds with up to 9 fraction digits, e.g. "5400s", "1.5s". */
export function formatDuration(ns: bigint): string {
  const neg = ns < 0n;
  const a = neg ? -ns : ns;
  const secs = a / NS_PER_S;
  const frac = a % NS_PER_S;
  const f = frac === 0n ? '' : '.' + frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${secs}${f}s`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
  } catch {
    return null;
  }
  formatters.set(zone, f);
  return f;
}

export const isValidZone = (zone: string): boolean => zone !== '' && formatter(zone) !== null;

export interface WallClock {
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:MM" */
  time: string;
  /** mon … sun (§4.2 Weekday) */
  weekday: string;
}

/** Wall-clock parts of an instant in an IANA zone, or null for an unknown zone. */
export function wallClock(ns: bigint, zone: string): WallClock | null {
  const f = formatter(zone);
  if (!f) return null;
  const ms = Number(floorDiv(ns, NS_PER_MS));
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : (parts.hour ?? '00');
  return {
    date: `${(parts.year ?? '').padStart(4, '0')}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    weekday: (parts.weekday ?? '').slice(0, 3).toLowerCase(),
  };
}
