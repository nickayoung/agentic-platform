// Config schema 2.1 (§4) in Zod 4. Transcribed from the normative TypeScript in §4 (and §9.2, §9.4, §18.8.3 for the
// types §4 references). Field names match §4 exactly. Objects are strict: an unknown field is SCHEMA_INVALID, so a
// typo or an invented field never passes silently. No defaults are applied here (see `withDefaults`, upgrade.ts), so a
// parsed document is exactly what was authored and its content hash is stable.
import { z } from 'zod';

// ── §4.2 Common types ──────────────────────────────────────────────────────────────────────────────────────────────

export const KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;
export const DURATION_RE = /^(\d+w)?(\d+d)?(\d+h)?(\d+m)?$/;
export const SIGNED_DURATION_RE = /^[+-]?(\d+w)?(\d+d)?(\d+h)?(\d+m)?$/;
const LOCAL_TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;   // 24:00 only makes sense as an interval end
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const twoDecimals = (n: number): boolean => Math.abs(Math.round(n * 100) - n * 100) < 1e-9;

export const Key = z.string().regex(KEY_RE, 'must match ^[a-z][a-z0-9_]{1,62}$');
export const Expr = z.string().min(1, 'expression must not be empty');   // CEL source, checked per slot by L3 (§5)
export const LocalTime = z.string().regex(LOCAL_TIME_RE, 'must be HH:MM');
export const LocalDate = z.string().regex(LOCAL_DATE_RE, 'must be YYYY-MM-DD').refine(validDate, 'not a calendar date');
export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const Money = z.strictObject({ minor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) });
/** w and d are calendar units in the studio's zone; h and m are elapsed. */
export const Duration = z.string().regex(DURATION_RE, 'must look like 1w2d3h4m').refine((s) => s !== '', 'must not be empty');
export const SignedDuration = z.string().regex(SIGNED_DURATION_RE, 'must look like -2h or +15m')
  .refine((s) => s.replace(/^[+-]/, '') !== '', 'must not be empty');
export const Offset = z.union([
  z.strictObject({ before_start: Duration, at_local: LocalTime.optional() }),
  z.strictObject({ after_start: Duration }),
  z.strictObject({ before_end: Duration }),
  z.strictObject({ after_end: Duration }),
]);
export const AttrValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const flagRef = { flag: z.string().optional() };   // FlagRef: the element is inactive unless the flag is on
export const PLATFORM_ROLES = ['owner', 'admin', 'manager', 'desk', 'instructor', 'staff', 'member', 'guest'] as const;
export const PlatformRole = z.enum(PLATFORM_ROLES);
const LocalInterval = z.tuple([LocalTime, LocalTime]);
const UnitAmount = z.number().refine(twoDecimals, 'unit amounts have at most 2 decimal places');

// ── §18.8.3 Payroll export (TenantSettings.payroll_export) ─────────────────────────────────────────────────────────

