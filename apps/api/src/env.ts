import type { ControlPlane } from '@kairos/control';
import type { TenantCore } from '@kairos/core';
import type { TenantSync } from '@kairos/sync';

export interface Env {
  ENVIRONMENT: 'preview' | 'production';
  TENANT_CORE: DurableObjectNamespace<TenantCore>;
  TENANT_SYNC: DurableObjectNamespace<TenantSync>;
  CONTROL: DurableObjectNamespace<ControlPlane>;
  /** HMAC secret the gateway signs inbound events with (§18.3). */
  GATEWAY_SIGNING_SECRET?: string;
  ARCHIVE?: R2Bucket;
  /** Platform operators' token for /v1/admin (Worker secret). */
  PLATFORM_ADMIN_TOKEN?: string;
  /** Comma-separated origins allowed to call the API from a browser (the Kairos console). */
  CONSOLE_ORIGINS?: string;
  /** Preview only: the demo sign-in Worker, bound because Workers can't fetch each other over workers.dev. */
  DEV_IDP?: Fetcher;
  /** Host the DEV_IDP binding answers for, e.g. kairos-dev-idp.<subdomain>.workers.dev. */
  DEV_IDP_HOST?: string;
  KEK?: { get(): Promise<string> };
  GATEWAY_URL?: string;
  NOTIFY_URL?: string;
  SERVICE_TOKEN?: string;
}

export const controlStub = (env: Env) => env.CONTROL.get(env.CONTROL.idFromName(`control:${env.ENVIRONMENT}`));
