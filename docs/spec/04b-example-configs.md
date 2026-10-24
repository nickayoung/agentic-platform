# 4b. Example configurations

Two complete documents validate against §4:

- **4b.1:** the reference tenant (three studios with mat maps, a heated room, desk shifts, and instructor rostering).
- **4b.2:** the **yoga starter config**, a single-studio variant with pooled rooms and no mat map. Onboarding uses it as its starting point (§3.12.1).

Both are fixtures (`fixtures/configs/lotus_line.yaml`, `fixtures/configs/yoga_starter.yaml`, §14.2), and both are reproduced here in full.

Neither uses special-case code: the engines read only requirements, capacity, scheduling, cost, policies, constraints and expressions. Appendix A.1 checks 4b.1 line by line.

## 4b.1 Reference tenant: "Lotus & Line Yoga" (three studios)

```yaml
schema_version: "2.0"
tenant:
  name: "Lotus & Line Yoga"
  default_timezone: America/New_York
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 5m
  materialize_horizon: 8w
  customer_label: member
  fee_ceiling: { minor: 5000, currency: USD }
  closure_pay_notice: 2h
  closing_notice: 14d
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: park_slope, name: "Park Slope", timezone: America/New_York,
      transfer_times: [{ to: williamsburg, duration: 40m }, { to: dumbo, duration: 30m }] }
  - { key: williamsburg, name: Williamsburg, timezone: America/New_York,
      transfer_times: [{ to: park_slope, duration: 40m }, { to: dumbo, duration: 30m }] }
  - { key: dumbo, name: Dumbo, timezone: America/New_York,
      transfer_times: [{ to: park_slope, duration: 30m }, { to: williamsburg, duration: 30m }] }
units:
  - { key: class_credit, name: "Class credit" }
skills:
  - { key: ryt200, name: "RYT-200", expires: false }
  - { key: hot_cert, name: "Hot yoga certification", expires: true }
  - { key: prenatal, name: "Prenatal certification", expires: false }
  - { key: cpr, name: "CPR / first aid", expires: true }
roles:
  - { key: teacher, name: "Yoga teacher", implies_skills: [ryt200] }
  - { key: desk_staff, name: "Front desk" }
tiers:
  - { key: member, name: Member, rank: 1 }
  - { key: unlimited, name: Unlimited, rank: 2 }
resource_types:
  - { key: staff, name: Staff, kind: person, attributes: [] }
  - key: studio_room
    name: "Studio room"
    kind: space
    attributes:
      - { key: capacity, type: int, required: true }
      - { key: heated, type: bool, default: false }
  - { key: front_desk, name: "Front desk", kind: space, attributes: [], default_concurrency: 2 }
  - key: mat
    name: "Mat spot"
    kind: spot
    attributes:
      - { key: by_wall, type: bool, default: false }
      - { key: front_row, type: bool, default: false }
resources:
  - { key: ps_studio_1, type: studio_room, name: "Park Slope Studio 1", location: park_slope,
      attributes: { capacity: 30 }, layout: mats_30 }
  - { key: ps_studio_2, type: studio_room, name: "Park Slope Studio 2 (hot)", location: park_slope, tags: [heated],
      attributes: { capacity: 24, heated: true }, layout: mats_24 }
  - { key: wb_studio, type: studio_room, name: "Williamsburg Studio", location: williamsburg,
      attributes: { capacity: 36 }, layout: mats_36 }
  - { key: db_studio, type: studio_room, name: "Dumbo Studio", location: dumbo, tags: [no_map],
      attributes: { capacity: 28 } }
  - { key: ps_desk, type: front_desk, name: "Park Slope desk", location: park_slope, concurrency: 2 }
  - { key: wb_desk, type: front_desk, name: "Williamsburg desk", location: williamsburg, concurrency: 2 }
  - { key: db_desk, type: front_desk, name: "Dumbo desk", location: dumbo, concurrency: 1 }
layouts:
  - key: mats_30
    spot_type: mat
    grid: { rows: 5, cols: 6 }
    generate: { prefix: mat_, label: "Mat {n}", count: 30, per_row: 6 }
    overrides:
      - { match: { rows: [1] }, tags: [front_row], attributes: { front_row: true } }
      - { match: { keys: [mat_1, mat_6, mat_7, mat_12, mat_13, mat_18, mat_19, mat_24, mat_25, mat_30] },
          tags: [by_wall], attributes: { by_wall: true } }
      - { match: { keys: [mat_29, mat_30] }, tags: [walk_in] }
  - key: mats_24
    spot_type: mat
    grid: { rows: 4, cols: 6 }
    generate: { prefix: mat_, label: "Mat {n}", count: 24, per_row: 6 }
    overrides:
      - { match: { rows: [1] }, tags: [front_row], attributes: { front_row: true } }
      - { match: { keys: [mat_23, mat_24] }, tags: [walk_in] }
  - key: mats_36
    spot_type: mat
    grid: { rows: 6, cols: 6 }
    generate: { prefix: mat_, label: "Mat {n}", count: 36, per_row: 6 }
    overrides:
      - { match: { rows: [1] }, tags: [front_row], attributes: { front_row: true } }
      - { match: { keys: [mat_35, mat_36] }, tags: [walk_in] }
templates:
  - key: vinyasa_60
    name: "Vinyasa 60"
    kind: class
    tags: [class, flow]
    duration: 60m
    scheduling: { mode: timetable }
    participants:
      who: customers
      capacity:
        mode: mixed
        base: { mode: assigned, requirement: room }
        partitions:
          - key: front_row_unlimited
            spots: { tags_any: [front_row] }
            eligible_if: "customer.tier == 'unlimited'"
            online: true
            release: { at: { before_start: 24h }, to: general }
          - key: walk_in
            spots: { tags_any: [walk_in] }
            eligible_if: "true"
            online: false
            release: { at: { before_start: 2h }, to: general }
    requirements:
      - { key: room, select: { type: studio_room, where: "!('no_map' in candidate.resource.tags)" },
          assign: fixed, provides_layout: true, buffers: { after: 15m } }
      - { key: teacher, select: { role: teacher }, assign: roster, buffers: { before: 10m, after: 10m } }
    cost:
      payment: units_or_price
      units: [{ unit: class_credit, amount: 1 }]
      price: { minor: 3000, currency: USD }
      price_rules:
        - { when: "customer.history.total.completed == 0", price: { minor: 1500, currency: USD } }
    policy: class_policy
  - key: hot_75
    name: "Hot 75"
    kind: class
    tags: [class, hot]
    duration: 75m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: assigned, requirement: room, auto_assign: true } }
    requirements:
      - { key: room, select: { type: studio_room, tags_all: [heated] }, assign: fixed, provides_layout: true,
          buffers: { after: 20m } }
      - { key: teacher, select: { role: teacher, skills_all: [hot_cert] }, assign: roster,
          buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 3200, currency: USD } }
    policy: class_policy
    intake: { form: hot_waiver, when: "customer.history.tags['hot'].completed == 0" }
  - key: flow_pooled_60
    name: "Flow 60 (Dumbo)"
    kind: class
    tags: [class, flow]
    duration: 60m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: pooled_from_space, requirement: room } }
    requirements:
      - { key: room, select: { type: studio_room, tags_all: [no_map] }, assign: fixed, buffers: { after: 15m } }
      - { key: teacher, select: { role: teacher }, assign: roster, buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 2800, currency: USD } }
    policy: class_policy
  - key: prenatal_60
    name: "Prenatal 60"
    kind: class
    tags: [class, prenatal]
    duration: 60m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: pooled, places: 12 } }
    requirements:
      - { key: room, select: { type: studio_room }, assign: fixed, buffers: { after: 15m } }
      - { key: teacher, select: { role: teacher, skills_all: [prenatal] }, assign: roster, buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 3000, currency: USD } }
    policy: class_policy
    intake: { form: prenatal_intake }
  - key: desk_open
    name: "Desk – opening"
    kind: shift
    tags: [desk, opening]
    duration: 6h30m
    scheduling: { mode: rostered, allowed_starts: ["06:15"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk_staff }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
  - key: desk_mid
    name: "Desk – mid"
    kind: shift
    tags: [desk]
    duration: 4h
    scheduling: { mode: rostered, allowed_starts: ["11:00", "16:00"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk_staff }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
  - key: desk_close
    name: "Desk – closing"
    kind: shift
    tags: [desk, closing]
    duration: 8h30m
    scheduling: { mode: rostered, allowed_starts: ["12:45"] }
    participants: { who: none }
    requirements:
      - { key: worker, select: { role: desk_staff }, assign: roster }
      - { key: desk, select: { type: front_desk }, assign: fixed, occupancy: lane }
timetable:
  # Used once the classes domain is owned (§18.9 phase 3). In mirror mode, sessions come from BookingVendor.
  - { key: ps_vinyasa_0700, template: vinyasa_60, location: park_slope, rrule: "FREQ=DAILY",
      start_local: "07:00", valid_from: "2027-03-01", fixed: { room: ps_studio_1 } }
  - { key: ps_vinyasa_0900, template: vinyasa_60, location: park_slope, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      start_local: "09:00", valid_from: "2027-03-01", fixed: { room: ps_studio_1 } }
  - { key: ps_hot_1800, template: hot_75, location: park_slope, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH",
      start_local: "18:00", valid_from: "2027-03-01", fixed: { room: ps_studio_2 } }
  - { key: wb_vinyasa_1830, template: vinyasa_60, location: williamsburg, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH",
      start_local: "18:30", valid_from: "2027-03-01", exdates: ["2027-12-23"], fixed: { room: wb_studio } }
  - { key: db_flow_1215, template: flow_pooled_60, location: dumbo, rrule: "FREQ=WEEKLY;BYDAY=TU,TH",
      start_local: "12:15", valid_from: "2027-03-01", fixed: { room: db_studio } }
  - { key: ps_prenatal_sat, template: prenatal_60, location: park_slope, rrule: "FREQ=WEEKLY;BYDAY=SA",
      start_local: "11:00", valid_from: "2027-03-06", fixed: { room: ps_studio_1, teacher: "@staff:amara" } }
policies:
  - key: class_policy
    name: "Class terms"
    booking_window: { opens: { before_start: 14d, at_local: "12:00" }, closes: { before_start: 0m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 12h }
      late:
        forfeit_units: true
        fee: { minor: 1000, currency: USD }
        fee_if: "booking.entitlement != null && booking.entitlement.kind == 'membership'"
        waive_if: "booking.place_refilled"
        assess_at: session_start
      no_show:
        forfeit_units: true
        fee: { minor: 1500, currency: USD }
        fee_if: "booking.entitlement != null && booking.entitlement.kind == 'membership'"
        strikes: 1
        assess_at: session_end
        grace: 10m
    refund: { timely: full, studio_cancel: full }
    limits:
      - { key: daily, window: day, max: 2, message: "You can book up to 2 classes per day." }
      - { key: upcoming_member, window: upcoming, max: 8, applies_if: "customer.tier != 'unlimited'",
          message: "You can hold up to 8 upcoming classes." }
    approval: { required_if: "customer.strikes >= 3", approver_roles: [manager, desk], timeout: 4h, on_timeout: reject }
    min_attendance: { min: 3, check_at: { before_start: 2h }, action: cancel_session }
    unstaffed: { check_at: { before_start: 90m }, action: cancel_session }
    waitlist:
      enabled: true
      max_size: 15
      require_entitlement: true
      schedule:
        - { until: { before_start: 2h }, mode: auto_promote }
        - { until: { before_start: 15m }, mode: offer_all }
      offer_ttl: 15m
      place_choice: preferred_then_best
    check_in: { opens: { before_start: 45m }, closes: { after_start: 10m } }
    customer_overlap: forbid
    retroactive: lenient_only
entitlement_products:
  - key: unlimited
    name: Unlimited
    kind: membership
    tier: unlimited
    grants: [{ unit: class_credit, amount: unlimited }]
    caps: [{ key: two_a_day, window: day, max: 2 }]
    validity: { anchor: purchase, recurring: true }
    freeze: { allowed: true, max_per_year: 8w, min: 1w, on_existing: cancel_timely }
    dunning_grace: 3d
    priority: 1
    sold_by: external
  - key: pack_10
    name: "10 classes"
    kind: pack
    tier: member
    grants: [{ unit: class_credit, amount: 10 }]
    validity: { length: 26w, anchor: purchase, recurring: false }
    priority: 2
    sold_by: external
  - key: intro_month
    name: "Intro month (new members)"
    kind: pack
    tier: member
    grants: [{ unit: class_credit, amount: unlimited }]
    caps: [{ key: one_a_day, window: day, max: 1 }]
    validity: { length: 30d, anchor: first_use, recurring: false }
    priority: 0
    sold_by: external
availability:
  - key: ps_hours
    applies_to: { locations: [park_slope] }
    kind: open
    weekly: { mon: [["06:00","21:30"]], tue: [["06:00","21:30"]], wed: [["06:00","21:30"]], thu: [["06:00","21:30"]],
              fri: [["06:00","21:30"]], sat: [["07:30","18:00"]], sun: [["07:30","18:00"]] }
  - key: wb_hours
    applies_to: { locations: [williamsburg] }
    kind: open
    weekly: { mon: [["06:00","21:30"]], tue: [["06:00","21:30"]], wed: [["06:00","21:30"]], thu: [["06:00","21:30"]],
              fri: [["06:00","21:30"]], sat: [["07:30","18:00"]], sun: [["07:30","18:00"]] }
  - key: db_hours
    applies_to: { locations: [dumbo] }
    kind: open
    weekly: { mon: [["07:00","20:30"]], tue: [["07:00","20:30"]], wed: [["07:00","20:30"]], thu: [["07:00","20:30"]],
              fri: [["07:00","20:30"]], sat: [["08:00","16:00"]] }
  - key: holidays
    applies_to: { locations: [park_slope, williamsburg, dumbo] }
    kind: closed
    dates: [{ date: "2027-12-25" }, { date: "2028-01-01" }]
coverage:
  - key: ps_desk_cover
    location: park_slope
    role: desk_staff
    shift_templates: [desk_open, desk_mid, desk_close]
    pattern:
      - { days: [mon, tue, wed, thu, fri], from: "06:30", to: "21:15", min: 1 }
      - { days: [mon, tue, wed, thu], from: "17:00", to: "20:00", min: 2 }
      - { days: [sat, sun], from: "07:30", to: "18:00", min: 1, target: 2 }
    level: hard
    weight: 100
  - key: wb_desk_cover
    location: williamsburg
    role: desk_staff
    shift_templates: [desk_open, desk_mid, desk_close]
    pattern:
      - { days: [mon, tue, wed, thu, fri], from: "06:30", to: "21:15", min: 1 }
      - { days: [sat, sun], from: "07:30", to: "18:00", min: 1 }
    level: hard
  - key: db_desk_cover
    location: dumbo
    role: desk_staff
    shift_templates: [desk_open, desk_mid, desk_close]
    pattern:
      - { days: [mon, tue, wed, thu, fri], from: "07:00", to: "20:30", min: 1 }
      - { days: [sat], from: "08:00", to: "16:00", min: 1 }
    level: hard
constraints:
  - { key: transfer, description: "Staff need travel time between studios", level: hard,
      applies_to: { roles: [teacher, desk_staff] }, rule: { type: transfer_time } }
  - { key: desk_week, description: "Desk staff: at most 40 hours a week, desk and teaching combined", level: hard,
      applies_to: { roles: [desk_staff] }, rule: { type: max_hours, window: week, hours: 40 } }
  - { key: desk_rest, description: "At least 10 hours between a closing and the next opening shift", level: hard,
      applies_to: { roles: [desk_staff] }, rule: { type: min_rest, duration: 10h } }
  - { key: teach_day, description: "Teachers teach at most 4 classes a day", level: hard,
      applies_to: { roles: [teacher] }, rule: { type: max_assignments, window: day, count: 4 } }
  - { key: teach_rest, description: "15 minutes between a teacher's claims", level: hard,
      applies_to: { roles: [teacher] }, rule: { type: min_rest, duration: 15m } }
  - { key: fair_closing, description: "Share closing shifts fairly", level: soft, weight: 80,
      applies_to: { template_tags: [closing] }, rule: { type: fairness, metric: closing_shifts } }
  - { key: fair_teaching, description: "Spread classes fairly", level: soft, weight: 50,
      applies_to: { roles: [teacher] }, rule: { type: fairness, metric: assignments } }
  - { key: keep_regulars, description: "Keep the same teacher on a recurring class", level: soft, weight: 200,
      applies_to: { roles: [teacher] }, rule: { type: continuity } }
  - { key: prefs, description: "Respect availability preferences", level: soft, weight: 150,
      applies_to: { roles: [teacher, desk_staff] }, rule: { type: preferences } }
  - { key: keep_published, description: "Avoid changing published rosters", level: soft, weight: 400,
      applies_to: { roles: [teacher, desk_staff] }, rule: { type: stability } }
workflows:
  - key: sub_finder
    name: "Find a substitute teacher"
    trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'teacher'" }
    recheck_at_fire: true
    actions:
      - { type: invoke_hook, hook: substitute_finder,
          input: { session_id: "session.id", deadline: "session.start - duration('90m')" } }
  - key: desk_vacated
    name: "Desk shift vacated"
    trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'worker'" }
    recheck_at_fire: true
    actions:
      - { type: create_task, list: manager_inbox, title: "Desk shift needs cover", due: { before_start: 2h } }
      - { type: notify, channel: staff_chat, to: { roles: [manager], location: session }, message: desk_shift_open }
  - key: no_sub_notice
    name: "Tell members when a class is cancelled"
    trigger: { event: session.cancelled }
    recheck_at_fire: false
    actions:
      - { type: notify, channel: sms, to: { session_customers: true }, message: class_cancelled,
          vars: { reason: "event.reason" } }
  - key: sub_assigned_notice
    name: "Tell members about a substitute"
    trigger: { event: assignment.confirmed, where: "assignment.requirement_key == 'teacher' && event.reason == 'substitute'" }
    recheck_at_fire: false
    actions: [{ type: notify, channel: push, to: { session_customers: true }, message: substitute_teacher }]
  - key: class_reminder
    name: "Class reminder"
    trigger: { at: { relative_to: session.start, offset: "-2h", templates_tagged: [class], for_each: booking } }
    condition: "booking.state == 'confirmed'"
    recheck_at_fire: true
    actions: [{ type: notify, channel: push, to: { customer: true }, message: class_reminder }]
  - key: promoted_notice
    name: "Waitlist promotion"
    trigger: { event: booking.confirmed, where: "booking.channel == 'waitlist'" }
    recheck_at_fire: false
    actions: [{ type: notify, channel: sms, to: { customer: true }, message: waitlist_promoted }]
  - key: offer_notice
    name: "Waitlist offers"
    trigger: { event: waitlist.offered }
    recheck_at_fire: false
    actions: [{ type: notify, channel: sms, to: { customer: true }, message: waitlist_offer }]
  - key: skipped_notice
    name: "Waitlist skipped"
    trigger: { event: waitlist.skipped }
    recheck_at_fire: false
    actions: [{ type: notify, channel: email, to: { customer: true }, message: waitlist_skipped,
                vars: { reason: "event.reason" } }]
  - key: desk_open_checklist
    name: "Opening checklist"
    trigger: { at: { relative_to: session.start, offset: "+0m", templates: [desk_open] } }
    recheck_at_fire: true
    actions: [{ type: create_task, list: desk_checklist, title: "Open studio: heat Studio 2, set mats, float till" }]
  - key: cross_domain_alert
    name: "Outside system double-booked a person"
    trigger: { event: sync.drift_detected, where: "event.reason == 'cross_domain_conflict' || event.reason == 'unmapped_person'" }
    recheck_at_fire: false
    actions:
      - { type: notify, channel: staff_chat, to: { roles: [manager] }, message: cross_domain_conflict }
      - { type: create_task, list: manager_inbox, title: "Resolve class/desk double-booking or unmapped teacher" }
  - key: tenant_closing
    name: "Tenant closing notice"
    trigger: { event: tenant.closing }
    recheck_at_fire: false
    actions: [{ type: notify, channel: email, to: { all_members: true }, message: studio_closing }]
custom_fields:
  - { key: liability_waiver, label: "Liability waiver", entity: customer, type: consent, required_if: "true",
      visible_to: [desk, manager, member], editable_by: [member, desk], pii: false }
  - { key: hot_ack, label: "I understand the heat risks", entity: booking, type: consent,
      required_if: "'hot' in booking.template.tags && customer.history.tags['hot'].completed == 0",
      visible_to: [desk, manager, member], editable_by: [member], pii: false }
  - { key: due_date, label: "Due date", entity: customer, type: date,
      required_if: "'prenatal' in booking.template.tags",
      visible_to: [instructor, manager], editable_by: [member], pii: true, retention: 52w }
  - { key: injuries, label: "Injuries the teacher should know about", entity: booking, type: long_text,
      visible_to: [instructor, manager], editable_by: [member], pii: true, retention: 26w }
forms:
  - { key: hot_waiver, name: "Hot yoga first class", fields: [hot_ack, injuries] }
  - { key: prenatal_intake, name: "Prenatal intake", fields: [due_date, injuries] }
views:
  - { key: desk_today, name: "Today", entity: session, roles: [desk, manager],
      columns: [local_start, template.name, assignments.teacher.name, booked_count, capacity_total, waitlist_count],
      filter: "row.location_key in me.location_keys && row.local_date == today(row.zone)",
      sort: [{ by: start, dir: asc }] }
  - { key: my_classes, name: "My classes", entity: session, roles: [instructor],
      columns: [local_date, local_start, template.name, booked_count],
      filter: "me.resource_id in row.assigned_resource_ids && row.start >= now",
      sort: [{ by: start, dir: asc }] }
simulation:
  - key: weekday_demand
    source: historical
    horizon: 4w
    seed: 7
    demand:
      - { templates_tagged: [class], per_session: { mean: 22, sd: 7 }, lead_time: { distribution: exponential, mean: 30h },
          cancel_rate: 0.10, late_cancel_rate: 0.04, no_show_rate: 0.03, tier_mix: { unlimited: 0.45, member: 0.55 } }
access:
  issuers:
    - { key: member_auth, audience: member, issuer: "https://id.lotusline.example/members",
        jwks_url: "https://id.lotusline.example/members/.well-known/jwks.json", subject_claim: sub, tenant_claim: tid }
    - { key: staff_auth, audience: staff, issuer: "https://id.lotusline.example/staff",
        jwks_url: "https://id.lotusline.example/staff/.well-known/jwks.json", subject_claim: sub, tenant_claim: tid }
  role_mappings:
    - { issuer: staff_auth, claim: groups, equals: lotus-owners, grant: owner }
    - { issuer: staff_auth, claim: groups, equals: lotus-managers, grant: manager, location_claim: studios }
    - { issuer: staff_auth, claim: groups, equals: lotus-desk, grant: desk, location_claim: studios }
    - { issuer: staff_auth, claim: groups, equals: lotus-teachers, grant: instructor }
    - { issuer: staff_auth, claim: groups, equals: lotus-staff, grant: staff }
  default_member_role: member
```

