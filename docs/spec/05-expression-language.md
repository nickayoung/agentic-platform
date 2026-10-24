# 5. Expression language

## 5.1 Choice: CEL, restricted profile (D-01)

| Criterion | CEL | JSONLogic |
|---|---|---|
| Static type checking at publish time | Yes. Unknown fields and type mismatches are rejected | No. Errors only appear at runtime |
| Guaranteed termination, no side effects | Yes | Yes |
| Cost estimation before execution | Yes | No |
| Readable in approval diffs | `customer.tier == 'unlimited'` | `{"==":[{"var":"customer.tier"},"unlimited"]}` |
| LLM generation accuracy | High (C-like syntax) | Lower (deeply nested JSON) |
| Time and duration types | Built in | None |
| Maturity of TypeScript implementations | Moderate | High |

CEL wins on static checking and readability. Both matter for config written by an agent: an LLM's mistake is caught at validation, not when a member tries to book.

The TypeScript maturity risk is handled in three ways:
- `packages/expr` wraps a maintained TypeScript CEL implementation behind `compile(source, slot)` and `evaluate(compiled, activation)`.
- That implementation must pass this profile's subset of the cel-spec conformance tests.
- If no library passes, the profile is small enough to build in house: about 3–4k lines (A-13).

## 5.2 Profile

**Allowed:**
- literals, field selection and indexing;
- comparison, logical, arithmetic and `?:` operators;
- `in`;
- the macros `has`, `all`, `exists`, `exists_one`, `filter`, `map` (lists from the activation only);
- the functions in §5.4.

**Forbidden:**
- user-defined functions, protobuf types and `bytes`;
- regex, except `matches` with a literal RE2 pattern of 128 characters or fewer;
- any I/O, clock access or randomness. `now` is bound by the engine.

## 5.3 Slots and environments

| Slot | Used by | Result | Variables |
|---|---|---|---|
| `booking` | `eligible_if` (template, policy), `price_rules[].when`, `partitions[].eligible_if`, `limits[].count_if`/`applies_if`, `Penalty.fee_if`/`waive_if`, `approval.required_if`, `intake.when`, `custom_fields[].required_if`, `covers`, `caps[].count_if` | `bool` | `now, customer, booking, session, template, location, request` |
| `candidate` | `select.where`, `applies_to.people_where`, `assignment_expr.must` | `bool` | `now, candidate, session, template` |
| `event` | `trigger.where`, `condition`, `action.when`, action `input`/`vars` values | `bool` / value | `now, event`, plus the event's subjects: `session, booking, customer, assignment, place, roster` |
| `row` | `views[].filter` | `bool` | `now, me, row` |

### Declared types

```text
Counts: { completed: int, upcoming: int, cancelled: int, late_cancelled: int, no_show: int,
          last_completed_at: timestamp|null }
customer: { id: string; tier: string|null; strikes: int; state: string; home_location_key: string|null;
            custom: map<string, dyn>;
            history: { total: Counts; tags: map<string, Counts>; templates: map<string, Counts> } }
Template: { key: string; kind: string; tags: list<string> }
session:  { id; template_key; template: Template; location_key: string; start: timestamp; end: timestamp;
            zone: string; local_date: string; local_start: string; weekday: string;
            booked_count: int; capacity_total: int; waitlist_count: int; status: string; tags: list<string> }
template: Template
location: { key: string; timezone: string }
booking:  { id: string|null; state: string; start: timestamp; end: timestamp; duration_minutes: int;
            booked_via: string; template: Template;   // Booking.booked_via (web, desk, portal, agent, mirror, waitlist)
            payment: { method: 'units'|'price'|'none' };
            entitlement: { product_key: string; kind: string; tier: string|null } | null;
            place: { label: string; partition: string; attributes: map<string, dyn> } | null;
            place_refilled: bool; intake_complete: bool;
            <custom booking fields by key> }
request:  { channel: 'web'|'desk'|'portal'|'agent'|'mirror'|'waitlist'; actor_type: string }
Resource: { id; key: string|null; type: string; kind: string; tags: list<string>; roles: list<string>;
            skills: list<string>; attributes: map<string, dyn>; location_keys: list<string> }
candidate: { resource: Resource; requirement_key: string;
             load: { minutes_day: int; minutes_week: int; assignments_day: int; assignments_week: int } }
assignment: { id: string; requirement_key: string; resource: Resource|null; state: string; source: string }
place:  { id: string; label: string; partition: string; attributes: map<string, dyn> }
roster: { published_through: timestamp }
event:  { name: string; at: timestamp; actor_type: string; reason: string|null;
          domain: 'classes'|'bookings'|'members'|'shifts'|'none';   // §9.2; drives workflow scope (§9.3)
          source: 'platform'|'mirror'; data: map<string, dyn> }
me:     { roles: list<string>; resource_id: string|null; customer_id: string|null; location_keys: list<string> }
row (entity = session): session fields + { assigned_resource_ids: list<string>; template: Template; custom: map }
row (other entities): the entity's public fields + custom
```

