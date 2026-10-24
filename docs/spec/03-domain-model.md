# 3. Domain model

The model has two layers:

- **Config entities** are declared in the config document (§4) and versioned as a whole. They are: studios, rooms, layouts, resource types, templates, timetable series, policies, entitlement products, constraints, coverage and workflows.
- **Runtime entities** are operational data in the tenant database (§12). They are: people, members, sessions, assignments, claims, places, holds, bookings, ledger, offers, proposals and tasks.

Runtime rows that depend on config record the `config_version` they were created under. Each tenant and environment has its own database (D-04), so tenant isolation does not depend on a tenant column.

## 3.1 Conventions

```ts
type ConfigKey = string;          // ^[a-z][a-z0-9_]{1,62}$
type Id<P extends string> = `${P}_${string}`;   // prefix + ULID
type UtcMs = number;              // integer ms since epoch, UTC
type IanaZone = string;           // validated against the bundled tzdb
type LocalDate = string;          // "2026-11-03" in the owning studio's zone
type LocalTime = string;          // "06:30"
type Money = { minor: number; currency: string };
type Source = 'platform' | 'mirror';
```

- Every instant is stored in UTC milliseconds. Every studio and every person has an IANA zone. Wall-clock values appear only in config and in recurrence rules (§7.10).
- Every mutable runtime row has `created_at`, `updated_at`, `version` (an integer used for optimistic concurrency), `created_by` (an `ActorRef`, §3.11) and `source`.
- Every row synced from an outside system has an `ExternalRef` (§3.11).

## 3.2 Relationships

```
Location(studio) 1─* Resource(space: room | front_desk) 1─* Resource(spot: mat)   (rooms with a layout)
Series *─1 Template ──generates──▶ Session *─1 Location
Session 1─* Assignment ─1 Resource(person | space) ─* ResourceClaim ─* Occupancy
Session 1─* Place 1─0..1 PlaceClaim(hold | booking)
Session 1─* Booking *─1 Customer *─* Entitlement 1─* LedgerEntry
Session 1─* WaitlistEntry                         Session 1─* Offer(substitute)   WaitlistEntry 1─* Offer(place)
Person 1─* AvailabilityRecord, TimeOff, SwapRequest, HoursRecord      Customer 0..1─0..1 Person (linked_resource_id)
```

## 3.3 Tenancy, config, modes, flags

```ts
interface Tenant {                      // control-plane DB
  id: Id<'ten'>; slug: string; name: string;
  environments: ('preview' | 'production')[];
  state: 'provisioning' | 'onboarding' | 'live' | 'offboarding' | 'closed' | 'deleted';
  legal_hold: boolean;                  // blocks hard deletion (§3.12.1)
  closed_at: UtcMs | null; delete_after: UtcMs | null;
}

interface ConfigVersion {
  id: Id<'cfv'>; number: number; content_hash: string;
  document: ConfigDocument; compiled: CompiledConfig;
  parent_number: number | null; published_at: UtcMs; published_by: ActorRef;
  effective_from: UtcMs; migration_plan_id: Id<'mig'> | null;
  summary: string; rollback_of: number | null;
  state: 'staged' | 'active' | 'superseded';
}

interface ConfigDraft {
  id: Id<'dft'>; base_number: number; document: ConfigDocument;
  patches: JsonPatchOp[][]; validation: ValidationReport | null; simulation: SimulationReport | null;
  state: 'editing' | 'validated' | 'awaiting_approval' | 'published' | 'abandoned';
  author: ActorRef;
}

interface DomainModeSetting {
  domain: 'classes' | 'bookings' | 'members' | 'shifts';
  mode: 'mirror' | 'shadow' | 'owner';
  outside_system: string | null;        // gateway system key
  outbound_push: boolean; retired: boolean;
  write_freeze: boolean;                // set during cutover and rollback (§18.7)
  changed_at: UtcMs; changed_by: ActorRef;
}

interface FeatureFlag {
  key: string; enabled: boolean;        // default false (I-30)
  allow_locations?: ConfigKey[]; allow_roles?: PlatformRole[];
  owner: string; remove_by: LocalDate;  // CI warns 30 days after remove_by (§15)
  updated_at: UtcMs; updated_by: ActorRef;
}
```

- **I-01** Exactly one config version is `active` at any instant: the one with the greatest `effective_from ≤ now`.
- **I-02** A published document never changes. A rollback republishes an old document as a new version.
- **I-03** Every runtime decision records its `config_version`.
- **I-04** There is at most one mode setting per domain. If `retired`, the mode is `owner`.

