// Request context shared by the route modules.
import type { TenantRecord } from '@kairos/control';
import type { ActorRef, CallContext, Scope } from '@kairos/core';
import type { Principal } from './auth';
import type { Env } from './env';

export type Vars = { requestId: string; tenant: TenantRecord; scope: Scope; principal: Principal };
export type AppEnv = { Bindings: Env; Variables: Vars };

export const coreStub = (env: Env, s: Scope) =>
  env.TENANT_CORE.get(env.TENANT_CORE.idFromName(`${s.tenant}:${s.env}`), { locationHint: 'enam' });
export const syncStub = (env: Env, s: Scope) =>
  env.TENANT_SYNC.get(env.TENANT_SYNC.idFromName(`${s.tenant}:${s.env}`), { locationHint: 'enam' });

const actorOf = (p: Principal): ActorRef =>
  p.kind === 'member' ? { type: 'member', subject: p.subject } : { type: 'staff', subject: p.subject, roles: p.roles };

export const callCtx = (c: { get<K extends keyof Vars>(k: K): Vars[K] }): CallContext => ({
  scope: c.get('scope'), actor: actorOf(c.get('principal')), requestId: c.get('requestId'),
});

