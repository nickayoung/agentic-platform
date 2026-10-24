// Token checks (§13.2): signature against the issuer's JWKS, iss / aud / exp / nbf with ±60 s skew, and the
// tenant and environment claims against the path (§11.2). Roles come from the access role mappings (§4.13).
import { KairosError } from '@kairos/errors';
import type { IdentityConfig, IssuerDef, RoleMapping } from '@kairos/control';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from 'jose';

export type PlatformRole = RoleMapping['grant'];

export interface Principal {
  kind: 'member' | 'staff';
  issuer: string;            // issuer key
  subject: string;
  roles: PlatformRole[];
  locations: string[] | null;
  claims: JWTPayload;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
/**
 * Fetchers for key-set hosts reachable only through a service binding. A Worker can't fetch another Worker on the
 * same account over workers.dev, so preview's demo issuer is bound instead (keyed by host).
 */
export type JwksFetchers = Record<string, Fetcher>;

const jwks = (url: string, fetchers: JwksFetchers = {}) => {
  let set = jwksCache.get(url);
  if (!set) {
    // keys cached for 10 minutes, refreshed early on an unknown kid (§13.2)
    const bound = fetchers[new URL(url).host];
    set = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 600_000, cooldownDuration: 30_000,
      ...(bound ? { [customFetch]: (u: string, o: RequestInit) => bound.fetch(u, o) } : {}),
    });
    jwksCache.set(url, set);
  }
  return set;
};

const claimValues = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);

export function rolesFor(issuer: IssuerDef, claims: JWTPayload, mappings: RoleMapping[]): { roles: PlatformRole[]; locations: string[] | null } {
  const roles = new Set<PlatformRole>(issuer.audience === 'member' ? ['member'] : []);
  let locations: string[] | null = null;
  for (const m of mappings) {
    if (m.issuer !== issuer.key) continue;
    if (!claimValues(claims[m.claim]).includes(m.equals)) continue;
    roles.add(m.grant);
    if (m.location_claim) locations = [...(locations ?? []), ...claimValues(claims[m.location_claim])];
  }
  return { roles: [...roles], locations };
}

export async function authenticate(
  header: string | undefined,
  identity: IdentityConfig,
  expect: { tenantId: string; env: string },
  fetchers: JwksFetchers = {},
): Promise<Principal> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new KairosError('UNAUTHENTICATED');
  let iss: string | undefined;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    throw new KairosError('UNAUTHENTICATED', { message: 'malformed token' });
  }
  const issuer = identity.issuers.find((i) => i.issuer === iss);
  if (!issuer) throw new KairosError('UNAUTHENTICATED', { message: 'unknown issuer' });
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks(issuer.jwks_url, fetchers), {
      issuer: issuer.issuer, audience: issuer.aud ?? 'kairos', clockTolerance: 60, requiredClaims: ['exp'],
    }));
  } catch (e) {
    throw new KairosError('UNAUTHENTICATED', { message: (e as Error).message });
  }
  if (String(payload[issuer.tenant_claim] ?? '') !== expect.tenantId) {
    throw new KairosError('TENANT_MISMATCH', { message: 'token tenant does not match the path' });
  }
  if (String(payload.env ?? '') !== expect.env) throw new KairosError('TENANT_MISMATCH', { message: 'token env does not match the path' });
  const subject = String(payload[issuer.subject_claim] ?? '');
  if (!subject) throw new KairosError('UNAUTHENTICATED', { message: 'no subject' });
  const { roles, locations } = rolesFor(issuer, payload, identity.role_mappings);
  return { kind: issuer.audience, issuer: issuer.key, subject, roles, locations, claims: payload };
}

export function requireRole(p: Principal, ...allowed: PlatformRole[]): void {
  if (!p.roles.some((r) => allowed.includes(r))) throw new KairosError('FORBIDDEN', { message: `needs one of ${allowed.join(', ')}` });
}

/** Constant-time comparison for the platform admin token. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let d = 0;
  for (let i = 0; i < x.byteLength; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}
