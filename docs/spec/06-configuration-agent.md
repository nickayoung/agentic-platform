# 6. Configuration agent

The configuration agent is an LLM loop that runs in the `kairos-agent` service. It never writes a published config. Its only output is a **draft**: a base version plus JSON Patch operations, with a rationale linked to each statement the owner made. Deterministic services validate, simulate and summarise the draft. A human with the `owner` or `admin` role approves it, and the `kairos-core` service publishes it.

The model is pinned per agent release. Changing the model counts as a release and must pass the eval gate (§14.4).

## 6.1 Pipeline

```
owner message
   │
   ▼
1. Intent capture ──── record_intent: numbered business facts F1..Fn (verbatim quotes + normalised meaning)
   │                   ask_user when a fact is ambiguous or conflicts with current config
   ▼
2. Patch drafting ──── propose_patch: JSON Patch ops, each tagged with the facts it implements
   │                   L1–L3 validation returned immediately; agent repairs (≤ 3 rounds per error)
   ▼
3. Full validation ─── validate: L1–L5 (schema, refs, expressions, semantics, feasibility probe)
   │                   errors → back to 2; warnings → must be acknowledged in the summary
   ▼
4. Simulation ──────── simulate: base vs draft on the same seeded demand (synthetic or historical)
   ▼
5. Impact ──────────── impact: migration plan for existing sessions, bookings, entitlements, scheduled actions
   │                   every impact group needs a resolution (default or chosen) → else IMPACT_UNRESOLVED
   ▼
6. Summary ─────────── explain_diff (deterministic) + agent-written plain-language summary
   │                   summary checker: coverage of ops, citations, numbers match reports
   ▼
7. Approval ────────── owner/admin reviews summary, structured diff, simulation deltas, impact plan
   ▼
8. Publish ─────────── kairos-core: stage migration → activate version → run post-activation ops
   ▼
9. Rollback (any time) publish an older document as a new version (§6.9)
```

Facts that no patch implements are reported back to the owner as **not expressible**, each with the closest supported alternative if there is one. Example: "Text members a birthday coupon" → not expressible: marketing automation is a non-goal. Example: "Charge a $5 surcharge for bikes in the front row" → not expressible in schema 1.0 (there is no per-place price), with the alternative of reserving the front row for a tier. The agent MUST NOT encode an unsupported behaviour as an approximation without the owner explicitly accepting the approximation, which is then recorded as a fact.

## 6.2 Tool definitions

All tools are typed (JSON Schema generated from Zod) and are thin wrappers over the public API (§11). The agent holds a token with `actor.type = agent`, `agent = config` and `on_behalf_of` set to the human in the session. Its scopes are `config:draft` and `config:read` only.

```ts
// Read
get_schema(args: { section?: keyof ConfigDocument }): { json_schema: object; docs_md: string; examples: string[] }
get_config(args: { ref: 'active' | `v${number}` | `draft:${string}`; path?: string }): { value: unknown; version: number }
get_facts(args: { kind: 'staff_summary' | 'resource_summary' | 'demand_history' | 'entitlement_summary' })
  : object  // aggregates only: counts by role/skill/location, weekly booking volume by template; never PII

// Intent
record_intent(args: { draft_id: string; facts: { id: string; quote: string; meaning: string;
                      kind: 'rule' | 'resource' | 'schedule' | 'price' | 'policy' | 'workflow' | 'other' }[] })
  : { facts: Fact[] }
ask_user(args: { question: string; options?: string[]; fact_ids?: string[] }): { answer: string }

// Drafting
create_draft(args: { base: 'active' }): { draft_id: string; base_number: number }
propose_patch(args: { draft_id: string; ops: JsonPatchOp[]; implements: string[]; rationale: string })
  : { applied: boolean; op_ids: string[]; issues: ValidationIssue[] }    // L1–L3 run synchronously
revert_patch(args: { draft_id: string; op_ids: string[] }): { ok: boolean }

// Checking
validate(args: { draft_id: string }): ValidationReport                    // L1–L5
simulate(args: { draft_id: string; profile: string | SimulationProfileDef; compare_to: 'base' })
  : SimulationReport
impact(args: { draft_id: string; resolutions?: ImpactResolution[] }): MigrationPlan
explain_diff(args: { draft_id: string }): StructuredDiff

// Hand-off (no publish tool exists for agents)
submit_for_approval(args: { draft_id: string; summary_md: string; acknowledged_warnings: string[] })
  : { state: 'awaiting_approval' } | { rejected: SummaryCheckFailure[] }
```

