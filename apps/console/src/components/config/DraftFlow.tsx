// The config draft flow: create from pasted YAML, validate (L1–L4 issues), submit, then approve with a summary or
// reject. The draft id sits in the URL so a reload keeps your place; every write sends If-Match with its version.
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../lib/api';
import { draftQuery } from '../../lib/queries';
import type { ConfigDraft, ConfigVersion, ValidationIssue } from '../../lib/types';
import { columnHelper, DataTable } from '../DataTable';
import { ProblemNotice, QueryView } from '../Problem';

const STEPS = [
  { key: 'editing', label: 'Draft' },
  { key: 'validated', label: 'Validated' },
  { key: 'awaiting_approval', label: 'Submitted' },
  { key: 'published', label: 'Published' },
] as const;

const i = columnHelper<ValidationIssue>();
const issueColumns = i.columns([
  i.accessor('severity', { header: 'Severity', cell: (c) => <span className={`badge sev-${c.getValue()}`}>{c.getValue()}</span> }),
  i.accessor('layer', { header: 'Layer' }),
  i.accessor('code', { header: 'Code', cell: (c) => <code>{c.getValue()}</code> }),
  i.accessor('path', { header: 'Path', cell: (c) => <code className="path">{c.getValue()}</code> }),
  i.accessor('message', { header: 'Message', enableSorting: false }),
]);

export function DraftFlow({ draftId }: { draftId: string | undefined }) {
  return draftId ? <DraftView id={draftId} /> : <NewDraft />;
}

function NewDraft() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (yaml: string) => api<ConfigDraft>('/config/drafts', { method: 'POST', body: { yaml } }),
    onSuccess: (d) => {
      qc.setQueryData(draftQuery(d.id).queryKey, d);
      void navigate({ to: '/config', search: { draft: d.id } });
    },
  });
  const form = useForm({
    defaultValues: { yaml: '' },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value.yaml).catch(() => undefined);
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <p className="muted">Paste a complete config document in YAML. Kairos keeps it as a draft until it is validated, submitted and approved; nothing changes before then.</p>
      <form.Field name="yaml" validators={{ onSubmit: ({ value }) => (value.trim() ? undefined : 'Paste the YAML first') }}>
        {(f) => (
          <label className="field">
            <span>Config YAML</span>
            <textarea className="code-input" rows={14} spellCheck={false} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder="schema_version: …" />
            {f.state.meta.errors.length > 0 && <span className="field-error">{f.state.meta.errors.join(', ')}</span>}
          </label>
        )}
      </form.Field>
      {create.isError && <ProblemNotice error={create.error} title="Draft refused" />}
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(busy) => <div className="actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button></div>}
      </form.Subscribe>
    </form>
  );
}

type Action = { kind: 'validate' } | { kind: 'submit' } | { kind: 'approve'; summary: string } | { kind: 'reject'; reason: string };

