// The console's API client (§19.14): fetch from the browser to the tenant API with the staff bearer token. Errors
// come back as application/problem+json and are thrown as ApiError so screens can show code, detail and reasons.
import { runtimeConfig } from './runtime-config';
import { clearSession, getSession } from './session';
import type { IdpUser, Items, Problem } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  readonly method: string;
  readonly path: string;

  constructor(status: number, problem: Problem, method: string, path: string) {
    super(problem.detail ?? problem.title ?? problem.code ?? `HTTP ${status}`);
    this.status = status;
    this.problem = problem;
    this.method = method;
    this.path = path;
  }

  get code(): string {
    return this.problem.code ?? `HTTP_${this.status}`;
  }
}

/**
 * A 404 for the route itself (the endpoint isn't deployed yet) rather than for a record. The API's not-found
 * handler puts the request path in `detail`.
 */
export function isUnavailable(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 404 && (!e.problem.detail || e.problem.detail.startsWith('/v1/'));
}

type Query = Record<string, string | number | undefined | null>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

function url(base: string, path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${base}${path}${s ? `?${s}` : ''}`;
}

async function send(base: string, path: string, o: RequestOptions, auth: boolean): Promise<Response> {
  const method = o.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...o.headers };
  if (o.body !== undefined) headers['content-type'] ??= 'application/json';
  const token = auth ? getSession()?.token : undefined;
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url(base, path, o.query), { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', detail: `Could not reach ${new URL(base).host} (offline, or the origin is not allowed by CORS)` }, method, path);
  }
  if (res.ok) return res;
  let problem: Problem = { status: res.status };
  try {
    const body = (await res.json()) as Problem & { error?: unknown };
    problem = { status: res.status, ...body };
    if (!problem.detail && typeof body.error === 'string') problem.detail = body.error; // the sign-in service's shape
  } catch {
    // not JSON
  }
  if (res.status === 401 && auth) clearSession();
  throw new ApiError(res.status, problem, method, path);
}

/** A JSON call against the tenant API (base URL from wrangler vars). */
export async function api<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const res = await send(runtimeConfig().apiBase, path, o, true);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A file download through the API with the bearer token (the browser can't attach it to a plain link). */
export async function downloadFile(path: string, o: RequestOptions, fallbackName: string): Promise<void> {
  const res = await send(runtimeConfig().apiBase, path, { ...o, headers: { accept: 'text/csv, */*', ...o.headers } }, true);
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Demo sign-in service (preview only). */
export const idp = {
  users: async () => (await (await send(runtimeConfig().idpBase, '/users', {}, false)).json()) as Items<IdpUser>,
  token: async (sub: string, password: string) =>
    (await (await send(runtimeConfig().idpBase, '/token', { method: 'POST', body: { sub, password } }, false)).json()) as {
      token: string;
      user: IdpUser;
    },
};
