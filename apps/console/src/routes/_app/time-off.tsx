// Time off: what's recorded in a date range (GET /time-off) and a form to record more (POST /time-off). A sick call
// (`immediate`) vacates the person's overlapping desk shifts at once (§3A.11.2); the API reports which.
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { columnHelper, DataTable } from '../../components/DataTable';
import { Dialog } from '../../components/Dialog';
import { ProblemNotice, QueryView } from '../../components/Problem';
import { api } from '../../lib/api';
import { peopleQuery, timeOffQuery } from '../../lib/queries';
import { addDays, formatDateTime, fromZoned, isDate, today } from '../../lib/time';
import type { TimeOff, TimeOffReason, TimeOffResult } from '../../lib/types';

export const Route = createFileRoute('/_app/time-off')({
  validateSearch: (s: Record<string, unknown>): { from?: string; to?: string } => ({
    ...(isDate(s.from) ? { from: s.from } : {}),
    ...(isDate(s.to) ? { to: s.to } : {}),
  }),
  component: TimeOffPage,
});

const h = columnHelper<TimeOff>();
const columns = h.columns([
  h.accessor('name', { header: 'Person', sortFn: 'text', cell: (c) => <span className="cell-strong">{c.getValue()}</span> }),
  h.accessor('start', { header: 'From', cell: (c) => formatDateTime(c.getValue()) }),
  h.accessor('end', { header: 'To', cell: (c) => formatDateTime(c.getValue()) }),
  h.accessor('reason', { header: 'Reason', cell: (c) => <span className={`badge reason-${c.getValue()}`}>{c.getValue()}</span> }),
  h.accessor('state', { header: 'State', cell: (c) => <span className={`state state-${c.getValue()}`}>{c.getValue()}</span> }),
]);

function TimeOffPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const from = search.from ?? addDays(today(), -14);
  const to = search.to ?? addDays(today(), 60);
  const list = useQuery(timeOffQuery(fromZoned(from), fromZoned(addDays(to, 1))));
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ name: string; r: TimeOffResult } | null>(null);

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Time off</h1>
          <p className="muted">Vacation, personal days and sick calls · times in New York</p>
        </div>
        <div className="toolbar">
          <label className="field inline"><span>From</span>
            <input type="date" value={from} onChange={(e) => isDate(e.target.value) && void navigate({ search: (s) => ({ ...s, from: e.target.value }) })} />
          </label>
          <label className="field inline"><span>To</span>
            <input type="date" value={to} onChange={(e) => isDate(e.target.value) && void navigate({ search: (s) => ({ ...s, to: e.target.value }) })} />
          </label>
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Record time off</button>
        </div>
      </header>

      {result && (
        <div className="toast" role="status">
          Recorded time off for {result.name} ({result.r.state}).{' '}
          {result.r.vacated.length > 0
            ? `${result.r.vacated.length} desk shift${result.r.vacated.length === 1 ? ' was' : 's were'} vacated and need${result.r.vacated.length === 1 ? 's' : ''} cover.`
            : 'No shifts were affected.'}
          <button type="button" className="icon-btn" onClick={() => setResult(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <QueryView query={list}>
        {(d) => <DataTable columns={columns} data={d.items} empty="No time off in this range." />}
      </QueryView>

      <Dialog open={open} onClose={() => setOpen(false)} title="Record time off">
        {open && <TimeOffForm onDone={(name, r) => { setOpen(false); setResult({ name, r }); }} />}
      </Dialog>
    </section>
  );
}

function TimeOffForm({ onDone }: { onDone: (name: string, r: TimeOffResult) => void }) {
  const qc = useQueryClient();
  const people = useQuery(peopleQuery());
  const save = useMutation({
    mutationFn: (body: { resource_id: string; start: number; end: number; reason: TimeOffReason; immediate: boolean }) =>
      api<TimeOffResult>('/time-off', { method: 'POST', body }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['time-off'] }), qc.invalidateQueries({ queryKey: ['shifts'] })]),
  });
  const d = today();
  const form = useForm({
    defaultValues: {
      resource_id: '', reason: 'vacation' as TimeOffReason, startDate: d, startTime: '00:00', endDate: d, endTime: '23:59', immediate: false,
    },
    onSubmit: async ({ value }) => {
      const r = await save.mutateAsync({
        resource_id: value.resource_id,
        start: fromZoned(value.startDate, value.startTime),
        end: fromZoned(value.endDate, value.endTime),
        reason: value.reason,
        immediate: value.immediate,
      }).catch(() => null);
      if (r) onDone(people.data?.items.find((p) => p.id === value.resource_id)?.name ?? 'them', r);
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
      <form.Field name="resource_id" validators={{ onSubmit: ({ value }) => (value ? undefined : 'Choose a person') }}>
        {(f) => (
          <label className="field">
            <span>Person</span>
            <QueryView query={people}>
              {(p) => (
                <select value={f.state.value} onChange={(e) => f.handleChange(e.target.value)}>
                  <option value="">Choose…</option>
                  {[...p.items].sort((a, b) => a.name.localeCompare(b.name)).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.roles.join(', ')}</option>)}
                </select>
              )}
            </QueryView>
            {f.state.meta.errors.length > 0 && <span className="field-error">{f.state.meta.errors.join(', ')}</span>}
          </label>
        )}
      </form.Field>

      <form.Field
        name="reason"
        listeners={{ onChange: ({ value }) => form.setFieldValue('immediate', value === 'sick') }}
      >
        {(f) => (
          <label className="field">
            <span>Reason</span>
            <select value={f.state.value} onChange={(e) => f.handleChange(e.target.value as TimeOffReason)}>
              <option value="vacation">Vacation</option>
              <option value="personal">Personal</option>
              <option value="sick">Sick</option>
            </select>
          </label>
        )}
      </form.Field>

      <div className="field-row">
        <form.Field name="startDate">
          {(f) => <label className="field"><span>From</span><input type="date" required value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></label>}
        </form.Field>
        <form.Field name="startTime">
          {(f) => <label className="field"><span>at</span><input type="time" required value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></label>}
        </form.Field>
      </div>
      <div className="field-row">
        <form.Field
          name="endDate"
          validators={{
            onChangeListenTo: ['startDate', 'startTime', 'endTime'],
            onSubmit: ({ value, fieldApi }) => {
              const v = fieldApi.form.state.values;
              return fromZoned(value, v.endTime) <= fromZoned(v.startDate, v.startTime) ? 'Must end after it starts' : undefined;
            },
          }}
        >
          {(f) => (
            <label className="field"><span>To</span><input type="date" required value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} />
              {f.state.meta.errors.length > 0 && <span className="field-error">{f.state.meta.errors.join(', ')}</span>}
            </label>
          )}
        </form.Field>
        <form.Field name="endTime">
          {(f) => <label className="field"><span>at</span><input type="time" required value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></label>}
        </form.Field>
      </div>

      <form.Field name="immediate">
        {(f) => (
          <label className="check">
            <input type="checkbox" checked={f.state.value} onChange={(e) => f.handleChange(e.target.checked)} />
            <span>Sick call: vacate their shifts in this time straight away</span>
          </label>
        )}
      </form.Field>

      {save.isError && <ProblemNotice error={save.error} title="Time off refused" />}

      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(submitting) => (
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving…' : 'Record time off'}</button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
