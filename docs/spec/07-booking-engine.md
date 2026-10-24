# 7. Booking engine

`@kairos/engine` is a TypeScript package. It runs in the `kairos-core` edge function, and in the batch worker for simulations. Given (compiled config, data read through a storage port, request, clock), it always returns the same decision. All writes go through **guarded batches** (§12.2). It never calls an LLM.

## 7.1 Responsibilities

| Operation | Endpoint (§11) |
|---|---|
| Timetable with availability | `GET /sessions?…&include=availability` |
| Mat map | `GET /sessions/{id}/places` |
| Hold (evaluate, quote, claim a place) | `POST /holds` |
| Confirm | `POST /bookings` |
| Cancel | `POST /bookings/{id}/cancel` |
| Waitlist join, leave, accept an offer | `POST /sessions/{id}/waitlist`, `POST /offers/{id}/accept` |
| Check-in; no-show timer | `POST /check-ins` |
| Explain a decision | `GET /decisions/{id}` |

**Built-in policy behaviour.** The engine itself carries out everything in a `PolicySet`:

- booking windows and limits;
- penalties, and assessing them later where the policy defers them;
- waitlist priority and promotion;
- partition releases;
- minimum attendance and the unstaffed check;
- approval timeouts;
- refunds.

Workflows (§9) only add reactions such as notifications, tasks and hooks. They never re-implement policy. **Built-in behaviour runs only on records whose domain Kairos owns** (§7.13, §3A.2). Two built-in timers run per session: **minimum attendance** and the **unstaffed check**. Their rules, including the deferral for a pending substitute proposal, are in §3A.9.5, and the cancel they perform is §3A.9.4.

## 7.2 Availability for classes

A class is **bookable for member C** when it passes the pipeline (§7.4) up to place selection.

- The timetable view runs the checks that don't depend on the member (status, window) once per session. It runs the member-specific checks (eligibility, limits, payment) once per member per request.
- Free places = `capacity_total − booked_count − active holds − disabled`, split by partition, plus `reserved_for='waitlist'` places, which count as **unavailable** to members who are not waitlisted.
- Anonymous timetable responses are cached at the edge for 15 s, keyed by session and `config_epoch`.

Teacher and room availability is not computed per member request. The rostering engine and the validator handle it (§8).

## 7.3 Capacity modes and places

When a session is materialised, its places are created from its capacity mode:

| Mode | Places | Selection |
|---|---|---|
| `pooled` / `pooled_from_space` | N anonymous places | The free place that was released earliest (so refills credit the earliest late canceller), otherwise the lowest `place_no` |
| `assigned` | One place per enabled mat in the room's layout, copying the mat's attributes | The requested mat. With no request and `auto_assign: true`, the first free mat in layout order (row, then column) |
| `mixed` | Base places labelled by partition (`general` by default) | Only partitions whose `eligible_if` is true for the member and whose `online` setting matches the channel. `online: false` accepts only the `desk` and `portal` channels with the staff `desk` role |

**Partition release.** A timer fires at each partition's release offset and relabels its free places `released_to = <to>`. Once the release time has passed, the partition behaves as its target permanently. A place freed later is relabelled in the same batch that frees it.

**Live capacity changes.** Raising capacity creates new places, which emits `place.released`. Lowering capacity removes only free places; if not enough are free, the session is marked over capacity.

## 7.4 Evaluation pipeline

