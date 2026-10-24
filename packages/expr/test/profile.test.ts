// The Kairos slots (§5.3), the spec's own expressions (§5.7, §4b.1), compile-time limits and
// diagnostics (§5.5, §6.3 L3), and the workerd constraints (§19.12).

import { describe, expect, it } from 'vitest';
import {
  compile,
  evaluate,
  LIMITS,
  SLOT_NAMES,
  SLOTS,
  slotDef,
  typeToString,
  type CompileContext,
  type SlotName,
} from '../src/index';

const NOW = '2026-10-24T14:00:00Z';
const zero = { completed: 0, upcoming: 0, cancelled: 0, late_cancelled: 0, no_show: 0, last_completed_at: null };
const CTX: CompileContext = {
  historyKeys: { tags: ['hot', 'prenatal', 'vinyasa'], templates: ['hot_60', 'vinyasa_60'] },
  bookingFields: { injury_notes: 'long_text', first_timer: 'bool' },
};

const template = { key: 'hot_60', kind: 'class', tags: ['hot'] };
const session = {
  id: 's1',
  template_key: 'hot_60',
  template,
  location_key: 'dumbo',
  start: '2026-10-24T22:00:00Z',
  end: '2026-10-24T23:00:00Z',
  zone: 'America/New_York',
  local_date: '2026-10-24',
  local_start: '18:00',
  weekday: 'sat',
  booked_count: 10,
  capacity_total: 24,
  waitlist_count: 0,
  status: 'scheduled',
  tags: ['hot'],
};
const customer = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tier: 'unlimited',
  strikes: 0,
  state: 'active',
  home_location_key: 'dumbo',
  custom: {},
  history: { total: { ...zero, completed: 4 }, tags: { hot: zero, prenatal: zero, vinyasa: { ...zero, completed: 4 } }, templates: { hot_60: zero, vinyasa_60: zero } },
  ...over,
});
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  state: 'confirmed',
  start: session.start,
  end: session.end,
  duration_minutes: 60,
  booked_via: 'web',
  template,
  payment: { method: 'units' },
  entitlement: { product_key: 'unlimited_monthly', kind: 'membership', tier: 'unlimited' },
  place: null,
  place_refilled: false,
  intake_complete: true,
  injury_notes: null,
  first_timer: true,
  ...over,
});
const bookingAct = (c = {}, b = {}) => ({
  now: NOW,
  customer: customer(c),
  booking: booking(b),
  session,
  template,
  location: { key: 'dumbo', timezone: 'America/New_York' },
  request: { channel: 'web', actor_type: 'member' },
});

function evalIn(slot: SlotName, src: string, act: Record<string, unknown>, ctx: CompileContext = CTX) {
  const c = compile(src, slot, ctx);
  if (!c.ok) throw new Error(`${src}: ${JSON.stringify(c.errors)}`);
  const r = evaluate(c.expr, act);
  return { ...r, warnings: c.warnings };
}

