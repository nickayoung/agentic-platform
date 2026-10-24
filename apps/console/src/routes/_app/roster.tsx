// Desk roster (§18.4 managers' desk roster): one studio, one week of desk shift slots from GET /shifts, with the
// week's coverage gaps. Open and vacated slots take an assignment; filled slots can be cleared or turned into a
// sick call. Every rule (conflicts, availability, rest, hours) is the API's; refusals are shown as it gives them.
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { LocationPicker, PeriodNav } from '../../components/Pickers';
import { ProblemNotice } from '../../components/Problem';
import { SlotDialog } from '../../components/roster/SlotDialog';
import { WeekGrid } from '../../components/WeekGrid';
import { locationsQuery, meQuery, shiftsQuery } from '../../lib/queries';
import { formatDay, formatHmShort, formatRange, isDate, mondayOf, today } from '../../lib/time';
import type { CoverageGap, ShiftSlot } from '../../lib/types';

export const Route = createFileRoute('/_app/roster')({
  validateSearch: (s: Record<string, unknown>): { location?: string; week?: string } => ({
    ...(typeof s.location === 'string' && s.location ? { location: s.location } : {}),
    ...(isDate(s.week) ? { week: mondayOf(s.week) } : {}),
  }),
  component: Roster,
});

const STATE_LABEL = { open: 'Open', filled: 'Filled', vacated: 'Vacated' } as const;

function Roster() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const week = search.week ?? mondayOf(today());
  const locations = useQuery(locationsQuery());
  const me = useQuery(meQuery());
  const [selected, setSelected] = useState<ShiftSlot | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // default studio: the first one you work at, else the first studio
  useEffect(() => {
    if (search.location || !locations.data?.items.length || me.isPending) return;
    const mine = me.data?.locations ?? [];
    const pick = locations.data.items.find((l) => mine.includes(l.key)) ?? locations.data.items[0]!;
    void navigate({ search: (s) => ({ ...s, location: pick.key }), replace: true });
  }, [search.location, locations.data, me.isPending, me.data, navigate]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  const location = search.location;
  const shifts = useQuery({ ...shiftsQuery(week, location ?? ''), enabled: !!location });
  const data = shifts.data;
  const gapsByDay = new Map<string, CoverageGap[]>();
  for (const g of data?.coverage ?? []) gapsByDay.set(g.date, [...(gapsByDay.get(g.date) ?? []), g]);
  const counts = { open: 0, filled: 0, vacated: 0 };
  for (const s of data?.slots ?? []) counts[s.state]++;
  const studioName = locations.data?.items.find((l) => l.key === location)?.name ?? location;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Desk roster</h1>
          <p className="muted">{studioName ? `${studioName} front desk` : 'Choose a studio'} · times in New York</p>
        </div>
        <div className="toolbar">
          <LocationPicker value={location} onChange={(l) => void navigate({ search: (s) => ({ ...s, location: l }) })} />
          <PeriodNav start={week} step={7} label="week" todayStart={mondayOf} onChange={(w) => void navigate({ search: (s) => ({ ...s, week: w }) })} />
        </div>
      </header>

      {flash && <div className="toast" role="status">{flash}</div>}
      {locations.data?.source === 'session' && (
        <p className="muted small">Studios come from your sign-in token until <code>GET /locations</code> is deployed.</p>
      )}

      {!location ? (
        <div className="notice notice-muted">Choose a studio to see its desk roster.</div>
      ) : shifts.isError ? (
        <ProblemNotice error={shifts.error} />
      ) : (
        <>
          <div className="summary-row" aria-live="polite">
            {data ? (
              <>
                <span className="stat"><span className="dot dot-filled" />{counts.filled} filled</span>
                <span className="stat"><span className="dot dot-open" />{counts.open} open</span>
                <span className="stat"><span className="dot dot-vacated" />{counts.vacated} vacated</span>
                <span className={data.coverage.length ? 'stat stat-warn' : 'stat stat-ok'}>
                  {data.coverage.length ? `${data.coverage.length} coverage gap${data.coverage.length === 1 ? '' : 's'}` : 'Desk fully covered'}
                </span>
              </>
            ) : (
              <span className="muted">Loading the week…</span>
            )}
          </div>

          {!!data?.coverage.length && (
            <details className="gaps" open>
              <summary>Coverage gaps: times the desk has fewer people than it needs</summary>
              <ul>
                {data.coverage.map((g, i) => (
                  <li key={i}>
                    <strong>{formatDay(g.date)}</strong>
                    <span className="num">{formatHmShort(g.from)} – {formatHmShort(g.to)}</span>
                    <span className="gap-count">{g.have} of {g.min}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <WeekGrid
            monday={week}
            loading={shifts.isPending}
            dayBadge={(d) => {
              const gaps = gapsByDay.get(d);
              return gaps ? <span className="badge badge-warn" title={gaps.map((g) => `${formatRange(g.from, g.to)}: ${g.have}/${g.min}`).join('\n')}>{gaps.length} gap{gaps.length === 1 ? '' : 's'}</span> : null;
            }}
            renderDay={(d) => {
              const slots = (data?.slots ?? []).filter((s) => s.local.date === d).sort((a, b) => a.start - b.start);
              if (!slots.length) return <p className="day-empty">No desk shifts</p>;
              return slots.map((s) => (
                <button key={s.slot_key} type="button" className={`slot slot-${s.state}`} onClick={() => setSelected(s)}
                  aria-label={`${s.template_name}, ${formatRange(s.local.start, s.local.end)}, ${STATE_LABEL[s.state]}${s.worker ? `, ${s.worker.name}` : ''}`}>
                  <span className="slot-time">{formatHmShort(s.local.start)} – {formatHmShort(s.local.end)}</span>
                  <span className="slot-name">{s.template_name}</span>
                  <span className="slot-foot">
                    <span className="slot-worker">{s.state === 'filled' && s.worker ? s.worker.name : s.state === 'vacated' ? 'Needs cover' : 'Unassigned'}</span>
                    <span className={`state state-${s.state}`}>{STATE_LABEL[s.state]}</span>
                  </span>
                </button>
              ));
            }}
          />
        </>
      )}

      <SlotDialog
        slot={selected}
        studioName={studioName ?? ''}
        onClose={() => setSelected(null)}
        onDone={(msg) => {
          setSelected(null);
          setFlash(msg);
        }}
      />
    </section>
  );
}
