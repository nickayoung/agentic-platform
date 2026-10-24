# 3. Domain model

The model has two layers:

- **Config entities** are declared in the config document (§4). They are versioned as a whole. Examples: locations, resource types, structural resources, templates, timetable series, policies, entitlement products, constraints, workflows.
- **Runtime entities** are operational data in the tenant database (§12). Examples: people, customers, sessions, assignments, claims, places, holds, bookings, ledger entries, proposals.

Runtime rows that depend on config record the `config_version` that was in force when they were created. Every runtime entity also carries `tenant_id` implicitly, because the database is per tenant (D-04).

## 3.1 Conventions

```ts
type ConfigKey = string;          // ^[a-z][a-z0-9_]{1,62}$, unique within its collection
type Id<P extends string> = `${P}_${string}`;  // prefix + ULID, e.g. "ses_01J9Z3K…"
type UtcMs = number;              // integer milliseconds since Unix epoch, UTC
type IanaZone = string;           // e.g. "Europe/London"; validated against the bundled tzdb
type LocalDate = string;          // "2026-11-01" in the owning location's zone
type LocalTime = string;          // "06:30" 24-hour wall time
type Money = { minor: number; currency: string };   // integer minor units, ISO 4217
type Source = 'platform' | 'mirror';                // who is the record for this row (§18.5)
```

- All instants are stored as `UtcMs`. Every location, service site and person has an IANA zone. Wall-clock values (`LocalDate`, `LocalTime`) appear only in config and in recurrence rules. Engines turn them into instants with the zone of the owning location (§7.10).
- Every mutable runtime row has `created_at`, `updated_at`, `version` (an optimistic-concurrency integer), `created_by` (an actor reference, §13.4) and `source`.
- Rows synced from outside systems link to an `ExternalRef` (§3.9).

## 3.2 Entity relationship overview

```
Location 1─* Resource(space) 1─* Resource(spot)          Template *─1 PolicySet
   │                │                                      │ 1─* Requirement
   │                └── Layout                             │
   │                                                       ▼
Series *─1 Template ──generates──▶ Session *─1 Location/ServiceSite
                                     │ 1─* Assignment ─1 Resource ─* Claim ─* Occupancy
                                     │ 1─* Place 1─0..1 PlaceClaim (hold | booking)
                                     │ 1─* Booking *─1 Customer *─* Entitlement 1─* LedgerEntry
                                     │ 1─* WaitlistEntry
Person(Resource) 1─* AvailabilityRecord, TimeOff, SwapRequest
Proposal ─targets─▶ Session/Assignment/Booking      ConfigVersion 1─* (every decision references one)
```

## 3.3 Tenancy, environment, configuration

```ts
interface Tenant {            // stored in the control-plane DB, not the tenant DB
  id: Id<'ten'>;
  slug: string;               // URL-safe, unique
  name: string;
  environments: ('preview' | 'production')[];
  status: 'active' | 'suspended';
}

interface ConfigVersion {
  id: Id<'cfv'>;
  number: number;             // 1, 2, 3 … monotonic per tenant+env
  content_hash: string;       // sha256 of canonical JSON (RFC 8785 JCS)
  document: ConfigDocument;   // §4
  compiled: CompiledConfig;   // CEL ASTs, expanded layouts, resolved refs (§4.13)
  parent_number: number | null;
  published_at: UtcMs;
  published_by: ActorRef;
  effective_from: UtcMs;      // usually = published_at; may be scheduled in the future
  migration_plan_id: Id<'mig'> | null;
  summary: string;            // plain-language diff summary shown at approval
  rollback_of: number | null; // set when this version restores an older one
}

interface ConfigDraft {
  id: Id<'dft'>;
  base_number: number;        // version the draft branched from
  document: ConfigDocument;
  patches: JsonPatchOp[][];   // history of applied patch batches
  validation: ValidationReport | null;
  simulation: SimulationReport | null;
  state: 'editing' | 'validated' | 'awaiting_approval' | 'published' | 'abandoned';
  author: ActorRef;           // human or config agent (on behalf of a human)
}

interface DomainModeSetting {
  domain: 'classes' | 'bookings' | 'members' | 'shifts';
  mode: 'mirror' | 'shadow' | 'owner';
  outside_system: string | null;   // gateway system key, e.g. "booking_vendor"
  outbound_push: boolean;          // owner mode: push changes to the outside system
  retired: boolean;                // outside system retired; rollback no longer possible
  changed_at: UtcMs; changed_by: ActorRef;
}

interface FeatureFlag {
  key: string;                     // e.g. "workflow.waitlist_auto_promote"
  enabled: boolean;                // default false (I-30)
  allow_locations?: ConfigKey[];   // optional narrowing
  allow_roles?: PlatformRole[];
  updated_at: UtcMs; updated_by: ActorRef;
}
```