describe('slots (§5.3)', () => {
  it('exports every slot with its variables and result type', () => {
    expect(SLOT_NAMES).toEqual(['booking', 'candidate', 'event', 'event_value', 'row']);
    expect(Object.keys(SLOTS.booking.variables)).toEqual(['now', 'customer', 'booking', 'session', 'template', 'location', 'request']);
    expect(Object.keys(SLOTS.candidate.variables)).toEqual(['now', 'candidate', 'session', 'template']);
    expect(Object.keys(SLOTS.event.variables)).toEqual(['now', 'event', 'session', 'booking', 'customer', 'assignment', 'place', 'roster']);
    expect(Object.keys(SLOTS.row.variables)).toEqual(['now', 'me', 'row']);
    for (const s of SLOT_NAMES) expect(typeToString(SLOTS[s].result)).toBe(s === 'event_value' ? 'dyn' : 'bool');
    expect(typeToString(SLOTS.booking.variables.customer!)).toBe('Customer');
    const cust = SLOTS.booking.variables.customer!;
    expect(cust.k === 'object' && typeToString(cust.fields.tier!)).toBe('string|null');
  });

  it('closes the history maps over the compiled config keys (UNKNOWN_HISTORY_KEY)', () => {
    const bad = compile("customer.history.tags['hott'].completed == 0", 'booking', CTX);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatchObject({ code: 'UNKNOWN_HISTORY_KEY', position: { column: 23 } });
    expect(compile('customer.history.templates.yin_75.upcoming > 0', 'booking', CTX)).toMatchObject({ ok: false, errors: [{ code: 'UNKNOWN_HISTORY_KEY' }] });
    expect(compile("customer.history.tags['hot'].completed == 0", 'booking', CTX).ok).toBe(true);
    expect(compile("customer.history.tags['anything'].completed == 0", 'booking').ok).toBe(true); // open without a config
  });

  it('adds custom booking fields by key', () => {
    expect(evalIn('booking', 'booking.first_timer == true', bookingAct())).toMatchObject({ ok: true, value: true });
    expect(compile('booking.first_timer == true', 'booking')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_TYPE', rule: 'unknown_field' }] });
  });

  it('types rows by view entity', () => {
    expect(compile("row.state == 'confirmed'", 'row', { rowEntity: 'booking' }).ok).toBe(true);
    expect(compile("row.state == 'confirmed'", 'row').ok).toBe(false);
    expect(compile('row.strikes > 2', 'row', { rowEntity: 'customer' }).ok).toBe(true);
    expect(compile("hasSkill(row, 'hot')", 'row', { rowEntity: 'resource' }).ok).toBe(true);
  });

  it('limits event slots to the subjects the event carries', () => {
    expect(compile("assignment.state == 'confirmed'", 'event', { eventSubjects: ['booking'] })).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPR_UNKNOWN_VAR' }],
    });
    expect(slotDef('event', { eventSubjects: ['booking'] }).variables).toHaveProperty('booking');
  });

  it('rejects a non-bool result in a bool slot, and accepts any value in event_value', () => {
    expect(compile('customer.strikes', 'booking')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_TYPE', rule: 'result_type' }] });
    const v = compile("event.name + ':' + event.actor_type", 'event_value');
    expect(v.ok).toBe(true);
    if (v.ok) expect(evaluate(v.expr, { now: NOW, event: { name: 'booking.confirmed', actor_type: 'member' } })).toMatchObject({ ok: true, value: 'booking.confirmed:member' });
  });

  it('checks a dyn result of a bool slot at runtime', () => {
    const c = compile("event.data['waived']", 'event');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(evaluate(c.expr, { event: { data: { waived: true } } })).toMatchObject({ ok: true, value: true });
    expect(evaluate(c.expr, { event: { data: { waived: 'yes' } } })).toMatchObject({ ok: false, error: { code: 'EXPR_ERROR', rule: 'result_type' } });
  });

  it('rejects enum literals outside the declared values', () => {
    expect(compile("booking.payment.method == 'unit'", 'booking')).toMatchObject({ ok: false, errors: [{ rule: 'enum_value' }] });
    expect(compile("request.channel in ['web', 'dsk']", 'booking')).toMatchObject({ ok: false, errors: [{ rule: 'enum_value' }] });
    expect(compile("'mirror' == event.source", 'event').ok).toBe(true);
  });

  it('rejects unknown variables and fields with their position', () => {
    const r = compile("customer.tier == 'unlimited' &&\n  customer.tierr == 'x'", 'booking');
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'EXPR_TYPE', rule: 'unknown_field', position: { line: 2, column: 11, offset: 42 } }] });
    expect(compile('candidate.resource.tags.size() > 0', 'booking')).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPR_UNKNOWN_VAR', position: { line: 1, column: 1 } }],
    });
  });
});

