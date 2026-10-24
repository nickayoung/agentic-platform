# Appendix A. Acceptance-test walkthrough

This appendix checks the spec against the acceptance test. It uses only the schema (§4), the example configs (§4b, §18.2) and the engine behaviour in §7–§9 and §12. Where a step relies on a mechanism, the section is cited.

## A.1 Boutique spin studio, expressed only through the schema (§4b.2)

| Business requirement | Schema element | Engine mechanism (generic) |
|---|---|---|
| One room, 40 bikes in 4 rows | `resources[room_a]` + `layouts[room_a_bikes]` with `generate` | Layout expansion into spot resources (§4.15); places materialised per session (§7.3) |
| Riders pick a bike | `capacity.mode: mixed`, `base: assigned`, `requirement: room` with `provides_layout` | Place selection (§7.3); `place_claim` primary key (§12.4) |
| Front row reserved for unlimited members until 24 h before | `partitions[front_row_unlimited]`: `spots.tags_any`, `eligible_if`, `release` | Partition eligibility; release timer and relabelling (§7.3) |
| 45-minute classes on a weekly timetable | `templates[spin_45]`, `timetable[*]` with RRULE | Materialiser (§3.6 I-11; DST §7.10) |
| Instructors assigned by roster; Saturday fixed to Maya | `requirements[instructor].assign: roster`; `timetable[sat_0900].fixed.instructor: "@staff:maya"` | Solver (§8.4), validator (§8.6) |
| Instructor buffers; room turnover | `buffers` on requirements | Widened claims in occupancy (§12.3) |
| Credits, unlimited membership, drop-in price, first-ride price | `cost.units`, `cost.price`, `price_rules`; `entitlement_products` | Entitlement selection (§7.4.1) |
| Booking opens 7 days ahead at noon | `booking_window.opens: { before_start: 7d, at_local: "12:00" }` | Calendar offsets (§7.10) |
| Free cancel until 12 h; then forfeit, plus a $15 fee for members, waived if the bike is re-sold | `cancellation.late` with `fee_if`, `waive_if: booking.place_refilled`, `assess_at: session_start` | Penalty assessment (§7.6) |
| No-show fee and strike | `cancellation.no_show` | No-show timer (§7.6) |
| Max 2 rides per day; 6 upcoming for non-unlimited | `limits` | `limit_counter` CHECK (§12.5) |
| Waitlist: auto-promote until 2 h, then offers until 10 min | `waitlist.schedule` | §7.7 |
| Cancel if fewer than 3 at T−2 h | `min_attendance` | Built-in (§7.1) + notification workflow |
| Instructor rules and fairness | `constraints` (max 3 a day, rest, fairness, continuity, preferences) | CP-SAT mapping (§8.4) |
| Substitute on drop-out | `workflows[sub_finder]` → `invoke_hook` | H3 (§10.4) |

Nothing in this list needs code specific to spin studios.

## A.2 Big-box gym: classes and PT sharing rooms and instructors (§4b.3)

**What is shared:**

- **Coaches** are person resources with role `coach`. The same person can match `hiit_45.coach` (skill `group_fitness`, assigned by roster) and `pt_60.trainer` (skill `personal_training`, chosen by the customer).
- **Studio A** is tagged both `group` (classes, claimed `exclusive`) and `pt_capable` (PT, claimed `lane`; its concurrency is 1). The PT zone has 4 lanes.

**Worked case: Tuesday.** Coach Marco has `group_fitness` and `personal_training`. The roster assigned him to HIIT 18:00 in Studio A.

1. When HIIT is staffed, two claims are written:
   - Marco 17:50–18:50: 45-minute class, 10-minute before buffer, 5-minute after buffer.
   - Studio A 18:00–19:00: 15-minute turnover.
2. A member searches PT with Marco, Tuesday 16:00–20:00 (§7.2.3, 30-minute step, 60-minute session plus 10-minute after buffer):

   | Start | Marco needs | Marco free? | Rest ≥ 10 min (`coach_rest`) | Space | Offered |
   |---|---|---|---|---|---|
   | 16:00 | 16:00–17:10 | ✓ | ✓ (gap to 17:50 is 40) | PT zone lane | ✓ |
   | 16:30 | 16:30–17:40 | ✓ | ✓ (gap 10) | PT zone lane | ✓ |
   | 17:00 | 17:00–18:10 | ✗ overlaps 17:50 | — | — | ✗ |
   | 17:30, 18:00, 18:30 | … | ✗ | — | — | ✗ |
   | 19:00 | 19:00–20:10 | ✓ (free from 18:50) | ✓ (gap 10) | PT zone lane (ranked first); Studio A also free | ✓ |

