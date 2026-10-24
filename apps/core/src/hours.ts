// Hours records and the Gusto CSV export (§18.8, §3A.16). Kairos stops at hours: it classifies regular and overtime
// hours and writes Gusto's upload format; Gusto prices them. MVP: the employee file; contractors come next.
import type { Tx } from '@kairos/db';
import { KairosError } from '@kairos/errors';
import type { ActiveConfig } from './model';
import { addDays, fromLocal, toLocal, weekdayOf, WEEKDAYS, type Weekday } from './time';

export interface HoursRow {
  id: string;
  resource_id: string;
  name: string;
  kind: 'shift' | 'teaching';
  location_key: string;
  start: number;
  end: number;
  minutes: number;
  state: 'scheduled' | 'worked' | 'approved' | 'voided';
}

/** Records whose session has ended become `worked` (§3A.16). Applied lazily before any read or approval. */
export function markWorked(tx: Tx, now: number): number {
  return tx.run(`UPDATE hours_record SET state = 'worked', updated_at = ?, version = version + 1 WHERE state = 'scheduled' AND end_at <= ?`, now, now);
}

export function listHours(tx: Tx, from: number, to: number): HoursRow[] {
  return tx.all<HoursRow & Record<string, SqlStorageValue>>(
    `SELECT h.id, h.resource_id, r.name, h.kind, h.location_key, h.start_at AS start, h.end_at AS "end", h.minutes, h.state
       FROM hours_record h JOIN resource r ON r.id = h.resource_id
      WHERE h.start_at >= ? AND h.start_at < ? AND h.state != 'voided' ORDER BY h.start_at, r.name`, from, to);
}

export function approveHours(tx: Tx, id: string, actor: unknown, now: number): HoursRow {
  const h = tx.maybe<{ state: string }>('SELECT state FROM hours_record WHERE id = ?', id);
  if (!h) throw new KairosError('NOT_FOUND', { message: `hours ${id}` });
  if (h.state === 'scheduled') throw new KairosError('SCHEMA_INVALID', { message: 'this shift has not been worked yet' });
  if (h.state === 'voided') throw new KairosError('SCHEMA_INVALID', { message: 'voided hours cannot be approved' });
  tx.run(`UPDATE hours_record SET state = 'approved', approved_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`, JSON.stringify(actor), now, id);
  return tx.one<HoursRow & Record<string, SqlStorageValue>>(
    `SELECT h.id, h.resource_id, r.name, h.kind, h.location_key, h.start_at AS start, h.end_at AS "end", h.minutes, h.state
       FROM hours_record h JOIN resource r ON r.id = h.resource_id WHERE h.id = ?`, id);
}

// ---- Gusto CSV ---------------------------------------------------------------------------------------------------

const periodDays: Record<string, number> = { weekly: 7, biweekly: 14 };

