# 4b. Example configurations

Each example below is a complete config document that validates against §4. They are shown as YAML. To keep them short, empty collections are omitted here. In stored JSON they are present as `[]`. Every example also has an `access` section of the same shape, given once in §4b.0. These six documents are fixtures in the config test suite (`fixtures/configs/*.yaml`, §14.2). They also serve as golden outputs for the agent eval set (§14.4).

None of these examples needs code specific to its business type. The engines read only requirements, capacity, scheduling, cost, policies, constraints and expressions. Appendix A.1–A.2 checks the spin studio and the gym line by line.

## 4b.0 Shared fragment: access

```yaml
access:
  issuers:
    - { key: member_auth, audience: member, issuer: "https://id.example.com/members",
        jwks_url: "https://id.example.com/members/.well-known/jwks.json",
        subject_claim: sub, tenant_claim: tid }
    - { key: staff_auth, audience: staff, issuer: "https://id.example.com/staff",
        jwks_url: "https://id.example.com/staff/.well-known/jwks.json",
        subject_claim: sub, tenant_claim: tid }
  role_mappings:
    - { issuer: staff_auth, claim: groups, equals: owners,   grant: owner }
    - { issuer: staff_auth, claim: groups, equals: managers, grant: manager, location_claim: sites }
    - { issuer: staff_auth, claim: groups, equals: staff,    grant: staff }
  default_member_role: member
```

## 4b.1 Appointments: multi-location physio clinic

What it shows: on-demand appointments, choosing a practitioner, a prerequisite assessment, an intake form for new patients, room plus practitioner requirements, approval for long sessions. A salon uses the same shape with skills such as `colour` and `cut`, and no prerequisite.

```yaml
schema_version: "1.0"
tenant:
  name: "Northside Physio"
  default_timezone: Europe/London
  currency: GBP
  locale: en-GB
  week_starts: mon
  hold_ttl: 10m
  materialize_horizon: 8w
  customer_label: patient
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: camden, name: Camden, timezone: Europe/London, transfer_times: [{ to: islington, duration: 30m }] }
  - { key: islington, name: Islington, timezone: Europe/London, transfer_times: [{ to: camden, duration: 30m }] }
units: []
skills:
  - { key: msk, name: Musculoskeletal, expires: false }
  - { key: sports, name: Sports rehab, expires: false }
  - { key: acupuncture, name: Acupuncture, expires: true }
roles:
  - { key: physio, name: Physiotherapist, implies_skills: [msk] }
  - { key: reception, name: Reception }
tiers: []
resource_types:
  - key: practitioner
    name: Practitioner
    kind: person
    attributes: [{ key: languages, type: string_list }]
  - key: treatment_room
    name: Treatment room
    kind: space
    attributes: [{ key: has_plinth, type: bool, default: true }]
resources:
  - { key: camden_r1, type: treatment_room, name: "Camden Room 1", location: camden }
  - { key: camden_r2, type: treatment_room, name: "Camden Room 2", location: camden }
  - { key: isl_r1, type: treatment_room, name: "Islington Room 1", location: islington }
  - { key: isl_gym, type: treatment_room, name: "Islington Rehab Gym", location: islington, tags: [gym] }
templates:
  - key: assessment_60
    name: "Initial assessment (60 min)"
    kind: appointment
    tags: [assessment]
    duration: 60m
    scheduling: { mode: on_demand, slot_step: 15m, min_lead: 2h, horizon: 6w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: physio, select: { role: physio }, assign: customer_choice, rank: { prefer: least_loaded } }
      - { key: room, select: { type: treatment_room }, assign: auto }
    buffers: { after: 15m }            # notes time
    cost: { payment: price_only, price: { minor: 8500, currency: GBP } }
    policy: clinic_standard
    intake: { form: new_patient_intake }
  - key: followup_30
    name: "Follow-up (30 min)"
    kind: appointment
    tags: [followup]
    duration: 30m
    scheduling: { mode: on_demand, slot_step: 15m, min_lead: 2h, horizon: 6w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: physio, select: { role: physio }, assign: customer_choice, rank: { prefer: customer_history } }
      - { key: room, select: { type: treatment_room }, assign: auto }
    buffers: { after: 5m }
    cost: { payment: price_only, price: { minor: 5500, currency: GBP } }
    policy: clinic_standard
    eligible_if: >
      customer.history.tags['assessment'].completed > 0 ||
      customer.history.tags['assessment'].upcoming > 0
    ineligible_message: "New patients need an initial assessment before booking a follow-up."
  - key: rehab_90
    name: "Sports rehab block (90 min)"
    kind: appointment
    tags: [followup, long]
    duration: 90m
    scheduling: { mode: on_demand, slot_step: 30m, min_lead: 24h, horizon: 6w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: physio, select: { role: physio, skills_all: [sports] }, assign: customer_choice }
      - { key: room, select: { type: treatment_room, tags_all: [gym] }, assign: auto }
    cost: { payment: price_only, price: { minor: 12000, currency: GBP } }
    policy: clinic_long
    eligible_if: "customer.history.tags['assessment'].completed > 0"
    ineligible_message: "Rehab blocks require a completed assessment."
policies:
  - key: clinic_standard
    name: Standard clinic terms
    booking_window: { opens: { before_start: 6w }, closes: { before_start: 2h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 24h }
      late: { forfeit_units: false, fee: { minor: 2500, currency: GBP }, assess_at: immediately }
      no_show: { forfeit_units: false, fee: { minor: 4000, currency: GBP }, assess_at: session_end, grace: 10m }
    limits:
      - { key: one_upcoming_assessment, window: upcoming, max: 1,
          count_if: "'assessment' in booking.template.tags",
          applies_if: "'assessment' in booking.template.tags",
          message: "You already have an assessment booked." }
    customer_overlap: forbid
    retroactive: lenient_only
  - key: clinic_long
    name: Long session terms
    booking_window: { opens: { before_start: 6w }, closes: { before_start: 24h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 48h }
      late: { forfeit_units: false, fee: { minor: 6000, currency: GBP }, assess_at: immediately }
      no_show: { forfeit_units: false, fee: { minor: 12000, currency: GBP }, assess_at: session_end, grace: 10m }
    limits: []
    approval: { required_if: "customer.strikes >= 2", approver_roles: [manager], timeout: 24h, on_timeout: reject }
    customer_overlap: forbid
    retroactive: lenient_only
availability:
  - key: camden_hours
    applies_to: { locations: [camden] }
    kind: open
    weekly: { mon: [["08:00","20:00"]], tue: [["08:00","20:00"]], wed: [["08:00","20:00"]],
              thu: [["08:00","20:00"]], fri: [["08:00","18:00"]], sat: [["09:00","13:00"]] }
  - key: islington_hours
    applies_to: { locations: [islington] }
    kind: open
    weekly: { mon: [["07:00","19:00"]], tue: [["07:00","19:00"]], wed: [["07:00","19:00"]],
              thu: [["07:00","19:00"]], fri: [["07:00","19:00"]] }
  - key: bank_holidays
    applies_to: { locations: [camden, islington] }
    kind: closed
    dates: [{ date: "2026-12-25" }, { date: "2026-12-26" }, { date: "2027-01-01" }]
constraints:
  - key: transfer
    description: "Physios need travel time between clinics"
    level: hard
    applies_to: { roles: [physio] }
    rule: { type: transfer_time }
workflows:
  - key: intake_sequence
    name: "Send intake form after first booking"
    trigger: { event: booking.confirmed, where: "'assessment' in booking.template.tags" }
    recheck_at_fire: true
    actions:
      - { type: notify, channel: email, to: { customer: true }, message: intake_form_link }
      - { type: notify, channel: sms, to: { customer: true }, message: intake_form_reminder,
          delay: 24h, when: "!booking.intake_complete" }
  - key: reminder_24h
    name: "Appointment reminder"
    trigger: { at: { relative_to: session.start, offset: "-24h", templates_tagged: [assessment, followup], for_each: booking } }
    condition: "booking.state == 'confirmed'"
    recheck_at_fire: true
    actions:
      - { type: notify, channel: sms, to: { customer: true }, message: appointment_reminder }
custom_fields:
  - { key: referral_source, label: "Referred by", entity: customer, type: enum,
      options: [gp, self, insurer, other], visible_to: [manager, desk, staff], editable_by: [desk, manager], pii: false }
  - { key: injury_area, label: "Area of concern", entity: booking, type: text,
      required_if: "'assessment' in booking.template.tags", visible_to: [staff, manager], editable_by: [member, staff], pii: true }
  - { key: consent_treatment, label: "Consent to treatment", entity: customer, type: consent,
      required_if: "true", visible_to: [staff, manager], editable_by: [member], pii: false }
forms:
  - { key: new_patient_intake, name: "New patient intake", fields: [injury_area, referral_source, consent_treatment] }
views:
  - { key: today_by_physio, name: "Today by physio", entity: session, roles: [desk, manager],
      columns: [start, assignments.physio.name, booking.customer.display_name, custom.injury_area],
      filter: "row.start_local_date == today(row.zone)", sort: [{ by: start, dir: asc }] }
# access: §4b.0
```

