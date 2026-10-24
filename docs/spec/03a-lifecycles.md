# 3A. Lifecycles

This section is the **only** normative statement of how each entity begins, changes and ends. §7–§18 describe mechanisms (batches, solver, workflows, sync) and refer here for *what happens when*. Entities and fields are defined in §3; endpoints in §11; reason codes in §7.9; events in §9.2.

## 3A.1 How to read a lifecycle card, and the rules every card shares

Each event is written as a card with the same rows:

| Row | Meaning |
|---|---|
| **Trigger** | What starts the event and which actors may cause it |
| **State changes** | The ordered changes. Numbered steps inside one bullet run in **one guarded batch** (§12.2) unless the card says *saga* |
| **Dependants** | What happens to bookings, sessions, shifts, waitlists, entitlements and holds |
| **Notify** | The domain events emitted. The reference workflow in §4b.1 that turns each one into a notification-service call is named in brackets |
| **Outside** | What changes in outside systems, through the gateway, per domain mode: **M** mirror · **S** shadow · **O** owner |
| **Audit** | What the audit entry records beyond the defaults in C1 |
| **Failure** | What happens when a step fails partway, and how the system recovers |

**Common rules.** A card that says nothing on a row means the common rule applies.

- **C1 Atomic state + audit + events.** Every state change is one guarded batch. That batch also writes the audit entry (actor including `on_behalf_of` and `run_id`, action `<entity>.<event>`, target, `before_hash`, redacted `after`, `request_id`, `config_version`), the domain events and the outbox rows (I-29). If the batch aborts, nothing changed. The caller receives the mapped reason code, and clients retry with the same `Idempotency-Key`.
- **C2 Notifications only through workflows.** The engine never sends a message. It emits a domain event; a workflow (§9) with a `notify` action writes an outbox row to the notification service. Validation warns with `NOTICE_MISSING` (§6.3) when a config has no workflow for an event marked *required notice* in §9.2. **The reference tenant has `member_messaging: kairos` (D-51):** Kairos sends every member and staff message in every domain mode, including messages about records still mirrored from BookingVendor, and BookingVendor's own member messages are switched off (§3A.3). Under `record_holder`, workflows run only for owned domains (§9.3).
- **C3 Outside systems only through the outbox and gateway.** In **M**, Kairos never changes an outside-owned record on its own initiative. A user write is written through synchronously (§7.12), and anything else is left to the outside system. In **S**, Kairos behaves as in M and also computes its own decision as a dry run, logging a `ShadowDisagreement` when it differs. In **O**, Kairos performs the change and pushes it out when `outbound_push` is on.
- **C4 Mixed domains (D-44).** An event that changes records in two domains runs natively only for the domains Kairos owns. For each domain it doesn't own, Kairos pushes its owned change (for example "class cancelled") to the outside system. The outside system then applies its own consequences to its records (for example cancelling and refunding bookings and telling members), and Kairos mirrors the result.
- **C5 Post-commit jobs.** Outbox jobs (refunds, fees, pushes, notifications, calendar events) retry at 1 m, 5 m, 30 m, 2 h and 12 h. Then the job is marked `dead`, a `manager_inbox` task is created, and a money job also pages (§13.9). A failed outbox job never rolls back the committed state. Each card names the compensation, if one exists.
- **C6 Sagas.** Work larger than one batch is a saga. A `saga` row (§12.7) records `kind`, `step`, `state` and an idempotency key per step. Each step is one batch and is idempotent per `(saga_id, step)`. A sweep every minute resumes any saga whose lease expired, from its last committed step. Each card that uses a saga names its compensation.
- **C7 Timers.** Built-in timers (penalty, no-show, attended, minimum attendance, unstaffed, partition release, approval timeout, hold expiry) are `scheduled_action` rows (§12.6). They are scheduled whatever the domain mode, and at fire time they check the domain mode (§3A.2). They are re-planned in the same batch when the session's time changes.

## 3A.2 Domain-mode matrix

What Kairos itself does for each event, per mode of the domain the event changes. "Write-through" = synchronous call through the gateway; the outside answer is final (§7.12). "Task" = a `manager_inbox` task naming the outside action needed.

| Event | Domain | Mirror | Shadow | Owner |
|---|---|---|---|---|
| Materialise sessions from the timetable | classes | Off: sessions come from the mirror | Dry run: compare occurrences | Native; push new classes |
| Partition release, minimum attendance, unstaffed timers | classes | Off | Dry run | Native |
| Session cancel (any reason): session, claims, places | classes | Write-through cancel if supported, else task (staff-initiated only; built-in cancels are off) | As mirror + dry run | Native; push the cancel |
| Session cancel: bookings, refunds, waitlist, member notice | bookings | Done by the outside system (C4) | Dry run of the studio cancel, compared with the mirrored outcome | Native (§3A.9.4) |
| Staff session edit (retime, room, capacity) | classes | Write-through if supported, else task | As mirror | Native; push |
| Holds, bookings, cancels, check-ins by members and desk | bookings | Write-through (§7.12) | Write-through + dry run | Native |
| Waitlist reservation, promotion, offers | bookings | Off: the outside system runs its waitlist | Dry run | Native |
| No-show marking, penalties, fees, refunds, approval timeouts | bookings | Off | Dry run | Native |
| Entitlement grant, renewal, expiry, freeze, past-due | members | Off (mirrored) | Dry run | Native |
| Member merge, suspend, close, freeze | members | Not available in Kairos; the UI links to BookingVendor | As mirror | Native |
| Member erase | members | Erase Kairos's mirror copy + task "erase in BookingVendor" | As mirror | Native |
| Desk-shift candidates, coverage, roster publish | shifts | Off | Dry run: validator verdicts and hours on the mirrored shifts (§18.7) | Native; push to ShiftTool while `outbound_push` |
| Vacate on sick call, time off, offboarding: **classes** | classes | Not done by Kairos; the portal shows "Arrange cover in BookingVendor" (deep link); the mirrored claim stays until BookingVendor changes the class | As mirror | Native → substitute flow (§3A.14) |
| Vacate on sick call, time off, offboarding: **desk shifts** | shifts | Write-through to ShiftTool | As mirror | Native → `desk_vacated` workflow |
| Substitute or teacher change from a roster solve | classes | Write-through `PATCH gateway/booking_vendor/classes/{id} {instructor}` if supported (A-03), else not available | As mirror | Native |
| Studio closure | classes + shifts | Per affected row above | Per row | Native (§3A.4) |
| Room or mat block | classes | Write-through room or capacity change if supported, else task | As mirror | Native (§3A.5) |
| Person-rule validator on Kairos-originated writes | all | **Always on** | Always on | Always on |
| Mirror ingestion of outside records | any non-owner | Applied (I-18) | Applied | n/a (push verification only) |
| Workflows | event's domain | On for `member_messaging: kairos` (events emitted by mirror ingestion, §18.6); off under `record_holder` unless `scope: all` | As mirror | On |

