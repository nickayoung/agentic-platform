# 1. Overview and design principles

## 1.1 What we are building

Kairos runs the schedule of a multi-studio yoga business. The studio owner describes the business in plain language: studios, rooms and mat layouts, class types, the weekly timetable, memberships and class packs, booking and cancellation rules, and desk cover. The **configuration agent** turns that description into a **config document**, a typed JSON document checked against a schema (§4). The published config is executed by deterministic engines:

- The **booking engine** answers "can this member book this class, on this mat, now?" and commits bookings atomically.
- The **rostering engine** proposes who teaches each class and who works each desk shift. It runs as a batch solver, never in the request path.

Two further components work on top of the engines:

- The **workflow engine** reacts to events, for example a booking cancelled or a class starting in 2 hours, by running declared actions such as notifications, desk tasks or a substitute search.
- **Runtime agent hooks** let LLM agents parse free-text requests, explain decisions, and find substitute instructors. Agents call only the public API, and the engines validate everything they propose.

```
     studio owner prompt                          members / staff / agents
            │                                              │
            ▼                                              ▼
 ┌──────────────────────┐                      ┌──────────────────────┐
 │ Configuration agent  │                      │  Public API (REST)   │
 └─────────┬────────────┘                      └──────────┬───────────┘
   config diff (JSON Patch)                               │
           ▼                                              ▼
 ┌──────────────────────┐ compiled config  ┌──────────────────────────┐  solve jobs  ┌────────────────┐
 │ validate → simulate →│────────────────▶ │ Booking engine           │────────────▶ │ Rostering      │
 │ summarise → approve →│   (versioned)    │ Workflow engine          │◀─ proposals ─│ (CP-SAT worker)│
 │ publish              │                  │ Sync (mirror/shadow)     │              └────────────────┘
 └──────────────────────┘                  └────────────┬─────────────┘
                                                        │ one SQLite DB per tenant per environment
                                                        ▼ (a Durable Object's storage, §19: occupancy,
                                                           places, bookings, ledger, outbox)
```

## 1.2 Design principles

1. **The LLM is a compiler, not a runtime.** LLMs only produce config diffs, structured queries and proposals. Every booking decision is a pure function of (published config version, data snapshot, request, clock).
2. **The schema is the boundary.** If the schema cannot express a behaviour, Kairos cannot do it. The agent says so. It does not approximate the behaviour without telling the owner.
3. **One calendar for people and rooms.** Classes and desk shifts are both **sessions**, and they claim resource time in one **occupancy** table. Its unique key makes it impossible for one person or room to be in two places at once. This holds whether the claim came from Kairos or was mirrored from an outside system (§12.3).
4. **Engines never branch on session kind.** `template.kind` (`class` or `shift`) is a UI label. All behaviour comes from requirements, capacity, scheduling mode and policies. A CI lint rule enforces this (§14.1).
5. **Correctness lives in the database; speed lives above it.** Unique keys, CHECK constraints and single-writer transactions enforce correctness (§12.2). The per-session queue (SessionGate) adds fair ordering and fast answers. Correctness never depends on it.
6. **Config is code.** Configs are versioned and immutable. Every change is validated, simulated, explained, approved by a human, published, and can be rolled back. Existing bookings are never changed silently (§6.8).
7. **Fit beside, don't duplicate.** Kairos trusts the tenant's sign-in services. It calls outside systems only through the gateway and sends messages only through the notification service. It exports hours to payroll and stops there. It never stores card data.
8. **Coexist, then own.** Each data domain (classes, bookings, members, shifts) moves separately from mirror to shadow to owner, and can be rolled back (§18.5).
9. **Off by default.** Every new behaviour ships behind a feature flag that defaults to off. Preview and production have separate data and separate outbound credentials.

## 1.3 Scope

**In scope:**
- yoga classes in studio rooms, either with a mat spot map (assigned) or without one (pooled);
- reserved and walk-in mats;
- memberships and class packs;
- booking windows, cancellation, late-cancel and no-show rules;
- waitlists and minimum attendance;
- instructor rostering and substitutes;
- desk-shift rostering, swaps, time off and availability;
- check-in, desk tasks, workflows and runtime agents;
- sync with outside systems;
- hours export;
- the full lifecycle of every entity, in one place (§3A).

