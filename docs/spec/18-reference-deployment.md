# 18. Reference deployment: the multi-studio yoga tenant

## 18.1 The tenant today

| Item | Today |
|---|---|
| Business | "Lotus & Line Yoga": 3 studios in Brooklyn (`park_slope`, `williamsburg`, `dumbo`), all `America/New_York` |
| Rooms | Park Slope: Studio 1 (30 mats), Studio 2, heated (24 mats). Williamsburg: one studio (36 mats). Dumbo: one studio (28 mats) |
| People | About 40 instructors and about 25 desk staff. Some people do both, which is the case that matters most here |
| Outside systems | **BookingVendor** (the record for classes, bookings, members, memberships and payments); **ShiftTool** (desk shifts); **PayrollCo** (pays staff) |
| Front ends | Public website (members and visitors), desk operations app (web + desktop at each front desk), staff portal (web + phone app) |
| Shared services | member sign-in, staff sign-in, gateway, notification service, help-article base, typed service contracts |

Gateway system keys used below: `booking_vendor`, `shift_tool`, `payroll`, `payments` (the card processor), `calendar` (staff calendar sync), `llm` (model provider).

## 18.2 Reference tenant config (abridged; the full file is `fixtures/configs/lotus_line.yaml`)

The excerpt below has every element that matters to the acceptance test and the front ends. The omitted parts follow §4b.2, apart from tenant-specific values.