Dependency rule for owner: classes and shifts have none; bookings needs classes; members needs bookings (§18.5). Tests cover every row in every mode (§14.1).

## 3A.3 Tenant

| Stage | Steps | Data / money / outside effects |
|---|---|---|
| **Provision** | Control-plane record created (`provisioning`) → IaC creates the preview and production databases, per-object namespaces, per-tenant data key, and gateway and notification credentials scoped to the tenant | No member data yet |
| **Onboard** (`onboarding`) | (1) The owner signs in; `access` is set by the owner (locked section). (2) The config agent starts from the **yoga starter config** (`fixtures/configs/yoga_starter.yaml`, §4b.2) and the owner's description. (3) All four domains are put in `mirror`. Backfill: classes and bookings from −26 weeks to +90 days, all active members and entitlements, desk shifts −8 to +8 weeks. Then incremental sync starts. (4) Person mapping is built (§18.5); every instructor seen in BookingVendor must be mapped. (5) Preview is seeded from a pseudonymised copy of production and refreshed weekly (§13.1). (6) **Go-live checklist:** zero open drift for 72 h; 100 % of people mapped; config validates with 0 errors; scenario suite green on preview; flags reviewed. (7) **Messaging switch** (`member_messaging: kairos`): in one step, BookingVendor's member notifications are switched off (except payment receipts for charges BookingVendor itself makes, until the bookings and members cutovers), and the flag `messaging.kairos_members` is turned on. Then `live` | Mirror writes are write-through only |
| **Change** | New studio: config ops add a location, rooms and layouts → publish (§6). Domain cutovers: §3A.18. Commercial plan for Kairos itself: out of scope (A-14) | — |
| **Offboard** (`offboarding`) | (1) The owner requests it (`POST /tenant/offboard`, a `tenant_offboard` proposal under the two-person rule). Export starts: NDJSON per table plus every config version plus the audit archive, delivered as a signed URL valid for 7 days, with a manifest of row counts and a SHA-256 per file. (2) Mode: **hand back** (domains rolled back to `mirror` per §3A.18 where the outside systems still exist) or **close**. (3) On close, a saga: future sessions are cancelled with reason `tenant_closed` (§3A.9.4); members are notified 14 days ahead (`tenant.closing_notice`); waitlists end; future shifts are vacated without a substitute search. (4) Tokens: token exchange refuses the tenant; service and agent client credentials are revoked; gateway routes and inbound webhooks are removed through the gateway's admin contract; per-object stores are drained. (5) `closed`; `delete_after = closed_at + 30 days` | Open entitlement balances are listed in the export for the tenant's own settlement. Kairos holds no funds |
| **Delete** | At `delete_after`, if `legal_hold = false`: the per-tenant data key is destroyed (crypto-shredding), the databases and object storage are deleted, and a signed deletion certificate (tenant, time, resources deleted, key ID) goes into the platform's audit archive → `deleted`. A legal hold blocks deletion until the platform owner lifts it | — |

| Row | Rule |
|---|---|
| Notify | `tenant.closing` at offboard approval [`tenant_closing`]; then the session-cancel events of §3A.9.4 |
| Outside | Close: owned domains push their cancellations (C4); hand back: §3A.18 rollback per domain |
| Audit | The offboard proposal, both approvers, the export manifest hash, each revocation, the deletion certificate. Never pruned (§13.4) |
| Failure | The close is a saga (C6): each step (cancel sessions per day, revoke credentials, remove routes) resumes after a failure. Deletion runs only once every step is `done`. A failed gateway route removal is retried and pages after 12 h; deletion waits for it |

## 3A.4 Studio (location)

- **Open:** a config op adds the location with its IANA zone, opening hours, rooms and desk → publish (§3A.17).
- **Time-zone change** (rare; a data correction): a config op. The impact plan keeps local wall time for future sessions and recomputes UTC (the tzdb-rebase mechanism, §7.10). Conflicts are listed for resolution.
- **Permanent closure:** a config op removes the location. The impact plan forces a resolution for every future session: cancel (§3A.9.4), or move to another studio with member opt-in. Members whose `home_location_key` was this studio get null. People lose the location from `location_keys`.
- **Planned holidays** use config `availability` closed dates and go through the impact plan (§6.8).

### 3A.4.1 Temporary closure

| Row | Rule |
|---|---|
| Trigger | `POST /locations/{key}/closures {start, end, reason, preview?}` by a manager of that studio, owner or admin. `preview: true` returns the impact (sessions, bookings, shifts, hours) without committing |
| State changes | Saga (C6), one step per affected session, in start order: the class or shift session is cancelled per §3A.9.4 with reason `closure`. A final step records the `closure` row |
| Dependants | Classes: §3A.9.4. Desk shifts: §3A.10.4. Hours: voided, unless the closure is created less than `tenant.closure_pay_notice` before the session start, in which case `pay_protected` (§3A.16) |
| Notify | Per session: `session.cancelled{reason: closure}` [`no_sub_notice` for members, owned bookings only; `desk_vacated` is not triggered because shifts are cancelled, not vacated]; `assignment.released{reason: session_cancelled}` for staff [`staff_session_cancelled`] |
| Outside | Classes: M/S write-through cancel per class if supported, else one task per class; O native + push. Shifts: per §3A.10.4 |
| Failure | A failed step (for example a write-through cancel that BookingVendor refuses) leaves the earlier steps committed. It is retried by the saga sweep; after 5 failures the step is parked, the class keeps its state, and a task "cancel in BookingVendor" is created. The closure response lists parked steps |

## 3A.5 Room and mat spot

- **Add / retire:** a config op with an impact plan (§6.8).
- **Layout change while bookings exist:** the impact plan re-seats each affected booking on a spot with equal attributes, otherwise the best free spot, otherwise cancels it with a refund (`studio_cancel`). Each re-seat emits `booking.reseated`, and each cancel emits `booking.cancelled{reason: config_migration}`.

### 3A.5.1 Out of service for a time (block)

