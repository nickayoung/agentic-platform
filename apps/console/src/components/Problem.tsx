// How the console shows API answers that aren't data: refusals with their reason codes, missing endpoints,
// missing access and network failures. The API is authoritative; this only renders what it said.
import type { UseQueryResult } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, isUnavailable } from '../lib/api';
import { formatDateTime } from '../lib/time';
import type { Problem } from '../lib/types';

export function ProblemNotice({ error, title }: { error: unknown; title?: string }) {
  if (isUnavailable(error)) {
    return (
      <div className="notice notice-muted" role="status">
        <strong>Not available yet</strong>
        <p>
          <code>{error.method} {error.path}</code> isn't deployed on this API yet. This view fills in as soon as it is.
        </p>
      </div>
    );
  }
  if (!(error instanceof ApiError)) {
    return (
      <div className="notice notice-error" role="alert">
        <strong>{title ?? 'Something went wrong'}</strong>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>
    );
  }
  const p = error.problem;
  const heading = title ?? (error.status === 403 ? 'You don’t have access to this' : error.status === 401 ? 'Signed out' : 'Refused');
  return (
    <div className="notice notice-error" role="alert">
      <div className="notice-head">
        <strong>{heading}</strong>
        <span className="code-chip">{error.code}</span>
      </div>
      {p.detail && <p className="notice-detail">{p.detail}</p>}
      {!!p.reasons?.length && <Reasons reasons={p.reasons} topCode={error.code} detail={p.detail} />}
      {!!p.issues?.length && (
        <ul className="reasons">
          {p.issues.map((x, i) => <li key={i}>{x.path?.join('.') ?? ''} {x.message}</li>)}
        </ul>
      )}
      {!!p.alternatives?.length && <p className="muted small">{p.alternatives.length} alternative(s) offered by the API.</p>}
    </div>
  );
}

const SHOWN = 6;
const show = (v: unknown) =>
  typeof v === 'number' && v > 1e12 && v < 1e13 ? formatDateTime(v) // UTC ms
    : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);

/** Each reason: its message (unless it repeats the detail), its code when it differs, and any facts or locators (e.g. config_path). */
function Reasons({ reasons, topCode, detail }: { reasons: NonNullable<Problem['reasons']>; topCode: string; detail: string | undefined }) {
  const [all, setAll] = useState(false);
  const list = all ? reasons : reasons.slice(0, SHOWN);
  return (
    <>
      <ul className="reasons">
        {list.map(({ code, message, facts, ...extra }, i) => (
          <li key={i}>
            {Object.keys(extra).length > 0 && <code className="reason-where">{Object.values(extra).map(show).join(' ')}</code>}
            {message === detail ? null : message ?? code}
            {code !== topCode && <> <span className="code-chip small">{code}</span></>}
            {facts && Object.keys(facts).length > 0 && (
              <span className="facts">{Object.entries(facts).map(([k, v]) => `${k}: ${show(v)}`).join(' · ')}</span>
            )}
          </li>
        ))}
      </ul>
      {reasons.length > SHOWN && (
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${reasons.length} reasons`}
        </button>
      )}
    </>
  );
}

/** Loading, error or data for one query. */
export function QueryView<T>({ query, children, skeleton }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: ReactNode }) {
  if (query.isPending) return <>{skeleton ?? <div className="skeleton" aria-busy="true" aria-label="Loading" />}</>;
  if (query.isError) return <ProblemNotice error={query.error} />;
  return <>{children(query.data)}</>;
}
