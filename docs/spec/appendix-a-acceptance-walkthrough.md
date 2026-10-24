# Appendix A. Acceptance-test walkthrough (yoga scope)

These checks use only the schema (§4), the reference config (§4b.1) and the engine behaviour in §7–§9 and §12. Each trace is backed by a scenario suite (§14.1).

## A.1 The reference tenant, expressed only through the schema

| Requirement | Schema element | Generic mechanism |
|---|---|---|
| Three studios, one zone | `locations` with `timezone` | §7.10 |
| Mat maps (rows of 6, wall mats, front row) | `layouts` with `generate` and `overrides`; `resources[].layout` | Expanded into spot resources (§4.15); places per session (§7.3) |
| Dumbo with no map | `pooled_from_space`; `tags: [no_map]`; Vinyasa selector `where` excludes `no_map` | §7.3 |
| Heated room only for Hot 75, certified teachers | `select.tags_all: [heated]`, `skills_all: [hot_cert]` | Validator (§8.5) |
| Unlimited-only front row until 24 h before; walk-in mats until 2 h before | `mixed` partitions with `eligible_if`, `online`, `release` | §7.3 |
| Prenatal capped at 12, intake | `pooled: 12`; `intake.form`; PII custom fields | §7.4 step 10 |
| First-time hot waiver | `intake.when: customer.history.tags['hot'].completed == 0` | §5.3 history map |
| Booking opens 14 days ahead at noon | `opens: { before_start: 14d, at_local: "12:00" }` | Calendar offsets |
| Late and no-show rules with membership fee and refill waiver | `cancellation.late` / `no_show` with `fee_if` and `waive_if` | §7.6 |
| Refunds | `refund: { timely: full, studio_cancel: full }` | §7.6 |
| Limits; minimum attendance; unstaffed | `limits`, `min_attendance`, `unstaffed` | Built-in timers (§7.1) |
| Waitlist auto, then offers | `waitlist.schedule` | §7.7 |
| Unlimited (freeze), 10-pack, intro month (first use) | `entitlement_products` | §7.4.1, §3A.7 |
| Desk shifts and coverage, with handover overlap | `kind: shift`, `participants: none`, `rostered`, `coverage`; 2-lane desks | CP-SAT (§8.3); lane-aware `COVERAGE_UNCOVERABLE` (§6.3) |
| Labour and teaching rules, including "10 h between a closing and the next opening" | `constraints`; `desk_rest` uses `min_rest.from: closing`, `to: opening` | §8.3, §8.5 |
| Late-cancel refunds for drop-ins | `refund.late: none` | §7.6 |
| Substitute search, member and staff notices | `workflows`, default `scope: owned` | §9, §3A |

No business-specific code is involved. The engines never read `kind` (lint, §14.1). A script that runs the lane-aware coverage check over every studio and weekday of §4b.1 finds every interval coverable with 2-lane desks, and finds Dumbo uncoverable with 1 lane, which is why D-45 sets 2 lanes; the tenant confirmed two people can work that desk.

## A.2 Mat-hold race: **Pass**

This trace needs `bookings = owner` (Phase 4 onwards). In Phases 1–3, mat holds are advisory and BookingVendor's answer is final (§7.12). The concurrency tests in §14.1 still run this trace against the native engine from Phase 2.

Two members tap Mat 12 (row 2, a wall mat, `general` partition) for Tue 07:00 Vinyasa in Park Slope Studio 1, within the same 50 ms.

1. **Store and constraint.** The place claim is stored in the tenant DB table `place_claim`, whose `PRIMARY KEY (session_id, place_id)` admits one claimant. The SessionGate for this class orders the two requests.
2. **Member A.** A's batch upserts the place claim with `expires_at = now + 5m` (`hold_ttl`). Its scalar assert `holder_id = A` evaluates to 1. A gets `201` with the hold and the quote.
3. **Member B.** B's upsert `WHERE` is false because A's hold is live, so nothing changes. B's scalar assert evaluates to 0, the `CHECK (ok = 1)` fails, and the whole batch rolls back. B gets `409 PLACE_TAKEN` with alternatives `[Mat 18, Mat 24]` (equal attributes, nearest first).
4. **Gate down.** Single-writer SQLite gives the same result.
5. **A abandons.** At 5 minutes the alarm deletes the claim, marks the hold `expired`, and emits `place.released`. If a waitlist exists, §7.7 applies: the mat is reserved for the waitlist. If the alarm is lost, the 1-minute sweep or the next upsert reclaims the mat.
6. **A confirms late.** The guard fails. The engine tries one transparent re-hold. If that fails, A gets `409 HOLD_EXPIRED` and the payment authorisation is voided through the outbox.

## A.3 Late cancellation with waitlist promotion: **Pass**