**Invariants**

- **I-01** Exactly one `ConfigVersion` is *active* at any instant: the one with the largest `effective_from ≤ now`.
- **I-02** `ConfigVersion.document` is immutable once published. A rollback publishes a new version whose document equals an old one, with `rollback_of` set.
- **I-03** Each runtime decision (booking, cancellation, assignment, workflow run) records the `config_version` it was evaluated under.
- **I-04** At most one `DomainModeSetting` per domain. Once `retired = true`, `mode` MUST be `owner`.

## 3.4 Locations, service sites, resources

```ts
interface Location {               // config entity (§4.3), materialised into a table for joins
  key: ConfigKey; name: string; timezone: IanaZone;
  address?: Address; geo?: { lat: number; lng: number };
}

interface ServiceSite {            // runtime: customer addresses for field service
  id: Id<'sit'>; customer_id: Id<'cus'>;
  address: Address; geo: { lat: number; lng: number };
  timezone: IanaZone; territory_key: ConfigKey | null;
  access_notes?: string;
}

interface Resource {
  id: Id<'res'>;
  kind: 'person' | 'space' | 'spot' | 'equipment' | 'vehicle';
  type_key: ConfigKey;             // ResourceTypeDef in config
  config_key: ConfigKey | null;    // structural resources: their key in config; people: null
  staff_key: string | null;        // people: stable key from the staff sign-in service ("@staff:<key>")
  name: string;
  parent_id: Id<'res'> | null;     // spot → space, equipment → space/vehicle
  location_keys: ConfigKey[];      // home location(s); people may have several
  timezone: IanaZone;              // people: home zone; others: location zone
  attributes: Record<string, AttrValue>;   // validated against ResourceTypeDef.attributes
  tags: string[];
  skills: { skill: ConfigKey; level?: number; expires_at?: UtcMs }[];  // people only
  roles: ConfigKey[];              // people only: staff roles (desk, instructor, server)
  concurrency: number;             // lanes; default 1
  layout_key: ConfigKey | null;    // spaces with spots
  active: boolean;
  source: Source;
}
```

**Invariants**

- **I-05** `parent_id` forms a forest. Depth ≤ 3. A spot's parent is a space.
- **I-06** Claiming a resource does not automatically claim its parent or children. Templates claim exactly what their requirements select. A space booked whole (exclusive) also blocks its spots: the engine writes claims for the space, and the availability of a spot is the intersection of its own and its parent's (§7.2).
- **I-07** `skills[].skill` and `roles[]` MUST exist in the active config's catalogs. A skill past `expires_at` is treated as absent.
- **I-08** `concurrency ≥ 1`. Lanes are numbered `0 … concurrency-1`.

## 3.5 Availability, time off, customers

