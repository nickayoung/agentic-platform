import { readFileSync } from 'node:fs';
import { parseConfigYaml, type ConfigDocument, type ValidationReport } from '../src/index';

export const fixturePath = (name: string): URL => new URL(`../../../fixtures/configs/${name}`, import.meta.url);
export const specPath = new URL('../../../docs/spec/04b-example-configs.md', import.meta.url);

export function loadFixture(name: string): ConfigDocument {
  const r = parseConfigYaml(readFileSync(fixturePath(name), 'utf8'));
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.issues)}`);
  return r.document;
}

export const codes = (r: ValidationReport): string[] => [...new Set(r.issues.map((i) => i.code))].sort();
export const errors = (r: ValidationReport): ValidationReport['issues'] => r.issues.filter((i) => i.severity === 'E');

/** A small, complete document with no issues: one studio, one class, one desk shift with 2-lane coverage. */
export function minimalDoc(): ConfigDocument {
  return {
    schema_version: '2.1',
    tenant: {
      name: 'Mini Yoga', default_timezone: 'America/New_York', currency: 'USD', locale: 'en-US', week_starts: 'mon',
      hold_ttl: '5m', materialize_horizon: '4w', customer_label: 'member', fee_ceiling: { minor: 5000, currency: 'USD' },
      closure_pay_notice: '2h', closing_notice: '14d', refund_credit_product: 'refund_credit',
      payroll_export: {
        format: 'gusto_csv', pay_period: { frequency: 'weekly', anchor: '2027-01-04' },
        template_headers: { employees: ['employee_id', 'regular_hours', 'job'], contractors: ['contractor_id', 'hours'] },
        columns: { employees: { payroll_ref: 'employee_id', regular_hours: 'regular_hours' }, contractors: { payroll_ref: 'contractor_id', hours: 'hours' } },
        overtime: { weekly_hours: 40, daily_hours: null, daily_double_hours: null },
        split_by_kind: false,
      },
      environment_guards: { preview_outbound: 'sandbox' },
    },
    locations: [{ key: 'main', name: 'Main', timezone: 'America/New_York' }],
    units: [{ key: 'class_credit', name: 'Class credit' }],
    skills: [{ key: 'ryt200', name: 'RYT-200', expires: false }],
    roles: [{ key: 'teacher', name: 'Teacher', implies_skills: ['ryt200'] }, { key: 'desk_staff', name: 'Desk' }],
    tiers: [{ key: 'member', name: 'Member', rank: 1 }],
    resource_types: [
      { key: 'staff', name: 'Staff', kind: 'person', attributes: [] },
      { key: 'studio_room', name: 'Room', kind: 'space', attributes: [{ key: 'capacity', type: 'int', required: true }] },
      { key: 'front_desk', name: 'Desk', kind: 'space', attributes: [], default_concurrency: 2 },
      { key: 'mat', name: 'Mat', kind: 'spot', attributes: [] },
    ],
    resources: [
      { key: 'room_1', type: 'studio_room', name: 'Room 1', location: 'main', attributes: { capacity: 20 }, layout: 'mats_6' },
      { key: 'desk_1', type: 'front_desk', name: 'Desk', location: 'main' },
    ],
    layouts: [{
      key: 'mats_6', spot_type: 'mat', grid: { rows: 2, cols: 3 },
      generate: { prefix: 'mat_', label: 'Mat {n}', count: 6, per_row: 3 },
      overrides: [{ match: { rows: [1] }, tags: ['front_row'] }, { match: { keys: ['mat_6'] }, tags: ['walk_in'] }],
    }],
    templates: [
      {
        key: 'flow_60', name: 'Flow 60', kind: 'class', tags: ['class'], duration: '60m', scheduling: { mode: 'timetable' },
        participants: { who: 'customers', capacity: { mode: 'pooled_from_space', requirement: 'room' } },
        requirements: [
          { key: 'room', select: { type: 'studio_room' }, assign: 'fixed', buffers: { after: '15m' } },
          { key: 'teacher', select: { role: 'teacher' }, assign: 'roster', buffers: { before: '10m', after: '10m' } },
        ],
        cost: { payment: 'units_or_price', units: [{ unit: 'class_credit', amount: 1 }], price: { minor: 2500, currency: 'USD' } },
        policy: 'simple',
      },
      {
        key: 'desk_shift', name: 'Desk', kind: 'shift', tags: ['desk'], duration: '6h',
        scheduling: { mode: 'rostered', starts: [{ at: '08:00' }, { at: '13:00' }] },
        participants: { who: 'none' },
        requirements: [
          { key: 'worker', select: { role: 'desk_staff' }, assign: 'roster' },
          { key: 'desk', select: { type: 'front_desk' }, assign: 'fixed', occupancy: 'lane' },
        ],
      },
    ],
    timetable: [{
      key: 'flow_mwf', template: 'flow_60', location: 'main', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', start_local: '09:00',
      valid_from: '2027-01-04', fixed: { room: 'room_1' },
    }],
    policies: [{
      key: 'simple', name: 'Simple',
      booking_window: { opens: { before_start: '7d' }, closes: { before_start: '0m' } },
      cancellation: {
        customer_can_cancel: true, free_until: { before_start: '6h' },
        late: { forfeit_units: true, assess_at: 'immediately' },
        no_show: { forfeit_units: true, assess_at: 'session_end', grace: '10m' },
      },
      refund: { timely: 'full', studio_cancel: 'full' },
      limits: [],
      unstaffed: { check_at: { before_start: '1h' }, action: 'notify_staff' },
      customer_overlap: 'forbid', retroactive: 'lenient_only',
    }],
    entitlement_products: [
      { key: 'pack_5', name: '5 classes', kind: 'pack', tier: 'member', grants: [{ unit: 'class_credit', amount: 5 }],
        validity: { length: '12w', anchor: 'purchase', recurring: false }, priority: 1, sold_by: 'platform' },
      { key: 'refund_credit', name: 'Refund credit', kind: 'pack', grants: [{ unit: 'class_credit', amount: 1 }],
        validity: { length: '90d', anchor: 'purchase', recurring: false }, priority: 2, sold_by: 'platform' },
    ],
    availability: [{
      key: 'hours', applies_to: { locations: ['main'] }, kind: 'open',
      weekly: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['07:00', '21:00']]])),
    }],
    constraints: [],
    coverage: [{
      key: 'desk_cover', location: 'main', role: 'desk_staff', shift_templates: ['desk_shift'],
      pattern: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '08:00', to: '19:00', min: 1 }],
      level: 'hard',
    }],
    workflows: [{
      key: 'notices', name: 'All required notices',
      trigger: { event: ['booking.cancelled', 'booking.reseated', 'session.cancelled', 'session.retimed', 'session.room_changed',
        'assignment.vacated', 'offer.sent', 'timeoff.submitted', 'proposal.created', 'proposal.urgent', 'tenant.closing',
        'sync.drift_detected'] },
      recheck_at_fire: false,
      actions: [{ type: 'notify', channel: 'email', to: { event_people: true }, message: 'notice' }],
    }],
    custom_fields: [], forms: [], views: [], simulation: [],
    access: {
      issuers: [{ key: 'staff_auth', audience: 'staff', issuer: 'https://id.example.com', jwks_url: 'https://id.example.com/jwks',
        subject_claim: 'sub', tenant_claim: 'tid' }],
      role_mappings: [], staff_role_mappings: [], default_member_role: 'member',
    },
  } as ConfigDocument;
}

/** A copy of `doc` changed by `fn`. */
export function edit<T>(doc: T, fn: (d: T) => void): T {
  const d = structuredClone(doc);
  fn(d);
  return d;
}