**Notes**

- The issuer and JWKS hostnames (`id.lotusline.example`) and the directory group names are **placeholders**. The real values come from the tenant's sign-in services at onboarding (Q-11).
- The `walk_in` partition is the last two mats of each layout, tagged `walk_in` (Mats 29–30 in Studio 1, 23–24 in Studio 2, 35–36 in Williamsburg). They are desk-only until 2 h before class, then go to `general`.
- In Studio 1, row 1 is Mats 1–6. Mat 12 is in row 2 and is a wall mat. It is **not** front row.

## 4b.2 Yoga starter config (one studio, pooled, packs only)

This is the onboarding starting point (§3.12.1). It also shows the same schema with no mat map, no desk shifts and no rostering.

```yaml
schema_version: "2.0"
tenant:
  name: "Starter Yoga"
  default_timezone: America/New_York
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 5m
  materialize_horizon: 6w
  customer_label: member
  fee_ceiling: { minor: 5000, currency: USD }
  closure_pay_notice: 2h
  closing_notice: 14d
  environment_guards: { preview_outbound: record_only }
locations:
  - { key: main, name: "Main studio", timezone: America/New_York }
units: [{ key: class_credit, name: "Class credit" }]
skills: [{ key: ryt200, name: "RYT-200", expires: false }]
roles: [{ key: teacher, name: "Yoga teacher", implies_skills: [ryt200] }]
tiers: [{ key: member, name: Member, rank: 1 }]
resource_types:
  - { key: staff, name: Staff, kind: person, attributes: [] }
  - { key: studio_room, name: "Studio room", kind: space, attributes: [{ key: capacity, type: int, required: true }] }
resources:
  - { key: room_1, type: studio_room, name: "Studio", location: main, attributes: { capacity: 20 } }
layouts: []
templates:
  - key: hatha_60
    name: "Hatha 60"
    kind: class
    tags: [class]
    duration: 60m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: pooled_from_space, requirement: room } }
    requirements:
      - { key: room, select: { type: studio_room }, assign: fixed, buffers: { after: 15m } }
      - { key: teacher, select: { role: teacher }, assign: fixed, buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 2500, currency: USD } }
    policy: simple
timetable:
  - { key: weekday_0730, template: hatha_60, location: main, rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      start_local: "07:30", valid_from: "2027-01-04", fixed: { room: room_1, teacher: "@staff:owner" } }
policies:
  - key: simple
    name: "Simple terms"
    booking_window: { opens: { before_start: 7d }, closes: { before_start: 0m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 6h }
      late: { forfeit_units: true, assess_at: immediately }
      no_show: { forfeit_units: true, assess_at: session_end, grace: 10m }
    refund: { timely: credit, studio_cancel: full }
    limits: []
    unstaffed: { check_at: { before_start: 1h }, action: notify_staff }
    customer_overlap: forbid
    retroactive: lenient_only
entitlement_products:
  - { key: pack_5, name: "5 classes", kind: pack, tier: member, grants: [{ unit: class_credit, amount: 5 }],
      validity: { length: 12w, anchor: purchase, recurring: false }, priority: 1, sold_by: platform,
      price: { minor: 11000, currency: USD } }
availability: []
constraints: []
coverage: []
workflows:
  - key: cancelled_notice
    name: "Class cancelled"
    trigger: { event: session.cancelled }
    recheck_at_fire: false
    actions: [{ type: notify, channel: email, to: { session_customers: true }, message: class_cancelled }]
custom_fields:
  - { key: liability_waiver, label: "Liability waiver", entity: customer, type: consent, required_if: "true",
      visible_to: [desk, manager, member], editable_by: [member, desk], pii: false }
forms: []
views: []
simulation: []
access:
  issuers:
    - { key: member_auth, audience: member, issuer: "https://id.example.com/members",
        jwks_url: "https://id.example.com/members/.well-known/jwks.json", subject_claim: sub, tenant_claim: tid }
    - { key: staff_auth, audience: staff, issuer: "https://id.example.com/staff",
        jwks_url: "https://id.example.com/staff/.well-known/jwks.json", subject_claim: sub, tenant_claim: tid }
  role_mappings:
    - { issuer: staff_auth, claim: groups, equals: owners, grant: owner }
  default_member_role: member
```

The `@staff:owner` reference is resolved during onboarding, when the owner's person record exists. Until then, validation reports `STAFF_REF_MISSING` (§6.3). The onboarding wizard asks for the owner's staff key before the first publish.
