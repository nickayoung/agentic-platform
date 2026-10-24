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
| D-43 | **Payroll is Gusto, fed by CSV upload.** Kairos makes no calls to Gusto. It produces files per pay period: an employees file (one row per person × workweek, optionally per kind) and a contractors file. It classifies regular and overtime hours with a configurable rule (FLSA weekly 40 by default; overtime goes to the chronologically last hours) and never handles rates or pay. Corrections after submission go into a corrections file for manual entry | The owner chose Gusto and CSV. It keeps Kairos out of payroll (non-goal) while giving Gusto what its upload expects |
| D-35 | Tenant data is retained 30 days after closure, then crypto-shredded, and a deletion certificate is issued. A legal hold blocks deletion | Clear offboarding (review F-08) |
| D-36 | Payroll source per kind and phase (§18.8). Kairos exports desk hours from the shifts cutover, and teaching hours from the classes cutover. The old systems' exports are switched off on those dates | Nobody is paid twice (review G-09) |
| D-37 | Built-in policy behaviour runs only for owned domains. Shadow is a dry run, and mirror runs nothing (§7.13) | Kairos never acts on another system's records (review G-02) |
| D-38 | Rostered templates declare start times per weekday and studio, and candidates must fit desk availability (§4.6) | Real studio hours differ by day and studio (review G-01) |
| D-39 | Config staff roles come from `access.staff_role_mappings`, with audited manager overrides (§4.13) | Rostering needs a defined source of roles (review G-04) |
| D-40 | Strikes expire after `strike_window` (default 90 days) and can be removed by managers | Members aren't gated forever (review G-10) |
| D-41 | A pending, validated substitute proposal defers the unstaffed check to `min(expires_at, start − 30m)`. Substitute proposals expire at `min(start − 30m, now + 2h)` | A found substitute isn't thrown away (review G-07) |
| D-42 | `max_hours`, `max_assignments` and `max_consecutive_days` count all of the person's work by default (`counts: all_work`) | Labour limits cover teaching plus desk work (review G-08) |
| D-44 | **Events that span domains run natively only for owned domains.** When Kairos cancels a class whose bookings it doesn't own (Phase 3), it pushes the class cancel. BookingVendor cancels, refunds and notifies its bookings, and Kairos mirrors the result. A failed push raises an urgent manager task (§3A.1 C4, §3A.9.4). **Assumed, not confirmed** (DQ-1) | Kairos never writes another system's records; the system that holds the money and the member relationship acts on them (review H-01) |
| D-45 | The Dumbo desk has **2 lanes**, like the other desks, so opening and closing shifts can overlap at handover. **Assumed, not confirmed** (DQ-2; placeholder, Q-17) | With 1 lane, hard coverage at Dumbo is infeasible (review H-02) |
| D-46 | `min_rest` takes optional `from` / `to` template-tag scopes (schema 2.1). `desk_rest` is 10 h from a `closing` to the next `opening` shift. **Assumed, not confirmed** (DQ-3) | The owner's rule is close → open, not between any two pieces of work (review H-03) |
| D-47 | Desk shifts go **mirror → shadow (14 days) → owner** in Phase 1, like every other domain. **Assumed, not confirmed** (DQ-4) | One cutover rule for all domains (review H-05) |
| D-48 | `refund.late` (schema 2.1): `none` or `as_timely_if_refilled`, default `none`. The reference tenant uses `none`. `waive_if` cancels penalties only; it never decides refunds. **Assumed, not confirmed** (DQ-5, Q-18) | The owner promised refunds only for timely cancels (review H-09) |
| D-49 | A studio-initiated session change (retime, room change) keeps bookings, extends each booking's free cancellation to the new start, and notifies members. A smaller room re-seats, then cancels with a full refund, newest booking first. Overlaps with a member's other bookings are listed, never auto-cancelled. **Assumed, not confirmed** (DQ-6) | Members aren't penalised for the studio's change (review H-10) |
| D-50 | A booking can be moved only before `free_cancel_until`; after that the member cancels (late) and books again. **Assumed, not confirmed** (DQ-8) | A move must not bypass late penalties (review H-17) |
| D-51 | Workflows default to `scope: owned`. Member recipients resolve only when Kairos owns the bookings (or members, for `all_members`). **Assumed, not confirmed** (DQ-7) | The system of record messages its members; no duplicate notices (review H-13) |
| D-52 | A sick call is approved on submission and can't be rejected. Cancelling it restores availability but not the released assignments. **Assumed, not confirmed** (DQ-9) | Cover starts at once; un-vacating would race the substitute flow (review H-16) |
| D-53 | Bookings imported at the bookings cutover get the active policy's terms (`origin: imported_at_cutover`). Penalties for late cancels and no-shows that happened before the cutover belong to BookingVendor. **Assumed, not confirmed** (DQ-10) | Parity is proven in shadow first; no double penalty (review H-12) |
| D-54 | Hours records exist only for owned domains: desk from the shifts cutover, teaching from the classes cutover. **Assumed, not confirmed** (DQ-11) | Matches D-36; mirrored work is paid through the old feed (review H-08) |
| D-55 | Staff keep their hours for any studio cancel committed less than `closure_pay_notice` before start, not only for closures. **Assumed, not confirmed** (DQ-12, Q-02) | One rule for every short-notice cancel (review H-08) |
| D-56 | `template.kind` may be read only by `packages/export`, to label hours `shift` or `teaching`. Engines and workflows still never read it | Payroll needs a label; behaviour stays in the primitives (review H-28) |
| D-57 | The **engine** creates the substitute proposal in the offer-accept batch. A partial unique index allows one accepted offer per slot, and a failed, rejected or expired proposal sets its offer to `lapsed` | No duplicate proposals; one creator (review H-06) |
| D-58 | A booking still `pending_approval` at session start is rejected | No approval after the class has begun (review H-18) |
| D-59 | A freed place is reserved for the waitlist only if at least one waiting entry could be eligible for its partition | A front-row place isn't blocked by a waitlist that can't use it (review H-25) |
| D-60 | At the classes cutover, mirrored future sessions are adopted into timetable series by (template, studio, local date, local start); unmatched ones become one-off sessions | No duplicate or lost classes at cutover (review H-12) |