export const PayrollExportSettings = z.strictObject({
  format: z.literal('gusto_csv'),
  pay_period: z.strictObject({ frequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']), anchor: LocalDate }),
  template_headers: z.strictObject({ employees: z.array(z.string()), contractors: z.array(z.string()) }),
  columns: z.strictObject({
    employees: z.strictObject({
      payroll_ref: z.string(), last_name: z.string().optional(), first_name: z.string().optional(),
      workweek: z.string().optional(), job: z.string().optional(), regular_hours: z.string(),
      overtime_hours: z.string().optional(), double_overtime_hours: z.string().optional(),
    }),
    contractors: z.strictObject({
      payroll_ref: z.string(), last_name: z.string().optional(), first_name: z.string().optional(), hours: z.string(),
    }),
  }),
  overtime: z.strictObject({
    weekly_hours: z.number().nullable(), daily_hours: z.number().nullable(), daily_double_hours: z.number().nullable(),
  }),
  split_by_kind: z.boolean(),
  job_names: z.strictObject({ shift: z.string(), teaching: z.string() }).optional(),
});

// ── §4.3 Tenant and studios ────────────────────────────────────────────────────────────────────────────────────────

export const TenantSettings = z.strictObject({
  name: z.string(), default_timezone: z.string(), currency: z.string().regex(/^[A-Z]{3}$/), locale: z.string(),
  week_starts: Weekday,
  hold_ttl: Duration.refine((d) => durationMinutes(d) <= 15, 'hold_ttl is at most 15m'),
  materialize_horizon: Duration,
  customer_label: z.string(),
  fee_ceiling: Money,                                 // LOCKED
  closure_pay_notice: Duration,
  closing_notice: Duration,
  refund_credit_product: Key,
  member_messaging: z.enum(['kairos', 'record_holder']).optional(),   // 2.1; default 'record_holder'
  payroll_export: PayrollExportSettings,              // LOCKED
  environment_guards: z.strictObject({ preview_outbound: z.enum(['sandbox', 'record_only']) }),   // LOCKED
});

export const LocationDef = z.strictObject({
  key: Key, name: z.string(), timezone: z.string(),
  address: z.strictObject({
    line1: z.string(), city: z.string(), region: z.string().optional(), postal_code: z.string(), country: z.string(),
  }).optional(),
  transfer_times: z.array(z.strictObject({ to: Key, duration: Duration })).optional(),
});

// ── §4.4 Catalogs ──────────────────────────────────────────────────────────────────────────────────────────────────

export const UnitDef = z.strictObject({ key: Key, name: z.string() });
export const SkillDef = z.strictObject({ key: Key, name: z.string(), expires: z.boolean() });
export const RoleDef = z.strictObject({ key: Key, name: z.string(), implies_skills: z.array(Key).optional() });
export const TierDef = z.strictObject({ key: Key, name: z.string(), rank: z.number() });

// ── §4.5 Resource types, rooms, layouts ────────────────────────────────────────────────────────────────────────────

export const ResourceTypeDef = z.strictObject({
  key: Key, name: z.string(), kind: z.enum(['person', 'space', 'spot']),
  attributes: z.array(z.strictObject({
    key: Key, type: z.enum(['string', 'int', 'number', 'bool', 'enum', 'string_list']),
    values: z.array(z.string()).optional(), required: z.boolean().optional(), default: AttrValue.optional(),
  })),
  default_concurrency: z.number().int().min(1).optional(),
});

export const ResourceDef = z.strictObject({
  ...flagRef,
  key: Key, type: Key, name: z.string(), location: Key,
  tags: z.array(z.string()).optional(), attributes: z.record(z.string(), AttrValue).optional(),
  concurrency: z.number().int().min(1).optional(), layout: Key.optional(),
});

export const LayoutDef = z.strictObject({
  key: Key, spot_type: Key,
  grid: z.strictObject({ rows: z.number().int().min(1), cols: z.number().int().min(1) }),
  generate: z.strictObject({
    prefix: z.string(), label: z.string(), count: z.number().int().min(1), per_row: z.number().int().min(1),
  }),
  overrides: z.array(z.strictObject({
    match: z.strictObject({ keys: z.array(Key).optional(), rows: z.array(z.number().int()).optional() }),
    tags: z.array(z.string()).optional(), attributes: z.record(z.string(), AttrValue).optional(),
    disabled: z.boolean().optional(),
  })).optional(),
});

// ── §4.6 Templates ─────────────────────────────────────────────────────────────────────────────────────────────────

export const RequirementDef = z.strictObject({
  key: Key,
  select: z.strictObject({
    type: Key.optional(), kind: z.enum(['person', 'space']).optional(), resources: z.array(z.string()).optional(),
    tags_all: z.array(z.string()).optional(), tags_any: z.array(z.string()).optional(),
    skills_all: z.array(Key).optional(), role: Key.optional(),
    where: Expr.optional(),                           // slot: candidate
  }),
  count: z.number().int().min(1).optional(),          // default 1
  assign: z.enum(['fixed', 'roster']),
  occupancy: z.enum(['exclusive', 'lane']).optional(),   // default exclusive
  buffers: z.strictObject({ before: Duration.optional(), after: Duration.optional() }).optional(),
  provides_layout: z.boolean().optional(),
});

export const PartitionDef = z.strictObject({
  key: Key,                                           // "general" is implicit
  count: z.number().int().min(0).optional(),
  spots: z.strictObject({ tags_any: z.array(z.string()).optional(), keys: z.array(Key).optional() }).optional(),
  eligible_if: Expr, online: z.boolean(),
  release: z.strictObject({ at: Offset, to: Key }).optional(),
});

const PooledCapacity = z.strictObject({ mode: z.literal('pooled'), places: z.number().int().min(1) });
export const CapacitySpec = z.discriminatedUnion('mode', [
  PooledCapacity,
  z.strictObject({ mode: z.literal('pooled_from_space'), requirement: Key }),
  z.strictObject({ mode: z.literal('assigned'), requirement: Key, auto_assign: z.boolean() }),
  z.strictObject({
    mode: z.literal('mixed'),
    base: z.discriminatedUnion('mode', [PooledCapacity, z.strictObject({ mode: z.literal('assigned'), requirement: Key })]),
    partitions: z.array(PartitionDef),
  }),
]);

export const CostSpec = z.strictObject({
  payment: z.enum(['units_or_price', 'units_only', 'price_only', 'none']),
  units: z.array(z.strictObject({ unit: Key, amount: UnitAmount })).optional(),
  price: Money.optional(),
  price_rules: z.array(z.strictObject({ when: Expr, price: Money })).optional(),   // the first matching rule wins
});

export const TemplateDef = z.strictObject({
  ...flagRef,
  key: Key, name: z.string(),
  kind: z.enum(['class', 'shift']),                   // UI label only (principle 4)
  tags: z.array(z.string()).optional(),
  duration: Duration,
  scheduling: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('timetable') }),
    z.strictObject({
      mode: z.literal('rostered'),
      starts: z.array(z.strictObject({
        at: LocalTime, days: z.array(Weekday).optional(), locations: z.array(Key).optional(),
      })),
    }),
  ]),
  participants: z.discriminatedUnion('who', [
    z.strictObject({ who: z.literal('customers'), capacity: CapacitySpec, allow_guests: z.number().int().min(0).optional() }),
    z.strictObject({ who: z.literal('none') }),
  ]),
  requirements: z.array(RequirementDef),
  cost: CostSpec.optional(),
  policy: Key.optional(),                             // required when participants.who = customers
  eligible_if: Expr.optional(), ineligible_message: z.string().optional(),
  intake: z.strictObject({ form: Key, when: Expr.optional() }).optional(),
}).superRefine((t, ctx) => {
  if (t.participants.who === 'customers' && t.policy === undefined) {
    ctx.addIssue({ code: 'custom', path: ['policy'], message: 'policy is required when participants.who = customers' });
  }
});

