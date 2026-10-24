// Seven day columns, Monday to Sunday. On a phone the columns stack into a day list.
import type { ReactNode } from 'react';
import { formatDay, today, weekDays } from '../lib/time';

export function WeekGrid({ monday, renderDay, dayBadge, loading }: {
  monday: string;
  renderDay: (date: string) => ReactNode;
  dayBadge?: (date: string) => ReactNode;
  loading?: boolean;
}) {
  const now = today();
  return (
    <div className="week-grid" aria-busy={loading || undefined}>
      {weekDays(monday).map((d) => {
        const [weekday, ...rest] = formatDay(d).split(', ');
        return (
          <section key={d} className={d === now ? 'day today' : d < now ? 'day past' : 'day'} aria-label={formatDay(d)}>
            <header className="day-head">
              <span className="day-name">{weekday}</span>
              <span className="day-date">{rest.join(', ')}</span>
              {d === now && <span className="badge badge-accent">Today</span>}
              {dayBadge?.(d)}
            </header>
            <div className="day-body">{loading ? <div className="skeleton slot-skeleton" /> : renderDay(d)}</div>
          </section>
        );
      })}
    </div>
  );
}