## 4b.2 Classes: boutique spin studio with assigned bikes

What it shows: an assigned spot map, credits and an unlimited membership, a booking window that opens at noon a week ahead, late cancellation with a fee waived if the bike is refilled, a waitlist that auto-promotes and then switches to offers, a minimum-attendance cancellation, premium front-row reservations released 24 hours before, and instructors assigned by the roster.

```yaml
schema_version: "1.0"
tenant:
  name: "Cadence Cycle"
  default_timezone: America/New_York
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 5m
  materialize_horizon: 4w
  customer_label: rider
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: soho, name: SoHo, timezone: America/New_York }
units:
  - { key: class_credit, name: "Class credit" }
skills:
  - { key: spin_cert, name: "Spin certification", expires: true }
roles:
  - { key: instructor, name: Instructor, implies_skills: [] }
tiers:
  - { key: standard, name: Standard, rank: 1 }
  - { key: unlimited, name: Unlimited, rank: 2 }
resource_types:
  - { key: instructor, name: Instructor, kind: person, attributes: [] }
  - key: cycle_room
    name: Cycle room
    kind: space
    attributes: [{ key: capacity, type: int, required: true }]
  - key: bike
    name: Bike
    kind: spot
    attributes:
      - { key: front_row, type: bool, default: false }
      - { key: model, type: enum, values: [standard, tall], default: standard }
resources:
  - { key: room_a, type: cycle_room, name: "Room A", location: soho, attributes: { capacity: 40 }, layout: room_a_bikes }
layouts:
  - key: room_a_bikes
    spot_type: bike
    grid: { rows: 4, cols: 10 }
    generate: { prefix: bike_, label: "Bike {n}", count: 40, per_row: 10 }
    overrides:
      - { match: { rows: [1] }, tags: [front_row], attributes: { front_row: true } }
      - { match: { keys: [bike_10, bike_20] }, attributes: { model: tall } }
templates:
  - key: spin_45
    name: "Spin 45"
    kind: class
    tags: [spin]
    duration: 45m
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
    requirements:
      - { key: room, select: { type: cycle_room }, assign: fixed, provides_layout: true, buffers: { after: 15m } }
      - { key: instructor, select: { role: instructor, skills_all: [spin_cert] }, assign: roster,
          buffers: { before: 10m, after: 10m } }
    cost:
      payment: units_or_price
      units: [{ unit: class_credit, amount: 1 }]
      price: { minor: 3400, currency: USD }
      price_rules:
        - { when: "customer.history.total.completed == 0", price: { minor: 1500, currency: USD } }   # first ride
    policy: spin_policy
  - key: spin_30_express
    name: "Express 30"
    kind: class
    tags: [spin, express]
    duration: 30m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: assigned, requirement: room, auto_assign: true } }
    requirements:
      - { key: room, select: { type: cycle_room }, assign: fixed, provides_layout: true, buffers: { after: 15m } }
      - { key: instructor, select: { role: instructor, skills_all: [spin_cert] }, assign: roster,
          buffers: { before: 10m, after: 10m } }
    cost: { payment: units_or_price, units: [{ unit: class_credit, amount: 1 }], price: { minor: 2800, currency: USD } }
    policy: spin_policy
timetable:
  - { key: weekday_0600, template: spin_45, location: soho, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      start_local: "06:00", valid_from: "2026-11-02", fixed: { room: room_a } }
  - { key: weekday_1215, template: spin_30_express, location: soho, rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      start_local: "12:15", valid_from: "2026-11-02", fixed: { room: room_a } }
  - { key: weekday_1830, template: spin_45, location: soho, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH",
      start_local: "18:30", valid_from: "2026-11-02", fixed: { room: room_a } }
  - { key: sat_0900, template: spin_45, location: soho, rrule: "FREQ=WEEKLY;BYDAY=SA",
      start_local: "09:00", valid_from: "2026-11-07", exdates: ["2026-12-26"],
      fixed: { room: room_a, instructor: "@staff:maya" } }
policies:
  - key: spin_policy
    name: "Spin studio terms"
    booking_window: { opens: { before_start: 7d, at_local: "12:00" }, closes: { before_start: 5m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 12h }
      late:
        forfeit_units: true
        fee: { minor: 1500, currency: USD }
        fee_if: "booking.payment.method == 'units' && booking.entitlement.kind == 'membership'"
        waive_if: "booking.place_refilled"
        assess_at: session_start
      no_show:
        forfeit_units: true
        fee: { minor: 2000, currency: USD }
        fee_if: "booking.payment.method == 'units' && booking.entitlement.kind == 'membership'"
        strikes: 1
        assess_at: session_end
        grace: 5m
    limits:
      - { key: daily_max, window: day, max: 2, message: "You can book up to 2 rides per day." }
      - { key: upcoming_max_standard, window: upcoming, max: 6,
          applies_if: "customer.tier != 'unlimited'", message: "Up to 6 upcoming rides on your plan." }
    min_attendance: { min: 3, check_at: { before_start: 2h }, action: cancel_session }
    waitlist:
      enabled: true
      max_size: 20
      require_entitlement: true
      schedule:
        - { until: { before_start: 2h }, mode: auto_promote }
        - { until: { before_start: 10m }, mode: offer_all }
      offer_ttl: 10m
      place_choice: preferred_then_best
    check_in: { opens: { before_start: 30m }, closes: { after_start: 5m } }
    customer_overlap: forbid
    retroactive: lenient_only
entitlement_products:
  - key: unlimited_monthly
    name: "Unlimited monthly"
    kind: membership
    tier: unlimited
    grants: [{ unit: class_credit, amount: unlimited }]
    caps: [{ key: two_a_day, window: day, max: 2 }]
    validity: { anchor: purchase, recurring: true }   # recurring monthly; period follows the processor's billing cycle
    priority: 1
    sold_by: platform
    price: { minor: 26000, currency: USD }
  - key: pack_10
    name: "10-ride pack"
    kind: pack
    tier: standard
    grants: [{ unit: class_credit, amount: 10 }]
    validity: { length: 13w, anchor: purchase, recurring: false }
    priority: 2
    sold_by: platform
    price: { minor: 29000, currency: USD }
availability:
  - key: studio_hours
    applies_to: { locations: [soho] }
    kind: open
    weekly: { mon: [["05:30","21:30"]], tue: [["05:30","21:30"]], wed: [["05:30","21:30"]],
              thu: [["05:30","21:30"]], fri: [["05:30","21:30"]], sat: [["07:30","14:00"]], sun: [["07:30","14:00"]] }
constraints:
  - { key: max_classes_day, description: "Instructors teach at most 3 classes a day", level: hard,
      applies_to: { roles: [instructor] }, rule: { type: max_assignments, window: day, count: 3 } }
  - { key: rest_between, description: "15 minutes between classes for the same instructor", level: hard,
      applies_to: { roles: [instructor] }, rule: { type: min_rest, duration: 15m } }
  - { key: fair_share, description: "Spread classes evenly", level: soft, weight: 50,
      applies_to: { roles: [instructor] }, rule: { type: fairness, metric: assignments } }
  - { key: keep_regulars, description: "Keep the same instructor on a recurring slot", level: soft, weight: 200,
      applies_to: { roles: [instructor] }, rule: { type: continuity } }
  - { key: honour_prefs, description: "Respect instructor preferences", level: soft, weight: 100,
      applies_to: { roles: [instructor] }, rule: { type: preferences } }
workflows:
  # Waitlist promotion and the minimum-attendance cancellation are built-in policy behaviour (§7.1).
  # These workflows only add notifications on top of them.
  - key: under_minimum_notice
    name: "Tell riders and instructor when a ride is cancelled for low attendance"
    trigger: { event: session.cancelled, where: "event.reason == 'under_minimum'" }
    recheck_at_fire: false
    actions:
      - { type: notify, channel: sms, to: { session_customers: true }, message: class_cancelled_low_attendance }
      - { type: notify, channel: staff_chat, to: { assignment: instructor }, message: class_cancelled_instructor }
  - key: promoted_notice
    name: "Tell a rider they got in from the waitlist"
    trigger: { event: booking.confirmed, where: "booking.channel == 'waitlist'" }
    recheck_at_fire: false
    actions: [{ type: notify, channel: push, to: { customer: true }, message: waitlist_promoted }]
  - key: offer_notice
    name: "Send last-minute waitlist offers"
    trigger: { event: waitlist.offered }
    recheck_at_fire: false
    actions: [{ type: notify, channel: sms, to: { customer: true }, message: waitlist_offer }]
  - key: reminder
    name: "Ride reminder"
    trigger: { at: { relative_to: session.start, offset: "-3h", templates_tagged: [spin], for_each: booking } }
    condition: "booking.state == 'confirmed'"
    recheck_at_fire: true
    actions: [{ type: notify, channel: push, to: { customer: true }, message: ride_reminder }]
  - key: sub_finder
    name: "Find a substitute when an instructor drops out"
    trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'instructor'" }
    recheck_at_fire: true
    actions:
      - { type: invoke_hook, hook: substitute_finder, input: { session_id: "session.id", deadline: "session.start - duration('2h')" } }
simulation:
  - key: launch_month
    source: synthetic
    horizon: 4w
    seed: 42
    demand:
      - { templates_tagged: [spin], per_session: { mean: 28, sd: 8 }, lead_time: { distribution: exponential, mean: 36h },
          cancel_rate: 0.12, late_cancel_rate: 0.04, no_show_rate: 0.03, tier_mix: { unlimited: 0.4, standard: 0.6 } }
# access: §4b.0
```