// ── §4.7 Timetable ─────────────────────────────────────────────────────────────────────────────────────────────────

export const SeriesDef = z.strictObject({
  ...flagRef,
  key: Key, template: Key, location: Key,
  rrule: z.string().regex(/(^|;)FREQ=/, 'must be an RFC 5545 RRULE without DTSTART'),
  start_local: LocalTime,
  valid_from: LocalDate, valid_until: LocalDate.optional(),
  exdates: z.array(LocalDate).optional(),
  fixed: z.record(Key, z.union([z.string(), z.array(z.string())])),   // requirement key → resource key or "@staff:<key>"
  capacity_override: z.number().int().min(1).optional(),
});

// ── §4.8 Policies ──────────────────────────────────────────────────────────────────────────────────────────────────

const penaltyShape = {
  forfeit_units: z.boolean(), fee: Money.optional(), fee_if: Expr.optional(), strikes: z.number().int().min(0).optional(),
  waive_if: Expr.optional(), assess_at: z.enum(['immediately', 'session_start', 'session_end']),
};
export const Penalty = z.strictObject(penaltyShape);

export const RefundRules = z.strictObject({
  timely: z.enum(['full', 'credit', 'none']),
  late: z.enum(['none', 'as_timely_if_refilled']).optional(),   // 2.1; default 'none'
  studio_cancel: z.literal('full'),
});

export const BookingLimitDef = z.strictObject({
  key: Key, window: z.enum(['day', 'week', 'month', 'upcoming']), max: z.number().int().min(0),
  count_if: Expr.optional(), applies_if: Expr.optional(), message: z.string(),
});

export const WaitlistPolicy = z.strictObject({
  enabled: z.boolean(), max_size: z.number().int().min(0), require_entitlement: z.boolean(),
  schedule: z.array(z.strictObject({ until: Offset, mode: z.enum(['auto_promote', 'offer_all', 'closed']) })),
  offer_ttl: Duration,
  place_choice: z.enum(['preferred_then_best', 'best']),
});