**Loop limits:** at most 60 tool calls per owner message, at most 3 repair attempts per distinct issue code and path, and at most 4 simulations per draft. When a limit is hit, the agent stops and reports what is left to the owner.

**Patch path rules:** ops address elements by key, not by array index: `/templates[key=spin_45]/policy`. The server resolves the path to the index. Locked paths (§4.1) return `LOCKED_PATH`.

## 6.3 Validation rules

Issues have `{ code, severity: 'error' | 'warning' | 'info', path, message, related_paths[], fact_ids[] }`. Errors block publish. Warnings must be acknowledged in `submit_for_approval`.

| Layer | Code | Severity | Rule |
|---|---|---|---|
| L1 Schema | `SCHEMA_INVALID` | error | Fails Zod parse |
| | `DURATION_GRAIN` | error | A session duration, buffer, step or start time is not a multiple of 5 minutes |
| | `LOCKED_PATH` | error | The patch touches a locked path |
| L2 References | `UNKNOWN_REF` | error | Unknown key: template→policy, series→template/location, selector→type/role/skill, cost→unit, product→tier/unit, partition release `to` |
| | `DUPLICATE_KEY` | error | Duplicate key within a collection |
| | `STAFF_REF_MISSING` | error | `@staff:` reference not found among active people |
| | `CAPACITY_REQUIREMENT_MISSING` | error | Capacity refers to a requirement that doesn't exist, isn't a space, or (for assigned capacity) lacks `provides_layout` |
| | `FIXED_AMBIGUOUS` | error | A `fixed` requirement on a rostered or on-demand template matches more than one resource at some location |
| | `LAYOUT_MISSING` | error | Assigned capacity, but the selected space has no layout |
| L3 Expressions | `EXPR_SYNTAX`, `EXPR_TYPE`, `EXPR_UNKNOWN_VAR`, `EXPR_COST`, `UNKNOWN_HISTORY_KEY` | error | §5 |
| | `EXPR_NULLABLE` | warning | Unguarded selection on a nullable field |
| L4 Semantics | `WINDOW_INVERTED` | error | `opens` is not before `closes` for a typical session |
| | `CANCEL_AFTER_START` | error | `free_until` is after session start |
| | `MIN_ATTENDANCE_GT_CAPACITY` | error | `min_attendance.min` > the smallest capacity of any session using the policy |
| | `PARTITION_OVERLAP` / `PARTITION_EXCEEDS_CAPACITY` | error | A spot is in two partitions, or partition counts exceed capacity |
| | `TIMETABLE_CONFLICT` | error | Two series, expanded over the horizon, claim the same fixed resource at overlapping times. Lists the first 10 collisions |
| | `SERIES_OUTSIDE_HOURS` | error | An occurrence falls outside location or resource open hours |
| | `UNSATISFIABLE_SELECTOR` | error/warning | No structural resource matches (error); no current person matches (warning: people are data) |
| | `PAYMENT_IMPOSSIBLE` | error | `units_only`, but no product grants the unit and covers the template |
| | `COVERAGE_UNCOVERABLE` | error | A coverage interval can't be covered by any allowed shift start and duration |
| | `HARD_CONTRADICTION` | error | Contradictory hard rules, e.g. `shift_length.min` > `max`; `max_hours/day` < the shortest shift of every allowed template for that role; `allowed_hours` narrower than every shift template a role can fill |
| | `WAITLIST_SCHEDULE_UNORDERED` | error | `schedule[].until` offsets are not strictly decreasing before start |
| | `WORKFLOW_CYCLE` | error | Static graph: an action emits an event that re-triggers the same workflow without a terminating condition |
| | `FEE_ABOVE_CEILING` | error | Fee above the tenant's configured ceiling (default 100 in the major unit), which only an owner can raise |
| | `WAITLIST_OFFERS_SILENT` | warning | A waitlist schedule uses `offer_all`, but no workflow notifies on `waitlist.offered` |
| | `KIND_MISMATCH` | warning | Label and shape disagree, e.g. `kind: shift` with customer participants |
| L5 Feasibility | `INFEASIBLE_HARD_CONSTRAINTS` | error | The solver probe (§8.5) proves no assignment can satisfy the hard constraints for the probe window. Includes the minimal conflicting set |
| | `FEASIBILITY_UNKNOWN` | warning | The probe timed out (20 s) |
| L7 Impact | `IMPACT_UNRESOLVED` | error | An impact group has no resolution |

