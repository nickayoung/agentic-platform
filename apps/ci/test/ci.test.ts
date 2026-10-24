import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { branchKey, instanceId, startRun, type Env, type RunRecord } from '../src/index';

const SHA = 'a'.repeat(40);

/** Fakes for the bindings the test runtime doesn't have (Artifacts, Workflows). R2 is real. */
function fakeEnv(heads: Record<string, string>) {
  const created: { id: string; params: unknown }[] = [];
  const e = {
    CI_RESULTS: env.CI_RESULTS,
    REPO: 'agentic-platform',
    WATCH_BRANCHES: 'main, feature/x',
    CI_TRIGGER_TOKEN: 'trigger-secret',
    ARTIFACTS: {
      async get() {
        return {
          [Symbol.dispose]() {},
          async log({ ref }: { ref: string }) { return heads[ref] ? [{ hash: heads[ref], message: 'm' }] : []; },
        };
      },
    },
    CI: {
      async create({ id, params }: { id: string; params: unknown }) {
        if (created.some((c) => c.id === id)) throw new Error(`instance ${id} already exists`);
        created.push({ id, params });
        return { id };
      },
      async get() { throw new Error('not found'); },
    },
  } as unknown as Env;
  return { e, created };
}

describe('kairos-ci', () => {
  it('a poll starts one run per new head commit; repeat polls are deduplicated by instance id', async () => {
    const { e, created } = fakeEnv({ main: SHA });
    expect(await startRun(e, 'main', 'poll')).toEqual({ id: `poll-${SHA}`, sha: SHA, created: true });
    expect(await startRun(e, 'main', 'poll')).toEqual({ id: `poll-${SHA}`, sha: SHA, created: false });
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toEqual({ branch: 'main', sha: SHA, trigger: 'poll' });
    expect(await startRun(e, 'nope', 'poll')).toBeNull();
  });

  it('manual runs always get a new instance', () => {
    expect(instanceId(SHA, 'manual', 1)).not.toBe(instanceId(SHA, 'manual', 2));
    expect(instanceId(SHA, 'poll')).toBe(`poll-${SHA}`);
  });

  it('the cron polls every watched branch', async () => {
    const { e, created } = fakeEnv({ main: SHA, 'feature/x': 'b'.repeat(40) });
    await worker.scheduled({} as ScheduledController, e);
    expect(created.map((c) => c.id).sort()).toEqual([`poll-${'a'.repeat(40)}`, `poll-${'b'.repeat(40)}`]);
  });

  it('a failing branch poll is logged, and the other branches still start', async () => {
    const { e, created } = fakeEnv({ 'feature/x': 'b'.repeat(40) });
    (e.ARTIFACTS as unknown as { get: () => Promise<unknown> }).get = (() => {
      let n = 0;
      return async () => {
        if (n++ === 0) throw new Error('artifacts unavailable');
        return { [Symbol.dispose]() {}, log: async () => [{ hash: 'b'.repeat(40), message: 'm' }] };
      };
    })();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => { errors.push(m); };
    try {
      await worker.scheduled({} as ScheduledController, e);
    } finally {
      console.error = orig;
    }
    expect(errors.some((m) => m.includes('ci poll failed') && m.includes('artifacts unavailable'))).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('POST /runs needs the trigger token', async () => {
    const { e } = fakeEnv({ main: SHA });
    const post = (auth?: string) => worker.fetch(new Request('https://ci.test/runs', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ branch: 'main' }),
    }), e);
    expect((await post()).status).toBe(401);
    expect((await post('Bearer wrong')).status).toBe(401);
    const ok = await post('Bearer trigger-secret');
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { sha: string }).sha).toBe(SHA);
  });

  it('the status page and API show the latest run per branch, escaping commit text', async () => {
    const { e } = fakeEnv({});
    const rec: RunRecord = {
      id: 'poll-x', branch: 'main', sha: SHA, subject: '<script>x</script>', trigger: 'poll', state: 'failed',
      steps: [{ name: 'typecheck', ok: true, code: 0, ms: 1 }, { name: 'test', ok: false, code: 1, ms: 2 }],
      started_at: 1, finished_at: 2, log_key: 'logs/poll-x.log',
    };
    await env.CI_RESULTS.put(branchKey('main'), JSON.stringify(rec));
    await env.CI_RESULTS.put('logs/poll-x.log', 'the log');
    const html = await (await worker.fetch(new Request('https://ci.test/'), e)).text();
    expect(html).toContain('failed');
    expect(html).toContain('✗ test');
    expect(html).not.toContain('<script>x');
    const api = (await (await worker.fetch(new Request('https://ci.test/api/branches'), e)).json()) as { items: { state: string }[] };
    expect(api.items.map((i) => i.state)).toEqual(['failed', 'none']);
    expect(await (await worker.fetch(new Request('https://ci.test/runs/poll-x/log'), e)).text()).toBe('the log');
  });
});