## 4b.3 Classes + appointments: big-box gym with shared rooms and instructors

What it shows: pooled group classes, an assigned cycle studio with a tier-reserved mix, PT appointments that need a trainer and any PT-capable space (a four-lane PT zone *or* an empty studio), open-floor check-in without booking, and instructors who both teach classes and train PT clients. PT availability is computed from the same occupancy table, so a trainer teaching HIIT at 18:00 is not offered for PT at 18:00, and Studio A is not offered for PT while a class is in it.

```yaml
schema_version: "1.0"
tenant:
  name: "Ironworks Gym"
  default_timezone: America/Chicago
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 5m
  materialize_horizon: 4w
  customer_label: member
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: downtown, name: Downtown, timezone: America/Chicago }
units:
  - { key: class_visit, name: "Class visit" }
  - { key: pt_session, name: "PT session" }
skills:
  - { key: group_fitness, name: "Group fitness", expires: true }
  - { key: cycle, name: "Indoor cycling", expires: true }
  - { key: personal_training, name: "Personal training", expires: true }
roles:
  - { key: coach, name: Coach }
  - { key: desk, name: "Front desk" }
tiers:
  - { key: basic, name: Basic, rank: 1 }
  - { key: plus, name: Plus, rank: 2 }
  - { key: premium, name: Premium, rank: 3 }
resource_types:
  - { key: coach, name: Coach, kind: person, attributes: [] }
  - key: studio
    name: Studio
    kind: space
    attributes: [{ key: capacity, type: int, required: true }]
  - { key: pt_zone, name: "PT zone", kind: space, attributes: [], default_concurrency: 4 }
  - { key: open_floor, name: "Open floor", kind: space, attributes: [{ key: capacity, type: int, required: true }] }
  - key: bike
    name: Bike
    kind: spot
    attributes: [{ key: row, type: int }]
resources:
  - { key: studio_a, type: studio, name: "Studio A", location: downtown, tags: [group, pt_capable], attributes: { capacity: 30 } }
  - { key: studio_b, type: studio, name: "Cycle Studio", location: downtown, tags: [cycle], attributes: { capacity: 24 }, layout: cycle_bikes }
  - { key: pt_zone_1, type: pt_zone, name: "PT Zone", location: downtown, tags: [pt_capable], concurrency: 4 }
  - { key: floor, type: open_floor, name: "Gym floor", location: downtown, attributes: { capacity: 150 } }
layouts:
  - key: cycle_bikes
    spot_type: bike
    grid: { rows: 3, cols: 8 }
    generate: { prefix: bike_, label: "Bike {n}", count: 24, per_row: 8 }
    overrides:
      - { match: { rows: [1] }, tags: [reserved_premium] }
templates:
  - key: hiit_45
    name: "HIIT 45"
    kind: class
    tags: [group, class]
    duration: 45m
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: pooled_from_space, requirement: room } }
    requirements:
      - { key: room, select: { type: studio, tags_all: [group] }, assign: fixed, buffers: { after: 15m } }
      - { key: coach, select: { role: coach, skills_all: [group_fitness] }, assign: roster, buffers: { before: 10m, after: 5m } }
    cost: { payment: units_only, units: [{ unit: class_visit, amount: 1 }] }
    policy: class_policy
  - key: cycle_45
    name: "Cycle 45"
    kind: class
    tags: [cycle, class]
    duration: 45m
    scheduling: { mode: timetable }
    participants:
      who: customers
      capacity:
        mode: mixed
        base: { mode: assigned, requirement: room }
        partitions:
          - key: premium_row
            spots: { tags_any: [reserved_premium] }
            eligible_if: "customer.tier == 'premium'"
            online: true
            release: { at: { before_start: 24h }, to: general }
    requirements:
      - { key: room, select: { type: studio, tags_all: [cycle] }, assign: fixed, provides_layout: true, buffers: { after: 15m } }
      - { key: coach, select: { role: coach, skills_all: [cycle] }, assign: roster, buffers: { before: 10m, after: 5m } }
    cost: { payment: units_only, units: [{ unit: class_visit, amount: 1 }] }
    policy: class_policy
  - key: pt_60
    name: "Personal training (60 min)"
    kind: appointment
    tags: [pt]
    duration: 60m
    scheduling: { mode: on_demand, slot_step: 30m, min_lead: 3h, horizon: 3w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: trainer, select: { role: coach, skills_all: [personal_training] }, assign: customer_choice,
          rank: { prefer: customer_history } }
      - { key: space, select: { tags_any: [pt_capable] }, assign: auto, occupancy: lane,
          rank: { prefer: expr, expr: "candidate.resource.type == 'pt_zone' ? 1.0 : 0.0" } }   # prefer the PT zone
    buffers: { after: 10m }
    cost: { payment: units_or_price, units: [{ unit: pt_session, amount: 1 }], price: { minor: 9000, currency: USD } }
    policy: pt_policy
    eligible_if: "customer.tier != null"
    ineligible_message: "PT is available to members only."
  - key: open_gym
    name: "Open gym (hourly slot)"
    kind: space_booking
    tags: [open]
    duration: 1h
    scheduling: { mode: timetable }
    participants:
      who: customers
      capacity:
        mode: mixed
        base: { mode: pooled, places: 150 }
        partitions:
          - { key: walk_in, count: 100, eligible_if: "customer.tier != null", online: false }   # desk check-in only
    requirements:
      - { key: floor, select: { resources: [floor] }, assign: fixed, occupancy: none }
    cost: { payment: none }
    policy: open_policy
timetable:
  - { key: hiit_am, template: hiit_45, location: downtown, rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      start_local: "06:15", valid_from: "2026-11-02", fixed: { room: studio_a } }
  - { key: hiit_pm, template: hiit_45, location: downtown, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH",
      start_local: "18:00", valid_from: "2026-11-02", fixed: { room: studio_a } }
  - { key: cycle_pm, template: cycle_45, location: downtown, rrule: "FREQ=WEEKLY;BYDAY=TU,TH",
      start_local: "17:30", valid_from: "2026-11-03", fixed: { room: studio_b } }
  - { key: floor_weekday, template: open_gym, location: downtown,
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH;BYHOUR=5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22;BYMINUTE=0",
      start_local: "05:00", valid_from: "2026-11-02", fixed: { floor: floor } }
  - { key: floor_friday, template: open_gym, location: downtown,
      rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21;BYMINUTE=0",
      start_local: "05:00", valid_from: "2026-11-06", fixed: { floor: floor } }
  - { key: floor_weekend, template: open_gym, location: downtown,
      rrule: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=7,8,9,10,11,12,13,14,15,16,17,18,19;BYMINUTE=0",
      start_local: "07:00", valid_from: "2026-11-07", fixed: { floor: floor } }
policies:
  - key: class_policy
    name: "Class terms"
    booking_window: { opens: { before_start: 3d }, closes: { before_start: 0m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 4h }
      late: { forfeit_units: true, strikes: 1, assess_at: immediately }
      no_show: { forfeit_units: true, strikes: 1, assess_at: session_end, grace: 10m }
    limits:
      - { key: plus_upcoming, window: upcoming, max: 4, applies_if: "customer.tier == 'plus'",
          message: "Plus members can hold 4 upcoming classes." }
    approval: { required_if: "customer.strikes >= 3", approver_roles: [manager, desk], timeout: 2h, on_timeout: reject }
    waitlist:
      enabled: true
      max_size: 15
      require_entitlement: true
      schedule: [{ until: { before_start: 1h }, mode: auto_promote }, { until: { before_start: 0m }, mode: offer_all }]
      offer_ttl: 10m
      place_choice: best
    check_in: { opens: { before_start: 30m }, closes: { after_start: 10m } }
    customer_overlap: forbid
    retroactive: lenient_only
  - key: pt_policy
    name: "PT terms"
    booking_window: { opens: { before_start: 3w }, closes: { before_start: 3h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 24h }
      late: { forfeit_units: true, assess_at: immediately }
      no_show: { forfeit_units: true, assess_at: session_end, grace: 15m }
    limits: []
    customer_overlap: forbid
    retroactive: lenient_only
  - key: open_policy
    name: "Open floor"
    booking_window: { opens: { before_start: 1d }, closes: { before_end: 30m } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 0m }
      late: { forfeit_units: false, assess_at: immediately }
      no_show: { forfeit_units: false, assess_at: session_end, grace: 0m }
    limits: [{ key: open_gym_upcoming, window: upcoming, max: 2, message: "Hold up to 2 open-gym slots." }]
    eligible_if: "customer.tier != null"
    check_in: { opens: { before_start: 10m }, closes: { before_end: 15m } }
    customer_overlap: allow
    retroactive: none
entitlement_products:
  - { key: basic, name: Basic, kind: membership, tier: basic, grants: [],
      validity: { anchor: purchase, recurring: true }, priority: 3, sold_by: external }
  - key: plus
    name: Plus
    kind: membership
    tier: plus
    grants: [{ unit: class_visit, amount: 12, per: month, rollover: false }]
    validity: { anchor: purchase, recurring: true }
    priority: 2
    sold_by: external
  - key: premium
    name: Premium
    kind: membership
    tier: premium
    grants: [{ unit: class_visit, amount: unlimited }]
    caps: [{ key: two_a_day, window: day, max: 2 }]
    validity: { anchor: purchase, recurring: true }
    priority: 1
    sold_by: external
  - { key: pt_pack_5, name: "PT 5-pack", kind: pack, grants: [{ unit: pt_session, amount: 5 }],
      validity: { length: 12w, anchor: purchase, recurring: false }, priority: 1, sold_by: platform,
      price: { minor: 40000, currency: USD } }
availability:
  - key: gym_hours
    applies_to: { locations: [downtown] }
    kind: open
    weekly: { mon: [["05:00","23:00"]], tue: [["05:00","23:00"]], wed: [["05:00","23:00"]], thu: [["05:00","23:00"]],
              fri: [["05:00","22:00"]], sat: [["07:00","20:00"]], sun: [["07:00","20:00"]] }
constraints:
  - { key: coach_week, description: "Coaches work at most 40 hours a week (classes + PT)", level: hard,
      applies_to: { roles: [coach] }, rule: { type: max_hours, window: week, hours: 40 } }
  - { key: coach_rest, description: "10 minutes between bookings for the same coach", level: hard,
      applies_to: { roles: [coach] }, rule: { type: min_rest, duration: 10m } }
  - { key: protect_pt, description: "Avoid rostering a coach onto a class over their regular PT hours", level: soft, weight: 300,
      applies_to: { roles: [coach] }, rule: { type: preferences } }
  - { key: fair_classes, description: "Balance class load", level: soft, weight: 40,
      applies_to: { roles: [coach], template_tags: [class] }, rule: { type: fairness, metric: assignments } }
workflows:
  - key: offer_notice
    name: "Send waitlist offers"
    trigger: { event: waitlist.offered }
    recheck_at_fire: false
    actions: [{ type: notify, channel: push, to: { customer: true }, message: waitlist_offer }]
  - key: no_show_strike_notice
    name: "Warn after second strike"
    trigger: { event: booking.no_show }
    condition: "customer.strikes == 2"
    recheck_at_fire: true
    actions: [{ type: notify, channel: email, to: { customer: true }, message: strike_warning }]
  - key: sub_finder
    name: "Find substitute coach"
    trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'coach'" }
    recheck_at_fire: true
    actions: [{ type: invoke_hook, hook: substitute_finder, input: { session_id: "session.id", deadline: "session.start - duration('1h')" } }]
  - key: pt_vacated
    name: "Tell PT client when their trainer is out"
    trigger: { event: assignment.vacated, where: "assignment.requirement_key == 'trainer'" }
    recheck_at_fire: true
    actions:
      - { type: create_task, list: desk_checklist, title: "Rebook PT client (trainer out)", due: { before_start: 2h } }
      - { type: notify, channel: sms, to: { session_customers: true }, message: pt_trainer_unavailable }
# access: §4b.0
```

