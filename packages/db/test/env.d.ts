declare namespace Cloudflare {
  interface Env {
    TEST_DB: DurableObjectNamespace<import('./worker').TestDb>;
  }
}