const SessionAction = z.enum(['cancel_session', 'notify_staff']);
export const PolicySetDef = z.strictObject({
  key: Key, name: z.string(),
  booking_window: z.strictObject({ opens: Offset, closes: Offset }),
  eligible_if: Expr.optional(),
  cancellation: z.strictObject({
    customer_can_cancel: z.boolean(),
    free_until: Offset,
    late: Penalty,
    no_show: z.strictObject({ ...penaltyShape, grace: Duration }),
  }),
  refund: RefundRules,
  limits: z.array(BookingLimitDef),
  approval: z.strictObject({
    required_if: Expr, approver_roles: z.array(PlatformRole), timeout: Duration, on_timeout: z.enum(['reject', 'approve']),
  }).optional(),
  min_attendance: z.strictObject({ min: z.number().int().min(0), check_at: Offset, action: SessionAction }).optional(),
  unstaffed: z.strictObject({ check_at: Offset, action: SessionAction }),
  waitlist: WaitlistPolicy.optional(),
  check_in: z.strictObject({ opens: Offset, closes: Offset }).optional(),
  customer_overlap: z.enum(['forbid', 'allow']),
  retroactive: z.enum(['none', 'lenient_only']),
  strike_window: Duration.optional(),                 // default "90d"
});

// ── §4.9 Entitlement products ──────────────────────────────────────────────────────────────────────────────────────

export const EntitlementProductDef = z.strictObject({
  ...flagRef,
  key: Key, name: z.string(), kind: z.enum(['membership', 'pack']),
  tier: Key.optional(),
  grants: z.array(z.strictObject({
    unit: Key, amount: z.union([UnitAmount, z.literal('unlimited')]), per: z.enum(['week', 'month']).optional(),
    rollover: z.boolean().optional(),
  })),
  covers: Expr.optional(),
  caps: z.array(z.strictObject({
    key: Key, window: z.enum(['day', 'week', 'month']), max: z.number().int().min(0), count_if: Expr.optional(),
  })).optional(),
  validity: z.strictObject({ length: Duration.optional(), anchor: z.enum(['purchase', 'first_use']), recurring: z.boolean() }),
  freeze: z.strictObject({
    allowed: z.boolean(), max_per_year: Duration, min: Duration, on_existing: z.enum(['keep', 'cancel_timely']),
  }).optional(),
  dunning_grace: Duration.optional(),                 // memberships; default "3d"
  priority: z.number(),
  sold_by: z.enum(['platform', 'external']),
  price: Money.optional(),
  processor_price_ref: z.string().optional(),         // 2.1
});

// ── §4.10 Availability ─────────────────────────────────────────────────────────────────────────────────────────────

export const AvailabilityRuleDef = z.strictObject({
  key: Key,
  applies_to: z.strictObject({
    locations: z.array(Key).optional(), resources: z.array(Key).optional(), tags_any: z.array(z.string()).optional(),
  }),
  kind: z.enum(['open', 'closed']),
  weekly: z.partialRecord(Weekday, z.array(LocalInterval)).optional(),
  dates: z.array(z.strictObject({ date: LocalDate, intervals: z.array(LocalInterval).optional() })).optional(),
  reason: z.string().optional(),
});

// ── §4.11 Constraints and coverage ─────────────────────────────────────────────────────────────────────────────────

export const Counts = z.enum(['all_work', 'matching']);   // default all_work
const TagScope = z.strictObject({ template_tags: z.array(z.string()).optional() });
export const ConstraintRule = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('max_hours'), window: z.enum(['day', 'week', 'rolling_7d']), hours: z.number(), counts: Counts.optional() }),
  z.strictObject({ type: z.literal('min_hours'), window: z.literal('week'), hours: z.number() }),
  z.strictObject({ type: z.literal('min_rest'), duration: Duration, from: TagScope.optional(), to: TagScope.optional() }),
  z.strictObject({ type: z.literal('max_consecutive_days'), days: z.number().int().min(1), counts: Counts.optional() }),
  z.strictObject({ type: z.literal('max_assignments'), window: z.enum(['day', 'week']), count: z.number().int().min(0), counts: Counts.optional() }),
  z.strictObject({ type: z.literal('transfer_time') }),
  z.strictObject({ type: z.literal('fairness'), metric: z.enum(['hours', 'assignments', 'weekend_assignments', 'closing_shifts']) }),
  z.strictObject({ type: z.literal('preferences') }),
  z.strictObject({ type: z.literal('continuity') }),
  z.strictObject({ type: z.literal('stability') }),
  z.strictObject({ type: z.literal('assignment_expr'), must: Expr }),
]);