## 16.2 Assumptions

| ID | Assumption | If it's wrong |
|---|---|---|
| A-01 | Edge SQLite batches are atomic and run one at a time per database | Serialise writes through a per-tenant writer object |
| A-02 | The per-object store is single-threaded per object, durable, and supports alarms | Fall back to the database plus the sweep; correctness is unaffected |
| A-03 | BookingVendor's API (via the gateway) covers reading classes, bookings and members, writing bookings, cancelling, changing teachers and creating classes, and it emits events | No events: poll every 2 min. No class creation: cut over classes and bookings together |
| A-04 | ShiftTool can be read and written during the 60-day push period | Manual parallel run |
| A-05 | Gusto's CSV upload for employee hours (with a workweek column) and its separate contractor CSV upload stay available. Re-uploads for the same payroll overwrite, a zero overwrites, and a blank leaves values unchanged (per Gusto's help pages) | Switch to Gusto's API through the gateway (a new decision) |
| A-06 | Batches allow ≥ 100 statements and ≤ 1 MB | Smaller chunks |
| A-07 | The staff directory exposes people, groups, location, active state and email, plus `person.created` and `person.deactivated` events | Nightly sync only, so offboarding takes ≤ 24 h unless a manager deactivates the person in Kairos |
| A-08 | Member emails are verified by the member sign-in service | Linking at the desk |
| A-09 | All reference studios are in one time zone; the platform supports many | — |
| A-10 | A container host outside the hyperscale clouds is acceptable for the solver and simulation | Investigate a WASM solver build for small problems |
| A-11 | The processor supports authorise-then-capture, saved methods with consent, idempotency and dunning webhooks | Waitlist auto-charge degrades to offers; past-due handled manually |
| A-12 | Edge clocks are within ±1 s | Hold margins absorb ±5 s |
| A-13 | A TypeScript CEL library passes the conformance subset, or the profile is built in house | Phase 0 schedule risk |
| A-14 | Kairos's own commercial plans and billing for tenants are out of scope for this spec | A separate billing spec |
| A-15 | BookingVendor's API can cancel a class. When a class is cancelled, BookingVendor cancels its bookings, refunds them under its own rules and notifies the members | Phase 3 runs with `unstaffed.action: notify_staff`, and a manager cancels in BookingVendor; the urgent task flow is reused |
| A-16 | The physical Dumbo desk can seat two people during a handover (D-45) | Change the Dumbo `starts` so its shifts don't overlap (for example a single 13.5 h template), or accept a coverage gap |

