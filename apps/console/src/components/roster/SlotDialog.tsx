// One desk slot: assign someone to an open or vacated slot, or remove / call in sick for a filled one.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { locationsQuery, peopleQuery } from '../../lib/queries';
import { formatDay, formatRange } from '../../lib/time';
import type { Person, ShiftSlot, TimeOffResult } from '../../lib/types';
import { Dialog } from '../Dialog';
import { ProblemNotice, QueryView } from '../Problem';

export function SlotDialog({ slot, studioName, onClose, onDone }: {
  slot: ShiftSlot | null; studioName: string; onClose: () => void; onDone: (message: string) => void;
}) {
  return (
    <Dialog
      open={!!slot}
      onClose={onClose}
      title={slot ? <>{slot.template_name} <span className="muted">· {formatDay(slot.local.date)}, {formatRange(slot.local.start, slot.local.end)}</span></> : ''}
    >
      {slot && (slot.state === 'filled' ? (
        <FilledSlot key={slot.slot_key} slot={slot} onDone={onDone} />
      ) : (
        <AssignSlot key={slot.slot_key} slot={slot} studioName={studioName} onDone={onDone} />
      ))}
    </Dialog>
  );
}

const firstName = (n: string) => n.split(' ')[0] ?? n;

function useInvalidateRoster() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['shifts'] }),
    qc.invalidateQueries({ queryKey: ['time-off'] }),
    qc.invalidateQueries({ queryKey: ['hours'] }),
  ]);
}

function AssignSlot({ slot, studioName, onDone }: { slot: ShiftSlot; studioName: string; onDone: (m: string) => void }) {
  const [filter, setFilter] = useState('');
  const people = useQuery(peopleQuery('desk_staff'));
  const locations = useQuery(locationsQuery());
  const studio = (k: string) => locations.data?.items.find((l) => l.key === k)?.name ?? k;
  const invalidate = useInvalidateRoster();
  const assign = useMutation({
    mutationFn: (p: Person) => api<ShiftSlot>('/shifts/assign', {
      method: 'POST',
      body: { template_key: slot.template_key, location_key: slot.location_key, start: slot.start, resource_id: p.id },
    }),
    onSuccess: async (_r, p) => {
      await invalidate();
      onDone(`${p.name} is on ${slot.template_name}, ${formatDay(slot.local.date)}.`);
    },
  });

  return (
    <div className="stack">
      <p className="muted">
        {slot.state === 'vacated' ? 'This shift was vacated and needs cover.' : 'This shift is open.'} Choose someone from the desk team at {studioName || slot.location_key}.
        The API checks conflicts, time off, rest and hours, and says why if it refuses.
      </p>
      {assign.isError && <ProblemNotice error={assign.error} title={`Couldn’t assign ${assign.variables?.name ?? ''}`} />}
      <input className="search" type="search" placeholder="Search desk staff" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search desk staff" autoFocus />
      <QueryView query={people}>
        {(d) => {
          const q = filter.trim().toLowerCase();
          const list = d.items
            .filter((p) => p.state !== 'inactive' && (!q || p.name.toLowerCase().includes(q) || p.staff_key.toLowerCase().includes(q)))
            .sort((a, b) => Number(b.location_keys.includes(slot.location_key)) - Number(a.location_keys.includes(slot.location_key)) || a.name.localeCompare(b.name));
          if (!list.length) return <p className="muted">No desk staff match.</p>;
          return (
            <ul className="pick-list">
              {list.map((p) => {
                const home = p.location_keys.includes(slot.location_key);
                const busy = assign.isPending && assign.variables?.id === p.id;
                return (
                  <li key={p.id}>
                    <button type="button" className="pick" disabled={assign.isPending} onClick={() => assign.mutate(p)}>
                      <span className="pick-name">{p.name}</span>
                      <span className="pick-meta">
                        {p.location_keys.map(studio).join(', ') || 'no studio'}
                        {!home && <span className="badge">other studio</span>}
                        {p.roles.includes('teacher') && <span className="badge">also teaches</span>}
                      </span>
                      <span className="pick-action">{busy ? 'Assigning…' : 'Assign'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </QueryView>
    </div>
  );
}

function FilledSlot({ slot, onDone }: { slot: ShiftSlot; onDone: (m: string) => void }) {
  const invalidate = useInvalidateRoster();
  const [confirm, setConfirm] = useState<'remove' | 'sick' | null>(null);
  const worker = slot.worker;
  const name = worker?.name ?? 'This person';

  const remove = useMutation({
    mutationFn: () => api<{ ok: true }>(`/shifts/${slot.session_id}/unassign`, { method: 'POST' }),
    onSuccess: async () => {
      await invalidate();
      onDone(`${name} was removed from ${slot.template_name}, ${formatDay(slot.local.date)}. The slot is open.`);
    },
  });
  const sick = useMutation({
    mutationFn: () => api<TimeOffResult>('/time-off', {
      method: 'POST',
      body: { resource_id: worker?.resource_id, start: slot.start, end: slot.end, reason: 'sick', immediate: true },
    }),
    onSuccess: async (r) => {
      await invalidate();
      const n = r.vacated?.length ?? 0;
      onDone(`${name} is off sick. ${n} shift${n === 1 ? '' : 's'} vacated; open ${n === 1 ? 'it' : 'them'} to find cover.`);
    },
  });
  const pending = remove.isPending || sick.isPending;

  return (
    <div className="stack">
      <div className="assignee">
        <span className="avatar" aria-hidden>{name.slice(0, 1)}</span>
        <div>
          <div className="assignee-name">{name}</div>
          <div className="muted small">On the desk {formatRange(slot.local.start, slot.local.end)}</div>
        </div>
      </div>
      {remove.isError && <ProblemNotice error={remove.error} title="Couldn’t remove the shift" />}
      {sick.isError && <ProblemNotice error={sick.error} title="Couldn’t record the sick call" />}
      {!slot.session_id && <p className="muted small">This slot has no session id, so it can’t be changed here.</p>}

      {confirm === null && (
        <div className="actions">
          <button type="button" className="btn" disabled={!slot.session_id || pending} onClick={() => setConfirm('remove')}>Remove from shift</button>
          <button type="button" className="btn btn-danger" disabled={!worker || pending} onClick={() => setConfirm('sick')}>Mark {firstName(name)} sick</button>
        </div>
      )}
      {confirm === 'remove' && (
        <div className="confirm">
          <p>Remove {name} from this shift? The slot becomes open.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={pending}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => remove.mutate()} disabled={pending}>{remove.isPending ? 'Removing…' : 'Remove'}</button>
          </div>
        </div>
      )}
      {confirm === 'sick' && (
        <div className="confirm">
          <p>
            Record a sick call for {name} covering {formatRange(slot.local.start, slot.local.end)} on {formatDay(slot.local.date)}? Any of their desk shifts in that time are
            vacated straight away so you can find cover.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={pending}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={() => sick.mutate()} disabled={pending}>{sick.isPending ? 'Recording…' : 'Record sick call'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