describe('EXPR_NULLABLE (§5.3 Nulls)', () => {
  const warns = (src: string) => {
    const c = compile(src, 'booking', CTX);
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    return c.warnings.map((w) => w.code);
  };
  it('warns about unguarded selection of a nullable field', () => {
    expect(warns("booking.entitlement.kind == 'membership'")).toEqual(['EXPR_NULLABLE']);
    expect(warns("booking.place.attributes['front'] == true")).toEqual(['EXPR_NULLABLE']);
  });
  it('accepts the usual guards', () => {
    expect(warns("booking.entitlement != null && booking.entitlement.kind == 'membership'")).toEqual([]);
    expect(warns("booking.entitlement == null || booking.entitlement.kind == 'membership'")).toEqual([]);
    expect(warns("booking.entitlement != null ? booking.entitlement.kind == 'membership' : false")).toEqual([]);
    expect(warns("booking.entitlement == null ? false : booking.entitlement.kind == 'membership'")).toEqual([]);
    expect(warns("has(booking.entitlement) && booking.entitlement.kind == 'membership'")).toEqual([]);
    expect(warns("!(booking.entitlement == null) && booking.entitlement.tier == 'x'")).toEqual([]);
  });
  it('a guard does not leak to the other branch', () => {
    expect(warns("booking.entitlement != null || booking.entitlement.kind == 'membership'")).toEqual(['EXPR_NULLABLE']);
  });
});