## 16.3 Review findings addressed in v2.0

Section references in 16.3 and 16.4 point to where each fix lives in v3.0; the old §3.12 content is now in §3A.

| Finding | Where it is fixed |
|---|---|
| F-01 assert/version guard | §12.2, §7.5.2, §7.5.4, §8.5, §14.1 |
| F-02 teacher person mapping | §3.11, §18.5, D-26, A.5 |
| F-03 waitlist race | §7.7, §12.4, D-27, §9.6 |
| F-04 offer endpoints and entity | §3.8, §11.3, §10.4 |
| F-05 no substitute → members | §4.8 `unstaffed`, §7.1, §8.6, D-28 |
| F-06 expired on-demand holds | Removed with on-demand (D-25); holds claim places only (§12.4) |
| F-07 / F-08 tenant onboarding / offboarding | §3A.3, D-35 |
| F-09 / F-10 staff and member lifecycle | §3A.6, §3A.7 |
| F-11 / F-12 closures, blocks | §3A.4, §3A.5, §11.3 |
| F-13 series edits | §4.7 |
| F-14 booking transitions | §3.8.1 |
| F-15 outside outage | §7.12, §13.8, D-30 |
| F-16 offer and hold TTL; consent fields | §7.5.2, §3.8 |
| F-17 refunds | §4.8, §7.6, D-29 |
| F-18 calendar sync | §18.3 |
| F-19 / F-20 observability; engine deploys | §13.9, §13.10 |
| F-21 eval suite | `evals/config-agent/cases.yaml`, §14.4 |
| F-22 phase dependency | §6 (manual path), §15 Phase 0 |
| F-23 staff who are members | §3A.7, D-32 |
| F-24 unapproved proposals | I-28a |
| F-25 – F-41 (minor) | Mat examples fixed (§7.5.3, §11.4, §4b.1); view fields (§5.3); locked paths (§4.1.1); unit conversion (§4.2); role clash (§4.4); drift ownership (§3.11); missing endpoints (§11.3); I-22 wording; skipped notice (§4b.1); flag removal (§15); inbound dedupe (§12.6); full re-home SQL (§12.3); the D-09 departure; log isolation (§13.1). F-28 (gym `protect_pt`) and F-38 (coworking search) no longer apply |

## 16.4 Second-review findings addressed

