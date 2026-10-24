// kairos-ci: CI on Cloudflare. A Workflow per commit resolves the commit in Artifacts, mints a short-lived read token,
// runs the repo's checks in a fresh Container, stores the log and result in R2, and revokes the token.
// Triggers: a cron poll of the watched branches (Artifacts has no push events), and POST /runs.
import { Container, getContainer } from '@cloudflare/containers';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export interface Env {
  ARTIFACTS: Artifacts;
  CI: Workflow<RunParams>;
  CI_RUNNER: DurableObjectNamespace<CiRunner>;
  CI_RESULTS: R2Bucket;
  REPO: string;                 // "agentic-platform"
  WATCH_BRANCHES: string;       // comma-separated
  CI_TRIGGER_TOKEN?: string;    // bearer for POST /runs (Worker secret)
}

export interface RunParams {
  branch: string;
  sha: string;
  trigger: 'poll' | 'manual';
}

export interface StepResult { name: string; ok: boolean; code: number | null; ms: number; skipped?: boolean }

export interface RunRecord {
  id: string;
  branch: string;
  sha: string;
  subject: string;
  trigger: RunParams['trigger'];
  state: 'running' | 'passed' | 'failed' | 'error';
  steps: StepResult[];
  started_at: number;
  finished_at: number | null;
  log_key: string | null;
  error?: string;
}

const RUN_TIMEOUT_MS = 45 * 60_000;
const POLL = '15 seconds';

/** One container instance per run. Internet access is needed for pnpm install and the Artifacts clone. */
export class CiRunner extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = '15m';
  override enableInternet = true;
}

export const branchKey = (branch: string) => `branches/${encodeURIComponent(branch)}.json`;
export const runKey = (id: string) => `runs/${id}.json`;
export const instanceId = (sha: string, trigger: RunParams['trigger'], now = Date.now()) =>
  trigger === 'poll' ? `poll-${sha}` : `manual-${sha.slice(0, 12)}-${now}`;

async function saveRecord(env: Env, r: RunRecord): Promise<void> {
  const body = JSON.stringify(r);
  await env.CI_RESULTS.put(runKey(r.id), body, { httpMetadata: { contentType: 'application/json' } });
  await env.CI_RESULTS.put(branchKey(r.branch), body, { httpMetadata: { contentType: 'application/json' } });
}

export class CiWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<RunRecord> {
    const { branch, sha, trigger } = event.payload;
    const id = event.instanceId;
    const startedAt = Date.now();

    const commit = await step.do('resolve commit', async () => {
      using repo = await this.env.ARTIFACTS.get(this.env.REPO);
      const info = await repo.info();
      const c = await repo.readCommit(sha);
      if (!c) throw new Error(`commit ${sha} not found in ${this.env.REPO}`);
      return { remote: info.remote, subject: c.message.split('\n')[0] ?? '' };
    });

    const base: RunRecord = {
      id, branch, sha, subject: commit.subject, trigger, state: 'running', steps: [], started_at: startedAt, finished_at: null, log_key: null,
    };
    await step.do('record start', () => saveRecord(this.env, base));

    // A read token that outlives the run's timeout but not much more; revoked at the end either way.
    const token = await step.do('mint read token', async () => {
      using repo = await this.env.ARTIFACTS.get(this.env.REPO);
      const t = await repo.createToken('read', Math.ceil(RUN_TIMEOUT_MS / 1000) + 600);
      return { id: t.id, plaintext: t.plaintext };
    });

    const runner = () => getContainer(this.env.CI_RUNNER, id);
    let result: RunRecord;
    try {
      await step.do('start runner', { retries: { limit: 2, delay: '10 seconds', backoff: 'linear' } }, async () => {
        const res = await runner().fetch('http://runner/run', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remote: commit.remote, token: token.plaintext, sha }),
        });
        if (res.status !== 202 && res.status !== 409) throw new Error(`runner refused the job: HTTP ${res.status} ${await res.text()}`);
      });

      let status: { state: string; ok: boolean | null; steps: StepResult[] } = { state: 'running', ok: null, steps: [] };
      for (let i = 0; Date.now() - startedAt < RUN_TIMEOUT_MS; i++) {
        await step.sleep(`wait ${i}`, POLL);
        status = await step.do(`poll ${i}`, async () => {
          const res = await runner().fetch('http://runner/status');
          if (!res.ok) throw new Error(`runner status HTTP ${res.status}`);
          return (await res.json()) as typeof status;
        });
        if (status.state === 'done') break;
      }

      const logKey = `logs/${id}.log`;
      await step.do('store log', async () => {
        const res = await runner().fetch('http://runner/log');
        await this.env.CI_RESULTS.put(logKey, await res.text(), { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
      });

      result = {
        ...base, steps: status.steps, finished_at: Date.now(), log_key: logKey,
        state: status.state !== 'done' ? 'error' : status.ok ? 'passed' : 'failed',
        ...(status.state !== 'done' ? { error: `timed out after ${RUN_TIMEOUT_MS / 60_000} minutes` } : {}),
      };
    } catch (e) {
      result = { ...base, state: 'error', finished_at: Date.now(), error: e instanceof Error ? e.message : String(e) };
    } finally {
      await step.do('revoke token and stop runner', async () => {
        using repo = await this.env.ARTIFACTS.get(this.env.REPO);
        await repo.revokeToken(token.id).catch(() => false);
        await runner().destroy().catch(() => undefined);
      });
    }

    await step.do('record result', () => saveRecord(this.env, result));
    return result;
  }
}