## 3.4 Studios and resources

```ts
interface Resource {
  id: Id<'res'>;
  kind: 'person' | 'space' | 'spot';
  type_key: ConfigKey; config_key: ConfigKey | null;     // structural resources (rooms, desks, mats)
  staff_key: string | null;                               // people: stable key from the staff sign-in service
  name: string; parent_id: Id<'res'> | null;              // mat → room
  location_keys: ConfigKey[]; home_location_key: ConfigKey | null;
  timezone: IanaZone;
  attributes: Record<string, AttrValue>; tags: string[];
  skills: { skill: ConfigKey; expires_at?: UtcMs }[];     // people
  roles: ConfigKey[];                                     // people: config staff roles (instructor, desk)
  concurrency: number;                                    // lanes, default 1
  layout_key: ConfigKey | null;
  state: 'active' | 'out_of_service' | 'leaving' | 'inactive';
  leaves_at: UtcMs | null;                                // people: last day (§3.12.4)
  payroll_ref: string | null;                             // people: identifier in PayrollCo export
  calendar_sync: boolean;                                 // people: opt-in (§18.3)
  source: Source;
}
```

- **I-05** Parent links form a forest with depth ≤ 2: room → mat.
- **I-06** Claiming a room does not claim its mats. Mats are places, not resource claims. A room that is `out_of_service` makes its classes `needs_resource` (§3.12.3).
- **I-07** Skills and roles must exist in the active config. An expired skill counts as absent.
- **I-08** `concurrency ≥ 1`. Lanes are numbered 0..concurrency−1.

## 3.5 People, availability, members

```ts
interface AvailabilityRecord {
  id: Id<'avl'>; resource_id: Id<'res'>;
  kind: 'available' | 'unavailable' | 'preferred' | 'avoid';
  location_key: ConfigKey | null;
  rule: { rrule: string; start_local: LocalTime; end_local: LocalTime; zone: IanaZone } | { start: UtcMs; end: UtcMs };
  valid_from: LocalDate; valid_until: LocalDate | null; source: Source;
}

interface TimeOff {
  id: Id<'tor'>; resource_id: Id<'res'>; start: UtcMs; end: UtcMs;
  reason: 'vacation' | 'sick' | 'personal' | 'leave_of_absence' | 'other';
  state: 'requested' | 'approved' | 'rejected' | 'cancelled';
  immediate: boolean;                   // sick calls take effect on submission
  affected_assignment_ids: Id<'asg'>[];
}

interface Customer {
  id: Id<'cus'>;
  member_subject: string | null;        // null = guest created at the desk (no account)
  state: 'active' | 'suspended' | 'closed' | 'erased';
  suspended_until: UtcMs | null; suspension_reason: string | null;
  merged_into: Id<'cus'> | null;        // set on the losing record of a merge
  linked_resource_id: Id<'res'> | null; // the same human as a staff member (§3.12.5)
  display_name: string; email?: string; phone?: string;  // PII (§13.3)
  timezone: IanaZone | null; home_location_key: ConfigKey | null;
  tier_key: ConfigKey | null;           // derived: highest-rank tier among ACTIVE entitlements (frozen/past-due-expired contribute none)
  strikes: number;                      // derived: count of CustomerStrike rows within the policy's strike_window
  waiver_signed_at: UtcMs | null;       // set via the waiver custom field (§4.12)
  custom: Record<string, AttrValue>; history: CustomerHistory;
  source: Source;
}
```

```ts
interface CustomerStrike { id: Id<'stk'>; customer_id: Id<'cus'>; booking_id: Id<'bkg'>; at: UtcMs;
  kind: 'late_cancel' | 'no_show'; removed_by: ActorRef | null; removed_at: UtcMs | null }
```

Strikes are rows, not a counter. `customer.strikes` (CEL, §5.3) counts the rows that are not removed and whose `at` is within the `strike_window` of the policy being evaluated (default 90 days). A manager can remove a strike with `DELETE /customers/{id}/strikes/{stk}`; the removal is audited.

**I-09** A person is available for an interval when all three hold:
- an `available` record covers the interval;
- no approved or immediate `TimeOff` overlaps it;
- no `unavailable` record overlaps it.

A person who is not `active` is never available, except a `leaving` person before `leaves_at`.

## 3.6 Sessions, assignments, exceptions

