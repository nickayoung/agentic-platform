# 4. Configuration schema

The config document is one JSON object per tenant and environment. It is authored and shown as YAML, parsed as **YAML 1.2 core schema**, and stored as canonical JSON (RFC 8785). The TypeScript below is normative. It is implemented once as Zod schemas in `packages/config-schema`. JSON Schema (for agent tools) and the OpenAPI components are generated from those Zod schemas. No field is named after a YAML 1.1 boolean word (`on`, `off`, `yes`, `no`).

## 4.1 Document structure

```ts
interface ConfigDocument {
  schema_version: '2.0';
  tenant: TenantSettings;
  locations: LocationDef[];              // studios
  units: UnitDef[];
  skills: SkillDef[];
  roles: RoleDef[];                      // config staff roles: teacher, desk, …
  tiers: TierDef[];
  resource_types: ResourceTypeDef[];
  resources: ResourceDef[];              // rooms and front desks
  layouts: LayoutDef[];                  // mat layouts
  templates: TemplateDef[];              // class types and desk-shift types
  timetable: SeriesDef[];
  policies: PolicySetDef[];
  entitlement_products: EntitlementProductDef[];
  availability: AvailabilityRuleDef[];   // studio hours, planned closures
  constraints: ConstraintDef[];
  coverage: CoverageDef[];
  workflows: WorkflowDef[];
  custom_fields: CustomFieldDef[];
  forms: FormDef[];
  views: ViewDef[];
  simulation: SimulationProfileDef[];
  access: AccessDef;                     // LOCKED (§4.1.1)
}
```

- Every collection is present. An empty collection is written as `[]`.
- A minor bump to `schema_version` may only add optional fields. A major bump ships with a migration function (`migrate_2_to_3`) that is tested against every stored version.

### 4.1.1 Locked paths

The configuration agent may not patch:

- `/access`
- `/tenant/environment_guards`
- `/tenant/fee_ceiling`
- `/tenant/payroll_export`
- any penalty `fee` whose amount is above `tenant.fee_ceiling`

Such patches are rejected with `LOCKED_PATH`. Only a human with the `owner` role can change these paths, through the same draft-and-approval flow.

## 4.2 Common types

```ts
type Key = string;                       // ^[a-z][a-z0-9_]{1,62}$
type Expr = string;                      // CEL source, type-checked per slot (§5)
type LocalTime = string;                 // "06:30"
type LocalDate = string;                 // "2026-11-01"
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Money = { minor: number; currency: string };
/** ^(\d+w)?(\d+d)?(\d+h)?(\d+m)?$ — w and d are CALENDAR units in the studio's zone; h and m are ELAPSED.
 *  Session durations, buffers and series start times MUST be multiples of 5m. */
type Duration = string;
type Offset = { before_start: Duration; at_local?: LocalTime } | { after_start: Duration }
            | { before_end: Duration } | { after_end: Duration };
type SignedDuration = string;            // "-2h", "+15m"
type AttrValue = string | number | boolean | string[];
type FlagRef = { flag?: string };        // the element is inactive unless the flag is on
type PlatformRole = 'owner' | 'admin' | 'manager' | 'desk' | 'instructor' | 'staff' | 'member' | 'guest';
```

**Units in config and in storage.** Unit amounts in config are decimals with at most 2 decimal places. At compile time they are multiplied by 100 and stored as integer hundredths (§12.5).

## 4.3 Tenant and studios

```ts
interface TenantSettings {
  name: string; default_timezone: string; currency: string; locale: string;
  week_starts: Weekday;
  hold_ttl: Duration;                    // default "5m", max "15m"
  materialize_horizon: Duration;         // default "8w"
  customer_label: string;                // "member"
  fee_ceiling: Money;                    // LOCKED; default 100.00 in tenant currency
  closure_pay_notice: Duration;          // §3.12.2; default "2h"
  closing_notice: Duration;              // notice to members when the tenant closes; default "14d"
  refund_credit_product: Key;            // pack granted when refund.timely = 'credit' (§4.8)
  payroll_export: PayrollExportSettings; // LOCKED; Gusto CSV settings (§18.8.3)
  environment_guards: { preview_outbound: 'sandbox' | 'record_only' };   // LOCKED
}
interface LocationDef {
  key: Key; name: string; timezone: string;
  address?: { line1: string; city: string; region?: string; postal_code: string; country: string };
  transfer_times?: { to: Key; duration: Duration }[];   // staff travel time between studios
}
```