| Row | Rule |
|---|---|
| Trigger | `POST /resources/{id}/blocks {start, end, reason, preview?}` (manager; desk for mats). `DELETE /resources/{id}/blocks/{blk}` ends it early |
| State changes | *Mat:* one batch per affected session: places in the window → `disabled`; each booking on them is re-seated (equal attributes, then best free) through `release_place` for the old place; with no free place, the booking is cancelled as a studio cancel (§3A.9.4 rules for that booking only). *Room:* a `ResourceBlock` and its claim are written; overlapping classes → `needs_resource`; the engine creates an `assignment_change` proposal for a free room of the same type with capacity ≥ `booked_count` |
| Dependants | Holds on a disabled place are released (`place.released{reason: block}`). Waitlists unchanged. If no room proposal is approved by `unstaffed.check_at`, the class is cancelled by the unstaffed timer (§3A.9.5) with reason `no_room` |
| Notify | `booking.reseated` [`reseat_notice`]; `session.needs_resource` [`room_needed`]; studio-cancel events as §3A.9.4 |
| Outside | M/S: write-through room or capacity change if supported, else task. O: native + push |
| Unblock | Deleting the block re-enables places; re-seated bookings stay where they are |
| Failure | Each session is its own batch inside a saga; a failure leaves earlier sessions done, and the sweep resumes |

## 3A.6 Staff member

| Stage | Behaviour |
|---|---|
| **Onboard** | The staff directory emits `person.created` (delivered through the gateway; a nightly sync is the backstop). Kairos creates the person resource with `staff_key`, platform roles from `access.role_mappings`, config staff roles (`teacher`, `desk_staff`) from `access.staff_role_mappings` (§4.13), both re-applied on every sync, and `home_location_key` from the directory's location attribute. A manager completes skills and certifications with expiry dates (`PATCH /resources/{id}`), `payroll_ref`, `payroll_type` and the calendar-sync opt-in. The person sets availability in the portal. They are eligible for rosters once they have ≥ 1 role and an availability record. The person is linked to BookingVendor's instructor ID through person mapping. Events: `person.created`; the first confirmed assignment emits `assignment.confirmed{first: true}` [`staff_welcome`] |
| **Role or skill change** | Effect on eligibility is immediate. In one batch per affected future assignment that no longer passes the validator: assignment → `released` with reason `skill_lost`, claim released, hours voided, session → `needs_staff`, `assignment.vacated` → substitute flow (classes, owned) or `desk_vacated` (shifts). **Certification expiry:** a nightly job emits `skill.expiring` 30 days before [`skill_expiring`], and at expiry treats it as a removal |
| **Leave of absence** | A `TimeOff` with `reason: leave_of_absence`. It needs manager approval, then has the same effect as a sick call over the range (§3A.11.2) |
| **Availability change** | Future assignments outside the new availability are **flagged** to the manager (`assignment.flagged{reason: availability}`) [`assignment_flagged`], not vacated |
| **Move studio** | `location_keys` changes; future assignments at the old studio are flagged as above |
| **Offboard (planned)** | The directory or a manager sets `leaves_at` → state `leaving`. At `leaves_at` the immediate-offboard card runs with `effective = leaves_at` |
| **History and rehire** | The resource row, assignments, hours and audit are kept (payroll and audit). Personal fields (phone, personal email) are erased 90 days after offboarding unless a legal hold applies. Rehire (`POST /resources/{id}/reactivate`) reactivates the same resource through the same `staff_key`; skills must be re-verified |

### 3A.6.1 Offboard (immediate)

| Row | Rule |
|---|---|
| Trigger | `person.deactivated` from the directory, or `POST /resources/{id}/deactivate {effective: now, reason}` by a manager of the person's studios, owner or admin |
| State changes | One batch: person → `inactive`; for every **owned** assignment starting after `effective`: assignment → `released` (reason `offboarding`), claim released, hours voided, session → `needs_staff`; swaps from or to the person → `withdrawn`; requested time off → `cancelled`; open substitute offers **to** the person → `withdrawn` (`end_reason: person_inactive`); pending proposals that would assign them → `rejected` (`person_inactive`). Records up to `effective` stay and are flagged `final` |
| Dependants | Class sessions → substitute flow (§3A.14); a session starting within 2 h also gets a manager task. Desk shifts → `desk_vacated`. Members' bookings are unaffected |
| Notify | `person.deactivated`, `assignment.vacated{reason: offboarding}` per assignment [`sub_finder`, `desk_vacated`] |
| Outside | Classes M/S: per assignment, task "reassign in BookingVendor"; the mirrored claims stay until BookingVendor changes them. Shifts M/S: write-through. O: native + push. Calendar sync events after `effective` are deleted (outbox) |
| Audit | The deactivation source (directory event ID or manager), every released assignment ID |
| Failure | Token exchange refuses new tokens at once. Existing staff JWTs are refused because `state` is checked on every request (cached ≤ 60 s); agent tokens acting for the person die within 15 min and are also checked against `state`. If the batch would exceed 100 statements, it becomes a saga whose first step sets `inactive` (so tokens stop at once) and whose later steps release assignments in start order |

## 3A.7 Member (customer)

| Stage | Behaviour |
|---|---|
| **Account** | A member token with an unknown `sub` creates a `Customer`. It is linked to a mirrored member by verified email; a match on several records creates a manager task. **Guest/walk-in** without an account: the desk creates a `Customer` with `member_subject = null`. When the person later signs up, the account links by email, and a merge happens if needed |
| **First booking** | The policy may require intake fields and a signed **waiver** (`consent` custom field `liability_waiver`, `required_if: true`). Missing ones → `INTAKE_REQUIRED`. The member signs on the website before confirming; at the desk, staff capture it |
| **Minors** | Out of scope for v2.0 online booking (D-31). A member whose recorded age is under 18 is blocked with `NOT_ELIGIBLE` and the message "Under-18s must book at the desk". The desk may book them as a guest, and a guardian waiver is captured as a custom field |
| **Duplicates (merge)** | `POST /customers/{id}/merge {into}` (manager), a saga: bookings, waitlist entries, entitlements and history move to the target. Conflicting bookings for the same session keep the earlier one and cancel the other as timely. Conflicting waitlist entries keep the better position. The losing record gets `merged_into` and `state = closed`. Event `customer.merged` |
| **Membership start / upgrade** | A purchase creates the entitlement (§3A.15). An upgrade takes effect at once: the new tier applies to new bookings. Existing bookings keep their terms and places, including tier-reserved places |
| **Downgrade** | Takes effect at the next billing period. Existing bookings in tier-reserved partitions are kept |
| **Freeze / unfreeze / payment failure / credit expiry** | §3A.15 |
| **Home-studio change** | `PATCH /customers/me {home_location_key}`. Display and default filters only |
| **Suspension / ban** | `POST /customers/{id}/suspend {until?, reason, cancel_future}` (manager). New bookings get `ACCOUNT_SUSPENDED`. Waitlist entries → `left` (`end_reason: member_suspended`), open place offers → `withdrawn`. If `cancel_future`, future bookings are cancelled as timely, with refunds per `refund.timely`. `POST /customers/{id}/unsuspend` ends it; nothing is restored automatically. Event `customer.suspended` [`member_suspended`] |
| **Staff who are also members** | `linked_resource_id` links the two identities. Linking needs both tokens: the person starts with a staff token (`POST /resources/me/link-member {customer_id}`), then confirms with that member's token (`POST /customers/me/link-staff {link_id}`); verified emails must match. A linked member's booking is refused with `CUSTOMER_OVERLAP` if it overlaps one of their own confirmed assignments (D-32). Permissions are never merged: a member token grants member rights only |
| **Close account** | `POST /customers/me/close` or `POST /customers/{id}/close`. Future bookings are cancelled as **timely** whatever the time, with refunds per `refund.timely`. Waitlist entries → `left` (`member_closed`). Memberships are cancelled at period end (§3A.15). → `closed`. Event `customer.closed` [`account_closed`] |
| **Data export** | `POST /customers/{id}/export` → JSON of profile, bookings, ledger and consents, delivered within 30 days as a signed link through the notification service (event `customer.export_ready` [`export_ready`]) |
| **Deletion (erasure)** | `POST /customers/{id}/erase`. The record must be `closed` first (closing is automatic). PII and custom-field values are erased and the row is pseudonymised. Bookings, ledger and payment references stay under the pseudonym for financial records (7 years) → `erased` |

