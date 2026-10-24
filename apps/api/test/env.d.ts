import type { Env as ApiEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      KEK: SecretsStoreSecret;
    }
  }
}
export {};