```ts
interface Session {
  id: Id<'ses'>; template_key: ConfigKey;
  series_key: ConfigKey | null; occurrence_key: string | null;   // "<series>@<LocalDate>T<LocalTime>"
  location_key: ConfigKey; start: UtcMs; end: UtcMs; zone: IanaZone;
  status: 'scheduled' | 'needs_staff' | 'needs_resource' | 'needs_mapping' | 'cancelled' | 'completed';
  capacity_total: number; booked_count: number; waitlist_count: number;
  exception: SessionException | null;  // differs from its series
  detached: boolean;                    // true once edited "this one"; series edits no longer touch it
  config_version: number; source: Source;
}
type SessionException =
  | { kind: 'substitute'; requirement_key: string; note?: string }
  | { kind: 'retimed'; from_start: UtcMs } | { kind: 'room_changed'; from_room: Id<'res'> }
  | { kind: 'capacity'; from: number } | { kind: 'cancelled'; reason: string };

interface Assignment {
  id: Id<'asg'>; session_id: Id<'ses'>; requirement_key: string;
  resource_id: Id<'res'> | null;        // null = open slot
  state: 'proposed' | 'confirmed' | 'released';
  claim_id: Id<'clm'> | null; assigned_by: ActorRef; source: Source;
}
```

- **I-10** Session start and end are aligned to 5-minute grains. Mirrored times that don't align are rounded outward for occupancy only, and a drift note is recorded.
- **I-11** `occurrence_key` is unique.
- **I-12** A session is `scheduled` only when every `fixed` requirement has a confirmed assignment and every `roster` requirement has one too. Otherwise it is `needs_staff` (or `needs_resource` for a room).
- **I-13** A template with `participants.who = none` (a desk shift) has no places and no bookings.
- **I-14** Cancelling a session releases all its claims and places in the same batch.

## 3.7 Resource claims and occupancy

```ts
interface ResourceClaim {
  id: Id<'clm'>; resource_id: Id<'res'>;
  owner: { type: 'assignment'; id: Id<'asg'> } | { type: 'block'; id: Id<'blk'> };
  start: UtcMs; end: UtcMs; occ_start: UtcMs; occ_end: UtcMs;   // occ widened by buffers, grain-aligned
  mode: 'exclusive' | 'lane';
  domain: 'classes' | 'shifts' | 'blocks'; source: Source;
  state: 'active' | 'conflicted' | 'released';
}
interface OccupancyRow { resource_id: Id<'res'>; grain: number; lane: number; claim_id: Id<'clm'> }
interface ResourceBlock { id: Id<'blk'>; resource_id: Id<'res'>; start: UtcMs; end: UtcMs;
  reason: string; created_by: ActorRef }      // out of service, maintenance, private use
```

- **I-15** For each resource and grain, at most `concurrency` active claims hold a lane. The database enforces this with the occupancy primary key (§12.3).
- **I-16** Every confirmed assignment has exactly one active claim. Every active claim owns exactly its expected number of occupancy rows.
- **I-17** Claims from **every** domain (classes, shifts, blocks) and **every** source (platform, mirror) go into the same occupancy table.
- **I-18** Mirror ingestion never drops an outside record. A mirrored claim that collides with an existing claim is stored `conflicted`, takes every free grain, and raises a `cross_domain_conflict` drift item. Its time is then fully blocked, either by its own rows or by the claim it collided with. When the colliding claim is released, its grains move to the conflicted claim (§12.3).

## 3.8 Places, holds, bookings, waitlist, offers