**The L5 probe** takes the next two weeks of materialised demand (timetable sessions plus coverage) and current people data. It builds the solver IR with **only hard constraints** and asks CP-SAT for any feasible solution, with each hard constraint group behind an assumption literal (§8.5). It reports the minimal infeasible subset in words, for example:

> These rules can't all hold for the week of 9 Nov: **coverage `servers` (Fri 17:30–23:00 needs 5 servers)**, **`weekly_40`**, and **`no_clopen`**. Only 7 people have the role `server`, and they can supply at most 4 people for that window under those rules.

## 6.4 Simulation design

**Where:** simulations run in the batch worker (§12.1), not at the edge. The worker runs the same `@kairos/engine` package that the edge functions use, with an in-memory SQLite adapter and a virtual clock.

**Inputs:**

1. *State snapshot:* the tenant's future sessions, bookings, entitlements and people from now until the end of the horizon. Customers are pseudonymised: IDs are replaced and PII is dropped before data leaves the tenant DB.
2. *Demand:*
   - `synthetic`: per-template arrival processes from the profile (§4.14). Booking requests arrive at `session.start − LeadTime` with an exponential lead-time distribution. Each request has a tier sampled from `tier_mix`. Cancellations, late cancellations and no-shows are sampled with the profile's rates.
   - `historical`: the last N weeks of real booking requests, including rejected ones where they were logged, shifted forward by whole weeks so weekdays line up. For the reference tenant this comes from mirrored data (§18).
3. *Seed:* the same seed for base and draft. The streams of requests are identical, so the deltas show only the effect of the config.

**Execution:** a discrete-event loop over a priority queue ordered by `(virtual_time, sequence)`. Each event calls the real engine API in process: `hold`, `book`, `cancel`, `check_in`, workflow timers, and roster solve requests. This is the same code path as production. Simulations are deterministic: a seeded PRNG (xoshiro128**) and no wall clock.

**Outputs (`SimulationReport`), for base and draft with deltas:**

| Metric | Definition |
|---|---|
| Fill rate per template | booked places at start ÷ capacity |
| Rejections by reason code | e.g. `LIMIT_REACHED` +212 |
| Waitlist joins, promotions, expired offers | |
| Sessions cancelled by `min_attendance` | |
| Late-cancel and no-show fees assessed or waived (count and amount) | |
| Entitlement units consumed or forfeited | |
| Resource utilisation | per room and per person, % of available time |
| Roster outcome | feasible?, coverage shortfall minutes, soft-constraint penalties by key, hours by person (min/median/max) |
| Hard-constraint violations | must be 0; any non-zero value is an engine bug and fails the simulation |

**Budget:** horizon ≤ 8 weeks, ≤ 200k simulated requests, ≤ 90 s wall time per run.

## 6.5 Diff presentation

What the approver sees, in order:

1. **Plain-language summary**, written by the agent and checked mechanically. Every sentence cites op IDs (`[op:7]`). Every op is cited at least once. Every number in the summary must match a value in the simulation or impact report: numbers are extracted and compared to the reports, and a mismatch rejects the summary with `SUMMARY_NUMBER_MISMATCH`.
2. **What changes for people**, a deterministic, templated section built from the impact plan:
   "14 future bookings are affected. 12 keep their original cancellation terms. 2 sessions on 24 and 31 Dec will be cancelled; 31 riders will be notified and refunded 31 credits."
3. **Simulation deltas**, a table of base vs draft for the metrics that moved by more than 2 %.
4. **Warnings acknowledged.**
5. **Structured diff**, grouped by entity: added, removed and changed fields, with before and after values. A YAML diff is available collapsed.
6. **Facts → ops trace**, with facts marked *not expressible* at the top.

Example summary (spin studio, owner said "make late cancel 8 hours and stop charging if someone takes the bike"):

