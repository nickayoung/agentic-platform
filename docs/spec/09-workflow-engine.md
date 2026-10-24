# 9. Workflow engine

Workflows are **declarative reactions**: trigger → condition → actions. The workflow engine runs inside `kairos-core`, on the same tenant database, so a workflow run, its scheduled actions and its outbox rows are written in the same batch as the state change that caused them. Workflows never re-implement policy behaviour (§7.1). They notify, create tasks, call hooks, adjust things within bounds, and start solves.

## 9.1 Execution model

```
state change batch ──(same batch)──▶ domain_event row (id, name, subject, causation_depth)
                                             │
                     event dispatcher (after commit, ordered per subject)
                                             │ match triggers by name + `where`
                                             ▼
                         workflow_run row (UNIQUE run_key)  ── condition (CEL)
                                             │
                     immediate actions ──▶ effects in one batch (+ outbox for external calls)
                     delayed actions   ──▶ scheduled_action rows (fire_at)
                                             │
                     timer driver (per-tenant alarm + 1-min sweep) ──▶ claim → recheck → execute
```

- **Delivery:** at least once. **Effect:** exactly once, through idempotency keys (§9.5).
- **Ordering:** events for the same subject (session, booking, customer) are processed in commit order. Events for different subjects may run in parallel.

## 9.2 Triggers

```ts
type Trigger =
  | { event: EventName; where?: Expr }
  | { at: { relative_to: 'session.start' | 'session.end' | 'booking.created' | 'hold.created';
            offset: SignedDuration; templates_tagged?: string[]; templates?: Key[];
            for_each?: 'session' | 'booking' } }          // default 'session'
  | { every: { rrule: string; at_local: LocalTime; location: Key } };
```

- **Event triggers** fire when a domain event with that name is committed.
- **Relative triggers** are planned ahead of time. When a matching session is created, or a booking for `booking.created`, the engine writes a `scheduled_action` for the trigger at `anchor + offset`. With `for_each: booking`, it fans out at fire time to every booking that is `confirmed` at that moment (one run per booking). Each run is idempotent per `(workflow, booking, anchor)`. If the session is retimed, its pending relative actions are re-planned in the same batch.
- **Calendar triggers** (`every`) expand like a timetable series in the location's zone. The next 14 days are kept in `scheduled_action` and topped up daily.

**Event catalog** (each event carries the subjects listed, which become CEL variables):

| Event | Subjects | Notes |
|---|---|---|
| `booking.held`, `booking.confirmed`, `booking.pending_approval`, `booking.rejected` | booking, session, customer | `booking.channel` shows `waitlist` for promotions |
| `booking.cancelled`, `booking.late_cancelled` | booking, session, customer | |
| `booking.checked_in`, `booking.no_show`, `booking.penalty_assessed` | booking, session, customer | `event.data.waived`, `event.data.fee` |
| `place.released` | place, session | cause in `event.reason` (`cancel`, `hold_expired`, `partition_release`, `capacity`) |
| `waitlist.joined`, `waitlist.offered`, `waitlist.skipped`, `waitlist.expired` | session, customer | |
| `session.created`, `session.cancelled`, `session.needs_staff`, `session.completed`, `session.retimed` | session | `event.reason` for cancellations (`under_minimum`, `staff`, `config_migration`, `no_substitute`) |
| `assignment.confirmed`, `assignment.vacated`, `assignment.changed`, `assignment.en_route` | assignment, session | |
| `roster.published` | roster | |
| `timeoff.submitted`, `timeoff.approved`, `swap.requested`, `swap.approved` | assignment?, (person in `event.data`) | |
| `entitlement.granted`, `entitlement.low_balance`, `entitlement.expiring` | customer | `expiring` is planned 7 days before `ends_at` |
| `proposal.created`, `proposal.decided` | proposal in `event.data` | |
| `config.published`, `config.expression_error`, `sync.drift_detected` | — | staff-facing only |
| `custom.<name>` | as emitted | only from `emit_event` |

## 9.3 Conditions

`trigger.where` filters before a run is created, and the run is not recorded. `condition` is evaluated when the run is created, and again before each delayed action if `recheck_at_fire` is true (the default). Each action can also have its own `when`. All three use the `event` slot (§5.3), with the trigger's subjects loaded **fresh at evaluation time**. So a delayed reminder whose booking was cancelled in the meantime sees `booking.state == 'cancelled'` and skips.

## 9.4 Actions