function DraftView({ id }: { id: string }) {
  const qc = useQueryClient();
  const draft = useQuery(draftQuery(id));
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');

  const act = useMutation({
    mutationFn: async (a: Action): Promise<ConfigDraft | ConfigVersion> => {
      const d = draft.data!;
      const ifMatch = { 'if-match': `"${d.version}"` };
      const base = `/config/drafts/${id}`;
      switch (a.kind) {
        case 'validate': return api<ConfigDraft>(`${base}/validate`, { method: 'POST' });
        case 'submit': return api<ConfigDraft>(`${base}/submit`, { method: 'POST', headers: ifMatch });
        case 'approve': return api<ConfigVersion>(`${base}/approve`, { method: 'POST', headers: ifMatch, body: { summary: a.summary } });
        case 'reject': return api<ConfigDraft>(`${base}/reject`, { method: 'POST', headers: ifMatch, body: { reason: a.reason } });
      }
    },
    onSuccess: async (r, a) => {
      if (a.kind === 'approve') {
        await Promise.all([qc.invalidateQueries({ queryKey: ['config'] }), qc.invalidateQueries({ queryKey: ['locations'] })]);
      } else {
        qc.setQueryData(draftQuery(id).queryKey, r as ConfigDraft);
      }
    },
    onError: () => qc.invalidateQueries({ queryKey: draftQuery(id).queryKey }), // e.g. a stale If-Match: show the current draft
  });

  return (
    <QueryView query={draft}>
      {(d) => {
        const stepIndex = d.state === 'abandoned' ? -1 : STEPS.findIndex((s) => s.key === d.state);
        const issues = d.validation?.issues ?? [];
        const errors = issues.filter((x) => x.severity === 'error').length;
        const busy = act.isPending;
        const last = act.variables?.kind;
        return (
          <div className="stack">
            <div className="draft-head">
              <div>
                <div className="muted small">Draft</div>
                <code>{d.id}</code>
              </div>
              <div><div className="muted small">Based on</div>{d.base_number ? `v${d.base_number}` : 'nothing'}</div>
              <div><div className="muted small">Version (If-Match)</div>{d.version}</div>
              <Link to="/config" search={{}} className="btn btn-ghost">Start another draft</Link>
            </div>

            <ol className="stepper">
              {STEPS.map((s, n) => (
                <li key={s.key} className={n < stepIndex ? 'done' : n === stepIndex ? 'current' : ''}>{s.label}</li>
              ))}
              {d.state === 'abandoned' && <li className="current rejected">Rejected</li>}
            </ol>

            {act.isError && <ProblemNotice error={act.error} title={`Couldn’t ${last ?? 'do that'}`} />}

            {d.validation && (
              <div className="stack">
                <div className={d.validation.ok ? 'notice notice-ok' : 'notice notice-error'}>
                  <strong>{d.validation.ok ? 'Validation passed' : 'Validation failed'}</strong>
                  <p>{issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}.` : 'No issues.'}</p>
                </div>
                {issues.length > 0 && <DataTable columns={issueColumns} data={issues} />}
              </div>
            )}

            {(d.state === 'editing' || d.state === 'validated') && (
              <div className="actions">
                <button type="button" className="btn" disabled={busy} onClick={() => act.mutate({ kind: 'validate' })}>
                  {busy && last === 'validate' ? 'Validating…' : d.validation ? 'Validate again' : 'Validate'}
                </button>
                <button type="button" className="btn btn-primary" disabled={busy || !d.validation?.ok} onClick={() => act.mutate({ kind: 'submit' })}
                  title={d.validation?.ok ? undefined : 'Validate without errors first'}>
                  {busy && last === 'submit' ? 'Submitting…' : 'Submit for approval'}
                </button>
              </div>
            )}

            {d.state === 'awaiting_approval' && (
              <div className="stack">
                <div className="notice notice-muted">
                  <strong>Preview before approving</strong>
                  <p>
                    {d.impact?.groups.length
                      ? `${d.impact.groups.length} impact group${d.impact.groups.length === 1 ? '' : 's'}: existing sessions or bookings this change touches.`
                      : 'No impact on existing sessions or bookings.'}
                  </p>
                  {!!d.impact?.groups.length && <pre className="json">{JSON.stringify(d.impact.groups, null, 2)}</pre>}
                </div>
                <div className="field-row">
                  <label className="field grow">
                    <span>Summary for the version history</span>
                    <input value={summary} maxLength={500} onChange={(e) => setSummary(e.target.value)} placeholder="What changes and why" />
                  </label>
                  <button type="button" className="btn btn-primary align-end" disabled={busy || !summary.trim()} onClick={() => act.mutate({ kind: 'approve', summary: summary.trim() })}>
                    {busy && last === 'approve' ? 'Publishing…' : 'Approve and publish'}
                  </button>
                </div>
                <div className="field-row">
                  <label className="field grow">
                    <span>Or reject, with a reason</span>
                    <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Why this can’t go live" />
                  </label>
                  <button type="button" className="btn btn-danger align-end" disabled={busy || !reason.trim()} onClick={() => act.mutate({ kind: 'reject', reason: reason.trim() })}>
                    {busy && last === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>
                </div>
              </div>
            )}

            {d.state === 'published' && <div className="notice notice-ok"><strong>Published.</strong> <p>This draft is now a config version; see Versions above.</p></div>}
            {d.state === 'abandoned' && <div className="notice notice-muted"><strong>Rejected.</strong> <p>This draft won’t go live. Start another draft to try again.</p></div>}
          </div>
        );
      }}
    </QueryView>
  );
}
