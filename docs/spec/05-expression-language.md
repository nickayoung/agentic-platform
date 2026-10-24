# 5. Expression language

## 5.1 Choice: CEL (Common Expression Language), restricted profile (D-01)

| Criterion | CEL | JSONLogic |
|---|---|---|
| Static type checking against a declared environment | Yes. The checker rejects unknown fields and type mismatches at publish time | No. Errors surface at runtime |
| Guaranteed termination, no side effects | Yes. Non-Turing-complete by design | Yes |
| Cost estimation before execution | Yes. The spec defines a cost model | No |
| Readable in diffs and by owners | `customer.tier == 'premium' && session.booked_count < 3` | `{"and":[{"==":[{"var":"customer.tier"},"premium"]},{"<":[{"var":"session.booked_count"},3]}]}` |
| LLM generation accuracy | High: C-like syntax, well represented in training data | Lower: deeply nested JSON, easy to get brackets wrong |
| Time and duration types | Built-in `timestamp`, `duration` | None; everything is a number or string |
| TypeScript runtime maturity | Moderate: community implementations | High: tiny and stable |

CEL wins on the two properties that matter most for an agent-written config: **static checking** (an LLM's mistakes are caught when the config is validated, not when a member tries to book) and **readability in the approval diff**. The main risk is the maturity of TypeScript implementations. We mitigate it by keeping the profile small and gating any library on a conformance suite:

- `packages/expr` exposes `compile(source, slot) → CompiledExpr | CompileError[]` and `evaluate(compiled, activation) → Value | EvalError`.
- It wraps a maintained TypeScript CEL implementation. That implementation MUST pass our profile's subset of the `cel-spec` conformance tests, plus our own tests (§14.1). If no library passes, we build the profile in house (parser, checker and tree-walking evaluator, estimated at ≈3–4k lines), because the profile is deliberately small.
- Compiled ASTs are stored in `CompiledConfig`. Edge functions never parse CEL in the hot path.

## 5.2 Profile: what is allowed

**Allowed:** literals (int, double, string, bool, null, list, map); field selection; indexing; `== != < <= > >= && || ! ?:`; arithmetic `+ - * / %` on numbers; `+` on timestamps and durations; `in`; the macros `has`, `all`, `exists`, `exists_one`, `filter`, `map` over lists in the activation; the functions listed in §5.4.

**Not allowed:** user-defined functions; protobuf messages and type construction; `bytes`; regular expressions other than `matches` with a literal RE2 pattern of ≤ 128 characters; any extension not listed in §5.4. Nothing can do I/O, read the clock or produce randomness. `now` is a variable bound by the engine.

## 5.3 Slots and their environments

Every config field of type `Expr` belongs to a **slot**. The slot fixes the declared variables and the required result type. The checker rejects an expression that refers to a variable not in its slot.

| Slot | Used by | Result | Variables |
|---|---|---|---|
| `booking` | `template.eligible_if`, `policy.eligible_if`, `price_rules[].when`, `partitions[].eligible_if`, `limits[].count_if/applies_if`, `Penalty.fee_if/waive_if`, `approval.required_if`, `cost.units[].amount`, `intake.when`, `custom_fields[].required_if`, `entitlement_products[].covers`, `caps[].count_if` | `bool` (`double` for `units.amount`) | `now, customer, booking, session, template, location, request` |
| `candidate` | `ResourceSelector.where`, `rank.expr`, `ConstraintDef.applies_to.people_where`, `assignment_expr.must` | `bool` (`double` for `rank.expr`) | `now, candidate, session, template, booking?` (booking is present only at booking time) |
| `event` | `workflow.trigger.where`, `workflow.condition`, `action.when`, action input values | `bool` / value | `now, event` + the subjects the event carries: `session, booking, customer, assignment, place, roster` |
| `row` | `views[].filter` | `bool` | `now, me, row` |

### Declared types

```text
customer:
  id: string; tier: string|null; strikes: int; tags: list<string>
  custom: map<string, dyn>            // custom fields of entity=customer
  history:
    total:     Counts
    tags:      map<string, Counts>    // keyed by template tag
    templates: map<string, Counts>    // keyed by template key
Counts: { completed: int, upcoming: int, cancelled: int, late_cancelled: int, no_show: int,
          last_completed_at: timestamp|null }

session:
  id; template_key; location_key: string|null; start: timestamp; end: timestamp; zone: string
  local_date: string ("2026-11-03"); local_start: string ("18:30"); weekday: string ("tue")
  booked_count: int; capacity_total: int; waitlist_count: int; status: string; tags: list<string>
  template: Template                  // shorthand for the session's template
template / Template: { key: string; kind: string; tags: list<string> }
location: { key: string; timezone: string }

booking:
  id: string|null (null while proposed); state: string; start: timestamp; end: timestamp
  duration_minutes: int; channel: string; template: Template
  payment: { method: 'units'|'price'|'none' }
  entitlement: { product_key: string; kind: string; tier: string|null } | null
  place: { label: string; partition: string; attributes: map<string, dyn> } | null
  place_refilled: bool; intake_complete: bool
  <custom booking fields by key>      // e.g. booking.party_size
  resource(key: string) -> Resource   // member function: the resource assigned to requirement `key`

request: { channel: 'web'|'desk'|'portal'|'agent'|'mirror'|'waitlist'; actor_type: string }

candidate:
  resource: Resource
  requirement_key: string
  load: { minutes_day: int; minutes_week: int; assignments_day: int; assignments_week: int }
  history_with_customer: int          // completed sessions with this booking's customer (0 outside booking)
Resource: { id; key: string|null; type: string; kind: string; tags: list<string>; roles: list<string>;
            skills: list<string>; attributes: map<string, dyn>; location_keys: list<string> }

assignment: { id: string; requirement_key: string; resource: Resource|null; state: string; source: string }
place: { id: string; label: string; partition: string; attributes: map<string, dyn> }
roster: { published_through: timestamp }  // end of the latest published roster for the trigger's location
event:  { name: string; at: timestamp; actor_type: string; reason: string|null; data: map<string, dyn> }
me:     { roles: list<string>; resource_id: string|null; customer_id: string|null; location_keys: list<string> }
row:    the view entity with its computed fields and custom.<key>
```

**Map completeness guarantee.** `customer.history.tags` and `customer.history.templates` contain an entry, zero-filled if needed, for **every** tag and template key in the compiled config. So `customer.history.tags['assessment']` never raises a missing-key error. Keys that are not in config (a typo) are caught at compile time: the checker knows the key set and reports `UNKNOWN_HISTORY_KEY`.

**Null handling.** `customer.tier` is `null` when the customer holds no tiered entitlement. Comparisons with `null` follow CEL semantics (`null == 'x'` is false). Selecting a field of `null` is an evaluation error. Authors use `has()` or `!= null` guards, and the linter warns about unguarded nullable selections.

## 5.4 Functions (extensions)

| Function | Signature | Meaning |
|---|---|---|
| `localDate` | `(timestamp, string zone) → string` | `"2026-11-03"` in that zone |
| `localTime` | `(timestamp, string zone) → string` | `"18:30"` |
| `weekday` | `(timestamp, string zone) → string` | `"tue"` |
| `today` | `(string zone) → string` | `localDate(now, zone)` |
| `hoursUntil` | `(timestamp) → double` | `(t - now)` in hours; negative if past |
| `minutesBetween` | `(timestamp, timestamp) → int` | elapsed minutes, b − a |
| `duration` | `(string) → duration` | CEL standard, e.g. `duration('2h')` |
| `timestamp` | `(string) → timestamp` | CEL standard, RFC 3339 |
| `hasTag` | `(Resource\|template\|session, string) → bool` | tag membership |
| `hasSkill` | `(Resource, string) → bool` | non-expired skill |
| `min`, `max` | `(number, number) → number` | |
| `round`, `floor`, `ceil` | `(double) → int` | |
| `size`, `contains`, `startsWith`, `endsWith`, `matches` | CEL standard | `matches` only with a literal pattern |

## 5.5 Sandbox limits

| Limit | Value | Enforced at |
|---|---|---|
| Source length | 2,000 characters | compile |
| AST nodes | 300 | compile |
| Nesting depth | 12 | compile |
| Static cost estimate (CEL cost model) | ≤ 5,000 | compile |
| Runtime step budget | 10,000 evaluator steps | evaluate (aborts with `EXPR_BUDGET`) |
| Comprehension input size | ≤ 256 elements | evaluate |
| String or list produced | ≤ 1 KiB / 256 elements | evaluate |
| Expressions per config | ≤ 2,000 | compile |
| Wall-clock guard | 2 ms per evaluation, logged; not used for decisions | evaluate (metrics only) |

Decisions depend only on deterministic limits: AST size, cost and step budget. Wall time is never a decision input, so a slow node cannot change an outcome.

## 5.6 Error semantics

The engine never treats an evaluation error as "true". Each slot defines its **fail-safe value**:

| Slot use | On error | Reason code |
|---|---|---|
| Eligibility (`eligible_if`, `partitions[].eligible_if`, `covers`) | not eligible | `EXPR_ERROR` with the config path |
| `approval.required_if` | approval required | `EXPR_ERROR` |
| `limits[].applies_if` | the limit applies | — |
| `limits[].count_if` | the booking counts | — |
| `Penalty.fee_if` | no fee (do not charge on uncertainty) | logged and alerted |
| `Penalty.waive_if` | not waived; the forfeit happens but the fee is skipped | logged and alerted |
| `price_rules[].when` | rule skipped | logged |
| `cost.units[].amount` | booking denied | `EXPR_ERROR` |
| Selector `where`, `assignment_expr` | candidate excluded | — |
| `rank.expr` | score 0 | logged |
| Workflow `where`/`condition`/`when` | action not run | run marked `condition_error` |

Errors raise a `config.expression_error` event. Ten or more errors from one expression within an hour alert the tenant's managers.

## 5.7 Examples

```cel
// Physio: follow-ups need an assessment, completed or booked
customer.history.tags['assessment'].completed > 0 || customer.history.tags['assessment'].upcoming > 0

// Spin: charge a late-cancel fee only to unlimited members, and waive it when the bike was re-sold
booking.payment.method == 'units' && booking.entitlement.kind == 'membership'     // fee_if
booking.place_refilled                                                           // waive_if

// Coworking: tier-dependent horizon
customer.tier == 'team' || (customer.tier == 'resident' && hoursUntil(session.start) <= 336.0)

// Restaurant: under-18s cannot serve dinner (selector where)
candidate.resource.attributes.age >= 18

// Workflow: only 6 a.m. classes
weekday(session.start, session.zone) != 'sun' && session.local_start == '06:00'
```