| # | Check | Fails with |
|---|---|---|
| 1 | Actor may act for this member (self; staff with a role at this studio; agent `on_behalf_of` this member); member `state = active` | `FORBIDDEN`, `ACCOUNT_SUSPENDED` |
| 2 | Domain routing: if `bookings` is in mirror or shadow mode, take the write-through path (§7.12). If its `write_freeze` is set, return `WRITE_FROZEN` with `Retry-After` | `WRITE_FROZEN` |
| 3 | Session is `scheduled`, `needs_staff` or `needs_mapping` (mirrored; bookings are written through, so mapping doesn't matter to members), has not started, and is not `over_capacity` (§3A.9.3) | `SESSION_NOT_BOOKABLE`, `SESSION_FULL` |
| 4 | Booking window: `opens ≤ now < closes` | `WINDOW_NOT_OPEN`, `WINDOW_CLOSED` |
| 5 | `template.eligible_if` and `policy.eligible_if` pass | `NOT_ELIGIBLE` |
| 6 | No duplicate booking (I-21). If `customer_overlap = forbid`, no overlapping booking, and for linked staff no overlapping assignment of their own | `ALREADY_BOOKED`, `CUSTOMER_OVERLAP` |
| 7 | Limits | `LIMIT_REACHED` |
| 8 | Payment: entitlement selection (§7.4.1), or price | `NO_ENTITLEMENT`, `INSUFFICIENT_UNITS`, `ENTITLEMENT_CAP_REACHED`, `PAYMENT_REQUIRED` |
| 9 | Place: requested mat is free, not disabled, in an eligible partition, and not `reserved_for='waitlist'` (unless the member holds an active place offer); otherwise any eligible free place | `PLACE_TAKEN` (+ alternatives), `PLACE_NOT_ELIGIBLE`, `SESSION_FULL` (+ `waitlist_available`) |
| 10 | Intake and waiver fields present | `INTAKE_REQUIRED` (+ field keys) |
| 11 | Approval required? | outcome `pending` |

The **quote** contains `{ payment, unit, amount, entitlement_id?, price?, terms: TermsSnapshot, approval_required }`, and is shown to the member before they confirm.

### 7.4.1 Entitlement selection

1. Candidates are the member's entitlements that cover the session at `session.start` (I-26a), that grant the unit, that `covers` returns true for, that have enough balance (or unlimited), and that have room under every cap.
2. Order the candidates by `(priority, ends_at ASC NULLS LAST, id)` and pick the first.
3. If there are no candidates: quote the price when `payment` allows it; otherwise fail with the most specific reason.
4. Units are **reserved at confirm**. `CHECK (balance >= 0)` makes over-spending impossible.

## 7.5 Holds and concurrency

### 7.5.1 Mechanisms

1. **Database constraints are authoritative.**
   - The primary key on `place_claim (session_id, place_id)` allows one claim per place.
   - The `place.reserved_for` guard protects places held for the waitlist.
   - CHECK constraints protect balances and counters.
   - Each operation runs as one guarded batch in which every assert is a scalar subquery (§12.2).
2. **SessionGate**, one per class, is a per-object store instance. It runs that class's commands one at a time in arrival order (hold, confirm, cancel, waitlist, promotion, timers), caches free counts, and sets an alarm at the earliest hold expiry. If the gate is unreachable, edge functions send batches directly to the database. Correctness is unchanged; only first-come-first-served fairness is lost.

### 7.5.2 Hold batch

```sql
-- 1. claim the mat unless a live claim exists (an expired hold is overwritten)
INSERT INTO place_claim (session_id, place_id, kind, holder_id, customer_id, expires_at)
VALUES (:session, :place, 'hold', :hold_id, :customer, :now + :ttl)
ON CONFLICT (session_id, place_id) DO UPDATE
  SET kind='hold', holder_id=excluded.holder_id, customer_id=excluded.customer_id, expires_at=excluded.expires_at
  WHERE place_claim.kind = 'hold' AND place_claim.expires_at <= :now;
-- 2. assert: we own it (scalar subquery → exactly one row inserted, never zero)
INSERT INTO batch_assert (ok) VALUES (
  (SELECT holder_id FROM place_claim WHERE session_id = :session AND place_id = :place) = :hold_id);
-- 3. assert: mat is usable by this member (not disabled; waitlist reservation honoured)
INSERT INTO batch_assert (ok) VALUES ((SELECT p.disabled = 0 AND (p.reserved_for IS NULL OR EXISTS (
    SELECT 1 FROM offer o WHERE o.session_id = :session AND o.kind = 'place'
      AND o.state IN ('sent','accepted') AND o.hold_id = :hold_id
      AND o.customer_id = :customer AND o.expires_at > :now))
  FROM place p WHERE p.id = :place));
INSERT INTO hold (...) VALUES (...); INSERT INTO decision (...) VALUES (...); INSERT INTO audit (...) VALUES (...);
DELETE FROM batch_assert;
```

**Hold TTL.** A hold lasts `tenant.hold_ttl`. A hold made under a place offer expires at `min(now + hold_ttl, offer.expires_at + 5m)`, so a member who accepts at the last minute still has time to pay.

### 7.5.3 Mat-hold race

Two members tap **Mat 12** in Park Slope Studio 1 for Tue 07:00 Vinyasa within the same 50 ms. Mat 12 is in row 2 and is a wall mat, so it is in the `general` partition.

1. Both requests pass checks 1–8 at the edge.
2. The SessionGate orders them: A first (arrived 3 ms earlier), then B.
3. A's batch inserts the place claim and the asserts pass. A gets `201 { hold_id, expires_at: now+5m, quote }`.
4. B's batch: the upsert's `WHERE` is false, so no row changes. Assert 2 evaluates to false, the CHECK fails, and the whole batch rolls back. B gets `409 PLACE_TAKEN` with alternatives: free places in B's eligible partitions with Mat 12's attributes (`by_wall: true`, `front_row: false`), nearest first by grid distance, for example `[Mat 18, Mat 24]`, plus `free_count`.
5. **Gate down:** SQLite runs write batches one at a time, so the second batch fails the same assert. Same outcome.
6. **A abandons:** at expiry the gate alarm deletes A's place claim (guarded on holder and expiry), marks the hold `expired`, and emits `place.released`. That release goes through the waitlist rules in §7.7. If the alarm is lost, the next claimant's upsert overwrites the expired row, and the one-minute sweep (§12.4) cleans up.
7. **Expiry during payment:** A confirms after expiry, so the guard fails. The engine tries **one** transparent re-hold of the same mat. If that also fails, A gets `409 HOLD_EXPIRED` with alternatives, and the payment authorisation is voided through an outbox job keyed by the hold ID.

Edge clocks are assumed to be within ±1 s (A-12). Holds last minutes, and the uniqueness guarantee depends only on commit order, not on clocks.

### 7.5.4 Confirm batch

One batch, in this order:

1. Convert the claim: `UPDATE place_claim SET kind='booking', holder_id=:b, expires_at=NULL WHERE session_id=? AND place_id=? AND kind='hold' AND holder_id=:h AND expires_at > :now`, then the assert `INSERT INTO batch_assert(ok) VALUES ((SELECT count(*) FROM place_claim WHERE session_id=? AND place_id=? AND holder_id=:b) = 1)`.
2. Insert the booking with its terms snapshot.
3. Units: `UPDATE entitlement_balance SET balance = balance - :n, last_batch = :batch WHERE …`. If the balance is short, the CHECK aborts the batch. Then assert `last_batch = :batch`, and insert the `reserve` ledger row.
4. Upsert the limit counters (CHECK `count <= max`).
5. Update `booked_count`.
6. Write the outbox rows (`booking.confirmed`, payment capture) and the audit row.

**Price payments.** The client completes the processor's hosted payment step, which produces an authorisation. Kairos never sees card data. The engine checks the authorised amount through the gateway before the batch runs. Capture is an outbox job that runs after commit. If capture fails for good, the booking is cancelled as a studio cancel, the place is released, and the member is notified.

## 7.6 Cancellation, late cancellation, no-show

| Case | Condition | Effect (one batch) | Deferred |
|---|---|---|---|
| Timely | `now < terms.free_cancel_until` | `cancelled`; place claim deleted; `release` ledger row; counters −1; refund per `terms.refund.timely` (`full` → outbox refund; `credit` → grant a 1-credit pack; `none` → nothing); place released (§7.7) | — |
| Late | `free_cancel_until ≤ now < start` | `late_cancelled`; place claim deleted; counters −1; place released (§7.7). Price-paid: no refund now | Penalty at `terms.late_penalty.assess_at`; price-paid refund decided then (`terms.refund.late`) |
| After start | `now ≥ start` | Members get `TOO_LATE_TO_CANCEL`. Staff may cancel with `penalty: apply \| waive` | — |
| Studio cancel | Session cancelled (unstaffed, closure, minimum attendance, staff) | Bookings domain owned: every booking → `cancelled`; `release`; full refund; late fees already charged for this session reversed. Not owned: the outside system does this (§3A.9.4, D-44) | — |

**Penalty assessment**, which runs immediately or from a timer at session start or end:

1. Evaluate `waive_if` against the booking at that moment. `booking.place_refilled` is true when that booking's place is held by another **confirmed** booking at that moment.
2. **Units** (`payment.method = units`): if waived, write a `release` row (credit back); if not waived and `forfeit_units`, write a `forfeit` row.
3. **Fee:** if not waived, and there is a `fee` and `fee_if` is true, create an outbox fee job keyed `fee:{booking}:{late|no_show}`.
4. **Strikes:** if not waived, add the policy's `strikes`.
5. **Price-paid late cancel** (`payment.method = price`): if `terms.refund.late = as_timely_if_refilled` and `place_refilled` is true, create a refund job per `terms.refund.timely`, keyed `refund:{booking}:late`. Otherwise no refund. `waive_if` doesn't decide refunds; it only cancels penalties (D-48).
6. Emit `booking.penalty_assessed{waived, fee, refund}`.

**No-show.** At `start + grace`, a timer marks every confirmed booking that hasn't checked in as `no_show`. The penalty follows at `assess_at`. Staff can correct a no-show within 24 h, which writes compensating ledger rows and a refund job. At `end + 15m`, checked-in bookings become `attended` and their reserved units are consumed.

## 7.7 Waitlist

**Join.** A member can join when:
- the waitlist is enabled;
- there is no free place they are eligible for (I-22);
- the waitlist has fewer than `max_size` entries;
- the current mode is not `closed`;
- checks 3–8 pass. If `require_entitlement` is set, payment only has to be possible (nothing is reserved).

`position = max + 1`, assigned in the gate batch. The body may carry `preferred_place_ids`, `auto_charge_consent` and `payment_method_ref`.

**Priority over new bookings (D-27).** Any batch that frees a place (cancellation, hold expiry, partition release, capacity increase, re-seat) checks whether the session has `waiting` entries and the mode is not `closed`. If so, and at least one waiting entry passes the place's partition `eligible_if` (evaluated in the read phase, D-59), the same batch sets `place.reserved_for = 'waitlist'`. A front-row place freed before its release time is therefore not reserved for a waitlist of non-unlimited members. The hold SQL (§7.5.2, assert 3) then refuses that place to anyone who doesn't hold an active place offer. This is enforced in the database, so it holds even when the gate is down.

**Freeing a place.** Every path that frees a place goes through one routine, `release_place(session, place)`, inside the batch that frees it. That covers cancellation, hold expiry (alarm **or** the 1-minute sweep, §12.4), partition release, capacity increase and re-seat. The routine sets `reserved_for` (D-27) and emits `place.released`.

**Promotion.**
- The gate runs promotion as its very next command after any batch that sets `reserved_for`.
- **Fallback:** a promotion sweep runs every minute. For any place with `reserved_for='waitlist'` set more than 30 s ago, it runs the same promotion directly against the database, guarded by the same asserts. A gate outage therefore delays promotion by at most about 90 s; it never strands a mat.

```
mode ← first schedule entry whose `until` instant is still in the future; else closed
auto_promote:
  for entry in waiting entries by position:
    place ← entry's first free preferred place among reserved/free eligible places, else best eligible
    if none: continue
    result ← pipeline steps 3, 5–10 for entry.customer with that place, channel 'waitlist' (step 4 skipped)
    payment: units → reserve; price → only if auto_charge_consent && payment_method_ref
             (charge via gateway with idempotency key = entry id; a declined charge → skipped, PAYMENT_FAILED);
             otherwise treat as not allowed → offer instead
    allowed → one batch: booking confirmed (booked_via=waitlist), place.reserved_for=NULL, entry → promoted,
              emit booking.confirmed; stop
    not allowed → entry → skipped (reason recorded), emit waitlist.skipped{reason}; continue
  if nobody promoted: clear reserved_for (place becomes free for anyone)
offer_all:
  every waiting entry → offered; create a place Offer per entry (expires_at = now + offer_ttl); emit waitlist.offered
  place stays reserved for offered members.
  POST /offers/{id}/accept (place) runs ONE batch: offer → accepted, hold created on a reserved place
    (assert 3 passes because o.hold_id = the new hold), returns hold_id; the member then confirms (POST /bookings).
  the first accepted offer to confirm wins; booking the place clears its reserved_for.
  other open offers stay valid while reserved places remain; when none remain they get 409 SESSION_FULL on accept.
  when all offers expire or are declined: entries → waiting (if session still full), reserved_for cleared
closed: reserved_for not set; at session start all entries → expired; emit waitlist.expired
```

Promotion never creates a hold. An auto-promoted member is booked directly, and a member with an offer goes through the normal hold flow. **Notifications** for promotion, offers and skips are sent by workflows (§4b.1 `promoted_notice`, `offer_notice`, `skipped_notice`) through the notification service.

## 7.8 Approval

A booking that needs approval is created as `pending_approval`. The place is claimed and units are reserved. A timer applies `on_timeout` at `min(created + timeout, session.start)`; a booking still pending at session start is always rejected (D-58). Approvers use `GET /approvals` and `POST /approvals/{id}/decide`. A rejection releases everything, as for a timely cancellation (§3A.12.4).

## 7.9 Reason codes

| Code | Meaning | Default member message |
|---|---|---|
| `FORBIDDEN` | Actor may not act for this member | — |
| `ACCOUNT_SUSPENDED` | Member is suspended | "Your account is paused. Please contact the studio." |
| `WRITE_FROZEN` | Domain is mid-cutover (§18.7) | "Booking is paused for a few minutes. Please try again." |
| `OUTSIDE_UNAVAILABLE` | Mirror-mode outside system is unreachable (§7.12) | "We can't take bookings right now. Please try again shortly." |
| `DOMAIN_NOT_OWNED` | Outside system rejected the write, with no mapped reason | "We couldn't complete that." |
| `SESSION_NOT_BOOKABLE` | Session is cancelled, completed or started | "This class isn't open for booking." |
| `WINDOW_NOT_OPEN` / `WINDOW_CLOSED` | Outside the booking window | "Booking opens {opens_at}." / "Booking has closed." |
| `NOT_ELIGIBLE` / `EXPR_ERROR` | Eligibility | `ineligible_message` |
| `ALREADY_BOOKED` / `CUSTOMER_OVERLAP` | Duplicate or overlapping booking | "You're already booked at this time." |
| `LIMIT_REACHED` | A booking limit is full | Limit `message` |
| `NO_ENTITLEMENT` / `INSUFFICIENT_UNITS` / `ENTITLEMENT_CAP_REACHED` / `PAYMENT_REQUIRED` | Payment checks | "Your plan doesn't cover this class." |
| `PLACE_TAKEN` / `PLACE_NOT_ELIGIBLE` / `SESSION_FULL` | Place checks | "That mat was just taken. Mat 18 is free." |
| `INTAKE_REQUIRED` | Intake fields missing | "Please complete: …" |
| `HOLD_EXPIRED` | Hold timed out | "Your hold expired." |
| `SESSION_CHANGED` | The session was retimed or moved after the hold was made (§3A.9.2) | "This class changed. Please review it again." |
| `MOVE_NOT_ALLOWED` | A move after `free_cancel_until` (D-50) | "It's too late to move this booking. You can cancel it instead." |
| `OFFER_FILLED` | Another substitute accepted first (§3A.14) | "Thanks, this class has already been covered." |
| `PAYMENT_FAILED` | An auto-charge for a waitlist promotion was declined | "We couldn't charge your saved card." |
| `IMPACT_UNACKNOWLEDGED` | A session edit has impact groups that weren't acknowledged (§3A.9.2) | — |
| `TOO_LATE_TO_CANCEL` | Class has started | — |
| `CONFIRMATION_STALE` | Agent confirmation no longer matches (§11.6) | "Details changed. Please review again." |
| `RESOURCE_CONFLICT` | Occupancy collision | "{person} is already booked {when}." |
| `OUTSIDE_AVAILABILITY` / `SKILL_MISSING` / `ROLE_MISSING` | Person rules | — |
| `REST_VIOLATION` / `MAX_HOURS` / `MAX_ASSIGNMENTS` / `TRANSFER_TIME` / `CONSECUTIVE_DAYS` | Person rules | — |
| `MIRROR_STALE` | Mirror data too old for a staff write (§18.6) | — |
| `STALE_VERSION` | Optimistic guard still failing after retries | "Please try again." |

## 7.10 Time zones and DST

- Instants are stored in UTC. Every studio and every person has an IANA zone. The tzdb version is pinned per release.
- RRULEs expand in the studio's zone and keep **local wall time** across DST.
- **Non-existent local times** (spring forward): the occurrence moves forward by the gap, per RFC 5545. A 02:30 class on 14 Mar 2027 in New York runs at 03:30 EDT. Validation reports `DST_SHIFTED_OCCURRENCE`.
- **Ambiguous local times** (fall back): the first occurrence is used. A 01:30 class on 7 Nov 2027 runs at 01:30 EDT (05:30 UTC), not at 01:30 EST.
- **Durations are elapsed time.** A 75-minute class that starts at 01:00 on fall-back night lasts 75 minutes and ends at 01:15 EST. A desk shift that crosses the change records its elapsed minutes (I-28). Yoga studios close overnight, so no rostered template in §4b crosses 02:00, and validation warns if one does.
- **`d`/`w` offsets are calendar arithmetic.** "14 days before at 12:00" means `local_date(start) − 14 days` at 12:00 local time.
- **Day windows** for limits, caps and person rules use the session's studio zone. Person rules that span studios in different zones use the person's home zone.
- **Members in other zones.** The API always returns `local` in the **studio's** zone, plus the UTC instant. Front ends may also show the viewer's local time, labelled "your time". Booking windows and cancel deadlines are always computed in the studio's zone.
- **tzdb changes.** A rebase job recomputes future UTC instants, keeping local wall time, and reports any collisions.

## 7.11 Performance targets (p95, single tenant)

| Operation | Target |
|---|---|
| Timetable week, anonymous | 60 ms cached / 200 ms uncached |
| Timetable week, personalised | 250 ms |
| Mat map | 120 ms |
| Hold | 250 ms |
| Confirm (units / price) | 300 ms / 800 ms |
| Booking-open rush | 300 hold attempts/s on one class with no double claims; first-come ordering within ±50 ms |

They are measured by synthetic probes every minute from three regions, per tenant, and by a load test before each phase gate (§14.3).

## 7.12 Mirror and shadow modes, and outside outages

While `bookings` (or `members`, for debits) is not `owner`:

1. **Local pre-checks:** actor, member state, write freeze, mirrored capacity.
2. **Write-through:** the engine calls the outside system through the gateway with idempotency key = hold or booking ID. The outside system's answer is final. A success writes the mirror row (`source = mirror`). A rejection is mapped to a Kairos reason code, or to `DOMAIN_NOT_OWNED` if it has no mapping.
3. **Shadow mode** also runs the full pipeline first and logs a `ShadowDisagreement` if the outcomes differ.
4. **Mat holds in mirror mode:** if the outside system supports reservations, they are used. Otherwise Kairos keeps an advisory local hold (Q-01).
5. **Outside outage:**
   - Write-through calls time out after 5 s. After 3 consecutive failures, a circuit opens for 30 s.
   - Writes in that domain are refused with `OUTSIDE_UNAVAILABLE`. They are never queued, because the outside system is the record.
   - Reads are served from the mirror, with a `stale_since` field that front ends show as a banner.
   - Desk check-ins are the only writes that queue: they wait in the desktop app's offline queue, keyed by `client_key`, and replay when the connection returns.
   - Owned domains are unaffected, except that outbound pushes queue in the outbox for up to 24 h before raising `push_failed` drift.

## 7.13 Built-in behaviour by domain mode

Kairos must never act on a record that an outside system owns. Each built-in behaviour therefore runs only when the domain it acts on is `owner`. In `shadow` mode it runs as a **dry run**: the decision is computed and logged as a `ShadowDisagreement` when it differs from the outside system, and nothing is written. In `mirror` mode it does not run at all.

**Events that span two domains** (for example a class cancel, which touches `classes` and `bookings`) run natively only for the owned domain. For a domain Kairos doesn't own, it pushes its owned change and lets the outside system apply the consequences (§3A.1 C4, D-44). In Phase 3, an unstaffed cancel therefore cancels the class in Kairos and pushes the cancel to BookingVendor, which cancels, refunds and notifies its bookings.

The full matrix of what Kairos does per event and per mode is **§3A.2**. The person-rule validator on Kairos-originated writes is always on in every mode; this is what refuses the desk shift in A.5.

The timers are still **scheduled** in mirror and shadow modes, so that switching a domain to `owner` needs no back-fill. When a timer fires, it checks the domain mode at that moment. Tests cover each row in each mode (§14.1).

