import type { ControlPlane } from '@kairos/control';
import type { TenantCore } from '@kairos/core';

export interface Env {
  ENVIRONMENT: 'preview' | 'production';
  TENANT_CORE: DurableObjectNamespace<TenantCore>;
  CONTROL: DurableObjectNamespace<ControlPlane>;
  ARCHIVE?: R2Bucket;
  /** Platform operators' token for /v1/admin (Worker secret). */
  PLATFORM_ADMIN_TOKEN?: string;
  KEK?: { get(): Promise<string> };
  GATEWAY_URL?: string;
  NOTIFY_URL?: string;
  SERVICE_TOKEN?: string;
}

export const controlStub = (env: Env) => env.CONTROL.get(env.CONTROL.idFromName(`control:${env.ENVIRONMENT}`));
