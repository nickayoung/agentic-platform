// kairos-ci runner. One job per container: POST /run starts it, GET /status reports progress, GET /log returns the
// full log. The read token arrives in the request body, is passed to git as an HTTP header, and never reaches the log.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';

const WORK = '/home/ci/work';
const MAX_LOG = 8 * 1024 * 1024;

/** Mirrors .github/workflows/ci.yml. */
const STEPS = [
  { name: 'install', cmd: 'pnpm install --frozen-lockfile' },
  { name: 'typecheck', cmd: 'pnpm typecheck' },
  { name: 'lint', cmd: 'pnpm lint' },
  { name: 'rule-tests', cmd: 'pnpm --filter eslint-plugin-kairos test' },
  { name: 'test', cmd: 'pnpm test' },
];

let job = null;   // { sha, state, steps, startedAt, finishedAt, ok }
let log = '';

const append = (s) => {
  log += s;
  if (log.length > MAX_LOG) log = '[…truncated…]\n' + log.slice(-MAX_LOG);
};

function sh(cmd, { cwd, env, redact = [] }) {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-o', 'pipefail', '-c', cmd], { cwd, env: { ...process.env, ...env } });
    const out = (b) => {
      let s = b.toString();
      for (const r of redact) if (r) s = s.split(r).join('[redacted]');
      append(s);
    };
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('close', (code) => resolve(code ?? 1));
  });
}

async function run({ remote, token, sha }) {
  job = { sha, state: 'running', steps: [], startedAt: Date.now(), finishedAt: null, ok: null };
  log = '';
  const step = async (name, cmd, opts) => {
    const t0 = Date.now();
    append(`\n::: ${name}\n`);
    const code = await sh(cmd, opts);
    job.steps.push({ name, ok: code === 0, code, ms: Date.now() - t0 });
    return code === 0;
  };
  try {
    await rm(WORK, { recursive: true, force: true });
    // clone and pin the exact commit; the token travels only in the header env var
    const auth = { GIT_AUTH_HEADER: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: '0' };
    let ok = await step('checkout',
      `git -c http.extraHeader="$GIT_AUTH_HEADER" clone --quiet --no-checkout "$REMOTE" ${WORK} && cd ${WORK} && ` +
      `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --quiet origin "$SHA" && git checkout --quiet --detach "$SHA" && git log -1 --oneline`,
      { cwd: '/home/ci', env: { ...auth, REMOTE: remote, SHA: sha }, redact: [token] });
    for (const s of STEPS) {
      if (!ok) { job.steps.push({ name: s.name, ok: false, code: null, ms: 0, skipped: true }); continue; }
      ok = await step(s.name, s.cmd, { cwd: WORK, env: {} });
    }
    job.ok = ok;
  } catch (e) {
    append(`\nrunner error: ${e?.stack ?? e}\n`);
    job.ok = false;
  } finally {
    job.state = 'done';
    job.finishedAt = Date.now();
  }
}

const body = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 64 * 1024) reject(new Error('body too large')); });
  req.on('end', () => resolve(s));
});

const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/status') return json(res, 200, job ?? { state: 'idle' });
    if (req.method === 'GET' && req.url === '/log') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(log); }
    if (req.method === 'POST' && req.url === '/run') {
      if (job && job.state === 'running') return json(res, 409, { error: 'a run is already in progress', sha: job.sha });
      const b = JSON.parse(await body(req));
      if (!/^[0-9a-f]{40}$/.test(b.sha ?? '') || !b.remote || !b.token) return json(res, 400, { error: 'remote, token and a 40-hex sha are required' });
      void run(b);
      return json(res, 202, { state: 'running', sha: b.sha });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(8080);
