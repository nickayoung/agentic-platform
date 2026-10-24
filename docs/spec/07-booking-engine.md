# 7. Booking engine

The booking engine is the TypeScript package `@kairos/engine`. It runs inside the `kairos-core` edge function, and inside the batch worker for simulation. It is a pure function of `(compiled config, data read through a storage port, request, clock)`. All writes go through the **guarded batch** primitive (§12.2). The engine never calls an LLM.

## 7.1 Responsibilities

| Operation | Endpoint (§11) | Summary |
|---|---|---|
| Timetable availability | `GET /sessions?…&include=availability` | Bookability and free places for scheduled sessions |
| Slot search | `POST /availability/search` | Free start times for on-demand and arrival-window templates |
| Spot map | `GET /sessions/{id}/places` | Places with state (free, held, booked, reserved for a partition) |
| Hold | `POST /holds` | Evaluate, quote, and claim a place or resource time for `hold_ttl` |
| Confirm | `POST /bookings` | Convert a hold into a booking, with payment |
| Cancel | `POST /bookings/{id}/cancel` | Timely or late cancellation, with penalties |
| Waitlist | `POST /sessions/{id}/waitlist` | Join, leave, accept an offer |
| Check-in / no-show | `POST /check-ins`, internal timer | Attendance and no-show penalties |
| Explain | `GET /decisions/{id}` | Decision trace |

**Built-in policy behaviour versus workflows.** Everything declared in a `PolicySet` is carried out by the engine itself: windows, limits, penalties and their deferred assessment, waitlist promotion, minimum-attendance cancellation, approval timeouts. Workflows (§9) add *extra* reactions to the resulting events, such as notifications, tasks or hooks. They never re-implement policy. So a waitlist never needs a workflow to promote it, and a duplicated workflow cannot promote twice.

## 7.2 Availability algorithm

### 7.2.1 Free-time model

For each resource *r* and each local day *d* in its zone, the engine builds two arrays over the 288 five-minute grains of that day. On DST days there are 276 or 300 grains, because grains are UTC-based.

- `avail_r,d`, a bitset: grains where *r* is available. For people, this is `AvailabilityRecord(available)` minus `unavailable` minus approved or immediate `TimeOff`. For structural resources, it is open rules minus closed rules, intersected with the location's opening hours (§4.10). A child resource's availability is also ANDed with its parent's, so a spot is only available when its room is open.
- `used_r,d`, a `Uint8Array`: the number of lanes occupied per grain, read from `occupancy` (one indexed range scan per resource-day).

A resource can host a new claim on grain *g* when:

- `exclusive`: `avail[g] && used[g] == 0`
- `lane`: `avail[g] && used[g] < concurrency`

An interval is free when every one of its grains is free. Bitsets are cached per request. For a 14-day search over 40 resources, that is 40 × 14 × 288 bits ≈ 20 KB, and the checks are word-wise ANDs.

### 7.2.2 Scheduled sessions (timetable and rostered templates)

A session is **bookable for customer C** when it passes the evaluation pipeline (§7.4) up to place selection. The timetable view batches this. It evaluates customer-independent checks once per session (status, window) and customer-dependent checks once per customer per request (eligibility, limits, payment), then joins the two. Free place counts come from `capacity_total − booked_count − active holds`, partitioned. The timetable is cached at the edge for anonymous users for 15 s, keyed by `(session, config_epoch)`. Free-place counts can be stale by up to that TTL, and holds are always authoritative.

### 7.2.3 On-demand slot search

Input: `{ template, location, from_date, to_date, resource_prefs?: { [requirement_key]: resource_id[] }, duration?, customer_id }`.

```
1. P ← customer-level checks (eligibility, limits, payment possibility); if any hard fail → return [] + reasons
2. starts ← for each local day in [from,to] ∩ [now+min_lead, now+horizon]:
              for each open interval of the location that day:
                 step through it by slot_step, aligned to local midnight
3. for each requirement R: cand[R] ← compiled_index(R.select) ∩ resource_prefs[R] (if given),
                                     filtered by selector.where (candidate slot)
4. for each start s (ascending):
     need[R] = [s − before_R, s + duration + after_R)          // buffers widen the occupied interval
     options[R] = { r ∈ cand[R] : free(r, need[R], R.occupancy) && person_rules_ok(r, s) }
     if a system of distinct representatives exists (each R gets count_R distinct resources,
        no resource used for two requirements)                  // bipartite matching, |R| ≤ 4
        → emit slot(s, default_pick = argmax rank per R, alternatives = |options[R]|)
5. return slots, paginated (default 50), with the default pick per requirement
```

