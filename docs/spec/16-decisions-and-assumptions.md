# 16. Decisions and assumptions

## 16.1 Decisions

| ID | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| D-01 | **CEL** (restricted profile) is the only expression language | JSONLogic; a custom DSL | Static type-checking at publish, cost estimation, readability in approval diffs, LLM accuracy (§5.1) |
| D-02 | **OR-Tools** (CP-SAT for rostering and timetabling; the routing library for field service) in a Python container worker | Timefold (JVM) | Proven infeasibility cores, optimality gaps, one package for both problem types, thin worker with logic kept in TypeScript (§8.1) |
| D-03 | **REST + OpenAPI 3.1** public API | GraphQL | Edge caching, idempotent commands, per-operation agent tool allowlists, bounded query cost (§11.1) |
| D-04 | **Database per tenant per environment** | A shared database with a tenant column | Strong isolation, per-tenant restore, keeps single-writer contention per tenant, matches "each function has its own SQLite-compatible database" |
| D-05 | Services own their data; `kairos-sync` writes mirrored data through `kairos-core`'s API | Sync writes directly into core tables | Tenant rule "no service reads another's database", and every mirrored claim passes the same occupancy constraints |
| D-06 | **One occupancy table** with a `(resource, 5-minute grain, lane)` primary key for every domain | Per-domain calendars; range-overlap checks in application code | SQLite has no exclusion constraints, so a grain table makes double-booking impossible at the database level, across domains (§12.3) |
| D-07 | Grain = **5 minutes**; config durations, buffers and starts must be multiples of 5 | 1 minute; 15 minutes | 1 minute gives 5× the rows; 15 minutes is too coarse for appointment buffers. Outside data that isn't aligned is rounded outward |
| D-08 | **Guarded batches** (unique keys, CHECKs, version rows, assert rows) instead of interactive transactions | Interactive transactions; locks in per-object stores | Matches edge SQLite batch semantics. Correctness lives in the database. Gates are an optimisation only |
| D-09 | **SessionGate** per session for ordering, plus alarms for hold expiry | Database only | Fair first-come-first-served order at booking-open rushes; fast "full" answers. Correctness doesn't depend on it |
| D-10 | Templates, timetable series, policies, products, constraints and workflows are **config**. People, customers, sessions, bookings and availability are **data** | Everything in config; everything as data | Config = the rules of the business, changed through validated, approved versions. Data = facts that change many times a day |
| D-11 | `template.kind` is a UI label only, and engines are lint-blocked from reading it | Typed subclasses per business type | Ensures one set of primitives covers all five shapes (principle 4) |
| D-12 | The substitute finder is Kairos-hosted. The member and staff assistants are tenant-owned clients | All Kairos-hosted | The tenant already owns the chat surfaces, inbox and help base. The substitute finder is driven by Kairos workflows |
| D-13 | Waitlist promotion, penalties, min-attendance and partition releases are **built-in policy behaviour**. Workflows only add reactions | Everything as workflows | Avoids double promotion or double charges, and keeps money-moving behaviour in tested engine code |
| D-14 | Cancellation terms are **snapshotted at booking**. Only uniformly more lenient changes may apply retroactively (`lenient_only`) | Always current terms | Fairness to customers, and predictable disputes |
| D-15 | Late-cancel fee waiver uses **`booking.place_refilled`** of the specific place. Pooled refills go to the earliest-released place | Count-based refill | Deterministic and auditable. Gives credit to the earliest late canceller |
| D-16 | Durations are **elapsed time**. Calendar offsets (`d`, `w`) are wall-clock arithmetic | Wall-clock end times for shifts | Correct hours for labour law and payroll. See open question Q-03 |
| D-17 | Non-existent local times shift forward, and ambiguous ones use the first occurrence (RFC 5545) | Skip the occurrence | Standard, and what members expect ("the 2:30 class happens at 3:30 that day") |
| D-18 | Units are stored as integer hundredths | Floats | Exact fractional room-hours, and CHECK constraints work |
| D-19 | Agents can directly finalise only reversible, zero-cost member actions. Everything else needs a member-token confirmation | Agent confirms after asking in chat | The platform can't verify a conversation. A member-token click can be verified |
| D-20 | Cutover order: **shifts → classes → bookings → members** | members first; big bang | Dependency order (§18.5), risk order, and the early cross-domain guard |
| D-21 | Simulations run the same engine package in the batch worker with an in-memory SQLite and a virtual clock | A separate simulator | Simulations can't drift from production behaviour |
| D-22 | Rollback of config is forward-only (republish an old document) | Restore in place | Immutable history, and bookings made under newer versions stay valid |
| D-23 | Recurring monthly memberships have no `length`. Their period follows the processor's billing cycle | A "month" duration unit | Avoids calendar-month arithmetic in the duration grammar. Billing is outside Kairos |
| D-24 | LLM provider calls go through the shared gateway | A direct provider SDK with a key | Tenant rule: one gateway for every outside call, and no outside keys in Kairos |

## 16.2 Assumptions

| ID | Assumption | If it is wrong |
|---|---|---|
| A-01 | The edge SQLite service runs a database's write batches one at a time, and each batch is atomic | Use a per-tenant writer object to serialise writes |
| A-02 | The per-object store gives single-threaded execution per object, durable storage and alarms | Fall back to the database plus a cron sweep (correctness is unaffected) |
| A-03 | BookingVendor exposes APIs to read classes, bookings and members; to create and cancel bookings; to change instructors; and to create classes, all through the gateway. It also emits change events | Without events: tighter polling (2 min windows). Without class creation: the classes domain can't be owned before bookings, and the order changes to classes + bookings together |
| A-04 | ShiftTool supports reads and writes of shifts, for the 60-day `outbound_push` period | Run ShiftTool read-only and accept a manual parallel period |
| A-05 | PayrollCo accepts hours imports (JSON or CSV) through the gateway | Produce a downloadable file for a manager to upload |
| A-06 | Batches allow ≥ 100 statements and ≤ 1 MB | Smaller chunks; sagas for larger units |
| A-07 | The staff sign-in service provides a directory API (people, groups, active status) | Manual person management in the portal |
| A-08 | Members have one account per person, and a member's email is verified by the member sign-in service | Linking to mirrored members needs a manual desk step |
| A-09 | The reference tenant's studios share one time zone. The platform supports many zones regardless | — |
| A-10 | A container host outside the hyperscale clouds is acceptable for the solver and simulation worker (CPU-bound, long-running jobs that can't run at the edge) | Investigate a WebAssembly build of a MIP/CP solver at the edge for small problems. Infeasibility reporting would be weaker |
| A-11 | The payment processor supports authorise-then-capture, saved payment methods with consent, and idempotent requests | Price-paid waitlist auto-promotion degrades to offers only |
| A-12 | Edge node clocks are NTP-synced to ±1 s | Hold TTL margins absorb up to ±5 s |
| A-13 | A TypeScript CEL implementation can pass the profile's conformance subset, or we build one (≈ 3–4k lines) | Schedule risk in Phase 0 (R-03) |
