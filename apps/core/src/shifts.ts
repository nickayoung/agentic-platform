// Desk shifts in owner mode (§4.6, §8, §3A.10–§3A.11). A shift template's `starts` define candidate slots; a slot
// becomes a session only when someone is assigned, with an exclusive claim on the person and a lane claim on the
// studio's front desk, in one batch (§12.2). The person-rule validator (§8.5) runs inside the same transaction.
import { claimPlatform, releaseClaim, type Tx } from '@kairos/db';
import { KairosError, type Reason } from '@kairos/errors';
import { emitEvent } from './events';
import type { ActiveConfig, Doc, TemplateDef } from './model';
import { addDays, durationMs, fromLocal, hhmmToMinutes, minutesToHhmm, toLocal, weekdayOf, WEEKDAYS, type Weekday } from './time';

const id = (p: string) => `${p}_${crypto.randomUUID().replaceAll('-', '')}`;

export interface Slot {
  slot_key: string;          // occurrence key: "<template>@<location>@<date>T<HH:MM>"
  template_key: string;
  template_name: string;
  location_key: string;
  start: number;
  end: number;
  local: { date: string; start: string; end: string };
  state: 'open' | 'filled' | 'vacated';
  session_id: string | null;
  worker: { resource_id: string; name: string } | null;
}

export interface CoverageGap {
  date: string;
  from: string;
  to: string;
  min: number;
  have: number;
}

interface Start { at: string; days: Weekday[]; locations?: string[] }

const isShiftTemplate = (t: TemplateDef) => t.scheduling.mode === 'rostered' && t.participants.who === 'none';
const startsOf = (t: TemplateDef) => ((t.scheduling as { starts?: Start[] }).starts ?? []);
const workerReq = (t: TemplateDef) => t.requirements.find((r) => r.assign === 'roster' && r.select.role !== undefined);

function closedOn(doc: Doc, location: string, date: string): boolean {
  return doc.availability.some((a) => a.kind === 'closed' && (a.applies_to.locations ?? []).includes(location)
    && ((a as { dates?: { date: string }[] }).dates ?? []).some((d) => d.date === date));
}

export const slotKey = (template: string, location: string, date: string, at: string) => `${template}@${location}@${date}T${at}`;