```ts
interface AvailabilityRecord {     // runtime: person-entered working hours and preferences
  id: Id<'avl'>; resource_id: Id<'res'>;
  kind: 'available' | 'unavailable' | 'preferred' | 'avoid';
  location_key: ConfigKey | null;  // null = any of the person's locations
  rule: { rrule: string; start_local: LocalTime; end_local: LocalTime; zone: IanaZone } // weekly etc.
      | { start: UtcMs; end: UtcMs };                                                    // one-off
  valid_from: LocalDate; valid_until: LocalDate | null;
  source: Source;
}

interface TimeOff {
  id: Id<'tor'>; resource_id: Id<'res'>;
  start: UtcMs; end: UtcMs;
  reason: 'vacation' | 'sick' | 'personal' | 'other';
  state: 'requested' | 'approved' | 'rejected' | 'cancelled';
  immediate: boolean;              // sick calls: effective on submission, approval after the fact
  affected_assignment_ids: Id<'asg'>[];   // computed when it takes effect
}

interface Customer {
  id: Id<'cus'>;
  member_subject: string | null;   // subject claim from the member sign-in service
  display_name: string; email?: string; phone?: string;   // PII (§13.3)
  timezone: IanaZone | null;
  tier_key: ConfigKey | null;      // derived: highest-rank tier among active entitlements
  strikes: number;                 // no-show / late-cancel strikes within policy window
  custom: Record<string, AttrValue>;   // custom fields (§4.12)
  history: CustomerHistory;        // maintained aggregates, see §5.3
  source: Source;
}
```

**I-09** At any instant, a resource is *available* for a session if all three hold: an `available` record (or, for structural resources, the config availability rules) covers the interval; no approved or immediate `TimeOff` overlaps it; and no `unavailable` record overlaps it. Occupancy (§3.7) is checked separately.

## 3.6 Sessions, assignments, timetable

```ts
interface Session {
  id: Id<'ses'>;
  template_key: ConfigKey;
  series_key: ConfigKey | null;    // set when generated from the timetable
  occurrence_key: string | null;   // "<series_key>@<LocalDate>T<LocalTime>"; unique when set
  location_key: ConfigKey | null;  // exactly one of location_key / site_id is set
  site_id: Id<'sit'> | null;
  start: UtcMs; end: UtcMs;        // elapsed duration = end - start
  zone: IanaZone;                  // copied from location/site at creation
  status: 'draft' | 'scheduled' | 'needs_staff' | 'cancelled' | 'completed';
  capacity_total: number;          // places materialised (0 for participants.who = none)
  booked_count: number;            // maintained in the same batch as place claims
  waitlist_count: number;
  exception: { kind: 'substitute' | 'moved' | 'retimed' | 'cancelled' | 'capacity'; note?: string } | null;
  arrival_window: { start: UtcMs; end: UtcMs } | null;   // field service
  config_version: number;          // version under which it was materialised
  source: Source;
}

interface Assignment {
  id: Id<'asg'>;
  session_id: Id<'ses'>;
  requirement_key: string;         // matches Template.requirements[].key
  resource_id: Id<'res'> | null;   // null = open slot (e.g. instructor not yet rostered)
  state: 'proposed' | 'confirmed' | 'released';
  claim_id: Id<'clm'> | null;      // set when state = confirmed and occupancy != none
  assigned_by: ActorRef;
  source: Source;
}
```

**Invariants**

- **I-10** `start < end`. Both are multiples of the grain (5 minutes) in UTC. Sessions synced from outside systems that are not aligned are rounded outward for occupancy, and a drift note is recorded.
- **I-11** `occurrence_key` is unique. Running materialisation twice never creates duplicate sessions.
- **I-12** A session is `scheduled` only when every requirement with `assign ∈ {fixed, auto, customer_choice}` has `count` confirmed assignments. Requirements with `assign = roster` may be open, in which case `status = needs_staff`. `deferred` requirements are allowed to be open until dispatch.
- **I-13** A session whose template has `participants.who = 'none'` has zero places and no bookings. A shift is such a session.
- **I-14** Cancelling a session releases all of its claims and places in the same batch.

## 3.7 Claims and occupancy (the shared calendar)

