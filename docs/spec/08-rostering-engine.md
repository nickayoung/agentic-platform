# 8. Rostering and optimisation engine

The rostering engine answers "who should work, teach or drive what, and when?". It runs as **batch jobs**, never inside a booking request. Every solution is a **proposal**. A TypeScript validator checks it independently (§8.6), an authorised person approves it (or a policy auto-approves it), and the commit goes through the same occupancy constraints as everything else.

## 8.1 Choice: Google OR-Tools (CP-SAT, plus the OR-Tools routing library) over Timefold (D-02)

| Criterion | OR-Tools CP-SAT | Timefold Solver |
|---|---|---|
| Proves infeasibility and returns a conflicting subset of constraints | **Yes.** Solving with assumptions gives `SufficientAssumptionsForInfeasibility` | No. Local search reports a negative hard score, not a proof or a minimal set |
| Optimality bounds and gap reporting | Yes | No (anytime heuristic) |
| Rostering (intervals, no-overlap, linear sums) | Native: `NewOptionalIntervalVar`, `AddNoOverlap`, linear constraints | Strong, via constraint streams |
| Vehicle routing with time windows | The OR-Tools routing library ships in the same package | Strong |
| Runtime | C++ core; Python, Java, C# and Go bindings; one pip package | JVM (Java/Kotlin) or Python via JPype |
| Fit with a small TypeScript team | Thin Python worker that reads a JSON IR; all business logic stays in TypeScript | A JVM service with business rules written in Java constraint streams |
| Licence | Apache-2.0 | Apache-2.0 (community edition); some enterprise features are commercial |

The deciding factor is **infeasibility reporting**. The spec requires that infeasible configs return *which constraints conflict*. CP-SAT gives this as a solver feature. With Timefold it would have to be approximated. Neither solver runs at the network edge, so either one means a container worker. OR-Tools keeps that worker small: it translates a JSON IR into model calls, and all business meaning stays in TypeScript.

## 8.2 Architecture

```
kairos-core (edge, TS)                                  solver worker (container, Python + OR-Tools)
┌─────────────────────────────────────┐   POST /solve   ┌──────────────────────────────────────┐
│ 1. Problem builder                  │  (IR JSON,      │ 4. IR → CP-SAT model / routing model │
│    - load compiled config           │   signed)       │ 5. solve with time limit             │
│    - load people, availability,     │ ──────────────▶ │ 6. if infeasible: core extraction    │
│      existing claims (ALL domains,  │                 │    + minimisation                    │
│      incl. mirrored), published     │ ◀────────────── │ 7. return solution or core           │
│      roster                         │   callback      └──────────────────────────────────────┘
│    - evaluate CEL to constants      │   (signed)
│ 2. Pre-solve checks (pigeonhole)    │
│ 3. Emit IR                          │
│ 8. Validate solution (TS validator) │
│ 9. Create Proposal → approval       │
│ 10. Commit (saga of guarded batches)│
└─────────────────────────────────────┘
```

- **No CEL in the solver.** Every expression (`where`, `people_where`, `assignment_expr`, `rank.expr`) is evaluated in TypeScript while the IR is built, and becomes a domain filter or a constant coefficient.
- **No PII in the IR.** People are opaque indices. The mapping from index to resource stays in `kairos-core`.
- **Worker contract:** `POST /solve` with the body signed by a service key (HMAC-SHA256 over the body and a timestamp). It returns `202 { job_id }`. Results come back through a signed callback to `kairos-core`, with a poll endpoint as fallback. The worker is stateless and has no database.
- **Jobs** come from an outbox topic `solver.requests`. Each job has a key `(tenant, env, kind, scope_hash, data_version)`, so a duplicate request returns the cached result.

## 8.3 Solver IR (summary)

