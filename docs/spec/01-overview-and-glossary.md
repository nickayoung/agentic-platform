# 1. Overview and design principles

## 1.1 What we are building

Kairos is a multi-tenant scheduling platform. Each tenant describes its business in plain language. The **configuration agent** turns that description into a **config document**: a typed JSON document validated by a schema. The document declares the tenant's locations, resources, event templates, timetable, policies, entitlements, constraints and workflows. Two deterministic engines execute the published config:

- The **booking engine** answers "what can this customer book, and can they book it now?" and commits bookings atomically.
- The **rostering engine** answers "who should work or teach what?" and produces proposed assignments. It runs as a batch solver, never in the request path.

A **workflow engine** reacts to domain events (booking cancelled, session starting in 2 hours) by running declared actions. **Runtime agent hooks** let LLM agents turn free text into structured queries, explain decisions and propose fixes. Agents only ever call the public API, and the engines validate everything they propose.

```
             owner prompt                      members / staff / agents
                  │                                      │
                  ▼                                      ▼
      ┌────────────────────────┐              ┌──────────────────────┐
      │  Configuration agent   │              │      Public API      │  REST, OpenAPI 3.1
      │  (LLM, offline)        │              └──────────┬───────────┘
      └──────────┬─────────────┘                         │
        config diff (JSON Patch)                         │
                 ▼                                       ▼
      ┌────────────────────────┐   compiled    ┌──────────────────────┐   solve jobs  ┌──────────────────┐
      │ Validate → simulate →  │──  config  ──▶│ Booking engine       │──────────────▶│ Rostering engine │
      │ summarise → approve →  │   (versioned) │ Workflow engine      │◀── proposals ─│ (OR-Tools worker)│
      │ publish                │               │ Sync (mirror/shadow) │               └──────────────────┘
      └────────────────────────┘               └──────────┬───────────┘
                                                          │ one SQLite DB per tenant per environment
                                                          ▼  (occupancy, places, bookings, ledger, outbox)
```

## 1.2 Design principles

1. **The LLM is a compiler, not a runtime.** LLMs produce config diffs, queries and proposals. They never decide whether a booking succeeds. Every booking decision is a pure function of (published config version, data snapshot, request, clock). The same inputs always produce the same output and the same decision trace.
2. **The schema is the boundary.** If the schema cannot express a behaviour, the platform cannot do it. The agent must say so. It must not approximate the behaviour with misleading config. New behaviour arrives as a schema change made by engineers, which ships behind a feature flag.
3. **One resource model, one calendar.** Classes, appointments, shifts, jobs and space bookings are all **sessions** that claim **resource time** in one **occupancy** table. A person, room or van can't be in two places at once. The database enforces this with a unique key, whatever domain the claim came from (§12.3).
4. **Engines never branch on business type.** `template.kind` is a UI label. Engine code MUST NOT read it. All behaviour comes from requirements, capacity, scheduling mode, policies and expressions. A CI lint rule enforces this (§14.1).
5. **Correctness at the database, speed above it.** The database enforces double-booking, spot claims, negative balances and limit counters through unique keys, CHECK constraints and guarded batches. Per-object coordinators (SessionGate) add fairness and throughput. Correctness never depends on them.
6. **Config is code.** Every config is an immutable, content-hashed version. Changes are diffs. Each diff is validated, simulated, explained, approved, published and can be rolled back. Existing bookings are never silently changed (§6.8).
7. **Fit beside, don't duplicate.** Kairos trusts the tenant's sign-in services, calls outside systems only through the shared gateway, sends messages only through the shared notification service, and exports hours to payroll. It never stores card data.
8. **Coexist, then own.** Each data domain moves on its own path from mirror to shadow to owner, and can roll back (§18.5).
9. **Off by default.** Every new behaviour ships behind a feature flag that starts off. Preview and production have separate data and separate outbound credentials.

## 1.3 Scope

**In scope:** configuration, availability, booking, waitlists, entitlement checks and ledgers, rostering and assignment, routing for field service, workflows, runtime agent hooks, sync with outside systems, hours export.

**Non-goals:** payroll calculation, point of sale, marketing automation, storing card data. Billing for memberships is done by the payment processor, or by the outside system while the members domain is mirrored. Kairos records entitlements and tells the processor what to charge (fees, drop-ins).

---

# 2. Glossary