```ts
interface Claim {
  id: Id<'clm'>;
  resource_id: Id<'res'>;
  owner: { type: 'assignment'; id: Id<'asg'> }
       | { type: 'hold'; id: Id<'hld'> }        // on-demand checkout holds resource time
       | { type: 'block'; reason: string };    // maintenance, private use
  start: UtcMs; end: UtcMs;                     // the session's own time
  occ_start: UtcMs; occ_end: UtcMs;             // widened by buffers and travel; grain-aligned
  lane: number | null;                          // chosen lane for concurrency > 1; null = lane per grain
  domain: 'classes' | 'bookings' | 'shifts' | 'appointments' | 'jobs' | 'spaces';
  source: Source;
  state: 'active' | 'conflicted' | 'released';
  expires_at: UtcMs | null;                     // holds only
}

// Physical enforcement table. One row per (resource, grain, lane). Primary key is unique.
interface OccupancyRow { resource_id: Id<'res'>; grain: number; lane: number; claim_id: Id<'clm'> }
```

**Invariants (the core of the shared resource model)**

- **I-15** For every resource and grain, at most `concurrency` active claims overlap. The database enforces this through `PRIMARY KEY (resource_id, grain, lane)` on `occupancy` (§12.3).
- **I-16** Every confirmed assignment with `occupancy ≠ none` has exactly one active claim covering `[occ_start, occ_end)`. Every active claim has exactly `(occ_end - occ_start)/5min` occupancy rows (one lane per grain).
- **I-17** Claims from **every** domain and **every** source (platform or mirror) go into the same `occupancy` table. A desk shift (owned), a mirrored class assignment and a PT appointment for the same person cannot overlap.
- **I-18** Mirror ingestion never drops an outside record. If a mirrored claim collides with an existing claim, it is stored with `state = 'conflicted'`. It takes occupancy rows for every grain that is still free (`INSERT … ON CONFLICT DO NOTHING`), and a `cross_domain_conflict` drift item is raised (§18.6). Every grain of the mirrored claim is then blocked: some by its own rows, the rest by the claim it collided with. So no *new* platform claim can overlap it. When the colliding claim is released, the same batch moves the conflicted claim's missing grains onto it and, if it is now complete, sets it to `active` (§12.3).

## 3.8 Places, holds, bookings, waitlist, attendance

```ts
interface Place {
  id: Id<'plc'>;
  session_id: Id<'ses'>;
  place_no: number;                 // 1..capacity_total, unique per session
  spot_resource_id: Id<'res'> | null;   // assigned mode: the spot; pooled: null
  label: string;                    // "Bike 12" / "Place 7"
  partition_key: string;            // "general" or a configured partition
  attributes: Record<string, AttrValue>;   // copied from the spot (front_row, type)
  released_to: string | null;       // partition this place was released to, if any
}

interface PlaceClaim {              // PRIMARY KEY (session_id, place_id) — one claimant per place
  session_id: Id<'ses'>; place_id: Id<'plc'>;
  kind: 'hold' | 'booking';
  holder_id: Id<'hld'> | Id<'bkg'>;
  customer_id: Id<'cus'>;
  expires_at: UtcMs | null;         // holds only
}

interface Hold {
  id: Id<'hld'>;
  session_id: Id<'ses'> | null;     // null for on-demand holds until the session row is created
  on_demand: { template_key: ConfigKey; start: UtcMs; end: UtcMs; resource_ids: Id<'res'>[] } | null;
  place_id: Id<'plc'> | null;
  customer_id: Id<'cus'>;
  quote: Quote;                     // price/units the engine computed (§7.4)
  expires_at: UtcMs;
  state: 'active' | 'converted' | 'expired' | 'released';
  idempotency_key: string;
}

interface Booking {
  id: Id<'bkg'>;
  session_id: Id<'ses'>; place_id: Id<'plc'> | null;  // null only for overflow while approval pending
  customer_id: Id<'cus'>;
  group_id: string | null;           // guests booked together
  state: 'pending_approval' | 'confirmed' | 'cancelled' | 'late_cancelled'
       | 'checked_in' | 'attended' | 'no_show';
  payment: { method: 'units'; entitlement_id: Id<'ent'>; units: number; unit: ConfigKey }
         | { method: 'price'; amount: Money; processor_ref: string }   // processor payment id via gateway
         | { method: 'none' };
  terms: TermsSnapshot;              // cancellation/no-show terms bound at booking (§6.8)
  intake: Record<string, AttrValue>; // custom fields captured at booking
  booked_via: 'web' | 'desk' | 'portal' | 'agent' | 'mirror' | 'waitlist';
  config_version: number;
  decision_id: Id<'dec'>;            // decision trace for the booking
  place_refilled: boolean;           // set when the released place is re-booked (late cancels)
  source: Source;
}

interface TermsSnapshot {
  policy_key: ConfigKey; policy_hash: string;
  free_cancel_until: UtcMs; late_penalty: Penalty; no_show_penalty: Penalty;   // Penalty: §4.8
}

interface WaitlistEntry {
  id: Id<'wle'>; session_id: Id<'ses'>; customer_id: Id<'cus'>;
  position: number;                  // dense order by join time; ties impossible (serialized)
  preferred_place_ids: Id<'plc'>[];  // assigned mode: ordered spot preferences
  state: 'waiting' | 'offered' | 'promoted' | 'expired' | 'left' | 'skipped';
  offer_expires_at: UtcMs | null;
  joined_at: UtcMs;
}

interface CheckIn { id: Id<'chk'>; booking_id: Id<'bkg'> | null; session_id: Id<'ses'>;
  customer_id: Id<'cus'>; at: UtcMs; by: ActorRef; method: 'desk' | 'self' | 'kiosk' }
```

