// L4: semantic rules (§6.3) that need no CEL evaluation. Timetable, coverage and workflow rules are in their own files.
import { durationMinutes, type ConfigDocument, type Offset } from '../schema';
import { Issues } from '../report';
import { checkCoverage } from './coverage';
import type { StaffRecord } from './l2';
import {
  activeSpots, buildModel, candidateRooms, generateSpots, isStaffRef, matchingResources, offsetRange, policyDurations,
  roomCapacity, selectorKind, STAFF_PREFIX, templateTags, type Model,
} from './model';
import { checkWorkflows, type NoticeOptions } from './notices';
import { checkTimetable, type TimetableOptions } from './timetable';

export interface L4Options extends NoticeOptions, TimetableOptions { staff?: readonly StaffRecord[] }

const SUB_FINDER_DEADLINE = /^\s*session\.start\s*-\s*duration\(\s*['"]([0-9hms]+)['"]\s*\)\s*$/;
const UNSTAFFED_MARGIN = 15;

export function checkSemantics(doc: ConfigDocument, opts: L4Options, out: Issues, m: Model = buildModel(doc)): void {
  checkPolicies(m, out);
  checkCapacities(m, out);
  checkSelectors(m, opts.staff, out);
  checkPayment(m, out);
  checkConstraints(m, out);
  checkPayroll(doc, out);
  doc.templates.forEach((t, i) => {
    const who = t.participants.who;
    if ((t.kind === 'shift' && who === 'customers') || (t.kind === 'class' && who === 'none')) {
      out.warn('KIND_MISMATCH', ['templates', i, 'kind'], `kind: ${t.kind} with participants.who: ${who}`);
    }
  });
  checkTimetable(m, opts, out);
  checkCoverage(m, out);
  checkWorkflows(doc, opts, out);
}

/** WINDOW_INVERTED, CANCEL_AFTER_START, WAITLIST_SCHEDULE_UNORDERED, UNSTAFFED_NOT_AFTER_DEADLINE, FEE_ABOVE_CEILING. */
function checkPolicies(m: Model, out: Issues): void {
  const doc = m.doc;
  const ceiling = doc.tenant.fee_ceiling;
  const deadlines = doc.workflows.flatMap((w) => w.actions.flatMap((a) => {
    if (a.type !== 'invoke_hook' || a.hook !== 'substitute_finder') return [];
    const hit = SUB_FINDER_DEADLINE.exec(a.input.deadline ?? '');
    return hit ? [{ workflow: w.key, at: -durationMinutes(hit[1]!) }] : [];
  }));

  doc.policies.forEach((p, i) => {
    const at = (...x: PropertyKey[]): PropertyKey[] => ['policies', i, ...x];
    // Offsets relative to the end need a session length; check against every template using the policy. An unused
    // policy is checked with length 0, which is exact for start-relative offsets.
    const lengths = policyDurations(m, p.key);
    const each = (fn: (len: number) => boolean): boolean => (lengths.length === 0 ? [0] : lengths).some(fn);
    const r = (o: Offset, len: number): [number, number] => offsetRange(o, len);

    const inverted = (opens: Offset, closes: Offset): boolean => each((len) => r(opens, len)[0] >= r(closes, len)[1]);
    if (inverted(p.booking_window.opens, p.booking_window.closes)) {
      out.error('WINDOW_INVERTED', at('booking_window'), 'booking_window.opens is not before closes');
    }
    if (p.check_in !== undefined && inverted(p.check_in.opens, p.check_in.closes)) {
      out.error('WINDOW_INVERTED', at('check_in'), 'check_in.opens is not before closes');
    }
    if (each((len) => r(p.cancellation.free_until, len)[0] > 0)) {
      out.error('CANCEL_AFTER_START', at('cancellation', 'free_until'), 'free_until is after the session start');
    }
    const schedule = p.waitlist?.schedule ?? [];
    for (let j = 1; j < schedule.length; j++) {
      if (each((len) => r(schedule[j - 1]!.until, len)[0] >= r(schedule[j]!.until, len)[1])) {
        out.error('WAITLIST_SCHEDULE_UNORDERED', at('waitlist', 'schedule', j, 'until'),
          'waitlist schedule offsets must be strictly decreasing');
      }
    }
    for (const d of deadlines) {
      if (each((len) => r(p.unstaffed.check_at, len)[0] < d.at + UNSTAFFED_MARGIN)) {
        out.warn('UNSTAFFED_NOT_AFTER_DEADLINE', at('unstaffed', 'check_at'), `unstaffed.check_at must be at least `
          + `${UNSTAFFED_MARGIN}m after the ${d.workflow} deadline (${-d.at}m before start)`);
      }
    }
    for (const which of ['late', 'no_show'] as const) {
      const fee = p.cancellation[which].fee;
      if (fee !== undefined && fee.currency === ceiling.currency && fee.minor > ceiling.minor) {
        out.error('FEE_ABOVE_CEILING', at('cancellation', which, 'fee'), `fee ${fee.minor} is above the ceiling ${ceiling.minor}`);
      }
    }
  });
}

/** MIN_ATTENDANCE_GT_CAPACITY, PARTITION_OVERLAP, PARTITION_EXCEEDS_CAPACITY, PARTITION_SPOT_MISSING. */
function checkCapacities(m: Model, out: Issues): void {
  const doc = m.doc;
  const smallest = new Map<string, number>();   // policy → smallest session capacity
  doc.templates.forEach((t, i) => {
    if (t.participants.who !== 'customers') return;
    const c = t.participants.capacity;
    const base = c.mode === 'mixed' ? c.base : c;
    const q = 'requirement' in base ? t.requirements.find((x) => x.key === base.requirement) : undefined;

    // Session capacities: one per series (its fixed room, or the override), else one per candidate room.
    const caps: number[] = [];
    const series = doc.timetable.filter((s) => s.template === t.key);
    for (const s of series) {
      const room = q === undefined ? undefined : m.resources.get([s.fixed[q.key] ?? []].flat()[0] ?? '');
      const n = s.capacity_override ?? roomCapacity(m, t, room);
      if (n !== null) caps.push(n);
    }
    if (series.length === 0) {
      for (const room of q === undefined ? [undefined] : candidateRooms(m, t, q)) {
        const n = roomCapacity(m, t, room);
        if (n !== null) caps.push(n);
      }
    }
    if (t.policy !== undefined && caps.length > 0) {
      smallest.set(t.policy, Math.min(smallest.get(t.policy) ?? Infinity, ...caps));
    }

    if (c.mode !== 'mixed') return;
    const pp: PropertyKey[] = ['templates', i, 'participants', 'capacity', 'partitions'];
    if (c.base.mode === 'pooled') {
      const total = c.partitions.reduce((n, p) => n + (p.count ?? 0), 0);
      if (total > c.base.places) {
        out.error('PARTITION_EXCEEDS_CAPACITY', pp, `partition counts (${total}) exceed ${c.base.places} places`);
      }
      return;
    }
    if (q === undefined) return;
    for (const room of candidateRooms(m, t, q)) {
      const layout = room.layout === undefined ? undefined : m.layouts.get(room.layout);
      if (layout === undefined) continue;
      const all = new Set(generateSpots(layout).map((s) => s.key));
      const live = activeSpots(layout);
      const owner = new Map<string, string>();
      const overlaps = new Set<string>();
      c.partitions.forEach((p, j) => {
        for (const k of p.spots?.keys ?? []) {
          if (!all.has(k)) {
            out.error('PARTITION_SPOT_MISSING', [...pp, j, 'spots', 'keys'], `spot "${k}" is not in layout ${layout.key} (room ${room.key})`);
          }
        }
        for (const s of live) {
          const inP = (p.spots?.keys?.includes(s.key) ?? false) || (p.spots?.tags_any?.some((t) => s.tags.includes(t)) ?? false);
          if (!inP) continue;
          const prev = owner.get(s.key);
          if (prev !== undefined && prev !== p.key && !overlaps.has(`${prev}|${p.key}`)) {
            overlaps.add(`${prev}|${p.key}`);
            out.error('PARTITION_OVERLAP', [...pp, j], `${layout.key}.${s.key} is in both "${prev}" and "${p.key}"`);
          }
          owner.set(s.key, p.key);
        }
      });
    }
  });
  doc.policies.forEach((p, i) => {
    const min = p.min_attendance?.min;
    const cap = smallest.get(p.key);
    if (min !== undefined && cap !== undefined && min > cap) {
      out.error('MIN_ATTENDANCE_GT_CAPACITY', ['policies', i, 'min_attendance', 'min'],
        `min_attendance.min (${min}) is above the smallest session capacity using the policy (${cap})`);
    }
  });
}

/** UNSATISFIABLE_SELECTOR: no room matches (E); with a staff directory, no current person matches (W). */
function checkSelectors(m: Model, staff: readonly StaffRecord[] | undefined, out: Issues): void {
  const implied = new Map(m.doc.roles.map((r) => [r.key, r.implies_skills ?? []]));
  m.doc.templates.forEach((t, i) => t.requirements.forEach((q, j) => {
    const path = ['templates', i, 'requirements', j, 'select'];
    if (selectorKind(m, q) !== 'person') {
      if (matchingResources(m, q).length === 0) out.error('UNSATISFIABLE_SELECTOR', path, `no resource matches "${q.key}"`);
      return;
    }
    if (staff === undefined) return;
    const s = q.select;
    const hit = staff.some((p) => {
      if (p.active === false) return false;
      const roles = p.roles ?? [];
      const skills = new Set([...(p.skills ?? []), ...roles.flatMap((r) => implied.get(r) ?? [])]);
      if (s.role !== undefined && !roles.includes(s.role)) return false;
      if (s.skills_all !== undefined && !s.skills_all.every((k) => skills.has(k))) return false;
      if (s.resources !== undefined && !s.resources.filter(isStaffRef).includes(`${STAFF_PREFIX}${p.key}`)) return false;
      return true;
    });
    if (!hit) out.warn('UNSATISFIABLE_SELECTOR', path, `no current person matches "${q.key}"`);
  }));
}

/** PAYMENT_IMPOSSIBLE. `covers` is CEL, so a product that grants the unit is assumed to cover the template. */
function checkPayment(m: Model, out: Issues): void {
  m.doc.templates.forEach((t, i) => {
    if (t.cost?.payment !== 'units_only') return;
    const units = t.cost.units ?? [];
    if (units.length === 0) out.error('PAYMENT_IMPOSSIBLE', ['templates', i, 'cost'], 'units_only, but no units are priced');
    units.forEach((u, j) => {
      if (!m.doc.entitlement_products.some((e) => e.grants.some((g) => g.unit === u.unit))) {
        out.error('PAYMENT_IMPOSSIBLE', ['templates', i, 'cost', 'units', j, 'unit'], `no product grants "${u.unit}"`);
      }
    });
  });
}

/** HARD_CONTRADICTION and MIN_REST_SCOPE_UNKNOWN_TAG. */
function checkConstraints(m: Model, out: Issues): void {
  const doc = m.doc;
  const tags = templateTags(m);
  const shortestFor = (roles: readonly string[] | undefined): number => {
    const ms = doc.templates
      .filter((t) => t.requirements.some((q) => q.assign === 'roster' && q.select.role !== undefined
        && (roles === undefined || roles.includes(q.select.role))))
      .map((t) => durationMinutes(t.duration));
    return ms.length === 0 ? Infinity : Math.min(...ms);
  };
  const overlap = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
    a === undefined || b === undefined || a.some((x) => b.includes(x));

  doc.constraints.forEach((c, i) => {
    const r = c.rule;
    if (r.type === 'min_rest') {
      for (const side of ['from', 'to'] as const) {
        r[side]?.template_tags?.forEach((t, j) => {
          if (!tags.has(t)) out.error('MIN_REST_SCOPE_UNKNOWN_TAG', ['constraints', i, 'rule', side, 'template_tags', j], `no template has tag "${t}"`);
        });
      }
    }
    if (c.level !== 'hard') return;
    if (r.type === 'max_hours' && r.window === 'day' && r.hours * 60 < shortestFor(c.applies_to.roles)) {
      out.error('HARD_CONTRADICTION', ['constraints', i], `${c.key}: max ${r.hours}h a day is shorter than the shortest rostered session`);
    }
    if (r.type === 'min_hours') {
      doc.constraints.forEach((d) => {
        const x = d.rule;
        if (d.level === 'hard' && x.type === 'max_hours' && x.window !== 'day' && x.hours < r.hours
          && overlap(c.applies_to.roles, d.applies_to.roles)) {
          out.error('HARD_CONTRADICTION', ['constraints', i], `${c.key}: min ${r.hours}h a week but ${d.key} allows at most ${x.hours}h`);
        }
      });
    }
  });
}

/** PAYROLL_HEADER_UNKNOWN, PAYROLL_JOB_COLUMN_MISSING, PAYROLL_OT_BELOW_ROSTER_CAP (§18.8.3). */
function checkPayroll(doc: ConfigDocument, out: Issues): void {
  const p = doc.tenant.payroll_export;
  const base = ['tenant', 'payroll_export'];
  for (const sheet of ['employees', 'contractors'] as const) {
    const headers = new Set(p.template_headers[sheet]);
    for (const [field, header] of Object.entries(p.columns[sheet])) {
      if (header !== undefined && !headers.has(header)) {
        out.error('PAYROLL_HEADER_UNKNOWN', [...base, 'columns', sheet, field], `"${header}" is not in template_headers.${sheet}`);
      }
    }
  }
  if (p.split_by_kind && (p.columns.employees.job === undefined || p.job_names === undefined)) {
    out.error('PAYROLL_JOB_COLUMN_MISSING', [...base, 'split_by_kind'], 'split_by_kind needs columns.employees.job and job_names');
  }
  const caps = doc.constraints.flatMap((c) => (c.level === 'hard' && c.rule.type === 'max_hours' && c.rule.window === 'week' ? [c.rule.hours] : []));
  const weekly = p.overtime.weekly_hours;
  if (weekly !== null && caps.length > 0 && weekly < Math.max(...caps)) {
    out.warn('PAYROLL_OT_BELOW_ROSTER_CAP', [...base, 'overtime', 'weekly_hours'],
      `overtime starts at ${weekly}h but rosters may reach ${Math.max(...caps)}h a week`);
  }
}