```yaml
schema_version: "1.0"
tenant: { name: "Lotus & Line Yoga", default_timezone: America/New_York, currency: USD, locale: en-US,
          week_starts: mon, hold_ttl: 5m, materialize_horizon: 4w, customer_label: member,
          environment_guards: { preview_outbound: sandbox } }
locations:
  - { key: park_slope, name: "Park Slope", timezone: America/New_York,
      transfer_times: [{ to: williamsburg, duration: 40m }, { to: dumbo, duration: 30m }] }
  - { key: williamsburg, name: Williamsburg, timezone: America/New_York,
      transfer_times: [{ to: park_slope, duration: 40m }, { to: dumbo, duration: 30m }] }
  - { key: dumbo, name: Dumbo, timezone: America/New_York,
      transfer_times: [{ to: park_slope, duration: 30m }, { to: williamsburg, duration: 30m }] }
units: [{ key: class_credit, name: "Class credit" }]
skills:
  - { key: ryt200, name: "RYT-200", expires: false }
  - { key: hot_cert, name: "Hot yoga certification", expires: true }
  - { key: cpr, name: "CPR/First aid", expires: true }
roles:
  - { key: instructor, name: Instructor, implies_skills: [ryt200] }
  - { key: desk, name: "Front desk" }
tiers: [{ key: member, name: Member, rank: 1 }, { key: unlimited, name: Unlimited, rank: 2 }]
resource_types:
  - { key: staff, name: Staff, kind: person, attributes: [] }
  - { key: studio, name: Studio, kind: space, attributes: [{ key: heated, type: bool, default: false }] }
  - { key: front_desk, name: "Front desk", kind: space, attributes: [], default_concurrency: 2 }
  - { key: mat, name: "Mat spot", kind: spot, attributes: [{ key: row, type: int }, { key: by_wall, type: bool, default: false }] }
resources:
  - { key: ps_studio_1, type: studio, name: "Park Slope Studio 1", location: park_slope, layout: mats_30 }
  - { key: ps_studio_2, type: studio, name: "Park Slope Studio 2 (hot)", location: park_slope, tags: [heated],
      attributes: { heated: true }, layout: mats_24 }
  - { key: wb_studio, type: studio, name: "Williamsburg Studio", location: williamsburg, layout: mats_36 }
  - { key: db_studio, type: studio, name: "Dumbo Studio", location: dumbo, layout: mats_28 }
  - { key: ps_desk, type: front_desk, name: "Park Slope desk", location: park_slope, concurrency: 2 }
  - { key: wb_desk, type: front_desk, name: "Williamsburg desk", location: williamsburg, concurrency: 2 }
  - { key: db_desk, type: front_desk, name: "Dumbo desk", location: dumbo, concurrency: 1 }
layouts:
  - { key: mats_30, spot_type: mat, grid: { rows: 5, cols: 6 }, generate: { prefix: mat_, label: "Mat {n}", count: 30, per_row: 6 },
      overrides: [{ match: { keys: [mat_1, mat_6, mat_7, mat_12] }, attributes: { by_wall: true } }] }
  - { key: mats_24, spot_type: mat, grid: { rows: 4, cols: 6 }, generate: { prefix: mat_, label: "Mat {n}", count: 24, per_row: 6 } }
  - { key: mats_36, spot_type: mat, grid: { rows: 6, cols: 6 }, generate: { prefix: mat_, label: "Mat {n}", count: 36, per_row: 6 } }
  - { key: mats_28, spot_type: mat, grid: { rows: 4, cols: 7 }, generate: { prefix: mat_, label: "Mat {n}", count: 28, per_row: 7 } }
templates:
  - key: vinyasa_60
    name: "Vinyasa 60"
    kind: class
    tags: [class, flow]
    duration: 60m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: assigned, requirement: room, auto_assign: true } }
    requirements:
      - { key: room, select: { type: studio }, assign: fixed, provides_layout: true, buffers: { after: 15m } }
      - { key: instructor, select: { role: instructor }, assign: roster, buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 3000, currency: USD } }
    policy: class_policy
  - key: hot_75
    name: "Hot 75"
    kind: class
    tags: [class, hot]
    duration: 75m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: assigned, requirement: room, auto_assign: true } }
    requirements:
      - { key: room, select: { type: studio, tags_all: [heated] }, assign: fixed, provides_layout: true, buffers: { after: 20m } }
      - { key: instructor, select: { role: instructor, skills_all: [hot_cert] }, assign: roster, buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 3200, currency: USD } }
    policy: class_policy
  - key: desk_open
    name: "Desk – opening"
    kind: shift
    tags: [desk, opening]
    duration: 6h30m
    scheduling: { mode: rostered, allowed_starts: ["06:15"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
  - key: desk_mid
    name: "Desk – mid"
    kind: shift
    tags: [desk]
    duration: 4h
    scheduling: { mode: rostered, allowed_starts: ["11:00", "16:00"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
  - key: desk_close
    name: "Desk – closing"
    kind: shift
    tags: [desk, closing]
    duration: 8h30m
    scheduling: { mode: rostered, allowed_starts: ["12:45"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
timetable:   # used once the classes domain is owned (§18.9 phase 3); in mirror mode, sessions come from BookingVendor
  - { key: ps_vinyasa_0700, template: vinyasa_60, location: park_slope, rrule: "FREQ=DAILY", start_local: "07:00",
      valid_from: "2027-03-01", fixed: { room: ps_studio_1 } }
  - { key: ps_hot_1800, template: hot_75, location: park_slope, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH", start_local: "18:00",
      valid_from: "2027-03-01", fixed: { room: ps_studio_2 } }
  # … 120 further series across the three studios
coverage:
  - { key: ps_desk_cover, location: park_slope, role: desk, shift_templates: [desk_open, desk_mid, desk_close],
      pattern: [{ days: [mon, tue, wed, thu, fri], from: "06:30", to: "21:15", min: 1, target: 1 },
                { days: [mon, tue, wed, thu], from: "17:00", to: "20:00", min: 2 },
                { days: [sat, sun], from: "07:30", to: "18:00", min: 1, target: 2 }], level: hard, weight: 100 }
  # wb_desk_cover, db_desk_cover: same shape
constraints:
  - { key: no_overlap_transfer, description: "Staff need travel time between studios", level: hard,
      applies_to: { roles: [instructor, desk] }, rule: { type: transfer_time } }
  - { key: desk_week, description: "Desk staff: max 40 h/week across desk and teaching", level: hard,
      applies_to: { roles: [desk] }, rule: { type: max_hours, window: week, hours: 40 } }
  - { key: desk_rest, description: "10 h rest between a closing and an opening shift", level: hard,
      applies_to: { roles: [desk] }, rule: { type: min_rest, duration: 10h } }
  - { key: teach_day, description: "Instructors teach at most 4 classes a day", level: hard,
      applies_to: { roles: [instructor] }, rule: { type: max_assignments, window: day, count: 4 } }
  - { key: fair_desk, description: "Share closing shifts", level: soft, weight: 80,
      applies_to: { template_tags: [closing] }, rule: { type: fairness, metric: closing_shifts } }
  - { key: prefs, description: "Respect availability preferences", level: soft, weight: 150,
      applies_to: { roles: [instructor, desk] }, rule: { type: preferences } }
  - { key: keep_published, description: "Avoid changing published rosters", level: soft, weight: 400,
      applies_to: { roles: [instructor, desk] }, rule: { type: stability } }
policies:
  - key: class_policy
    name: "Class terms"
    booking_window: { opens: { before_start: 14d }, closes: { before_start: 0m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 12h }
      late: { forfeit_units: true, fee: { minor: 1000, currency: USD },
              fee_if: "booking.entitlement != null && booking.entitlement.kind == 'membership'",
              waive_if: "booking.place_refilled", assess_at: session_start }
      no_show: { forfeit_units: true, fee: { minor: 1500, currency: USD },
                 fee_if: "booking.entitlement != null && booking.entitlement.kind == 'membership'",
                 assess_at: session_end, grace: 10m }
    limits: [{ key: daily, window: day, max: 2, message: "Up to 2 classes per day." }]
    waitlist: { enabled: true, max_size: 15, require_entitlement: true,
                schedule: [{ until: { before_start: 2h }, mode: auto_promote }, { until: { before_start: 15m }, mode: offer_all }],
                offer_ttl: 15m, place_choice: preferred_then_best }
    check_in: { opens: { before_start: 45m }, closes: { after_start: 10m } }
    customer_overlap: forbid
    retroactive: lenient_only
entitlement_products:
  - { key: unlimited, name: Unlimited, kind: membership, tier: unlimited, grants: [{ unit: class_credit, amount: unlimited }],
      caps: [{ key: two_a_day, window: day, max: 2 }], validity: { anchor: purchase, recurring: true }, priority: 1, sold_by: external }
  - { key: pack_10, name: "10 classes", kind: pack, tier: member, grants: [{ unit: class_credit, amount: 10 }],
      validity: { length: 26w, anchor: purchase, recurring: false }, priority: 2, sold_by: external }
workflows:
  - { key: sub_finder, name: "Find a substitute", trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'instructor'" },
      recheck_at_fire: true,
      actions: [{ type: invoke_hook, hook: substitute_finder, input: { session_id: "session.id", deadline: "session.start - duration('90m')" } }] }
  - { key: no_sub_fallback, name: "No substitute found", trigger: { event: custom.substitute_exhausted }, recheck_at_fire: true,
      actions: [{ type: create_task, list: manager_inbox, title: "No substitute: decide cancel or cover", due: { before_start: 60m } },
                { type: notify, channel: staff_chat, to: { roles: [manager], location: session }, message: no_substitute }] }
  - { key: desk_open_checklist, name: "Opening checklist", trigger: { at: { relative_to: session.start, offset: "+0m", templates: [desk_open] } },
      recheck_at_fire: true,
      actions: [{ type: create_task, list: desk_checklist, title: "Open studio: heat Studio 2, check mats, float till" }] }
  - { key: class_reminder, name: "Class reminder",
      trigger: { at: { relative_to: session.start, offset: "-2h", templates_tagged: [class], for_each: booking } },
      condition: "booking.state == 'confirmed'", recheck_at_fire: true,
      actions: [{ type: notify, channel: push, to: { customer: true }, message: class_reminder }] }
  - { key: offer_notice, name: "Waitlist offers", trigger: { event: waitlist.offered }, recheck_at_fire: false,
      actions: [{ type: notify, channel: sms, to: { customer: true }, message: waitlist_offer }] }
  - { key: cross_domain_alert, name: "Outside system double-booked a person", trigger: { event: sync.drift_detected,
      where: "event.reason == 'cross_domain_conflict'" }, recheck_at_fire: false,
      actions: [{ type: notify, channel: staff_chat, to: { roles: [manager] }, message: cross_domain_conflict },
                { type: create_task, list: manager_inbox, title: "Resolve double-booking between class and desk shift" }] }
views:
  - { key: desk_today, name: "Today", entity: session, roles: [desk, manager],
      columns: [local_start, template.name, assignments.instructor.name, booked_count, capacity_total, waitlist_count],
      filter: "row.location_key in me.location_keys && row.local_date == today(row.zone)", sort: [{ by: start, dir: asc }] }
# access: §4b.0, with staff groups "lotus-managers", "lotus-desk", "lotus-instructors" mapped to manager, desk, instructor
```

