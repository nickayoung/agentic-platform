declare namespace Cloudflare {
  interface Env {
    TENANT_CORE: DurableObjectNamespace<import('../src/index').TenantCore>;
    ARCHIVE: R2Bucket;
  }
}
