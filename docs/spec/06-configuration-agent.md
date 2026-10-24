# 6. Configuration agent

The configuration agent is an LLM loop in the `kairos-agent` service. It only produces **drafts**: a base version, JSON Patch operations, and a rationale linked to the owner's statements. Deterministic services validate, simulate and summarise each draft. A human `owner` or `admin` approves it, and `kairos-core` publishes it. The model is pinned per agent release, and changing the model is a release that must pass the eval gate (§14.4).

A **manual path** uses the same pipeline without the agent: `PATCH /config/drafts/{id}` with JSON Patch, from an admin UI or from the CLI in the IaC repo. It ships in Phase 0, so Phase 1 can publish configs before the agent exists (§15).

## 6.1 Pipeline

```
owner message
  1. Intent capture   record_intent: numbered facts F1..Fn (quote + meaning); ask_user when ambiguous
  2. Drafting         propose_patch: ops tagged with fact ids; L1–L3 checks returned at once (≤ 3 repairs per issue)
  3. Validation       validate: L1–L5
  4. Simulation       simulate: base vs draft on the same seeded demand
  5. Impact           impact: migration plan; every impact group needs a resolution
  6. Summary          explain_diff (deterministic) + agent summary, checked mechanically
  7. Approval         owner/admin approves, bound to the draft's content hash
  8. Publish          stage → activate → post-activation ops (§6.8)
  9. Rollback         republish an older document (§6.9)
```

If no op implements a fact, the agent reports it to the owner as **not expressible** and names the nearest supported alternative. Examples:

- "Charge $5 extra for front-row mats": not expressible in schema 2.0, because there is no price per place (Q-04). Alternative: reserve the front row for a tier.
- "Text members a birthday discount": a non-goal (marketing).

The agent MUST NOT approximate a behaviour unless the owner accepts the approximation, and the acceptance is recorded as a fact.

## 6.2 Tools

All tools are typed wrappers over the public API (§11). The agent's token carries `actor.type = agent`, `agent = config`, `on_behalf_of` = the human, and scopes `config:read` and `config:draft`.

```ts
get_schema({ section? }): { json_schema; docs_md; examples }
get_config({ ref: 'active' | `v${n}` | `draft:${id}`, path? }): { value; version }
get_facts({ kind: 'staff_summary' | 'room_summary' | 'demand_history' | 'entitlement_summary' })  // aggregates only, no PII
record_intent({ draft_id, facts: { id; quote; meaning; kind }[] })
ask_user({ question; options?; fact_ids? }): { answer }
create_draft({ base: 'active' }): { draft_id; base_number }
propose_patch({ draft_id; ops: JsonPatchOp[]; implements: string[]; rationale }): { applied; op_ids; issues }
revert_patch({ draft_id; op_ids })
validate({ draft_id }): ValidationReport
simulate({ draft_id; profile; compare_to: 'base' }): SimulationReport
impact({ draft_id; resolutions? }): MigrationPlan
explain_diff({ draft_id }): StructuredDiff
submit_for_approval({ draft_id; summary_md; acknowledged_warnings }): { state } | { rejected }
```

**Limits.** Per owner message: at most 60 tool calls, 3 repairs per issue (same code and path), and 4 simulations per draft.

**Path rules.** Paths address elements by key, not array index: `/templates[key=hot_75]/policy`.

**Edit scopes.** The agent expresses the series edit scopes ("this and following", "all") with the ops defined in §4.7.

## 6.3 Validation rules

Errors block publish. Warnings must be acknowledged when the draft is submitted.