The substitute-finder hook emits `custom.substitute_exhausted` when it ends with `exhausted` or `deadline_passed`. The `no_sub_fallback` workflow reacts to it.

## 18.3 Fitting beside the shared services

| Shared service | How Kairos uses it | What Kairos does **not** do |
|---|---|---|
| Member sign-in | Validates member JWTs (JWKS), maps `sub` to `Customer.member_subject`, and links a new subject to a mirrored member by verified email on first sign-in | Store passwords, issue member sessions |
| Staff sign-in | Validates staff JWTs; maps groups to roles (§4.13); maps `sub` to `Resource.staff_key`; the staff directory is synced nightly through the sign-in service's directory API to create and deactivate person resources | Hold staff credentials |
| Gateway | **Every** outbound call: BookingVendor, ShiftTool, PayrollCo, payments, calendar, travel matrix, LLM provider. Kairos calls `https://gateway.internal/{system}/…` with its own service identity, and the gateway attaches the outside credentials. Inbound outside events arrive at `POST /sync/inbound/{system}`, signed by the gateway | Hold any outside system's key |
| Notification service | Workflow `notify` actions, substitute offers and confirmation links all go through `POST /messages { template, channel, recipient_ref, vars, idempotency_key }`. Recipients are passed as references (`customer:cus_…`, `staff:res_…`), and the notification service resolves contact details | Send email, SMS, push or staff chat directly |
| Help-article base | Read by the member and staff assistants (tenant-owned). Kairos's policy text endpoint (`GET /policies/{key}/text`) is the source for *scheduling* policy answers, so articles can't contradict the live config | Store help content |
| Typed contracts | Kairos publishes OpenAPI + JSON Schema event contracts in `packages/contracts`, versioned with semver. Consumers generate clients. Kairos consumes the gateway, notification and sign-in contracts the same way | Read any other service's database, or let others read its own |