export const ConstraintDef = z.strictObject({
  ...flagRef,
  key: Key, description: z.string(),
  level: z.enum(['hard', 'soft']), weight: z.number().int().min(1).max(1000).optional(),   // weight: soft only
  applies_to: z.strictObject({
    roles: z.array(Key).optional(), templates: z.array(Key).optional(), template_tags: z.array(z.string()).optional(),
    people_where: Expr.optional(),
  }),
  rule: ConstraintRule,
}).superRefine((c, ctx) => {
  if (c.level === 'hard' && c.weight !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['weight'], message: 'weight applies to soft constraints only' });
  }
});

export const CoverageDef = z.strictObject({
  ...flagRef,
  key: Key, location: Key, role: Key, shift_templates: z.array(Key),
  pattern: z.array(z.strictObject({
    days: z.array(Weekday), from: LocalTime, to: LocalTime, min: z.number().int().min(0), target: z.number().int().min(0).optional(),
  })),
  level: z.enum(['hard', 'soft']), weight: z.number().optional(), except_dates: z.array(LocalDate).optional(),
});

// ── §4.12 / §9.2 / §9.4 Workflows ──────────────────────────────────────────────────────────────────────────────────

export const EventName = z.string().regex(/^[a-z_]+\.[a-z_.]+$/, 'must be an event name such as session.cancelled');

export const Trigger = z.union([
  z.strictObject({ event: z.union([EventName, z.array(EventName).min(1)]), where: Expr.optional() }),   // list form: 2.1
  z.strictObject({
    at: z.strictObject({
      relative_to: z.enum(['session.start', 'session.end', 'booking.created']), offset: SignedDuration,
      templates_tagged: z.array(z.string()).optional(), templates: z.array(Key).optional(),
      for_each: z.enum(['session', 'booking']).optional(),
    }),
  }),
  z.strictObject({ every: z.strictObject({ rrule: z.string(), at_local: LocalTime, location: Key }) }),
]);

export const Recipient = z.union([
  z.strictObject({ customer: z.literal(true) }),
  z.strictObject({ session_customers: z.literal(true) }),
  z.strictObject({ waitlist: z.literal(true) }),
  z.strictObject({ assignment: Key }),
  z.strictObject({ assignment_people: z.literal(true) }),
  z.strictObject({ event_people: z.literal(true) }),
  z.strictObject({ roles: z.array(PlatformRole), location: z.literal('session').optional() }),
  z.strictObject({ all_members: z.literal(true) }),
]);

const actionBase = { id: z.string().optional(), delay: Duration.optional(), when: Expr.optional() };
export const ActionDef = z.discriminatedUnion('type', [
  z.strictObject({
    ...actionBase, type: z.literal('notify'), channel: z.enum(['email', 'sms', 'push', 'staff_chat']), to: Recipient,
    message: z.string(), vars: z.record(z.string(), Expr).optional(),
  }),
  z.strictObject({
    ...actionBase, type: z.literal('create_task'), list: z.enum(['desk_checklist', 'manager_inbox']), title: z.string(),
    due: Offset.optional(), location: Key.optional(),
  }),
  z.strictObject({ ...actionBase, type: z.literal('cancel_session'), reason: z.string() }),
  z.strictObject({
    ...actionBase, type: z.literal('adjust_units'), unit: Key,
    amount: z.number().refine((n) => Math.abs(n) <= 2, '|amount| ≤ 2 per run'), reason: z.string(),
  }),
  z.strictObject({
    ...actionBase, type: z.literal('set_field'), entity: z.enum(['booking', 'customer', 'session']), field: Key, value: Expr,
  }),
  z.strictObject({
    ...actionBase, type: z.literal('invoke_hook'), hook: z.enum(['substitute_finder', 'explain_block', 'staff_draft']),
    input: z.record(z.string(), Expr),
  }),
  z.strictObject({
    ...actionBase, type: z.literal('request_solve'), horizon: z.strictObject({ days_ahead: z.number().int().min(1) }),
    scope: z.strictObject({ roles: z.array(Key).optional() }), publish: z.literal('proposal'),
  }),
  z.strictObject({
    ...actionBase, type: z.literal('emit_event'),
    name: z.string().regex(/^custom\.[a-z0-9_.]+$/, 'must be custom.<name>'), data: z.record(z.string(), Expr).optional(),
  }),
]);

