// Configuration endpoints (§11.3): owner and admin. Approval, rejection and rollback are human only.
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { KairosError } from '@kairos/errors';
import { requireRole, type Principal } from '../auth';
import { callCtx, coreStub, type AppEnv } from '../context';
import { errors, TenantParams } from '../schemas';

const DraftParams = TenantParams.extend({ id: z.string().regex(/^dft_[a-f0-9]{32}$/).openapi({ param: { name: 'id', in: 'path' } }) });
const IfMatch = z.object({ 'if-match': z.string().regex(/^"?\d+"?$/) });

const Issue = z.object({ layer: z.string(), code: z.string(), severity: z.string(), path: z.string(), message: z.string() });
const Draft = z.object({
  id: z.string(), base_number: z.number().int().nullable(),
  state: z.enum(['editing', 'validated', 'awaiting_approval', 'published', 'abandoned']), version: z.number().int(),
  document: z.record(z.string(), z.unknown()), validation: z.object({ ok: z.boolean(), issues: z.array(Issue) }).nullable(),
  impact: z.object({ groups: z.array(z.unknown()) }).nullable(), author: z.unknown(),
}).openapi('ConfigDraft');
const Version = z.object({
  number: z.number().int(), content_hash: z.string(), state: z.enum(['staged', 'active', 'superseded']),
  effective_from: z.number().int(), published_at: z.number().int(), summary: z.string(),
  rollback_of: z.number().int().nullable(), parent_number: z.number().int().nullable(),
}).openapi('ConfigVersion');
const JsonPatch = z.array(z.union([
  z.object({ op: z.enum(['add', 'replace', 'test']), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
  z.object({ op: z.enum(['move', 'copy']), from: z.string(), path: z.string() }),
])).min(1).max(500).openapi('JsonPatch');

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const version = (h: string) => Number(h.replaceAll('"', ''));
const admins = (p: Principal) => requireRole(p, 'owner', 'admin');
const humanOnly = (p: Principal) => {
  admins(p);
  if (p.kind !== 'staff') throw new KairosError('FORBIDDEN', { message: 'approval, rejection and rollback are human only' });
};

export function configRoutes(app: OpenAPIHono<AppEnv>): void {
  const base = '/v1/t/{tenant_slug}/{env}/config';

  app.openapi(createRoute({ method: 'get', path: `${base}/active`, request: { params: TenantParams },
    responses: { 200: json(z.object({ number: z.number(), content_hash: z.string(), epoch: z.number(), document: z.record(z.string(), z.unknown()) }), 'Active config'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const a = await coreStub(c.env, c.get('scope')).getActiveConfig(c.get('scope'));
    if (!a) throw new KairosError('NOT_FOUND', { message: 'no config has been published' });
    c.header('etag', `"${a.epoch}"`);
    return c.json(a, 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/versions`, request: { params: TenantParams },
    responses: { 200: json(z.object({ items: z.array(Version) }), 'Versions, newest first'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    return c.json({ items: await coreStub(c.env, c.get('scope')).listConfigVersions(c.get('scope')) }, 200);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/versions/{n}`,
    request: { params: TenantParams.extend({ n: z.coerce.number().int().positive().openapi({ param: { name: 'n', in: 'path' } }) }) },
    responses: { 200: json(Version.extend({ document: z.record(z.string(), z.unknown()) }), 'Version'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const v = await coreStub(c.env, c.get('scope')).getConfigVersion(c.get('scope'), c.req.valid('param').n);
    if (!v) throw new KairosError('NOT_FOUND');
    return c.json(v, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/drafts`,
    request: { params: TenantParams, body: { required: false, content: { 'application/json': {
      schema: z.union([z.object({ yaml: z.string().min(1).max(1_000_000) }), z.object({ document: z.record(z.string(), z.unknown()) }), z.object({})]),
    } } } },
    responses: { 201: json(Draft, 'Draft created'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const body = c.req.valid('json') as { yaml?: string; document?: Record<string, unknown> };
    const input = body.yaml !== undefined ? { yaml: body.yaml } : body.document !== undefined ? { document: body.document } : null;
    const d = await coreStub(c.env, c.get('scope')).createDraft(callCtx(c), input);
    c.header('etag', `"${d.version}"`);
    return c.json(d, 201);
  });

  app.openapi(createRoute({ method: 'get', path: `${base}/drafts/{id}`, request: { params: DraftParams },
    responses: { 200: json(Draft, 'Draft'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const d = await coreStub(c.env, c.get('scope')).getDraft(c.get('scope'), c.req.valid('param').id);
    c.header('etag', `"${d.version}"`);
    return c.json(d, 200);
  });

  app.openapi(createRoute({ method: 'patch', path: `${base}/drafts/{id}`,
    request: { params: DraftParams, headers: IfMatch, body: { required: true, content: { 'application/json-patch+json': { schema: JsonPatch }, 'application/json': { schema: JsonPatch } } } },
    responses: { 200: json(Draft, 'Patched'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const ops = await c.req.json();
    const parsed = JsonPatch.safeParse(ops);
    if (!parsed.success) throw new KairosError('SCHEMA_INVALID', { message: 'body is not a JSON Patch' });
    const d = await coreStub(c.env, c.get('scope')).patchDraft(callCtx(c), c.req.valid('param').id, parsed.data as never, version(c.req.valid('header')['if-match']));
    c.header('etag', `"${d.version}"`);
    return c.json(d, 200);
  });

  for (const [action, method] of [['validate', 'validateDraft'], ['impact', 'getDraft']] as const) {
    app.openapi(createRoute({ method: 'post', path: `${base}/drafts/{id}/${action}`, request: { params: DraftParams },
      responses: { 200: json(Draft, action === 'validate' ? 'Validation report (L1–L4)' : 'Impact plan (L6; empty until sessions exist)'), ...errors } }),
    async (c) => {
      admins(c.get('principal'));
      const stub = coreStub(c.env, c.get('scope'));
      const id = c.req.valid('param').id;
      const d = method === 'validateDraft' ? await stub.validateDraft(callCtx(c), id) : await stub.getDraft(c.get('scope'), id);
      c.header('etag', `"${d.version}"`);
      return c.json(d, 200);
    });
  }

  app.openapi(createRoute({ method: 'post', path: `${base}/drafts/{id}/submit`, request: { params: DraftParams, headers: IfMatch },
    responses: { 200: json(Draft, 'Submitted for approval'), ...errors } }),
  async (c) => {
    admins(c.get('principal'));
    const d = await coreStub(c.env, c.get('scope')).submitDraft(callCtx(c), c.req.valid('param').id, version(c.req.valid('header')['if-match']));
    c.header('etag', `"${d.version}"`);
    return c.json(d, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/drafts/{id}/approve`,
    request: { params: DraftParams, headers: IfMatch, body: { required: true, content: { 'application/json': {
      schema: z.object({ summary: z.string().min(1).max(500), effective_from: z.number().int().optional() }) } } } },
    responses: { 200: json(Version, 'Published'), ...errors } }),
  async (c) => {
    humanOnly(c.get('principal'));
    const v = await coreStub(c.env, c.get('scope')).approveAndPublish(callCtx(c), c.req.valid('param').id, version(c.req.valid('header')['if-match']), c.req.valid('json'));
    return c.json(v, 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/drafts/{id}/reject`,
    request: { params: DraftParams, headers: IfMatch, body: { required: true, content: { 'application/json': { schema: z.object({ reason: z.string().min(1).max(1000) }) } } } },
    responses: { 200: json(Draft, 'Rejected'), ...errors } }),
  async (c) => {
    humanOnly(c.get('principal'));
    return c.json(await coreStub(c.env, c.get('scope')).rejectDraft(callCtx(c), c.req.valid('param').id, version(c.req.valid('header')['if-match']), c.req.valid('json').reason), 200);
  });

  app.openapi(createRoute({ method: 'post', path: `${base}/rollback`,
    request: { params: TenantParams, body: { required: true, content: { 'application/json': {
      schema: z.object({ to_version: z.number().int().positive(), summary: z.string().min(1).max(500).default('rollback'), emergency: z.boolean().optional() }) } } } },
    responses: { 200: json(Version, 'Rolled back'), ...errors } }),
  async (c) => {
    humanOnly(c.get('principal'));
    const b = c.req.valid('json');
    return c.json(await coreStub(c.env, c.get('scope')).rollbackConfig(callCtx(c), b.to_version, b.summary), 200);
  });
}
