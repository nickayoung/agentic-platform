import { adminSecretsStore, createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const ISS = 'https://staff.signin.test';
const MEMBER_ISS = 'https://members.signin.test';
let keys: { privateKey: CryptoKey; jwk: JWK };

beforeAll(async () => {
  using admin = adminSecretsStore(env.KEK);
  await admin.create(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
  const kp = await generateKeyPair('RS256', { extractable: true });
  keys = { privateKey: kp.privateKey, jwk: { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' } };
});

afterEach(() => vi.restoreAllMocks());

/** JWKS endpoints are the only outbound calls these tests allow. */
function mockJwks() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [keys.jwk] });
    return real(input, init);
  });
}

const call = async (path: string, init: RequestInit = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

let n = 0;
async function provision() {
  const slug = `lotus-${n++}`;
  const res = await call('/v1/admin/tenants', {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      slug, name: 'Lotus & Line',
      identity: {
        issuers: [
          { key: 'staff', audience: 'staff', issuer: ISS, jwks_url: `${ISS}/.well-known/jwks.json`, subject_claim: 'sub', tenant_claim: 'tid' },
          { key: 'members', audience: 'member', issuer: MEMBER_ISS, jwks_url: `${MEMBER_ISS}/.well-known/jwks.json`, subject_claim: 'sub', tenant_claim: 'tid' },
        ],
        role_mappings: [
          { issuer: 'staff', claim: 'groups', equals: 'kairos-owners', grant: 'owner' },
          { issuer: 'staff', claim: 'groups', equals: 'studio-managers', grant: 'manager', location_claim: 'studios' },
        ],
      },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

const token = (claims: Record<string, unknown>, opts: { iss?: string; exp?: string } = {}) =>
  new SignJWT({ env: 'preview', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.iss ?? ISS).setAudience('kairos')
    .setSubject(String(claims.sub ?? 'staff_1')).setIssuedAt().setExpirationTime(opts.exp ?? '5m').sign(keys.privateKey);

describe('kairos-api', () => {
  it('health needs no auth', async () => {
    const res = await call('/v1/health');
    expect(await res.json()).toEqual({ ok: true, env: 'preview' });
  });

  it('provisioning needs the platform admin token', async () => {
    const res = await call('/v1/admin/tenants', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect([401, 422]).toContain(res.status);
  });

  it('provisions a tenant: control-plane record, wrapped keys, TenantCore seeded in mirror', async () => {
    mockJwks();
    const t = await provision();
    const owner = await token({ tid: t.id, groups: ['kairos-owners'] });
    const res = await call(`/v1/t/${t.slug}/preview/domain-modes`, { headers: { authorization: `Bearer ${owner}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { mode: string }[] };
    expect(body.items.map((m) => m.mode)).toEqual(['mirror', 'mirror', 'mirror', 'mirror']);
    const keys = await env.CONTROL.get(env.CONTROL.idFromName('control:preview')).wrappedKeys(t.id);
    expect(keys.map((k) => k.purpose).sort()).toEqual(['blind_index', 'data']);
    expect(keys.every((k) => k.wrapped.startsWith('v1.'))).toBe(true);
  });

  it('flags: owner can write with If-Match; manager can read but not write', async () => {
    mockJwks();
    const t = await provision();
    const owner = await token({ tid: t.id, groups: ['kairos-owners'] });
    const manager = await token({ tid: t.id, groups: ['studio-managers'], studios: ['park_slope'] });
    const put = (tok: string, ifMatch?: string) => call(`/v1/t/${t.slug}/preview/flags/sync.shifts.owner`, {
      method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify({ enabled: false, owner: 'ops', remove_by: '2027-06-01' }),
    });
    const r1 = await put(owner);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('etag')).toBe('"1"');
    expect((await put(owner, '"9"')).status).toBe(409);
    expect((await put(owner, '"1"')).status).toBe(200);
    const denied = await put(manager);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain('application/problem+json');
    const list = await call(`/v1/t/${t.slug}/preview/flags`, { headers: { authorization: `Bearer ${manager}` } });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('rejects a token for another tenant, another env, an unknown issuer, or one that expired (§13.2)', async () => {
    mockJwks();
    const t = await provision();
    const other = await provision();
    const path = `/v1/t/${t.slug}/preview/flags`;
    const get = (tok: string) => call(path, { headers: { authorization: `Bearer ${tok}` } });
    expect((await get(await token({ tid: other.id, groups: ['kairos-owners'] }))).status).toBe(403);
    expect((await get(await token({ tid: t.id, groups: ['kairos-owners'], env: 'production' }))).status).toBe(403);
    expect((await get(await token({ tid: t.id, groups: ['kairos-owners'] }, { iss: 'https://evil.test' }))).status).toBe(401);
    expect((await get(await token({ tid: t.id, groups: ['kairos-owners'] }, { exp: '-5m' }))).status).toBe(401);
    expect((await call(path)).status).toBe(401);
  });

  it('a member token has no staff permissions', async () => {
    mockJwks();
    const t = await provision();
    const member = await token({ tid: t.id, groups: ['kairos-owners'] }, { iss: MEMBER_ISS });
    expect((await call(`/v1/t/${t.slug}/preview/flags`, { headers: { authorization: `Bearer ${member}` } })).status).toBe(403);
  });

  it('a preview deployment does not serve production paths (§13.1)', async () => {
    const t = await provision();
    expect((await call(`/v1/t/${t.slug}/production/flags`)).status).toBe(404);
  });

  it('an unknown tenant is 404 before any token check', async () => {
    expect((await call('/v1/t/nobody/preview/flags')).status).toBe(404);
  });

  it('validates request bodies against the route schema', async () => {
    mockJwks();
    const t = await provision();
    const owner = await token({ tid: t.id, groups: ['kairos-owners'] });
    const res = await call(`/v1/t/${t.slug}/preview/flags/x.y`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(422);
  });

  it('serves the OpenAPI 3.1 document', async () => {
    const doc = (await (await call('/v1/openapi.json')).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/t/{tenant_slug}/{env}/flags/{key}');
  });

  it('the backstop cron re-arms a tenant whose alarm was cleared (§19.5)', async () => {
    const t = await provision();
    const stub = env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`${t.slug}:preview`));
    await runInDurableObject(stub, (_o, state) => state.storage.deleteAlarm());
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/5 * * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await stub.health({ tenant: t.slug, env: 'preview' })).alarm).not.toBeNull();
  });
});