```ts
interface ActionBase { id?: string; delay?: Duration; when?: Expr }
type ActionDef = ActionBase & (
  | { type: 'notify'; channel: 'email' | 'sms' | 'push' | 'staff_chat'; to: Recipient;
      message: string;                       // template key in the shared notification service
      vars?: Record<string, Expr> }
  | { type: 'create_task'; list: 'desk_checklist' | 'manager_inbox'; title: string; due?: Offset; location?: Key }
  | { type: 'cancel_session'; reason: string; refund: 'units' | 'units_and_fees' | 'none' }
  | { type: 'promote_waitlist' }               // manual re-run, e.g. after a staff capacity change
  | { type: 'adjust_units'; unit: Key; amount: number; reason: string }   // |amount| ≤ 5 per run
  | { type: 'release_remaining_time'; booking: Expr }                     // on-demand bookings only
  | { type: 'set_field'; entity: 'booking' | 'customer' | 'session'; field: Key; value: Expr }  // custom fields only
  | { type: 'invoke_hook'; hook: 'substitute_finder' | 'explain_block' | 'staff_draft'; input: Record<string, Expr> }
  | { type: 'request_solve'; horizon: { days_ahead: number }; scope: { template_tags?: string[]; roles?: Key[] };
      publish: 'proposal' }
  | { type: 'emit_event'; name: `custom.${string}`; data?: Record<string, Expr> }
);
type Recipient =
  | { customer: true } | { session_customers: true } | { waitlist: true }
  | { assignment: Key }                        // person in that requirement of the session
  | { assignment_people: true }                // everyone assigned to the session
  | { roles: PlatformRole[]; location?: 'session' };
```

| Action | Effect | External call | Bounds |
|---|---|---|---|
| `notify` | resolves recipients to IDs; writes an outbox row | shared notification service: `POST /messages` with idempotency key | ≤ 500 recipients per run; message templates live in the notification service, not in config |
| `create_task` | inserts a desk-app or manager task (`task` table) | — | — |
| `cancel_session` | engine cancellation: releases places, refunds per `refund`, emits `session.cancelled` | refunds via gateway (outbox) | only for sessions that have not started |
| `promote_waitlist` | runs §7.7 for the subject session | — | — |
| `adjust_units` | ledger `adjust` row | — | absolute value ≤ 5 per run; ≤ 1 run per subject per workflow per day |
| `release_remaining_time` | shortens the on-demand claim to `now` rounded up to the grain | — | — |
| `set_field` | sets a custom field | — | built-in fields are never writable |
| `invoke_hook` | creates an agent hook job (§10) with the evaluated input | agent service | ≤ 1 concurrent hook job per subject per hook |
| `request_solve` | creates a solver job (§8.2) | solver worker | ≤ 4 per tenant per hour |
| `emit_event` | inserts a `custom.*` domain event | — | depth limit (§9.7) |

There is deliberately **no** action that charges an arbitrary amount, sends an arbitrary message, calls a webhook URL or changes a policy. Fees are charged only by built-in policy penalties, whose amounts are capped (`FEE_ABOVE_CEILING`).

## 9.5 Scheduling delayed actions, and idempotency

**Tables** (§12): `domain_event`, `workflow_run (run_key UNIQUE)`, `scheduled_action (action_key UNIQUE, fire_at, state, lease_until)`, `outbox (idempotency_key UNIQUE)`.

**Keys:**

```
run_key    = sha256(workflow_key ‖ workflow_hash ‖ (event_id | subject_id ‖ anchor_utc ‖ fire_index))
action_key = run_key ‖ ':' ‖ (action.id ?? action_index) [‖ ':' ‖ fan_out_subject_id]
outbox key = action_key                     // passed as Idempotency-Key to the notification service / gateway
```

Re-delivering an event, a timer firing twice, or a retried batch all produce the same keys. The `UNIQUE` index turns the duplicate insert into a no-op (`ON CONFLICT DO NOTHING`), and downstream services drop duplicates by idempotency key. Both shared services **must** dedupe by `Idempotency-Key` for at least 7 days. This is a contract requirement (§18.3).

**Timer driver:**

1. A per-tenant TimerObject (per-object store with alarms) keeps `next_fire_at = min(fire_at of pending actions)`. Every insert of a scheduled action that is sooner than the current alarm moves the alarm.
2. When the alarm fires, it claims a batch: `UPDATE scheduled_action SET state='running', lease_until=:now+60s WHERE action_key IN (SELECT action_key FROM scheduled_action WHERE state='pending' AND fire_at <= :now ORDER BY fire_at LIMIT 100)`.
3. For each claimed action: re-check the condition if required, execute, and write `state='done'` (or `skipped` or `failed`) in the same batch as the effect.
4. A cron sweep every minute picks up actions whose lease has expired, or that are overdue by more than 60 s, in case the alarm was lost.