`person_rules_ok` applies the hard constraints that depend on neighbouring claims: `min_rest`, `max_hours`, `max_assignments`, `transfer_time` and `allowed_hours` (§8.6 has the shared validator). Step 4 is O(starts × Σ|cand|) bitset checks. A typical physio search (14 days, 8 practitioners, 4 rooms) runs about 2,000 × 12 checks in well under 10 ms.

### 7.2.4 Arrival-window templates (field service)

A booking reserves a **window**, not a time. The invariant is:

> **I-31** At all times, for every technician-day there is a *planned route*: an ordered list of jobs with planned starts. Every booked job's arrival falls inside its window, travel times are respected, and every hard person rule holds.

A window *w* on day *d* is offered when the job can be inserted into at least one eligible technician's planned route. The insertion check tries each position, recomputes planned starts with time-window propagation (earliest start = max(window start, previous end + travel)), and checks that every later job still arrives inside its own window. Travel times come from the gateway's travel matrix, cached per `(site, site)` pair (§4.14). The chosen insertion is the one with the lowest added travel. The engine writes the new job's claim, moves the claims of the later jobs it shifted, and bumps the technician-day version, all in **one guarded batch** (§12.2). Planned assignments are `state = proposed`. They become `confirmed` at dispatch, when the nightly route optimisation (§8.8) publishes. The optimiser may reorder and reassign jobs, but must keep I-31.

## 7.3 Capacity modes and places

When a session is created, places are materialised from `participants.capacity`:

| Mode | Places | Selection at booking |
|---|---|---|
| `single` | 1 place | That place |
| `pooled` / `pooled_from_space` | N anonymous places, `place_no` 1..N | The earliest-released free place (so refills go to earlier late cancellations first), else the lowest `place_no` |
| `assigned` | One place per enabled spot of the layout supplied by the `provides_layout` requirement, with the spot's attributes copied | The requested spot. If none was requested and `auto_assign` is true, the best free spot by layout order (row, then column). If `auto_assign` is false, a spot is required |
| `mixed` | Base places, each labelled with a partition (`general` by default) | Only places in partitions where `eligible_if` is true for the customer and `online` matches the channel (`online: false` partitions accept only `desk` and `portal` channels with the staff `desk` role) |

**Partition release.** For each partition with `release`, the materialiser schedules a timer at the release offset. When it fires, the free places of that partition are relabelled `released_to = <to>`, and a `place.released` event is emitted for each one, which can trigger waitlist promotion. The relabelling is idempotent, because it is keyed by `(session, partition, release)`.

Once a partition's release instant has passed, the partition behaves as its target for good. A place in it that becomes free **later** (for example through a late cancellation) is relabelled to the target in the same batch that frees it. Example: in the spin studio, a front-row bike freed 10 hours before class is in `general`, because the front-row partition was released 24 hours before class.

**Capacity changes on a live session** (staff override or config migration) add or remove places in a batch. Removal only takes free places. If too few are free, the session is marked over capacity (§6.8).

## 7.4 Evaluation pipeline (hold and booking)

Checks run in this order. The first hard failure stops the pipeline. Each step appends to the decision trace.

| # | Check | Fails with |
|---|---|---|
| 1 | Actor may act for this customer (self, staff with role, or agent with `on_behalf_of` = this customer) | `FORBIDDEN` |
| 2 | Domain routing: if the `bookings` domain is `mirror` or `shadow`, take the write-through path (§7.12) | — |
| 3 | Session status is `scheduled` (or `needs_staff` when the policy allows booking unstaffed sessions; default allowed) and the session has not started | `SESSION_NOT_BOOKABLE` |
| 4 | Booking window: `opens ≤ now < closes` | `WINDOW_NOT_OPEN` (with `opens_at`), `WINDOW_CLOSED` |
| 5 | `template.eligible_if` and `policy.eligible_if` | `NOT_ELIGIBLE` (+ `ineligible_message`) |
| 6 | No existing booking for this session (I-21). If `customer_overlap = forbid`, no overlapping confirmed booking | `ALREADY_BOOKED`, `CUSTOMER_OVERLAP` |
| 7 | Every applicable limit has room. Counter keys are listed in §12.5 | `LIMIT_REACHED` (+ limit key, message) |
| 8 | Payment: entitlement selection (§7.4.1), or a price from `price_rules`/`price` | `NO_ENTITLEMENT`, `INSUFFICIENT_UNITS`, `ENTITLEMENT_CAP_REACHED`, `PAYMENT_REQUIRED` |
| 9 | Place: the requested spot is free and in an eligible partition; otherwise any eligible free place | `PLACE_TAKEN` (+ alternatives), `PLACE_NOT_ELIGIBLE`, `SESSION_FULL` (+ `waitlist_available`) |
| 10 | Intake: required custom fields are present | `INTAKE_REQUIRED` (+ field keys) |
| 11 | Approval: `approval.required_if` | outcome `pending` (not a failure) |