The full timeline is in §9.6.

- **Penalty.** The penalty is deferred to session start. It is waived if `place_refilled` is true. Otherwise, depending on what the late canceller paid with: credit forfeited (pack) and/or a $10 fee (membership), charged through the gateway.
- **Promotion order.** The freed mat is reserved for the waitlist in the same batch that frees it. A new member's hold on it fails. Promotion then goes by position, honouring mat preferences.
- **Promoted member.** In `auto_promote` mode there is no hold: the member is booked directly and their credit is reserved. In `offer_all` mode, `POST /offers/{id}/accept` creates the hold in the same batch. The offer moves to `accepted` with `hold_id` set, so the hold assert passes. The hold expires at `min(now + 5m, offer.expires_at + 5m)`, and the member confirms with `POST /bookings`.
- **Gate down.** Every freeing path runs `release_place`, so the mat is still reserved for the waitlist. The promotion sweep promotes within about 90 s (§7.7).
- **Mode.** All of this is built-in behaviour that needs `bookings = owner` (§7.13), so the trace applies from Phase 4. Before that, BookingVendor runs its own waitlist and Kairos dry-runs this logic in shadow mode.
- **Promoted member has no credits.** They are `skipped` (`INSUFFICIENT_UNITS`), `skipped_notice` emails them, and the next member is promoted. If nobody is eligible, the reservation is cleared.
- **Price-paid canceller.** No units and no fee. `refund.late: none`, so no refund even when refilled; `booking.penalty_assessed{waived: true, refund: none}` (D-48).
- **Front row before release.** The place is reserved only because an unlimited member (Eli) is waiting, and Eli is promoted while Dana keeps her position (D-59).
- **Notifications.** The `promoted_notice`, `offer_notice` and `skipped_notice` workflows call the notification service through the outbox, keyed by idempotency key.

## A.4 Instructor sick call: **Pass**

Maya is rostered for Tue 18:00 Hot 75 at Park Slope. At 12:00 she submits a sick call in the phone app.

| Time | Step | Detail |
|---|---|---|
| 12:00:00 | `POST /time-off {sick, immediate}` | One batch releases Maya's assignment and claim, sets the session to `needs_staff`, and emits `assignment.vacated`. Members keep their bookings. |
| 12:00:01 | `sub_finder` workflow → H3 | Deadline = 18:00 − 2 h = 16:00. The unstaffed check is at 16:30 |
| 12:00:02 | **Candidate query** `GET /sessions/{id}/substitutes?requirement=teacher` | The validator keeps only `teacher` people with an unexpired `hot_cert` who are available, have no overlapping claim in any domain (including desk shifts and mirrored classes), and satisfy `teach_rest`, `teach_day` and transfer time. Ranked: Leo (fewest minutes this week), Ana (has taught this slot 9 times), Ravi |
| 12:00:03 | **Outreach** `POST /offers` ×3, in rank order, at once | `start − now = 6h ≤ 6h`, so each offer expires at 12:10 (D-33). Each `offer.sent` triggers `substitute_offer_notice`, which texts the teacher through the notification service. No quiet hours apply. |
| 12:10 | All three offers expire | The next wave fetches candidates again. None are left, so the run ends `exhausted` and emits `custom.substitute_exhausted`. A manager task is created. |
| *(Alternative)* 12:04 | Ana taps Accept (`POST /offers/{id}/accept`) | One engine batch: offer → `accepted`, a `Proposal` is created and validated, and Leo's and Ravi's offers → `withdrawn` (they get `substitute_filled_notice`). If Leo taps Accept in the same instant, the unique index gives him `409 OFFER_FILLED` (D-57). The proposal `expires_at` is 14:04 (`min(start − 30m, now + 2h)`); `approval_needed` tells the managers. |
| *(Alternative)* 12:15 | Manager approves | Re-validation passes (with the `resource_day` guards and a scalar assert). Ana's claim and hours record are written, the session returns to `scheduled`, and `sub_assigned_notice` notifies members. If Ana (who also has the `desk_staff` role in that variant) was given the 16:00 desk shift before approval, the commit fails with `RESOURCE_CONFLICT`, the proposal → `failed`, her offer → `lapsed`, and outreach continues. |
| *(Alternative)* 15:50–15:58 | A manager sends Ravi an offer at 15:50; he accepts at 15:58 | The proposal (expires 17:30) is pending at 16:30, so the check is deferred once to `min(17:30, 17:30)` = 17:30, and `proposal.urgent` triggers `approval_urgent` (SMS and staff chat). If it is approved before 17:30, the class runs. |
| 16:30 | **Unstaffed check** (built-in, `unstaffed.check_at: 90m`) | The slot is empty and no proposal is pending, so the class is cancelled with `reason: no_staff`. **Members:** every booking is cancelled, credits are released, price-paid bookings get full refunds through the gateway, waitlist entries expire, and `no_sub_notice` texts everyone. |

