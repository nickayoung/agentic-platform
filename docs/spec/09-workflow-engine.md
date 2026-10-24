# 9. Workflow engine

Workflows are declarative reactions: trigger → condition → actions. They run inside `kairos-core`, on the tenant database. Each run, its scheduled actions and its outbox rows are written in the same batch as the state change that caused them. Workflows never re-implement policy behaviour (§7.1). Messages go only through the notification service. Calls to outside systems go only through the gateway, via the outbox.

## 9.1 Execution model

```
state change batch ──(same batch)──▶ domain_event (id, name, subject, causation_depth)
        dispatcher (after commit, ordered per subject) → match triggers (event + where)
        → workflow_run (UNIQUE run_key) → condition → immediate actions (same batch, outbox for external)
                                                    → delayed actions → scheduled_action (fire_at)
        timer driver (per-tenant alarm + 1-minute sweep) → claim → recheck → execute
```

Delivery is at least once. Effects happen exactly once, enforced by idempotency keys (§9.5). Events for one subject are processed in commit order.

## 9.2 Triggers and event catalog

```ts
type Trigger =
  | { event: EventName; where?: Expr }
  | { at: { relative_to: 'session.start' | 'session.end' | 'booking.created'; offset: SignedDuration;
            templates_tagged?: string[]; templates?: Key[]; for_each?: 'session' | 'booking' } }
  | { every: { rrule: string; at_local: LocalTime; location: Key } };
```

- **Relative triggers** are planned when the session or booking is created. If the session is retimed, they are re-planned in the same batch. With `for_each: booking`, one run fans out per booking that is `confirmed` at fire time.
- **Calendar triggers** keep 14 days of `scheduled_action` rows ahead, topped up daily.

| Event | Subjects | `event.reason` / `data` |
|---|---|---|
| `booking.held`, `booking.confirmed`, `booking.pending_approval`, `booking.rejected` | booking, session, customer | `booking.channel = waitlist` for promotions |
| `booking.cancelled`, `booking.late_cancelled`, `booking.checked_in`, `booking.no_show`, `booking.penalty_assessed` | booking, session, customer | `data.waived`, `data.fee` |
| `place.released` | place, session | `cancel`, `hold_expired`, `partition_release`, `capacity`, `reseat` |
| `waitlist.joined`, `waitlist.offered`, `waitlist.skipped`, `waitlist.expired` | session, customer | skip reason code |
| `session.created`, `session.cancelled`, `session.needs_staff`, `session.needs_resource`, `session.completed`, `session.retimed` | session | cancel reasons: `under_minimum`, `no_staff`, `closure`, `staff`, `config_migration`, `tenant_closed` |
| `assignment.confirmed`, `assignment.vacated`, `assignment.changed` | assignment, session | `substitute`, `roster`, `manager`, `swap`; vacate: `sick`, `time_off`, `offboarding`, `skill_lost` |
| `offer.sent`, `offer.accepted`, `offer.declined`, `offer.expired` | session; offer in `data` | — |
| `roster.published` | roster | — |
| `timeoff.submitted`, `timeoff.approved`, `swap.requested`, `swap.approved` | person in `data` | — |
| `person.created`, `person.deactivated`, `skill.expiring` | person in `data` | — |
| `entitlement.granted`, `entitlement.low_balance`, `entitlement.expiring`, `entitlement.past_due`, `entitlement.frozen` | customer | — |
| `proposal.created`, `proposal.decided`, `proposal.expired` | proposal in `data` | — |
| `tenant.closing` | — | `data.close_at` |
| `config.published`, `config.expression_error`, `sync.drift_detected` | — | drift kinds: `cross_domain_conflict`, `unmapped_person`, `field_mismatch`, `missing_local`, `missing_remote`, `push_failed` |
| `custom.<name>` | as emitted | e.g. `custom.substitute_exhausted` from H3 |

## 9.3 Conditions

