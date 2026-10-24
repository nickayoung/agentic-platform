// kairos-api: stateless. Checks the token, resolves the tenant through the control plane, validates the request
// with the route's Zod schema and calls the tenant's object over RPC (§19.1). Routes and the OpenAPI document come
// from the same definitions (§19.11).
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { TenantRecord } from '@kairos/control';
import type { Scope } from '@kairos/core';
import { KairosError } from '@kairos/errors';
import { verifySignature } from '@kairos/sync';
import { authenticate, requireRole, sameSecret } from './auth';
import { callCtx, coreStub, syncStub, type AppEnv } from './context';
import { configRoutes } from './routes/config';
import { errors, TenantParams } from './schemas';
import { controlStub, type Env } from './env';
import { problem } from './problem';

const INBOUND_PATH = /^\/v1\/t\/[^/]+\/[^/]+\/sync\/inbound\//;

// ---- tenant resolution, cached briefly per isolate -------------------------------------------------------------

const TENANT_TTL_MS = 30_000;
const tenantCache = new Map<string, { at: number; t: TenantRecord | null }>();

async function resolveTenant(env: Env, slug: string): Promise<TenantRecord> {
  const hit = tenantCache.get(slug);
  let t = hit && Date.now() - hit.at < TENANT_TTL_MS ? hit.t : undefined;
  if (t === undefined) {
    t = await controlStub(env).getTenant(slug);
    tenantCache.set(slug, { at: Date.now(), t });
  }
  if (!t || t.state === 'deleted' || t.state === 'closed') throw new KairosError('NOT_FOUND', { message: `tenant ${slug}` });
  return t;
}

// ---- schemas -----------------------------------------------------------------------------------------------------

const Flag = z.object({
  key: z.string(), enabled: z.boolean(), allow_locations: z.array(z.string()).nullable(),
  allow_roles: z.array(z.string()).nullable(), owner: z.string(), remove_by: z.string(), version: z.number().int(),
}).openapi('Flag');
const FlagPut = z.object({
  enabled: z.boolean(), owner: z.string().min(1), remove_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  allow_locations: z.array(z.string()).optional(), allow_roles: z.array(z.string()).optional(),
}).openapi('FlagPut');
const DomainMode = z.object({
  domain: z.enum(['classes', 'bookings', 'members', 'shifts']), mode: z.enum(['mirror', 'shadow', 'owner']),
  outside_system: z.string().nullable(), outbound_push: z.boolean(), retired: z.boolean(), write_freeze: z.boolean(),
  version: z.number().int(),
}).openapi('DomainMode');
const TenantCreate = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), name: z.string().min(1), region_hint: z.string().optional(),
  identity: z.object({
    issuers: z.array(z.object({
      key: z.string(), audience: z.enum(['member', 'staff']), issuer: z.string().url(), jwks_url: z.string().url(),
      subject_claim: z.string(), tenant_claim: z.string(), aud: z.string().optional(),
    })).min(1),
    role_mappings: z.array(z.object({
      issuer: z.string(), claim: z.string(), equals: z.string(),
      grant: z.enum(['owner', 'admin', 'manager', 'desk', 'instructor', 'staff', 'member', 'guest']), location_claim: z.string().optional(),
    })),
  }),
}).openapi('TenantCreate');

// ---- app -----------------------------------------------------------------------------------------------------------