```ts
interface Place {
  id: Id<'plc'>; session_id: Id<'ses'>; place_no: number;
  spot_resource_id: Id<'res'> | null; label: string;        // "Mat 12" / "Place 7"
  partition_key: string; released_to: string | null; released_at: UtcMs | null;
  reserved_for: 'waitlist' | null;                          // set while promotion is pending (§7.7)
  attributes: Record<string, AttrValue>; disabled: boolean; // disabled = spot out of service
}
interface PlaceClaim { session_id: Id<'ses'>; place_id: Id<'plc'>; kind: 'hold' | 'booking';
  holder_id: string; customer_id: Id<'cus'>; expires_at: UtcMs | null }

interface Hold {
  id: Id<'hld'>; session_id: Id<'ses'>; place_id: Id<'plc'>; customer_id: Id<'cus'>;
  quote: Quote; expires_at: UtcMs; offer_id: Id<'ofr'> | null;
  state: 'active' | 'converted' | 'expired' | 'released'; idempotency_key: string;
}

interface Booking {
  id: Id<'bkg'>; session_id: Id<'ses'>; place_id: Id<'plc'> | null; customer_id: Id<'cus'>;
  session_start: UtcMs; group_id: string | null;
  state: BookingState;
  payment: { method: 'units'; entitlement_id: Id<'ent'>; units: number; unit: ConfigKey }
         | { method: 'price'; amount: Money; processor_ref: string } | { method: 'none' };
  terms: TermsSnapshot; intake: Record<string, AttrValue>;
  booked_via: 'web' | 'desk' | 'portal' | 'agent' | 'mirror' | 'waitlist';
  config_version: number; decision_id: Id<'dec'>; source: Source;
}
// `place_refilled` is NOT stored. It is computed when a penalty is assessed (§7.6) and exposed to CEL as booking.place_refilled.
type BookingState = 'pending_approval' | 'confirmed' | 'cancelled' | 'late_cancelled'
                  | 'checked_in' | 'attended' | 'no_show' | 'rejected';

interface TermsSnapshot { policy_key: ConfigKey; policy_hash: string; free_cancel_until: UtcMs;
  late_penalty: Penalty; no_show_penalty: Penalty; refund: RefundRules }

interface WaitlistEntry {
  id: Id<'wle'>; session_id: Id<'ses'>; customer_id: Id<'cus'>; position: number;
  preferred_place_ids: Id<'plc'>[];
  auto_charge_consent: boolean; payment_method_ref: string | null;   // processor saved-method ref via gateway
  state: 'waiting' | 'offered' | 'promoted' | 'expired' | 'left' | 'skipped';
  joined_at: UtcMs;
}

interface Offer {
  id: Id<'ofr'>;
  kind: 'place' | 'substitute';
  session_id: Id<'ses'>;
  waitlist_entry_id: Id<'wle'> | null;            // kind = place
  requirement_key: string | null;                 // kind = substitute
  recipient: { customer_id: Id<'cus'> } | { resource_id: Id<'res'> };
  state: 'sent' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  expires_at: UtcMs; reply_text: string | null;   // free text from SMS/email replies (substitute)
  hold_id: Id<'hld'> | null;                      // kind = place: hold created atomically by accept (§7.7)
  created_by: ActorRef; run_id: string | null;
}

interface CheckIn { id: Id<'chk'>; booking_id: Id<'bkg'>; session_id: Id<'ses'>; customer_id: Id<'cus'>;
  at: UtcMs; by: ActorRef; method: 'desk' | 'self' | 'kiosk'; client_key: string /* offline idempotency */ }
```

**Invariants**
- **I-19** A place has at most one place claim. An expired hold may be overwritten.
- **I-20** `booked_count` equals the number of booking place claims for the session.
- **I-21** A member has at most one active booking per session, unless the extra bookings share a `group_id` (guests).
- **I-22** A member cannot be both booked and waiting for the same session. A member may **join** the waitlist only when no free place they are eligible for exists.
- **I-23** Booking terms never change after creation, except through a lenient retroactive change (§6.8).

### 3.8.1 Booking state transitions

| From → To | Trigger | Allowed actors | Entitlement (ledger) | Money |
|---|---|---|---|---|
| (hold) → `confirmed` | confirm a hold | member, desk, member assistant (§10.1), waitlist promotion | `reserve −n` | price: capture after commit |
| (hold) → `pending_approval` | `approval.required_if` true | same | `reserve −n` | price: authorise only |
| `pending_approval` → `confirmed` | approver approves | manager/desk per policy | — | capture |
| `pending_approval` → `rejected` | approver rejects, or timeout with `on_timeout: reject` | approver, timer | `release +n` | void authorisation |
| `confirmed` → `cancelled` | cancel before `free_cancel_until`, or staff waive | member, desk, agent (if zero-cost) | `release +n` | refund per `terms.refund.timely` |
| `confirmed` → `late_cancelled` | cancel after `free_cancel_until` and before start | member (via confirmation if agent), desk | reserve held until assessment; then `forfeit` or `release` (§7.6) | fee per penalty |
| `confirmed` → `checked_in` | check-in within the window | desk, instructor, member (kiosk/self) | — | — |
| `no_show` → `checked_in` | an offline desk check-in replayed late, whose recorded `at` is inside the check-in window | desk app (offline queue) | penalty reversed (compensating rows, fee refund job); audited | refund fee |
| `checked_in` → `attended` | session end + 15 min (timer) | system | `consume` (reserve becomes final) | — |
| `confirmed` → `no_show` | start + `grace` with no check-in (timer) | system | penalty at `assess_at` | fee per penalty |
| `no_show` → `attended` | correction within 24 h | desk, manager | reverse penalty with compensating rows | refund fee |
| `confirmed`/`pending_approval` → `cancelled` (studio) | session cancelled (unstaffed, closure, minimum attendance, staff) | system, manager | `release +n` | refund per `terms.refund.studio_cancel` |
| `confirmed` → (moved) | `POST /bookings/{id}/move` = new booking + timely cancellation of the old one in one batch | member, desk | `release` then `reserve` | difference charged or refunded |