- `trigger.where` filters events before a run is created.
- `condition` is checked when the run is created, and again before each delayed action when `recheck_at_fire` is true (the default).
- `action.when` gates a single action.

All three use the `event` slot (§5.3), with subjects loaded fresh when the expression is evaluated.

## 9.4 Actions

```ts
interface ActionBase { id?: string; delay?: Duration; when?: Expr }
type ActionDef = ActionBase & (
  | { type: 'notify'; channel: 'email' | 'sms' | 'push' | 'staff_chat'; to: Recipient; message: string;
      vars?: Record<string, Expr> }
  | { type: 'create_task'; list: 'desk_checklist' | 'manager_inbox'; title: string; due?: Offset; location?: Key }
  | { type: 'cancel_session'; reason: string }                 // refunds always per policy.refund.studio_cancel
  | { type: 'adjust_units'; unit: Key; amount: number; reason: string }   // |amount| ≤ 2 per run
  | { type: 'set_field'; entity: 'booking' | 'customer' | 'session'; field: Key; value: Expr }
  | { type: 'invoke_hook'; hook: 'substitute_finder' | 'explain_block' | 'staff_draft'; input: Record<string, Expr> }
  | { type: 'request_solve'; horizon: { days_ahead: number }; scope: { roles?: Key[] }; publish: 'proposal' }
  | { type: 'emit_event'; name: `custom.${string}`; data?: Record<string, Expr> }
);
type Recipient =
  | { customer: true } | { session_customers: true } | { waitlist: true }
  | { assignment: Key } | { assignment_people: true }
  | { roles: PlatformRole[]; location?: 'session' }
  | { all_members: true };               // only for trigger tenant.closing; batched 500 per outbox row
```

| Action | Effect | External call | Bounds |
|---|---|---|---|
| `notify` | Resolves recipient references; writes an outbox row | Notification service `POST /messages`, with idempotency key | ≤ 500 recipients per row; templates live in the notification service |
| `create_task` | Inserts a task | — | — |
| `cancel_session` | Runs the engine's studio cancel (§7.6) | Refunds via gateway (outbox) | Only before the session starts |
| `adjust_units` | Ledger `adjust` row | — | ≤ 2 units; ≤ 1 per subject per workflow per day |
| `set_field` | Sets a custom field | — | Custom fields only |
| `invoke_hook` | Creates a hook job (§10) | `kairos-agent` | ≤ 1 concurrent job per subject per hook |
| `request_solve` | Creates a solver job | Solver worker | ≤ 4 per tenant per hour |
| `emit_event` | Inserts a `custom.*` event | — | Depth limit (§9.7) |

There is no action that charges arbitrary money, sends arbitrary text, calls an arbitrary URL, or changes policy.

## 9.5 Scheduling and idempotency

```
run_key    = sha256(workflow_key ‖ workflow_hash ‖ (event_id | subject_id ‖ anchor_utc ‖ fire_index))
action_key = run_key ‖ ':' ‖ (action.id ?? index) [‖ ':' ‖ fan_out_subject_id]
outbox idempotency key = action_key
```

- **Duplicates are no-ops.** `run_key`, `action_key` and the outbox key are `UNIQUE` and inserted with `ON CONFLICT DO NOTHING`. The notification service and the gateway must also deduplicate by `Idempotency-Key` for ≥ 7 days (§18.3).
- **Timer driver.**
  - A per-tenant TimerObject holds an alarm set to the earliest `fire_at`.
  - When the alarm fires, it claims up to 100 due actions with a 60 s lease.
  - For each action, it re-checks the condition, executes the effect, and marks the action done, all in one batch.
  - A sweep runs every minute and picks up expired leases and anything more than 60 s overdue.
  - Target: p95 within 15 s of `fire_at`, p99 within 60 s.
- **Failures.** Retries happen at 1 m, 5 m, 30 m, 2 h and 12 h. After that the action is marked `dead` and a manager-inbox task is created.
- **Config publish.** Pending actions of removed workflows are cancelled. Pending actions of changed workflows are cancelled and re-planned under the new hash.