## 4.4 Catalogs

```ts
interface UnitDef  { key: Key; name: string }
interface SkillDef { key: Key; name: string; expires: boolean }
interface RoleDef  { key: Key; name: string; implies_skills?: Key[] }   // config staff role, not a PlatformRole
interface TierDef  { key: Key; name: string; rank: number }
```

A config role key MUST NOT equal a `PlatformRole` value. Validation rejects a clash with `ROLE_NAME_CLASH`. This is why the examples use `teacher` as the config role for instructors.

## 4.5 Resource types, rooms, layouts

```ts
interface ResourceTypeDef {
  key: Key; name: string; kind: 'person' | 'space' | 'spot';
  attributes: { key: Key; type: 'string' | 'int' | 'number' | 'bool' | 'enum' | 'string_list';
                values?: string[]; required?: boolean; default?: AttrValue }[];
  default_concurrency?: number;
}
interface ResourceDef extends FlagRef {
  key: Key; type: Key; name: string; location: Key;
  tags?: string[]; attributes?: Record<string, AttrValue>;
  concurrency?: number; layout?: Key;
}
interface LayoutDef {
  key: Key; spot_type: Key;
  grid: { rows: number; cols: number };
  generate: { prefix: string; label: string; count: number; per_row: number };   // label: "Mat {n}"
  overrides?: { match: { keys?: Key[]; rows?: number[] }; tags?: string[];
                attributes?: Record<string, AttrValue>; disabled?: boolean }[];
}
```

Spots are generated row by row. Spot *n* sits in row `ceil(n / per_row)`, and its key is `<layout>.<prefix><n>`. For example, with `per_row: 6`, `mats_30.mat_12` is in row 2 and `mat_3` is in row 1.

## 4.6 Templates

```ts
interface TemplateDef extends FlagRef {
  key: Key; name: string;
  kind: 'class' | 'shift';               // UI LABEL ONLY (principle 4)
  tags?: string[];
  duration: Duration;
  scheduling: { mode: 'timetable' }                                 // sessions come from series or one-off creation by staff
            | { mode: 'rostered';                                   // desk shifts, created by a roster solve or a manager
                starts: { at: LocalTime; days?: Weekday[]; locations?: Key[] }[] };   // omitted days/locations = all
  participants: { who: 'customers'; capacity: CapacitySpec; allow_guests?: number }
              | { who: 'none' };
  requirements: RequirementDef[];
  cost?: CostSpec;
  policy?: Key;                          // required when participants.who = customers
  eligible_if?: Expr; ineligible_message?: string;
  intake?: { form: Key; when?: Expr };
}

interface RequirementDef {
  key: Key;                              // "room", "teacher", "worker", "desk"
  select: { type?: Key; kind?: 'person' | 'space'; resources?: string[];
            tags_all?: string[]; tags_any?: string[]; skills_all?: Key[]; role?: Key;
            where?: Expr };              // ctx: candidate (§5.3)
  count?: number;                        // default 1
  assign: 'fixed' | 'roster';
  occupancy?: 'exclusive' | 'lane';      // default exclusive
  buffers?: { before?: Duration; after?: Duration };
  provides_layout?: boolean;
}

type CapacitySpec =
  | { mode: 'pooled'; places: number }
  | { mode: 'pooled_from_space'; requirement: Key }              // N = the room's `capacity` attribute
  | { mode: 'assigned'; requirement: Key; auto_assign: boolean } // places are the mats of the room's layout
  | { mode: 'mixed'; base: { mode: 'pooled'; places: number } | { mode: 'assigned'; requirement: Key };
      partitions: PartitionDef[] };
interface PartitionDef {
  key: Key;                              // "general" is implicit
  count?: number;                        // for a pooled base
  spots?: { tags_any?: string[]; keys?: Key[] };   // for an assigned base
  eligible_if: Expr; online: boolean;    // online = false → desk and portal channels only (walk-ins)
  release?: { at: Offset; to: Key };
}

interface CostSpec {
  payment: 'units_or_price' | 'units_only' | 'price_only' | 'none';
  units?: { unit: Key; amount: number }[];
  price?: Money;
  price_rules?: { when: Expr; price: Money }[];    // the first matching rule wins
}
```