**Accuracy target:** p95 of 15 s after `fire_at`, and p99 of 60 s.

**Failures:** retry at 1 m, 5 m, 30 m, 2 h and 12 h. After that, `dead` with a `manager_inbox` task. Retries never repeat a side effect, because the outbox row is shared by key.

**Config changes:** on publish, pending actions of removed workflows are set to `cancelled`. Pending actions of changed workflows (a new `workflow_hash`) are cancelled and re-planned under the new definition. Re-planning is idempotent, because new keys include the new hash.

## 9.6 Worked example: a late cancellation that promotes from the waitlist (spin studio, §4b.2)

Session: **Tue 18:30 Spin 45**, Room A, 40/40 booked. Waitlist: #1 Dana (pack_10, 3 credits left, prefers Bike 7 then Bike 8), #2 Eli (unlimited). Rider Cara (unlimited membership) holds **Bike 7**. Terms snapshot: `free_until` = 06:30 (12 h before); late penalty = forfeit units, $15 fee if paid with a membership, waived if the place is refilled, assessed at session start.

| Time | Actor | What happens | Batch contents |
|---|---|---|---|
| 08:00:00 | Cara cancels in the app | 08:00 ≥ 06:30, so this is a **late** cancel | booking → `late_cancelled`; delete `place_claim(Bike 7)`; limit counters −1; `booked_count` 39; `scheduled_action(penalty:bkg_cara @ 18:30)`; events `booking.late_cancelled`, `place.released{reason: cancel}`; audit |
| 08:00:00.05 | SessionGate | Waitlist mode at 08:00: the first schedule entry `until 16:30` is in the future → **auto_promote** | — |
| 08:00:00.08 | Engine | Dana is #1. Bike 7 (her first preference) is a front-row bike. The `front_row_unlimited` partition was released to `general` at Mon 18:30 (24 h before), so freeing Bike 7 relabelled it `general` (§7.3), and Dana is eligible even though she is not unlimited. Pipeline steps 3–10 pass (Dana has no overlap and is within limits). Entitlement pack_10 covers it with 3 ≥ 1 | `place_claim(Bike 7 → bkg_dana)`; booking `confirmed`, `channel=waitlist`; balance 3→2 (CHECK ok); ledger `reserve −1`; waitlist entry → `promoted`; `booked_count` 40; event `booking.confirmed` |
| 08:00:01 | Workflow `promoted_notice` | Push to Dana: "You're in: Bike 7, Tue 18:30" | outbox → notification service |
| 18:30:00 | Timer | Penalty assessment for Cara: `waive_if = booking.place_refilled`. Bike 7 is held by Dana's confirmed booking → **true** | No fee job. Cara's unlimited membership means nothing to forfeit. Event `booking.penalty_assessed{waived: true}` |

**Variants (all covered by tests in §14.1):**

- *Dana had no credits:* she is `skipped` (`INSUFFICIENT_UNITS`) and `waitlist.skipped` is emitted. Eli is promoted onto **Bike 7**: his preference list is empty, so `best` picks the first free place by layout order, which is Bike 7.
- *Nobody refilled the bike* (empty waitlist): at 18:30 `place_refilled` is false. Cara is charged $15 through an outbox → gateway → processor job with key `fee:bkg_cara:late`, and gets a strike if the policy sets one.
- *Cara was on a pack:* the waived penalty writes a `release +1` ledger row, so she gets her credit back. If not waived, a `forfeit` row makes the reserve final.
- *The cancellation came at 17:00* (after 16:30): the mode is **offer_all**. Dana and Eli both get offers that expire at 17:10. The first to hold and confirm gets the bike. Expired offers go back to `waiting`.
- *Dana cancels at 18:10* (also late): Bike 7 is released again. At 18:10 the mode is offer_all until 18:20. If nobody takes it, then at 18:30 **both** Cara's and Dana's assessments see `place_refilled = false`, so both are charged under their own terms.

## 9.7 Loop protection and limits

- Each domain event carries `causation_depth`. Events emitted because of a workflow action get `depth + 1`. Triggers ignore events with depth > 3.
- Static cycle detection at validation (`WORKFLOW_CYCLE`, §6.3).
- Rate limits: ≤ 1,000 runs per workflow per hour per tenant, and ≤ 20 runs per workflow per subject per day. When exceeded, runs are dropped with a `workflow.throttled` metric and one manager notification per hour.
- `max_runs_per_subject`, when set, is enforced by a counter row with a CHECK constraint.
