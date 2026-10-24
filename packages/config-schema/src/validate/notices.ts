// Workflow checks (§9.2, §9.3, §6.3): NOTICE_MISSING, SCOPE_ALL_MEMBER_RECIPIENT and WORKFLOW_CYCLE.
import type { ConfigDocument, Recipient, WorkflowDef } from '../schema';
import { Issues } from '../report';

export type Domain = 'classes' | 'bookings' | 'members' | 'shifts';
export type DomainMode = 'mirror' | 'shadow' | 'owner';

export interface NoticeOptions {
  /** Flags that are on. An element with `flag` is inactive unless its flag is listed. */
  flags?: ReadonlySet<string>;
  /** Domain modes. Unknown modes count as "not owner", so `sync.drift_detected` is required. */
  domainModes?: Partial<Record<Domain, DomainMode>>;
}

export const eventsOf = (w: WorkflowDef): string[] =>
  ('event' in w.trigger ? [w.trigger.event].flat() : []);

const isEnabled = (x: { flag?: string | undefined }, flags: ReadonlySet<string> | undefined): boolean =>
  x.flag === undefined || (flags?.has(x.flag) ?? false);

/** Required-notice events (§9.2, column R) that apply to this config. */
export function requiredNotices(doc: ConfigDocument, opts: NoticeOptions = {}): string[] {
  const policies = doc.policies;
  const waitlist = policies.some((p) => p.waitlist?.enabled === true);
  const offerAll = policies.some((p) => p.waitlist?.enabled === true && p.waitlist.schedule.some((s) => s.mode === 'offer_all'));
  const customers = doc.templates.some((t) => t.participants.who === 'customers');
  const roster = doc.templates.some((t) => t.requirements.some((q) => q.assign === 'roster'));
  const pricePayments = doc.templates.some((t) => t.cost !== undefined && ['units_or_price', 'price_only'].includes(t.cost.payment));
  const modes = opts.domainModes ?? {};
  const notOwned = (['classes', 'bookings', 'members', 'shifts'] as const).some((d) => modes[d] !== 'owner');
  const out: string[] = [];
  const need = (cond: boolean, ...events: string[]): void => { if (cond) out.push(...events); };
  need(waitlist, 'booking.confirmed', 'waitlist.skipped');
  need(policies.some((p) => p.approval !== undefined), 'booking.rejected');
  need(pricePayments, 'booking.cancelled');                 // for reason payment_failed
  need(doc.layouts.length > 0, 'booking.reseated');
  need(offerAll, 'waitlist.offered');
  need(customers, 'session.cancelled', 'session.retimed', 'session.room_changed');
  need(roster, 'assignment.vacated', 'offer.sent', 'timeoff.submitted', 'proposal.created', 'proposal.urgent');
  need(true, 'tenant.closing');
  need(notOwned, 'sync.drift_detected');
  return out;
}

const MEMBER_RECIPIENTS = ['customer', 'session_customers', 'waitlist', 'all_members'];
const isMemberRecipient = (r: Recipient): boolean => MEMBER_RECIPIENTS.some((k) => k in r);

/** Events an action can raise, for the static workflow graph. Hooks are left out: what they emit is not static. */
const ACTION_EVENTS: Partial<Record<WorkflowDef['actions'][number]['type'], string[]>> = {
  cancel_session: ['session.cancelled', 'booking.cancelled', 'assignment.released', 'place.released'],
  request_solve: ['proposal.created'],
};

export function checkWorkflows(doc: ConfigDocument, opts: NoticeOptions, out: Issues): void {
  // NOTICE_MISSING: an enabled workflow with a notify action must listen for each required event. `trigger.where`
  // is CEL and not evaluated, so any such listener counts.
  const listened = new Set(doc.workflows
    .filter((w) => isEnabled(w, opts.flags) && w.actions.some((a) => a.type === 'notify'))
    .flatMap(eventsOf));
  for (const e of requiredNotices(doc, opts)) {
    if (!listened.has(e)) out.warn('NOTICE_MISSING', ['workflows'], `no enabled workflow sends a notice on ${e}`);
  }

  // SCOPE_ALL_MEMBER_RECIPIENT (§9.3).
  if ((doc.tenant.member_messaging ?? 'record_holder') === 'record_holder') {
    doc.workflows.forEach((w, i) => {
      if (w.scope !== 'all') return;
      w.actions.forEach((a, j) => {
        if (a.type === 'notify' && isMemberRecipient(a.to)) {
          out.warn('SCOPE_ALL_MEMBER_RECIPIENT', ['workflows', i, 'actions', j, 'to'],
            `${w.key} has scope: all and notifies members, but member_messaging is record_holder`);
        }
      });
    });
  }

  // WORKFLOW_CYCLE: W1 → W2 when an action of W1 raises an event W2 listens for.
  const emits = (w: WorkflowDef): string[] => w.actions.flatMap((a) => (a.type === 'emit_event' ? [a.name] : ACTION_EVENTS[a.type] ?? []));
  const edges = doc.workflows.map((w) => {
    const raised = new Set(emits(w));
    return doc.workflows.flatMap((v, j) => (eventsOf(v).some((e) => raised.has(e)) ? [j] : []));
  });
  const state = new Array<0 | 1 | 2>(doc.workflows.length).fill(0);
  const stack: number[] = [];
  const reported = new Set<string>();
  const visit = (i: number): void => {
    state[i] = 1;
    stack.push(i);
    for (const j of edges[i]!) {
      if (state[j] === 1) {
        const cycle = stack.slice(stack.indexOf(j));
        const id = [...cycle].sort().join(',');
        if (!reported.has(id)) {
          reported.add(id);
          out.error('WORKFLOW_CYCLE', ['workflows', j], `workflow cycle: ${[...cycle, j].map((k) => doc.workflows[k]!.key).join(' → ')}`);
        }
      } else if (state[j] === 0) {
        visit(j);
      }
    }
    stack.pop();
    state[i] = 2;
  };
  doc.workflows.forEach((_, i) => { if (state[i] === 0) visit(i); });
}