| Term | Definition |
|---|---|
| **Tenant** | A business using Kairos. Each tenant has its own database in each environment. |
| **Environment** | `preview` or `production`. Data, credentials and outbound targets are fully separate. |
| **Location** | A physical site with an IANA time zone (for example `America/New_York`). Every session belongs to a location or to a **service site**. |
| **Service site** | A customer address where field work happens (HVAC). It has a geo point and a territory. |
| **Resource** | Anything that can be claimed for time: a `person`, `space`, `spot`, `equipment` or `vehicle`. |
| **Structural resource** | A non-person resource declared in config (a room, a bike, a van). |
| **Person resource** | A staff member. People are data synced from the staff sign-in service, not config. Config refers to them by selector or by `@staff:<key>`. |
| **Spot** | A child resource of a space with a position in a **layout** (bike #12, front row). |
| **Lane** | One of `concurrency` parallel slots on a resource. A PT zone with four lanes can host four PT sessions at once. |
| **Template** | A reusable definition of something schedulable: "Spin 45", "60-min assessment", "Desk AM shift", "AC repair". |
| **Requirement** | One resource need of a template ("1 instructor with skill `spin`", "1 room tagged `cycle`"). It also says how the resource gets assigned. |
| **Series** | A timetable entry: template + location + RRULE + start time + fixed resources. It generates sessions. |
| **Session** | One scheduled occurrence of a template with a start and end in UTC. Classes, appointments, shifts, jobs and room bookings are all sessions. |
| **Assignment** | A resource bound to a session for one requirement (Jamie teaches the 09:00 Spin, Room 1 hosts it). |
| **Claim** | A row stating that a resource is occupied from `occ_start` to `occ_end` for an owner (assignment, block or hold). |
| **Occupancy** | The grain-level expansion of claims. Its key `(resource_id, grain, lane)` is unique, so double-booking is impossible. |
| **Grain** | 5 minutes of UTC time. `grain = floor(epoch_minutes / 5)`. |
| **Place** | One unit of customer capacity in a session. Assigned places map to spots. Pooled places are anonymous. |
| **Partition** | A labelled subset of places with its own eligibility and release rule (tier-reserved, walk-in). |
| **Hold** | A short-lived claim on a place (or on resource time for on-demand sessions) during checkout. |
| **Booking** | A customer's confirmed claim on a place in a session. |
| **Waitlist entry** | A customer's ordered request for a place in a full session. |
| **Policy set** | A named bundle of booking window, cancellation, no-show, limits, approval, minimum attendance, waitlist and check-in rules. |
| **Entitlement product** | Something a customer can hold: a membership, a class pack or a pass. It grants **units** and can carry caps and a tier. |
| **Entitlement** | One customer's instance of a product, with a balance and validity. Changes are recorded in the **ledger**. |
| **Unit** | A named currency of entitlement: `class_credit`, `pt_session`, `room_hour`, `desk_day`. |
| **Tier** | A ranked membership level (`basic`, `plus`, `premium`). Expressions use it. |
| **Constraint** | A hard rule (never violated) or a soft rule (weighted preference) used by the engines. |
| **Coverage requirement** | Minimum (and target) staffing by role, location and time of day. |
| **Workflow** | Trigger → condition → actions. Actions can be delayed. |
| **Proposal** | A change suggested by a person, the solver or an agent (a swap, a new roster, a refund). The engine validates it and an authorised human approves it, unless policy allows auto-approval. |
| **Decision trace** | The ordered list of checks the engine ran for a request, with reason codes and references to config paths. |
| **Config document** | The full typed configuration of a tenant (§4). |
| **Config version** | An immutable, content-hashed published config document with a monotonically increasing number. |
| **Draft** | An unpublished config document being edited by a person or the configuration agent. |
| **Domain** | A unit of data ownership for sync: `classes`, `bookings`, `members`, `shifts`. |
| **Domain mode** | `mirror`, `shadow` or `owner`, set per tenant, environment and domain (§18.5). |
| **Drift** | A difference between Kairos's copy of a record and the outside system's record. |
| **Shadow disagreement** | A case where Kairos's own decision differs from what the outside system decided. |
| **Gateway** | The tenant's shared service that holds outside-system credentials and proxies every outbound call. |
| **SessionGate** | A per-session coordinator object (a strongly consistent per-object store) that orders contended requests and runs hold-expiry alarms. |
| **CEL** | Common Expression Language, the only way to write conditional logic in config (§5). |
| **IR** | The solver's intermediate representation: a JSON problem that the TypeScript compiler produces and the solver worker reads (§8.3). |