The table above is the trace with **every domain owned** (Phase 4 onwards for the member effects).

**Phase 3 (`classes = owner`, `bookings = shadow`).** Everything up to 16:30 is identical. At 16:30 the unstaffed check cancels the session in Kairos (claims released, Maya's voided hours stay voided, timers cancelled) and pushes `cancel` to BookingVendor with key `cancel:{session}` (§3A.9.4, D-44). Kairos writes no booking, ledger, refund or member-notify rows: `no_sub_notice` resolves to nobody because bookings aren't owned (D-51). BookingVendor cancels the 20 bookings and refunds the 4 drop-ins (confirmed, D-44), and texts members (A-15), and its cancellations are mirrored back. Shadow compares that outcome with Kairos's dry-run studio cancel. If the push fails 3 times (by about 16:40), `push_failed` drift raises the urgent manager task and the staff-chat page.

**Phases 1–2 (`classes = mirror`).** Maya's sick call vacates only her owned desk shifts. Cover for her class is arranged in BookingVendor (§3A.2), and her mirrored class claim keeps blocking that time for desk assignments.

## A.5 Classes mirrored, desk shifts owned: **Pass**

Configuration: Phase 1, with `classes = mirror` and `shifts = owner`.

**Order 1: class known first.**

1. BookingVendor sends `class.updated` for Tue 09:00 Vinyasa at Park Slope, instructor `BV-1187`. `kairos-sync` dedupes the event and maps it: `VIN60` → `vinyasa_60`, room → `ps_studio_1`, and `person_mapping(booking_vendor, BV-1187)` → Priya (matched by email at onboarding).
2. It calls `POST /internal/mirror/apply`. One batch upserts the session, the assignment, and **claim C1** on Priya's resource for 08:50–10:10 (10-minute buffers), with `source = mirror`. Exclusive occupancy rows are written.
3. A manager drags Priya onto Park Slope *Desk – opening* (06:15–12:45). The portal calls `POST /assignments`.
4. The **staleness guard** pulls Priya's Tuesday from BookingVendor and finds C1 current.
5. The **validator** sees C1 overlapping and returns `409 RESOURCE_CONFLICT`, with facts `{person: Priya, conflict: "Vinyasa 60 09:00–10:00 Park Slope", source: BookingVendor}`.
6. **Backstop:** if the validator were bypassed, the occupancy insert would hit C1's row `(priya, grain(08:50), 0)`. The primary-key violation aborts the batch, and nothing is written.
7. **Solver:** C1 is in `fixed_busy`, so `AddNoOverlap` makes an overlapping desk shift impossible.

**Order 2: class arrives after the shift.**

1. Priya already has published desk shift D1 at Park Slope, 06:15–12:45, owned by Kairos.
2. BookingVendor then assigns her to the 09:00 class.
3. Ingestion inserts C2's grains with `ON CONFLICT DO NOTHING`. All of them are taken by D1, so C2 is stored as `conflicted`. The engine did not put Priya on the desk during her class; the outside system created the overlap, and Kairos does not refuse an outside record (I-18).
4. A `cross_domain_conflict` drift item and the `cross_domain_alert` workflow notify managers and create a task within 60 s. The desk app shows the conflict.
5. No new claim can use Priya's time 08:50–10:10: those grains are held by D1, and C2 keeps them reserved for itself.
6. The manager resolves it, typically with a proposal that moves Priya's desk shift. D1's release batch re-homes C2's grains, and C2 becomes `active`. D1 is not vacated automatically (D-34, Q-05).
7. While D1 stands, a further desk shift for Priya at 11:00 (11:00–15:00) is refused with `RESOURCE_CONFLICT`, because it overlaps D1 itself. A 16:00 desk shift is accepted: it overlaps neither D1 nor the class, and `desk_rest` applies only from a closing shift to an opening one (D-46).

**Order 3: teacher unmapped.**

1. `BV-2290` has no mapping, so the class is stored as `needs_mapping` and `unmapped_person` alerts managers.
2. A manager tries to put any person with the `teacher` role on a desk shift, at **any** studio, that overlaps the class ± the maximum transfer time (40 min). The validator refuses with `RESOURCE_CONFLICT` and the reason "unmapped teacher" (D-26). The solver never proposes such a shift, because the block is in the IR as `unmapped_blocks`. Desk staff who don't teach are unaffected.
3. After the mapping is fixed, the claim lands on the right person and the normal rules apply.

In every order, the refusal is enforced by the shared `occupancy` primary key and the shared validator, in the same tenant database, while the two domains are in different modes (I-17, D-05, D-06).
