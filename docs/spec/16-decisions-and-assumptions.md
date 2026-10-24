# 16. Decisions and assumptions

## 16.1 Decisions

| ID | Decision | Rationale |
|---|---|---|
| D-01 | **CEL** (restricted profile) is the only expression language; JSONLogic was rejected | CEL type-checks at publish time, estimates cost, reads clearly in diffs, and LLMs write it more accurately (§5.1) |
| D-02 | **OR-Tools CP-SAT** in a Python container worker; Timefold was rejected | CP-SAT proves infeasibility and returns cores and optimality gaps. The worker stays thin and the business logic stays in TypeScript (§8.1) |
| D-03 | **REST + OpenAPI 3.1**; GraphQL was rejected | Edge caching, idempotent commands, per-operation agent allowlists, bounded cost (§11.1) |
| D-04 | **One database per tenant per environment** | Strong isolation, per-tenant restore, contention isolated per tenant |
| D-05 | Each service owns its data. `kairos-sync` writes mirrored data through `kairos-core`'s API | This is the tenant's rule, and it puts every claim through the same constraints |
| D-06 | **One occupancy table** keyed `(resource, 5-min grain, lane)` for classes, shifts and blocks, from both platform and mirror | SQLite has no exclusion constraints. This enforces "no desk shift during a class you teach" in the database |
| D-07 | Grain is 5 minutes. Durations, buffers and start times must be multiples of it | Fine enough for yoga buffers; keeps row counts small |
| D-08 | **Guarded batches**: unique keys, CHECK constraints, version guards with a `last_batch` token, and asserts that are **always scalar** | Edge SQLite has batch semantics. Asserts that can match zero rows silently pass, so they are forbidden (fixes review F-01) |
| D-09 | SessionGate orders requests; it is not the source of truth. **This departs from the brief's technical context**, which named the per-object store for holds and counters. In Kairos, holds and counters are authoritative in the database, and the per-object store only orders requests and runs alarms | Correctness survives a gate outage |
| D-10 | Templates, timetable, policies, products, constraints and workflows are **config**. People, members, sessions and bookings are **data** | Rules change through approved versions; facts change daily |
| D-11 | `template.kind` is a UI label, and lint blocks engines from reading it | Keeps behaviour in the primitives |
| D-12 | The substitute finder is hosted by Kairos. The member and staff assistants are owned by the tenant | The tenant owns the chat surfaces, inbox and help base |
| D-13 | Waitlist, penalties, minimum attendance, the unstaffed check, partition releases and refunds are **built-in policy**. Workflows only add reactions | No double promotion or double charge |
| D-14 | Cancellation and refund terms are snapshotted at booking. Only uniformly more lenient changes may apply retroactively | Fairness and predictability |
| D-15 | The late-fee waiver checks whether the specific place was refilled. In pooled classes, refills go to the earliest-released place | Deterministic and auditable |
| D-16 | Durations are elapsed time. `d`/`w` offsets are wall-clock calendar arithmetic | Correct hours for payroll |
| D-17 | A local time that doesn't exist shifts forward; an ambiguous one takes the first occurrence (RFC 5545) | Standard behaviour |
| D-18 | Units are stored as integer hundredths, rounded up | Exact arithmetic; CHECKs work |
| D-19 | Agents may only finalise reversible, zero-cost member actions. Everything else needs a confirmation that only a member token can redeem | A conversation can't be verified; a member's click can |
| D-20 | Cutover order: **shifts → classes → bookings → members** | Dependencies (§18.5) and risk |
| D-21 | Simulations run the production engine package with a virtual clock | Simulation can't drift from production |
| D-22 | Config rollback is forward-only | Immutable history |
| D-23 | Recurring memberships have no `length`; the period follows the billing cycle | Billing stays outside Kairos |
| D-24 | LLM provider calls go through the gateway | One gateway for every outside call |
| D-25 | **Scope is yoga studios only (v2.0).** Appointments, gyms, shifts-only businesses, field service, space rental, on-demand slot search, routing and travel are removed. The configurable core stays. The original acceptance test is restated for yoga (README) | Product direction from the owner: yoga only, keep the core |
| D-26 | Teachers are matched to outside systems through **person mapping** (email from the staff directory, then manual). An unmapped teacher puts the class in `needs_mapping` and blocks desk assignments at that studio and time | The cross-domain refusal must not depend on luck (review F-02) |
| D-27 | **Waitlisted members always have priority over new bookings.** A freed place is reserved for the waitlist in the same batch that frees it | Fair, and enforced in the database (review F-03) |
| D-28 | A policy must set `unstaffed`. For the reference tenant: cancel 90 min before start, with a full refund | Members must never arrive to a class with no teacher (review F-05) |
| D-29 | A timely cancellation of a price-paid booking gets a refund per `refund.timely` (reference tenant: `full`). A studio cancellation is always a full refund, and fees already charged are reversed | Clear money rules (review F-17) |
| D-30 | When the outside system is unavailable in mirror mode, writes are refused (`OUTSIDE_UNAVAILABLE`) and never queued, except desk check-ins | The outside system is the record (review F-15) |
| D-31 | Minors are out of scope for online booking in v2.0. Under-18s are booked at the desk as guests, with a guardian waiver | Avoids building a guardian model now |
| D-32 | A staff member linked to a member account can't book a class that overlaps their own assignment | One calendar per human |
| D-33 | A substitute offer lasts 20 min, or 10 min when the class starts within 6 h. The top 3 candidates are asked at once | Speed versus fairness |
| D-34 | When an outside system creates a class that overlaps an *owned* desk shift, Kairos does **not** vacate the shift automatically. It raises a conflict, alerts managers and blocks the time | A human decides which side changes. Revisit after Phase 1 data (Q-05) |
| D-35 | Tenant data is retained 30 days after closure, then crypto-shredded, and a deletion certificate is issued. A legal hold blocks deletion | Clear offboarding (review F-08) |