describe('spec expressions (§5.7, §4b.1)', () => {
  const cases: [SlotName, string, Record<string, unknown>, boolean][] = [
    ['booking', "customer.tier == 'unlimited'", bookingAct(), true],
    ['booking', "customer.tier == 'unlimited'", bookingAct({ tier: null }), false],
    ['booking', "customer.tier != 'unlimited'", bookingAct({ tier: null }), true],
    ['booking', 'true', bookingAct(), true],
    ['booking', "booking.entitlement != null && booking.entitlement.kind == 'membership'", bookingAct(), true],
    ['booking', "booking.entitlement != null && booking.entitlement.kind == 'membership'", bookingAct({}, { entitlement: null }), false],
    // §5.3: false, not an error, for a price-paid booking.
    ['booking', "booking.payment.method == 'units' && booking.entitlement.kind == 'membership'", bookingAct({}, { payment: { method: 'price' }, entitlement: null }), false],
    ['booking', 'booking.place_refilled', bookingAct({}, { place_refilled: true }), true],
    ['booking', "customer.history.tags['hot'].completed == 0", bookingAct(), true],
    ['booking', "customer.history.tags['vinyasa'].completed == 0", bookingAct(), false],
    ['booking', 'customer.history.total.completed == 0', bookingAct(), false],
    ['booking', 'customer.strikes >= 3', bookingAct({ strikes: 3 }), true],
    ['booking', "'hot' in booking.template.tags && customer.history.tags['hot'].completed == 0", bookingAct(), true],
    ['booking', "'prenatal' in booking.template.tags", bookingAct(), false],
    ['booking', "hoursUntil(session.start) < 12 && request.channel != 'desk'", bookingAct(), true],
    ['booking', "localDate(session.start, location.timezone) == today(location.timezone)", bookingAct(), true],
    ['booking', "weekday(session.start, session.zone) in ['sat', 'sun']", bookingAct(), true],
    ['booking', 'minutesBetween(booking.start, booking.end) == booking.duration_minutes', bookingAct(), true],
    ['booking', 'customer.history.total.last_completed_at != null && now - customer.history.total.last_completed_at > duration(\'720h\')', bookingAct(), false],
    ['booking', "hasTag(session, 'hot') && hasTag(template, 'hot')", bookingAct(), true],
    ['booking', "customer.custom['waiver_signed'] == true", bookingAct({ custom: { waiver_signed: true } }), true],
  ];
  it.each(cases)('[%s] %s', (slot, src, act, expected) => {
    expect(evalIn(slot, src, act)).toMatchObject({ ok: true, value: expected });
  });

  const resource = { id: 'r1', key: 'studio_a', type: 'studio_room', kind: 'space', tags: ['no_map'], roles: [], skills: [], attributes: { capacity: 24 }, location_keys: ['dumbo'] };
  const candAct = { now: NOW, candidate: { resource, requirement_key: 'room', load: { minutes_day: 0, minutes_week: 0, assignments_day: 0, assignments_week: 0 } }, session, template };
  it('candidate slot', () => {
    expect(evalIn('candidate', "!('no_map' in candidate.resource.tags)", candAct)).toMatchObject({ ok: true, value: false });
    expect(evalIn('candidate', "candidate.resource.attributes['capacity'] >= session.capacity_total", candAct)).toMatchObject({ ok: true, value: true });
    expect(evalIn('candidate', 'candidate.load.minutes_week + minutesBetween(session.start, session.end) <= 40 * 60', candAct)).toMatchObject({
      ok: true,
      value: true,
    });
    expect(evalIn('candidate', "candidate.resource.location_keys.exists(l, l == session.location_key)", candAct)).toMatchObject({ ok: true, value: true });
  });

  const eventAct = (event: Record<string, unknown>, subjects: Record<string, unknown> = {}) => ({
    now: NOW,
    event: { name: 'booking.confirmed', at: NOW, actor_type: 'system', reason: null, domain: 'bookings', source: 'platform', data: {}, ...event },
    ...subjects,
  });
  const assignment = { id: 'a1', requirement_key: 'teacher', resource: null, state: 'vacant', source: 'platform' };
  const evCases: [string, Record<string, unknown>, boolean | { error: string }][] = [
    ["assignment.requirement_key == 'teacher'", eventAct({}, { assignment }), true],
    ["assignment.requirement_key == 'teacher' && event.reason == 'substitute'", eventAct({ reason: 'substitute' }, { assignment }), true],
    ["booking.state == 'confirmed'", eventAct({}, { booking: booking() }), true],
    ["booking.booked_via == 'waitlist'", eventAct({}, { booking: booking() }), false],
    ["event.reason in ['cross_domain_conflict', 'unmapped_person', 'push_failed']", eventAct({ reason: 'push_failed' }), true],
    ["event.reason in ['cross_domain_conflict', 'unmapped_person', 'push_failed']", eventAct({ reason: null }), false],
    ["event.reason == 'payment_failed'", eventAct({ reason: null }), false],
    ["event.name == 'booking.rejected' || event.reason == 'approved'", eventAct({ name: 'booking.rejected' }), true],
    ["!event.data['waived']", eventAct({ data: { waived: false } }), true],
    ["!event.data['waived']", eventAct({ data: {} }), { error: 'no_such_key' }],
    ["event.data['kind'] == 'substitute' && event.reason == 'filled'", eventAct({ reason: 'filled', data: { kind: 'substitute' } }), true],
    ["event.data['state'] == 'pending'", eventAct({ data: { state: 'pending' } }), true],
    ["event.data['first'] == true", eventAct({ data: { first: true } }), true],
    ["event.reason == 'session_cancelled'", eventAct({ reason: 'session_cancelled' }), true],
    // A subject the event does not carry is an evaluation error (fail-safe: action not run, §5.6).
    ["booking.state == 'confirmed'", eventAct({}), { error: 'unbound_variable' }],
  ];
  it.each(evCases)('[event] %s', (src, act, expected) => {
    const r = evalIn('event', src, act);
    if (typeof expected === 'boolean') expect(r).toMatchObject({ ok: true, value: expected });
    else expect(r).toMatchObject({ ok: false, error: { code: 'EXPR_ERROR', rule: expected.error } });
  });

  it('row slot (desk "Today" and "My shifts" views)', () => {
    const row = { ...session, assigned_resource_ids: ['r1'], custom: {} };
    const me = { roles: ['desk'], resource_id: 'r1', customer_id: null, location_keys: ['dumbo'] };
    expect(evalIn('row', 'row.location_key in me.location_keys && row.local_date == today(row.zone)', { now: NOW, me, row })).toMatchObject({ ok: true, value: true });
    expect(evalIn('row', 'me.resource_id in row.assigned_resource_ids && row.start >= now', { now: NOW, me, row })).toMatchObject({ ok: true, value: true });
    expect(evalIn('row', 'me.resource_id in row.assigned_resource_ids', { now: NOW, me: { ...me, resource_id: null }, row })).toMatchObject({ ok: true, value: false });
  });
});