## 3.9 Entitlements and ledger

```ts
interface Entitlement {
  id: Id<'ent'>; customer_id: Id<'cus'>; product_key: ConfigKey; product_hash: string;
  state: 'active' | 'frozen' | 'past_due' | 'expired' | 'cancelled';
  starts_at: UtcMs; ends_at: UtcMs | null;
  freeze: { from: UtcMs; until: UtcMs } | null;
  past_due_since: UtcMs | null;
  balances: { unit: ConfigKey; balance: number | null; period_start: UtcMs | null }[];
  processor_subscription_ref: string | null; external_ref_id: Id<'ext'> | null; source: Source;
}
interface LedgerEntry { id: Id<'led'>; entitlement_id: Id<'ent'>; unit: ConfigKey; delta: number;
  kind: 'grant' | 'reserve' | 'consume' | 'release' | 'expire' | 'adjust' | 'refund' | 'forfeit' | 'transfer';
  booking_id: Id<'bkg'> | null; reason: string; actor: ActorRef; at: UtcMs; idempotency_key: string }
// Unlimited balances (balance = null) still get reserve/consume/release/forfeit rows, with delta = 0,
// so I-25 holds for every booking paid with units.
```

- **I-24** A limited balance is ≥ 0 (a CHECK constraint) and equals the sum of the ledger.
- **I-25** Each booking paid with units has exactly one `reserve`, which is resolved exactly once: by `release`, `consume` or `forfeit`.
- **I-26** The ledger is append-only.
- **I-26a** An entitlement covers a booking only if it is `active` at `session.start`. `frozen` within the freeze window does not cover. `past_due` covers until `past_due_since + product.dunning_grace` (§4.9).

## 3.10 Staff operations

```ts
interface Proposal {
  id: Id<'prp'>; kind: 'assignment_change' | 'roster_publish' | 'swap' | 'session_cancel' | 'refund' | 'credit_adjust'
      | 'domain_mode' | 'tenant_offboard';   // the last two implement the two-person rule: approver ≠ proposer, roles owner/admin
  proposed_by: ActorRef; ops: ProposalOp[];
  validation: { ok: boolean; reasons: ReasonCode[]; checked_at: UtcMs; config_version: number };
  state: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'expired';
  approver_roles: PlatformRole[]; decided_by: ActorRef | null; decided_at: UtcMs | null;
  expires_at: UtcMs;      // default: min(session.start − 30m, now + 2h) for assignment_change; now + 72h otherwise
  version: number;        // optimistic concurrency for concurrent manager edits (§11.2 If-Match)
}
interface SwapRequest { id: Id<'swp'>; from_assignment_id: Id<'asg'>; to_resource_id: Id<'res'> | null;
  counter_assignment_id: Id<'asg'> | null;
  state: 'open' | 'accepted' | 'approved' | 'rejected' | 'withdrawn'; proposal_id: Id<'prp'> | null }
interface Task { id: Id<'tsk'>; list: 'desk_checklist' | 'manager_inbox'; location_key: ConfigKey | null;
  title: string; due_at: UtcMs | null; state: 'open' | 'done' | 'cancelled'; source_ref: string | null }
interface HoursRecord { id: Id<'hrs'>; resource_id: Id<'res'>; assignment_id: Id<'asg'>;
  kind: 'shift' | 'teaching'; scheduled_start: UtcMs; scheduled_end: UtcMs;
  actual_start: UtcMs | null; actual_end: UtcMs | null; elapsed_minutes: number;
  state: 'scheduled' | 'worked' | 'approved' | 'exported' | 'voided'; export_batch_id: string | null }
```

- **I-27** Applying a proposal re-validates it against current data. It applies completely or not at all.
- **I-28** Elapsed minutes are computed from UTC instants.
- **I-28a** A proposal that is never approved expires at `expires_at`. Expiry emits `proposal.expired`. For a substitute proposal, the hook then moves on to the next candidate (§10.4). A manager is reminded once, when half the time to expiry has passed.

## 3.11 Sync, audit, decisions, actors