```ts
interface SolveRequest {
  kind: 'roster' | 'repair' | 'probe' | 'route';
  horizon: { start: UtcMs; end: UtcMs };
  grain_minutes: 5;
  people: { idx: number; home_zone: string; locations: number[] }[];
  tasks: {                                  // things that may be staffed
    idx: number;
    origin: { type: 'session_requirement'; session_ref: string; requirement_key: string; slot: number }
          | { type: 'shift_candidate'; template_key: string; location: number; start: number; end: number };
    start: number; end: number;             // grain indices (occupied interval incl. buffers)
    location: number; local_day: number; weekday: number; weekend: boolean; tags: string[];
    eligible: number[];                     // person idx after selector + availability + CEL filtering
    required: 'exact' | 'optional';         // session requirement slots are exact; shift candidates optional
    published_person: number | null;        // for stability
    continuity_person: number | null;
  }[];
  fixed_busy: { person: number; start: number; end: number; location: number; ref: string }[];
                                            // existing claims not being re-planned (mirrored classes, PT, other shifts)
  coverage: { key: string; level: 'hard' | 'soft'; segments: { start: number; end: number; min: number; target: number;
              location: number; role: string; candidate_tasks: number[] }[]; weight: number }[];
  hard: HardGroup[];                        // each has a stable id → constraint key + scope
  soft: SoftTerm[];
  time_limit_s: number; seed: number; workers: number;
}
type HardGroup =
  | { id: string; key: string; type: 'max_minutes'; person: number; window: [number, number]; minutes: number }
  | { id: string; key: string; type: 'min_rest'; person: number; pairs: [number, number][] }   // task pairs too close
  | { id: string; key: string; type: 'transfer'; person: number; pairs: [number, number][] }
  | { id: string; key: string; type: 'max_count'; person: number; window: [number, number]; count: number }
  | { id: string; key: string; type: 'max_consecutive_days'; person: number; days: number }
  | { id: string; key: string; type: 'coverage_min'; coverage: string; segment: number }
  | { id: string; key: string; type: 'staff_required'; task: number };
```

## 8.4 Mapping constraints to CP-SAT

**Decision variables.** For each task *t* and each eligible person *p*: a Boolean `x[p,t]`. Each has an **optional interval** `I[p,t] = [start_t, end_t)` that is present iff `x[p,t]`.

| Rule | CP-SAT encoding | Level |
|---|---|---|
| A session requirement slot gets exactly one person | `Σ_p x[p,t] == 1` (`staff_required`). If relaxed in repair mode: `Σ_p x[p,t] + u_t == 1`, where `u_t` (unstaffed) is penalised by 10⁶ | hard |
| Shift candidate takes at most one person per copy | candidates are duplicated per possible headcount; `Σ_p x[p,t] ≤ 1` | hard |
| A person fills at most one slot of the same session | `Σ_{t ∈ slots(s)} x[p,t] ≤ 1` | hard |
| **No overlap for a person**, across all domains | `AddNoOverlap({I[p,t]} ∪ fixed_busy[p] as fixed intervals)` | hard |
| Availability, time off, skills, roles, `allowed_hours`, `people_where`, hard `assignment_expr` | domain filtering when `eligible` is built: no variable is created | hard |
| `min_rest` | for each task pair (a, b) with gap < rest: `x[p,a] + x[p,b] ≤ 1`; and `x[p,a] == 0` if it is too close to a fixed busy interval | hard |
| `transfer_time` | the same pairwise encoding for pairs at different locations with gap < transfer | hard |
| `max_hours` (day / week / rolling 7d) | `Σ_t dur_t · x[p,t] + fixed_minutes ≤ H·60` per window | hard |
| `max_assignments` | `Σ x[p,t] ≤ count` per window | hard |
| `max_consecutive_days` | `w[p,d] = max_t∈day(d) x[p,t]` (`AddMaxEquality`); for every window of k+1 days: `Σ w ≤ k` | hard |
| `shift_length` | candidate generation only emits allowed durations | hard |
| Coverage minimum | per segment: `Σ_{t ∈ candidate_tasks, p} x[p,t] ≥ min` | hard or soft |
| Coverage target shortfall | `short_seg ≥ target − Σ …`, `short_seg ≥ 0`; cost `weight · short_seg · seg_minutes` | soft |
| `min_hours` | `under_p ≥ H·60 − Σ dur·x`; cost `weight · under_p` | soft |
| `fairness` | load `L_p = Σ metric_t · x[p,t]` over eligible people; `hi ≥ L_p`, `lo ≤ L_p`; cost `weight · (hi − lo)` | soft |
| `preferences` | cost `+weight` per avoided interval worked, `−weight/2` per preferred interval worked | soft |
| `continuity` | cost `weight · (1 − x[continuity_person, t])` | soft |
| `stability` | cost `weight · (1 − x[published_person, t])` for tasks already published | soft |
| soft `assignment_expr` | cost `weight · x[p,t]` where the expression is false | soft |