describe('compile-time limits (§5.5)', () => {
  it('source length 2,000', () => {
    const at = `'${'a'.repeat(1984)}' == event.name`;
    expect(at.length).toBe(LIMITS.sourceLength);
    expect(compile(at, 'event').ok).toBe(true);
    expect(compile(`'${'a'.repeat(2000)}' == event.name`, 'event')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_COST', rule: 'source_length' }] });
  });
  it('300 AST nodes', () => {
    const list = (n: number) => `size([${Array.from({ length: n }, () => '1').join(', ')}]) > 0`;
    expect(compile(list(296), 'event').ok).toBe(true); // 296 + list + size + lit + > = 300
    expect(compile(list(297), 'event')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_COST', rule: 'max_nodes' }] });
  });
  it('nesting depth 12', () => {
    const sum = (n: number) => `${Array.from({ length: n }, () => '1').join(' + ')} > 0`;
    expect(compile(sum(11), 'event').ok).toBe(true); // 10 '+' + lit + '>' = depth 12
    expect(compile(sum(12), 'event')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_COST', rule: 'max_depth' }] });
    // A chain of && / || is one n-ary node, so long conjunctions stay shallow.
    expect(compile(Array.from({ length: 40 }, (_, i) => `event.name != '${i}'`).join(' && '), 'event').ok).toBe(true);
  });
  it('static cost 5,000', () => {
    const ok = compile("session.tags.all(t, t in template.tags) && session.tags.exists(t, t.startsWith('h'))", 'booking');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.expr.cost).toBeLessThanOrEqual(LIMITS.staticCost);
    expect(compile('session.tags.all(a, template.tags.all(b, a != b))', 'booking')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_COST', rule: 'static_cost' }] });
  });
  it('deep parenthesis nesting fails safely', () => {
    expect(compile(`${'('.repeat(500)}true${')'.repeat(500)}`, 'event')).toMatchObject({ ok: false, errors: [{ code: 'EXPR_COST', rule: 'max_depth' }] });
  });
});

describe('runtime', () => {
  it('reports steps and the wall-clock guard as metrics only', () => {
    const c = compile("session.tags.exists(t, t == 'hot')", 'booking');
    if (!c.ok) throw new Error('compile');
    let slow = -1;
    let t = 0;
    const r = evaluate(c.expr, bookingAct(), { clock: () => (t += 5), onSlow: (ms) => (slow = ms) });
    expect(r).toMatchObject({ ok: true, value: true });
    expect(r.steps).toBeGreaterThan(0);
    expect(slow).toBe(5);
  });
  it('reports runtime error positions', () => {
    const c = compile("event.name == 'x' ||\n  1 / event.data['n'] > 0", 'event');
    if (!c.ok) throw new Error('compile');
    const r = evaluate(c.expr, { event: { name: 'y', data: { n: 0 } } });
    expect(r).toMatchObject({ ok: false, error: { code: 'EXPR_ERROR', rule: 'division_by_zero', position: { line: 2, column: 5 } } });
  });
  it('a compiled expression is reusable and deterministic', () => {
    const c = compile('customer.strikes >= 3', 'booking');
    if (!c.ok) throw new Error('compile');
    expect(evaluate(c.expr, bookingAct({ strikes: 3 }))).toMatchObject({ ok: true, value: true });
    expect(evaluate(c.expr, bookingAct({ strikes: 1 }))).toMatchObject({ ok: true, value: false });
    const again = compile('customer.strikes >= 3', 'booking');
    if (!again.ok) throw new Error('compile');
    expect(again.expr.cost).toBe(c.expr.cost);
    expect(again.expr.nodes).toBe(c.expr.nodes);
  });
  it('rejects hand-made expressions', () => {
    expect(() => evaluate({} as never, {})).toThrow(TypeError);
  });
});

describe('workerd (§19.12, A-13)', () => {
  it('runs inside workerd', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
  it('the package source never generates code', () => {
    const sources = import.meta.glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/new\s+Function\s*\(|\beval\s*\(|\bFunction\s*\(/);
    }
  });
});