3. **The PT zone is full at 14:00** (4 lanes taken). A PT booking at 14:00 gets Studio A's only lane through `select: tags_any [pt_capable]` and the `rank` expression. If a manager then tries to add a one-off class in Studio A at 14:00, the exclusive occupancy insert hits the PT claim's row, and the batch aborts with `RESOURCE_CONFLICT`.
4. **Rostering respects PT:** when coaches are next rostered, Marco's PT bookings are `fixed_busy` in the IR (§8.3), so the solver cannot give him a class that overlaps a PT client. The soft `protect_pt` constraint also steers classes away from his preferred PT hours.
5. **Open floor:** hourly open-gym sessions use pooled capacity with a walk-in partition and `occupancy: none` on the floor, so classes and PT never compete with them for resource time.
6. **Cycle 45:** assigned bikes, with a Premium row released 24 h before. This is the same mechanism as the spin studio.

All of this comes from the same primitives as the spin studio. The engine never reads `kind`.

## A.3 Spot-hold race

Covered step by step in §7.5.3. In summary:

1. Two riders hold Bike 12 at the same instant.
2. The SessionGate orders the requests. The first batch's upsert-and-assert wins.
3. The second gets `409 PLACE_TAKEN`, with equivalent free bikes as alternatives.
4. With the gate down, SQLite's single-writer batches give the same result.
5. An abandoned hold is released by an alarm, or overwritten in place after expiry if the alarm is lost.
6. A late confirm gets one transparent re-hold attempt, or `HOLD_EXPIRED` with the payment authorisation voided.

Tests: §14.1 "Concurrency tests".

## A.4 Late cancellation with waitlist promotion

Covered as a timeline in §9.6:

