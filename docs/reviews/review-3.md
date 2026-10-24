# Review 3 of the Kairos spec (v2.1 + Gusto CSV, commit 3b59747)

**Reviewer role:** principal engineer · **Scope:** `docs/spec/`, `fixtures/`, `evals/` on `main` · **Date:** 2026-10-24

The text of the two earlier reviews (F-series, G-series) was never committed. Their IDs survive only in §16.3–16.4. This review starts the **H-series**. Severity: **B** = Blocker (an acceptance trace fails, or the spec contradicts itself in a way an engineer can't resolve), **M** = Major (a behaviour is undefined or ambiguous enough that two engineers would build different things), **m** = Minor.

Scope is yoga-only (D-25). The product owner confirmed this in this review round.

## 1. Findings

| ID | Sev. | Section(s) | Finding | Recommended fix |
|---|---|---|---|---|
| H-01 | B | §7.1, §7.6, §7.13, §8.6 step 7, §15 Phase 3, §18.5.1, §18.9, A.4 | **Studio cancel in mixed modes is contradictory.** In Phase 3, `classes = owner` and `bookings = shadow`. §8.6 step 7, A.4 and Phase 3 acceptance #1 say Kairos's unstaffed check cancels the class, "refunds members and notifies them". But §7.13 says refunds and booking writes need `bookings = owner`, and in shadow nothing is written. Nothing says who cancels the bookings, who refunds, who notifies members, or what happens if the push to BookingVendor fails. The same gap applies to minimum attendance, closures and staff cancels | Define one rule for a session cancel when the bookings domain isn't owned. Kairos cancels the session, pushes the cancel to BookingVendor, and BookingVendor cancels, refunds and notifies. Kairos mirrors the results. A failed push escalates to an urgent manager task |
| H-02 | B | §4b.1, §6.3 `COVERAGE_UNCOVERABLE`, §15 Phase 0 #1 | **The reference config is infeasible at Dumbo.** `db_desk` has `concurrency: 1`. But Dumbo's `desk_open` (07:00–13:30) and `desk_close` (12:00–20:30) overlap, and so do the Saturday open and mid shifts. Hard coverage of 07:00–20:30 can't be met with one lane, so every Dumbo roster solve returns INFEASIBLE. `COVERAGE_UNCOVERABLE` ignores lanes, so the "real validator in CI" passes an unsolvable fixture | Make `COVERAGE_UNCOVERABLE` lane-aware. Fix the Dumbo desk lanes (placeholder; ask the tenant) |
| H-03 | B | §4.11 `min_rest`, §4b.1 `desk_rest`, Y-REF-01 | **`min_rest` can't express "10 h between a closing and the next opening".** `desk_rest` applies `min_rest: 10h` between **any** two claims of a desk-staff person. That forbids desk-open plus desk-close at another studio on different days less than 10 h apart (intended), but also an opening shift followed by teaching an evening class, and a mid shift after a class. The owner's rule (Y-REF-01) can't be expressed, so acceptance item 1 (expressible through the schema) fails | Add optional `from`/`to` template-tag scopes to `min_rest`. Express `desk_rest` as closing → opening |
| H-04 | B | `fixtures/scenarios/lotus_line/a5_…`, `a4_…`, A.4, A.5 | **Two acceptance fixtures can't pass.** (a) A.5 order 2 expects `201` for Priya's `desk_mid` 11:00–15:00 on a day she already works `desk_open` 06:15–12:45. That overlaps her own shift, so it must be `409 RESOURCE_CONFLICT` (and `desk_rest` would refuse it too). (b) A.4 "substitute became busy" assigns Ana, who only has the `teacher` role, to `desk_mid`. The selector refuses with `ROLE_MISSING`, so the proposal never reaches `RESOURCE_CONFLICT` | Fix both variants and make them reach the behaviour they claim to test |
| H-05 | M | §18.7, §18.9, §15 Phase 1 | **The shifts cutover skips shadow.** §18.7 requires mirror → shadow (drift < 0.5 % for 7 days) → owner (disagreement < 0.2 % for 14 days). §18.9 puts shifts straight into owner at Phase 1 with no gate. Phase 1 acceptance #4 also needs a "60-day parallel run" inside an 8-week phase | Add a shifts shadow stage with a defined disagreement metric. Move the 60-day check to the ShiftTool retirement gate (Phase 3) |
| H-06 | M | §8.6 step 4, §10.4 step 3, §12.4 | **Concurrent substitute accepts.** Three offers go out at once (D-33). Both the engine (§8.6 "a Proposal is created") and H3 (§10.4 "create the proposal") claim to create the proposal, and no database guard stops two accepted offers from producing two proposals for one slot. What happens to an accepted offer whose proposal later fails or expires is also undefined | The engine creates the proposal in the accept batch. Add a unique index (one accepted offer per slot) and a terminal `lapsed` state. Remove `create_proposal` from H3 |
| H-07 | M | §3.12 and scattered | **The lifecycle rules are incomplete and scattered.** Class sessions, desk shifts, holds, bookings, waitlist entries, offers, proposals, entitlements, hours, config versions and domain modes have no lifecycle rules, or only partial ones. Very few events say what happens when a step fails partway, who is notified, or what is audited. See the matrix in §2 | Add one normative "Lifecycles" section with a fixed card per event |
| H-08 | M | §3.10, §18.8.1 | **Hours-record gaps.** It's undefined whether a vacated, retimed or substituted assignment's record is voided, updated or replaced. §18.8.1 creates teaching records for mirrored classes, but D-36 says teaching hours are exported only from the classes cutover. Studio-cancel pay (`closure_pay_notice`) applies to closures only, and there's no manager endpoint to void or adjust a record | Hours lifecycle card, one rule per assignment event, plus `PATCH /hours/{id}` |
| H-09 | M | §4.8 `RefundRules`, §7.6 | **Late cancel of a price-paid booking.** Refund rules cover only timely and studio cancels. §7.6 says a waived penalty "writes a `release` row", which has no meaning for a price payment. Whether a refilled drop-in late cancel is refunded is undefined | Add `refund.late` (`none` \| `as_timely_if_refilled`), snapshot it, and define the waiver for price payments |
| H-10 | M | §4.7 "This one", §11.3 `PATCH /sessions/{id}` | **Runtime session edits.** Retiming, changing the room or changing the capacity of a booked class have no defined effect on bookings (terms, overlap, re-seating, free cancellation), holds, waitlists, timers, hours, notifications or outside systems. §6.8 covers config changes only | A session-change lifecycle card with a `preview` impact response |
| H-11 | M | §3.8, §7.7 | **Waitlist and place-offer end states.** No rule says what happens to waiting entries and open place offers when the session is cancelled or retimed, or when the member is suspended, closed or merged, or their entitlement lapses. `waitlist.expired` exists only for `closed` mode | End-state rules and an `end_reason` field |
| H-12 | M | §7.13, §18.7 | **In-flight items at domain-mode transitions.** Undefined: active holds and outside waitlists at the bookings cutover; penalties for late cancels that happened before cutover but are assessed after; terms for imported bookings; adoption of mirrored future sessions into timetable series at the classes cutover; Kairos waitlists, offers, proposals and pending penalty jobs on rollback | A transition card per direction, with an in-flight table |
| H-13 | M | §9, §4b.1 workflows | **Workflows act on mirrored records.** §7.13 limits built-in behaviour to owned domains, but workflows aren't limited. `class_reminder` and `no_sub_notice` would text members about BookingVendor classes in Phase 1 and duplicate BookingVendor's own messages | Give events a `domain`. Workflows default to `scope: owned`, and member recipients resolve only when the system that holds the bookings is Kairos |
| H-14 | M | §11.3, §18.4 | **Front-end endpoints missing or inconsistent.** The `me` alias in `/resources/me/availability` and `GET /assignments?resource_id=me` is undefined. Members can't list their waitlist entries, and the desk can't see a session's waitlist. There's no way to cancel a membership, no way to adjust or void hours, and no swap rejection. `?preview=true` (§18.4) conflicts with the `preview` body field (§11.3) | Add the endpoints and define aliases. One preview convention |
| H-15 | M | §3.12.3, §3.12.4, §8.6 | **Notifications with no event or workflow.** Several notifications are stated but not routed through workflows: re-seat "members are notified", "first assignment sends a welcome notification", "approvers get an urgent notification", substitute offers "delivered through the notification service". The brief requires workflow actions to call the notification service | Each becomes an event and a reference workflow. Add a validation warning for required events with no workflow |
| H-16 | m | §3.5 `TimeOff`, §8.6 | Sick-call state is undefined (an `immediate` request in `requested`?). It's unclear whether a manager can reject a sick call after the vacate. Approving planned time off has no stated effect on assignments | Define the states and the approval effect |
| H-17 | m | §3.8.1 "moved" | A move is "a timely cancellation of the old one" even inside the late window, so moving bypasses late penalties | Allow moves only before `free_cancel_until` |
| H-18 | m | §7.8 | A booking awaiting approval at session start (timeout 4 h may run past start) is undefined | Reject at start at the latest |
| H-19 | m | §12.5 | When the `upcoming` limit counter is decremented is undefined | Decrement on leaving an active state and at session start |
| H-20 | m | §5.3, §9.2, §4b.1 | CEL `booking.channel` vs entity field `booked_via`: two names for one fact | One name: `booked_via` |
| H-21 | m | §3.8 `Offer`, §12.4 | `Offer.recipient` vs `offer.customer_id`/`resource_id` columns is unstated. `kind: place` offers have no "one open per entry" guard | State the mapping; add the index |
| H-22 | m | D-33, A.4 | "If the class starts within 6 h" is ambiguous at exactly 6 h, and A.4 sits exactly on the boundary | `start − now ≤ 6h` |
| H-23 | m | §6.3 | Validation layers skip L6 (L5 then L7) | Renumber |
| H-24 | m | §2 | The glossary lacks impact plan, dry run, write freeze, staleness guard, unstaffed check, hours record, workflow run, outbox and `release_place` | Add the terms |
| H-25 | m | §7.7 | A freed place in an unreleased partition (front row) is reserved for a waitlist none of whose members can be eligible. That blocks eligible members until promotion clears it | Reserve only if some waiting entry is eligible for the place's partition |
| H-26 | m | §18.5 | ShiftTool shifts have no mapping to desk templates, so shadow comparison and drift hashing have nothing to compare against | Map by studio + local start + duration, with `unmapped` fallback |
| H-27 | m | §15 | Phase 3 needs the `invoke_hook` action and H3 hosting, which no phase lists. Phase 1 needs the workflow `scope` rule | Add them to scope |
| H-28 | m | §3.10 `HoursRecord.kind`, principle 4 | Hours `kind` is derived from `template.kind`, which the lint forbids engines to read. The spec doesn't say the export package is the allowed exception | State it: label use in `packages/export` only, and the lint whitelists it |

## 2. Lifecycle matrix (v2.1)

`C` = covered · `P` = partial · `–` = missing. Columns: create/start, change, end/cancel, effects on dependants, notifications, outside systems by mode, audit, failure and recovery.

| Entity | Create | Change | End | Dependants | Notify | Modes | Audit | Failure |
|---|---|---|---|---|---|---|---|---|
| Tenant | C | P | C | C | P | P | C | – |
| Studio | C | P | C | C | P | P | P | – |
| Room / mat | C | P | P | P | P | P | P | – |
| Staff member | C | P | C | C | P | C | P | – |
| Member | C | C | C | P | – | C | P | – |
| Agent client | C | P | C | – | – | n/a | P | – |
| Class session | P | – (runtime edits) | P (mixed modes) | P | P | P | – | – |
| Desk shift | P | – | P | P | P | P | – | P (saga) |
| Assignment / time off | P | P | P | P | P | P | – | – |
| Hold | C | – | C | C | – | P | P | C |
| Booking | C | P (move) | P (late price) | P | P | P | P | P |
| Waitlist entry | C | – | P | P | C | P | – | P |
| Place offer | C | – | P | P | C | P | – | P |
| Substitute offer + proposal | P | – | P (lapsed) | P | P | P | – | – |
| Entitlement | P | P | P | P | – | P | – | – |
| Hours record | P | – | P | – | – | P | – | – |
| Config version | C | C | C | C | – | P | C | P |
| Domain mode | C | C | C | – (in-flight) | – | C | C | P |

## 3. Acceptance traces against v2.1

| # | Trace | Result | Why |
|---|---|---|---|
| T1 | Reference tenant expressed through the schema only | **Fail** | The owner's close → open rest rule can't be expressed (H-03), and the Dumbo coverage is unsolvable (H-02) |
| T2 | Mat-hold race (A.2) | **Pass** | Place-claim PK, scalar assert, gate-down path all hold |
| T3 | Late cancel with waitlist promotion (A.3) | **Undefined** | Pass for the membership canceller in §9.6. Undefined for a price-paid canceller whose mat is refilled (H-09) and for a front-row place freed before release (H-25) |
| T4 | Instructor sick call (A.4) | **Fail** | Phase 3 member effects contradict §7.13 (H-01). The "became busy" variant can't happen (H-04b). Two simultaneous accepts make two proposals (H-06) |
| T5 | Mirrored classes + owned desk shifts (A.5) | **Fail** | The order-2 fixture expects a desk assignment that overlaps the person's own shift to succeed (H-04a) |

## 4. Decisions the spec must make

| # | Question | Reviewer's recommended answer |
|---|---|---|
| DQ-1 (H-01) | When Kairos cancels a class whose bookings it does not own, who cancels the bookings, refunds and notifies members? | BookingVendor. Kairos pushes the class cancel. BookingVendor applies its own cancel, refund and notice rules. Kairos mirrors the result, and escalates a failed push as an urgent manager task |
| DQ-2 (H-02) | How many people can work the Dumbo desk at once during a handover? | 2 lanes (handover overlap), pending tenant confirmation |
| DQ-3 (H-03) | Does the 10-hour rest apply between any two pieces of work, or only closing → opening? | Closing → opening only, as the owner's description says |
| DQ-4 (H-05) | Do desk shifts go through shadow before owner? | Yes: 14 days of shadow at the start of Phase 1, comparing ShiftTool's shifts with Kairos's validator and hours |
| DQ-5 (H-09) | Is a late cancel of a drop-in refunded if the mat is refilled? | No (`refund.late: none`). The owner only promised refunds for timely cancels |
| DQ-6 (H-10) | When staff retime a booked class or change its room, what happens to members' bookings? | Bookings are kept. Free cancellation is extended to the new start. Members are notified. A room with fewer mats re-seats, then cancels with a full refund, newest bookings first |
| DQ-7 (H-13) | Who sends member notices about records Kairos doesn't own? | The outside system that holds them. Kairos workflows don't message members about mirrored bookings |
| DQ-8 (H-17) | Can a member move a booking inside the late window? | No. They cancel (late) and book again |
| DQ-9 (H-16) | Can a manager reject a sick call? | No. They can cancel it. Vacated assignments are not restored automatically |
| DQ-10 (H-12) | What terms do bookings imported at the bookings cutover get? | The active policy at cutover. Parity is proven in shadow before the cutover |
| DQ-11 (H-08) | Are teaching hours recorded for mirrored classes? | No. Teaching hours records start at the classes cutover (D-36) |
| DQ-12 (H-08) | Are staff paid for a class or shift the studio cancels at short notice? | Yes, if it is cancelled less than `closure_pay_notice` before start, for any studio cancel, not only closures (Q-02) |