**Objective:** minimise `Σ soft costs` (integer, in minutes × weight). Solver parameters: `num_workers = 8`, `random_seed` from the request, `max_time_in_seconds` from the request, and `log_search_progress` captured in the job record. **Determinism:** the same IR, seed and worker count gives the same solution with `interleave_search = true`. CI checks this.

## 8.5 Infeasibility reporting

1. **Pre-solve pigeonhole checks** (TypeScript, milliseconds). For each coverage segment, count the people who are eligible and not otherwise busy. If that count is below `min`, report directly: "Fri 17:30–23:00 needs 5 servers; only 4 are available and qualified (Ana and Ben have time off)."
2. **Assumption literals.** Each `HardGroup` *g* gets an enforcement literal `a_g`, and its constraint is added with `OnlyEnforceIf(a_g)`. All `a_g` are passed as assumptions. If CP-SAT returns `INFEASIBLE`, `SufficientAssumptionsForInfeasibility()` gives a subset *C*.
3. **Minimisation.** A deletion-based pass: for each *g* in *C*, re-solve with *C* \ {g} under a 2 s limit. If the result is still infeasible, drop *g*. The total budget is 30 s. The result is a minimal (or, at the time limit, near-minimal) conflicting set.
4. **Report.** Each group maps back to the constraint key, its `description` and its scope (person, date, coverage segment):

```json
{ "status": "infeasible",
  "conflicts": [
    { "constraint": "servers", "scope": "Fri 13 Nov 17:30–23:00 Mission", "text": "needs 5 servers" },
    { "constraint": "weekly_40", "scope": "Ana, Ben, Chloe (week of 9 Nov)", "text": "max 40 h/week" },
    { "constraint": "no_clopen", "scope": "Dev, Eli (Fri 13 → Sat 14 Nov)", "text": "10 h rest" } ],
  "suggestions": [ "Lower the Friday dinner minimum to 4", "Allow overtime for 1 person",
                   "Add a server to the roster" ] }
```

Suggestions come from a fixed rule table (for example "a coverage min is in the core → suggest lowering it"). They are **not** written by an LLM. The staff assistant may phrase them in words, but cannot add new ones.

5. **Best-effort mode.** Managers can ask for a "best possible" roster. Coverage minimums become soft with weight 10⁵, and `staff_required` slots become relaxable. Unmet items are listed explicitly. The proposal cannot be auto-approved.

## 8.6 Shared person-rule validator (authoritative)

`@kairos/engine/person-rules` is one TypeScript module. **Every** write that assigns a person runs it: solver proposals, manager edits, swaps, substitute acceptances, `auto` and `customer_choice` bookings, and mirror ingestion (where it only reports). It checks:

1. the selector (role, skills not expired, `where`);
2. availability and time off;
3. occupancy (no overlap; the database also enforces this);
4. `min_rest`, `transfer_time`, `max_hours`, `max_assignments`, `max_consecutive_days`, `allowed_hours`, and hard `assignment_expr`, against the person's claims in the relevant windows across **all domains and sources**.

Rules that depend on neighbouring claims (rest, transfer, hours) can't be expressed as a unique key. They are made race-safe by **per-person-day version rows**. The validator reads `resource_day.version` for every local day its windows touch. The commit batch includes `UPDATE resource_day SET version = version + 1 WHERE resource_id = ? AND day = ? AND version = ?` for each one, followed by an assert row. If a concurrent write changed any of those days, the batch aborts. The engine then re-reads, re-validates and retries up to 3 times (`STALE_VERSION`).

A solver solution that fails the validator is treated as a **bug**. It is not committed, the job is marked `invalid_solution` with the failing rule, and an alert is raised.

## 8.7 Disruption repair: an instructor's sick call

The trigger is a `TimeOff` with `reason = sick` and `immediate = true`, created by the instructor (portal or phone app), by a manager, or by the staff assistant on the instructor's instruction.