**Assignment modes**
- `fixed`: the series or a staff member names the resource when the session is created. For `rostered` templates, `fixed` means the **single** resource that matches the selector at the session's studio. If more than one resource matches, validation fails with `FIXED_AMBIGUOUS`.
- `roster`: the rostering engine fills it, or a manager fills it through a proposal.

**Occupancy modes**
- `exclusive` claims every lane of the resource.
- `lane` claims one lane. Front desks use lanes so that two desk staff can work at the same desk at once.

A private class is a one-off session of a template with `{ mode: pooled, places: 1 }`.

**Shift candidates.** A rostered template yields one candidate shift for each matching `starts` entry, day and studio. A candidate is generated **only if** `[start, start + duration)` lies inside the availability of the requirement's `fixed` resource (the front desk) on that day. Since a desk follows its studio's hours (§4.10), shifts never fall outside opening hours. `COVERAGE_UNCOVERABLE` (§6.3) is evaluated against these candidates only.

## 4.7 Timetable and series edits

```ts
interface SeriesDef extends FlagRef {
  key: Key; template: Key; location: Key;
  rrule: string;                         // RFC 5545 RRULE, without DTSTART
  start_local: LocalTime;
  valid_from: LocalDate; valid_until?: LocalDate;
  exdates?: LocalDate[];
  fixed: Record<Key, string | string[]>; // requirement key → resource key or "@staff:<key>"
  capacity_override?: number;            // pooled templates only; ≤ room capacity
}
```

**Edit scopes.** The staff portal offers three edit scopes. Each one maps to exactly one operation.

| Scope | Operation | Goes through |
|---|---|---|
| **This one** | `PATCH /sessions/{id}`: retime, change room, change capacity, set a substitute, or cancel. This writes a `SessionException` and sets `detached = true`. Later series edits skip detached sessions | Engine validation (it is data, not config) |
| **This and following** | Config ops: set `valid_until` on the old series to the day before the edit date; add a new series `<old>_from_<yyyymmdd>` that carries the change from that date. Detached sessions keep their exceptions | Config publish, with an impact plan (§6.8) |
| **All** | A config op that edits the series in place | Config publish, with an impact plan |

A one-off session (`POST /sessions`) has no series, so it only supports "this one".

## 4.8 Policies

```ts
interface PolicySetDef {
  key: Key; name: string;
  booking_window: { opens: Offset; closes: Offset };
  eligible_if?: Expr;
  cancellation: {
    customer_can_cancel: boolean;
    free_until: Offset;
    late: Penalty;
    no_show: Penalty & { grace: Duration };
  };
  refund: RefundRules;
  limits: BookingLimitDef[];
  approval?: { required_if: Expr; approver_roles: PlatformRole[]; timeout: Duration; on_timeout: 'reject' | 'approve' };
  min_attendance?: { min: number; check_at: Offset; action: 'cancel_session' | 'notify_staff' };
  unstaffed: { check_at: Offset; action: 'cancel_session' | 'notify_staff' };   // REQUIRED for customer templates
  waitlist?: WaitlistPolicy;
  check_in?: { opens: Offset; closes: Offset };
  customer_overlap: 'forbid' | 'allow';
  retroactive: 'none' | 'lenient_only';
  strike_window?: Duration;              // default "90d"; strikes older than this no longer count (§3.5)
}
interface Penalty {
  forfeit_units: boolean; fee?: Money; fee_if?: Expr; strikes?: number; waive_if?: Expr;
  assess_at: 'immediately' | 'session_start' | 'session_end';
}
interface RefundRules {
  timely: 'full' | 'credit' | 'none';    // a price-paid booking cancelled before free_until
                                         //   'credit' = grant one entitlement of tenant.refund_credit_product instead of money
  studio_cancel: 'full';                 // the studio cancels (unstaffed, closure, minimum attendance): always a full refund
}
interface BookingLimitDef { key: Key; window: 'day' | 'week' | 'month' | 'upcoming'; max: number;
  count_if?: Expr; applies_if?: Expr; message: string }
interface WaitlistPolicy {
  enabled: boolean; max_size: number; require_entitlement: boolean;
  schedule: { until: Offset; mode: 'auto_promote' | 'offer_all' | 'closed' }[];   // offsets strictly decreasing
  offer_ttl: Duration;
  place_choice: 'preferred_then_best' | 'best';
}
```

