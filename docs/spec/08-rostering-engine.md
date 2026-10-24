# 8. Rostering engine

The rostering engine proposes **teacher assignments for classes** and **desk staff for desk shifts**. It runs as batch jobs. Every result is a **proposal**. A TypeScript validator checks it (§8.5), a manager approves it (or a configured auto-approval does), and the commit goes through the same occupancy constraints as every other write.

## 8.1 Choice: OR-Tools CP-SAT, not Timefold (D-02)

| Criterion | CP-SAT | Timefold |
|---|---|---|
| Proves infeasibility and returns the conflicting constraints | Yes (`SufficientAssumptionsForInfeasibility`) | No (it reports a negative hard score) |
| Optimality bounds | Yes | No |
| Intervals, no-overlap, linear sums | Native | Native, via constraint streams |
| Runtime | C++ core, Python wheel | JVM |
| Fit for a small TypeScript team | Thin Python worker reads a JSON IR; all logic stays in TypeScript | JVM service, with rules written in Java |

The deciding factor is infeasibility reporting: the brief requires naming the conflicting constraints, and CP-SAT does this directly. Neither solver runs at the edge, so the solver runs in a stateless container worker (A-10).

## 8.2 Architecture

```
kairos-core (edge, TS)                                     solver worker (container, Python + OR-Tools)
 1. Problem builder: compiled config, people, availability,  ── POST /solve (signed IR) ──▶ 4. IR → CP-SAT
    time off, ALL existing claims (owned + mirrored),                                        5. solve (time limit)
    published roster; CEL evaluated to constants                                             6. core extraction if infeasible
 2. Pre-solve pigeonhole checks                              ◀── signed callback ────────── 7. solution / core
 3. Emit IR
 8. Validate (TS validator) → 9. Proposal → approval → 10. Commit saga
```

- **No CEL in the solver.** Expressions are evaluated while the IR is built, so they become domain filters or constants.
- **No PII in the IR.** People appear as opaque indices.
- **Signed and idempotent.** Requests and callbacks are signed (HMAC over body + timestamp). A job is keyed by `(tenant, env, kind, scope_hash, data_version)`, so a duplicate request returns the cached result.
- **If the worker is down,** solve jobs queue and the portal shows them as "pending". Bookings never depend on the worker.

## 8.3 IR and model mapping

**IR contents.**
- **Tasks**: teacher slots of classes in scope, plus candidate desk-shift copies (one per template × allowed start × day × studio × lane up to coverage target).
- **Eligible people per task**: selector and skills, availability, time off, studio, and person `state`.
- **`fixed_busy`** intervals: every existing claim outside the scope, including **mirrored class assignments**.
- **Coverage segments**, **hard groups** (each with a stable ID that maps back to its constraint key and scope), **soft terms**, `time_limit_s` and `seed`.

**Variables.** A Boolean `x[p,t]` for each task *t* and eligible person *p*, each with an optional interval `[occ_start, occ_end)`.

| Rule | Encoding | Level |
|---|---|---|
| Teacher slot filled | `Σ_p x[p,t] == 1` (a repair solve may relax this with a penalised slack) | hard |
| Shift copy | `Σ_p x[p,t] ≤ 1` | hard |
| No overlap per person, across classes, shifts, blocks and mirrored claims | `AddNoOverlap(intervals[p] ∪ fixed_busy[p])` | hard |
| Skills, roles, availability, time off, `people_where`, hard `assignment_expr` | Domain filtering (no variable is created) | hard |
| `min_rest`, `transfer_time` | `x[p,a] + x[p,b] ≤ 1` for task pairs too close together (and against `fixed_busy`) | hard |
| `max_hours` / `max_assignments` | `Σ dur·x + fixed ≤ limit` per window | hard |
| `max_consecutive_days` | Day indicators with `AddMaxEquality`; sliding windows | hard |
| Coverage minimum | `Σ x ≥ min` per segment | hard / soft |
| Coverage target, `min_hours` | Shortfall variables × weight | soft |
| Fairness | `weight · (max L_p − min L_p)` | soft |
| Preferences / continuity / stability | Penalty when the preferred, previous or published person is not chosen | soft |

The objective minimises the integer sum of soft costs. Solves are deterministic for a given IR, seed and worker count (`interleave_search`), and CI checks this.

## 8.4 Infeasibility reporting

1. **Pre-solve pigeonhole check.** For each coverage segment or teacher slot, if fewer eligible, free people exist than are needed, report it directly. Example: "Hot 75 Tue 18:00 needs a teacher with `hot_cert`; the only two are on time off."
2. **Assumptions.** Each hard group runs under `OnlyEnforceIf(a_g)`. If the solve is `INFEASIBLE`, `SufficientAssumptionsForInfeasibility()` returns a core.
3. **Minimisation.** Deletion-based: drop one group at a time and re-solve with a 2 s limit each, within a 30 s total budget.
4. **Report.** Each conflict lists its constraint key, its description, its scope (person, date or segment), and **suggestions** from a fixed rule table. Suggestions never come from an LLM.
5. **Best-effort mode** (requested by a manager): coverage minimums become heavily weighted soft terms, unmet items are listed, and the result cannot be auto-approved.

## 8.5 Shared person-rule validator (authoritative)

`@kairos/engine/person-rules` runs on **every** person assignment write: solver proposals, manager edits, swaps, substitutes, and lifecycle vacates/re-assigns. Mirror ingestion also runs it, but only to report problems. It checks:

- the selector;
- skills and expiry;
- person `state`;
- availability and time off;
- occupancy;
- `min_rest`, `transfer_time`, `max_hours`, `max_assignments`, `max_consecutive_days` and hard `assignment_expr`, against the person's claims in every domain and from every source.

