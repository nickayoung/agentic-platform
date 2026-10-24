# 4. Configuration schema

The config document is one JSON object per tenant and environment. It is authored and shown as YAML and stored as canonical JSON (RFC 8785). The **normative definition** is the TypeScript below. The implementation MUST define it once as Zod schemas in `packages/config-schema`. JSON Schema (for the agent's tools) and the OpenAPI components are generated from those Zod schemas. Nothing else may define config shapes.

## 4.1 Document structure and schema versioning

```ts
interface ConfigDocument {
  schema_version: '1.0';             // semver major.minor of THIS schema
  tenant: TenantSettings;            // §4.3
  locations: LocationDef[];          // §4.3
  units: UnitDef[];                  // §4.4
  skills: SkillDef[];
  roles: RoleDef[];
  tiers: TierDef[];
  resource_types: ResourceTypeDef[]; // §4.5
  resources: ResourceDef[];
  layouts: LayoutDef[];
  templates: TemplateDef[];          // §4.6
  timetable: SeriesDef[];            // §4.7
  policies: PolicySetDef[];          // §4.8
  entitlement_products: EntitlementProductDef[];   // §4.9
  availability: AvailabilityRuleDef[];             // §4.10
  constraints: ConstraintDef[];      // §4.11
  coverage: CoverageDef[];
  workflows: WorkflowDef[];          // §4.12 (semantics in §9)
  custom_fields: CustomFieldDef[];
  forms: FormDef[];
  views: ViewDef[];
  territories: TerritoryDef[];       // §4.14
  travel: TravelDef | null;
  simulation: SimulationProfileDef[];
  access: AccessDef;                 // §4.13  LOCKED: humans with role owner only
}
```

- Empty collections MUST be present as `[]` so that diffs stay simple.
- YAML is parsed as **YAML 1.2, core schema**, so `yes`, `no`, `on` and `off` stay strings. Still, no schema field is named after a YAML 1.1 boolean word (which is why workflow triggers use `event:` and not `on:`).
- `schema_version` minor bumps are additive: new optional fields only. A major bump comes with a deterministic migration function `migrate_1_to_2(doc)` that is tested on every stored version.
- **Locked sections.** The configuration agent MUST NOT patch `access`, `tenant.environment_guards` or anything under `/workflows/*/actions/*/charge` above the fee ceiling (§13.5). The patch tool rejects such paths with `LOCKED_PATH`.

## 4.2 Common types

```ts
type Key = string;                    // ^[a-z][a-z0-9_]{1,62}$
type Expr = string;                   // CEL source, type-checked per slot (§5)
type LocalTime = `${number}:${number}`;    // "06:30"
type LocalDate = string;              // "2026-11-01"
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Money = { minor: number; currency: string };

/** Duration grammar: ^(\d+w)?(\d+d)?(\d+h)?(\d+m)?$  e.g. "45m", "1h30m", "7d".
 *  w and d are CALENDAR units in the relevant zone; h and m are ELAPSED time.
 *  Every value used for session times, buffers and steps MUST be a multiple of 5m. */
type Duration = string;

/** A point in time relative to a session. */
type Offset =
  | { before_start: Duration; at_local?: LocalTime }  // at_local snaps to that wall time on the resulting day
  | { after_start: Duration }
  | { before_end: Duration }
  | { after_end: Duration };

/** Signed duration used by relative triggers: "-2h", "+15m". */
type SignedDuration = string;

type AttrValue = string | number | boolean | string[];

type FlagRef = { flag?: string };     // when set, the element is inactive unless the flag is on
```

## 4.3 Tenant and locations

```ts
interface TenantSettings {
  name: string;
  default_timezone: string;           // IANA
  currency: string;                   // ISO 4217
  locale: string;                     // BCP 47
  week_starts: Weekday;               // for 'week' windows
  hold_ttl: Duration;                 // default "5m"; max "20m"
  materialize_horizon: Duration;      // timetable sessions created this far ahead; default "8w"
  customer_label: string;             // "member", "patient", "client"
  environment_guards: { preview_outbound: 'sandbox' | 'record_only' };  // LOCKED
}

interface LocationDef {
  key: Key; name: string;
  timezone: string;                   // IANA, required
  address?: { line1: string; city: string; region?: string; postal_code: string; country: string };
  geo?: { lat: number; lng: number };
  transfer_times?: { to: Key; duration: Duration }[];   // staff travel between locations
}
```

## 4.4 Catalogs

```ts
interface UnitDef  { key: Key; name: string; }                        // "class_credit", "pt_session"
interface SkillDef { key: Key; name: string; expires: boolean; }      // certifications expire
interface RoleDef  { key: Key; name: string; implies_skills?: Key[]; }// "desk", "instructor"
interface TierDef  { key: Key; name: string; rank: number; }          // higher rank = higher tier
```

## 4.5 Resource types, resources, layouts

```ts
interface ResourceTypeDef {
  key: Key; name: string;
  kind: 'person' | 'space' | 'spot' | 'equipment' | 'vehicle';
  attributes: { key: Key; type: 'string' | 'int' | 'number' | 'bool' | 'enum' | 'string_list';
                values?: string[]; required?: boolean; default?: AttrValue }[];
  default_concurrency?: number;       // default 1
}

/** Structural (non-person) resources. People are runtime data (§3.4). */
interface ResourceDef extends FlagRef {
  key: Key; type: Key; name: string;
  location: Key;
  parent?: Key;                       // another ResourceDef key
  tags?: string[];
  attributes?: Record<string, AttrValue>;
  concurrency?: number;               // lanes; overrides type default
  layout?: Key;                       // LayoutDef that generates child spots
}

interface LayoutDef {
  key: Key;
  spot_type: Key;                     // ResourceTypeDef with kind 'spot'
  grid?: { rows: number; cols: number };
  generate?: { prefix: string; label: string; count: number; per_row: number };  // label: "Bike {n}"
  spots?: { key: Key; label: string; row?: number; col?: number;
            tags?: string[]; attributes?: Record<string, AttrValue> }[];
  overrides?: { match: { keys?: Key[]; rows?: number[] }; tags?: string[];
                attributes?: Record<string, AttrValue>; disabled?: boolean }[];
}
```

Generated spot keys are `<layout.key>.<prefix><n>` (for example `cycle_room_40.bike_12`). They become child resources of the space that references the layout.

## 4.6 Templates

```ts
interface TemplateDef extends FlagRef {
  key: Key; name: string;
  kind: 'class' | 'appointment' | 'shift' | 'job' | 'space_booking';   // UI LABEL ONLY (principle 4)
  tags?: string[];
  duration: Duration | { min: Duration; max: Duration; step: Duration; default: Duration };
  scheduling: SchedulingSpec;
  participants: { who: 'customers'; capacity: CapacitySpec; allow_guests?: number }  // max guests per booking
              | { who: 'none' };
  requirements: RequirementDef[];
  buffers?: { before?: Duration; after?: Duration };   // default for every requirement
  cost?: CostSpec;
  policy?: Key;                       // PolicySetDef; required when participants.who = customers
  eligible_if?: Expr;                 // ctx: booking (§5.3) → bool
  ineligible_message?: string;        // shown with reason NOT_ELIGIBLE
  intake?: { form: Key; when?: Expr };   // ctx: booking → bool
  custom_fields?: Key[];              // session-level fields shown to staff
}

type SchedulingSpec =
  | { mode: 'timetable' }             // sessions come from timetable series or staff creation
  | { mode: 'on_demand'; slot_step: Duration; min_lead: Duration; horizon: Duration }
  | { mode: 'rostered'; allowed_starts?: LocalTime[] }     // shifts: created by roster solve or managers
  | { mode: 'arrival_window'; windows: { start: LocalTime; end: LocalTime }[];
      min_lead: Duration; horizon: Duration };             // field service: customer picks window

interface RequirementDef {
  key: Key;                           // "instructor", "room", "trainer", "tech"
  select: ResourceSelector;
  count?: number;                     // default 1
  assign: 'fixed' | 'customer_choice' | 'auto' | 'roster' | 'deferred';
  occupancy?: 'exclusive' | 'lane' | 'none';   // default 'exclusive'
  buffers?: { before?: Duration; after?: Duration };   // overrides template buffers
  travel?: boolean;                   // include travel from/to adjacent claims (field service)
  rank?: { prefer: 'continuity' | 'least_loaded' | 'customer_history' | 'expr'; expr?: Expr };
                                      // ordering among valid candidates for assign=auto (ctx: candidate → double)
  provides_layout?: boolean;          // this requirement's space supplies spots for assigned capacity
}

interface ResourceSelector {
  type?: Key; kind?: 'person' | 'space' | 'spot' | 'equipment' | 'vehicle';
  resources?: string[];               // structural keys or "@staff:<key>"
  tags_all?: string[]; tags_any?: string[];
  skills_all?: Key[]; role?: Key;
  same_location?: boolean;            // default true: resource must belong to the session location
  where?: Expr;                       // ctx: candidate (§5.3) → bool
}

type CapacitySpec =
  | { mode: 'single' }                                         // 1 place
  | { mode: 'pooled'; places: number }                         // N anonymous places
  | { mode: 'pooled_from_space'; requirement: Key }            // N = space attribute "capacity"
  | { mode: 'assigned'; requirement: Key; auto_assign: boolean }  // spots of the space's layout
  | { mode: 'mixed'; base: { mode: 'pooled'; places: number } | { mode: 'assigned'; requirement: Key };
      partitions: PartitionDef[] };

interface PartitionDef {
  key: Key;                           // "general" is implicit and receives every unpartitioned place
  count?: number;                     // pooled base: number of places
  spots?: { tags_any?: string[]; keys?: Key[] };   // assigned base: which spots
  eligible_if: Expr;                  // ctx: booking → bool
  online: boolean;                    // false = desk only (walk-ins)
  release?: { at: Offset; to: Key };  // e.g. unsold premium places go to "general" 24h before
}

interface CostSpec {
  payment: 'units_or_price' | 'units_only' | 'price_only' | 'none';
  units?: { unit: Key; amount: number | Expr }[];  // Expr ctx: booking → double (e.g. per-hour)
  price?: Money;
  price_rules?: { when: Expr; price: Money }[];    // first match wins; ctx: booking
}
```

**Occupancy modes.** `exclusive` claims *every* lane of the resource for the occupied interval, so nothing else can use it. `lane` claims one lane, so up to `concurrency` claims can overlap. `none` writes no claim: the resource is a container that limits capacity, such as an open floor or a hot-desk floor whose spots are places. On a resource with `concurrency = 1`, `exclusive` and `lane` behave the same. A class claims Studio A as `exclusive`. A PT session claims one lane of the four-lane PT zone, or the only lane of Studio A when Studio A is free.

**Assignment modes**

| `assign` | Who picks the resource | When | Example |
|---|---|---|---|
| `fixed` | The series, or staff when creating a session. For sessions created by the roster or by booking, it is the **single** resource that matches the selector at the session's location (more than one match → `FIXED_AMBIGUOUS`) | At session creation | Room for a timetabled class; the front desk for a desk shift |
| `customer_choice` | The customer (or "any", which falls back to `auto`) | At booking | Pick your physio, pick a desk |
| `auto` | Booking engine, ordered by `rank` | At booking | Any free PT zone lane |
| `roster` | Rostering engine or a manager, through a proposal | Before the session, published | Instructor for a class; worker for a shift |
| `deferred` | Routing engine at dispatch; feasibility checked at booking | Before the day | HVAC technician for an arrival window |

## 4.7 Timetable

```ts
interface SeriesDef extends FlagRef {
  key: Key; template: Key; location: Key;
  rrule: string;                      // RFC 5545 RRULE without DTSTART, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  start_local: LocalTime;             // DTSTART time in the location's zone
  valid_from: LocalDate; valid_until?: LocalDate;
  exdates?: LocalDate[];              // skipped dates (holidays)
  fixed: Record<Key, string | string[]>;   // requirement key → resource key(s) or "@staff:<key>"
  capacity_override?: number;         // pooled only; must be ≤ space capacity
  duration_override?: Duration;
}
```

## 4.8 Policies

```ts
interface PolicySetDef {
  key: Key; name: string;
  booking_window: { opens: Offset; closes: Offset };
  eligible_if?: Expr;                 // in addition to the template's
  cancellation: {
    customer_can_cancel: boolean;
    free_until: Offset;               // cancel before this → full release
    late: Penalty;                    // cancel after free_until and before start
    no_show: Penalty & { grace: Duration };   // not checked in by start + grace
  };
  limits: BookingLimitDef[];
  approval?: { required_if: Expr; approver_roles: PlatformRole[]; timeout: Duration;
               on_timeout: 'reject' | 'approve' };
  min_attendance?: { min: number; check_at: Offset; action: 'cancel_session' | 'notify_staff' };
  waitlist?: WaitlistPolicy;
  check_in?: { opens: Offset; closes: Offset };
  reschedule?: { allowed: boolean; until: Offset };
  customer_overlap: 'forbid' | 'allow';      // may a customer hold overlapping bookings
  retroactive: 'none' | 'lenient_only';      // §6.8
}

interface Penalty {
  forfeit_units: boolean;             // unit-paid bookings lose the reserved units
  fee?: Money;                        // charged through the payment processor via gateway
  fee_if?: Expr;                      // ctx: booking → bool; default true when fee set
  strikes?: number;                   // added to customer.strikes
  waive_if?: Expr;                    // evaluated at assess time, ctx: booking → bool
  assess_at: 'immediately' | 'session_start' | 'session_end';
}

interface BookingLimitDef {
  key: Key;
  window: 'day' | 'week' | 'month' | 'upcoming';  // 'upcoming' = concurrent future bookings
  max: number;
  count_if?: Expr;                    // which bookings count; ctx: booking (of the counted booking)
  applies_if?: Expr;                  // which customers it applies to; ctx: booking
  message: string;
}

interface WaitlistPolicy {
  enabled: boolean;
  max_size: number;
  require_entitlement: boolean;       // only customers who could pay may join
  schedule: { until: Offset; mode: 'auto_promote' | 'offer_all' | 'closed' }[];  // ordered, first matching
  offer_ttl: Duration;                // for offer_all
  place_choice: 'preferred_then_best' | 'best';
}
```

The `schedule` list is read in order. At time `t`, the mode is that of the first entry whose `until` instant is still after `t`. If no entry matches, the waitlist is `closed`. For example `[{until:{before_start:'2h'}, mode:auto_promote}, {until:{before_start:'15m'}, mode:offer_all}]` means auto-promote until 2 hours before start, then offer to everyone until 15 minutes before, then closed.

## 4.9 Entitlement products

```ts
interface EntitlementProductDef extends FlagRef {
  key: Key; name: string;
  kind: 'membership' | 'pack' | 'pass';
  tier?: Key;
  grants: { unit: Key; amount: number | 'unlimited'; per?: 'week' | 'month'; rollover?: boolean }[];
  covers?: Expr;                      // ctx: booking → bool; default true
  caps?: { key: Key; window: 'day' | 'week' | 'month'; max: number; count_if?: Expr }[];
  validity: { length?: Duration; anchor: 'purchase' | 'first_use'; recurring: boolean };
  priority: number;                   // lower is used first when several entitlements cover a booking
  sold_by: 'platform' | 'external';
  price?: Money;
}
```

## 4.10 Availability rules (structural resources and locations)

```ts
interface AvailabilityRuleDef {
  key: Key;
  applies_to: { locations?: Key[]; resources?: Key[]; tags_any?: string[] };
  kind: 'open' | 'closed';
  weekly?: Partial<Record<Weekday, [LocalTime, LocalTime][]>>;   // wall-clock intervals per day
  dates?: { date: LocalDate; intervals?: [LocalTime, LocalTime][] }[];  // no intervals = whole day
  reason?: string;
}
```

Structural resources are available when an `open` rule covers them and no `closed` rule does. If no `open` rule names a resource, it inherits its location's opening hours. A location with no `open` rule is always open (restaurants and other businesses that are fully driven by shifts often declare none). People's availability is runtime data (§3.5). A `closed` rule on a location also closes all its resources.

## 4.11 Constraints and coverage

```ts
interface ConstraintDef extends FlagRef {
  key: Key; description: string;      // description is shown in infeasibility reports
  level: 'hard' | 'soft';
  weight?: number;                    // soft only, 1..1000
  applies_to: { roles?: Key[]; templates?: Key[]; template_tags?: string[]; people_where?: Expr };
  rule: ConstraintRule;
}

type ConstraintRule =
  | { type: 'max_hours'; window: 'day' | 'week' | 'rolling_7d'; hours: number }
  | { type: 'min_hours'; window: 'week'; hours: number }
  | { type: 'min_rest'; duration: Duration }                   // gap from one claim's occ_end to the next claim's occ_start (buffers included)
  | { type: 'max_consecutive_days'; days: number }
  | { type: 'max_assignments'; window: 'day' | 'week'; count: number }
  | { type: 'shift_length'; min?: Duration; max?: Duration }
  | { type: 'allowed_hours'; from: LocalTime; to: LocalTime; days?: Weekday[] }   // e.g. minors
  | { type: 'transfer_time' }                                  // uses locations[].transfer_times
  | { type: 'fairness'; metric: 'hours' | 'assignments' | 'weekend_assignments' | 'closing_shifts' }
  | { type: 'preferences' }                                    // AvailabilityRecord preferred/avoid
  | { type: 'continuity' }                                     // same person for a series
  | { type: 'stability' }                                      // minimise change vs published roster
  | { type: 'minimize_travel' }
  | { type: 'territory_match' }                                // person.attributes.territories ∋ site territory
  | { type: 'assignment_expr'; must: Expr };                   // ctx: candidate → bool (hard) / penalty if false (soft)

interface CoverageDef extends FlagRef {
  key: Key; location: Key; role: Key;
  shift_templates: Key[];             // rostered templates that may be used to cover
  pattern: { days: Weekday[]; from: LocalTime; to: LocalTime; min: number; target?: number }[];
  level: 'hard' | 'soft';             // hard: min must be met; target shortfall is always soft
  weight?: number;
  except_dates?: LocalDate[];
}
```

Booking-time hard checks for people (overlap, availability, `min_rest`, `max_hours`, `transfer_time`, `allowed_hours`) are enforced by the same validator whether a person is assigned by the solver, a manager, a swap, or the booking engine for `auto`/`customer_choice` (§8.6). Fairness, preference, continuity, stability and travel minimisation are solver objectives only.

## 4.12 Workflows, custom fields, forms, views

```ts
interface WorkflowDef extends FlagRef {
  key: Key; name: string;
  trigger: { event: EventName; where?: Expr }                      // §9.2 event catalog
         | { at: { relative_to: 'session.start' | 'session.end' | 'booking.created' | 'hold.created';
                   offset: SignedDuration; templates_tagged?: string[]; templates?: Key[];
                   for_each?: 'session' | 'booking' } }      // default 'session' (§9.2)
         | { every: { rrule: string; at_local: LocalTime; location: Key } };
  condition?: Expr;                   // ctx depends on trigger (§9.3)
  recheck_at_fire: boolean;           // default true: re-evaluate condition when a delayed action fires
  actions: ActionDef[];               // ActionDef and Recipient are defined in §9.4
  max_runs_per_subject?: number;      // default unlimited
}

interface CustomFieldDef {
  key: Key; label: string;
  entity: 'customer' | 'booking' | 'session' | 'resource';
  type: 'text' | 'long_text' | 'int' | 'bool' | 'date' | 'enum' | 'multi_enum' | 'consent';
  options?: string[];
  required_if?: Expr;                 // ctx: booking or customer → bool
  visible_to: PlatformRole[]; editable_by: PlatformRole[];
  pii: boolean;                       // PII fields are encrypted at rest and redacted in agent context (§13.3)
  retention?: Duration;
}

interface FormDef { key: Key; name: string; fields: Key[]; }

interface ViewDef {
  key: Key; name: string;
  entity: 'session' | 'booking' | 'customer' | 'assignment' | 'resource';
  roles: PlatformRole[];
  columns: string[];                  // field paths, including custom.<key>
  filter?: Expr;                      // ctx: row → bool, with `me` and `now` bound
  sort?: { by: string; dir: 'asc' | 'desc' }[];
}
```

## 4.13 Access (locked)

```ts
type PlatformRole = 'owner' | 'admin' | 'manager' | 'desk' | 'instructor' | 'staff' | 'member' | 'guest';

interface AccessDef {
  issuers: { key: Key; audience: 'member' | 'staff'; issuer: string; jwks_url: string;
             subject_claim: string; tenant_claim: string }[];
  role_mappings: { issuer: Key; claim: string; equals: string; grant: PlatformRole;
                   location_claim?: string }[];   // claim listing locations the role applies to
  default_member_role: 'member';
}
```

## 4.14 Territories, travel, simulation

```ts
interface TerritoryDef { key: Key; name: string; postal_codes?: string[]; polygon?: [number, number][]; }

interface TravelDef {
  matrix_source: 'gateway:maps';      // travel times fetched through the gateway, cached
  fallback: { mode: 'haversine'; speed_kmh: number; detour_factor: number };
  cache_ttl: Duration;
  round_up_to: Duration;              // travel times are rounded up to this (≥ 5m)
}

interface SimulationProfileDef {
  key: Key; source: 'synthetic' | 'historical';
  horizon: Duration; seed: number;
  demand: { templates?: Key[]; templates_tagged?: string[];
            per_session?: { mean: number; sd: number };     // timetable/rostered
            per_day?: { mean: number; sd: number };         // on_demand / arrival_window
            lead_time: { distribution: 'exponential'; mean: Duration };
            cancel_rate: number; late_cancel_rate: number; no_show_rate: number;
            tier_mix?: Record<Key, number> }[];
}
```

## 4.15 Compiled config

Publishing compiles the document into `CompiledConfig`. Engines read only this compiled form:

- every `Expr` parsed, type-checked against its slot's context (§5.3) and cost-estimated, stored as an AST;
- layouts expanded into concrete spot resources with stable keys;
- `@staff:` references resolved to resource IDs, with failure if a reference is missing;
- durations and offsets normalised to minutes plus calendar parts;
- an index per resource of the templates that can claim it (used by the availability search);
- a `limits` table of every booking limit and entitlement cap, with counter-key formats (§12.5).

Compilation is deterministic: the same document always produces byte-identical compiled output.
