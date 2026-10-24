// L2, L3 and L4 rules (§6.3): at least one failing case per code, on small inline documents.
import { describe, expect, it } from 'vitest';
import { validate, type ExprChecker, type ValidateOptions, type ValidationIssue } from '../src/index';
import { edit, loadFixture, minimalDoc } from './helpers';

const only = (doc: unknown, code: string, opts?: ValidateOptions): ValidationIssue[] =>
  validate(doc, opts).issues.filter((i) => i.code === code);
const paths = (doc: unknown, code: string, opts?: ValidateOptions): string[] => only(doc, code, opts).map((i) => i.path).sort();
const mini = (fn: (d: any) => void): unknown => edit(minimalDoc(), fn);

/** flow_60 with mixed capacity over room_1's mats. */
const mixed = (partitions: unknown[]): unknown => mini((d) => {
  d.templates[0].participants.capacity = { mode: 'mixed', base: { mode: 'assigned', requirement: 'room' }, partitions };
  d.templates[0].requirements[0].provides_layout = true;
});

describe('L2 references', () => {
  it('UNKNOWN_REF', () => {
    const doc = mini((d) => {
      d.templates[0].policy = 'nope';
      d.resources[0].layout = 'nope';
      d.timetable[0].fixed.coach = 'room_1';
      d.coverage[0].shift_templates.push('ghost_shift');
      d.access.staff_role_mappings.push({ issuer: 'other', claim: 'g', equals: 'x', role: 'teacher' });
      d.workflows[0].actions.push({ type: 'set_field', entity: 'booking', field: 'mood', value: "'ok'" });
    });
    expect(paths(doc, 'UNKNOWN_REF')).toEqual([
      '/access/staff_role_mappings/0/issuer', '/coverage/0/shift_templates/1', '/resources/0/layout', '/templates/0/policy',
      '/timetable/0/fixed/coach', '/workflows/0/actions/1/field',
    ]);
  });

  it('UNKNOWN_REF for a partition release target', () => {
    const doc = mixed([{ key: 'front', spots: { tags_any: ['front_row'] }, eligible_if: 'true', online: true,
      release: { at: { before_start: '2h' }, to: 'back' } }]);
    expect(paths(doc, 'UNKNOWN_REF')).toEqual(['/templates/0/participants/capacity/partitions/0/release/to']);
  });

  it('DUPLICATE_KEY', () => {
    const doc = mini((d) => {
      d.units.push({ key: 'class_credit', name: 'Again' });
      d.templates[1].requirements.push({ key: 'worker', select: { role: 'desk_staff' }, assign: 'roster' });
    });
    expect(paths(doc, 'DUPLICATE_KEY')).toEqual(['/templates/1/requirements/2/key', '/units/1/key']);
  });

  it('STAFF_REF_MISSING (only when a staff directory is given)', () => {
    const doc = mini((d) => { d.timetable[0].fixed.teacher = '@staff:ghost'; });
    expect(paths(doc, 'STAFF_REF_MISSING', { staff: [{ key: 'amara' }, { key: 'ghost', active: false }] }))
      .toEqual(['/timetable/0/fixed/teacher']);
    expect(paths(doc, 'STAFF_REF_MISSING')).toEqual([]);
  });

  it('CAPACITY_REQUIREMENT_MISSING: missing, not a space, or assigned without provides_layout', () => {
    expect(paths(mini((d) => { d.templates[0].participants.capacity.requirement = 'hall'; }), 'CAPACITY_REQUIREMENT_MISSING'))
      .toEqual(['/templates/0/participants/capacity/requirement']);
    expect(paths(mini((d) => { d.templates[0].participants.capacity.requirement = 'teacher'; }), 'CAPACITY_REQUIREMENT_MISSING'))
      .toEqual(['/templates/0/participants/capacity/requirement']);
    expect(paths(mini((d) => {
      d.templates[0].participants.capacity = { mode: 'assigned', requirement: 'room', auto_assign: true };
    }), 'CAPACITY_REQUIREMENT_MISSING')).toEqual(['/templates/0/participants/capacity/requirement']);
  });

  it('LAYOUT_MISSING', () => {
    const doc = mini((d) => {
      d.resources.push({ key: 'room_2', type: 'studio_room', name: 'Room 2', location: 'main', attributes: { capacity: 10 } });
      d.templates[0].participants.capacity = { mode: 'assigned', requirement: 'room', auto_assign: true };
      d.templates[0].requirements[0].provides_layout = true;
    });
    expect(only(doc, 'LAYOUT_MISSING')).toEqual([expect.objectContaining({ message: expect.stringContaining('room_2') })]);
  });

  it('FIXED_AMBIGUOUS', () => {
    const doc = mini((d) => { d.resources.push({ key: 'desk_2', type: 'front_desk', name: 'Desk 2', location: 'main' }); });
    expect(paths(doc, 'FIXED_AMBIGUOUS')).toEqual(['/templates/1/requirements/1']);
  });

  it('ROLE_NAME_CLASH', () => {
    expect(paths(mini((d) => { d.roles.push({ key: 'manager', name: 'Manager' }); }), 'ROLE_NAME_CLASH')).toEqual(['/roles/2/key']);
  });

  it('FIELD_SHADOWS_BUILTIN', () => {
    const doc = mini((d) => {
      d.custom_fields.push({ key: 'place_refilled', label: 'x', entity: 'booking', type: 'bool', visible_to: [], editable_by: [], pii: false });
      d.custom_fields.push({ key: 'shoe_size', label: 'x', entity: 'customer', type: 'int', visible_to: [], editable_by: [], pii: false });
    });
    expect(paths(doc, 'FIELD_SHADOWS_BUILTIN')).toEqual(['/custom_fields/0/key']);
  });
});