| Row | Rule (all member stages) |
|---|---|
| Outside | `members` M/S: merge, suspend, close and freeze are not available in Kairos (the UI links to BookingVendor); erase removes Kairos's mirror copy and creates a task to erase in BookingVendor; bookings cancelled by a close are written through. O: native; memberships are cancelled at the processor through the gateway |
| Audit | Merge (both IDs, moved row IDs), suspension, erasure: never pruned |
| Failure | Merge and close are sagas (C6). A failed booking cancel inside a close is retried; the account becomes `closed` only after the last step. Erasure runs after the close saga is `done` |

## 3A.8 Runtime agents and agent clients

| Stage | Behaviour |
|---|---|
| Provision | An owner registers an agent client (`POST /agents/clients {agent, allowlist}`). A credential is issued to the client's own secret store through the gateway's secret contract |
| Rate limits | §10.1 |
| Kill switch | The flag `agent.<name>.enabled`. When off, the agent's token exchange is refused and open hook runs end with `deadline_passed` at their next step |
| Revocation | `DELETE /agents/clients/{id}` revokes the credential at once. Outstanding tokens die within 15 min, and the client state is checked on every request. Offers created by that client stay valid (they are engine records); proposals it created stay pending for a human |
| Model or prompt changes | Gated by evals (§14.4–14.5) |
| Audit | Registration, allowlist changes, revocation: never pruned |

## 3A.9 Class session

### 3A.9.1 Materialise

| Row | Rule |
|---|---|
| Trigger | Daily job (system `materializer`) keeps `tenant.materialize_horizon` of sessions ahead for every active series; also run by a config publish (§3A.17) and by `POST /sessions` (one-off; manager or desk) |
| State changes | Per session: insert the session (`occurrence_key` unique, I-11) → write the fixed assignments and their claims (room, `fixed` teacher) → create places from the capacity mode (§7.3) → schedule timers (C7): partition releases, minimum attendance, unstaffed, no-show, attended. Status per I-12 |
| Dependants | A roster requirement with no assignment leaves the session `needs_staff`; the next teacher solve fills it. A fixed claim that collides (`RESOURCE_CONFLICT`) leaves that requirement empty and raises a manager task |
| Notify | `session.created` (no reference workflow) |
| Outside | classes M: off. S: dry run compares the occurrence set with the mirror. O: push the new class (ExternalRef written on success) |
| Failure | One batch per session; the job resumes from the last materialised date. A push failure leaves the session in Kairos and raises `push_failed` drift after 3 attempts |

### 3A.9.2 Staff edit "this one": retime, room change, capacity change

| Row | Rule |
|---|---|
| Trigger | `PATCH /sessions/{id}` (`If-Match`; manager of the studio, owner, admin) before the session starts. With `preview: true` the response is the impact: assignments that fail validation, bookings affected, members whose other bookings would overlap, re-seats and cancellations. Without `preview`, the request must carry `acknowledge: [<impact group ids>]` for every non-empty impact group, or it fails with `IMPACT_UNACKNOWLEDGED` |
| State changes | One batch: write the `SessionException` and `detached = true` → **retime**: move every assignment's claim (release + re-claim; validator per person, §8.5) and the room claim, recompute `start`/`end`, re-plan timers and relative workflow triggers (§9.2), update every booking's `session_start` and set `terms.free_cancel_until = max(old, new start)` for each booking (studio-initiated change, D-49) → **room change**: release the old room claim, claim the new one, rebuild places if the layout differs and re-seat bookings (equal attributes, then best free); bookings that can't be seated are cancelled as studio cancels, **newest booking first** → **capacity change**: §7.3 "Live capacity changes" (increase creates places via `release_place`; decrease removes only free places, otherwise `over_capacity = true`) |
| Dependants | An assignment that fails validation after a retime is released in the same batch (`assignment.vacated{reason: session_changed}`, hours voided) unless `keep_assignments_or_fail: true`, in which case the request fails with the validator's reasons. Active holds on the session are released (`place.released{reason: session_changed}`), and a later confirm of such a hold returns `SESSION_CHANGED`. Waitlist entries are kept. Bookings that now overlap a member's other booking are kept and listed in the impact (never auto-cancelled). Hours records move with their assignments |
| Notify | `session.retimed` / `session.room_changed` / `session.capacity_changed` with `data.from` [`session_changed_notice`: members and assigned staff]; `booking.reseated` [`reseat_notice`]; studio-cancel events for bookings that lost their place |
| Outside | classes M/S: write-through retime, room or capacity change if supported, else the request fails with `DOMAIN_NOT_OWNED` and the UI shows the BookingVendor link. O: native + push. Booking-side effects (terms, re-seats, cancels) apply only when bookings are owned (C4) |
| Audit | Old and new times, room and capacity; the acknowledged impact groups |
| Failure | The edit is one batch (≤ 100 statements, A-06). A larger edit (more than about 60 bookings to re-seat) runs as a saga whose first step writes the exception and claims and closes the session to new bookings, and whose later steps re-seat 40 bookings per step. If the saga is parked, the session stays closed to new bookings and a manager task is created |

"This and following" and "all" are config operations (§4.7) and go through §3A.17.

### 3A.9.3 Over capacity

A session with `over_capacity = true` accepts no new holds (`SESSION_FULL`). Freed places are **not** recreated until `booked_count < capacity_total`, and then `release_place` applies. The impact plan for a config capacity cut offers to move the last-booked N to the top of the waitlist with refunds (§6.8).

### 3A.9.4 Cancel (studio cancel)

