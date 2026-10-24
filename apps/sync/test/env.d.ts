declare namespace Cloudflare {
  interface Env {
    TENANT_SYNC: DurableObjectNamespace<import('../src/index').TenantSync>;
  }
}