- **Map completeness.** `customer.history.tags` and `customer.history.templates` have a zero-filled entry for every tag and template key in the compiled config. So `customer.history.tags['hot']` never raises a missing-key error. Using a key that isn't in the config is a compile error (`UNKNOWN_HISTORY_KEY`).
- **Nulls.** `customer.tier` and `booking.entitlement` can be null. Comparing with null is false. Selecting a field of null is an error. The linter warns about unguarded selection (`EXPR_NULLABLE`). CEL's `&&` and `||` absorb errors when the other side decides the result, so `booking.payment.method == 'units' && booking.entitlement.kind == 'membership'` is false, not an error, for a price-paid booking. For clarity, the examples still guard with `booking.entitlement != null`.

## 5.4 Functions

| Function | Signature | Meaning |
|---|---|---|
| `localDate` / `localTime` / `weekday` | `(timestamp, zone) → string` | Wall-clock parts in the zone |
| `today` | `(zone) → string` | `localDate(now, zone)` |
| `hoursUntil` | `(timestamp) → double` | Hours from now until the timestamp |
| `minutesBetween` | `(timestamp, timestamp) → int` | Elapsed minutes |
| `duration` / `timestamp` | CEL standard | |
| `hasTag` / `hasSkill` | `(x, string) → bool` | Tag test; skill test that ignores expired skills |
| `min`, `max`, `round`, `floor`, `ceil` | numeric | |
| `size`, `contains`, `startsWith`, `endsWith`, `matches` | CEL standard | `matches` takes a literal pattern only |

## 5.5 Sandbox limits

| Limit | Value | Enforced at |
|---|---|---|
| Source length | 2,000 chars | Compile |
| AST nodes / nesting depth | 300 / 12 | Compile |
| Static cost estimate | ≤ 5,000 | Compile |
| Runtime step budget | 10,000 | Evaluate (`EXPR_BUDGET`) |
| Comprehension input | ≤ 256 elements | Evaluate |
| Produced string or list | ≤ 1 KiB / 256 elements | Evaluate |
| Expressions per config | ≤ 2,000 | Compile |
| Wall-clock guard | 2 ms, metrics only | Evaluate |

Decisions depend only on deterministic limits, never on wall time.

## 5.6 Error semantics (fail-safe values)

| Use | On error |
|---|---|
| Eligibility (`eligible_if`, partition `eligible_if`, `covers`) | Not eligible (`EXPR_ERROR`) |
| `approval.required_if` | Approval required |
| `limits[].applies_if` / `count_if` | The limit applies / the booking counts |
| `Penalty.fee_if` | No fee; logged and alerted |
| `Penalty.waive_if` | Not waived for units; fee skipped; logged and alerted |
| `price_rules[].when` | Rule skipped |
| Selector `where`, `assignment_expr` | Candidate excluded |
| Workflow `where` / `condition` / `when` | Action not run; run marked `condition_error` |

If one expression errors 10 or more times within an hour, the tenant's managers are alerted.

## 5.7 Examples (all from §4b.1)

```cel
customer.tier == 'unlimited'                                                    // front-row partition
booking.entitlement != null && booking.entitlement.kind == 'membership'         // late/no-show fee_if
booking.place_refilled                                                          // late waive_if
customer.history.tags['hot'].completed == 0                                     // first hot class → waiver form
!('no_map' in candidate.resource.tags)                                          // vinyasa needs a mapped room
row.location_key in me.location_keys && row.local_date == today(row.zone)       // desk "Today" view
```
