// Hours: worked time for a pay period (GET /hours), approval, and the Gusto employee CSV a manager uploads to
// Gusto (§18.8). Pay periods are biweekly from 2027-03-01, but any start date can be picked.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { columnHelper, DataTable } from '../../components/DataTable';
import { PeriodNav } from '../../components/Pickers';
import { ProblemNotice, QueryView } from '../../components/Problem';
import { api, downloadFile } from '../../lib/api';
import { hoursQuery, locationsQuery } from '../../lib/queries';
import { addDays, formatDay, formatTime, fromZoned, isDate, payPeriodStart, today, zoned } from '../../lib/time';
import type { HoursRecord } from '../../lib/types';

const ANCHOR = '2027-03-01';
const periodOf = (d: string) => payPeriodStart(d, ANCHOR);

export const Route = createFileRoute('/_app/hours')({
  validateSearch: (s: Record<string, unknown>): { period?: string } => (isDate(s.period) ? { period: s.period } : {}),
  component: Hours,
});

const hrs = (minutes: number) => (minutes / 60).toFixed(2);

function Hours() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const period = search.period ?? periodOf(today());
  const from = fromZoned(period);
  const to = fromZoned(addDays(period, 14));
  const hours = useQuery(hoursQuery(from, to));
  const [download, setDownload] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });

  const getCsv = async () => {
    setDownload({ busy: true, error: null });
    try {
      await downloadFile('/hours/export', { query: { period_start: period } }, `gusto-hours-${period}.csv`);
      setDownload({ busy: false, error: null });
    } catch (e) {
      setDownload({ busy: false, error: e });
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Hours</h1>
          <p className="muted">Pay period {formatDay(period)} – {formatDay(addDays(period, 13))} · biweekly from {formatDay(ANCHOR)}, {ANCHOR.slice(0, 4)}</p>
        </div>
        <div className="toolbar">
          <PeriodNav
            start={period}
            step={14}
            label="pay period"
            todayStart={periodOf}
            pick={(d) => d}
            onChange={(p) => void navigate({ search: { period: p } })}
          />
          <button type="button" className="btn btn-primary" onClick={() => void getCsv()} disabled={download.busy}>
            {download.busy ? 'Preparing…' : 'Download Gusto CSV'}
          </button>
        </div>
      </header>
      {download.error !== null && <ProblemNotice error={download.error} title="Couldn’t export the CSV" />}
      <QueryView query={hours}>{(d) => <HoursTable items={d.items} />}</QueryView>
    </section>
  );
}

function HoursTable({ items }: { items: HoursRecord[] }) {
  const qc = useQueryClient();
  const locations = useQuery(locationsQuery());
  const approve = useMutation({
    mutationFn: (id: string) => api<HoursRecord>(`/hours/${id}/approve`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hours'] }),
  });
  const studio = (k: string) => locations.data?.items.find((l) => l.key === k)?.name ?? k;

  const columns = useMemo(() => {
    const h = columnHelper<HoursRecord>();
    return h.columns([
      h.accessor('name', { header: 'Person', sortFn: 'text', cell: (c) => <span className="cell-strong">{c.getValue()}</span> }),
      h.accessor('start', { header: 'Date', cell: (c) => formatDay(zoned(c.getValue()).date) }),
      h.accessor((r) => r.end - r.start, { id: 'time', header: 'Time', enableSorting: false, cell: (c) => `${formatTime(c.row.original.start)} – ${formatTime(c.row.original.end)}` }),
      h.accessor('kind', { header: 'Kind', cell: (c) => <span className="badge">{c.getValue().replace('_', ' ')}</span> }),
      h.accessor('location_key', { header: 'Studio', cell: (c) => studio(c.getValue()) }),
      h.accessor('minutes', { header: 'Hours', cell: (c) => <span className="num">{hrs(c.getValue())}</span> }),
      h.accessor('state', { header: 'State', cell: (c) => <span className={`state state-${c.getValue()}`}>{c.getValue()}</span> }),
      h.display({
        id: 'approve',
        header: '',
        cell: (c) => {
          const r = c.row.original;
          if (r.state === 'approved') return <span className="muted small">Approved</span>;
          const busy = approve.isPending && approve.variables === r.id;
          return <button type="button" className="btn btn-small" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>{busy ? 'Approving…' : 'Approve'}</button>;
        },
      }),
    ]);
    // rebuilt only when approval progress or studio names change
  }, [approve.isPending, approve.variables, locations.data]);

  const total = items.reduce((n, r) => n + r.minutes, 0);
  const pending = items.filter((r) => r.state !== 'approved').length;
  return (
    <div className="stack">
      <div className="summary-row">
        <span className="stat">{items.length} records</span>
        <span className="stat">{hrs(total)} hours</span>
        <span className={pending ? 'stat stat-warn' : 'stat stat-ok'}>{pending ? `${pending} awaiting approval` : 'All approved'}</span>
      </div>
      {approve.isError && <ProblemNotice error={approve.error} title="Approval refused" />}
      <DataTable columns={columns} data={items} empty="No hours recorded in this period." />
    </div>
  );
}
