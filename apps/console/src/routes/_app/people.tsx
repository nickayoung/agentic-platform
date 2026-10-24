// People: the staff directory as the API knows it (GET /people), filtered by role and studio.
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { columnHelper, DataTable } from '../../components/DataTable';
import { LocationPicker } from '../../components/Pickers';
import { QueryView } from '../../components/Problem';
import { locationsQuery, peopleQuery } from '../../lib/queries';
import type { Person } from '../../lib/types';

const ROLES = ['desk_staff', 'teacher'] as const;

export const Route = createFileRoute('/_app/people')({
  validateSearch: (s: Record<string, unknown>): { role?: string; location?: string; q?: string } => ({
    ...(typeof s.role === 'string' && (ROLES as readonly string[]).includes(s.role) ? { role: s.role } : {}),
    ...(typeof s.location === 'string' && s.location ? { location: s.location } : {}),
    ...(typeof s.q === 'string' && s.q ? { q: s.q } : {}),
  }),
  component: People,
});

const h = columnHelper<Person>();
const columns = h.columns([
  h.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (c) => (
      <div>
        <div className="cell-strong">{c.getValue()}</div>
        <div className="muted small">{c.row.original.email}</div>
      </div>
    ),
  }),
  h.accessor((p) => p.roles.join(', '), {
    id: 'roles',
    header: 'Roles',
    cell: (c) => <span className="chips">{c.row.original.roles.map((r) => <span key={r} className="role-chip">{r.replace('_', ' ')}</span>)}</span>,
  }),
  h.accessor((p) => p.location_keys.join(', '), {
    id: 'studios',
    header: 'Studios',
    cell: (c) => (c.row.original.location_keys.length ? <StudioNames keys={c.row.original.location_keys} /> : <span className="muted">—</span>),
  }),
  h.accessor('staff_key', { header: 'Staff key', cell: (c) => <code>{c.getValue()}</code> }),
  h.accessor('state', { header: 'State', cell: (c) => <span className={`state state-${c.getValue()}`}>{c.getValue()}</span> }),
]);

function People() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const people = useQuery(peopleQuery(search.role, search.location));

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">Staff from the directory, with their roles and studios</p>
        </div>
        <div className="toolbar">
          <label className="field inline">
            <span>Role</span>
            <select value={search.role ?? ''} onChange={(e) => void navigate({ search: (s) => ({ ...s, role: e.target.value || undefined }) })}>
              <option value="">All roles</option>
              <option value="desk_staff">Desk staff</option>
              <option value="teacher">Teachers</option>
            </select>
          </label>
          <LocationPicker allowAll value={search.location} onChange={(l) => void navigate({ search: (s) => ({ ...s, location: l }) })} />
          <input
            className="search"
            type="search"
            placeholder="Search by name"
            aria-label="Search by name"
            value={search.q ?? ''}
            onChange={(e) => void navigate({ search: (s) => ({ ...s, q: e.target.value || undefined }), replace: true })}
          />
        </div>
      </header>
      <QueryView query={people}>{(d) => <PeopleTable items={d.items} q={search.q} />}</QueryView>
    </section>
  );
}

function PeopleTable({ items, q }: { items: Person[]; q: string | undefined }) {
  const rows = useMemo(() => {
    const n = q?.trim().toLowerCase();
    return n ? items.filter((p) => p.name.toLowerCase().includes(n) || p.email.toLowerCase().includes(n)) : items;
  }, [items, q]);
  return (
    <>
      <p className="muted small">{rows.length} of {items.length} people</p>
      <DataTable columns={columns} data={rows} empty="No one matches these filters." />
    </>
  );
}

function StudioNames({ keys }: { keys: string[] }) {
  const locations = useQuery(locationsQuery());
  return <>{keys.map((k) => locations.data?.items.find((l) => l.key === k)?.name ?? k).join(', ')}</>;
}
