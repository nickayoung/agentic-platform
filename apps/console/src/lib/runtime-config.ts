// The two base URLs the browser needs. They live in wrangler `vars`; the root route loads them once through this
// server function, so a deployment can point at another API without a rebuild. The page then holds them in memory.
import { createServerFn } from '@tanstack/react-start';

export interface RuntimeConfig { apiBase: string; idpBase: string }

const trim = (s: string | undefined) => (s ?? '').replace(/\/+$/, '');

export const getRuntimeConfig = createServerFn({ method: 'GET' }).handler(async (): Promise<RuntimeConfig> => {
  const { env } = await import('cloudflare:workers');
  return { apiBase: trim(env.API_BASE), idpBase: trim(env.IDP_BASE) };
});

let current: RuntimeConfig = { apiBase: '', idpBase: '' };

export function setRuntimeConfig(c: RuntimeConfig): void {
  current = c;
}

export function runtimeConfig(): RuntimeConfig {
  return current;
}
