// Slots and their environments (§5.3). Each slot declares its variables and its result type.

import { T, type Type } from './types';

export type SlotName = 'booking' | 'candidate' | 'event' | 'event_value' | 'row';

export type CustomFieldType = 'text' | 'long_text' | 'int' | 'bool' | 'date' | 'enum' | 'multi_enum' | 'consent';
export type ViewEntity = 'session' | 'booking' | 'customer' | 'assignment' | 'resource';
export type EventSubject = 'session' | 'booking' | 'customer' | 'assignment' | 'place' | 'roster';

export interface CompileContext {
  /**
   * The tag and template keys of the compiled config. With these, `customer.history.tags` and
   * `.templates` are closed maps and an unknown literal key is `UNKNOWN_HISTORY_KEY` (§5.3).
   * Without them the maps are open.
   */
  historyKeys?: { tags: readonly string[]; templates: readonly string[] };
  /** Custom booking fields (§4.12, `entity: booking`) by key; selectable as `booking.<key>`. */
  bookingFields?: Readonly<Record<string, CustomFieldType>>;
  /** `row` slot only: the view's entity (§4.12 `ViewDef.entity`). Default `session`. */
  rowEntity?: ViewEntity;
  /** `event` slots only: the subjects this event carries. Default all six. */
  eventSubjects?: readonly EventSubject[];
}

export interface SlotDef {
  readonly name: SlotName;
  /** Where the slot is used (§5.3 "Used by"). */
  readonly usedBy: readonly string[];
  /** `bool`, or `dyn` for a value-producing slot. */
  readonly result: Type;
  readonly variables: Readonly<Record<string, Type>>;
}

const S = T.string;
const nS = T.nullable(T.string);
const lS = T.list(T.string);
const dynMap = T.map(T.string, T.dyn);

export const CountsType = T.object('Counts', {
  completed: T.int,
  upcoming: T.int,
  cancelled: T.int,
  late_cancelled: T.int,
  no_show: T.int,
  last_completed_at: T.nullable(T.timestamp),
});

export const TemplateType = T.object('Template', { key: S, kind: S, tags: lS });

export const ResourceType = T.object('Resource', {
  id: S,
  key: nS,
  type: S,
  kind: S,
  tags: lS,
  roles: lS,
  skills: lS,
  attributes: dynMap,
  location_keys: lS,
});

const CHANNELS = ['web', 'desk', 'portal', 'agent', 'mirror', 'waitlist'];

function customerType(ctx: CompileContext): Type {
  const hk = ctx.historyKeys;
  return T.object('Customer', {
    id: S,
    tier: nS,
    strikes: T.int,
    state: S,
    home_location_key: nS,
    custom: dynMap,
    history: T.object('History', {
      total: CountsType,
      tags: T.map(S, CountsType, hk?.tags),
      templates: T.map(S, CountsType, hk?.templates),
    }),
  });
}

const sessionFields: Record<string, Type> = {
  id: S,
  template_key: S,
  template: TemplateType,
  location_key: S,
  start: T.timestamp,
  end: T.timestamp,
  zone: S,
  local_date: S,
  local_start: S,
  weekday: S,
  booked_count: T.int,
  capacity_total: T.int,
  waitlist_count: T.int,
  status: S,
  tags: lS,
};
export const SessionType = T.object('Session', sessionFields);

function customFieldType(t: CustomFieldType): Type {
  switch (t) {
    case 'int':
      return T.nullable(T.int);
    case 'bool':
    case 'consent':
      return T.nullable(T.bool);
    case 'multi_enum':
      return T.nullable(lS);
    default:
      return nS;
  }
}

function bookingFields(ctx: CompileContext): Record<string, Type> {
  const builtin: Record<string, Type> = {
    id: nS,
    state: S,
    start: T.timestamp,
    end: T.timestamp,
    duration_minutes: T.int,
    booked_via: T.enum(...CHANNELS),
    template: TemplateType,
    payment: T.object('Payment', { method: T.enum('units', 'price', 'none') }),
    entitlement: T.nullable(T.object('Entitlement', { product_key: S, kind: S, tier: nS })),
    place: T.nullable(T.object('BookingPlace', { label: S, partition: S, attributes: dynMap })),
    place_refilled: T.bool,
    intake_complete: T.bool,
  };
  // Custom booking fields by key. A key that shadows a built-in is rejected by validation
  // (FIELD_SHADOWS_BUILTIN, §4.12); here the built-in wins.
  for (const [key, ft] of Object.entries(ctx.bookingFields ?? {})) {
    if (!(key in builtin)) builtin[key] = customFieldType(ft);
  }
  return builtin;
}
const bookingType = (ctx: CompileContext) => T.object('Booking', bookingFields(ctx));

