// The MVP flows on the real Lotus & Line config (§4b.1): desks from config, directory people, the desk roster with
// the person-rule validator, sick calls, mirrored classes with the A.5 guard, and the Gusto export.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import lotusYaml from '../../../fixtures/configs/lotus_line.yaml';
import type { CallContext, DirectoryPerson, MirrorClass, Scope } from '../src/index';
import { fromLocal } from '../src/time';

const NY = 'America/New_York';
const at = (date: string, time: string) => fromLocal(date, time, NY);
const failure = (p: Promise<unknown>) =>
  Promise.resolve(p).then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as Error & { code?: string; reasons?: { code: string; message: string }[] });

const PEOPLE: DirectoryPerson[] = [
  { staff_key: 'sam', name: 'Sam Okafor', email: 'sam@lotusline.example', groups: ['lotus-desk'], studios: ['park_slope'], payroll_ref: 'E-100', payroll_type: 'employee' },
  { staff_key: 'lena', name: 'Lena Novak', email: 'lena@lotusline.example', groups: ['lotus-desk'], studios: ['park_slope'], payroll_ref: 'E-101', payroll_type: 'employee' },
  { staff_key: 'jo', name: 'Jo Ramirez', email: 'jo@lotusline.example', groups: ['lotus-desk'], studios: ['park_slope', 'dumbo'], payroll_ref: 'E-102' },
  { staff_key: 'priya', name: 'Priya Shah', email: 'priya@lotusline.example', groups: ['lotus-desk', 'lotus-teachers'], studios: ['park_slope'], payroll_ref: 'E-103' },
  { staff_key: 'maya', name: 'Maya Ross', email: 'maya@lotusline.example', groups: ['lotus-teachers'] },
];

let n = 0;
async function setup() {
  const scope: Scope = { tenant: `mvp-${n++}`, env: 'preview' };
  const stub = env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`${scope.tenant}:${scope.env}`));
  const c: CallContext = { scope, actor: { type: 'staff', subject: 'nina', roles: ['owner'] }, requestId: 'req' };
  await stub.init(c);
  const d0 = await stub.createDraft(c, { yaml: lotusYaml });
  const d1 = await stub.validateDraft(c, d0.id);
  const d2 = await stub.submitDraft(c, d0.id, d1.version);
  await stub.approveAndPublish(c, d0.id, d2.version, { summary: 'initial' });
  await stub.syncDirectory(c, PEOPLE);
  const people = await stub.listPeople(scope, {});
  const pid = (k: string) => people.find((p) => p.staff_key === k)!.id;
  return { scope, stub, c, pid };
}

describe('MVP: studios, desks and people', () => {
  it('publishing materialises rooms and 2-lane front desks; the directory sets staff roles from the config', async () => {
    const { stub, scope } = await setup();
    await runInDurableObject(stub, (obj) => {
      const desks = obj.db.tx((tx) => tx.all<{ config_key: string; concurrency: number; home_location_key: string }>(
        `SELECT config_key, concurrency, home_location_key FROM resource WHERE type_key = 'front_desk' ORDER BY config_key`));
      expect(desks).toEqual([
        { config_key: 'db_desk', concurrency: 2, home_location_key: 'dumbo' },
        { config_key: 'ps_desk', concurrency: 2, home_location_key: 'park_slope' },
        { config_key: 'wb_desk', concurrency: 2, home_location_key: 'williamsburg' },
      ]);
    });
    const desk = await stub.listPeople(scope, { role: 'desk_staff', location: 'park_slope' });
    expect(desk.map((p) => p.staff_key)).toEqual(['jo', 'lena', 'priya', 'sam']);
    const priya = desk.find((p) => p.staff_key === 'priya')!;
    expect(priya.roles).toEqual(['desk_staff', 'teacher']);
    expect((await stub.listLocations(scope)).map((l) => l.key)).toEqual(['park_slope', 'williamsburg', 'dumbo']);
  });
});

