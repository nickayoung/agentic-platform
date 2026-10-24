// Time display and local-date arithmetic. The API speaks UTC milliseconds; every studio is in America/New_York,
// so the console shows that zone regardless of the viewer's own. Local dates are "YYYY-MM-DD" strings.
export const TZ = 'America/New_York';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const longDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

/** Wall-clock fields of an instant in New York. */
export function zoned(ms: number): { date: string; time: string } {
  const p = Object.fromEntries(parts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** UTC offset of New York at an instant, in ms (negative: behind UTC). */
function offset(ms: number): number {
  const { date, time } = zoned(ms);
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5)) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant of a New York wall-clock time. */
export function fromZoned(date: string, time = '00:00'): number {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5));
  const first = guess - offset(guess);
  return guess - offset(first);
}

const utcDate = (d: string) => new Date(`${d}T00:00:00Z`);

export const today = (): string => zoned(Date.now()).date;

export function addDays(date: string, n: number): string {
  const d = utcDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (a: string, b: string): number => Math.round((utcDate(b).getTime() - utcDate(a).getTime()) / 86_400_000);

/** Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -((utcDate(date).getUTCDay() + 6) % 7));
}

export const weekDays = (monday: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utcDate(s).getTime());

/** "Mon, Mar 8" for a local date. */
export const formatDay = (date: string): string => dayFmt.format(utcDate(date));
export const formatLongDay = (date: string): string => longDayFmt.format(utcDate(date));

/** "6:15 PM" for an instant. */
export const formatTime = (ms: number): string => timeFmt.format(ms);
export const formatDateTime = (ms: number): string => dateTimeFmt.format(ms);

/** "18:00" → "6:00 PM" (a local wall-clock string from the API). */
export function formatHm(hm: string): string {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "18:00" → "6pm", "06:15" → "6:15am": for dense grids. */
export function formatHmShort(hm: string): string {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export function formatRange(fromHm: string, toHm: string): string {
  const a = formatHm(fromHm);
  const b = formatHm(toHm);
  // "6:15 – 12:45 PM" when both sides share AM/PM
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

/** Start of the biweekly pay period containing `date`, counting from `anchor`. */
export function payPeriodStart(date: string, anchor: string): string {
  return addDays(anchor, Math.floor(daysBetween(anchor, date) / 14) * 14);
}
