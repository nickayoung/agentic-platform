// The deployable Worker. It serves the public API and hosts the Durable Object classes; the classes live in their
// own packages (§19.15).
import { ControlPlane } from '@kairos/control';
import { TenantCore } from '@kairos/core';
import { buildApp, coreStub } from './app';
import { controlStub, type Env } from './env';

export { ControlPlane, TenantCore };

const app = buildApp();

export default {
  fetch: app.fetch,
  /** Backstop cron, every 5 minutes (§19.5): re-arm any tenant object whose alarm is missing. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const slugs = await controlStub(env).listActive();
    ctx.waitUntil(Promise.allSettled(slugs.map(async (slug) => {
      const scope = { tenant: slug, env: env.ENVIRONMENT };
      const r = await coreStub(env, scope).ensureAlarm(scope);
      if (r.wasMissing) console.warn(JSON.stringify({ msg: 'alarm_missing', tenant: slug, env: env.ENVIRONMENT }));
    })));
  },
} satisfies ExportedHandler<Env>;