describe('MVP: desk roster (owner mode)', () => {
  it('lists the week of candidate slots from the templates, with coverage gaps until filled', async () => {
    const { stub, scope } = await setup();
    const w = await stub.rosterWeek(scope, 'park_slope', '2027-03-10');
    expect(w.week_start).toBe('2027-03-08');
    const mon = w.slots.filter((s) => s.local.date === '2027-03-08');
    expect(mon.map((s) => `${s.template_key} ${s.local.start}-${s.local.end}`)).toEqual([
      'desk_open 06:15-12:45', 'desk_mid 11:00-15:00', 'desk_close 12:45-21:15', 'desk_mid 16:00-20:00',
    ]);
    expect(w.slots.every((s) => s.state === 'open')).toBe(true);
    expect(w.coverage.some((g) => g.date === '2027-03-08' && g.min === 1 && g.have === 0)).toBe(true);
  });

  it('assigns a worker: claims the person and a desk lane, records hours, and closes the coverage gap', async () => {
    const { stub, scope, c, pid } = await setup();
    const slot = await stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-08', '06:15'), resource_id: pid('sam') });
    expect(slot).toMatchObject({ state: 'filled', worker: { name: 'Sam Okafor' } });
    const w = await stub.rosterWeek(scope, 'park_slope', '2027-03-08');
    expect(w.slots.find((s) => s.slot_key === slot.slot_key)!.state).toBe('filled');
    expect(w.coverage.find((g) => g.date === '2027-03-08' && g.from === '06:30')).toBeUndefined();
    const hours = await stub.listHours(scope, at('2027-03-08', '00:00'), at('2027-03-09', '00:00'));
    expect(hours).toMatchObject([{ name: 'Sam Okafor', kind: 'shift', minutes: 390, state: 'scheduled' }]);
  });

  it('refuses a worker without the desk role, and a second shift that overlaps (RESOURCE_CONFLICT)', async () => {
    const { stub, c, pid } = await setup();
    const maya = await failure(stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-08', '06:15'), resource_id: pid('maya') }));
    expect(maya.code).toBe('ROLE_MISSING');
    await stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-08', '06:15'), resource_id: pid('sam') });
    const twice = await failure(stub.assignShift(c, { template_key: 'desk_mid', location_key: 'park_slope', start: at('2027-03-08', '11:00'), resource_id: pid('sam') }));
    expect(twice.code).toBe('RESOURCE_CONFLICT');
  });

  it('desk_rest: refuses an opening shift less than 10 h after a closing shift (REST_VIOLATION)', async () => {
    const { stub, c, pid } = await setup();
    await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('lena') });
    const e = await failure(stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-09', '06:15'), resource_id: pid('lena') }));
    expect(e.code).toBe('REST_VIOLATION');
    expect(e.message).toMatch(/10 hours/);
  });

  it('desk_week: refuses a shift that takes a desk worker past 40 h in the week (MAX_HOURS)', async () => {
    const { stub, c, pid } = await setup();
    // 5 × 8h30 closing shifts = 42.5h; the 5th is refused
    for (const d of ['2027-03-08', '2027-03-09', '2027-03-10', '2027-03-11']) {
      await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at(d, '12:45'), resource_id: pid('sam') });
    }
    const e = await failure(stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-12', '12:45'), resource_id: pid('sam') }));
    expect(e.code).toBe('MAX_HOURS');
  });

  it('the front desk seats two: the closing and evening mid shifts run side by side on separate lanes (D-45)', async () => {
    const { stub, c, pid } = await setup();
    await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('sam') });
    await stub.assignShift(c, { template_key: 'desk_mid', location_key: 'park_slope', start: at('2027-03-08', '16:00'), resource_id: pid('lena') });
    await runInDurableObject(stub, (obj) => {
      const lanes = obj.db.tx((tx) => tx.all<{ lane: number }>(
        `SELECT DISTINCT o.lane FROM occupancy o JOIN resource r ON r.id = o.resource_id WHERE r.config_key = 'ps_desk' ORDER BY o.lane`));
      expect(lanes).toEqual([{ lane: 0 }, { lane: 1 }]);
    });
  });

  it('sick call: vacates the shift, keeps the slot as vacated, voids the hours and opens a manager task', async () => {
    const { stub, scope, c, pid } = await setup();
    const slot = await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('sam') });
    const r = await stub.recordTimeOff(c, { resource_id: pid('sam'), start: at('2027-03-08', '00:00'), end: at('2027-03-09', '00:00'), reason: 'sick', immediate: true });
    expect(r.vacated).toEqual([{ session_id: slot.session_id, template_key: 'desk_close', start: slot.start }]);
    const w = await stub.rosterWeek(scope, 'park_slope', '2027-03-08');
    expect(w.slots.find((s) => s.slot_key === slot.slot_key)).toMatchObject({ state: 'vacated', worker: null });
    expect(await stub.listHours(scope, at('2027-03-08', '00:00'), at('2027-03-09', '00:00'))).toEqual([]);
    // Lena covers the vacated slot; Sam can't be put back while off sick
    expect((await failure(stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('sam') }))).code).toBe('OUTSIDE_AVAILABILITY');
    await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('lena') });
    await runInDurableObject(stub, (obj) => {
      expect(obj.db.tx((tx) => tx.all<{ title: string }>(`SELECT title FROM task WHERE list = 'manager_inbox'`))).toEqual([{ title: 'Desk shift needs cover' }]);
    });
  });

  it('unassign removes the shift and frees the person and the desk lane', async () => {
    const { stub, scope, c, pid } = await setup();
    const slot = await stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-08', '06:15'), resource_id: pid('sam') });
    await stub.unassignShift(c, slot.session_id!);
    const w = await stub.rosterWeek(scope, 'park_slope', '2027-03-08');
    expect(w.slots.find((s) => s.slot_key === slot.slot_key)!.state).toBe('open');
    await stub.assignShift(c, { template_key: 'desk_open', location_key: 'park_slope', start: at('2027-03-08', '06:15'), resource_id: pid('sam') });
  });
});

