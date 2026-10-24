import { adminSecretsStore, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import lotusYaml from '../../../fixtures/configs/lotus_line.yaml';
import worker from '../src/index';

const ISS = 'https://staff.signin.test';
let keys: { privateKey: CryptoKey; jwk: JWK };

beforeAll(async () => {
  using admin = adminSecretsStore(env.KEK);
  await admin.create(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))).catch(() => undefined);
  const kp = await generateKeyPair('RS256', { extractable: true });
  keys = { privateKey: kp.privateKey, jwk: { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' } };
});
afterEach(() => vi.restoreAllMocks());

const call = async (path: string, init: RequestInit = {}) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

let n = 0;
async function setup() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [keys.jwk] });
    if (url.startsWith('https://gateway.test')) return Response.json({ records: [], next_cursor: null });
    return real(input, init);
  });
  const slug = `cfg-api-${n++}`;
  const res = await call('/v1/admin/tenants', {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ slug, name: 'Lotus & Line', identity: {
      issuers: [{ key: 'staff', audience: 'staff', issuer: ISS, jwks_url: `${ISS}/.well-known/jwks.json`, subject_claim: 'sub', tenant_claim: 'tid' }],
      role_mappings: [
        { issuer: 'staff', claim: 'groups', equals: 'kairos-owners', grant: 'owner' },
        { issuer: 'staff', claim: 'groups', equals: 'studio-managers', grant: 'manager' },
      ],
    } }),
  });
  const t = (await res.json()) as { id: string; slug: string };
  const tok = (groups: string[]) => new SignJWT({ env: 'preview', tid: t.id, groups })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience('kairos').setSubject('u1')
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const owner = await tok(['kairos-owners']);
  const manager = await tok(['studio-managers']);
  const api = (path: string, init: RequestInit & { as?: string } = {}) => call(`/v1/t/${slug}/preview${path}`, {
    ...init, headers: { authorization: `Bearer ${init.as ?? owner}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { api, manager };
}

describe('configuration endpoints (§11.3)', () => {
  it('publishes lotus_line.yaml over HTTP and rolls back', async () => {
    const { api } = await setup();
    expect((await api('/config/active')).status).toBe(404);

    let r = await api('/config/drafts', { method: 'POST', body: JSON.stringify({ yaml: lotusYaml }) });
    expect(r.status).toBe(201);
    const d0 = (await r.json()) as { id: string; version: number };
    r = await api(`/config/drafts/${d0.id}/validate`, { method: 'POST' });
    const d1 = (await r.json()) as { state: string; version: number; validation: { ok: boolean } };
    expect(d1.state).toBe('validated');
    expect(d1.validation.ok).toBe(true);
    r = await api(`/config/drafts/${d0.id}/submit`, { method: 'POST', headers: { 'if-match': `"${d1.version}"` } });
    const d2 = (await r.json()) as { version: number };
    r = await api(`/config/drafts/${d0.id}/approve`, { method: 'POST', headers: { 'if-match': `"${d2.version}"` }, body: JSON.stringify({ summary: 'initial' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ number: 1, state: 'active' });

    // edit via JSON Patch
    r = await api('/config/drafts', { method: 'POST', body: '{}' });
    const e0 = (await r.json()) as { id: string; version: number };
    r = await api(`/config/drafts/${e0.id}`, {
      method: 'PATCH', headers: { 'if-match': `"${e0.version}"`, 'content-type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'replace', path: '/tenant/hold_ttl', value: '10m' }]),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe(`"${e0.version + 1}"`);

    r = await api('/config/rollback', { method: 'POST', body: JSON.stringify({ to_version: 1, summary: 'test' }) });
    expect(await r.json()).toMatchObject({ number: 2, rollback_of: 1 });
    const versions = (await (await api('/config/versions')).json()) as { items: { number: number }[] };
    expect(versions.items.map((v) => v.number)).toEqual([2, 1]);
    expect(((await (await api('/config/versions/1')).json()) as { document: { schema_version: string } }).document.schema_version).toBe('2.1');
  });

  it('a manager cannot draft or publish; a bad YAML is SCHEMA_INVALID with issues', async () => {
    const { api, manager } = await setup();
    expect((await api('/config/drafts', { method: 'POST', body: JSON.stringify({ yaml: lotusYaml }), as: manager })).status).toBe(403);
    const r = await api('/config/drafts', { method: 'POST', body: JSON.stringify({ yaml: 'schema_version: "2.1"\nflag: yes\n' }) });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { code: string; reasons: unknown[] };
    expect(body.code).toBe('SCHEMA_INVALID');
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it('If-Match is required on submit and approve', async () => {
    const { api } = await setup();
    const d0 = (await (await api('/config/drafts', { method: 'POST', body: JSON.stringify({ yaml: lotusYaml }) })).json()) as { id: string };
    await api(`/config/drafts/${d0.id}/validate`, { method: 'POST' });
    expect((await api(`/config/drafts/${d0.id}/submit`, { method: 'POST' })).status).toBe(422);
    expect((await api(`/config/drafts/${d0.id}/submit`, { method: 'POST', headers: { 'if-match': '"1"' } })).status).toBe(409);
  });
});
