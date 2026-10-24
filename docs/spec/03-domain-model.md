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
  legal_hold: boolean;                  // blocks hard deletion (§3A.3)
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
  leaves_at: UtcMs | null;                                // people: last day (§3A.6)
  payroll_ref: string | null;                             // people: identifier Gusto's CSV template matches on (§18.8)
  payroll_type: 'employee' | 'contractor' | null;         // people: which Gusto CSV template they go in
  calendar_sync: boolean;                                 // people: opt-in (§18.3)
  source: Source;
}
```

- **I-05** Parent links form a forest with depth ≤ 2: room → mat.
- **I-06** Claiming a room does not claim its mats. Mats are places, not resource claims. A room that is `out_of_service` makes its classes `needs_resource` (§3A.5).
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
  immediate: boolean;                   // sick calls: created directly in 'approved' (decided_by = system); never 'rejected' (§3A.11)
  decided_by: ActorRef | null; decided_at: UtcMs | null;
  affected_assignment_ids: Id<'asg'>[]; // filled in the batch that vacates them
}

interface Customer {
  id: Id<'cus'>;
  member_subject: string | null;        // null = guest created at the desk (no account)
  state: 'active' | 'suspended' | 'closed' | 'erased';
  suspended_until: UtcMs | null; suspension_reason: string | null;
  merged_into: Id<'cus'> | null;        // set on the losing record of a merge
  linked_resource_id: Id<'res'> | null; // the same human as a staff member (§3A.7)
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
  cancel_reason: string | null;         // §9.2 cancel reasons
  capacity_total: number; booked_count: number; waitlist_count: number;
  over_capacity: boolean;               // booked_count > capacity_total after a capacity cut; closed to new bookings (§3A.9)
  exception: SessionException | null;  // differs from its series
  detached: boolean;                    // true once edited "this one"; series edits no longer touch it
  config_version: number; source: Source;
}
type SessionException =
  | { kind: 'substitute'; requirement_key: string; note?: string }
  | { kind: 'retimed'; from_start: UtcMs } | { kind: 'room_changed'; from_room: Id<'res'> }
  | { kind: 'capacity'; from: number } | { kind: 'cancelled'; reason: string };
// A session edited more than once keeps the most recent exception; the audit log keeps the history.

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
- **I-14** Cancelling a session releases all its claims and places in the same batch. Bookings are cancelled in that batch only when the `bookings` domain is `owner`; otherwise the outside system cancels them (§3A.9, D-44).

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
  late_penalty: Penalty; no_show_penalty: Penalty; refund: RefundRules /* includes refund.late (§4.8) */;
  origin: 'booked' | 'imported_at_cutover' }  // imported: snapshot of the active policy at the bookings cutover (§3A.18)

interface WaitlistEntry {
  id: Id<'wle'>; session_id: Id<'ses'>; customer_id: Id<'cus'>; position: number;
  preferred_place_ids: Id<'plc'>[];
  auto_charge_consent: boolean; payment_method_ref: string | null;   // processor saved-method ref via gateway
  state: 'waiting' | 'offered' | 'promoted' | 'expired' | 'left' | 'skipped';
  end_reason: string | null;            // set on every terminal state: e.g. session_cancelled, session_started, member_closed, INSUFFICIENT_UNITS (§3A.13)
  joined_at: UtcMs;
}

interface Offer {
  id: Id<'ofr'>;
  kind: 'place' | 'substitute';
  session_id: Id<'ses'>;
  waitlist_entry_id: Id<'wle'> | null;            // kind = place
  requirement_key: string | null;                 // kind = substitute
  recipient: { customer_id: Id<'cus'> } | { resource_id: Id<'res'> };
  state: 'sent' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'lapsed';
                                                  // lapsed = accepted, but its proposal later failed, expired or was rejected (§3A.14)
  expires_at: UtcMs; reply_text: string | null;   // free text from SMS/email replies (substitute)
  hold_id: Id<'hld'> | null;                      // kind = place: hold created atomically by accept (§7.7)
  proposal_id: Id<'prp'> | null;                  // kind = substitute: proposal created by the accept batch (§8.6)
  end_reason: string | null;                      // withdrawn/lapsed: filled, session_cancelled, person_inactive, proposal_failed, …
  created_by: ActorRef; run_id: string | null;
}
// Storage: `recipient` is stored as two nullable columns, offer.customer_id and offer.resource_id, exactly one non-null (§12.4).

interface CheckIn { id: Id<'chk'>; booking_id: Id<'bkg'>; session_id: Id<'ses'>; customer_id: Id<'cus'>;
  at: UtcMs; by: ActorRef; method: 'desk' | 'self' | 'kiosk'; client_key: string /* offline idempotency */ }
```