**Invariants**

- **I-19** For each place there is at most one `PlaceClaim` (primary key). An active hold has `expires_at > now`. An expired hold may be overwritten in place (§12.4).
- **I-20** `Session.booked_count` = number of `PlaceClaim` rows with `kind = 'booking'` for the session. It is maintained in the same batch.
- **I-21** A customer has at most one non-cancelled booking per session (partial unique index), unless `participants.allow_guests` is set and the extra bookings share a `group_id`.
- **I-22** A waitlist entry exists only while the session has no free eligible place for that customer at the time of joining. A customer cannot be both booked and waiting for the same session.
- **I-23** A booking's `terms` never change after creation, except through a lenient retroactive policy change (§6.8).

## 3.9 Entitlements and ledger

```ts
interface Entitlement {
  id: Id<'ent'>; customer_id: Id<'cus'>; product_key: ConfigKey;
  state: 'active' | 'frozen' | 'expired' | 'cancelled';
  starts_at: UtcMs; ends_at: UtcMs | null;
  balances: { unit: ConfigKey; balance: number | null; period_start: UtcMs | null }[];  // null = unlimited
  external_ref_id: Id<'ext'> | null;  // while members domain is mirrored
  source: Source;
}

interface LedgerEntry {               // append-only
  id: Id<'led'>; entitlement_id: Id<'ent'>; unit: ConfigKey;
  delta: number;                      // negative = debit
  kind: 'grant' | 'reserve' | 'consume' | 'release' | 'expire' | 'adjust' | 'refund' | 'forfeit';
  booking_id: Id<'bkg'> | null;
  reason: string; actor: ActorRef; at: UtcMs;
  idempotency_key: string;            // unique
}
```

**Invariants**

- **I-24** `balance ≥ 0` for limited units (a CHECK constraint). The balance equals the sum of ledger deltas since `period_start`.
- **I-25** Each booking paid with units has exactly one `reserve` entry. The entry is resolved by exactly one `release` (timely cancel), `consume` (attended), or `forfeit` (late cancel / no-show where `forfeit_units` is true).
- **I-26** Ledger rows are never updated or deleted. Corrections are new `adjust` rows.

## 3.10 Staff operations: proposals, swaps, hours

