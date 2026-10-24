// kairos-dev-idp: a preview-only sign-in service for demos. It signs RS256 JWTs for the fixed demo users, protected
// by a demo password. Never bound to production: kairos-api's production deployment has no issuer pointing here.
import { importJWK, SignJWT, type JWK } from 'jose';
import { USERS } from './users';

export interface Env {
  SIGNING_JWK: string;         // private RSA JWK (Worker secret)
  DEMO_PASSWORD: string;       // Worker secret
  TENANT_ID: string;           // the preview tenant's id (tid claim)
  ALLOWED_ORIGINS: string;     // comma-separated console origins (CORS)
}

const cors = (env: Env, req: Request): Record<string, string> => {
  const origin = req.headers.get('origin') ?? '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  return ok ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' } : {};
};

const enc = new TextEncoder();
const same = (a: string, b: string) => {
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (url.pathname === '/.well-known/jwks.json') {
      const priv = JSON.parse(env.SIGNING_JWK) as JWK;
      const { n, e, kty } = priv;
      return Response.json({ keys: [{ kty, n, e, alg: 'RS256', use: 'sig', kid: priv.kid ?? 'dev-1' }] }, { headers: { 'cache-control': 'max-age=300' } });
    }
    if (url.pathname === '/users' && req.method === 'GET') {
      return Response.json({ items: USERS.map(({ sub, name, groups, studios }) => ({ sub, name, groups, studios })) }, { headers: h });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { sub?: string; password?: string; env?: string };
      if (!body.password || !same(body.password, env.DEMO_PASSWORD)) return Response.json({ error: 'bad password' }, { status: 401, headers: h });
      const u = USERS.find((x) => x.sub === body.sub);
      if (!u) return Response.json({ error: 'unknown user' }, { status: 404, headers: h });
      const jwk = JSON.parse(env.SIGNING_JWK) as JWK;
      const key = await importJWK(jwk, 'RS256');
      const token = await new SignJWT({ tid: env.TENANT_ID, env: 'preview', groups: u.groups, name: u.name, email: u.email, ...(u.studios ? { studios: u.studios } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid ?? 'dev-1' })
        .setIssuer(url.origin).setAudience('kairos').setSubject(u.sub).setIssuedAt().setExpirationTime('8h')
        .sign(key);
      return Response.json({ token, user: { sub: u.sub, name: u.name, groups: u.groups, studios: u.studios ?? null } }, { headers: h });
    }
    return Response.json({ error: 'not found' }, { status: 404, headers: h });
  },
} satisfies ExportedHandler<Env>;