**Invariants**
- **I-19** A place has at most one place claim. An expired hold may be overwritten.
- **I-20** `booked_count` equals the number of booking place claims for the session.
- **I-21** A member has at most one active booking per session, unless the extra bookings share a `group_id` (guests).
- **I-22** A member cannot be both booked and waiting for the same session. A member may **join** the waitlist only when no free place they are eligible for exists.
- **I-23** Booking terms never change after creation, except through a lenient retroactive change (§6.8) or a studio-initiated session change, which moves `free_cancel_until` later (§3A.9). Both only make terms more lenient.

### 3.8.1 Booking state transitions

| From → To | Trigger | Allowed actors | Entitlement (ledger) | Money |
|---|---|---|---|---|
| (hold) → `confirmed` | confirm a hold | member, desk, member assistant (§10.1), waitlist promotion | `reserve −n` | price: capture after commit |
| (hold) → `pending_approval` | `approval.required_if` true | same | `reserve −n` | price: authorise only |
| `pending_approval` → `confirmed` | approver approves | manager/desk per policy | — | capture |
| `pending_approval` → `rejected` | approver rejects; timeout with `on_timeout: reject`; or session start reached while still pending (always reject) | approver, timer | `release +n` | void authorisation |
| `confirmed` → `cancelled` | cancel before `free_cancel_until`, or staff waive | member, desk, agent (if zero-cost) | `release +n` | refund per `terms.refund.timely` |
| `confirmed` → `late_cancelled` | cancel after `free_cancel_until` and before start | member (via confirmation if agent), desk | reserve held until assessment; then `forfeit` or `release` (§7.6) | fee per penalty; price-paid: refund only if `terms.refund.late = as_timely_if_refilled` and the place is refilled at assessment |
| `confirmed` → `checked_in` | check-in within the window | desk, instructor, member (kiosk/self) | — | — |
| `no_show` → `checked_in` | an offline desk check-in replayed late, whose recorded `at` is inside the check-in window | desk app (offline queue) | penalty reversed (compensating rows, fee refund job); audited | refund fee |
| `checked_in` → `attended` | session end + 15 min (timer) | system | `consume` (reserve becomes final) | — |
| `confirmed` → `no_show` | start + `grace` with no check-in (timer) | system | penalty at `assess_at` | fee per penalty |
| `no_show` → `attended` | correction within 24 h | desk, manager | reverse penalty with compensating rows | refund fee |
| `confirmed`/`pending_approval` → `cancelled` (studio) | session cancelled (unstaffed, closure, minimum attendance, staff), **bookings domain owned** | system, manager | `release +n` | refund per `terms.refund.studio_cancel` |
| `confirmed`/… → `cancelled` (mirrored) | the outside system cancels the booking after Kairos pushed a session cancel (bookings not owned, D-44) | outside system via mirror | none in Kairos (the outside system settles) | none in Kairos |
| `confirmed` → (moved) | `POST /bookings/{id}/move` while `now < terms.free_cancel_until` = new booking + timely cancellation of the old one in one batch. After that: `MOVE_NOT_ALLOWED` (cancel and rebook instead, D-50) | member, desk | `release` then `reserve` | difference charged or refunded |

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
  template_key: ConfigKey;              // the payroll label `kind` ('shift' | 'teaching') is derived from template.kind
                                        //   by packages/export at export time, never stored or read by engines (§14.1 lint, D-56)
  scheduled_start: UtcMs; scheduled_end: UtcMs;
  actual_start: UtcMs | null; actual_end: UtcMs | null; elapsed_minutes: number;
  state: 'scheduled' | 'worked' | 'approved' | 'exported' | 'voided';
  void_reason: 'vacated' | 'session_cancelled' | 'no_show' | 'manager' | null;
  pay_protected: boolean;               // studio cancel less than closure_pay_notice before start: kept and paid (§3A.16)
  final: boolean;                       // the person was offboarded; flagged in the export summary
  export_batch_id: string | null }
```

- **I-27** Applying a proposal re-validates it against current data. It applies completely or not at all.
- **I-28** Elapsed minutes are computed from UTC instants.
- **I-28b** A confirmed assignment in an **owned** domain has exactly one non-voided hours record. Vacating the assignment voids it in the same batch (§3A.16).
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

Every lifecycle rule (how each entity begins, changes and ends, what it does to dependants, who is notified, what happens in each domain mode, what is audited and how a partial failure recovers) is in **§3A Lifecycles**. Other sections refer to §3A and do not restate it.