| Layer | Code | Sev. | Rule |
|---|---|---|---|
| L1 | `SCHEMA_INVALID` | E | Zod parse fails |
| L1 | `DURATION_GRAIN` | E | A duration, buffer or series start is not a multiple of 5 minutes |
| L1 | `LOCKED_PATH` | E | §4.1.1 |
| L2 | `UNKNOWN_REF` | E | A key reference does not resolve (policy, template, location, type, role, skill, unit, tier, layout, partition `to`, form, coverage template) |
| L2 | `DUPLICATE_KEY` | E | Two elements in one collection share a key |
| L2 | `STAFF_REF_MISSING` | E | An `@staff:` reference does not match an active person |
| L2 | `CAPACITY_REQUIREMENT_MISSING` | E | Capacity names a missing requirement, a non-space requirement, or (for assigned capacity) one without `provides_layout` |
| L2 | `LAYOUT_MISSING` | E | Assigned capacity, but at least one candidate room has no layout |
| L2 | `FIXED_AMBIGUOUS` | E | A `fixed` requirement on a rostered template matches more than one resource at some studio |
| L2 | `ROLE_NAME_CLASH` | E | A config role key equals a PlatformRole |
| L2 | `FIELD_SHADOWS_BUILTIN` | E | A custom field key equals a built-in field |
| L3 | `EXPR_SYNTAX` / `EXPR_TYPE` / `EXPR_UNKNOWN_VAR` / `EXPR_COST` / `UNKNOWN_HISTORY_KEY` | E | §5 |
| L3 | `EXPR_NULLABLE` | W | A nullable field is selected without a guard |
| L4 | `WINDOW_INVERTED` | E | `opens` is not before `closes` |
| L4 | `CANCEL_AFTER_START` | E | `free_until` is after the start |
| L4 | `MIN_ATTENDANCE_GT_CAPACITY` | E | `min_attendance.min` > the smallest capacity of any session that uses the policy |
| L4 | `PARTITION_OVERLAP` / `PARTITION_EXCEEDS_CAPACITY` | E | A spot is in two partitions, or the partition counts exceed capacity |
| L4 | `PARTITION_SPOT_MISSING` | E | A partition names spot keys that don't exist in every layout of every room the template can use. Use tags instead |
| L4 | `TIMETABLE_CONFLICT` | E | Over the horizon, two series claim the same room at overlapping times (the first 10 collisions are listed) |
| L4 | `SERIES_OUTSIDE_HOURS` | E | An occurrence falls outside studio or room hours |
| L4 | `UNSATISFIABLE_SELECTOR` | E/W | No room matches (error); no current person matches (warning) |
| L4 | `PAYMENT_IMPOSSIBLE` | E | `units_only`, but no product grants the unit and covers the template |
| L4 | `COVERAGE_UNCOVERABLE` | E | A coverage interval cannot be covered by any allowed shift start and duration |
| L4 | `HARD_CONTRADICTION` | E | Contradictory hard rules, e.g. `max_hours/day` < the shortest shift for a role |
| L4 | `WAITLIST_SCHEDULE_UNORDERED` | E | Waitlist schedule offsets are not strictly decreasing |
| L4 | `UNSTAFFED_AFTER_DEADLINE` | W | `unstaffed.check_at` is later than the `sub_finder` workflow's deadline offset |
| L4 | `WORKFLOW_CYCLE` | E | Static cycle in the workflow event graph |
| L4 | `FEE_ABOVE_CEILING` | E | A fee is above `tenant.fee_ceiling` |
| L4 | `WAITLIST_SILENT` | W | `offer_all` mode with no workflow on `waitlist.offered`, or no workflow on `waitlist.skipped` |
| L4 | `KIND_MISMATCH` | W | `kind: shift` with customers, or `kind: class` with `participants: none` |
| L4 | `DST_SHIFTED_OCCURRENCE` | I | An occurrence falls on a non-existent local time (§7.10) |
| L5 | `INFEASIBLE_HARD_CONSTRAINTS` | E | The solver probe proves the hard rules can't all hold. The minimal conflicting set is reported (§8.4) |
| L5 | `FEASIBILITY_UNKNOWN` | W | The probe timed out after 20 s |
| L7 | `IMPACT_UNRESOLVED` | E | An impact group has no resolution |

**L5 probe.** Takes the next two weeks of classes (teacher slots) and desk coverage, with current people, availability, time off and all mirrored claims. Only hard rules are checked, each wrapped in an assumption literal. Example report:

> These rules can't all hold for the week of 8 Mar: **`ps_desk_cover` (Mon–Thu 17:00–20:00 needs 2 desk staff)**, **`desk_week`**, **`desk_rest`**. Only 5 people have role `desk_staff` at Park Slope, and under those rules they can cover at most 3 of the 4 evenings.

## 6.4 Simulation

Simulations run in the batch worker. They use the same `@kairos/engine` package as production, with an in-memory SQLite and a virtual clock.

**Inputs**
- A pseudonymised snapshot of the future: sessions, bookings, entitlements and people.
- Demand, from one of two sources:
  - *synthetic*: arrivals from the profile;
  - *historical*: the last N weeks of real requests, shifted forward by whole weeks. For the reference tenant this data comes from the mirror.
- A seed shared by base and draft.

**Execution.** A discrete-event loop calls the real engine for holds, bookings, cancellations, check-ins, timers and roster solves. It uses xoshiro128\*\* seeded, so runs are deterministic.