const templateVar = TemplateType;
const locationType = T.object('Location', { key: S, timezone: S });
const requestType = T.object('Request', { channel: T.enum(...CHANNELS), actor_type: S });
const candidateType = T.object('Candidate', {
  resource: ResourceType,
  requirement_key: S,
  load: T.object('Load', { minutes_day: T.int, minutes_week: T.int, assignments_day: T.int, assignments_week: T.int }),
});
const assignmentType = T.object('Assignment', {
  id: S,
  requirement_key: S,
  resource: T.nullable(ResourceType),
  state: S,
  source: S,
});
const placeType = T.object('Place', { id: S, label: S, partition: S, attributes: dynMap });
const rosterType = T.object('Roster', { published_through: T.timestamp });
const eventType = T.object('Event', {
  name: S,
  at: T.timestamp,
  actor_type: S,
  reason: nS,
  domain: T.enum('classes', 'bookings', 'members', 'shifts', 'none'),
  source: T.enum('platform', 'mirror'),
  data: dynMap,
});
const meType = T.object('Me', { roles: lS, resource_id: nS, customer_id: nS, location_keys: lS });

function rowType(ctx: CompileContext): Type {
  switch (ctx.rowEntity ?? 'session') {
    case 'session':
      return T.object('SessionRow', {
        ...sessionFields,
        assigned_resource_ids: lS,
        template: TemplateType,
        custom: dynMap,
      });
    case 'booking':
      return T.object('BookingRow', { ...bookingFields(ctx), custom: dynMap });
    case 'customer':
      return customerType(ctx);
    case 'assignment':
      return T.object('AssignmentRow', { ...(assignmentType as { fields: Record<string, Type> }).fields, custom: dynMap });
    case 'resource':
      return T.object('ResourceRow', { ...(ResourceType as { fields: Record<string, Type> }).fields, custom: dynMap });
  }
}

const ALL_SUBJECTS: readonly EventSubject[] = ['session', 'booking', 'customer', 'assignment', 'place', 'roster'];

function eventVariables(ctx: CompileContext): Record<string, Type> {
  const subjects: Record<EventSubject, Type> = {
    session: SessionType,
    booking: bookingType(ctx),
    customer: customerType(ctx),
    assignment: assignmentType,
    place: placeType,
    roster: rosterType,
  };
  const vars: Record<string, Type> = { now: T.timestamp, event: eventType };
  for (const s of ctx.eventSubjects ?? ALL_SUBJECTS) vars[s] = subjects[s];
  return vars;
}

const USED_BY: Record<SlotName, readonly string[]> = {
  booking: [
    'eligible_if (template, policy)',
    'price_rules[].when',
    'partitions[].eligible_if',
    'limits[].count_if',
    'limits[].applies_if',
    'Penalty.fee_if',
    'Penalty.waive_if',
    'approval.required_if',
    'intake.when',
    'custom_fields[].required_if',
    'covers',
    'caps[].count_if',
  ],
  candidate: ['select.where', 'applies_to.people_where', 'assignment_expr.must'],
  event: ['trigger.where', 'condition', 'action.when'],
  event_value: ['action input values', 'action vars values'],
  row: ['views[].filter'],
};

/** The slot's environment for a given compiled config. */
export function slotDef(slot: SlotName, ctx: CompileContext = {}): SlotDef {
  let variables: Record<string, Type>;
  switch (slot) {
    case 'booking':
      variables = {
        now: T.timestamp,
        customer: customerType(ctx),
        booking: bookingType(ctx),
        session: SessionType,
        template: templateVar,
        location: locationType,
        request: requestType,
      };
      break;
    case 'candidate':
      variables = { now: T.timestamp, candidate: candidateType, session: SessionType, template: templateVar };
      break;
    case 'event':
    case 'event_value':
      variables = eventVariables(ctx);
      break;
    case 'row':
      variables = { now: T.timestamp, me: meType, row: rowType(ctx) };
      break;
  }
  return { name: slot, usedBy: USED_BY[slot], result: slot === 'event_value' ? T.dyn : T.bool, variables };
}

/** The slots with no config context (open history maps, no custom booking fields, session rows). */
export const SLOTS: Readonly<Record<SlotName, SlotDef>> = {
  booking: slotDef('booking'),
  candidate: slotDef('candidate'),
  event: slotDef('event'),
  event_value: slotDef('event_value'),
  row: slotDef('row'),
};

export const SLOT_NAMES = Object.keys(SLOTS) as SlotName[];