## 9.6 Worked example: late cancellation with waitlist promotion (reference tenant, §4b.1)

**Setup**
- Class: Tue 18:30 Vinyasa 60, Williamsburg, 36/36 booked.
- Waitlist: #1 Dana (pack_10, 3 credits, prefers Mat 3 then Mat 4); #2 Eli (unlimited).
- Cara (unlimited membership) holds **Mat 3**, which is in row 1 (front row).
- Cara's terms: `free_cancel_until` 06:30; late penalty = forfeit units plus a $10 fee if paid by membership, waived if the place is refilled, assessed at session start.

| Time | What happens | Batch contents |
|---|---|---|
| 08:00:00 | Cara cancels. 08:00 ≥ 06:30, so it is **late** | Booking → `late_cancelled`; place claim deleted; counters −1; `booked_count` 35; scheduled action `penalty:bkg_cara @ 18:30`. The waitlist has waiting entries and the mode is not closed, so **`place.reserved_for = 'waitlist'`** is set in the same batch. The front-row partition was released to `general` at Mon 18:30, so Mat 3 is relabelled `general`. Events `booking.late_cancelled`, `place.released{cancel}` |
| 08:00:00.01 | A new member, Fay, tries to hold Mat 3 | Assert 3 (§7.5.2) fails because Mat 3 is reserved for the waitlist and Fay has no offer → `409 PLACE_TAKEN`. Fay can join the waitlist |
| 08:00:00.05 | SessionGate runs promotion. Mode at 08:00 is **auto_promote** (16:30 is still in the future) | — |
| 08:00:00.08 | Dana (#1): Mat 3 is free and reserved; she passes steps 3 and 5–10; pack_10 covers her (3 ≥ 1) | Place claim Mat 3 → `bkg_dana`; booking `confirmed`, `booked_via: waitlist`; balance 3→2, `reserve −1`; `reserved_for` cleared; entry → `promoted`; `booked_count` 36 |
| 08:00:01 | `promoted_notice` workflow | SMS to Dana via the notification service ("You're in: Mat 3, Tue 18:30") |
| 18:30:00 | Penalty for Cara: `place_refilled` is true (Mat 3 has Dana's confirmed booking) | No fee job. Cara's membership is unlimited, so nothing is forfeited. Event `booking.penalty_assessed{waived: true}` |

**Variants (tests in §14.1)**
- **Dana has no credits.** Her entry is `skipped` (`INSUFFICIENT_UNITS`) and `skipped_notice` emails her. Eli is promoted onto Mat 3 (`best`, since he has no preferences).
- **Nobody is eligible.** `reserved_for` is cleared and Mat 3 is free for anyone. At 18:30, `place_refilled` is false unless someone booked it meanwhile; if so, Cara is charged $10 via outbox → gateway → processor (key `fee:bkg_cara:late`), plus a strike if the policy sets one.
- **Cara paid with a pack.** If waived, a `release +1` row returns her credit. If not waived, a `forfeit` row is written.
- **Cancellation at 17:00** (mode **offer_all**). Dana and Eli each get a place offer that expires at 17:15. Mat 3 stays reserved for offered members. The first to hold and confirm wins (the hold lasts until at most 17:20, §7.5.2). If both offers expire, both go back to `waiting` and `reserved_for` is cleared.
- **Dana late-cancels at 18:10.** The mode is offer_all until 18:15. If Mat 3 is not refilled, both Cara's and Dana's assessments at 18:30 see `place_refilled = false`, and both are charged under their own terms.

## 9.7 Loop protection and limits

- Events caused by workflow actions carry `causation_depth + 1`. Triggers ignore any event with depth > 3.
- A static cycle check runs at validation (`WORKFLOW_CYCLE`).
- Rate limits: ≤ 1,000 runs per workflow per hour, and ≤ 20 runs per workflow per subject per day. When throttled, the engine records a metric and sends one manager notification per hour.