**Contract requirements Kairos places on shared services:** dedupe by `Idempotency-Key` for ≥ 7 days (notification service, gateway); signed inbound events with a timestamp (gateway); a preview mode in the gateway that never forwards to production endpoints (§13.1).

## 18.4 The three front ends

None of the front ends holds scheduling logic. Each one renders what the API returns: availability, reasons, alternatives, quotes and confirmations. All writes are API calls. Reason codes come with display messages, so error copy is consistent everywhere.

### Public website (members and visitors)

| Feature | API |
|---|---|
| Class timetable | `GET /sessions?from&to&location&template_tags=class&include=availability` (anonymous: edge-cached; signed-in: personalised eligibility and price) |
| Spot map | `GET /sessions/{id}/places` → grid, place states, partition badges |
| Book | `POST /holds` (place chosen on the map) → show quote and terms → `POST /bookings`. For price payments: the processor's hosted payment step returns an authorisation, which goes to `POST /bookings`. Kairos never sees card data |
| Cancel | `POST /bookings/{id}/cancel?preview=true` → show penalty (if any) → confirm |
| Waitlist | `POST /sessions/{id}/waitlist` with mat preferences |
| Account page | `GET /customers/me`, `GET /bookings?customer_id=me&from=now`, `GET /customers/me/entitlements` |
| Checkout for packs and memberships | **Phases 1–4:** BookingVendor's checkout via its embedded flow (the members domain is mirrored). **Phase 5:** processor checkout + `POST /entitlements` after the processor's webhook through the gateway |
| AI chat assistant | Tenant-owned member support assistant (§18.4.4) |

### Desk operations app (web, and a desktop app at each front desk)