describe('L3 expressions (injected checker)', () => {
  const recorder = (fail: (source: string) => ReturnType<ExprChecker['check']> | null) => {
    const calls: { source: string; slot: string; path: string; result: string }[] = [];
    const checker: ExprChecker = {
      check(source, slot, ctx) {
        calls.push({ source, slot, path: ctx.path, result: ctx.result });
        return fail(source) ?? { ok: true };
      },
    };
    return { calls, checker };
  };

  it('is called for every CEL field with its §5.3 slot', () => {
    const { calls, checker } = recorder(() => null);
    expect(validate(loadFixture('lotus_line.yaml'), { expr: checker }).issues).toEqual([]);
    const slotOf = Object.fromEntries(calls.map((c) => [c.path, `${c.slot}/${c.result}`]));
    expect(slotOf).toMatchObject({
      '/templates/0/participants/capacity/partitions/0/eligible_if': 'booking/bool',
      '/templates/0/requirements/0/select/where': 'candidate/bool',
      '/templates/0/cost/price_rules/0/when': 'booking/bool',
      '/templates/1/intake/when': 'booking/bool',
      '/policies/0/cancellation/late/fee_if': 'booking/bool',
      '/policies/0/cancellation/late/waive_if': 'booking/bool',
      '/policies/0/limits/1/applies_if': 'booking/bool',
      '/policies/0/approval/required_if': 'booking/bool',
      '/workflows/0/trigger/where': 'event/bool',
      '/workflows/0/actions/0/input/deadline': 'event/value',
      '/workflows/2/actions/0/vars/reason': 'event/value',
      '/workflows/4/condition': 'event/bool',
      '/custom_fields/1/required_if': 'booking/bool',
      '/views/0/filter': 'row/bool',
    });
    expect(calls).toHaveLength(36);
  });

  it('reports the checker result, with EXPR_TYPE as the default code and EXPR_NULLABLE as a warning', () => {
    const { checker } = recorder((s) => {
      if (s.includes('history')) return { ok: false, code: 'UNKNOWN_HISTORY_KEY', message: 'no such key' };
      if (s.includes('booking.entitlement.kind')) return { ok: false, code: 'EXPR_NULLABLE', message: 'unguarded' };
      if (s === 'booking.place_refilled') return { ok: false, message: 'bad' };
      return null;
    });
    const issues = validate(loadFixture('lotus_line.yaml'), { expr: checker }).issues;
    expect(issues.every((i) => i.layer === 'L3')).toBe(true);
    expect(issues.find((i) => i.path === '/policies/0/cancellation/late/waive_if')).toMatchObject({ code: 'EXPR_TYPE', severity: 'E' });
    expect(issues.find((i) => i.path === '/policies/0/cancellation/late/fee_if')).toMatchObject({ code: 'EXPR_NULLABLE', severity: 'W' });
    expect(issues.find((i) => i.path === '/templates/1/intake/when')).toMatchObject({ code: 'UNKNOWN_HISTORY_KEY', severity: 'E' });
  });

  it('is skipped without a checker', () => {
    expect(validate(mini((d) => { d.templates[0].eligible_if = '((('; })).issues).toEqual([]);
  });
});