/** The pay period containing `date`, from `pay_period.anchor` (weekly and biweekly; other frequencies come later). */
export function payPeriod(cfg: ActiveConfig, date: string): { start: string; end: string } {
  const pp = cfg.doc.tenant.payroll_export!.pay_period;
  const len = periodDays[pp.frequency];
  if (!len) throw new KairosError('SCHEMA_INVALID', { message: `pay period ${pp.frequency} is not supported yet` });
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${pp.anchor}T00:00:00Z`)) / 86_400_000);
  const start = addDays(pp.anchor, Math.floor(diff / len) * len);
  return { start, end: addDays(start, len - 1) };
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
/** Hours with 2 decimals, rounded half-up once per cell (§18.8.2). */
const hours = (minutes: number) => (Math.floor((minutes / 60) * 100 + 0.5 + 1e-9) / 100).toFixed(2);

export interface ExportResult {
  filename: string;
  csv: string;
  period: { start: string; end: string };
  unapproved: number;
  rows: number;
}

export function gustoEmployeesCsv(tx: Tx, cfg: ActiveConfig, periodStart: string, env: string, tenant: string): ExportResult {
  const settings = cfg.doc.tenant.payroll_export;
  if (!settings) throw new KairosError('SCHEMA_INVALID', { message: 'payroll_export is not configured' });
  const period = payPeriod(cfg, periodStart);
  if (period.start !== periodStart) throw new KairosError('SCHEMA_INVALID', { message: `pay periods start on ${period.start}` });
  const zone = cfg.doc.tenant.default_timezone;
  const from = fromLocal(period.start, '00:00', zone);
  const to = fromLocal(addDays(period.end, 1), '00:00', zone);
  const recs = tx.all<{ resource_id: string; name: string; payroll_ref: string | null; payroll_type: string | null; kind: 'shift' | 'teaching';
    start: number; end: number; minutes: number; state: string }>(
    `SELECT h.resource_id, r.name, r.payroll_ref, r.payroll_type, h.kind, h.start_at AS start, h.end_at AS "end", h.minutes, h.state
       FROM hours_record h JOIN resource r ON r.id = h.resource_id
      WHERE h.start_at >= ? AND h.start_at < ? AND h.state != 'voided' ORDER BY h.start_at`, from, to);
  const unapproved = recs.filter((r) => r.state !== 'approved').length;
  const approved = recs.filter((r) => r.state === 'approved' && r.payroll_type !== 'contractor');
  const missing = [...new Set(approved.filter((r) => !r.payroll_ref).map((r) => r.name))];
  if (missing.length) {
    throw new KairosError('SCHEMA_INVALID', { message: `PAYROLL_REF_MISSING: ${missing.join(', ')}`, reasons: missing.map((m) => ({ code: 'SCHEMA_INVALID' as const, message: `${m} has no payroll_ref` })) });
  }

  const weekStart = cfg.doc.tenant.week_starts as Weekday;
  const workweek = (ms: number) => {
    const d = toLocal(ms, zone).date;
    return addDays(d, -((WEEKDAYS.indexOf(weekdayOf(d)) - WEEKDAYS.indexOf(weekStart) + 7) % 7));
  };
  const otLimit = (settings.overtime.weekly_hours ?? Infinity) * 60;

  // per person × workweek: walk records in time order; minutes past the weekly limit are overtime (§18.8.2)
  type Key = string;
  const cells = new Map<Key, { name: string; ref: string; week: string; kind: 'shift' | 'teaching'; regular: number; overtime: number }>();
  const weekTotal = new Map<string, number>();
  for (const r of approved) {
    const week = workweek(r.start);
    const wk = `${r.resource_id}|${week}`;
    const before = weekTotal.get(wk) ?? 0;
    const after = before + r.minutes;
    weekTotal.set(wk, after);
    const regular = Math.max(0, Math.min(r.minutes, otLimit - before));
    const kind = settings.split_by_kind ? r.kind : 'shift';
    const k = `${wk}|${kind}`;
    const c = cells.get(k) ?? { name: r.name, ref: r.payroll_ref!, week, kind, regular: 0, overtime: 0 };
    c.regular += regular;
    c.overtime += r.minutes - regular;
    cells.set(k, c);
  }

  const header = settings.template_headers.employees;
  const cols = settings.columns.employees as Record<string, string | undefined>;
  const split = (name: string) => { const i = name.lastIndexOf(' '); return i < 0 ? { first: name, last: '' } : { first: name.slice(0, i), last: name.slice(i + 1) }; };
  const rows = [...cells.values()].sort((a, b) => {
    const x = split(a.name); const y = split(b.name);
    return x.last.localeCompare(y.last) || x.first.localeCompare(y.first) || a.week.localeCompare(b.week) || a.kind.localeCompare(b.kind);
  }).map((c) => {
    const n = split(c.name);
    const values: Record<string, string> = {
      payroll_ref: c.ref, last_name: n.last, first_name: n.first, workweek: c.week,
      job: settings.job_names?.[c.kind] ?? c.kind,
      regular_hours: hours(c.regular), overtime_hours: hours(c.overtime), double_overtime_hours: '0.00',
    };
    const byHeader = new Map(Object.entries(cols).filter(([, h]) => h).map(([field, h]) => [h!, values[field] ?? '']));
    return header.map((h) => cell(byHeader.get(h) ?? '')).join(',');
  });
  const csv = [header.map(cell).join(','), ...rows].join('\r\n') + '\r\n';
  const prefix = env === 'preview' ? 'PREVIEW_' : '';
  return { filename: `${prefix}${tenant}_${env}_${period.start}_${period.end}_employees_v1.csv`, csv, period, unapproved, rows: rows.length };
}