## 4b.4 Shift rostering: restaurant

What it shows: shifts with no customers, roles, coverage minimums and targets by day part, labour-law limits (weekly hours, rest between shifts, rules for minors), fairness for closing shifts, and a 14-day publishing lead time enforced by a workflow and a constraint.

```yaml
schema_version: "1.0"
tenant:
  name: "Fennel & Fig"
  default_timezone: America/Los_Angeles
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 5m
  materialize_horizon: 3w
  customer_label: guest
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: mission, name: Mission, timezone: America/Los_Angeles }
units: []
skills:
  - { key: food_handler, name: "Food handler card", expires: true }
  - { key: bartending, name: Bartending, expires: false }
  - { key: alcohol_service, name: "RBS alcohol certification", expires: true }
roles:
  - { key: server, name: Server, implies_skills: [food_handler] }
  - { key: line_cook, name: "Line cook", implies_skills: [food_handler] }
  - { key: bartender, name: Bartender, implies_skills: [bartending, alcohol_service] }
  - { key: host, name: Host }
tiers: []
resource_types:
  - key: crew
    name: Crew member
    kind: person
    attributes:
      - { key: age, type: int, required: true }
      - { key: max_weekly_hours_pref, type: int }
templates:
  - { key: server_lunch, name: "Server – lunch", kind: shift, tags: [foh, lunch], duration: 5h,
      scheduling: { mode: rostered, allowed_starts: ["10:30"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: server }, assign: roster }] }
  - { key: server_dinner, name: "Server – dinner", kind: shift, tags: [foh, dinner, closing], duration: 6h30m,
      scheduling: { mode: rostered, allowed_starts: ["16:30", "17:00"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: server, where: "candidate.resource.attributes.age >= 18" }, assign: roster }] }
  - { key: cook_am, name: "Line – AM", kind: shift, tags: [boh, lunch], duration: 7h,
      scheduling: { mode: rostered, allowed_starts: ["09:00"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: line_cook }, assign: roster }] }
  - { key: cook_pm, name: "Line – PM", kind: shift, tags: [boh, dinner, closing], duration: 7h,
      scheduling: { mode: rostered, allowed_starts: ["15:30"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: line_cook }, assign: roster }] }
  - { key: bar_pm, name: "Bar – PM", kind: shift, tags: [foh, dinner, closing], duration: 7h,
      scheduling: { mode: rostered, allowed_starts: ["16:00"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: bartender, where: "candidate.resource.attributes.age >= 21" }, assign: roster }] }
  - { key: host_pm, name: "Host – PM", kind: shift, tags: [foh, dinner], duration: 4h,
      scheduling: { mode: rostered, allowed_starts: ["17:00", "18:00"] }, participants: { who: none },
      requirements: [{ key: worker, select: { role: host }, assign: roster }] }
coverage:
  - key: servers
    location: mission
    role: server
    shift_templates: [server_lunch, server_dinner]
    pattern:
      - { days: [mon, tue, wed, thu], from: "11:00", to: "14:30", min: 2, target: 3 }
      - { days: [fri, sat, sun],      from: "11:00", to: "14:30", min: 3, target: 4 }
      - { days: [mon, tue, wed, thu], from: "17:30", to: "22:00", min: 3, target: 4 }
      - { days: [fri, sat],           from: "17:30", to: "23:00", min: 5, target: 6 }
    level: hard
    weight: 80
  - key: cooks
    location: mission
    role: line_cook
    shift_templates: [cook_am, cook_pm]
    pattern:
      - { days: [mon, tue, wed, thu, fri, sat, sun], from: "09:30", to: "15:30", min: 2 }
      - { days: [mon, tue, wed, thu, fri, sat, sun], from: "16:00", to: "22:00", min: 3, target: 4 }
    level: hard
  - { key: bar, location: mission, role: bartender, shift_templates: [bar_pm],
      pattern: [{ days: [tue, wed, thu, fri, sat], from: "16:30", to: "23:00", min: 1, target: 2 }], level: hard, weight: 60 }
  - { key: hosts, location: mission, role: host, shift_templates: [host_pm],
      pattern: [{ days: [thu, fri, sat], from: "17:30", to: "21:30", min: 1 }], level: soft, weight: 100 }
constraints:
  - { key: weekly_40, description: "No more than 40 hours a week (overtime not budgeted)", level: hard,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: max_hours, window: week, hours: 40 } }
  - { key: daily_10, description: "No more than 10 hours in a day", level: hard,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: max_hours, window: day, hours: 10 } }
  - { key: no_clopen, description: "At least 10 hours between closing and next opening", level: hard,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: min_rest, duration: 10h } }
  - { key: six_days, description: "No more than 6 consecutive days", level: hard,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: max_consecutive_days, days: 6 } }
  - { key: minors_hours, description: "Workers under 18: shifts between 07:00 and 22:00 only", level: hard,
      applies_to: { people_where: "candidate.resource.attributes.age < 18" },
      rule: { type: allowed_hours, from: "07:00", to: "22:00" } }
  - { key: minors_weekly, description: "Workers under 18: at most 28 hours a week", level: hard,
      applies_to: { people_where: "candidate.resource.attributes.age < 18" },
      rule: { type: max_hours, window: week, hours: 28 } }
  - { key: fair_closers, description: "Share closing shifts fairly", level: soft, weight: 120,
      applies_to: { template_tags: [closing] }, rule: { type: fairness, metric: closing_shifts } }
  - { key: fair_weekends, description: "Share weekend shifts fairly", level: soft, weight: 100,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: fairness, metric: weekend_assignments } }
  - { key: prefs, description: "Respect availability preferences", level: soft, weight: 150,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: preferences } }
  - { key: keep_published, description: "Avoid changing a published schedule", level: soft, weight: 500,
      applies_to: { roles: [server, line_cook, bartender, host] }, rule: { type: stability } }
  - { key: min_hours_pref, description: "Give part-timers at least 12 hours", level: soft, weight: 30,
      applies_to: { roles: [server, host] }, rule: { type: min_hours, window: week, hours: 12 } }
workflows:
  - key: publish_reminder
    name: "Remind manager to publish 14 days ahead"
    trigger: { every: { rrule: "FREQ=WEEKLY;BYDAY=MO", at_local: "09:00", location: mission } }
    condition: "roster.published_through < now + duration('336h')"
    recheck_at_fire: true
    actions: [{ type: notify, channel: staff_chat, to: { roles: [manager] }, message: roster_publish_due }]
  - key: shift_change_notice
    name: "Tell staff when a published shift changes"
    trigger: { event: assignment.changed, where: "session.template.kind == 'shift'" }
    recheck_at_fire: false
    actions: [{ type: notify, channel: sms, to: { assignment_people: true }, message: shift_changed }]
# access: §4b.0
```