describe('L4 semantic rules', () => {
  it('WINDOW_INVERTED', () => {
    const doc = mini((d) => {
      d.policies[0].booking_window = { opens: { before_start: '0m' }, closes: { before_start: '1h' } };
      d.policies[0].check_in = { opens: { after_start: '10m' }, closes: { before_start: '30m' } };
    });
    expect(paths(doc, 'WINDOW_INVERTED')).toEqual(['/policies/0/booking_window', '/policies/0/check_in']);
  });

  it('CANCEL_AFTER_START', () => {
    expect(paths(mini((d) => { d.policies[0].cancellation.free_until = { after_start: '10m' }; }), 'CANCEL_AFTER_START'))
      .toEqual(['/policies/0/cancellation/free_until']);
    expect(paths(mini((d) => { d.policies[0].cancellation.free_until = { before_end: '30m' }; }), 'CANCEL_AFTER_START'))
      .toEqual(['/policies/0/cancellation/free_until']);   // 60m class: 30m after the start
  });

  it('MIN_ATTENDANCE_GT_CAPACITY', () => {
    const doc = mini((d) => { d.policies[0].min_attendance = { min: 25, check_at: { before_start: '2h' }, action: 'cancel_session' }; });
    expect(paths(doc, 'MIN_ATTENDANCE_GT_CAPACITY')).toEqual(['/policies/0/min_attendance/min']);
    const overridden = mini((d) => {
      d.policies[0].min_attendance = { min: 15, check_at: { before_start: '2h' }, action: 'cancel_session' };
      d.timetable[0].capacity_override = 12;
    });
    expect(paths(overridden, 'MIN_ATTENDANCE_GT_CAPACITY')).toEqual(['/policies/0/min_attendance/min']);
  });

  it('PARTITION_OVERLAP', () => {
    const doc = mixed([
      { key: 'front', spots: { tags_any: ['front_row'] }, eligible_if: 'true', online: true },
      { key: 'first', spots: { keys: ['mat_1'] }, eligible_if: 'true', online: false },
    ]);
    expect(only(doc, 'PARTITION_OVERLAP')).toEqual([expect.objectContaining({
      path: '/templates/0/participants/capacity/partitions/1', message: expect.stringContaining('mats_6.mat_1'),
    })]);
    expect(only(mixed([
      { key: 'front', spots: { tags_any: ['front_row'] }, eligible_if: 'true', online: true },
      { key: 'walk_in', spots: { tags_any: ['walk_in'] }, eligible_if: 'true', online: false },
    ]), 'PARTITION_OVERLAP')).toEqual([]);
  });

  it('PARTITION_EXCEEDS_CAPACITY', () => {
    const doc = mini((d) => {
      d.templates[0].participants.capacity = { mode: 'mixed', base: { mode: 'pooled', places: 10 }, partitions: [
        { key: 'members', count: 6, eligible_if: 'true', online: true },
        { key: 'walk_in', count: 5, eligible_if: 'true', online: false },
      ] };
    });
    expect(paths(doc, 'PARTITION_EXCEEDS_CAPACITY')).toEqual(['/templates/0/participants/capacity/partitions']);
  });

  it('PARTITION_SPOT_MISSING', () => {
    const doc = mixed([{ key: 'back', spots: { keys: ['mat_99'] }, eligible_if: 'true', online: true }]);
    expect(paths(doc, 'PARTITION_SPOT_MISSING')).toEqual(['/templates/0/participants/capacity/partitions/0/spots/keys']);
  });

  it('TIMETABLE_CONFLICT (room buffers included)', () => {
    const doc = mini((d) => {
      d.timetable.push({ key: 'flow_mon_late', template: 'flow_60', location: 'main', rrule: 'FREQ=WEEKLY;BYDAY=MO',
        start_local: '10:10', valid_from: '2027-01-04', fixed: { room: 'room_1' } });
    });
    const issues = only(doc, 'TIMETABLE_CONFLICT');
    expect(issues.length).toBe(4);   // every Monday of the 4-week horizon: 09:00–10:15 vs 10:10–11:25
    expect(issues[0]!.message).toContain('2027-01-04');
    const later = mini((d) => {
      d.timetable.push({ key: 'flow_mon_late', template: 'flow_60', location: 'main', rrule: 'FREQ=WEEKLY;BYDAY=MO',
        start_local: '10:15', valid_from: '2027-01-04', fixed: { room: 'room_1' } });
    });
    expect(only(later, 'TIMETABLE_CONFLICT')).toEqual([]);
  });

  it('TIMETABLE_CONFLICT lists at most 10 collisions', () => {
    const doc = mini((d) => {
      d.tenant.materialize_horizon = '8w';
      d.timetable.push({ ...d.timetable[0], key: 'flow_copy' });
    });
    expect(only(doc, 'TIMETABLE_CONFLICT')).toHaveLength(10);
  });

  it('SERIES_OUTSIDE_HOURS (teacher buffer before the start counts)', () => {
    expect(paths(mini((d) => { d.timetable[0].start_local = '07:00'; }), 'SERIES_OUTSIDE_HOURS')).toEqual(['/timetable/0']);
    expect(paths(mini((d) => { d.timetable[0].start_local = '07:10'; }), 'SERIES_OUTSIDE_HOURS')).toEqual([]);
    expect(paths(mini((d) => { d.timetable[0].start_local = '19:50'; }), 'SERIES_OUTSIDE_HOURS')).toEqual(['/timetable/0']);
  });

  it('SERIES_OUTSIDE_HOURS ignores planned closures, which suppress the occurrence', () => {
    const doc = mini((d) => { d.availability.push({ key: 'holiday', applies_to: { locations: ['main'] }, kind: 'closed', dates: [{ date: '2027-01-06' }] }); });
    expect(only(doc, 'SERIES_OUTSIDE_HOURS')).toEqual([]);
  });

  it('DST_SHIFTED_OCCURRENCE (informational)', () => {
    const doc = mini((d) => {
      d.availability[0].weekly.sun = [['00:00', '24:00']];
      d.timetable[0] = { ...d.timetable[0], rrule: 'FREQ=WEEKLY;BYDAY=SU', start_local: '02:30', valid_from: '2027-03-07' };
    });
    expect(only(doc, 'DST_SHIFTED_OCCURRENCE')).toEqual([expect.objectContaining({
      severity: 'I', path: '/timetable/0/start_local', message: expect.stringContaining('2027-03-14'),
    })]);
  });

  it('UNSATISFIABLE_SELECTOR: no room (E); no current person (W, with a staff directory)', () => {
    const noRoom = mini((d) => { d.templates[0].requirements[0].select.tags_all = ['heated']; });
    expect(only(noRoom, 'UNSATISFIABLE_SELECTOR')).toEqual([expect.objectContaining({ severity: 'E', path: '/templates/0/requirements/0/select' })]);
    const staff = [{ key: 'kim', roles: ['desk_staff'] }];
    expect(only(minimalDoc(), 'UNSATISFIABLE_SELECTOR', { staff })).toEqual([
      expect.objectContaining({ severity: 'W', path: '/templates/0/requirements/1/select' }),
    ]);
    const skill = mini((d) => { d.templates[0].requirements[1].select.skills_all = ['ryt200']; });
    expect(only(skill, 'UNSATISFIABLE_SELECTOR', { staff: [{ key: 'ana', roles: ['teacher'] }, { key: 'kim', roles: ['desk_staff'] }] })).toEqual([]);   // implied by the role
  });

  it('PAYMENT_IMPOSSIBLE', () => {
    const doc = mini((d) => {
      d.units.push({ key: 'hot_credit', name: 'Hot credit' });
      d.templates[0].cost = { payment: 'units_only', units: [{ unit: 'hot_credit', amount: 1 }] };
    });
    expect(paths(doc, 'PAYMENT_IMPOSSIBLE')).toEqual(['/templates/0/cost/units/0/unit']);
  });

  it('COVERAGE_UNCOVERABLE: a gap no candidate covers', () => {
    const doc = mini((d) => { d.coverage[0].pattern[0].to = '20:00'; });
    expect(only(doc, 'COVERAGE_UNCOVERABLE')[0]).toMatchObject({ path: '/coverage/0', message: expect.stringContaining('19:00') });
  });

  it('COVERAGE_UNCOVERABLE is lane-aware: overlapping handovers need 2 desk lanes', () => {
    const oneLane = mini((d) => { d.resources[1].concurrency = 1; });
    expect(only(oneLane, 'COVERAGE_UNCOVERABLE')).toHaveLength(7);   // every day
    expect(only(oneLane, 'COVERAGE_UNCOVERABLE')[0]!.message).toContain('lane');
  });

  it('COVERAGE_UNCOVERABLE: candidates must fit inside desk hours', () => {
    const doc = mini((d) => { d.availability[0].weekly.sat = [['09:00', '21:00']]; });
    expect(only(doc, 'COVERAGE_UNCOVERABLE').map((i) => i.message)).toEqual([expect.stringContaining('on sat')]);
  });

  it('COVERAGE_UNCOVERABLE on the reference tenant with a 1-lane Dumbo desk (D-45)', () => {
    const lotus = edit(loadFixture('lotus_line.yaml'), (d) => { d.resources.find((r) => r.key === 'db_desk')!.concurrency = 1; });
    const issues = only(lotus, 'COVERAGE_UNCOVERABLE');
    expect(issues.map((i) => i.message.split(':')[0])).toEqual(['db_desk_cover on mon', 'db_desk_cover on tue',
      'db_desk_cover on wed', 'db_desk_cover on thu', 'db_desk_cover on fri', 'db_desk_cover on sat']);
  });

  it('HARD_CONTRADICTION', () => {
    const doc = mini((d) => {
      d.constraints.push(
        { key: 'short_day', description: 'x', level: 'hard', applies_to: { roles: ['desk_staff'] }, rule: { type: 'max_hours', window: 'day', hours: 4 } },
        { key: 'busy', description: 'x', level: 'hard', applies_to: { roles: ['teacher'] }, rule: { type: 'min_hours', window: 'week', hours: 30 } },
        { key: 'cap', description: 'x', level: 'hard', applies_to: { roles: ['teacher'] }, rule: { type: 'max_hours', window: 'week', hours: 20 } },
      );
    });
    expect(paths(doc, 'HARD_CONTRADICTION')).toEqual(['/constraints/0', '/constraints/1']);
  });

  it('WAITLIST_SCHEDULE_UNORDERED', () => {
    const doc = mini((d) => {
      d.policies[0].waitlist = { enabled: true, max_size: 5, require_entitlement: false, offer_ttl: '15m', place_choice: 'best',
        schedule: [{ until: { before_start: '15m' }, mode: 'offer_all' }, { until: { before_start: '2h' }, mode: 'auto_promote' }] };
    });
    expect(paths(doc, 'WAITLIST_SCHEDULE_UNORDERED')).toEqual(['/policies/0/waitlist/schedule/1/until']);
  });

  it('UNSTAFFED_NOT_AFTER_DEADLINE', () => {
    const doc = mini((d) => {
      d.workflows.push({ key: 'sub_finder', name: 'Sub', trigger: { event: 'assignment.vacated' }, recheck_at_fire: true,
        actions: [{ type: 'invoke_hook', hook: 'substitute_finder', input: { deadline: "session.start - duration('2h')" } }] });
      d.policies[0].unstaffed.check_at = { before_start: '110m' };
    });
    expect(only(doc, 'UNSTAFFED_NOT_AFTER_DEADLINE')).toEqual([expect.objectContaining({ severity: 'W', path: '/policies/0/unstaffed/check_at' })]);
  });

  it('WORKFLOW_CYCLE', () => {
    const doc = mini((d) => {
      d.workflows.push(
        { key: 'ping', name: 'Ping', trigger: { event: 'custom.ping' }, recheck_at_fire: false, actions: [{ type: 'emit_event', name: 'custom.pong' }] },
        { key: 'pong', name: 'Pong', trigger: { event: 'custom.pong' }, recheck_at_fire: false, actions: [{ type: 'emit_event', name: 'custom.ping' }] },
        { key: 'self', name: 'Self', trigger: { event: 'session.cancelled' }, recheck_at_fire: false, actions: [{ type: 'cancel_session', reason: 'x' }] },
      );
    });
    expect(only(doc, 'WORKFLOW_CYCLE').map((i) => i.message)).toEqual([
      'workflow cycle: ping → pong → ping', 'workflow cycle: self → self',
    ]);
  });

  it('FEE_ABOVE_CEILING', () => {
    const doc = mini((d) => { d.policies[0].cancellation.no_show.fee = { minor: 5001, currency: 'USD' }; });
    expect(paths(doc, 'FEE_ABOVE_CEILING')).toEqual(['/policies/0/cancellation/no_show/fee']);
  });

  it('PAYROLL_HEADER_UNKNOWN, PAYROLL_JOB_COLUMN_MISSING, PAYROLL_OT_BELOW_ROSTER_CAP', () => {
    const doc = mini((d) => {
      d.tenant.payroll_export.columns.employees.first_name = 'First name';
      d.tenant.payroll_export.split_by_kind = true;
      d.tenant.payroll_export.overtime.weekly_hours = 30;
      d.constraints.push({ key: 'week', description: 'x', level: 'hard', applies_to: { roles: ['desk_staff'] }, rule: { type: 'max_hours', window: 'week', hours: 40 } });
    });
    expect(paths(doc, 'PAYROLL_HEADER_UNKNOWN')).toEqual(['/tenant/payroll_export/columns/employees/first_name']);
    expect(paths(doc, 'PAYROLL_JOB_COLUMN_MISSING')).toEqual(['/tenant/payroll_export/split_by_kind']);
    expect(only(doc, 'PAYROLL_OT_BELOW_ROSTER_CAP')).toEqual([expect.objectContaining({ severity: 'W' })]);
    const fixed = edit(doc as any, (d: any) => {
      d.tenant.payroll_export.columns.employees.job = 'job';
      d.tenant.payroll_export.job_names = { shift: 'Desk', teaching: 'Teacher' };
    });
    expect(only(fixed, 'PAYROLL_JOB_COLUMN_MISSING')).toEqual([]);
  });

  it('NOTICE_MISSING', () => {
    const doc = mini((d) => {
      d.workflows[0].trigger.event = d.workflows[0].trigger.event.filter((e: string) => e !== 'tenant.closing');
      d.policies[0].waitlist = { enabled: true, max_size: 5, require_entitlement: false, offer_ttl: '15m', place_choice: 'best',
        schedule: [{ until: { before_start: '1h' }, mode: 'offer_all' }] };
    });
    const missing = only(doc, 'NOTICE_MISSING').map((i) => i.message.replace('no enabled workflow sends a notice on ', ''));
    expect(missing).toEqual(['booking.confirmed', 'waitlist.skipped', 'waitlist.offered', 'tenant.closing']);
    expect(only(doc, 'NOTICE_MISSING').every((i) => i.severity === 'W')).toBe(true);
  });

  it('NOTICE_MISSING: a flagged workflow counts only when its flag is on; drift notices only while a domain is not owned', () => {
    const flagged = mini((d) => { d.workflows[0].flag = 'notices_v2'; });
    expect(only(flagged, 'NOTICE_MISSING').length).toBeGreaterThan(0);
    expect(only(flagged, 'NOTICE_MISSING', { flags: new Set(['notices_v2']) })).toEqual([]);
    const noDrift = mini((d) => { d.workflows[0].trigger.event = d.workflows[0].trigger.event.filter((e: string) => e !== 'sync.drift_detected'); });
    expect(only(noDrift, 'NOTICE_MISSING')).toHaveLength(1);
    const allOwned = { classes: 'owner', bookings: 'owner', members: 'owner', shifts: 'owner' } as const;
    expect(only(noDrift, 'NOTICE_MISSING', { domainModes: allOwned })).toEqual([]);
  });

  it('SCOPE_ALL_MEMBER_RECIPIENT', () => {
    const doc = mini((d) => {
      d.workflows.push({ key: 'remind', name: 'Remind', scope: 'all', trigger: { event: 'booking.confirmed' }, recheck_at_fire: false,
        actions: [{ type: 'notify', channel: 'sms', to: { customer: true }, message: 'hi' }] });
    });
    expect(paths(doc, 'SCOPE_ALL_MEMBER_RECIPIENT')).toEqual(['/workflows/1/actions/0/to']);
    const kairos = edit(doc as any, (d: any) => { d.tenant.member_messaging = 'kairos'; });
    expect(only(kairos, 'SCOPE_ALL_MEMBER_RECIPIENT')).toEqual([]);
  });

  it('MIN_REST_SCOPE_UNKNOWN_TAG', () => {
    const doc = mini((d) => {
      d.constraints.push({ key: 'rest', description: 'x', level: 'hard', applies_to: { roles: ['desk_staff'] },
        rule: { type: 'min_rest', duration: '10h', from: { template_tags: ['closing'] }, to: { template_tags: ['desk'] } } });
    });
    expect(paths(doc, 'MIN_REST_SCOPE_UNKNOWN_TAG')).toEqual(['/constraints/0/rule/from/template_tags/0']);
  });

  it('KIND_MISMATCH', () => {
    expect(only(mini((d) => { d.templates[1].kind = 'class'; }), 'KIND_MISMATCH'))
      .toEqual([expect.objectContaining({ severity: 'W', path: '/templates/1/kind' })]);
  });
});