| Row | Rule |
|---|---|
| Trigger | Built-in unstaffed or minimum-attendance timer (§3A.9.5); `POST /sessions/{id}/cancel {reason}` (manager, owner, admin); closure (§3A.4.1); config migration (§3A.17); `cancel_session` workflow action; tenant close. Only before start; after start, `TOO_LATE_TO_CANCEL` |
| State changes | One batch for the session part: session → `cancelled` with `cancel_reason` → every assignment → `released`, every claim released (I-14) → hours voided or `pay_protected` (§3A.16) → pending timers for the session cancelled. **If `bookings` is owner**, a saga continues, 40 bookings per batch: each `confirmed`/`pending_approval` booking → `cancelled` (studio); ledger `release +n`; price-paid → full refund job (`refund:{booking}:studio`); any late fee already charged for this session → reversal job; limit counters −1; place claims deleted (no `release_place`: the places die with the session) → waitlist entries → `expired` (`end_reason: session_cancelled`), open place offers → `withdrawn` → active holds released. **If `bookings` is not owner** (C4, D-44): Kairos writes no booking, waitlist or ledger rows; the session cancel is pushed, and the outside system cancels and refunds the bookings (confirmed); the mirrored cancellations arrive by sync. Kairos still tells the members (`no_sub_notice`, D-51) |
| Dependants | Assigned staff lose the session; there is no substitute flow. Desk shifts are untouched |
| Notify | `session.cancelled{reason}` [`no_sub_notice`: SMS to the session's customers, including mirrored bookings when bookings aren't owned (D-51)]; `booking.cancelled{reason: studio_cancel}` per booking (owned) [no reference workflow; the session notice covers it]; `assignment.released{reason: session_cancelled}` [`staff_session_cancelled`] |
| Outside | classes O: push the cancel to BookingVendor (`gateway/booking_vendor/classes/{id}/cancel`) with idempotency key `cancel:{session}`. classes M/S: only staff-initiated cancels are possible, by write-through; built-in cancels are off. bookings O: refunds and fee reversals through the payments gateway. bookings M/S: shadow computes the dry-run studio cancel and compares it with the mirrored booking outcome within 30 min |
| Audit | Reason, trigger (timer, actor, migration), counts of bookings cancelled and money jobs created |
| Failure | Session batch aborts → nothing changed, and the timer retries (C7). A booking-saga step failure is resumed by the sweep; the session is already `cancelled`, so no new booking can arrive. **Push failure while bookings aren't owned:** after the third failed attempt (≤ 10 min), `push_failed` drift, an urgent `manager_inbox` task "cancel this class in BookingVendor and tell members", and a staff-chat page through `cross_domain_alert`. Members may otherwise arrive to a cancelled class, so this alert is never rate-limited |

### 3A.9.5 Minimum attendance and unstaffed checks