// ---- HTTP: status page, JSON API, manual trigger ------------------------------------------------------------------

const json = (v: unknown, status = 200) => Response.json(v, { status });

async function latest(env: Env): Promise<(RunRecord | { branch: string; state: 'none' })[]> {
  return Promise.all(branches(env).map(async (b) => {
    const o = await env.CI_RESULTS.get(branchKey(b));
    return o ? ((await o.json()) as RunRecord) : { branch: b, state: 'none' as const };
  }));
}

const branches = (env: Env) => env.WATCH_BRANCHES.split(',').map((s) => s.trim()).filter(Boolean);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(rows: Awaited<ReturnType<typeof latest>>): string {
  const badge = (s: string) => ({ passed: '#1a7f37', failed: '#cf222e', error: '#9a6700', running: '#0969da' } as Record<string, string>)[s] ?? '#6e7781';
  const tr = rows.map((r) => 'sha' in r
    ? `<tr><td>${esc(r.branch)}</td><td><span style="color:${badge(r.state)}">●</span> ${r.state}</td><td><code>${r.sha.slice(0, 7)}</code> ${esc(r.subject)}</td>
       <td>${r.steps.map((s) => `${s.ok ? '✓' : s.skipped ? '–' : '✗'} ${s.name}`).join(' · ')}</td>
       <td>${r.log_key ? `<a href="/runs/${encodeURIComponent(r.id)}/log">log</a>` : ''}</td></tr>`
    : `<tr><td>${esc(r.branch)}</td><td>no runs yet</td><td></td><td></td><td></td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>kairos-ci</title>
<style>body{font:14px system-ui;margin:24px;color:#1f2328;background:#fff}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #d0d7de;text-align:left}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}td,th{border-color:#30363d}a{color:#58a6ff}}</style>
<h1>kairos-ci</h1><table><tr><th>Branch</th><th>State</th><th>Commit</th><th>Steps</th><th></th></tr>${tr}</table>`;
}

export async function startRun(env: Env, branch: string, trigger: RunParams['trigger']): Promise<{ id: string; sha: string; created: boolean } | null> {
  using repo = await env.ARTIFACTS.get(env.REPO);
  const head = (await repo.log({ ref: branch, limit: 1 }))[0];
  if (!head) return null;
  const id = instanceId(head.hash, trigger);
  try {
    await env.CI.create({ id, params: { branch, sha: head.hash, trigger } });
    return { id, sha: head.hash, created: true };
  } catch (e) {
    // a poll for a commit that already has a run: instance ids are unique, so this is the dedupe
    if (trigger === 'poll' && /already exists|duplicate/i.test(String(e))) return { id, sha: head.hash, created: false };
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(page(await latest(env)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/branches') return json({ items: await latest(env) });
    const m = /^\/runs\/([^/]+)(\/log)?$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const id = decodeURIComponent(m[1]!);
      if (m[2]) {
        const o = await env.CI_RESULTS.get(`logs/${id}.log`);
        return o ? new Response(o.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }) : json({ error: 'not found' }, 404);
      }
      const o = await env.CI_RESULTS.get(runKey(id));
      if (o) return new Response(o.body, { headers: { 'content-type': 'application/json' } });
      try {
        return json({ id, workflow: await (await env.CI.get(id)).status() });
      } catch {
        return json({ error: 'not found' }, 404);
      }
    }
    if (req.method === 'POST' && url.pathname === '/runs') {
      const auth = req.headers.get('authorization') ?? '';
      if (!env.CI_TRIGGER_TOKEN || auth !== `Bearer ${env.CI_TRIGGER_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const { branch } = (await req.json().catch(() => ({}))) as { branch?: string };
      if (!branch) return json({ error: 'branch is required' }, 400);
      const r = await startRun(env, branch, 'manual');
      return r ? json(r, 201) : json({ error: `branch ${branch} not found` }, 404);
    }
    return json({ error: 'not found' }, 404);
  },

  /** Artifacts has no push events, so watched branches are polled; a run starts once per new head commit. */
  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    const results = await Promise.allSettled(branches(env).map(async (b) => {
      const r = await startRun(env, b, 'poll');
      if (r?.created) console.log(JSON.stringify({ msg: 'ci run started', branch: b, sha: r.sha, id: r.id }));
      return r;
    }));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(JSON.stringify({ msg: 'ci poll failed', branch: branches(env)[i], error: String(r.reason) }));
    });
  },
} satisfies ExportedHandler<Env>;