1. Cara's late cancel frees Bike 7. The front-row partition had already been released, so Bike 7 is now `general`.
2. The waitlist is in `auto_promote` mode, so Dana (#1, a pack holder, preferring Bike 7) is booked onto Bike 7 in the same SessionGate turn, and her credit is reserved.
3. At session start, Cara's penalty assessment sees `place_refilled = true`, so the $15 fee is waived. Variants: no refill → charged; pack → credit released when waived; after 16:30 → offers; Dana's own late cancel → both charged if not refilled.

Scenario test: §14.1.

## A.5 Instructor sick call (spin studio, §4b.2; the same flow applies to the gym and the reference tenant)

Instructor Jamie is rostered for Tue 18:30 Spin 45. Candidates with `spin_cert`: Maya, Leo, Ana and Sam.

| Time | Event | Detail |
|---|---|---|
| 13:00:00 | Jamie submits `POST /time-off { reason: sick, immediate: true, start: 13:00, end: 23:59 }` in the phone app | One batch: time off recorded; assignment `released`; claim released (occupancy rows deleted); session → `needs_staff`; `assignment.vacated` emitted; audit (§8.7 step 1). The 40 riders keep their bookings |
| 13:00:01 | Workflow `sub_finder` | `invoke_hook substitute_finder { session_id, deadline: 16:30 }` (start − 2 h) |
| 13:00:02 | Hook → `GET /sessions/{id}/substitutes?requirement=instructor` | The validator (§8.6) excludes Sam (`OUTSIDE_AVAILABILITY`, time off). Ranked by soft score: **Leo** (fewest minutes this week, no preference conflict), **Maya** (has taught this slot 14 times; continuity), **Ana** (marked the evening as `avoid`) |
| 13:00:03 | Offers to the top 3 in parallel (urgent) via `send_offer` → notification service | Expiry 13:30; the quiet-hours check passes |
| 13:06 | Maya replies "yes, happy to" | Interpreted as accept → `Proposal{assign Maya}` → validated at once (passes) → manager notified; Leo's and Ana's offers withdrawn ("filled, thanks") |
| 13:20 | Manager approves in the staff portal | Commit re-validates (I-27). The batch inserts Maya's claim 18:20–19:25 (with buffers) and bumps `resource_day` versions → assignment `confirmed`; session → `scheduled`; `assignment.confirmed` |

**Variants:**

- *Maya was assigned elsewhere between 13:06 and 13:20* (for example a manager added her to a 18:00 class): the commit's occupancy insert or validator fails with `RESOURCE_CONFLICT`. The proposal goes to `failed`, and the hook continues with Leo (and Ana if needed).
- *No acceptance by 16:30:* the hook ends `deadline_passed`, a manager task is created, and `custom.substitute_exhausted` is emitted. The tenant's workflow (for example cancel with refund, as in §18.2) runs.
- *Jamie is out all week:* more than 3 vacated slots → a `repair` solve with stability weighting proposes one coherent set of substitutions (§8.7 step 7).
- *Classes domain mirrored* (reference tenant, phases 1–2): the approved commit is a write-through instructor change to BookingVendor. The mirrored claim is updated from the response.

## A.6 Mirror classes + owner desk shifts at the same time, without double-booking a person

**Configuration in force:** reference tenant, phase 1 (§18.9). `classes = mirror` (BookingVendor), `shifts = owner`.

**1. Mirrored class arrives.** BookingVendor emits `class.updated` for Tue 09:00 Vinyasa 60 at Park Slope, instructor = Priya (staff key `priya`). `kairos-sync` maps it (`VIN60` → `vinyasa_60`, room → `ps_studio_1`) and calls `kairos-core` `POST /internal/mirror/apply`. One batch:
- upserts the session (`source = mirror`) and the `external_ref`;
- upserts an assignment for requirement `instructor` → Priya;
- writes **claim C1** on Priya's resource: 08:50–10:10 (10-minute buffers from the template), `source = mirror`, `domain = classes`, with occupancy rows for grains 08:50–10:10 at lane 0. This uses `ON CONFLICT DO NOTHING`, and all rows insert because nothing else holds that time.

**2. Manager tries to roster Priya on the desk.** In the staff portal, the manager drags Priya onto Park Slope *Desk – opening* Tue 06:15–12:45.
- The portal sends `POST /assignments { session: desk_open@Tue, requirement: worker, resource: priya }`.
- **Staleness guard (§18.6):** a targeted pull of Priya's Tuesday classes from BookingVendor confirms C1 is current.
- **Validator (§8.6):** occupancy for Priya on Tuesday shows C1 overlapping 06:15–12:45 → `RESOURCE_CONFLICT`.
- **Response:** `409` with `reasons: [{ code: RESOURCE_CONFLICT, facts: { person: "Priya", conflict: "Vinyasa 60, 09:00–10:00, Park Slope", source: "BookingVendor" } }]`. The portal shows the message.

**3. Database backstop.** Suppose a bug skipped the validator. The commit batch's exclusive occupancy insert for Priya, 06:15–12:45, collides with C1's row at `(priya, grain(08:50), 0)`. That is a primary-key violation, so the batch aborts, and nothing is written.

**4. Solver path.** `POST /rosters/solve { scope: { roles: [desk] } }` builds the IR with C1 as `fixed_busy` for Priya. `AddNoOverlap` makes any overlapping desk shift impossible. The solver assigns someone else, or assigns Priya only to shifts that don't touch 08:50–10:10 (for example *Desk – closing* from 12:45). `min_rest` and transfer rules are applied against C1 as well.

**5. Reverse order (outside system creates the conflict).** Priya is already on a published desk shift 12:45–21:15 (claim D1, owned). BookingVendor then assigns her to a 17:00 class:
- Mirror ingestion cannot take grains 16:50–18:10 (held by D1), so the new claim C2 is stored `conflicted`, taking every free grain (none here). Each grain is therefore blocked either by D1 or by C2's own rows.
- A `cross_domain_conflict` drift item is raised, and the `cross_domain_alert` workflow notifies managers and creates a task.
- Kairos does not refuse the outside record, because BookingVendor is the record for classes. But no new Kairos claim can use that time. The desk app shows the conflict on today's board.
- When the manager resolves it, for example by moving Priya's desk shift through a proposal, D1's release batch re-homes C2's missing grains and sets C2 to `active` (§12.3).

**Result:** in both orders, the engine never *creates* a state where one person works the desk during a class they teach. When the outside system creates such a state itself, Kairos detects it within the ingestion latency (p95 ≤ 2 min) and escalates it. This holds while classes are mirrored and desk shifts are owned, because both domains write to the same `occupancy` table in the same tenant database (I-17, D-05, D-06).
