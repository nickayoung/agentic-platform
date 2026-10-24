// Studio and date-range pickers shared by the week and pay-period screens.
import { useQuery } from '@tanstack/react-query';
import { locationsQuery } from '../lib/queries';
import { addDays, formatDay, isDate, today } from '../lib/time';

export function LocationPicker({ value, onChange, allowAll }: { value: string | undefined; onChange: (key: string | undefined) => void; allowAll?: boolean }) {
  const q = useQuery(locationsQuery());
  const items = q.data?.items ?? [];
  return (
    <label className="field inline">
      <span>Studio</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} disabled={q.isPending}>
        {(allowAll || !value) && <option value="">{allowAll ? 'All studios' : 'Choose a studio'}</option>}
        {value && !items.some((l) => l.key === value) && <option value={value}>{value}</option>}
        {items.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}
      </select>
    </label>
  );
}

/**
 * Prev / today / next plus a date field. `step` is in days (7 for weeks, 14 for pay periods); `todayStart` maps a
 * date to the start of its period, and `pick` maps a date typed into the field (default: the same as todayStart).
 */
export function PeriodNav({ start, step, label, onChange, todayStart, pick = todayStart }: {
  start: string; step: number; label: string; onChange: (start: string) => void; todayStart: (date: string) => string; pick?: (date: string) => string;
}) {
  const last = addDays(start, step - 1);
  const shift = (n: number) => onChange(addDays(start, n));
  const current = todayStart(today());
  return (
    <div className="period-nav" role="group" aria-label={label}>
      <button type="button" className="btn" onClick={() => shift(-step)} aria-label={`Previous ${label}`}>‹</button>
      <button type="button" className="btn" onClick={() => onChange(current)} disabled={current === start}>Today</button>
      <button type="button" className="btn" onClick={() => shift(step)} aria-label={`Next ${label}`}>›</button>
      <span className="period-label">{formatDay(start)} – {formatDay(last)}, {last.slice(0, 4)}</span>
      <input
        type="date"
        className="period-date"
        aria-label={`Jump to ${label}`}
        value={start}
        onChange={(e) => isDate(e.target.value) && onChange(pick(e.target.value))}
      />
    </div>
  );
}