```ts
interface Proposal {
  id: Id<'prp'>;
  kind: 'assignment_change' | 'roster_publish' | 'swap' | 'session_cancel' | 'refund' | 'config_change';
  proposed_by: ActorRef;              // person, solver run, or agent (with on_behalf_of)
  ops: ProposalOp[];                  // typed operations, e.g. {op:'reassign', assignment_id, to_resource_id}
  validation: { ok: boolean; reasons: ReasonCode[]; checked_at: UtcMs; config_version: number };
  state: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'expired';
  approver_roles: PlatformRole[];
  decided_by: ActorRef | null; decided_at: UtcMs | null;
  expires_at: UtcMs;
}

interface SwapRequest {
  id: Id<'swp'>; from_assignment_id: Id<'asg'>;
  to_resource_id: Id<'res'> | null;   // null = open offer to anyone qualified
  counter_assignment_id: Id<'asg'> | null;   // two-way swap
  state: 'open' | 'accepted' | 'approved' | 'rejected' | 'withdrawn';
  proposal_id: Id<'prp'> | null;
}

interface HoursRecord {               // basis for the payroll export (§18.8)
  id: Id<'hrs'>; resource_id: Id<'res'>; assignment_id: Id<'asg'>;
  kind: 'shift' | 'teaching';
  scheduled_start: UtcMs; scheduled_end: UtcMs;
  actual_start: UtcMs | null; actual_end: UtcMs | null;   // time clock (later phase)
  elapsed_minutes: number;            // elapsed, DST-correct
  state: 'scheduled' | 'worked' | 'approved' | 'exported';
  export_batch_id: string | null;
}
```

**Invariants**

- **I-27** Applying a proposal re-runs full validation against the *current* data and config. A proposal that validated when created but fails at apply goes to `failed` with reasons. It is never partially applied.
- **I-28** `HoursRecord.elapsed_minutes = (end - start)/60000`, computed from UTC instants and never from wall-clock values.

## 3.11 Sync, audit and decisions

```ts
interface ExternalRef {
  id: Id<'ext'>; system: string; entity_type: string; entity_id: string;
  external_id: string; external_version: string | null;
  content_hash: string;               // hash of mapped canonical fields (§18.6)
  last_seen_at: UtcMs; last_pushed_at: UtcMs | null;
}

interface DriftItem {
  id: Id<'drf'>; domain: Domain; entity_type: string; entity_id: string | null; external_id: string | null;
  kind: 'missing_local' | 'missing_remote' | 'field_mismatch' | 'cross_domain_conflict' | 'push_failed';
  fields: { path: string; local: unknown; remote: unknown }[];
  detected_by: 'event' | 'window_scan' | 'bucket_checksum' | 'push';
  state: 'open' | 'auto_resolved' | 'resolved' | 'ignored';
  resolution: 'took_remote' | 'took_local' | 'manual' | null;
}

interface ShadowDisagreement {
  id: Id<'sdg'>; domain: Domain; external_id: string;
  outside_decision: unknown; platform_decision: unknown;   // normalised decision shapes
  reason_codes: ReasonCode[]; config_version: number; at: UtcMs;
  triage: 'unreviewed' | 'expected' | 'config_fix' | 'platform_bug' | 'outside_bug';
}

interface AuditEntry {                // append-only, hash-chained (§13.4)
  id: Id<'aud'>; seq: number; at: UtcMs;
  actor: ActorRef; action: string; target: { type: string; id: string };
  before_hash: string | null; after: unknown; request_id: string;
  config_version: number; prev_hash: string; hash: string;
}

interface DecisionTrace {
  id: Id<'dec'>; kind: 'booking' | 'hold' | 'cancel' | 'availability' | 'assignment' | 'proposal';
  request: unknown; outcome: 'allowed' | 'denied' | 'pending';
  steps: { check: string; result: 'pass' | 'fail' | 'skip'; reason?: ReasonCode;
           config_path?: string; facts?: Record<string, unknown> }[];
  config_version: number; flags_hash: string; at: UtcMs;
}

type ActorRef =
  | { type: 'member'; customer_id: Id<'cus'> }
  | { type: 'staff'; resource_id: Id<'res'>; roles: PlatformRole[] }
  | { type: 'agent'; agent: 'config' | 'member_assistant' | 'staff_assistant' | 'substitute_finder';
      on_behalf_of: ActorRef | null; run_id: string }
  | { type: 'service'; name: string }
  | { type: 'system'; component: 'materializer' | 'workflow' | 'sync' | 'solver' };
```

**I-29** Every write that changes runtime state writes an `AuditEntry` and any `Outbox` rows in the same database batch (§12.6).
**I-30** Feature flags default to `enabled = false`. A missing flag reads as false.