describe('MVP: mirrored classes and the A.5 cross-domain guard', () => {
  const hot = (externalId: string, date: string, teacher = 'priya'): MirrorClass => ({
    external_id: externalId, template_key: 'hot_75', location_key: 'park_slope', room_key: 'ps_studio_2',
    start: at(date, '18:00'), end: at(date, '19:15'), status: 'scheduled',
    teacher: { external_id: `bv_t_${teacher}`, email: `${teacher}@lotusline.example`, name: teacher },
  });

  it('a mirrored class maps its teacher by email, then blocks a desk shift over it (RESOURCE_CONFLICT)', async () => {
    const { stub, scope, c, pid } = await setup();
    const r = await stub.mirrorApply(scope, [hot('bv_1', '2027-03-08')]);
    expect(r).toMatchObject({ applied: 1, conflicts: [], unmapped: [] });
    const classes = await stub.listClasses(scope, at('2027-03-08', '00:00'), at('2027-03-09', '00:00'), 'park_slope');
    expect(classes).toMatchObject([{ template_key: 'hot_75', name: 'Hot 75', source: 'mirror', teacher: { name: 'Priya Shah' }, conflicted: false }]);
    const e = await failure(stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('priya') }));
    expect(e.code).toBe('RESOURCE_CONFLICT');
    expect(e.message).toMatch(/teaching Hot 75/);
    // re-applying the same record changes nothing
    expect(await stub.mirrorApply(scope, [hot('bv_1', '2027-03-08')])).toMatchObject({ applied: 0, unchanged: 1 });
  });

  it('a mirrored class over an owned desk shift is stored conflicted and still blocks the time (A.5 other order)', async () => {
    const { stub, scope, c, pid } = await setup();
    await stub.assignShift(c, { template_key: 'desk_close', location_key: 'park_slope', start: at('2027-03-08', '12:45'), resource_id: pid('priya') });
    const r = await stub.mirrorApply(scope, [hot('bv_2', '2027-03-08')]);
    expect(r.conflicts).toEqual([expect.objectContaining({ external_id: 'bv_2', resource: 'priya' })]);
    const [cls] = await stub.listClasses(scope, at('2027-03-08', '00:00'), at('2027-03-09', '00:00'), 'park_slope');
    expect(cls!.conflicted).toBe(true);
  });

  it('an unknown teacher leaves the class needs_mapping', async () => {
    const { stub, scope } = await setup();
    const r = await stub.mirrorApply(scope, [{ ...hot('bv_3', '2027-03-10'), teacher: { external_id: 'bv_t_x', email: 'nobody@x.example', name: 'X' } }]);
    expect(r.unmapped).toEqual([{ external_id: 'bv_3', teacher_external_id: 'bv_t_x', name: 'X' }]);
    const [cls] = await stub.listClasses(scope, at('2027-03-10', '00:00'), at('2027-03-11', '00:00'), null);
    expect(cls).toMatchObject({ status: 'needs_mapping', teacher: null });
  });
});

describe('MVP: hours and the Gusto export (§18.8)', () => {
  it('exports approved hours per person and workweek with overtime past 40 h, as RFC 4180 CRLF CSV', async () => {
    const { stub, scope, c, pid } = await setup();
    // make Sam's past week: 5 closing shifts (42.5h) written directly as worked hours, then approved
    await runInDurableObject(stub, (obj) => {
      obj.db.tx((tx) => {
        const sam = pid('sam');
        ['2027-03-01', '2027-03-02', '2027-03-03', '2027-03-04', '2027-03-05'].forEach((d, i) => {
          tx.run(`INSERT INTO hours_record (id, resource_id, assignment_id, session_id, kind, location_key, start_at, end_at, minutes, state, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'shift', 'park_slope', ?, ?, 510, 'worked', 0, 0)`, `hrs_${i}`, sam, `asg_${i}`, `ses_${i}`, at(d, '12:45'), at(d, '21:15'));
        });
      });
    });
    for (const i of [0, 1, 2, 3, 4]) await stub.approveHours(c, `hrs_${i}`);
    const r = await stub.exportHours(c, '2027-03-01');
    expect(r.filename).toBe(`PREVIEW_${scope.tenant}_preview_2027-03-01_2027-03-14_employees_v1.csv`);
    expect(r.csv).toBe(
      'employee_id,last_name,first_name,workweek,job,regular_hours,overtime_hours,double_overtime_hours,bonus,reimbursement\r\n' +
      'E-100,Okafor,Sam,2027-03-01,Front Desk,40.00,2.50,0.00,,\r\n');
    expect((await failure(stub.exportHours(c, '2027-03-02'))).code).toBe('SCHEMA_INVALID');
  });
});
