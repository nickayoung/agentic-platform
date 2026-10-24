// Config (§6, manual path): the active version, its history, the domain modes, and the draft flow
// (paste YAML → draft → validate → submit → approve). Each step sends `If-Match` with the draft version it saw.
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { columnHelper, DataTable } from '../../components/DataTable';
import { DraftFlow } from '../../components/config/DraftFlow';
import { ProblemNotice, QueryView } from '../../components/Problem';
import { configActiveQuery, configVersionsQuery, domainModesQuery } from '../../lib/queries';
import { formatDateTime } from '../../lib/time';
import type { ConfigVersion, DomainMode } from '../../lib/types';

export const Route = createFileRoute('/_app/config')({
  validateSearch: (s: Record<string, unknown>): { draft?: string } =>
    typeof s.draft === 'string' && /^dft_[a-f0-9]{32}$/.test(s.draft) ? { draft: s.draft } : {},
  component: Config,
});

const v = columnHelper<ConfigVersion>();
const versionColumns = v.columns([
  v.accessor('number', { header: 'Version', cell: (c) => <span className="cell-strong">v{c.getValue()}</span> }),
  v.accessor('state', { header: 'State', cell: (c) => <span className={`state state-${c.getValue()}`}>{c.getValue()}</span> }),
  v.accessor('summary', { header: 'Summary', enableSorting: false }),
  v.accessor('published_at', { header: 'Published', cell: (c) => formatDateTime(c.getValue()) }),
  v.accessor('effective_from', { header: 'Effective', cell: (c) => formatDateTime(c.getValue()) }),
  v.accessor('content_hash', { header: 'Hash', enableSorting: false, cell: (c) => <code title={c.getValue()}>{c.getValue().slice(0, 10)}</code> }),
  v.accessor('rollback_of', { header: 'Rollback of', cell: (c) => (c.getValue() ? `v${c.getValue()}` : '') }),
]);

const m = columnHelper<DomainMode>();
const modeColumns = m.columns([
  m.accessor('domain', { header: 'Domain', cell: (c) => <span className="cell-strong">{c.getValue().replace(/_/g, ' ')}</span> }),
  m.accessor('mode', { header: 'Mode', cell: (c) => <span className={`badge mode-${c.getValue()}`}>{c.getValue()}</span> }),
  m.accessor('outside_system', { header: 'Outside system', cell: (c) => (c.getValue() ? <code>{c.getValue()}</code> : <span className="muted">—</span>) }),
  m.display({
    id: 'flags',
    header: 'Flags',
    cell: (c) => {
      const d = c.row.original;
      return (
        <span className="chips">
          {d.write_freeze && <span className="badge badge-danger">write freeze</span>}
          {d.retired && <span className="badge">retired</span>}
          {d.outbound_push && <span className="badge badge-accent">outbound push</span>}
        </span>
      );
    },
  }),
]);

function Config() {
  const search = Route.useSearch();
  const active = useQuery(configActiveQuery());
  const versions = useQuery(configVersionsQuery());
  const modes = useQuery(domainModesQuery());
  const activeVersion = versions.data?.items.find((x) => x.state === 'active');

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Config</h1>
          <p className="muted">The tenant’s configuration: what’s live, its history, and changes in review</p>
        </div>
      </header>

      <div className="cards">
        <article className="card">
          <h2>Active version</h2>
          {active.isError ? <ProblemNotice error={active.error} /> : active.data ? (
            <dl className="facts-list">
              <div><dt>Version</dt><dd className="big">v{active.data.number}</dd></div>
              <div><dt>Epoch</dt><dd>{active.data.epoch}</dd></div>
              <div><dt>Content hash</dt><dd><code title={active.data.content_hash}>{active.data.content_hash.slice(0, 16)}…</code></dd></div>
              {activeVersion && <div><dt>Published</dt><dd>{formatDateTime(activeVersion.published_at)}</dd></div>}
              {activeVersion && <div className="wide"><dt>Summary</dt><dd>{activeVersion.summary}</dd></div>}
              <div className="wide"><dt>Contents</dt><dd className="muted small">{Object.keys(active.data.document).sort().join(' · ')}</dd></div>
            </dl>
          ) : <div className="skeleton" />}
        </article>
        <article className="card">
          <h2>Domain modes</h2>
          <p className="muted small">Which system is the record for each domain while Kairos takes over (§18.5).</p>
          <QueryView query={modes}>{(d) => <DataTable columns={modeColumns} data={d.items} empty="No domains." />}</QueryView>
        </article>
      </div>

      <article className="card">
        <h2>Versions</h2>
        <QueryView query={versions}>{(d) => <DataTable columns={versionColumns} data={d.items} empty="Nothing published yet." />}</QueryView>
      </article>

      <article className="card">
        <h2>Change the config</h2>
        <DraftFlow draftId={search.draft} />
      </article>
    </section>
  );
}