The **quote** returned with a hold contains `{ payment: units|price|none, unit, amount, entitlement_id?, price?, terms: TermsSnapshot, approval_required }`. The customer sees the terms (for example "free cancellation until Tue 06:30") before confirming.

### 7.4.1 Entitlement selection

1. Candidates are the customer's entitlements that meet all of: `state = active`; valid at `session.start` (`starts_at ≤ start < ends_at`, or open-ended); a grant for the template's unit; `covers` is true; balance ≥ amount, or unlimited; and every cap counter has room.
2. Order the candidates by `(priority ASC, ends_at ASC NULLS LAST, id)`. Pick the first.
3. If there are no candidates and payment allows a price, quote the price. If `units_only`, fail with the most specific reason: no covering entitlement → `NO_ENTITLEMENT`; a covering entitlement with too few units → `INSUFFICIENT_UNITS`; a covering entitlement over a cap → `ENTITLEMENT_CAP_REACHED`.
4. The units are *reserved* at confirm, not at hold. They are re-checked at confirm, and the `CHECK (balance >= 0)` constraint makes over-spending impossible (§12.5).

## 7.5 Holds and concurrency

### 7.5.1 Mechanisms (defence in depth)

1. **Database constraints, which are authoritative.** `place_claim` has `PRIMARY KEY (session_id, place_id)`. `occupancy` has `PRIMARY KEY (resource_id, grain, lane)`. Counters and balances have CHECK constraints. Each hold, confirm or cancel is **one guarded batch** that either applies fully or not at all (§12.2).
2. **SessionGate, for ordering and speed.** This is one per-object coordinator per timetable session, with strongly consistent storage. It:
   - processes that session's hold, confirm, cancel and waitlist commands **one at a time in arrival order**, so a rush at booking-open time is served first come, first served instead of by retry luck;
   - keeps a cached free-place map, so it can answer `SESSION_FULL` without touching the database;
   - sets an alarm for the earliest hold expiry and runs the release batch when it fires.

   If the gate is unreachable, edge functions fall back to sending batches straight to the database. Correctness is unchanged; only ordering fairness is lost.
3. **On-demand holds** (appointments, rooms, jobs) claim resource time in `occupancy` (`claim.owner.type = hold`, `expires_at` set), plus the single place. There is no gate. Contention is low, and the database is the arbiter.

### 7.5.2 The hold batch (assigned spot)

```sql
-- 1. claim the place unless a live claim exists (an expired hold is overwritten in place)
INSERT INTO place_claim (session_id, place_id, kind, holder_id, customer_id, expires_at)
VALUES (:session, :place, 'hold', :hold_id, :customer, :now + :ttl)
ON CONFLICT (session_id, place_id) DO UPDATE
  SET kind = 'hold', holder_id = excluded.holder_id, customer_id = excluded.customer_id,
      expires_at = excluded.expires_at
  WHERE place_claim.kind = 'hold' AND place_claim.expires_at <= :now;
-- 2. assert we own it; batch_assert has CHECK (ok = 1), so a false here aborts the whole batch
INSERT INTO batch_assert (ok)
  SELECT holder_id = :hold_id FROM place_claim WHERE session_id = :session AND place_id = :place;
-- 3. record the hold, the decision trace and the audit row
INSERT INTO hold (...) VALUES (...);
INSERT INTO decision (...) VALUES (...);
INSERT INTO audit (...) VALUES (...);
DELETE FROM batch_assert;
```

### 7.5.3 Spot-hold race: what happens

