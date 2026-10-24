// MVP endpoints (docs/mvp-api.md): people, the desk roster, time off, mirrored classes, hours and the Gusto export.
// Managers act only on the studios in their token's location claim (§13.2).
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { KairosError } from '@kairos/errors';
import { requireRole, type Principal } from '../auth';
import { callCtx, coreStub, syncStub, type AppEnv } from '../context';
import { errors, TenantParams } from '../schemas';

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } });

const staff = (p: Principal) => requireRole(p, 'owner', 'admin', 'manager', 'desk', 'instructor', 'staff');
const deskReaders = (p: Principal) => requireRole(p, 'owner', 'admin', 'manager', 'desk');
const managers = (p: Principal) => requireRole(p, 'owner', 'admin', 'manager');
const admins = (p: Principal) => requireRole(p, 'owner', 'admin');
/** Owners and admins see every studio; a manager only the studios in their location claim. */
const studio = (p: Principal, location: string) => {
  if (p.roles.includes('owner') || p.roles.includes('admin') || p.locations === null) return;
  if (!p.locations.includes(location)) throw new KairosError('FORBIDDEN', { message: `you don't manage ${location}` });
};

const Person = z.object({
  id: z.string(), staff_key: z.string(), name: z.string(), email: z.string().nullable(), roles: z.array(z.string()),
  location_keys: z.array(z.string()), state: z.string(),
}).openapi('Person');
const Slot = z.object({
  slot_key: z.string(), template_key: z.string(), template_name: z.string(), location_key: z.string(),
  start: z.number(), end: z.number(), local: z.object({ date: z.string(), start: z.string(), end: z.string() }),
  state: z.enum(['open', 'filled', 'vacated']), session_id: z.string().nullable(),
  worker: z.object({ resource_id: z.string(), name: z.string() }).nullable(),
}).openapi('ShiftSlot');
const Gap = z.object({ date: z.string(), from: z.string(), to: z.string(), min: z.number(), have: z.number() }).openapi('CoverageGap');
const ClassRow = z.object({
  id: z.string(), template_key: z.string(), name: z.string(), location_key: z.string(), start: z.number(), end: z.number(),
  status: z.string(), source: z.string(), teacher: z.object({ resource_id: z.string(), name: z.string() }).nullable(), conflicted: z.boolean(),
}).openapi('ClassSession');
const Hours = z.object({
  id: z.string(), resource_id: z.string(), name: z.string(), kind: z.enum(['shift', 'teaching']), location_key: z.string(),
  start: z.number(), end: z.number(), minutes: z.number(), state: z.string(),
}).openapi('HoursRecord');
const Range = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function mvpRoutes(app: OpenAPIHono<AppEnv>): void {
  const base = '/v1/t/{tenant_slug}/{env}';

  app.openapi(createRoute({ method: 'get', path: `${base}/me`, request: { params: TenantParams },
    responses: { 200: json(z.object({ subject: z.string(), kind: z.string(), roles: z.array(z.string()), locations: z.array(z.string()).nullable(), resource: Person.nullable() }), 'Who you are'), ...errors } }),
  async (c) => {
    const p = c.get('principal');
    const resource = p.kind === 'staff' ? await coreStub(c.env, c.get('scope')).me(c.get('scope'), p.subject) : null;
    return c.json({ subject: p.subject, kind: p.kind, roles: p.roles, locations: p.locations, resource }, 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/locations`, request: { params: TenantParams },
    responses: { 200: json(z.object({ items: z.array(z.object({ key: z.string(), name: z.string(), timezone: z.string() })) }), 'Studios'), ...errors } }),
  async (c) => {
    staff(c.get('principal'));
    return c.json({ items: await coreStub(c.env, c.get('scope')).listLocations(c.get('scope')) }, 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/people`,
    request: { params: TenantParams, query: z.object({ role: z.string().optional(), location: z.string().optional() }) },
    responses: { 200: json(z.object({ items: z.array(Person) }), 'People'), ...errors } }),
  async (c) => {
    deskReaders(c.get('principal'));
    return c.json({ items: await coreStub(c.env, c.get('scope')).listPeople(c.get('scope'), c.req.valid('query')) }, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/directory/sync`,
    request: { params: TenantParams, body: body(z.object({ people: z.array(z.object({
      staff_key: z.string().min(1), name: z.string().min(1), email: z.string().email(), groups: z.array(z.string()),
      studios: z.array(z.string()).optional(), payroll_ref: z.string().optional(), payroll_type: z.enum(['employee', 'contractor']).optional(),
    })).max(500) })) },
    responses: { 200: json(z.object({ created: z.number(), updated: z.number() }), 'Synced'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    return c.json(await coreStub(c.env, c.get('scope')).syncDirectory(callCtx(c), c.req.valid('json').people), 200);
  });

  // ---- desk roster ----

  app.openapi(createRoute({ method: 'get', path: `${base}/shifts`,
    request: { params: TenantParams, query: z.object({ week: date, location: z.string() }) },
    responses: { 200: json(z.object({ week_start: z.string(), location: z.string(), slots: z.array(Slot), coverage: z.array(Gap) }), 'Roster week'), ...errors } }),
  async (c) => {
    deskReaders(c.get('principal'));
    const q = c.req.valid('query');
    return c.json(await coreStub(c.env, c.get('scope')).rosterWeek(c.get('scope'), q.location, q.week), 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/shifts/assign`,
    request: { params: TenantParams, body: body(z.object({ template_key: z.string(), location_key: z.string(), start: z.number().int(), resource_id: z.string() })) },
    responses: { 200: json(Slot, 'Assigned'), ...errors } }),
  async (c) => {
    const p = c.get('principal');
    managers(p);
    const b = c.req.valid('json');
    studio(p, b.location_key);
    return c.json(await coreStub(c.env, c.get('scope')).assignShift(callCtx(c), b), 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/shifts/{session_id}/unassign`,
    request: { params: TenantParams.extend({ session_id: z.string().openapi({ param: { name: 'session_id', in: 'path' } }) }) },
    responses: { 200: json(z.object({ ok: z.literal(true) }), 'Removed'), ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    return c.json(await coreStub(c.env, c.get('scope')).unassignShift(callCtx(c), c.req.valid('param').session_id), 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/time-off`,
    request: { params: TenantParams, body: body(z.object({ resource_id: z.string(), start: z.number().int(), end: z.number().int(),
      reason: z.enum(['sick', 'vacation', 'personal']), immediate: z.boolean().optional() })) },
    responses: { 200: json(z.object({ id: z.string(), state: z.string(), vacated: z.array(z.object({ session_id: z.string(), template_key: z.string(), start: z.number() })) }), 'Recorded'), ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    return c.json(await coreStub(c.env, c.get('scope')).recordTimeOff(callCtx(c), c.req.valid('json')), 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/time-off`, request: { params: TenantParams, query: Range },
    responses: { 200: json(z.object({ items: z.array(z.object({ id: z.string(), resource_id: z.string(), name: z.string(), start: z.number(), end: z.number(), reason: z.string(), state: z.string() })) }), 'Time off'), ...errors } }),
  async (c) => {
    deskReaders(c.get('principal'));
    const q = c.req.valid('query');
    return c.json({ items: await coreStub(c.env, c.get('scope')).listTimeOff(c.get('scope'), q.from, q.to) }, 200);
  });

  // ---- classes ----

  app.openapi(createRoute({ method: 'get', path: `${base}/sessions`,
    request: { params: TenantParams, query: Range.extend({ location: z.string().optional() }) },
    responses: { 200: json(z.object({ items: z.array(ClassRow) }), 'Classes'), ...errors } }),
  async (c) => {
    staff(c.get('principal'));
    const q = c.req.valid('query');
    if (q.to - q.from > 35 * 86_400_000) throw new KairosError('SCHEMA_INVALID', { message: 'at most 35 days at a time' });
    return c.json({ items: await coreStub(c.env, c.get('scope')).listClasses(c.get('scope'), q.from, q.to, q.location ?? null) }, 200);
  });

  // ---- sync (§18.5) ----

  app.openapi(createRoute({ method: 'get', path: `${base}/sync/drift`, request: { params: TenantParams },
    responses: { 200: json(z.object({ items: z.array(z.object({ id: z.string(), kind: z.string(), external_id: z.string().nullable(), detail: z.string(), created_at: z.number() })) }), 'Open drift items'), ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    return c.json({ items: await syncStub(c.env, c.get('scope')).drift(c.get('scope')) }, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/sync/poll`,
    request: { params: TenantParams, body: body(z.object({ system: z.enum(['booking_vendor', 'shift_tool']), entity: z.enum(['classes', 'bookings', 'members', 'shifts']) })) },
    responses: { 200: json(z.object({ system: z.string(), entity: z.string(), records: z.number(), changed: z.number(), error: z.string().optional() }), 'Poll result'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const b = c.req.valid('json');
    return c.json(await syncStub(c.env, c.get('scope')).poll(c.get('scope'), b.system, b.entity), 200);
  });

  // ---- hours ----

  app.openapi(createRoute({ method: 'get', path: `${base}/hours`, request: { params: TenantParams, query: Range },
    responses: { 200: json(z.object({ items: z.array(Hours) }), 'Hours'), ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    const q = c.req.valid('query');
    return c.json({ items: await coreStub(c.env, c.get('scope')).listHours(c.get('scope'), q.from, q.to) }, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/hours/{id}/approve`,
    request: { params: TenantParams.extend({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }) },
    responses: { 200: json(Hours, 'Approved'), ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    return c.json(await coreStub(c.env, c.get('scope')).approveHours(callCtx(c), c.req.valid('param').id), 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/hours/export`, request: { params: TenantParams, query: z.object({ period_start: date }) },
    responses: { 200: { description: 'Gusto employee CSV (§18.8)', content: { 'text/csv': { schema: z.string() } } }, ...errors } }),
  async (c) => {
    managers(c.get('principal'));
    const r = await coreStub(c.env, c.get('scope')).exportHours(callCtx(c), c.req.valid('query').period_start);
    return c.body(r.csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${r.filename}"`,
      'x-kairos-unapproved': String(r.unapproved),
    });
  });
}