export const WorkflowDef = z.strictObject({
  ...flagRef,
  key: Key, name: z.string(),
  scope: z.enum(['owned', 'all']).optional(),         // 2.1; default from tenant.member_messaging (§9.3)
  trigger: Trigger,
  condition: Expr.optional(), recheck_at_fire: z.boolean(),
  actions: z.array(ActionDef),
  max_runs_per_subject: z.number().int().min(1).optional(),
});

export const CustomFieldDef = z.strictObject({
  key: Key, label: z.string(), entity: z.enum(['customer', 'booking', 'session', 'resource']),
  type: z.enum(['text', 'long_text', 'int', 'bool', 'date', 'enum', 'multi_enum', 'consent']),
  options: z.array(z.string()).optional(), required_if: Expr.optional(),
  visible_to: z.array(PlatformRole), editable_by: z.array(PlatformRole),
  pii: z.boolean(), retention: Duration.optional(),
});

export const FormDef = z.strictObject({ key: Key, name: z.string(), fields: z.array(Key) });

export const ViewDef = z.strictObject({
  key: Key, name: z.string(), entity: z.enum(['session', 'booking', 'customer', 'assignment', 'resource']),
  roles: z.array(PlatformRole), columns: z.array(z.string()), filter: Expr.optional(),
  sort: z.array(z.strictObject({ by: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
});

// ── §4.13 Access (locked) ──────────────────────────────────────────────────────────────────────────────────────────

export const AccessDef = z.strictObject({
  issuers: z.array(z.strictObject({
    key: Key, audience: z.enum(['member', 'staff']), issuer: z.string(), jwks_url: z.string(),
    subject_claim: z.string(), tenant_claim: z.string(),
  })),
  role_mappings: z.array(z.strictObject({
    issuer: Key, claim: z.string(), equals: z.string(), grant: PlatformRole, location_claim: z.string().optional(),
  })),
  staff_role_mappings: z.array(z.strictObject({ issuer: Key, claim: z.string(), equals: z.string(), role: Key })),
  default_member_role: z.literal('member'),
});

// ── §4.14 Simulation profiles ──────────────────────────────────────────────────────────────────────────────────────

export const SimulationProfileDef = z.strictObject({
  key: Key, source: z.enum(['synthetic', 'historical']), horizon: Duration, seed: z.number().int(),
  demand: z.array(z.strictObject({
    templates: z.array(Key).optional(), templates_tagged: z.array(z.string()).optional(),
    per_session: z.strictObject({ mean: z.number(), sd: z.number() }),
    lead_time: z.strictObject({ distribution: z.literal('exponential'), mean: Duration }),
    cancel_rate: z.number(), late_cancel_rate: z.number(), no_show_rate: z.number(),
    tier_mix: z.record(Key, z.number()).optional(),
  })),
});

// ── §4.1 Document ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSIONS = ['2.0', '2.1'] as const;

export const ConfigDocumentSchema = z.strictObject({
  schema_version: z.enum(SCHEMA_VERSIONS),
  tenant: TenantSettings,
  locations: z.array(LocationDef),
  units: z.array(UnitDef),
  skills: z.array(SkillDef),
  roles: z.array(RoleDef),
  tiers: z.array(TierDef),
  resource_types: z.array(ResourceTypeDef),
  resources: z.array(ResourceDef),
  layouts: z.array(LayoutDef),
  templates: z.array(TemplateDef),
  timetable: z.array(SeriesDef),
  policies: z.array(PolicySetDef),
  entitlement_products: z.array(EntitlementProductDef),
  availability: z.array(AvailabilityRuleDef),
  constraints: z.array(ConstraintDef),
  coverage: z.array(CoverageDef),
  workflows: z.array(WorkflowDef),
  custom_fields: z.array(CustomFieldDef),
  forms: z.array(FormDef),
  views: z.array(ViewDef),
  simulation: z.array(SimulationProfileDef),
  access: AccessDef,                                  // LOCKED (§4.1.1)
}).superRefine((doc, ctx) => {
  // A 2.0 document may not use the fields 2.1 added (§4.1).
  if (doc.schema_version !== '2.0') return;
  for (const path of fieldsAddedIn21(doc)) {
    ctx.addIssue({ code: 'custom', path, message: 'this field needs schema_version "2.1"' });
  }
});

export type ConfigDocument = z.infer<typeof ConfigDocumentSchema>;
export type TenantSettings = z.infer<typeof TenantSettings>;
export type PayrollExportSettings = z.infer<typeof PayrollExportSettings>;
export type LocationDef = z.infer<typeof LocationDef>;
export type UnitDef = z.infer<typeof UnitDef>;
export type SkillDef = z.infer<typeof SkillDef>;
export type RoleDef = z.infer<typeof RoleDef>;
export type TierDef = z.infer<typeof TierDef>;
export type ResourceTypeDef = z.infer<typeof ResourceTypeDef>;
export type ResourceDef = z.infer<typeof ResourceDef>;
export type LayoutDef = z.infer<typeof LayoutDef>;
export type TemplateDef = z.infer<typeof TemplateDef>;
export type RequirementDef = z.infer<typeof RequirementDef>;
export type CapacitySpec = z.infer<typeof CapacitySpec>;
export type PartitionDef = z.infer<typeof PartitionDef>;
export type CostSpec = z.infer<typeof CostSpec>;
export type SeriesDef = z.infer<typeof SeriesDef>;
export type PolicySetDef = z.infer<typeof PolicySetDef>;
export type Penalty = z.infer<typeof Penalty>;
export type RefundRules = z.infer<typeof RefundRules>;
export type BookingLimitDef = z.infer<typeof BookingLimitDef>;
export type WaitlistPolicy = z.infer<typeof WaitlistPolicy>;
export type EntitlementProductDef = z.infer<typeof EntitlementProductDef>;
export type AvailabilityRuleDef = z.infer<typeof AvailabilityRuleDef>;
export type ConstraintDef = z.infer<typeof ConstraintDef>;
export type ConstraintRule = z.infer<typeof ConstraintRule>;
export type CoverageDef = z.infer<typeof CoverageDef>;
export type Trigger = z.infer<typeof Trigger>;
export type Recipient = z.infer<typeof Recipient>;
export type ActionDef = z.infer<typeof ActionDef>;
export type WorkflowDef = z.infer<typeof WorkflowDef>;
export type CustomFieldDef = z.infer<typeof CustomFieldDef>;
export type FormDef = z.infer<typeof FormDef>;
export type ViewDef = z.infer<typeof ViewDef>;
export type AccessDef = z.infer<typeof AccessDef>;
export type SimulationProfileDef = z.infer<typeof SimulationProfileDef>;
export type Offset = z.infer<typeof Offset>;
export type Money = z.infer<typeof Money>;
export type Weekday = z.infer<typeof Weekday>;
export type PlatformRole = z.infer<typeof PlatformRole>;

/** Paths of every field that schema 2.1 added (§4.1), as Zod paths. */
export function fieldsAddedIn21(doc: ConfigDocument): (string | number)[][] {
  const out: (string | number)[][] = [];
  if (doc.tenant.member_messaging !== undefined) out.push(['tenant', 'member_messaging']);
  doc.policies.forEach((p, i) => { if (p.refund.late !== undefined) out.push(['policies', i, 'refund', 'late']); });
  doc.workflows.forEach((w, i) => {
    if (w.scope !== undefined) out.push(['workflows', i, 'scope']);
    if ('event' in w.trigger && Array.isArray(w.trigger.event)) out.push(['workflows', i, 'trigger', 'event']);
  });
  doc.constraints.forEach((c, i) => {
    if (c.rule.type !== 'min_rest') return;
    if (c.rule.from !== undefined) out.push(['constraints', i, 'rule', 'from']);
    if (c.rule.to !== undefined) out.push(['constraints', i, 'rule', 'to']);
  });
  doc.entitlement_products.forEach((e, i) => {
    if (e.processor_price_ref !== undefined) out.push(['entitlement_products', i, 'processor_price_ref']);
  });
  return out;
}

/** Minutes in a Duration, with w = 7 d and d = 24 h. Calendar units are approximated as elapsed for comparisons. */
export function durationMinutes(d: string): number {
  const m = /^([+-])?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(d);
  if (!m) return NaN;
  const n = (s: string | undefined): number => (s === undefined ? 0 : Number(s));
  const total = n(m[2]) * 10080 + n(m[3]) * 1440 + n(m[4]) * 60 + n(m[5]);
  return m[1] === '-' ? -total : total;
}