Riders A and B both tap **Bike 12** for Tuesday 06:00 Spin at 12:00:00.200, the moment the window opens.

1. Both requests reach edge functions and pass checks 1–8 independently, using read-only queries.
2. Both are sent to the SessionGate for `ses_…tue0600`. The gate orders them: A first (it arrived 3 ms earlier), then B.
3. A's batch inserts the `place_claim`. The assert passes, and A gets `201 { hold_id, expires_at: 12:05:00.2, quote }`.
4. B's batch: the upsert's `WHERE` is false (A's hold is live), so no row changes. The assert selects `holder_id = A ≠ B`, so `ok = 0`, the CHECK fails, and the batch rolls back. B gets `409 PLACE_TAKEN` with `alternatives`: the free places in B's eligible partitions with the same attributes as Bike 12 (`front_row`), nearest first by grid distance, for example `[Bike 13, Bike 11]`, plus `free_count`.
5. **Without the gate** (for example during a gate outage), both batches go to the tenant database. SQLite runs write transactions one at a time, so whichever commits second hits the same assert and fails. The outcome is identical.
6. A abandons checkout. At 12:05:00.2 the gate's alarm runs `DELETE FROM place_claim WHERE session_id=? AND place_id=? AND kind='hold' AND holder_id=:A AND expires_at <= :now`, sets the hold to `expired`, and emits `place.released`. Promotion runs if anyone is waiting. If the alarm is lost, nothing is stuck: the next claimant's upsert overwrites the expired row (step 1 of §7.5.2).
7. A comes back at 12:06 and confirms. The confirm batch's guard (`kind='hold' AND holder_id=:A AND expires_at > :now`) fails. The engine tries **one** transparent re-hold of the same place. If the place is free, the confirm goes ahead. If not, A gets `409 HOLD_EXPIRED` with alternatives. Any payment authorisation for A is voided through the gateway, by an outbox job keyed by the hold ID.

Clock assumption: edge nodes' clocks are within ±1 s (NTP). Holds last minutes, so this skew cannot cause a double claim. The database constraint does not depend on clocks, only on which batch commits first.

### 7.5.4 Confirm batch

One batch, in this order:

1. Convert the place claim, guarded on the live hold.
2. Insert the booking with its terms snapshot.
3. Units: `UPDATE entitlement_balance SET balance = balance - :n WHERE …`. `CHECK (balance >= 0)` aborts the batch if units are short. Then insert a `reserve` ledger row.
4. Upsert every limit counter, with its `CHECK (count <= max)`.
5. Increment `session.booked_count`.
6. Write the outbox rows: `booking.confirmed` and the payment capture, if any.
7. Write the audit row.

For price payments, the client first completes the processor's hosted payment step, which produces an authorisation. The platform never sees card data. The engine verifies the authorisation amount through the gateway before sending the batch. Capture is an outbox job that runs after commit. If capture fails permanently, the booking is cancelled, the place is released, and the customer is notified.

## 7.6 Cancellation, late cancellation, no-show

On `POST /bookings/{id}/cancel` by the customer, an agent for the customer, or staff:

| Case | Condition | Effect in one batch | Deferred |
|---|---|---|---|
| Timely | `now < terms.free_until` | `state = cancelled`; delete the place claim; `release` ledger row and balance restored; limit counters decremented; refund outbox if price-paid; `place.released` | — |
| Late | `free_until ≤ now < start` | `state = late_cancelled`; delete the place claim (the place becomes free for others); limit counters decremented; `place.released` | Penalty per `terms.late_penalty.assess_at` |
| After start | `now ≥ start` | Rejected for customers (`TOO_LATE_TO_CANCEL`). Staff may cancel with an explicit `penalty: apply | waive` | — |
| Staff waive | staff with `waive=true` | Treated as timely; audited with a reason | — |

**Penalty assessment** (immediately, or by a timer at `session_start` / `session_end`):

1. Evaluate `waive_if` with the booking as it is at assessment time. `booking.place_refilled` is true when that booking's place is held by another confirmed booking at that moment.
2. If waived, `release` the reserved units (the customer gets the credit back) and charge no fee.
3. If not waived: if `forfeit_units`, write a `forfeit` ledger row (the reserve becomes final). If `fee` and `fee_if`, write an outbox job that charges the fee through the gateway, with idempotency key `fee:{booking_id}:{late|no_show}`. Add `strikes`.
4. Emit `booking.penalty_assessed` with the outcome.

**No-show:** a timer at `start + grace` marks confirmed bookings that have not checked in as `no_show`, and emits `booking.no_show`. The penalty is assessed at `assess_at`. Staff can reverse a no-show within 24 h (`POST /bookings/{id}/attendance`), which reverses the penalty with compensating ledger rows and a refund job.

## 7.7 Waitlist

**Join** (`POST /sessions/{id}/waitlist`) is allowed when: the waitlist is enabled; the session has no free place the customer is eligible for (I-22); the size is below `max_size`; the mode now is not `closed`; checks 3–8 pass for this customer, with check 8 only testing that payment is *possible* when `require_entitlement` is set, without reserving. `position = max(position) + 1`, assigned inside the SessionGate batch. The customer may give `preferred_place_ids`.

**Promotion** runs whenever `place.released` fires for the session: from a cancellation, a hold expiry, a partition release, a capacity increase, or a staff removal. The SessionGate runs it:

```
mode ← waitlist mode at now (first schedule entry whose `until` is still in the future; else closed)
if mode == auto_promote:
   for entry in waiting entries by position:
      place ← preferred free eligible place, else best eligible free place (place_choice)
      if place is null: continue        // e.g. the freed place is tier-reserved and this customer isn't eligible
      result ← evaluate pipeline steps 3–10 for entry.customer with that place, channel 'waitlist'
               (step 4 skipped: promotion is allowed after the window closes, until the schedule ends)
      if result.allowed: one batch = confirm booking (units reserved / price via saved method*) +
                           entry.state=promoted; emit booking.confirmed{via: waitlist}; stop
      else: entry.state = skipped, reason recorded; emit waitlist.skipped; continue
if mode == offer_all:
   all waiting entries → state=offered, offer_expires_at = now + offer_ttl; emit waitlist.offered
   the first offered customer to hold + confirm wins (normal flow, limited to offered customers)
   expired offers return to waiting if the session is still full
if mode == closed: nothing; at session start all entries → expired; emit waitlist.expired
```

\* Price-paid promotion needs a saved payment method with the processor (via the gateway) and the customer's prior consent, captured at join (`auto_charge_consent: true`). Without it, the entry gets an offer instead, even in `auto_promote` mode.

## 7.8 Approval

When check 11 says approval is required, the booking is created as `pending_approval` and the place is claimed (the place is not oversold). Units are reserved. A timer at `now + timeout` applies `on_timeout`. Approvers with the listed roles see the booking in their queue (`GET /approvals`). Rejection releases everything as a timely cancellation and emits `booking.rejected`.

## 7.9 Reason codes

| Code | Meaning | Customer-facing message (default) |
|---|---|---|
| `FORBIDDEN` | Actor may not act for this customer | — |
| `DOMAIN_NOT_OWNED` | Write to a mirrored domain whose outside system rejected it | "We couldn't complete that right now." |
| `SESSION_NOT_BOOKABLE` | Cancelled, completed, started or draft | "This class isn't open for booking." |
| `WINDOW_NOT_OPEN` | Before `opens` | "Booking opens {opens_at}." |
| `WINDOW_CLOSED` | After `closes` | "Booking has closed." |
| `NOT_ELIGIBLE` | Eligibility expression false | `ineligible_message` |
| `EXPR_ERROR` | Expression failed (fail-safe) | "We couldn't confirm eligibility. Please contact us." |
| `ALREADY_BOOKED` / `CUSTOMER_OVERLAP` | Duplicate or overlapping booking | "You're already booked at this time." |
| `LIMIT_REACHED` | A booking limit is full | limit `message` |
| `NO_ENTITLEMENT` / `INSUFFICIENT_UNITS` / `ENTITLEMENT_CAP_REACHED` / `PAYMENT_REQUIRED` | Payment checks | "Your plan doesn't cover this class." etc. |
| `PLACE_TAKEN` / `PLACE_NOT_ELIGIBLE` / `SESSION_FULL` | Place checks | "That bike was just taken. Bike 13 is free." |
| `INTAKE_REQUIRED` | Missing required fields | "Please complete: …" |
| `HOLD_EXPIRED` | Hold timed out | "Your hold expired." |
| `TOO_LATE_TO_CANCEL` | After start | — |
| `RESOURCE_CONFLICT` | Occupancy collision (assignment or shift) | "{person} is already booked {when}." |
| `OUTSIDE_AVAILABILITY` | Outside availability or time off | — |
| `SKILL_MISSING` / `ROLE_MISSING` | Selector mismatch | — |
| `REST_VIOLATION` / `MAX_HOURS` / `MAX_ASSIGNMENTS` / `TRANSFER_TIME` / `ALLOWED_HOURS` / `CONSECUTIVE_DAYS` | Person rules (§8.6) | — |
| `STALE_VERSION` | An optimistic concurrency guard failed after retries | "Please try again." |

## 7.10 Time zones and DST

- **Storage:** every instant is UTC milliseconds. Every location, site and person has an IANA zone. The tzdb version is pinned per release and recorded in `CompiledConfig.tzdb`.
- **Recurrence:** RRULEs expand in the location's zone with `DTSTART;TZID=<zone>`. Occurrences keep their **local wall time** across DST changes.
- **Times that don't exist** (spring forward, for example 02:30 on 14 Mar 2027 in `America/New_York`): the time is read with the UTC offset in force before the gap, as RFC 5545 specifies, so the occurrence starts at 03:30 EDT. The validator reports `DST_SHIFTED_OCCURRENCE` (info) for each one in the horizon.
- **Times that occur twice** (fall back, 01:30 on 7 Nov 2027): the first occurrence (daylight time) is used, as RFC 5545 specifies.
- **Durations are elapsed time.** A 01:00–02:00 class on fall-back night lasts 60 minutes. An overnight shift starting 22:00 with `duration: 8h` ends at 05:00 local on fall-back night and 07:00 on spring-forward night. Hours worked (I-28) are always elapsed.
- **Offsets with `d`/`w` are calendar arithmetic:** "7 days before at 12:00" is `local_date(start) − 7 days` at 12:00 local, then converted to UTC. It is *not* 168 hours.
- **Day windows** (limits, `max_hours/day`, caps) use the local day of the session's location. Person rules that span locations in different zones use the person's home zone.
- **Weekly availability** is wall-clock and converted per date, so "09:00–17:00" means 8 elapsed hours on normal days and also on DST days, because the change happens at night.
- **tzdb changes:** when a new tzdb release changes the rules for future dates, a rebase job recomputes UTC instants for materialised future sessions, keeping their local wall time. Any resulting occupancy collisions are reported as drift items and to managers.

The DST test matrix is listed in §14.1.

## 7.11 Performance targets (p95, production, single tenant)

| Operation | Target | Notes |
|---|---|---|
| Timetable week (one location, anonymous) | 60 ms from edge cache / 200 ms uncached | |
| Timetable week personalised | 250 ms | eligibility, limits and payment per session |
| Spot map | 120 ms | |
| Hold | 250 ms | including SessionGate |
| Confirm (units) | 300 ms | |
| Confirm (price) | 800 ms | including the gateway check of the processor authorisation |
| On-demand search, 14 days | 400 ms | |
| Booking-open rush | 300 hold attempts/s per session with no double claims; fairness by arrival order within ±50 ms | |

## 7.12 Mirror and shadow behaviour

While the `bookings` domain (or `members`, for entitlement debits) is not `owner`, the engine works as a **façade with checks**:

1. **Pre-checks run locally:** check 1, the cross-domain occupancy check for staff-side writes, and a soft capacity check against the mirror. These protect the outside system from obviously invalid writes.
2. **Write-through:** the engine calls the outside system through the gateway (`POST gateway/{system}/bookings`, with idempotency key = hold or booking ID). The outside system's answer is **authoritative**. On success, the mirror row is written with `source = mirror` and an `ExternalRef`. On rejection, the outside reason is mapped to a Kairos reason code (or `DOMAIN_NOT_OWNED` if there is no mapping) and returned.
3. **Shadow mode** adds one more step: the engine runs its full pipeline (§7.4) against local data *before* the write-through. It stores its decision, and compares it with the outside outcome. A difference creates a `ShadowDisagreement`. The customer always gets the outside outcome.
4. **Spot holds in mirror mode:** if the outside system supports reservations, the hold goes through to it. If not, Kairos keeps a local advisory hold (the same `place_claim` mechanism on mirrored places) so that two Kairos-routed customers don't race each other. Customers booking directly in the outside system are only seen when its events arrive. So a confirm can still fail with the outside system's "taken" result, which maps to `PLACE_TAKEN`.