## 16.2 Assumptions

| ID | Assumption | If it's wrong |
|---|---|---|
| A-01 | Edge SQLite batches are atomic and run one at a time per database | Serialise writes through a per-tenant writer object |
| A-02 | The per-object store is single-threaded per object, durable, and supports alarms | Fall back to the database plus the sweep; correctness is unaffected |
| A-03 | BookingVendor's API (via the gateway) covers reading classes, bookings and members, writing bookings, cancelling, changing teachers and creating classes, and it emits events | No events: poll every 2 min. No class creation: cut over classes and bookings together |
| A-04 | ShiftTool can be read and written during the 60-day push period | Manual parallel run |
| A-05 | PayrollCo accepts imports through the gateway | Downloadable file |
| A-06 | Batches allow ≥ 100 statements and ≤ 1 MB | Smaller chunks |
| A-07 | The staff directory exposes people, groups, location, active state and email, plus `person.created` and `person.deactivated` events | Nightly sync only, so offboarding takes ≤ 24 h unless a manager deactivates the person in Kairos |
| A-08 | Member emails are verified by the member sign-in service | Linking at the desk |
| A-09 | All reference studios are in one time zone; the platform supports many | — |
| A-10 | A container host outside the hyperscale clouds is acceptable for the solver and simulation | Investigate a WASM solver build for small problems |
| A-11 | The processor supports authorise-then-capture, saved methods with consent, idempotency and dunning webhooks | Waitlist auto-charge degrades to offers; past-due handled manually |
| A-12 | Edge clocks are within ±1 s | Hold margins absorb ±5 s |
| A-13 | A TypeScript CEL library passes the conformance subset, or the profile is built in house | Phase 0 schedule risk |
| A-14 | Kairos's own commercial plans and billing for tenants are out of scope for this spec | A separate billing spec |

## 16.3 Review findings addressed in v2.0

| Finding | Where it is fixed |
|---|---|
| F-01 assert/version guard | §12.2, §7.5.2, §7.5.4, §8.5, §14.1 |
| F-02 teacher person mapping | §3.11, §18.5, D-26, A.5 |
| F-03 waitlist race | §7.7, §12.4, D-27, §9.6 |
| F-04 offer endpoints and entity | §3.8, §11.3, §10.4 |
| F-05 no substitute → members | §4.8 `unstaffed`, §7.1, §8.6, D-28 |
| F-06 expired on-demand holds | Removed with on-demand (D-25); holds claim places only (§12.4) |
| F-07 / F-08 tenant onboarding / offboarding | §3.12.1, D-35 |
| F-09 / F-10 staff and member lifecycle | §3.12.4, §3.12.5 |
| F-11 / F-12 closures, blocks | §3.12.2, §3.12.3, §11.3 |
| F-13 series edits | §4.7 |
| F-14 booking transitions | §3.8.1 |
| F-15 outside outage | §7.12, §13.8, D-30 |
| F-16 offer and hold TTL; consent fields | §7.5.2, §3.8 |
| F-17 refunds | §4.8, §7.6, D-29 |
| F-18 calendar sync | §18.3 |
| F-19 / F-20 observability; engine deploys | §13.9, §13.10 |
| F-21 eval suite | `evals/config-agent/cases.yaml`, §14.4 |
| F-22 phase dependency | §6 (manual path), §15 Phase 0 |
| F-23 staff who are members | §3.12.5, D-32 |
| F-24 unapproved proposals | I-28a |
| F-25 – F-41 (minor) | Mat examples fixed (§7.5.3, §11.4, §4b.1); view fields (§5.3); locked paths (§4.1.1); unit conversion (§4.2); role clash (§4.4); drift ownership (§3.11); missing endpoints (§11.3); I-22 wording; skipped notice (§4b.1); flag removal (§15); inbound dedupe (§12.6); full re-home SQL (§12.3); the D-09 departure; log isolation (§13.1). F-28 (gym `protect_pt`) and F-38 (coworking search) no longer apply |