| Feature | API |
|---|---|
| Support inbox | Inbox data is the desk app's own. Kairos supplies context: `GET /customers?query=`, the customer's bookings and entitlements, `GET /decisions/{id}` for "why couldn't I book". Drafts come from H4 through the staff assistant |
| Who is on the desk now | `GET /desk/now?location=` (current and next desk assignments, including people also teaching today) |
| Today's classes and rosters | `GET /sessions?location&from=today&include=assignments,places_summary` + `GET /sessions/{id}/roster` |
| Check-ins | `POST /check-ins`. Walk-ins: `POST /holds` + `POST /bookings` with the `desk` channel. The desktop app keeps an **offline queue** of check-ins with client-generated idempotency keys, replayed when the connection returns. Conflicts (for example the session was cancelled meanwhile) are shown for review. Check-in is the only offline operation |
| Desk checklists and reminders | `GET /tasks?list=desk_checklist&location&due=today`, `POST /tasks/{id}/complete` (tasks created by workflows, §18.2) |

### Staff portal (web, and a phone app)

| Feature | API |
|---|---|
| My desk shifts and teaching schedule | `GET /assignments?resource_id=me&from&to`: both domains in one list, each item marked with its source (`platform` or `mirror`) |
| Shift and class swaps | `POST /swaps` → counterpart accepts → manager approves (`POST /swaps/{id}/approve`). Class swaps while classes are mirrored are written through to BookingVendor on approval |
| Time off and sick calls | `POST /time-off` (`reason: sick, immediate: true` starts §8.7) |
| Availability | `GET/POST /resources/me/availability` |
| Time clock (later phase) | `POST /time-clock/punches` |
| **Managers:** desk roster | `POST /rosters/solve { kind: roster, scope: { roles: [desk] }, horizon }` → review the proposal (coverage, fairness, conflicts) → manual edits (`POST /proposals/{id}/ops`) → `POST /proposals/{id}/approve` = publish |
| **Managers:** instructor schedule | The same, with `scope: { roles: [instructor] }`. Until the classes domain is owned, the solver's result for mirrored classes is a set of **write-through proposals** to BookingVendor (instructor changes per class) |

### 18.4.4 Runtime agents in the reference tenant

**Member support assistant** (website chat, email, SMS; tenant-owned; member principal):

- "Book me into something with Priya on Thursday evening, by the wall if possible" → H1 → `GET /sessions?…` → `POST /holds { place_id: mat_7 }` (a by-wall mat) → booking with a credit while free cancellation is open → **direct** confirm is allowed (§10.1) → reply with the booking and its terms.
- "Cancel tonight's class" (inside 12 h) → `POST /bookings/{id}/cancel?preview=true` → `confirmation` with "$10 late fee unless your mat is re-booked" → confirm card in chat, or a signed link by SMS or email → the member's click redeems it.
- "Why can't I book the 6 pm?" → H2 on the decision ID → for example "You already have 2 classes today (the daily limit)". The next action offered is another session from the trace's alternatives.
- Policy questions are answered from `GET /policies/class_policy/text`, plus articles from the help base for non-scheduling questions.

**Staff assistant** (desk app and portal; staff principal):