**Out of scope for v2.0 (D-25):**
- business shapes other than yoga studios (appointments, gyms, restaurants, field service, space rental);
- one-to-one private sessions booked by start time (a private class can be scheduled by staff as a one-off session with capacity 1);
- workshops sold as multi-session series (Q-04).

**Non-goals:** payroll calculation, point of sale (retail, cafe), marketing automation, storing card data.

---

# 2. Glossary

| Term | Definition |
|---|---|
| **Tenant** | A yoga business using Kairos. It has one database per environment. |
| **Environment** | `preview` or `production`. Their data, credentials and outbound targets are separate. |
| **Studio** | A physical location, with an IANA time zone. In config and the API it is called a `location`. |
| **Room** | A space in a studio where classes run. It may have a mat layout. |
| **Resource** | Anything whose time can be claimed. In v2.0 that is a `person`, a `space` (a room or a front desk) or a `spot` (a mat position). |
| **Mat spot** | A child resource of a room, with a position in a **layout** (for example "Mat 12, row 2, by the wall"). |
| **Lane** | One of `concurrency` parallel slots on a resource. A front desk with 2 lanes seats 2 desk staff at once. |
| **Person resource** | A staff member: instructor, desk staff or manager. People are data synced from the staff sign-in service, not config. |
| **Template** | A reusable definition: "Vinyasa 60", "Hot 75", "Desk – opening". |
| **Requirement** | One resource need of a template, for example 1 instructor with skill `hot_cert` and 1 heated room. It also says how the resource is assigned (`fixed` or `roster`). |
| **Series** | A timetable entry: template, studio, RRULE, start time, room. Series generate sessions. |
| **Session** | One scheduled occurrence with a UTC start and end. A class and a desk shift are both sessions. |
| **Session exception** | A per-session change that differs from its series, such as a substitute instructor, a new time, a cancellation or a changed capacity. |
| **Assignment** | A resource bound to a session for one requirement. Example: "Priya teaches Tue 09:00 Vinyasa". |
| **Resource claim** | A row saying a resource is occupied from `occ_start` to `occ_end` for an owner (an assignment or a block). |
| **Occupancy** | The 5-minute-grain expansion of resource claims. Its key `(resource_id, grain, lane)` is unique. |
| **Grain** | 5 minutes of UTC time: `floor(epoch_minutes / 5)`. |
| **Place** | One unit of member capacity in a class. An assigned place is a mat spot. A pooled place is anonymous. |
| **Place claim** | The one row that holds a place: either a hold or a booking. This is a different table from resource claims. |
| **`release_place`** | The one routine every place-freeing path runs in its batch: it frees the place, reserves it for the waitlist when an eligible waiting entry exists, and emits `place.released` (§7.7). |
| **Partition** | A labelled subset of places with its own eligibility and release time, for example `front_row_unlimited` or `walk_in`. |
| **Hold** | A claim on a place that expires after a short time, used during checkout. |
| **Booking** | A member's claim on a place in a class, from confirmation (or `pending_approval`) until it ends (§3.8.1). `booked_via` records the channel it was made through. |
| **Channel** | Where a request comes from: `web`, `desk`, `portal`, `agent`, `mirror` or `waitlist` (CEL `request.channel`; stored on a booking as `booked_via`). |
| **Waitlist entry** | A member's ordered request for a place in a full class. |
| **Offer** | A time-limited request to a person, either a waitlisted member (a place offer) or an instructor (a substitute offer). A substitute offer that was accepted but whose proposal then failed, was rejected or expired is **lapsed**. |
| **Policy set** | A named bundle of booking window, cancellation, no-show, limits, approval, minimum attendance, unstaffed handling, waitlist, refund and check-in rules. |
| **Entitlement product** | A membership or class pack that a member can hold. It grants **units** and may carry caps and a tier. |
| **Entitlement** | One member's instance of a product, with a balance and validity. Every change is recorded in the **ledger**. |
| **Unit** | A named credit currency. In v2.0 this is `class_credit`. |
| **Tier** | A ranked membership level (`member`, `unlimited`). |
| **Constraint** | A hard rule (never broken) or a soft rule (weighted preference) used by the engines. |
| **Coverage requirement** | The minimum and target desk staffing per studio and time of day. |
| **Hours record** | One assignment's scheduled and worked time, used for the payroll export; exists only for owned domains (§3A.16). |
| **Workflow** | Trigger → condition → actions. Actions can be delayed. A **workflow run** is one execution for one event or time anchor. |
| **Workflow scope** | `all`: a workflow also runs for events about records mirrored from an outside system. `owned`: only for events whose domain Kairos owns. The default comes from `tenant.member_messaging` (`kairos` → `all`; `record_holder` → `owned`, with member recipients resolving only for owned bookings or members) (§9.3). |
| **Event domain** | The data domain an event belongs to (`classes`, `bookings`, `members`, `shifts`, or `none`), carried as `event.domain` (§9.2). |
| **Required notice** | An event that a config must route to a `notify` workflow, or validation warns `NOTICE_MISSING` (§9.2). |
| **Outbox** | The table of side effects (messages, pushes, money jobs) written in the same batch as the state change and delivered after commit with retries (§12.6). |
| **Saga** | Work larger than one batch, done as numbered idempotent steps that resume after a failure (§3A.1 C6). |
| **Lifecycle card** | The fixed description of one lifecycle event: trigger, state changes, dependants, notifications, outside systems per mode, audit, failure and recovery (§3A.1). |
| **Proposal** | A change that is validated and then approved by a human. Staff, the solver, agents or the engine (on a substitute accept) can create one. Examples: a substitute, a roster, a refund. |
| **Impact plan** | The list of existing records a change affects, grouped, each group with a resolution: for a config change (§6.8, L6) or a session edit (§3A.9.2). |
| **Studio cancel** | Kairos cancels a session (unstaffed, under minimum, closure, staff, migration, tenant closing). Booking effects follow §3A.9.4. |
| **Unstaffed check** | The built-in timer at `unstaffed.check_at` that cancels a class (or notifies staff) when a roster requirement is still empty (§3A.9.5). |
| **Over capacity** | A session with more bookings than places after a capacity cut; it takes no new bookings (§3A.9.3). |
| **Decision trace** | The ordered checks the engine ran for a request, with their reason codes. |
| **Config document / version / draft** | The tenant's full configuration (§4); a published, content-hashed copy of it; an unpublished working copy. |
| **Domain** | A unit of data ownership for sync: `classes`, `bookings`, `members`, `shifts`. |
| **Domain mode** | `mirror`, `shadow` or `owner`, set per domain (§18.5). What Kairos does in each mode is the matrix in §3A.2. |
| **Dry run** | In `shadow` mode, Kairos computes the decision it would make, logs any difference from the outside system as a shadow disagreement, and writes nothing else. |
| **Write freeze** | A short period (≤ 15 min) during a mode switch when writes to the domain return `WRITE_FROZEN` (§18.7). |
| **Push** | An outbox call that sends a change Kairos owns to an outside system through the gateway. A push that fails 3 times raises `push_failed` drift. |
| **Adoption** | At the classes cutover, matching mirrored future sessions to timetable series so they become Kairos sessions (§3A.18). |
| **Staleness guard** | A targeted pull of a person's mirrored days before a staff commit; fails with `MIRROR_STALE` when the outside system is unreachable and the copy is too old (§18.6). |
| **Person mapping** | The link from an outside system's person ID (for example a BookingVendor instructor) to a Kairos person resource (§18.5). |
| **Drift** | A difference between Kairos's copy of a record and the outside system's record. |
| **Gateway** | The tenant's shared proxy for every outbound call. It holds all outside credentials. |
| **SessionGate** | A per-class in-memory command queue inside the tenant's `TenantCore` object. It orders contended requests across `await`s and caches free counts (§19.3). |
| **Batch** | One atomic write: a single synchronous SQLite transaction in `TenantCore` that also writes the audit row, events and outbox rows (§12.2). |
| **TenantCore** | The Durable Object that holds one tenant-environment's `kairos-core` database and runs the engines (§19.1). |
| **CEL** | Common Expression Language, the only way to write conditional logic in config (§5). |