- **`studio_cancel = full`** means: reserved units are released, price-paid bookings are refunded in full, and any late fee already charged for that session is reversed.
- **Partial refunds** exist only as `refund` proposals approved by a manager (§11.3).
- **`unstaffed`**: at `check_at`, if any `roster` requirement is still empty, the engine either cancels the class with `reason: no_staff` or notifies staff (§7.1).
- **Waitlist priority**: waitlisted members always have priority over new bookings (D-27).

## 4.9 Entitlement products

```ts
interface EntitlementProductDef extends FlagRef {
  key: Key; name: string; kind: 'membership' | 'pack';
  tier?: Key;
  grants: { unit: Key; amount: number | 'unlimited'; per?: 'week' | 'month'; rollover?: boolean }[];
  covers?: Expr;                         // ctx: booking
  caps?: { key: Key; window: 'day' | 'week' | 'month'; max: number; count_if?: Expr }[];
  validity: { length?: Duration; anchor: 'purchase' | 'first_use'; recurring: boolean };
  freeze?: { allowed: boolean; max_per_year: Duration; min: Duration; on_existing: 'keep' | 'cancel_timely' };
  dunning_grace?: Duration;              // memberships: coverage kept after a failed payment; default "3d"
  priority: number;
  sold_by: 'platform' | 'external';
  price?: Money;
}
```

A recurring membership has no `length`. Its period follows the processor's billing cycle (D-23).

## 4.10 Availability rules

```ts
interface AvailabilityRuleDef {
  key: Key; applies_to: { locations?: Key[]; resources?: Key[]; tags_any?: string[] };
  kind: 'open' | 'closed';
  weekly?: Partial<Record<Weekday, [LocalTime, LocalTime][]>>;
  dates?: { date: LocalDate; intervals?: [LocalTime, LocalTime][] }[];
  reason?: string;
}
```

- A room or desk is available when an `open` rule covers it and no `closed` rule does.
- If no `open` rule names a resource, the resource follows its studio's hours.
- A studio with no `open` rule is always open.
- Same-day closures (weather, power cut) use the closures API (§3.12.2), not config.

## 4.11 Constraints and coverage

```ts
interface ConstraintDef extends FlagRef {
  key: Key; description: string;
  level: 'hard' | 'soft'; weight?: number;          // weight: soft only, 1..1000
  applies_to: { roles?: Key[]; templates?: Key[]; template_tags?: string[]; people_where?: Expr };
  rule:
    | { type: 'max_hours'; window: 'day' | 'week' | 'rolling_7d'; hours: number; counts?: Counts }
    | { type: 'min_hours'; window: 'week'; hours: number }
    | { type: 'min_rest'; duration: Duration }      // from one claim's occ_end to the next claim's occ_start, buffers included
    | { type: 'max_consecutive_days'; days: number; counts?: Counts }
    | { type: 'max_assignments'; window: 'day' | 'week'; count: number; counts?: Counts }
    | { type: 'transfer_time' }
    | { type: 'fairness'; metric: 'hours' | 'assignments' | 'weekend_assignments' | 'closing_shifts' }
    | { type: 'preferences' } | { type: 'continuity' } | { type: 'stability' }
    | { type: 'assignment_expr'; must: Expr };
}
interface CoverageDef extends FlagRef {
  key: Key; location: Key; role: Key; shift_templates: Key[];
  pattern: { days: Weekday[]; from: LocalTime; to: LocalTime; min: number; target?: number }[];
  level: 'hard' | 'soft'; weight?: number; except_dates?: LocalDate[];
}
```