/** Candidate slots for one studio over [fromDate, fromDate + days). */
export function candidates(cfg: ActiveConfig, location: string, fromDate: string, days: number) {
  const out: Omit<Slot, 'state' | 'session_id' | 'worker'>[] = [];
  const zone = cfg.zoneOf(location);
  for (const t of cfg.doc.templates.filter(isShiftTemplate)) {
    const dur = durationMs(t.duration);
    for (let i = 0; i < days; i++) {
      const date = addDays(fromDate, i);
      if (closedOn(cfg.doc, location, date)) continue;
      const wd = weekdayOf(date);
      for (const s of startsOf(t)) {
        if (!s.days.includes(wd) || (s.locations && !s.locations.includes(location))) continue;
        const start = fromLocal(date, s.at, zone);
        const end = start + dur;
        out.push({
          slot_key: slotKey(t.key, location, date, s.at), template_key: t.key, template_name: t.name, location_key: location,
          start, end, local: { date, start: s.at, end: toLocal(end, zone).time },
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.template_key.localeCompare(b.template_key));
}

/** The roster for one studio and week: every candidate slot with its state, plus coverage gaps (§4.6). */
export function rosterWeek(tx: Tx, cfg: ActiveConfig, location: string, weekStart: string): { slots: Slot[]; coverage: CoverageGap[] } {
  const cands = candidates(cfg, location, weekStart, 7);
  const rows = tx.all<{ id: string; occurrence_key: string; status: string; resource_id: string | null; name: string | null }>(
    `SELECT s.id, s.occurrence_key, s.status, a.resource_id, r.name
       FROM session s
       LEFT JOIN assignment a ON a.session_id = s.id AND a.requirement_key = 'worker' AND a.state = 'confirmed'
       LEFT JOIN resource r ON r.id = a.resource_id
      WHERE s.location_key = ? AND s.start_at >= ? AND s.start_at < ? AND s.status != 'cancelled' AND s.occurrence_key IS NOT NULL`,
    location, cands[0]?.start ?? 0, (cands.at(-1)?.start ?? 0) + 1,
  );
  const byKey = new Map(rows.map((r) => [r.occurrence_key, r]));
  const slots: Slot[] = cands.map((c) => {
    const r = byKey.get(c.slot_key);
    return {
      ...c,
      state: !r ? 'open' : r.resource_id ? 'filled' : 'vacated',
      session_id: r?.id ?? null,
      worker: r?.resource_id ? { resource_id: r.resource_id, name: r.name ?? '' } : null,
    };
  });
  return { slots, coverage: coverageGaps(cfg, location, weekStart, slots) };
}

/** Segments of the week where filled desk shifts fall below a coverage rule's minimum (5-minute grains). */
function coverageGaps(cfg: ActiveConfig, location: string, weekStart: string, slots: Slot[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const zone = cfg.zoneOf(location);
  for (const rule of cfg.doc.coverage.filter((c) => c.location === location)) {
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      if (closedOn(cfg.doc, location, date)) continue;
      const wd = weekdayOf(date);
      for (const seg of rule.pattern.filter((p) => (p.days as Weekday[]).includes(wd))) {
        const from = hhmmToMinutes(seg.from);
        const to = hhmmToMinutes(seg.to);
        let open: { from: number; have: number } | null = null;
        for (let m = from; m <= to; m += 5) {
          let have = 0;
          if (m < to) {
            const at = fromLocal(date, minutesToHhmm(m), zone);
            have = slots.filter((s) => s.state === 'filled' && rule.shift_templates.includes(s.template_key) && s.start <= at && at < s.end).length;
          }
          const short = m < to && have < seg.min;
          if (short && (!open || open.have !== have)) {
            if (open) gaps.push({ date, from: minutesToHhmm(open.from), to: minutesToHhmm(m), min: seg.min, have: open.have });
            open = { from: m, have };
          } else if (!short && open) {
            gaps.push({ date, from: minutesToHhmm(open.from), to: minutesToHhmm(m), min: seg.min, have: open.have });
            open = null;
          }
        }
      }
    }
  }
  return gaps;
}

// ---- person rules (§8.5) -----------------------------------------------------------------------------------------

interface PersonClaim {
  claim_id: string;
  session_id: string;
  template_key: string;
  location_key: string;
  start: number;          // session start/end (work time)
  end: number;
  occ_start: number;      // with buffers (occupancy)
  occ_end: number;
  source: string;
}

interface Person { id: string; name: string; roles: string[]; state: string }

const WEEK_MS = 7 * 86_400_000;

function personClaims(tx: Tx, resourceId: string, from: number, to: number): PersonClaim[] {
  return tx.all<PersonClaim & Record<string, SqlStorageValue>>(
    `SELECT c.id AS claim_id, s.id AS session_id, s.template_key, s.location_key, s.start_at AS start, s.end_at AS "end",
            c.occ_start, c.occ_end, c.source
       FROM claim c JOIN assignment a ON a.id = c.owner_id AND c.owner_type = 'assignment'
       JOIN session s ON s.id = a.session_id
      WHERE c.resource_id = ? AND c.state != 'released' AND c.occ_end > ? AND c.occ_start < ?`,
    resourceId, from, to,
  );
}

const tagsOf = (cfg: ActiveConfig, template: string): string[] => {
  try {
    return cfg.template(template).tags ?? [];
  } catch {
    return [];
  }
};

function reason(code: Reason['code'], message: string, facts: Record<string, unknown> = {}): Reason {
  return { code, message, facts };
}

/**
 * Hard person rules for putting `person` on a shift [start, end) at `location`: role, state, time off, occupancy
 * against every claim (owned or mirrored, any domain), transfer time, min rest, max hours and max assignments.
 * Returns the reasons it fails, empty when it passes. Pure reads inside the caller's transaction.
 */
export function checkPerson(
  tx: Tx, cfg: ActiveConfig, person: Person, shift: { template: TemplateDef; location: string; start: number; end: number },
): Reason[] {
  const out: Reason[] = [];
  const req = workerReq(shift.template);
  const role = req?.select.role;
  if (role && !person.roles.includes(role)) out.push(reason('ROLE_MISSING', `${person.name} doesn't have the ${role} role`, { role }));
  if (person.state !== 'active') out.push(reason('ROLE_MISSING', `${person.name} is ${person.state}`, { state: person.state }));

  const off = tx.maybe<{ reason: string; start_at: number; end_at: number }>(
    `SELECT reason, start_at, end_at FROM time_off WHERE resource_id = ? AND state = 'approved' AND start_at < ? AND end_at > ? LIMIT 1`,
    person.id, shift.end, shift.start,
  );
  if (off) out.push(reason('OUTSIDE_AVAILABILITY', `${person.name} has time off (${off.reason})`, { time_off: off }));

  const maxTransfer = Math.max(0, ...cfg.doc.locations.flatMap((l) => (l.transfer_times ?? []).map((t) => durationMs(t.duration))));
  const near = personClaims(tx, person.id, shift.start - Math.max(maxTransfer, 12 * 3_600_000), shift.end + Math.max(maxTransfer, 12 * 3_600_000));
  const name = (t: string) => { try { return cfg.template(t).name; } catch { return t; } };
  const local = (ms: number, loc: string) => { const l = toLocal(ms, cfg.zoneOf(loc)); return `${l.date} ${l.time}`; };

  for (const c of near) {
    if (c.occ_start < shift.end && c.occ_end > shift.start) {
      out.push(reason('RESOURCE_CONFLICT', `${person.name} is ${c.source === 'mirror' ? 'teaching' : 'working'} ${name(c.template_key)} at ${local(c.start, c.location_key)}`,
        { session_id: c.session_id, template_key: c.template_key, start: c.start, source: c.source }));
    }
  }

  const applies = (a: { roles?: string[]; template_tags?: string[] } | undefined) =>
    !a || ((a.roles ?? []).length === 0 || person.roles.some((r) => (a.roles ?? []).includes(r)));
  const newTags = shift.template.tags ?? [];

  for (const k of cfg.doc.constraints.filter((x) => x.level === 'hard' && applies(x.applies_to as never))) {
    const rule = k.rule as { type: string; duration?: string; hours?: number; count?: number; window?: string;
      from?: { template_tags?: string[] }; to?: { template_tags?: string[] } };
    if (rule.type === 'transfer_time') {
      for (const c of near) {
        const travel = cfg.transfer(c.location_key, shift.location);
        if (!travel || c.location_key === shift.location) continue;
        const gap = c.end <= shift.start ? shift.start - c.end : c.start >= shift.end ? c.start - shift.end : -1;
        if (gap >= 0 && gap < travel) {
          out.push(reason('TRANSFER_TIME', `${person.name} needs ${travel / 60_000} min to travel from ${name(c.template_key)} at ${c.location_key}`,
            { constraint: k.key, session_id: c.session_id }));
        }
      }
    } else if (rule.type === 'min_rest' && rule.duration) {
      const need = durationMs(rule.duration);
      const matchFrom = (tags: string[]) => !rule.from?.template_tags || rule.from.template_tags.some((t) => tags.includes(t));
      const matchTo = (tags: string[]) => !rule.to?.template_tags || rule.to.template_tags.some((t) => tags.includes(t));
      for (const c of near) {
        const tags = tagsOf(cfg, c.template_key);
        const before = c.end <= shift.start && matchFrom(tags) && matchTo(newTags) ? shift.start - c.end : -1;
        const after = c.start >= shift.end && matchFrom(newTags) && matchTo(tags) ? c.start - shift.end : -1;
        const gap = before >= 0 ? before : after;
        if (gap >= 0 && gap < need) {
          out.push(reason('REST_VIOLATION', `${k.description}: only ${Math.round(gap / 60_000)} min between ${name(c.template_key)} and this shift`,
            { constraint: k.key, session_id: c.session_id }));
        }
      }
    } else if (rule.type === 'max_hours' && rule.window === 'week' && rule.hours) {
      const zone = cfg.zoneOf(shift.location);
      const wk = toLocal(shift.start, zone);
      const weekStart = addDays(wk.date, -WEEKDAYS.indexOf(wk.weekday));
      const from = fromLocal(weekStart, '00:00', zone);
      const to = fromLocal(addDays(weekStart, 7), '00:00', zone);
      const claims = personClaims(tx, person.id, from - WEEK_MS, to + WEEK_MS).filter((c) => c.start >= from && c.start < to);
      const minutes = claims.reduce((s, c) => s + (c.end - c.start) / 60_000, 0) + (shift.end - shift.start) / 60_000;
      if (minutes > rule.hours * 60) {
        out.push(reason('MAX_HOURS', `${k.description}: this would make ${Math.round(minutes / 6) / 10} h this week`,
          { constraint: k.key, minutes, limit_minutes: rule.hours * 60 }));
      }
    } else if (rule.type === 'max_assignments' && rule.window === 'day' && rule.count) {
      const zone = cfg.zoneOf(shift.location);
      const day = toLocal(shift.start, zone).date;
      const from = fromLocal(day, '00:00', zone);
      const to = fromLocal(addDays(day, 1), '00:00', zone);
      const n = personClaims(tx, person.id, from, to).filter((c) => c.start >= from && c.start < to).length + 1;
      if (n > rule.count) out.push(reason('MAX_ASSIGNMENTS', `${k.description}`, { constraint: k.key, count: n }));
    }
  }
  return out;
}

// ---- assign, unassign, vacate ------------------------------------------------------------------------------------

function loadPerson(tx: Tx, resourceId: string): Person {
  const r = tx.maybe<{ id: string; name: string; roles: string; state: string; kind: string }>(
    'SELECT id, name, roles, state, kind FROM resource WHERE id = ?', resourceId);
  if (!r || r.kind !== 'person') throw new KairosError('NOT_FOUND', { message: `person ${resourceId}` });
  return { id: r.id, name: r.name, roles: JSON.parse(r.roles) as string[], state: r.state };
}

function deskFor(tx: Tx, location: string): { id: string; name: string } {
  const r = tx.maybe<{ id: string; name: string }>(
    `SELECT id, name FROM resource WHERE type_key = 'front_desk' AND home_location_key = ? AND state = 'active' LIMIT 1`, location);
  if (!r) throw new KairosError('NOT_FOUND', { message: `no front desk at ${location}` });
  return r;
}

function bumpDays(tx: Tx, resourceId: string, zone: string, start: number, end: number): void {
  for (const d of new Set([toLocal(start, zone).date, toLocal(end - 1, zone).date])) {
    tx.run(`INSERT INTO resource_day (resource_id, day, version) VALUES (?, ?, 1)
            ON CONFLICT (resource_id, day) DO UPDATE SET version = version + 1`, resourceId, d);
  }
}

export interface AssignInput { template_key: string; location_key: string; start: number; resource_id: string }

/** Puts a worker on a candidate slot (a one-op proposal applied directly, §8.7). One batch. */
export function assignShift(tx: Tx, cfg: ActiveConfig, input: AssignInput, actor: unknown, now: number): { session_id: string; slot: Slot } {
  const t = cfg.template(input.template_key);
  if (!isShiftTemplate(t)) throw new KairosError('SCHEMA_INVALID', { message: `${t.key} is not a rostered shift template` });
  const zone = cfg.zoneOf(input.location_key);
  const local = toLocal(input.start, zone);
  const cand = candidates(cfg, input.location_key, local.date, 1).find((c) => c.template_key === t.key && c.start === input.start);
  if (!cand) throw new KairosError('NOT_FOUND', { message: `no ${t.key} slot at ${input.location_key} on ${local.date} ${local.time}` });
  if (cand.start < now) throw new KairosError('SCHEMA_INVALID', { message: 'that shift has already started' });

  const person = loadPerson(tx, input.resource_id);
  const problems = checkPerson(tx, cfg, person, { template: t, location: input.location_key, start: cand.start, end: cand.end });
  if (problems.length) {
    const first = problems[0]!;
    throw new KairosError(first.code, { message: first.message ?? first.code, reasons: problems });
  }

  const existing = tx.maybe<{ id: string; status: string }>('SELECT id, status FROM session WHERE occurrence_key = ? AND status != ?', cand.slot_key, 'cancelled');
  let sessionId: string;
  if (existing) {
    const filled = tx.maybe('SELECT 1 FROM assignment WHERE session_id = ? AND requirement_key = ? AND state = ?', existing.id, 'worker', 'confirmed');
    if (filled) throw new KairosError('RESOURCE_CONFLICT', { message: 'this shift already has a worker', reasons: [{ code: 'RESOURCE_CONFLICT', message: 'slot is filled' }] });
    sessionId = existing.id;
  } else {
    // a cancelled session may hold the occurrence key; free it for the new one
    tx.run(`UPDATE session SET occurrence_key = NULL WHERE occurrence_key = ? AND status = 'cancelled'`, cand.slot_key);
    sessionId = id('ses');
    tx.run(
      `INSERT INTO session (id, template_key, occurrence_key, location_key, start_at, end_at, zone, status, capacity_total,
         config_version, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, 'platform', ?, ?)`,
      sessionId, t.key, cand.slot_key, input.location_key, cand.start, cand.end, zone, cfg.number, now, now,
    );
    const desk = deskFor(tx, input.location_key);
    const deskAsg = id('asg');
    const deskClaim = id('clm');
    tx.run(`INSERT INTO assignment (id, session_id, requirement_key, resource_id, state, claim_id, assigned_by, source, created_at, updated_at)
            VALUES (?, ?, 'desk', ?, 'confirmed', ?, ?, 'platform', ?, ?)`, deskAsg, sessionId, desk.id, deskClaim, JSON.stringify(actor), now, now);
    try {
      claimPlatform(tx, { id: deskClaim, resourceId: desk.id, ownerType: 'assignment', ownerId: deskAsg, start: cand.start, end: cand.end,
        occStart: cand.start, occEnd: cand.end, mode: 'lane', domain: 'shifts', source: 'platform' });
    } catch (e) {
      if (e instanceof KairosError) {
        throw new KairosError('RESOURCE_CONFLICT', { message: `${desk.name} has no free lane then`, reasons: [{ code: 'RESOURCE_CONFLICT', message: `${desk.name} is full`, facts: { resource_id: desk.id } }] });
      }
      throw e;
    }
  }

  const asg = id('asg');
  const claim = id('clm');
  tx.run(`INSERT INTO assignment (id, session_id, requirement_key, resource_id, state, claim_id, assigned_by, source, created_at, updated_at)
          VALUES (?, ?, 'worker', ?, 'confirmed', ?, ?, 'platform', ?, ?)`, asg, sessionId, person.id, claim, JSON.stringify(actor), now, now);
  claimPlatform(tx, { id: claim, resourceId: person.id, ownerType: 'assignment', ownerId: asg, start: cand.start, end: cand.end,
    occStart: cand.start, occEnd: cand.end, mode: 'exclusive', domain: 'shifts', source: 'platform' });
  tx.run(`UPDATE session SET status = 'scheduled', updated_at = ?, version = version + 1 WHERE id = ?`, now, sessionId);
  bumpDays(tx, person.id, zone, cand.start, cand.end);
  // one hours record per confirmed owned assignment (I-28b)
  tx.run(`INSERT INTO hours_record (id, resource_id, assignment_id, session_id, kind, location_key, start_at, end_at, minutes, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'shift', ?, ?, ?, ?, 'scheduled', ?, ?)`,
    id('hrs'), person.id, asg, sessionId, input.location_key, cand.start, cand.end, Math.round((cand.end - cand.start) / 60_000), now, now);
  emitEvent(tx, { name: 'assignment.confirmed', subject: { type: 'assignment', id: asg }, reason: 'roster',
    data: { session_id: sessionId, resource_id: person.id, template_key: t.key } }, now);

  return {
    session_id: sessionId,
    slot: { ...cand, state: 'filled', session_id: sessionId, worker: { resource_id: person.id, name: person.name } },
  };
}

function releaseWorker(tx: Tx, sessionId: string, voidReason: string, now: number): { resource_id: string; assignment_id: string } | null {
  const a = tx.maybe<{ id: string; resource_id: string; claim_id: string | null }>(
    `SELECT id, resource_id, claim_id FROM assignment WHERE session_id = ? AND requirement_key = 'worker' AND state = 'confirmed'`, sessionId);
  if (!a) return null;
  if (a.claim_id) releaseClaim(tx, a.claim_id);
  tx.run(`UPDATE assignment SET state = 'released', updated_at = ?, version = version + 1 WHERE id = ?`, now, a.id);
  tx.run(`UPDATE hours_record SET state = 'voided', void_reason = ?, updated_at = ?, version = version + 1
          WHERE assignment_id = ? AND state != 'voided'`, voidReason, now, a.id);
  return { resource_id: a.resource_id, assignment_id: a.id };
}

/** Removes a shift: releases the worker and the desk lane, voids the hours, cancels the session. */
export function unassignShift(tx: Tx, sessionId: string, now: number): void {
  const s = tx.maybe<{ id: string; template_key: string; status: string }>('SELECT id, template_key, status FROM session WHERE id = ?', sessionId);
  if (!s) throw new KairosError('NOT_FOUND', { message: `session ${sessionId}` });
  if (s.status === 'cancelled') return;
  const w = releaseWorker(tx, sessionId, 'removed', now);
  for (const d of tx.all<{ id: string; claim_id: string | null }>(
    `SELECT id, claim_id FROM assignment WHERE session_id = ? AND requirement_key = 'desk' AND state = 'confirmed'`, sessionId)) {
    if (d.claim_id) releaseClaim(tx, d.claim_id);
    tx.run(`UPDATE assignment SET state = 'released', updated_at = ? WHERE id = ?`, now, d.id);
  }
  tx.run(`UPDATE session SET status = 'cancelled', cancel_reason = 'removed', updated_at = ?, version = version + 1 WHERE id = ?`, now, sessionId);
  emitEvent(tx, { name: 'session.cancelled', subject: { type: 'session', id: sessionId }, reason: 'removed', data: { worker: w?.resource_id ?? null } }, now);
}

/**
 * Sick call (§3A.11.2): every owned shift of the person overlapping the range loses its worker. The session stays,
 * keeps its desk lane, and goes to needs_staff; a manager task asks for cover (workflow desk_vacated, §4b.1).
 */
export function vacateForTimeOff(tx: Tx, cfg: ActiveConfig, resourceId: string, start: number, end: number, now: number) {
  const rows = tx.all<{ session_id: string; template_key: string; location_key: string; start_at: number }>(
    `SELECT s.id AS session_id, s.template_key, s.location_key, s.start_at
       FROM assignment a JOIN session s ON s.id = a.session_id
      WHERE a.resource_id = ? AND a.requirement_key = 'worker' AND a.state = 'confirmed' AND s.source = 'platform'
        AND s.status != 'cancelled' AND s.start_at < ? AND s.end_at > ? AND s.end_at > ?`,
    resourceId, end, start, now,
  );
  for (const r of rows) {
    const w = releaseWorker(tx, r.session_id, 'sick', now);
    tx.run(`UPDATE session SET status = 'needs_staff', updated_at = ?, version = version + 1 WHERE id = ?`, now, r.session_id);
    emitEvent(tx, { name: 'assignment.vacated', subject: { type: 'assignment', id: w?.assignment_id ?? r.session_id }, reason: 'sick',
      data: { session_id: r.session_id, requirement_key: 'worker', resource_id: resourceId } }, now);
    const l = toLocal(r.start_at, cfg.zoneOf(r.location_key));
    tx.run(`INSERT INTO task (id, list, location_key, title, detail, subject_type, subject_id, due_at, state, created_by, created_at)
            VALUES (?, 'manager_inbox', ?, 'Desk shift needs cover', ?, 'session', ?, ?, 'open', '{"type":"system","component":"workflow"}', ?)`,
      id('tsk'), r.location_key, `${cfg.template(r.template_key).name} on ${l.date} at ${l.time}`, r.session_id, r.start_at - 2 * 3_600_000, now);
  }
  return rows.map((r) => ({ session_id: r.session_id, template_key: r.template_key, start: r.start_at }));
}