**Outputs** (base vs draft):
- fill rate per template;
- rejections by reason code;
- waitlist joins, promotions and expiries;
- classes cancelled for minimum attendance or unstaffed;
- fees assessed or waived;
- units consumed or forfeited;
- room and teacher utilisation;
- roster feasibility, coverage shortfall and soft penalties;
- hard-rule violations, which must be 0 (any violation fails the run as an engine bug).

**Budget:** a horizon of 8 weeks or less, at most 200k requests, and at most 90 s.

## 6.5 Diff presentation

The approver sees, in order:

1. **Agent summary.** Each sentence cites op IDs, and every op is cited. Every number must match the simulation or impact report; otherwise the summary is rejected with `SUMMARY_NUMBER_MISMATCH`.
2. **"What changes for people"** (deterministic, from the impact plan).
3. **Simulation deltas** above 2 %.
4. **Acknowledged warnings.**
5. **Structured diff**, with the YAML diff collapsed.
6. **Facts → ops trace**, with not-expressible facts first.

Example (owner: "make late cancel 8 hours and stop charging if someone takes the mat"):

> - The late-cancellation cutoff moves from 12 hours to **8 hours** before class [op:1]. The change is more lenient and the policy is `lenient_only`, so existing bookings move to 8 hours too [op:1, impact:g1].
> - The $10 late fee for members is **waived when the mat is re-booked** [op:2].
> - Over 4 simulated weeks, late cancellations rise from 58 to 71, and fees charged fall from $410 to $190 [sim].

## 6.6 Approval

- Only owner or admin tokens from the staff sign-in service can approve. Agent tokens cannot.
- An approval is bound to the draft's `content_hash`. If the draft changes afterwards, the approval fails with `DRAFT_CHANGED`.
- The approver can approve, reject, or ask for changes. Comments go back to the agent.

## 6.7 Versioning

- Versions are immutable, numbered per tenant and environment, and content-hashed.
- `effective_from` may be in the future.
- Promoting from preview to production replays the **document** and recomputes validation, simulation and impact against production data.
- Engines cache compiled config by `(tenant, env, number)`. Publishing increments a `config_epoch`, which each request reads together with its first query.

## 6.8 Existing bookings when rules change

Principle: a confirmed booking never changes silently.

| Change | Default | Owner options |
|---|---|---|
| Booking window, eligibility, limits, price | Not retroactive | — |
| Cancellation, no-show or refund terms | Existing bookings keep their `TermsSnapshot`. Under `lenient_only`, terms that are more lenient on every axis are applied to existing bookings too | Keep old terms |
| Capacity reduced below booked | Existing bookings are kept; the session is marked over capacity and closed to new bookings | Move the last-booked N to the top of the waitlist, with refunds |
| Layout change removes mats | Re-seat on a mat with equal attributes, else the best free mat, else cancel and refund; notify | Cancel all affected |
| Series removed or retimed ("this and following", "all") | **No default.** One impact group per booked session | (a) keep as a detached one-off at the old time; (b) cancel, refund, notify; (c) cancel and offer the new time with a 24 h priority hold |
| Stricter requirement (new required skill) | Assignments that now fail are flagged → `needs_staff` → substitute flow | Keep as an exception |
| Product changed | Existing entitlements keep their `product_hash` until renewal | Apply now (only if more lenient) |
| Workflow changed or removed | Pending actions of removed workflows are cancelled; changed workflows are re-planned idempotently (§9.5) | — |
| Limit max lowered | `max = max(new, current count)`; existing bookings kept | — |
| Studio closed or room removed | §3.12.2 / §3.12.3 | — |

**Publish:**

1. Stage the version and store the approved plan.
2. Run pre-activation ops.
3. Activate in one batch: active pointer, `config_epoch`, audit.
4. Run post-activation ops (cancellations, refunds, re-seating, re-planning, materialisation). Each op is idempotent per `(version, op_id)`.
5. Track progress at `GET /config/versions/{n}/migration`. Ops that fail 5 times are parked and alerted. They never block activation.

## 6.9 Rollback

- Rollback publishes version *k*'s document as version *n+1*, with `rollback_of = k`. Impact is computed from *n* to *k*. Bookings made under *n* keep their own terms.
- **Emergency rollback** (owner or admin) skips simulation but still runs L1–L4 and impact, taking the safest defaults. Target: under 60 s.
- Domain-mode rollback is a separate procedure (§18.7).