`type Counts = 'all_work' | 'matching'`, default `all_work`.
- `applies_to` chooses **which people** the rule applies to.
- `counts` chooses **which work** is counted. With `all_work`, every confirmed assignment of that person is counted, in every domain (classes, shifts) and from every source (platform, mirror). With `matching`, only assignments of templates matching `applies_to.templates` / `template_tags` are counted.

So `desk_week` in §4b.1 limits a desk worker's teaching plus desk hours to 40.

- **Hard** person rules are enforced by one shared validator (§8.5) on every assignment write, whatever its source: the solver, a manager, a swap, a substitute, or a mirror report.
- **Soft** rules (fairness, preferences, continuity, stability) are solver objectives only.

## 4.12 Workflows, custom fields, forms, views

```ts
interface WorkflowDef extends FlagRef {
  key: Key; name: string;
  trigger: { event: EventName; where?: Expr }
         | { at: { relative_to: 'session.start' | 'session.end' | 'booking.created';
                   offset: SignedDuration; templates_tagged?: string[]; templates?: Key[];
                   for_each?: 'session' | 'booking' } }
         | { every: { rrule: string; at_local: LocalTime; location: Key } };
  condition?: Expr; recheck_at_fire: boolean;
  actions: ActionDef[];                  // §9.4
  max_runs_per_subject?: number;
}
interface CustomFieldDef {
  key: Key; label: string; entity: 'customer' | 'booking' | 'session' | 'resource';
  type: 'text' | 'long_text' | 'int' | 'bool' | 'date' | 'enum' | 'multi_enum' | 'consent';
  options?: string[]; required_if?: Expr;
  visible_to: PlatformRole[]; editable_by: PlatformRole[];
  pii: boolean; retention?: Duration;
}
interface FormDef { key: Key; name: string; fields: Key[] }
interface ViewDef { key: Key; name: string; entity: 'session' | 'booking' | 'customer' | 'assignment' | 'resource';
  roles: PlatformRole[]; columns: string[]; filter?: Expr; sort?: { by: string; dir: 'asc' | 'desc' }[] }
```

A custom field key MUST NOT shadow a built-in field of its entity. Validation rejects this with `FIELD_SHADOWS_BUILTIN`.

## 4.13 Access (locked)

```ts
interface AccessDef {
  issuers: { key: Key; audience: 'member' | 'staff'; issuer: string; jwks_url: string;
             subject_claim: string; tenant_claim: string }[];
  role_mappings: { issuer: Key; claim: string; equals: string; grant: PlatformRole; location_claim?: string }[];
  staff_role_mappings: { issuer: Key; claim: string; equals: string; role: Key }[];   // directory group → config staff role
  default_member_role: 'member';
}
```

- `role_mappings` grant **platform permissions**.
- `staff_role_mappings` set a person's **config staff roles** (`Resource.roles`, for example `teacher` or `desk_staff`), which selectors and coverage use. They are re-applied on `person.created` and on every directory sync. A manager can add or remove a staff role with `PATCH /resources/{id}`. That override is audited, and it survives syncs until removed.

## 4.14 Simulation profiles

```ts
interface SimulationProfileDef {
  key: Key; source: 'synthetic' | 'historical'; horizon: Duration; seed: number;
  demand: { templates?: Key[]; templates_tagged?: string[];
            per_session: { mean: number; sd: number };
            lead_time: { distribution: 'exponential'; mean: Duration };
            cancel_rate: number; late_cancel_rate: number; no_show_rate: number;
            tier_mix?: Record<Key, number> }[];
}
```

## 4.15 Compiled config

Publishing compiles the document. The compiled form contains:

- CEL ASTs, type-checked and with estimated cost;
- mat spot resources expanded from layouts, with stable keys;
- resolved `@staff:` references (a missing person fails validation);
- normalised durations;
- a per-resource index of the templates that can claim each resource;
- the key formats for limit and cap counters;
- the tzdb version.

Compilation is deterministic: the same document always compiles to byte-identical output.