> `session.template.kind` here is a *CEL value* used in a workflow filter written by the tenant. It is not engine branching. Principle 4 forbids engine code from reading `kind`. Tenant expressions may use it as data.

## 4b.5 Field service: HVAC

What it shows: jobs at customer sites, customer-chosen arrival windows, technicians assigned later with travel-aware feasibility checked at booking, skills and territories, a two-technician install job that needs a vehicle carrying equipment, and nightly route optimisation.

```yaml
schema_version: "1.0"
tenant:
  name: "Polar Air Services"
  default_timezone: America/Phoenix
  currency: USD
  locale: en-US
  week_starts: mon
  hold_ttl: 10m
  materialize_horizon: 2w
  customer_label: customer
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: depot, name: "Tempe depot", timezone: America/Phoenix, geo: { lat: 33.4255, lng: -111.94 } }
units: []
skills:
  - { key: epa_608, name: "EPA 608 refrigerant", expires: true }
  - { key: ductwork, name: Ductwork, expires: false }
  - { key: heat_pump, name: "Heat pump install", expires: false }
roles:
  - { key: tech, name: Technician }
  - { key: dispatcher, name: Dispatcher }
tiers:
  - { key: comfort_club, name: "Comfort Club", rank: 1 }
resource_types:
  - key: technician
    name: Technician
    kind: person
    attributes: [{ key: territories, type: string_list, required: true }]
  - key: van
    name: Van
    kind: vehicle
    attributes: [{ key: has_lift, type: bool, default: false }]
resources:
  - { key: van_1, type: van, name: "Van 1", location: depot }
  - { key: van_2, type: van, name: "Van 2", location: depot }
  - { key: van_3, type: van, name: "Van 3 (lift)", location: depot, attributes: { has_lift: true } }
territories:
  - { key: east_valley, name: "East Valley", postal_codes: ["85201","85202","85203","85204","85210","85281","85282","85283"] }
  - { key: west_valley, name: "West Valley", postal_codes: ["85301","85302","85303","85304","85305","85306"] }
travel:
  matrix_source: "gateway:maps"
  fallback: { mode: haversine, speed_kmh: 40, detour_factor: 1.4 }
  cache_ttl: 7d
  round_up_to: 5m
templates:
  - key: maintenance
    name: "Seasonal maintenance"
    kind: job
    tags: [service]
    duration: 1h
    scheduling: { mode: arrival_window, windows: [{ start: "08:00", end: "12:00" }, { start: "12:00", end: "16:00" }],
                  min_lead: 18h, horizon: 3w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: tech, select: { role: tech, same_location: false }, assign: deferred, travel: true }
    cost: { payment: price_only, price: { minor: 12900, currency: USD },
            price_rules: [{ when: "customer.tier == 'comfort_club'", price: { minor: 0, currency: USD } }] }
    policy: field_policy
  - key: repair
    name: "AC repair"
    kind: job
    tags: [service, repair]
    duration: 2h
    scheduling: { mode: arrival_window, windows: [{ start: "08:00", end: "12:00" }, { start: "12:00", end: "16:00" }],
                  min_lead: 2h, horizon: 2w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: tech, select: { role: tech, skills_all: [epa_608], same_location: false }, assign: deferred, travel: true }
    cost: { payment: price_only, price: { minor: 8900, currency: USD } }   # diagnostic fee
    policy: field_policy
  - key: heat_pump_install
    name: "Heat pump install"
    kind: job
    tags: [install]
    duration: 8h
    scheduling: { mode: arrival_window, windows: [{ start: "07:00", end: "08:00" }], min_lead: 72h, horizon: 6w }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: lead, select: { role: tech, skills_all: [heat_pump, epa_608], same_location: false }, assign: deferred, travel: true }
      - { key: helper, select: { role: tech, same_location: false }, assign: deferred, travel: true }
      - { key: vehicle, select: { type: van, where: "candidate.resource.attributes.has_lift" }, assign: deferred }
    cost: { payment: none }    # quoted and invoiced outside the platform
    policy: install_policy
policies:
  - key: field_policy
    name: "Service visit terms"
    booking_window: { opens: { before_start: 3w }, closes: { before_start: 2h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 24h }
      late: { forfeit_units: false, fee: { minor: 4900, currency: USD }, assess_at: immediately }
      no_show: { forfeit_units: false, fee: { minor: 8900, currency: USD }, assess_at: session_end, grace: 30m }
    limits: [{ key: one_per_day, window: day, max: 1, message: "One visit per day per address." }]
    customer_overlap: forbid
    retroactive: lenient_only
  - key: install_policy
    name: "Install terms"
    booking_window: { opens: { before_start: 6w }, closes: { before_start: 72h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 72h }
      late: { forfeit_units: false, assess_at: immediately }
      no_show: { forfeit_units: false, assess_at: session_end, grace: 60m }
    limits: []
    approval: { required_if: "true", approver_roles: [manager], timeout: 48h, on_timeout: reject }
    customer_overlap: forbid
    retroactive: none
entitlement_products:
  - { key: comfort_club, name: "Comfort Club", kind: membership, tier: comfort_club, grants: [],
      validity: { anchor: purchase, recurring: true }, priority: 1, sold_by: external }
availability:
  - key: field_hours
    applies_to: { locations: [depot] }
    kind: open
    weekly: { mon: [["07:00","18:00"]], tue: [["07:00","18:00"]], wed: [["07:00","18:00"]],
              thu: [["07:00","18:00"]], fri: [["07:00","18:00"]], sat: [["08:00","14:00"]] }
constraints:
  - { key: territory, description: "Technicians stay in their territories", level: soft, weight: 400,
      applies_to: { roles: [tech] }, rule: { type: territory_match } }
  - { key: travel, description: "Minimise drive time", level: soft, weight: 100,
      applies_to: { roles: [tech] }, rule: { type: minimize_travel } }
  - { key: tech_day, description: "Technicians work at most 10 hours a day including travel", level: hard,
      applies_to: { roles: [tech] }, rule: { type: max_hours, window: day, hours: 10 } }
  - { key: keep_routes, description: "Avoid reshuffling routes after 06:00 dispatch", level: soft, weight: 300,
      applies_to: { roles: [tech] }, rule: { type: stability } }
workflows:
  - key: nightly_dispatch
    name: "Optimise tomorrow's routes"
    trigger: { every: { rrule: "FREQ=DAILY", at_local: "19:00", location: depot } }
    recheck_at_fire: false
    actions: [{ type: request_solve, horizon: { days_ahead: 1 }, scope: { template_tags: [service, install, repair] },
                publish: proposal }]
  - key: on_the_way
    name: "On-the-way text"
    trigger: { event: assignment.en_route }
    recheck_at_fire: false
    actions: [{ type: notify, channel: sms, to: { session_customers: true }, message: tech_on_the_way }]
custom_fields:
  - { key: unit_age_years, label: "Age of AC unit", entity: booking, type: int, visible_to: [staff, manager, desk],
      editable_by: [member, staff], pii: false }
  - { key: gate_code, label: "Gate code", entity: booking, type: text, visible_to: [staff], editable_by: [member], pii: true, retention: 30d }
# access: §4b.0
```