```ts
interface ExternalRef { id: Id<'ext'>; system: string; entity_type: string; entity_id: string;
  external_id: string; external_version: string | null; content_hash: string;
  last_seen_at: UtcMs; last_pushed_at: UtcMs | null }
interface PersonMapping { system: string; external_person_id: string; resource_id: Id<'res'> | null;
  match: 'email' | 'manual' | 'unmatched'; matched_at: UtcMs | null; matched_by: ActorRef | null }
// DriftItem, ShadowDisagreement, InboundEvent are owned by kairos-sync (§12.1, §18.6).
interface AuditEntry { id: Id<'aud'>; seq: number; at: UtcMs; actor: ActorRef; action: string;
  target: { type: string; id: string }; before_hash: string | null; after: unknown;
  request_id: string; config_version: number; prev_hash: string; hash: string }
interface DecisionTrace { id: Id<'dec'>; kind: string; request: unknown; outcome: 'allowed' | 'denied' | 'pending';
  steps: { check: string; result: 'pass' | 'fail' | 'skip'; reason?: ReasonCode; config_path?: string;
           facts?: Record<string, unknown> }[]; config_version: number; flags_hash: string; at: UtcMs }
type ActorRef =
  | { type: 'member'; customer_id: Id<'cus'> }
  | { type: 'staff'; resource_id: Id<'res'>; roles: PlatformRole[] }
  | { type: 'agent'; agent: 'config' | 'member_assistant' | 'staff_assistant' | 'substitute_finder';
      on_behalf_of: ActorRef | null; run_id: string }
  | { type: 'service'; name: string }
  | { type: 'system'; component: 'materializer' | 'workflow' | 'sync' | 'solver' | 'lifecycle' };
```

- **I-29** Every state change writes its audit entry and outbox rows in the same batch.
- **I-30** Feature flags default to off. A missing flag reads as off.

## 3.12 Lifecycles

This section is normative for how each entity begins, changes and ends. Endpoints are listed in §11. All lifecycle operations are audited (§13.4).

### 3.12.1 Tenant