**Race safety.** Rules that depend on neighbouring claims are protected by **per-person-day version rows**. The commit batch includes, for every local day the rule windows touch:

```sql
UPDATE resource_day SET version = version + 1, last_batch = :batch_id
 WHERE resource_id = :p AND day = :d AND version = :v_read;
INSERT INTO batch_assert (ok) VALUES (
  (SELECT last_batch FROM resource_day WHERE resource_id = :p AND day = :d) = :batch_id);
```

A `resource_day` row is created on first use (`INSERT … ON CONFLICT DO NOTHING` in the read phase). If a concurrent batch has bumped the version, this batch's UPDATE matches no row, `last_batch` stays different, and the batch aborts. The engine then re-reads, re-validates, and retries up to 3 times before failing with `STALE_VERSION`.

A solver result that fails the validator is a **bug**: it is not committed, and an alert is raised.

**Two managers editing the same roster.** Each proposal has a `version`, and edits require `If-Match`. Two proposals that touch the same person-days can both be *created*. When the second one is *applied*, its `resource_day` guards fail, it re-validates against the first one's committed state, and it either applies or fails with reasons.

## 8.6 Instructor sick call

The trigger is a `TimeOff` with `reason: sick, immediate: true`. It can come from the teacher (portal or phone app), from a manager, or from the staff assistant acting on the teacher's instruction.

1. **Vacate (one batch).** The time off is recorded. Every overlapping confirmed assignment (classes and desk shifts) is `released`, and its claim is released. The session goes to `needs_staff`, and `assignment.vacated` is emitted. Members keep their bookings.
2. **Candidates (deterministic).** `GET /sessions/{id}/substitutes?requirement=teacher` runs the validator over everyone who matches the selector. It returns those who pass every hard rule, ranked by soft score (preferences, fairness by minutes this week, continuity with this template, and `rank`), each with `why` facts.
3. **Outreach (H3, §10.4).**
   - Offers are created with `POST /offers {kind: substitute}` and delivered through the notification service.
   - The top `k = 3` candidates are asked at once, because a sick call is urgent. Each offer expires at `min(now + 20m, deadline)`; if the class starts within 6 h, the offer lasts 10 min (D-33).
   - When an offer is declined or expires, the next candidate is asked. Candidates are re-fetched before each wave.
4. **Accept → proposal.** The candidate answers `POST /offers/{id}/accept` (button in the phone app), or replies by SMS. In the SMS case, H3 interprets the text and records an accept on their behalf, with the text attached for the manager. Either way, a `Proposal{assignment_change}` is created and validated at once. All other open offers for the slot are withdrawn.
5. **Approve → commit.** A manager approves in the portal or desk app, or the proposal auto-approves if the flag `substitute.auto_approve` is on and the candidate passes every *soft* rule too. The commit re-validates (I-27). The assignment becomes `confirmed`, the session `scheduled`, and `assignment.confirmed{reason: substitute}` is emitted, which triggers the `sub_assigned_notice` workflow to members. If the candidate became busy in the meantime (`RESOURCE_CONFLICT`), the proposal goes to `failed` and outreach continues.
6. **Unapproved proposals** expire at `expires_at`, which defaults to `min(deadline, now + 2h)` (I-28a). Outreach then continues.
7. **No substitute.** At the hook's deadline, the hook emits `custom.substitute_exhausted`, and the tenant's workflows create a manager task. At `policy.unstaffed.check_at`, if the slot is still empty, the **built-in** unstaffed check (§7.1) cancels the class with `reason: no_staff`. Every booking is cancelled with a full refund and units released (§7.6, studio cancel). The `no_sub_notice` workflow texts members, and waitlist entries expire.
8. **Multi-day absence.** If the time off vacates more than 3 slots, or slots on more than 1 day, a `repair` solve runs as well. Only the vacated slots are variables, everything else is fixed, and stability has a high weight. The solve returns one coherent multi-slot proposal.
9. **Mirror mode for classes.** The commit in step 5 is a **write-through** of the teacher change to BookingVendor (§18.4). The mirrored claim is updated from BookingVendor's response. A cancellation in step 7 is also written through.

## 8.7 Committing a roster

A roster commit is a **saga**:

1. Group the ops by person. Each person's ops go in one guarded batch: `resource_day` guards, occupancy changes and assignments.
2. Apply the batches in person-ID order.
3. If any batch fails, compensate the batches already applied (release their new claims, restore their old assignments). The proposal goes to `failed` and lists the conflicting person-days.

**Before the commit:** the staleness guard (§18.6) pulls the classes mirror for every affected person-day.

**After success:** emit `roster.published`, notify affected staff, and update calendar sync (§18.3).

## 8.8 Performance targets

| Problem | Size | First feasible | Time limit |
|---|---|---|---|
| Desk roster | 3 studios × 2 weeks, 25 desk staff, 3 shift templates | ≤ 2 s | 15 s |
| Teacher schedule | 3 studios × 1 week, 180 class slots, 40 teachers | ≤ 5 s | 30 s |
| Repair (sick call) | ≤ 20 vacated slots | ≤ 1 s | 5 s |
| Feasibility probe | 2 weeks | — | 20 s |
| Infeasibility core | — | — | +30 s |
| Substitute candidates | 1 slot, 60 people | — | p95 300 ms |

The hard cap is 120 s per job. When a solve exceeds its limit, it returns the best solution found (`feasible`) with its optimality gap, or `unknown` if it found none. On `unknown`, the portal offers best-effort mode, a longer limit (up to the cap), or a narrower scope. Solver times are recorded per job and shown on the operations dashboard (§13.9).