- "Who is teaching the 6 pm class?" → `GET /sessions?location&from=18:00&include=assignments` → answer, including the source ("from BookingVendor, last synced 2 min ago").
- "Move Sam to the Dumbo closing shift on Friday" → `POST /proposals` (assignment change) → the validator runs at once → if valid, the manager sees "Approve?"; if not, the reasons (for example `REST_VIOLATION` with Saturday's opening shift).
- Draft replies to inbox messages via H4.

**Substitute finder** (Kairos-hosted, workflow-invoked): §8.7 and §10.4. In mirror mode for classes, the approved proposal's commit writes the instructor change through to BookingVendor (`PATCH gateway/booking_vendor/classes/{id} { instructor }`). The local copy is updated from the response.

## 18.5 Domain modes and data contracts

| Domain | Kairos entities | Outside record (before owner) |
|---|---|---|
| `classes` | sessions of class templates, instructor assignments, room/template mapping | BookingVendor |
| `bookings` | bookings, place claims, waitlist entries, check-ins | BookingVendor |
| `members` | customers, entitlements, ledger, payment references | BookingVendor (and the processor behind it) |
| `shifts` | desk-shift sessions, worker assignments, staff availability, time off, swaps | ShiftTool |

### Contract per mode

| | **mirror** | **shadow** | **owner** |
|---|---|---|---|
| Record of truth | outside system | outside system | Kairos |
| Reads by front ends | Kairos copy (`source = mirror`) | Kairos copy | Kairos |
| Writes by front ends and agents | Kairos API → local pre-checks (permissions, **cross-domain occupancy**) → write-through via gateway → outside answer is final → copy updated from the answer | same as mirror, **plus** Kairos computes its own decision first and logs a `ShadowDisagreement` when outcomes differ | Kairos engine decides and commits. If `outbound_push`, changes are pushed to the outside system through the outbox |
| Inbound refresh | outside events (through the gateway, near real time) + timers: next 14 days every 5 min, days 15–60 hourly, everything nightly | same | only when `outbound_push` (read-after-write verification) |
| Conflicts between copy and outside | outside wins automatically (`auto_resolved`), except `cross_domain_conflict`, which is manual | outside wins; logged | Kairos wins; re-push; `push_failed` drift after 3 attempts |
| Kairos engines' authority | cross-domain occupancy guard on *Kairos-originated* writes only | the same + full shadow evaluation | full |

**Canonical mapped fields** (hashed for drift detection; any other field is ignored):

| Domain | Mapped fields |
|---|---|
| classes | external id, template key (through the class-type mapping), location, room, start (UTC), end (UTC), status, instructor staff key, capacity |
| bookings | external id, class external id, member external id, status, spot label, checked-in flag, booked-at |
| members | external id, email (blind index), membership product key (mapping), status, starts/ends, credit balance |
| shifts | external id, location, start, end, role, staff key, status |

**Mapping tables** in `kairos-sync` translate outside codes into config keys (BookingVendor class type "VIN60" → `vinyasa_60`). An unmapped code creates a `field_mismatch` drift item and stores the record with `template_key = 'unmapped'`. Its claims are still written, so occupancy stays protected.

**Allowed combinations.** A domain may only become `owner` when the domains it depends on are already `owner`:

| Domain | Requires owner of | Reason |
|---|---|---|
| shifts | — | independent |
| classes | — | BookingVendor keeps taking bookings against classes that Kairos pushes out (`outbound_push: true`) |
| bookings | classes | places and holds belong to sessions that Kairos must own |
| members | bookings | the entitlement ledger is debited by bookings. While members is mirrored, owned bookings write debits through to BookingVendor as a saga: hold → debit (idempotent) → confirm, with release on failure |

## 18.6 Drift detection

1. **Event compare:** each inbound event fetches the full record, maps it, hashes the canonical fields, and compares with `external_ref.content_hash` → `field_mismatch` / `missing_local`.
2. **Window scans:** the timers above list outside records for the window and compare ID sets and hashes → `missing_local`, `missing_remote`, `field_mismatch`.
3. **Bucket checksums:** nightly, for each domain and local day for the past 30 and next 60 days, compute `(count, sha256(sorted(external_id ‖ content_hash)))` on both sides (the outside side is computed by Kairos from a listing). Days that differ are drilled into record by record. This catches deletions without events.
4. **Push verification (owner mode with `outbound_push`):** read-after-write for each push → `push_failed` if the outside record doesn't match within 5 min.
5. **Cross-domain conflicts:** mirror ingestion that cannot take every grain → `cross_domain_conflict` (I-18). This is the only drift kind that **always** needs a person, because each side is the record for its own domain.

**Metrics:** drift rate = open items ÷ records in window, per domain. Alerts: any `cross_domain_conflict` (immediately, via the workflow in §18.2); drift rate > 0.5 % for 1 h; any item open > 24 h; outside system unreachable for > 15 min (mirror staleness).

**Staleness guard for staff writes:** before any assignment or roster commit that touches people with mirrored claims, Kairos does a **targeted pull** of the classes window for those people's affected days (≤ 5 s). If BookingVendor is unreachable and the watermark for that window is older than 15 min, the commit is refused with `MIRROR_STALE`. A manager can override this, and the override is audited. This narrows the window in which an outside change that Kairos hasn't seen yet could collide with a new desk shift.

## 18.7 Changing modes and rolling back

All mode changes go through `POST /sync/domains/{d}/mode`, need the owner role, and need **two people** (a second owner or admin approves) for any change into or out of `owner`. Every change is audited and behind a flag `sync.<domain>.<mode>`.

| Transition | Gate | Procedure |
|---|---|---|
| mirror → shadow | drift rate < 0.5 % for 7 days | flip the flag; shadow evaluation starts |
| shadow → owner (cutover) | disagreement rate < 0.2 % over 14 days with **every** disagreement triaged (`expected`, `config_fix` applied, or `outside_bug`); 0 drift items open > 24 h; runbook rehearsed in preview | 1. announce a ≤ 15 min write freeze for the domain (`503 Retry-After` on its writes); 2. drain inbound events; 3. full reconcile of the active window to zero drift; 4. set `owner`, `outbound_push: true`; 5. smoke tests (book, cancel, waitlist, or assign, depending on the domain); 6. lift the freeze |
| owner → mirror (**rollback**) | outside system not retired; push lag < 5 min; 0 open `push_failed` items | 1. write freeze for the domain; 2. drain the domain's outbox (all pushes delivered or failed explicitly); 3. full reconcile: records that exist only in Kairos are pushed, and any that still can't be pushed are listed for manual entry; 4. set `mirror`; 5. re-enable inbound refresh; 6. lift the freeze. Target ≤ 30 min. Bookings made in owner mode stay valid because they now exist in the outside system |
| owner → retired | ≥ 60 days in owner with no rollback; owner sign-off | outside writes stop; `retired = true`; rollback no longer possible (I-04) |

Rollback triggers include an engine defect affecting customers, unrecoverable push failures, or a business decision. Rolling one domain back never forces a rollback of an *independent* domain, but rolling back `classes` requires `bookings` to be in mirror or shadow first (dependency order, §18.5).

## 18.8 Payroll export

- **Hours records** (§3.10) are created when a shift or teaching assignment is confirmed. They move to `worked` after the session ends (or from actual punches once the time clock ships), to `approved` by a manager per pay period, and to `exported`.
- Teaching hours come from class assignments, mirrored or owned. So payroll gets both desk and teaching hours from one place, regardless of domain modes.
- `POST /exports/hours { period_start, period_end }` builds a batch (JSON per the PayrollCo import contract: staff key, date, start, end, elapsed minutes, kind, location) with a stable `batch_id`. It sends the batch through `gateway/payroll/imports` with `Idempotency-Key = batch_id`. Corrections after export go in the next batch as adjustment lines that reference the original record.
- Kairos knows no pay rates, overtime premiums or taxes. It **stops at hours**.

## 18.9 Cutover order for the reference tenant

**Rationale for the order:**

- `shifts` first: staff-facing only, no money, the simplest outside tool. It also delivers the cross-domain guard early.
- `classes` second: the timetable and instructor schedule. Needed before bookings, and lets the instructor rostering and substitute flows run natively.
- `bookings` third: the busiest customer path, after shadow has proved the engine.
- `members` last: the most data, payments and account migration.

| Phase (§15) | classes | bookings | members | shifts | Notes |
|---|---|---|---|---|---|
| 1 | mirror | mirror | mirror | **owner** | Desk roster built and published in Kairos. ShiftTool kept read-only, with `outbound_push: true`, for 60 days, then retired. **This is the acceptance-test configuration** |
| 2 | shadow | shadow | mirror | owner | Kairos computes class and booking decisions in parallel; disagreements are triaged |
| 3 | **owner** | shadow | mirror | owner (retired ShiftTool) | Timetable series in Kairos config; classes pushed to BookingVendor; substitute finder native |
| 4 | owner | **owner** | mirror | owner | Kairos takes bookings; entitlement debits written through to BookingVendor |
| 5 | owner | owner | shadow → **owner** | owner | Processor subscriptions via gateway; BookingVendor read-only for 60 days, then retired |

**The acceptance scenario in phase 1** (detailed in Appendix A.6): Priya teaches Tue 09:00 Vinyasa at Park Slope. The class is mirrored from BookingVendor, and its instructor claim covers 08:50–10:10 including buffers. A manager tries to put Priya on Park Slope "Desk – opening" (06:15–12:45). The person-rule validator finds the overlapping claim and returns `409 RESOURCE_CONFLICT` ("Priya teaches Vinyasa 60 at 09:00, from BookingVendor"). If the validator were bypassed, the occupancy primary key would still abort the batch. The solver never proposes it, because mirrored claims are `fixed_busy` in the IR.