| Stage | Steps | Data / money / outside effects |
|---|---|---|
| **Provision** | Control-plane record created (`provisioning`) → IaC creates the preview and production databases, per-object namespaces, per-tenant data key, and gateway and notification credentials scoped to the tenant | No member data yet |
| **Onboard** (`onboarding`) | (1) owner signs in; `access` is set by the owner (locked section). (2) The config agent starts from the **yoga starter config** (`fixtures/configs/yoga_starter.yaml`, §4b.2) and the owner's description. (3) All four domains are put in `mirror`. Backfill: classes and bookings from −26 weeks to +90 days, all active members and entitlements, desk shifts −8 to +8 weeks. Then incremental sync starts. (4) Person mapping is built (§18.5); every instructor seen in BookingVendor must be mapped. (5) Preview is seeded from a pseudonymised copy of production and refreshed weekly (§13.1). (6) **Go-live checklist:** zero open drift for 72 h; 100 % of people mapped; config validates with 0 errors; scenario suite green on preview; flags reviewed. Then `live` | Mirror writes are write-through only |
| **Change** | New studio: config ops add a location, rooms and layouts → publish (§6). Domain cutovers: §18.7. Commercial plan for Kairos itself: out of scope (A-14) | — |
| **Offboard** (`offboarding`) | (1) The owner requests it. Export starts: NDJSON per table plus every config version plus the audit archive, delivered as a signed URL valid for 7 days, with a manifest of row counts and a SHA-256 per file. (2) Choose a mode: **hand back** (domains rolled back to `mirror` per §18.7 where the outside systems still exist) or **close**. (3) On close: future sessions are cancelled with reason `tenant_closed`, refunds go out per `refund.studio_cancel`, members are notified via the workflow `tenant_closing` (14 days' notice, configurable), waitlists are cleared, and future shifts are vacated without a substitute search. (4) Tokens: token exchange refuses the tenant; service and agent client credentials are revoked; gateway routes and inbound webhooks are removed through the gateway's admin contract; per-object stores are drained. (5) `closed`; `delete_after = closed_at + 30 days` | Open entitlement balances are listed in the export for the tenant's own settlement. Kairos holds no funds |
| **Delete** | At `delete_after`, if `legal_hold = false`: the per-tenant data key is destroyed (crypto-shredding), the databases and object storage are deleted, and a signed deletion certificate (tenant, time, resources deleted, key ID) goes into the platform's audit archive → `deleted`. A legal hold blocks deletion until it is lifted by the platform owner | — |

### 3.12.2 Studio (location)

- **Open:** a config op adds the location with its IANA zone, opening hours, rooms and desk → publish.
- **Temporary closure** (holiday, power cut, weather): `POST /locations/{key}/closures {start, end, reason}`. One batch per affected session:
  - classes → cancelled (`closure`) with refunds per `refund.studio_cancel`;
  - shifts → vacated;
  - hours records → `voided`, unless the closure is created less than `tenant.closure_pay_notice` (default 2 h) before the start, in which case they stay `scheduled` (Q-02);
  - the `session.cancelled` workflow notifies members and staff.

  Planned holidays use config `availability` closed dates instead. Those go through the impact plan (§6.8).
- **Time-zone change** (rare; a data correction): a config op. The impact plan keeps local wall time for future sessions and recomputes UTC (the same mechanism as a tzdb rebase, §7.10). Conflicts are listed for resolution.
- **Permanent closure:** a config op removes the location. The impact plan forces a resolution for every future session (cancel with refund, or move to another studio with member opt-in). Members whose `home_location_key` was this studio are set to null. People lose the location from `location_keys`.

### 3.12.3 Room and mat spot

- **Add:** a config op.
- **Layout change while bookings exist:** the impact plan (§6.8) re-seats each affected booking on a spot with equal attributes, otherwise the best free spot, otherwise cancels with a refund. Members are notified.
- **Out of service for a time:** `POST /resources/{id}/blocks {start, end, reason}`. It returns the impact before committing (`preview=true`).
  - A *mat spot*: places in the window are `disabled`; their bookings are re-seated (equal attributes, then best free); if no place is free, the booking is cancelled with a refund per `studio_cancel`.
  - A *room*: overlapping classes become `needs_resource`. The engine proposes another free room of the same type with capacity ≥ booked count (a proposal for a manager). If nothing is approved by `unstaffed.check_at`, the class is cancelled under the same rule.
- **Retire:** a config op with an impact plan.

### 3.12.4 Staff member

| Stage | Behaviour |
|---|---|
| **Onboard** | The staff directory emits `person.created` (event delivered through the gateway; a nightly sync is the backstop). Kairos creates the person resource with `staff_key`, platform roles from `access.role_mappings` and config staff roles (`teacher`, `desk_staff`) from `access.staff_role_mappings` (§4.13), both re-applied on every sync, and `home_location_key` from the directory's location attribute. A manager completes skills and certifications with expiry dates (`PATCH /resources/{id}`), `payroll_ref`, and the calendar-sync opt-in. The person sets availability in the portal. They are eligible for rosters once they have ≥ 1 role and an availability record. The first assignment sends a welcome notification. The person is linked to BookingVendor's instructor ID through person mapping |
| **Change** | *Role or skill change:* the effect is immediate on eligibility. Existing assignments that no longer pass the validator are flagged, the session goes to `needs_staff`, and the substitute flow runs. *Certification expiry:* a nightly job emits `skill.expiring` 30 days before and handles it as a skill removal at expiry. *Leave of absence:* a `TimeOff` with `reason: leave_of_absence`, same effect as a sick call over the range, but with manager approval first. *Availability change:* future assignments that fall outside the new availability are flagged to the manager (not auto-vacated). *Move studio:* `location_keys` changes; future assignments at the old studio are flagged. *Staff who are also members:* §3.12.5 |
| **Offboard (planned)** | The directory or a manager sets `leaves_at` → state `leaving`. After `leaves_at`: assignments are vacated (substitute flow for classes, desk coverage re-solve proposal for shifts); open swaps are withdrawn; requested time off is cancelled; substitute offers to them are withdrawn; pending proposals assigning them are rejected; calendar entries after `leaves_at` are deleted. If classes are mirrored, use the per-mode write table in §18.5.1 |
| **Offboard (immediate)** | The directory emits `person.deactivated`, or a manager calls `POST /resources/{id}/deactivate {effective: now}`. In one batch: state `inactive`; every assignment starting after now is vacated (substitute flow; a session starting within 2 h also creates a manager task); swaps are withdrawn; time off is cancelled; open substitute **offers to** the person are withdrawn; pending proposals that would assign them are rejected with reason `person_inactive`. Token exchange refuses new tokens for the person at once. Existing staff JWTs are refused because the platform checks `state` on every request (cached ≤ 60 s). Agent tokens acting for them die within ≤ 15 min of TTL and are also checked against `state`. Calendar sync entries are deleted. Hours up to `effective` stay and go into the next export. Unexported records are flagged `final` |
| **History and rehire** | The resource row, assignments, hours and audit are kept (needed for payroll and audit). Personal fields (phone, personal email) are erased 90 days after offboarding unless a legal hold applies. Rehire reactivates the same resource through the same `staff_key`; skills must be re-verified |

### 3.12.5 Member (customer)

| Stage | Behaviour |
|---|---|
| **Account** | A member token with an unknown `sub` creates a `Customer`. It is linked to a mirrored member by verified email, and a match on several records creates a manager task. **Guest/walk-in** without an account: the desk creates a `Customer` with `member_subject = null`. When the person later signs up, their account links by email, and a merge happens if needed |
| **First booking** | The policy may require intake fields and a signed **waiver** (`consent` custom field `liability_waiver`, `required_if: true`). Missing ones → `INTAKE_REQUIRED`. The member signs on the website before confirming; at the desk, the desk captures it |
| **Minors** | Out of scope for v2.0 (D-31). A member with an age below 18 recorded at signup is blocked with `NOT_ELIGIBLE` and the message "Under-18s must book at the desk". The desk may book them as a guest, and a guardian waiver is captured as a custom field |
| **Duplicates** | `POST /customers/{id}/merge {into}` (manager). In one saga: bookings, waitlist entries, entitlements and history move to the target. Conflicting bookings for the same session keep the earlier one and cancel the other as timely. The losing record gets `merged_into` and `state = closed` |
| **Membership start / upgrade** | A purchase creates the entitlement (members owner) or arrives by mirror. An upgrade takes effect at once: the new tier applies to new bookings. Existing bookings keep their terms and places, including tier-reserved places |
| **Downgrade** | Takes effect at the next billing period. Existing bookings in tier-reserved partitions are kept |
| **Freeze / unfreeze** | `POST /entitlements/{id}/freeze {from, until}` within `product.freeze` limits. Bookings in the freeze window are handled per `product.freeze.on_existing`: `keep` (they stay paid by this entitlement) or `cancel_timely`. Unfreezing early ends the freeze; balances are unchanged |
| **Payment failure** | A processor dunning event (through the gateway) → `past_due`. New bookings are still covered until `dunning_grace` runs out, then `NO_ENTITLEMENT`. Existing bookings are kept. Recovery → `active` |
| **Credit expiry** | At `ends_at`: an `expire` ledger row for the remaining balance. Bookings already reserved keep their reserve. A booking for a session after `ends_at` was never allowed (I-26a) |
| **Home-studio change** | `PATCH /customers/me {home_location_key}`. Display and default filters only |
| **Suspension / ban** | `POST /customers/{id}/suspend {until?, reason, cancel_future: bool}` (manager). New bookings get `ACCOUNT_SUSPENDED`. If `cancel_future`, future bookings are cancelled timely with refunds |
| **Staff who are also members** | `linked_resource_id` links the two identities. Linking takes both tokens: the person starts with a staff token (`POST /resources/me/link-member {customer_id}`), then confirms with that member's token (`POST /customers/me/link-staff {link_id}`); verified emails must match. A linked member's booking is refused with `CUSTOMER_OVERLAP` if it overlaps one of their own confirmed assignments (D-32). Permissions are never merged: a member token grants member rights only |
| **Close account** | `POST /customers/me/close`. Future bookings are cancelled as **timely** whatever the time, with refunds per `refund.timely`. Waitlist entries are removed. Memberships are cancelled at the processor via gateway at period end (members owner) or flagged to BookingVendor (mirror). → `closed` |
| **Data export** | `POST /customers/{id}/export` → JSON of profile, bookings, ledger and consents, delivered within 30 days as a signed link through the notification service |
| **Deletion (erasure)** | `POST /customers/{id}/erase`. The record must be `closed` first (closing is automatic). PII and custom-field values are erased and the row is pseudonymised. Bookings, ledger and payment references stay under the pseudonym for financial records (7 years) → `erased` |

### 3.12.6 Runtime agents and agent clients

- **Provisioning:** an owner registers an agent client (`POST /agents/clients {agent, allowlist}`). A credential is issued to the client's own secret store through the gateway's secret contract.
- **Rate limits:** §10.1.
- **Kill switch:** the flag `agent.<name>.enabled`.
- **Revocation:** `DELETE /agents/clients/{id}` revokes the credential at once. Outstanding tokens die within ≤ 15 min, and the client state is checked on every request.
- **Model or prompt changes:** gated by evals (§14.4–14.5).
- **Unapproved proposals:** I-28a.