## 4b.6 Space booking: coworking with membership tiers

What it shows: rooms booked for a variable length and priced per hour in credits, hot desks as assigned spots on a floor layout, a booking horizon that depends on tier, a members-only rule, and an approval rule for the boardroom.

```yaml
schema_version: "1.0"
tenant:
  name: "Commons Works"
  default_timezone: Europe/Berlin
  currency: EUR
  locale: de-DE
  week_starts: mon
  hold_ttl: 10m
  materialize_horizon: 4w
  customer_label: member
  environment_guards: { preview_outbound: sandbox }
locations:
  - { key: kreuzberg, name: Kreuzberg, timezone: Europe/Berlin }
units:
  - { key: room_hour, name: "Meeting room hour" }
  - { key: desk_day, name: "Desk day" }
skills: []
roles: [{ key: community, name: "Community team" }]
tiers:
  - { key: flex, name: Flex, rank: 1 }
  - { key: resident, name: Resident, rank: 2 }
  - { key: team, name: Team, rank: 3 }
resource_types:
  - key: meeting_room
    name: Meeting room
    kind: space
    attributes:
      - { key: seats, type: int, required: true }
      - { key: av, type: bool, default: false }
  - { key: desk_floor, name: "Desk floor", kind: space, attributes: [] }
  - key: desk
    name: Desk
    kind: spot
    attributes: [{ key: monitor, type: bool, default: false }, { key: zone, type: enum, values: [quiet, social] }]
resources:
  - { key: room_spree, type: meeting_room, name: Spree, location: kreuzberg, attributes: { seats: 4 } }
  - { key: room_havel, type: meeting_room, name: Havel, location: kreuzberg, attributes: { seats: 8, av: true } }
  - { key: boardroom, type: meeting_room, name: Boardroom, location: kreuzberg, tags: [premium], attributes: { seats: 16, av: true } }
  - { key: floor_2, type: desk_floor, name: "Floor 2 hot desks", location: kreuzberg, layout: floor_2_desks }
layouts:
  - key: floor_2_desks
    spot_type: desk
    grid: { rows: 4, cols: 6 }
    generate: { prefix: d, label: "Desk {n}", count: 24, per_row: 6 }
    overrides:
      - { match: { rows: [1, 2] }, attributes: { zone: quiet, monitor: true } }
      - { match: { rows: [3, 4] }, attributes: { zone: social } }
templates:
  - key: room_booking
    name: "Meeting room"
    kind: space_booking
    tags: [room]
    duration: { min: 30m, max: 8h, step: 30m, default: 1h }
    scheduling: { mode: on_demand, slot_step: 30m, min_lead: 0m, horizon: 30d }
    participants: { who: customers, capacity: { mode: single } }
    requirements:
      - { key: room, select: { type: meeting_room, where: "candidate.resource.attributes.seats >= booking.party_size" },
          assign: customer_choice, buffers: { after: 10m } }
    cost:
      payment: units_or_price
      units: [{ unit: room_hour, amount: "double(booking.duration_minutes) / 60.0 * (booking.resource('room').key == 'boardroom' ? 2.0 : 1.0)" }]
      price: { minor: 3000, currency: EUR }
    policy: room_policy
    eligible_if: "customer.tier != null"
    ineligible_message: "Meeting rooms are for members."
  - key: desk_day_pass
    name: "Hot desk (day)"
    kind: space_booking
    tags: [desk]
    duration: 11h
    scheduling: { mode: timetable }
    participants: { who: customers, capacity: { mode: assigned, requirement: floor, auto_assign: true } }
    requirements:
      - { key: floor, select: { resources: [floor_2] }, assign: fixed, provides_layout: true, occupancy: none }
    cost: { payment: units_or_price, units: [{ unit: desk_day, amount: 1 }], price: { minor: 2500, currency: EUR } }
    policy: desk_policy
timetable:
  - { key: desks_weekdays, template: desk_day_pass, location: kreuzberg, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      start_local: "08:00", valid_from: "2026-11-02", fixed: { floor: floor_2 } }
policies:
  - key: room_policy
    name: "Room terms"
    booking_window:
      opens: { before_start: 30d }
      closes: { before_start: 0m }
    eligible_if: >
      (customer.tier == 'team') ||
      (customer.tier == 'resident' && hoursUntil(session.start) <= 14.0 * 24.0) ||
      (customer.tier == 'flex' && hoursUntil(session.start) <= 7.0 * 24.0)
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 2h }
      late: { forfeit_units: true, assess_at: immediately }
      no_show: { forfeit_units: true, assess_at: session_start, grace: 15m }
    limits:
      - { key: flex_room_cap, window: week, max: 3, applies_if: "customer.tier == 'flex'",
          message: "Flex members can book 3 rooms a week." }
    approval: { required_if: "booking.resource('room').key == 'boardroom' && booking.duration_minutes > 240",
                approver_roles: [manager], timeout: 24h, on_timeout: reject }
    customer_overlap: allow
    retroactive: lenient_only
  - key: desk_policy
    name: "Desk terms"
    booking_window: { opens: { before_start: 14d }, closes: { before_end: 2h } }
    cancellation:
      customer_can_cancel: true
      free_until: { before_start: 0m }
      late: { forfeit_units: true, assess_at: immediately }
      no_show: { forfeit_units: false, assess_at: session_end, grace: 0m }
    limits: []
    customer_overlap: allow
    retroactive: none
entitlement_products:
  - { key: flex, name: Flex, kind: membership, tier: flex,
      grants: [{ unit: room_hour, amount: 4, per: month }, { unit: desk_day, amount: 5, per: month }],
      validity: { anchor: purchase, recurring: true }, priority: 2, sold_by: external }
  - { key: resident, name: Resident, kind: membership, tier: resident,
      grants: [{ unit: room_hour, amount: 10, per: month }, { unit: desk_day, amount: unlimited }],
      validity: { anchor: purchase, recurring: true }, priority: 1, sold_by: external }
  - { key: team, name: Team, kind: membership, tier: team,
      grants: [{ unit: room_hour, amount: 40, per: month, rollover: true }, { unit: desk_day, amount: unlimited }],
      validity: { anchor: purchase, recurring: true }, priority: 1, sold_by: external }
availability:
  - key: building_hours
    applies_to: { locations: [kreuzberg] }
    kind: open
    weekly: { mon: [["07:00","21:00"]], tue: [["07:00","21:00"]], wed: [["07:00","21:00"]],
              thu: [["07:00","21:00"]], fri: [["07:00","19:00"]] }
workflows:
  - key: release_no_show_rooms
    name: "Release rooms 15 minutes after a no-show"
    trigger: { event: booking.no_show, where: "'room' in booking.template.tags" }
    recheck_at_fire: true
    actions: [{ type: release_remaining_time, booking: "booking.id" }]
custom_fields:
  - { key: party_size, label: "Number of people", entity: booking, type: int, required_if: "'room' in booking.template.tags",
      visible_to: [member, staff, manager], editable_by: [member], pii: false }
# access: §4b.0
```

`booking.party_size` resolves to the custom field `party_size` captured in the booking request. Custom fields on bookings can be read in expressions as `booking.<key>` when the field key does not shadow a built-in (§5.3). Validation rejects field keys that clash with built-ins.