1. **Effect (one batch):** the time off is recorded. Every confirmed assignment of that person overlapping it is set to `released`, and its claim is released. Each affected session's assignment slot becomes open, the session goes to `needs_staff`, and `assignment.vacated` is emitted per slot. Desk shifts the person had in the window are vacated the same way. Bookings are untouched: members keep their places.
2. **Candidates (deterministic, no solver):** `GET /sessions/{id}/substitutes?requirement=instructor` evaluates every person who matches the selector with the validator (§8.6). It returns those who pass every hard rule, ranked by a score computed from the tenant's soft constraints: preferences, fairness (fewer minutes this week ranks higher), continuity (has taught this template before), and `rank`. Each candidate carries `why` facts, for example `{ taught_template_before: 14, minutes_this_week: 180, preference: 'none' }`.
3. **Outreach (substitute finder hook, §10.4):** the agent asks candidates in rank order through the notification service. Each offer has an expiry. Offers are batched: by default the top 3 are asked at once, because a sick call is urgent, and acceptance is first-come.
4. **Accept → proposal:** a candidate's "yes" creates a `Proposal{kind: assignment_change, ops: [{op: 'assign', session, requirement: 'instructor', resource: cand}]}`, which is validated at once.
5. **Approve → commit:** a manager approves in the staff portal or desk app, or the policy auto-approves if the tenant enabled `auto_approve_substitutes` and the candidate passes every *soft* rule too. The commit re-validates (I-27). If the candidate has meanwhile become busy (`RESOURCE_CONFLICT`), the proposal goes to `failed`, and outreach continues with the next candidate.
6. **Deadline:** at the workflow's `deadline` (e.g. start − 2 h), if no one has been assigned, the configured fallback runs: the tenant's workflow (for example cancel the session with refund and notify members), or a manager task.
7. **Multi-day absence:** when one time-off vacates more than 3 sessions, or vacates sessions over more than 1 day, the engine also starts a `repair` solve. Only the vacated slots are variables, everything else is `fixed_busy`, and `stability` gets a high weight. This produces one coherent multi-session proposal. Outreach for the vacated slots then follows the solver's suggestion first.

If the `classes` domain is in mirror mode, step 5's commit is a **write-through** to the outside booking system (change of instructor). The local mirror is updated from the outside system's response (§18.4).

## 8.8 Field service routing

The nightly `request_solve` (HVAC example) builds a `route` IR. Nodes are jobs with time windows and service durations. Vehicles are technician + van pairs. Constraints include skills (domain filtering), territory (soft: a penalty per job outside territory), maximum day length and the travel matrix. The worker uses the **OR-Tools routing library** (`RoutingModel` with time dimension, disjunctions only for jobs explicitly allowed to be dropped, which by default is none), `GUIDED_LOCAL_SEARCH`, and a 60 s limit. It starts from the current planned routes (I-31), so the result is never worse than the current feasible plan. The validator checks the result, which becomes a proposal with an auto-approval rule, and at commit planned claims move in one saga.

## 8.9 Committing a roster

Publishing a roster (or a large repair) touches many people. The commit is a **saga**:

1. Group the operations by person. Each person's operations go in one guarded batch, with `resource_day` version guards, occupancy inserts and deletes, and assignment rows.
2. Apply the groups in a deterministic order (by person ID).
3. If any group fails (someone became busy, for example because a mirrored class was newly imported), the groups already applied are compensated: their new claims are released and their old assignments restored, so the proposal applies **all or nothing** (I-27). The proposal goes to `failed`, listing the conflicting person-days. The manager can re-solve with one click, and the new solve includes the new fixed busy intervals.
4. On success: `roster.published`, outbox notifications to every affected person, and a calendar-sync update.

## 8.10 Performance targets

| Problem | Size | First feasible | Returned by (time limit) |
|---|---|---|---|
| Desk-shift roster (reference tenant) | 3 studios, 2 weeks, 25 desk staff, 4 shift templates | ≤ 2 s | 15 s |
| Instructor schedule | 3 studios, 1 week, 180 class slots, 40 instructors | ≤ 5 s | 30 s |
| Restaurant | 1 site, 2 weeks, 45 staff | ≤ 5 s | 30 s |
| Field routing | 15 technicians, 120 jobs/day | ≤ 10 s | 60 s |
| Repair (sick call, multi-day) | ≤ 20 vacated slots | ≤ 1 s | 5 s |
| Feasibility probe (config validation) | 2 weeks | — | 20 s |
| Infeasibility core + minimisation | — | — | +30 s |
| Substitute candidates (no solver) | 1 slot, 60 people | — | p95 300 ms |

Hard cap: 120 s per job. The result reports `status ∈ {optimal, feasible, infeasible, unknown}` and the optimality gap.