export function buildApp() {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ code: 'SCHEMA_INVALID', status: 422, detail: 'request does not match the schema', issues: result.error.issues }, 422,
          { 'content-type': 'application/problem+json' });
      }
    },
  });

  // browsers: only the configured console origins; bearer tokens, no cookies
  app.use('*', (c, next) => cors({
    origin: (o) => ((c.env.CONSOLE_ORIGINS ?? '').split(',').map((s) => s.trim()).includes(o) ? o : null),
    allowHeaders: ['authorization', 'content-type', 'if-match', 'idempotency-key', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['etag', 'x-request-id'],
    maxAge: 600,
  })(c, next));
  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? `req_${crypto.randomUUID().replaceAll('-', '')}`);
    await next();
    c.header('x-request-id', c.get('requestId'));
  });
  app.onError((e, c) => problem(c, e));
  app.notFound((c) => problem(c, new KairosError('NOT_FOUND', { message: c.req.path })));

  app.get('/v1/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

  // tenant routes: resolve, check the deployment environment, authenticate
  app.use('/v1/t/:tenant_slug/:env/*', async (c, next) => {
    const env = c.req.param('env');
    if (env !== c.env.ENVIRONMENT) throw new KairosError('NOT_FOUND', { message: `this deployment serves ${c.env.ENVIRONMENT}` });
    const tenant = await resolveTenant(c.env, c.req.param('tenant_slug'));
    const scope: Scope = { tenant: tenant.slug, env: env as Scope['env'] };
    c.set('tenant', tenant);
    c.set('scope', scope);
    // inbound events are signed by the gateway instead of carrying a user token (§18.3)
    if (!INBOUND_PATH.test(c.req.path)) {
      c.set('principal', await authenticate(c.req.header('authorization'), tenant.identity, { tenantId: tenant.id, env },
        c.env.DEV_IDP && c.env.DEV_IDP_HOST ? { [c.env.DEV_IDP_HOST]: c.env.DEV_IDP } : {}));
    }
    await next();
  });

  app.openapi(
    createRoute({
      method: 'get', path: '/v1/t/{tenant_slug}/{env}/flags', request: { params: TenantParams },
      responses: { 200: { description: 'Flags', content: { 'application/json': { schema: z.object({ items: z.array(Flag) }) } } }, ...errors },
    }),
    async (c) => {
      requireRole(c.get('principal'), 'owner', 'admin', 'manager');
      return c.json({ items: await coreStub(c.env, c.get('scope')).listFlags(c.get('scope')) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put', path: '/v1/t/{tenant_slug}/{env}/flags/{key}',
      request: {
        params: TenantParams.extend({ key: z.string().regex(/^[a-z][a-z0-9_.]{1,62}$/).openapi({ param: { name: 'key', in: 'path' } }) }),
        headers: z.object({ 'if-match': z.string().optional() }),
        body: { content: { 'application/json': { schema: FlagPut } }, required: true },
      },
      responses: { 200: { description: 'Flag', content: { 'application/json': { schema: Flag } } }, ...errors },
    }),
    async (c) => {
      requireRole(c.get('principal'), 'owner', 'admin');
      const { key } = c.req.valid('param');
      const ifMatch = c.req.valid('header')['if-match'];
      const expected = ifMatch === undefined || ifMatch === '*' ? null : Number(ifMatch.replaceAll('"', ''));
      const f = await coreStub(c.env, c.get('scope')).setFlag(callCtx(c), { key, ...c.req.valid('json') }, expected);
      c.header('etag', `"${f.version}"`);
      return c.json(f, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/v1/t/{tenant_slug}/{env}/domain-modes', request: { params: TenantParams },
      responses: { 200: { description: 'Domain modes', content: { 'application/json': { schema: z.object({ items: z.array(DomainMode) }) } } }, ...errors },
    }),
    async (c) => {
      requireRole(c.get('principal'), 'owner', 'admin', 'manager');
      return c.json({ items: await coreStub(c.env, c.get('scope')).getDomainModes(c.get('scope')) }, 200);
    },
  );

  // inbound outside events (§18.3, §12.6): signed and timestamped by the gateway; duplicates are acknowledged and dropped
  app.openapi(
    createRoute({
      method: 'post', path: '/v1/t/{tenant_slug}/{env}/sync/inbound/{system}',
      request: {
        params: TenantParams.extend({ system: z.enum(['booking_vendor', 'shift_tool', 'staff_directory', 'payments']).openapi({ param: { name: 'system', in: 'path' } }) }),
        headers: z.object({ 'x-gateway-signature': z.string() }),
      },
      responses: { 200: { description: 'Accepted or duplicate', content: { 'application/json': { schema: z.object({ duplicate: z.boolean() }) } } }, ...errors },
    }),
    async (c) => {
      const raw = await c.req.text();
      const secret = c.env.GATEWAY_SIGNING_SECRET;
      if (!secret || !(await verifySignature(secret, c.req.header('x-gateway-signature') ?? null, raw, Date.now()))) {
        throw new KairosError('UNAUTHENTICATED', { message: 'bad or stale gateway signature' });
      }
      let body: { event_id?: unknown };
      try { body = JSON.parse(raw) as { event_id?: unknown }; } catch { throw new KairosError('SCHEMA_INVALID', { message: 'body is not JSON' }); }
      if (typeof body.event_id !== 'string' || body.event_id === '') throw new KairosError('SCHEMA_INVALID', { message: 'event_id is required' });
      const fresh = await syncStub(c.env, c.get('scope')).receive(c.get('scope'), c.req.valid('param').system, body.event_id, body);
      return c.json({ duplicate: !fresh }, 200);
    },
  );

  // platform admin: provisioning (§3A.3)
  app.openapi(
    createRoute({
      method: 'post', path: '/v1/admin/tenants',
      request: { body: { content: { 'application/json': { schema: TenantCreate } }, required: true } },
      responses: {
        201: { description: 'Provisioned', content: { 'application/json': { schema: z.object({ id: z.string(), slug: z.string(), state: z.string() }) } } },
        ...errors,
      },
    }),
    async (c) => {
      const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!c.env.PLATFORM_ADMIN_TOKEN || !sameSecret(token, c.env.PLATFORM_ADMIN_TOKEN)) throw new KairosError('UNAUTHENTICATED');
      const actor = { type: 'service' as const, name: 'platform-admin' };
      const body = c.req.valid('json');
      const t = await controlStub(c.env).createTenant(body, actor, c.get('requestId'));
      const scope: Scope = { tenant: t.slug, env: c.env.ENVIRONMENT };
      await coreStub(c.env, scope).init({ scope, actor, requestId: c.get('requestId') });
      await syncStub(c.env, scope).init(scope);
      return c.json({ id: t.id, slug: t.slug, state: t.state }, 201);
    },
  );

  configRoutes(app);

  app.doc31('/v1/openapi.json', { openapi: '3.1.0', info: { title: 'Kairos API', version: '0.1.0' } });
  return app;
}
