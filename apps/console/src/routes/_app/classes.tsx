// Classes: the week's timetable as mirrored from BookingVendor (GET /sessions). Read-only while classes are in
// mirror mode; a conflicted class is one the mirror and Kairos disagree about.
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { LocationPicker, PeriodNav } from '../../components/Pickers';
import { ProblemNotice } from '../../components/Problem';
import { WeekGrid } from '../../components/WeekGrid';
import { locationsQuery, sessionsQuery } from '../../lib/queries';
import { addDays, formatTime, fromZoned, isDate, mondayOf, today, zoned } from '../../lib/time';

export const Route = createFileRoute('/_app/classes')({
  validateSearch: (s: Record<string, unknown>): { location?: string; week?: string } => ({
    ...(typeof s.location === 'string' && s.location ? { location: s.location } : {}),
    ...(isDate(s.week) ? { week: mondayOf(s.week) } : {}),
  }),
  component: Classes,
});

function Classes() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = search.week ?? mondayOf(today());
  const from = fromZoned(week);
  const to = fromZoned(addDays(week, 7));
  const sessions = useQuery(sessionsQuery(from, to, search.location));
  const locations = useQuery(locationsQuery());
  const studio = (k: string) => locations.data?.items.find((l) => l.key === k)?.name ?? k;
  const items = sessions.data?.items ?? [];
  const conflicted = items.filter((s) => s.conflicted).length;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Classes</h1>
          <p className="muted">Timetable mirrored from BookingVendor · times in New York</p>
        </div>
        <div className="toolbar">
          <LocationPicker allowAll value={search.location} onChange={(l) => void navigate({ search: (s) => ({ ...s, location: l }) })} />
          <PeriodNav start={week} step={7} label="week" todayStart={mondayOf} onChange={(w) => void navigate({ search: (s) => ({ ...s, week: w }) })} />
        </div>
      </header>

      {sessions.isError ? (
        <ProblemNotice error={sessions.error} />
      ) : (
        <>
          <div className="summary-row">
            {sessions.data ? (
              <>
                <span className="stat">{items.length} classes</span>
                {conflicted > 0 && <span className="stat stat-warn">{conflicted} conflicted</span>}
              </>
            ) : <span className="muted">Loading the week…</span>}
          </div>
          <WeekGrid
            monday={week}
            loading={sessions.isPending}
            renderDay={(d) => {
              const list = items.filter((s) => zoned(s.start).date === d).sort((a, b) => a.start - b.start);
              if (!list.length) return <p className="day-empty">No classes</p>;
              return list.map((s) => (
                <article key={s.id} className={`class-card${s.conflicted ? ' conflicted' : ''}${s.status === 'cancelled' ? ' cancelled' : ''}`}>
                  <span className="slot-time">{formatTime(s.start)} – {formatTime(s.end)}</span>
                  <span className="slot-name">{s.name}</span>
                  <span className="class-teacher">{s.teacher?.name ?? <em className="muted">No teacher</em>}</span>
                  <span className="class-foot">
                    {!search.location && <span className="muted small">{studio(s.location_key)}</span>}
                    {s.source === 'mirror' ? <span className="badge" title="Mirrored from BookingVendor">mirror</span> : <span className="badge badge-accent">platform</span>}
                    {s.conflicted && <span className="badge badge-danger" title="The mirror and Kairos disagree about this class">conflicted</span>}
                    {s.status !== 'scheduled' && s.status !== 'active' && <span className="badge">{s.status}</span>}
                  </span>
                </article>
              ));
            }}
          />
        </>
      )}
    </section>
  );
}