| Row | Rule |
|---|---|
| Trigger | Timers at `min_attendance.check_at` and `unstaffed.check_at` (classes domain owner; S dry run; M off) |
| Minimum attendance | If `booked_count < min` (counting mirrored bookings when bookings aren't owned): `cancel_session` → §3A.9.4 with reason `under_minimum`; `notify_staff` → event `session.under_minimum` [a tenant workflow; none in §4b.1, whose policy cancels] |
| Unstaffed | If any `roster` requirement is empty, or the room is missing (`needs_resource`): if a **validated `assignment_change` proposal is pending** for that requirement, defer once to `min(proposal.expires_at, start − 30m)` and emit `proposal.urgent` [`approval_urgent`]. Otherwise, or when the deferral ends: `cancel_session` → §3A.9.4 with reason `no_staff` (or `no_room`); `notify_staff` → event `session.unstaffed` [a tenant workflow; none in §4b.1, whose policy cancels] |
| Failure | A timer that fires late (sweep, ≤ 60 s) runs the same check; a timer that would fire after start does nothing and records `skipped_after_start` |

### 3A.9.6 Start, no-show timer, completion

| Time | What happens (bookings owner; otherwise mirrored state only) |
|---|---|
| `start` | Pending approvals → `rejected` (D-58). `upcoming` limit counters −1 for each counted booking. Waitlist entries still `waiting` or `offered` → `expired` (`session_started`), place offers → `expired` |
| `start + no_show.grace` | Every `confirmed` booking without check-in → `no_show` (§3A.12.8) |
| `end + 15m` | `checked_in` → `attended`, reserve → `consume`. Session → `completed`. Hours records → `worked` (§3A.16). Event `session.completed` |

## 3A.10 Desk-shift session

### 3A.10.1 Candidates and roster publish

| Row | Rule |
|---|---|
| Trigger | `POST /rosters/solve {kind: shifts, scope, horizon}` (manager) → solver job → `roster_publish` proposal → `POST /proposals/{id}/approve` (manager of every studio in scope, or auto-approval where configured) |
| State changes | Saga (§8.7), one batch per person in person-ID order: create the shift sessions that the proposal fills (candidates from `starts`, §4.6) with their desk lane claim → write worker assignments, claims and `resource_day` guards → hours records `scheduled` |
| Dependants | Existing published shifts changed by the proposal are released first in the same person batch. Members are unaffected (`participants: none`, I-13) |
| Notify | `roster.published` [`roster_published`: affected staff], `assignment.confirmed{reason: roster}` |
| Outside | shifts O: push to ShiftTool while `outbound_push` (the 60-day push period, §18.9); calendar events for opted-in staff. S: dry run compares the proposal with ShiftTool's published shifts. M: off |
| Failure | §8.7: a failed person batch compensates the already-applied batches; the proposal → `failed`, listing the conflicting person-days. The staleness guard (§18.6) runs before the first batch |

### 3A.10.2 Manager assign / unassign

`POST /assignments` (validated, §8.5) creates or fills a shift assignment; `DELETE /assignments/{id}` releases it (reason `manager`) → claim released, hours voided, `assignment.vacated{reason: manager}` [`desk_vacated`]. Shifts M/S: write-through to ShiftTool. Failure: C1.

### 3A.10.3 Vacate (sick call, time off, offboarding, skill lost)

As §3A.11.2 for the person; for the shift: assignment → `released`, session → `needs_staff`, `assignment.vacated` [`desk_vacated`: manager task + staff chat]. No automatic substitute search for desk shifts; a manager fills it with a proposal or `POST /assignments`, or runs a repair solve.

### 3A.10.4 Cancel

A shift session is cancelled by a closure or by a manager (`POST /sessions/{id}/cancel`). One batch: session → `cancelled`, assignment → `released`, claims released, hours voided or `pay_protected` (§3A.16). Event `assignment.released{reason: session_cancelled}` [`staff_session_cancelled`]. Shifts M/S: write-through cancel. O: native + push.

### 3A.10.5 Completion

At `end`: session → `completed`; hours records → `worked` (or actuals from time-clock punches, later phase). A worker who did not come is marked by a manager with `PATCH /hours/{id} {state: voided, void_reason: no_show}`.

## 3A.11 Assignment, time off and swaps

### 3A.11.1 Assignment states

`proposed` → `confirmed` (validator + commit) → `released` (vacated, unassigned, session cancelled). Every transition to `confirmed` writes the claim and the hours record (owned domains) in the same batch; every transition to `released` releases both (I-16, I-28b).

### 3A.11.2 Sick call

| Row | Rule |
|---|---|
| Trigger | `POST /time-off {reason: sick, immediate: true, start, end}` by the person (portal, phone app), a manager, or the staff assistant on the person's instruction |
| State changes | One batch: `TimeOff` created directly as `approved` (`decided_by = system`, D-52) → for every overlapping **owned** confirmed assignment: assignment → `released` (reason `sick`), claim released, hours voided, session → `needs_staff`; `affected_assignment_ids` filled |
| Dependants | Members keep their bookings. Class sessions → substitute flow (§3A.14). Desk shifts → `desk_vacated`. More than 3 vacated slots, or slots on more than 1 day, also start a repair solve (§8.6) |
| Notify | `timeoff.submitted{immediate: true}` [`timeoff_notice`: managers of the person's studios]; `assignment.vacated{reason: sick}` [`sub_finder`, `desk_vacated`] |
| Outside | classes M/S: not vacated by Kairos; the portal shows "Arrange cover in BookingVendor"; the mirrored claim keeps blocking that time. shifts M/S: write-through. O: native + push; calendar events deleted |
| Cancel | A sick call can't be rejected. A manager or the person can `cancel` it; this restores availability for future solves but does **not** restore released assignments (a manager re-assigns with a proposal) |
| Failure | One batch, or the saga of §3A.6.1 for more than 100 statements |

### 3A.11.3 Planned time off and leave

| Event | Rule |
|---|---|
| Request | `POST /time-off {reason, start, end}` → `requested`. No effect on assignments or availability. Event `timeoff.submitted` [`timeoff_notice`: managers] |
| Approve | `POST /time-off/{id}/approve` (manager) → `approved`, then the vacate steps of §3A.11.2 for overlapping owned assignments (reason `time_off`). Event `timeoff.approved` [`timeoff_decided`: the person] |
| Reject | `POST /time-off/{id}/reject` → `rejected`. Event `timeoff.rejected` [`timeoff_decided`] |
| Cancel | `POST /time-off/{id}/cancel` by the person or a manager. If it was approved, availability returns; released assignments are not restored |

### 3A.11.4 Swaps

`POST /swaps` → `open` → the counterpart accepts (`POST /swaps/{id}/accept`) → `accepted` → a `swap` proposal is created and validated → manager approves (`POST /swaps/{id}/approve`) → both assignments change in one person-ordered saga → `approved`. `POST /swaps/{id}/reject` (manager) → `rejected`; `POST /swaps/{id}/withdraw` (requester) → `withdrawn`. Events `swap.requested`, `swap.approved`, `swap.rejected` [`swap_notice`]. Classes M/S: swaps of mirrored class assignments are write-through teacher changes, else not available.

## 3A.12 Hold and booking

All of §3A.12 applies when `bookings` is owner. In M/S, members' and desk writes are write-through (§7.12), and timers and penalties are off (§3A.2).

### 3A.12.1 Hold

Trigger `POST /holds` (member, desk, member assistant) or `POST /offers/{id}/accept` (place offer). Batch: §7.5.2. Event `booking.held`. Failure: `PLACE_TAKEN` with alternatives, `SESSION_FULL` with `waitlist_available`, or another pipeline reason (§7.4).

### 3A.12.2 Hold expiry or release

Trigger: SessionGate alarm, the 1-minute sweep, `DELETE /holds/{id}`, or a session change. One batch per session through `release_place` (§7.7): place claim deleted (guarded on holder and expiry) → hold `expired`/`released` → `reserved_for` set if an eligible waiting entry exists (D-59) → `place.released{reason}`. A processor authorisation tied to the hold is voided by an outbox job keyed by the hold ID.

### 3A.12.3 Confirm

Trigger `POST /bookings {hold_id}`. Batch: §7.5.4. Events `booking.confirmed` (or `booking.pending_approval`) [`promoted_notice` when `booked_via = waitlist`]. Price payments: capture after commit (C5). If capture fails for good, the booking is cancelled as a studio cancel for that booking only, the place goes through `release_place`, and `booking.cancelled{reason: payment_failed}` is emitted [`payment_failed_notice`].

### 3A.12.4 Approval

`pending_approval` holds its place and reserved units. `POST /approvals/{id}/decide` → `confirmed` (capture) or `rejected` (release units, void authorisation, `release_place`). A timer applies `on_timeout` at `min(created + approval.timeout, session.start)`; at session start it always rejects (D-58). Events `booking.confirmed` / `booking.rejected` [`approval_decided`].

### 3A.12.5 Timely cancel

`now < terms.free_cancel_until`. One batch: booking → `cancelled`; place claim deleted through `release_place`; ledger `release +n`; limit counters −1; refund per `terms.refund.timely` (`full` → refund job; `credit` → grant one `tenant.refund_credit_product` entitlement in the same batch; `none` → nothing). Event `booking.cancelled` [no reference workflow]. A cancel by an agent is allowed directly (§10.1).

### 3A.12.6 Late cancel

`free_cancel_until ≤ now < start`. One batch: booking → `late_cancelled`; place claim deleted through `release_place`; limit counters −1; the reserve is kept until assessment; a penalty action is scheduled at `terms.late_penalty.assess_at`. Event `booking.late_cancelled`. An agent needs a member-token confirmation (§11.6).

### 3A.12.7 Penalty assessment

Runs immediately or from a timer at session start or end (§7.6). One batch: evaluate `waive_if` (with `booking.place_refilled` computed at that moment) → units: waived → `release`, else `forfeit` if `forfeit_units` → fee job if not waived and `fee_if` → strike rows if not waived → **price-paid late cancel**: if `terms.refund.late = as_timely_if_refilled` and the place is refilled, a refund job per `refund.timely`; otherwise nothing → event `booking.penalty_assessed{waived, fee, refund}` [`penalty_notice`]. Failure: a failed fee job is retried (C5) and never charged twice (key `fee:{booking}:{late|no_show}`).

### 3A.12.8 No-show, attendance, correction

At `start + grace`: one batch per session marks every unchecked `confirmed` booking `no_show` and schedules its penalty at `no_show.assess_at`. Event `booking.no_show`. Corrections: `POST /bookings/{id}/attendance` within 24 h (staff) or a late replay of an offline check-in whose `at` is inside the check-in window → `checked_in`/`attended`, with compensating ledger rows and a fee refund job. Event `booking.attendance_corrected`.

### 3A.12.9 Move

`POST /bookings/{id}/move {to_session_id, place_id?}` only while `now < terms.free_cancel_until` (else `MOVE_NOT_ALLOWED`, D-50). One batch: the new booking passes the full pipeline (§7.4); the old one is cancelled as timely (§3A.12.5); price difference charged or refunded by outbox. Events `booking.cancelled` + `booking.confirmed` with `data.moved_from`.

### 3A.12.10 Check-in

`POST /check-ins {booking_id, client_key}` inside `check_in.opens`–`closes`: booking → `checked_in`. The desktop app queues check-ins offline by `client_key` (the only write that queues during an outside outage, §7.12). Event `booking.checked_in`.

## 3A.13 Waitlist entry and place offer

| Event | Rule |
|---|---|
| Join | `POST /sessions/{id}/waitlist` when §7.7 "Join" holds → `waiting`, `position = max + 1` in the gate batch. Event `waitlist.joined` |
| Leave | `DELETE /sessions/{id}/waitlist/me` → `left` (`end_reason: member_left`); an open place offer for the entry → `withdrawn` |
| Freed place | `release_place` sets `reserved_for` when at least one `waiting` entry could be eligible for the place's partition (evaluated in the read phase, D-59); the gate's next command (or the sweep after 30 s) runs promotion (§7.7) |
| Auto-promote | One batch: booking `confirmed` (`booked_via: waitlist`), entry → `promoted`, `reserved_for` cleared. Event `booking.confirmed` [`promoted_notice`] |
| Skip | Entry → `skipped` with the reason code as `end_reason`. Event `waitlist.skipped` [`skipped_notice`] |
| Offer (offer_all) | Every waiting entry → `offered`; one place `Offer` per entry (`expires_at = now + offer_ttl`, unique open offer per entry, §12.4). Event `waitlist.offered` [`offer_notice`] |
| Offer accept | `POST /offers/{id}/accept`: one batch creates the hold on a reserved place and sets `offer.hold_id` (§7.7). The member confirms with `POST /bookings`. When no reserved place remains: `409 SESSION_FULL`, offer → `withdrawn` (`end_reason: filled`) |
| Offer decline / expiry | Offer → `declined`/`expired`. When every offer has ended: entries → `waiting` (if the session is still full), `reserved_for` cleared. Event `offer.declined` / `offer.expired` |
| Session cancelled / started / retimed | Cancelled: entries → `expired` (`session_cancelled`), offers → `withdrawn`. Started: entries → `expired` (`session_started`). Retimed: entries kept, notified by `session_changed_notice` |
| Member suspended, closed, merged | Entries → `left` (`member_suspended`, `member_closed`); merge keeps the better position (§3A.7) |
| Entitlement lapses | Nothing at once; at promotion the entry is `skipped` (`NO_ENTITLEMENT`) |
| Outside | bookings M: off; mirrored entries are read-only. S: dry run. O: native. Mode transitions: §3A.18 |
| Failure | Promotion is one batch per entry; a failed batch leaves the place reserved, and the sweep retries within 90 s. A failed auto-charge (gateway) skips the entry with `PAYMENT_FAILED` and moves on |

## 3A.14 Substitute offer and proposal

| Event | Rule |
|---|---|
| Vacated teacher slot | `assignment.vacated` (classes owner) → `sub_finder` workflow → H3 run (§10.4) |
| Offer sent | `POST /offers {kind: substitute}` by H3 or a manager → `sent`, unique per (session, requirement, person) while open. Expiry per D-33 (`start − now ≤ 6h` → 10 min, else 20 min, capped at the hook deadline). Event `offer.sent` [`substitute_offer_notice`: to the offer recipient, through the notification service] |
| Accept | `POST /offers/{id}/accept` by the recipient, or H3's `record_reply {interpreted: accept}` on their behalf. **One batch** (D-57): offer → `accepted` (guarded by the unique index "one accepted substitute offer per session and requirement", §12.4) → `Proposal{assignment_change}` created and validated (§8.5) with `offer.proposal_id` set → every other open offer for the slot → `withdrawn` (`end_reason: filled`). A concurrent second accept violates the index → `409 OFFER_FILLED`, and that offer → `withdrawn`. Events `offer.accepted`, `proposal.created` [`approval_needed`: approvers], `offer.withdrawn{reason: filled}` per withdrawn offer [`substitute_filled_notice`] |
| Validation fails at accept | The proposal is created with `validation.ok = false` and immediately → `failed`; the offer → `lapsed` (`proposal_failed`); outreach continues |
| Approve | `POST /proposals/{id}/approve` (manager; auto-approval if `substitute.auto_approve` and every soft rule passes). Re-validated (I-27) → assignment `confirmed`, claim, hours record, session → `scheduled`. Event `assignment.confirmed{reason: substitute}` [`sub_assigned_notice`: members, owned bookings only] |
| Reject / fail / expire | Proposal → `rejected` / `failed` (`RESOURCE_CONFLICT`, `STALE_VERSION`) / `expired` (at `expires_at`, I-28a); in the same batch the offer → `lapsed`, which frees the unique index. Event `proposal.decided` / `proposal.expired`; H3 resumes outreach |
| Decline / expire / withdraw | Offer → `declined` / `expired` / `withdrawn`. Event `offer.declined` / `offer.expired` |
| Session cancelled | Open offers → `withdrawn` (`session_cancelled`), pending proposals → `rejected` (`session_cancelled`) |
| Outside | Needs classes owner. M/S: no substitute flow (§3A.2); a manager uses BookingVendor |
| Failure | Accept is one batch. An H3 run that crashes is resumed from its last tool call by `kairos-agent` (the run log is the saga). Offers keep their own expiry whatever happens to H3 |

## 3A.15 Entitlement

| Event | Rule |
|---|---|
| Grant / purchase | members O: `POST /entitlements {customer_id, product_key, processor_ref}` after the processor confirms payment (or a subscription webhook through the gateway). One batch: entitlement `active`, balances, `grant` ledger rows. Event `entitlement.granted` [`entitlement_notice`]. members M/S: mirrored from BookingVendor |
| Renewal | A processor renewal webhook → new period: `expire` the unused limited balance unless `rollover`, `grant` the new amount, `period_start` updated. Event `entitlement.renewed` |
| Freeze / unfreeze | `POST /entitlements/{id}/freeze {from, until}` within `product.freeze` limits → `frozen` during the window. Bookings in the window: `on_existing: keep` (stay paid) or `cancel_timely` (each cancelled per §3A.12.5). Unfreezing early ends the freeze; balances unchanged. Event `entitlement.frozen` |
| Payment failure | A dunning webhook → `past_due` (`past_due_since`). New bookings are covered until `dunning_grace` ends, then `NO_ENTITLEMENT`. Existing bookings are kept. Recovery → `active`. Event `entitlement.past_due` [`past_due_notice`] |
| Expiry | At `ends_at`: `expire` ledger row for the remaining balance → `expired`. Bookings already reserved keep their reserve. Event `entitlement.expiring` 7 days before [`expiring_notice`] |
| Cancel | `POST /entitlements/{id}/cancel {at: period_end \| now}` (member for own membership; manager) → processor subscription cancelled through the gateway; `cancelled` at the chosen time. Future bookings paid by it after that time are cancelled as timely |
| Adjust | `POST /entitlements/{id}/adjust` (bounded by role) or a `credit_adjust` proposal → `adjust` row |
| Outside | members M/S: all of the above are mirrored from BookingVendor and the processor. While bookings is owner and members is mirror, debits are written through as a saga (§18.5) |
| Failure | Webhooks are deduplicated (§12.6). A grant whose processor confirmation is missing after 15 min is not created; the member sees `PAYMENT_REQUIRED` |

## 3A.16 Hours record

| Event | Rule |
|---|---|
| Create | In the batch that confirms an assignment in an **owned** domain: desk shifts from the shifts cutover, teaching from the classes cutover (D-54). Mirrored assignments never get hours records. `scheduled` |
| Retime | Updated in the batch that moves the assignment's claim |
| Vacate | `voided` (`vacated`) in the batch that releases the assignment; a substitute gets a new record |
| Session cancelled | `voided` (`session_cancelled`), unless the cancel is committed less than `tenant.closure_pay_notice` before start: then `pay_protected = true` and the record continues to `worked` (D-55, Q-02) |
| Worked | At session end (or from punches) → `worked` |
| Manager correction | `PATCH /hours/{id} {actual_start?, actual_end?, state?: voided, void_reason?}` (manager) before export; after `exported`, §18.8.4 corrections |
| Approve / export | `POST /hours/{id}/approve` → `approved`; `POST /exports/hours/{id}/mark-submitted` → `exported` (§18.8) |
| Offboarding | Records up to `effective` stay, with `final = true` |
| Audit | Every correction (old and new values, reason) |

## 3A.17 Config version

| Event | Rule |
|---|---|
| Publish | §6.8: stage → pre-activation ops → **activate in one batch** (active pointer, `config_epoch`, audit) → post-activation ops (cancellations, refunds, re-seats, re-planning, materialisation), each idempotent per `(version, op_id)`. Event `config.published` |
| Dependants | Per the impact plan (§6.8); session cancels follow §3A.9.4, re-seats §3A.5 |
| Failure | Post-activation ops that fail 5 times are parked and alerted; they never block activation. `GET /config/versions/{n}/migration` shows parked ops; an owner can retry or resolve them |
| Rollback | §6.9: republish an older document as version n+1; impact computed from n to the target |
| Audit | Never pruned: draft hash, approver, impact resolutions, parked ops |

## 3A.18 Domain-mode transitions

Every transition is a `domain_mode` proposal under the two-person rule (§18.7) and runs under `write_freeze` (≤ 15 min). Gates and procedures are in §18.7. This card defines what happens to items that are **in flight** at the moment of the switch.

**Mirror → shadow.** No data changes. The dry-run decisions start.

**Shadow → owner**

| Domain | In-flight item | Rule |
|---|---|---|
| shifts | ShiftTool's future shifts | Become Kairos sessions and assignments (`source: platform`), keeping their ExternalRef; hours records are created from the cutover date (D-54) |
| shifts | Open ShiftTool swap or time-off requests | Imported as `open` / `requested` |
| classes | Mirrored future sessions | **Adopted** (D-60): matched to a timetable series by (template, studio, local date, local start). A match gets the series' `occurrence_key`. No match → kept as a one-off session (`detached = true`). A series occurrence with no mirrored session is created and pushed |
| classes | Mirrored teacher assignments | Become owned assignments; hours records start (D-54) |
| bookings | Active holds | No new holds during the freeze. Holds already written through may confirm until they expire (≤ `hold_ttl`); the switch waits for the last one |
| bookings | Future bookings | Keep their place and payment. They get `TermsSnapshot{origin: imported_at_cutover}` from the active policy (D-53) |
| bookings | Late cancels and no-shows that happened before the switch | Their penalties belong to BookingVendor; Kairos schedules none |
| bookings | BookingVendor waitlists | Imported in position order as `waiting`. Open BookingVendor offers are treated as expired. Kairos's waitlist schedule applies at once (`release_place` on each free place) |
| members | Entitlements and balances | Imported; balances must match BookingVendor exactly (Phase 5 gate); the ledger starts with one `grant` row per balance (`reason: cutover`) |

**Owner → mirror (rollback)**

| Domain | In-flight item | Rule |
|---|---|---|
| any | Records that exist only in Kairos | Pushed during reconcile; those that can't be pushed are listed for manual entry (§18.7) |
| bookings | Kairos waitlists | Pushed if BookingVendor supports it; otherwise listed and a manager task per session; open place offers → `withdrawn` (`end_reason: rollback`) |
| bookings | Scheduled penalty assessments for events that happened in owner mode | Still run (they are Kairos's decisions); fees go through the payments gateway; the resulting debits are written through |
| classes | Pending substitute proposals and open substitute offers | Proposals → `rejected` (`rollback`), offers → `withdrawn`; a manager task per affected class |
| shifts | Open swaps and pending roster proposals | `withdrawn` / `rejected` (`rollback`) |

| Row | Rule |
|---|---|
| Notify | `domain.mode_changed` [`mode_changed_notice`: owners and managers] |
| Audit | Proposal, both approvers, freeze start and end, reconcile counts, items imported or pushed. Never pruned |
| Failure | If any step of the switch fails, the freeze is lifted with the **old** mode still in force (the mode changes only in the batch that clears the freeze, §18.7). Imports and pushes are idempotent and are re-run on the next attempt |

## 3A.19 Failure and recovery patterns (summary)

| Pattern | Where | Recovery |
|---|---|---|
| Batch abort | Every write | Nothing committed; the client retries with the same idempotency key (C1) |
| Outbox job failure | Money, pushes, notifications, calendar | Retry schedule, then `dead` + task; money pages (C5) |
| Saga step failure | Closure, studio-cancel bookings, roster publish, merge, close account, tenant close, large session edits | Sweep resumes from the last step; parked after 5 failures with a task; compensations per card (C6) |
| Timer missed | All built-in timers | 1-minute sweep; re-check at fire time (C7) |
| Gate outage | Holds, promotion | Database still enforces; sweeps take over (§7.5, §7.7) |
| Outside outage (mirror) | Write-through | `OUTSIDE_UNAVAILABLE`, never queued except check-ins (§7.12) |
| Push failure (owner) | Pushes | `push_failed` drift after 3 attempts; urgent for session cancels (§3A.9.4) |