> - Late-cancellation cutoff moves from 12 hours to **8 hours** before class [op:1]. The change is more lenient and the policy is `lenient_only`, so **existing bookings move to the 8-hour cutoff as well** [op:1, impact:g1].
> - The $15 late fee for unlimited members is **waived when the bike is re-booked** before class [op:2].
> - Over 4 simulated weeks, late cancellations rise from 61 to 74 and fees charged fall from $915 to $420 [sim].

## 6.6 Approval

- Approval requires the `owner` or `admin` role, given by the staff sign-in service. It cannot be given by an agent token.
- The approver can approve, reject, or ask for changes (which go back to the agent with comments).
- The approval records the draft's `content_hash`. If the draft changes after the summary was generated, the approval is invalid (`DRAFT_CHANGED`).

## 6.7 Versioning

- Versions are immutable. `number` increases monotonically per tenant and environment. `content_hash` is a hash of the canonical JSON.
- `effective_from` may be in the future (scheduled publish). The materialiser and the engines choose the active version per I-01.
- Each environment has its own version history. Promoting from preview to production replays the **document** and recomputes validation, simulation and impact against production data. Versions are not copied directly.
- Engines cache the compiled config per isolate, keyed by `(tenant, env, number)`. A publish increments a per-tenant `config_epoch` in the tenant DB. Each request reads the epoch together with its first query, so no request can use a stale version after activation.

## 6.8 Existing bookings when rules change (migration)

**Principle:** a config change never silently changes a customer's confirmed booking. Changes either do not apply to existing bookings, or apply through an explicit, approved migration plan.

| Change | Default handling | Owner options |
|---|---|---|
| Booking window, eligibility, limits, price | Not retroactive. Existing bookings stand | — |
| Cancellation or no-show terms | Bookings keep their `TermsSnapshot`. If `retroactive: lenient_only` and the new terms are **more lenient on every axis** (fee ≤ old, `forfeit_units` not newly true, `free_until` not earlier, `waive_if` not narrower as judged by the linter), the new terms are applied to existing snapshots | Keep old terms |
| Capacity reduced below booked count | Existing bookings are kept. The session is marked over capacity and accepts no new bookings | Move the last-booked N to the top of the waitlist, with refunds and notices |
| Layout change removes spots | Re-seat on a spot with equal attributes, else the best available; customers are notified | Cancel and refund affected bookings |
| Series removed or retimed | **No default.** Each affected session with bookings forms an impact group | (a) keep as a one-off session at the old time; (b) cancel, refund and notify; (c) cancel and offer the new time with priority (a hold for 24 h) |
| Requirement made stricter (e.g. new required skill) | Existing assignments that now fail are flagged. Sessions go to `needs_staff`, which triggers the substitute flow | Keep, as a recorded exception |
| Entitlement product changed | Existing entitlements keep their product snapshot (`product_hash`) until renewal | Apply at once (only if more lenient) |
| Workflow changed or removed | Pending scheduled actions of removed workflows are cancelled. Those of changed workflows are re-planned under the new definition, idempotently (§9.5) | — |
| Limit max lowered | Counter rows get `max = max(new, current count)`. Existing bookings are kept | — |

**Publish procedure (kairos-core):**

1. **Stage:** write the `ConfigVersion` with `state = staged` and store the approved `MigrationPlan`.
2. **Pre-activation ops:** idempotent batches (≤ 100 rows each) that need the old config: snapshot terms where needed, and mark sessions to be cancelled.
3. **Activate:** in one batch, set the active version pointer, increment `config_epoch`, and write the audit entry.
4. **Post-activation ops:** cancellations with refunds, re-seating, re-planning workflow actions, and materialising new series. Each op is idempotent and keyed by `(version, op_id)`. Notifications go through the outbox.
5. Progress is visible in `GET /config/versions/{n}/migration`. A failed op retries with backoff. After 5 failures it is parked and alerts the approver. It never blocks activation, because each op is independent.

## 6.9 Rollback

- **Rollback is forward-only:** publish the document of version *k* as a new version *n+1* with `rollback_of = k`. Impact analysis runs from *n* to *k*. Bookings made under *n* stay valid under their own terms snapshots.
- **Emergency rollback** (owner or admin, `POST /config/rollback`) skips simulation. It still runs L1–L4 and impact, and impact groups get the safest default (keep). Target: active in ≤ 60 s.
- Domain-mode rollbacks (mirror/shadow/owner) are a separate procedure (§18.7).