| Finding | Where it is fixed |
|---|---|
| G-01 reference config invalid; shift starts | §4b.1 (timetable, desk `starts`), §4.6, §6.3, §15 Phase 0 (real validator in CI), D-38 |
| G-02 built-in behaviour on mirrored records | §7.13, §7.1, §14.1 mode tests, `a5_…` mode-guard variant, D-37 |
| G-03 offer accept vs hold assert | §7.5.2, §7.7, §3.8 `Offer.hold_id`, §11.3, §12.4, A.3 |
| G-04 config staff roles | §4.13 `staff_role_mappings`, §3A.6, §4b.1, D-39 |
| G-05 staff writes on mirrored domains | §18.5.1, §8.6 step 9, A.4 |
| G-06 promotion when the gate is down; sweep | §7.7 `release_place`, promotion sweep, §12.4 |
| G-07 unstaffed check vs pending proposal | §8.6 step 7, §6.3 `UNSTAFFED_NOT_AFTER_DEADLINE`, §4b.1 deadline T−2h, D-41 |
| G-08 hour-counting scope | §4.11 `counts`, §8.3, D-42 |
| G-09 payroll source | §18.8, D-36 |
| G-10 strike decay | §3.5 `CustomerStrike`, §4.8 `strike_window`, §12.5, D-40 |
| G-11 eval grammar and scenarios | §14.4 grammar, `evals/config-agent/schema.json`, `intents.yaml`, `fixtures/scenarios/lotus_line/`, Y-REF-01 turns and `golden_ignore` |
| G-12 unmapped teacher across studios | §18.5 step 3, §8.3 `unmapped_blocks`, A.5 |
| G-13 – G-23 (minor) | `place_refilled` computed (§3.8); refund credit product (§4.3); late offline check-in (§3.8.1); offboarding offers and proposals (§3A.6); two-token linking (§3A.7, §11.3); two-person rule via proposals (§3.10, §11.3, §18.7); frozen tier (§3.5); unlimited ledger rows (§3.9); `needs_mapping` bookable (§7.4); Phase 1 façade (§15). template retire (G-19) in the §6.8 impact table |


## 16.5 Third-review findings addressed (v3.0)

The review is committed at `docs/reviews/review-3.md`, and the triage, change log and traces are at `docs/reviews/v3-revision.md`. The product owner confirmed the yoga-only scope (D-25) in this round. Every other decision from that review is marked **Assumed, not confirmed** above.

| Finding | Where it is fixed |
|---|---|
| H-01 mixed-mode studio cancel | §3A.1 C4, §3A.2, §3A.9.4, §7.6, §7.13, §8.6 step 7, §15 Phase 3, A.4, `a4_…` Phase 3 variants, D-44, A-15 |
| H-02 Dumbo desk lanes | §4.6, §6.3 `COVERAGE_UNCOVERABLE`, §4b.1, §15 Phase 0, D-45, Q-17 |
| H-03 scoped rest | §4.11 `min_rest.from/to`, §8.3, §4b.1 `desk_rest`, §6.3, D-46 |
| H-04 broken fixtures | `a5_…` order 2, `a4_…` busy variant, A.4, A.5 |
| H-05 shifts shadow | §18.2, §18.7 disagreement table, §18.9, §15 Phase 1, D-47 |
| H-06 substitute accept | §3A.14, §8.6, §10.4, §11.3, §12.4, D-57 |
| H-07 lifecycles | **§3A** (new section) |
| H-08 hours | §3A.16, §3.10, §11.3 `PATCH /hours`, §18.8.1, D-54, D-55 |
| H-09 late refund | §4.8 `refund.late`, §7.6, §3A.12.7, §9.6, D-48 |
| H-10 session edits | §3A.9.2–§3A.9.3, §11.3, D-49 |
| H-11 waitlist end states | §3A.13, §3.8 `end_reason` |
| H-12 mode transitions | §3A.18, §18.7, D-53, D-60 |
| H-13 workflow scope | §9.2 domains, §9.3, §4.12 `scope`, §4b.1, D-51 |
| H-14 endpoints | §11.2 `me` and preview, §11.3, §18.4 |
| H-15 notifications via workflows | §3A (Notify rows), §9.2 required notices, §6.3 `NOTICE_MISSING`, §4b.1 workflows |
| H-16 – H-28 (minor) | Sick call (§3A.11, D-52); move (§3A.12.9, D-50); approval at start (§7.8, D-58); counters (§12.5); `booked_via` (§5.3, §4b.1); offer storage and `lapsed` (§3.8, §12.4); 6 h boundary (§8.6); layers (§6.3); glossary (§2); partition reservation (§7.7, D-59); shift mapping (§18.5); Phase 3 hooks and Phase 1 scope (§15); `kind` for payroll (§14.1, D-56) |
