# 15. Phased delivery plan

Each phase ends with acceptance criteria that are checked by automated tests where possible. Every new behaviour ships behind a flag that is off by default (I-30). It is turned on in preview first, then for one reference studio, then for all of them. Phases follow the cutover order in §18.9.

## Phase 0 — Foundations (≈ 6 weeks)

**Scope:**
- IaC for edge functions, per-tenant databases (preview and production), per-object stores, solver worker container, object storage.
- Control plane and tenant routing.
- Token validation for both sign-in services, and role mapping.
- Config schema 1.0 in Zod, with the generated JSON Schema and OpenAPI.
- `packages/expr` (the CEL profile), with conformance tests.
- Core tables, the guarded-batch helper, occupancy, the audit hash chain, outbox and flags.
- `kairos-sync` skeleton with BookingVendor and ShiftTool adapters through the gateway, read-only.
- Contracts package.

**Acceptance criteria:**
1. All six §4b fixtures and `lotus_line.yaml` validate and compile to golden hashes.
2. The CEL profile passes the conformance subset, and the sandbox limits are enforced (tests for each limit).
3. Occupancy property tests (I-15–I-17) pass over 10⁵ random operations.
4. Cross-tenant and preview→production isolation tests pass. The preview gateway configuration contains no production endpoints.
5. The lint rule "engines never branch on kind" is active in CI.

## Phase 1 — MVP for the reference tenant: mirror classes, bookings and members; **own desk shifts** (≈ 8 weeks)

**Scope:**
- Mirror ingestion for classes (including instructor claims), bookings and members. Drift detection (event, window, bucket).
- Desk-shift ownership: shift templates, coverage, availability, time off, swaps, the person-rule validator, a solver for desk rosters, proposals, roster publish saga, the staleness guard.
- ShiftTool `outbound_push`.
- Hours records and the PayrollCo export.
- Staff portal and desk app integration: `/assignments`, `/desk/now`, `/sessions?include=assignments`, `/tasks`.
- Workflows: notify and create_task, with the timer driver.
- Read-only website timetable and spot map from the mirror. Booking is write-through.

**Acceptance criteria:**
1. **Acceptance test A.6 passes in production-like preview data:** a person teaching a mirrored class cannot be assigned an overlapping desk shift, through the portal UI, the API, or the solver. A conflicting mirror import raises `cross_domain_conflict` within 60 s and notifies managers.
2. A desk roster for 3 studios and 2 weeks solves in ≤ 15 s. Infeasible coverage returns a minimal conflicting set with plain text.
3. Drift detection finds 100 % of seeded discrepancies. The mirror refresh SLO is met (p95 ≤ 2 min behind BookingVendor events).
4. The payroll export for a full pay period matches ShiftTool's hours for the same period exactly, during the 60-day parallel run.
5. Desk staff can check members in at all three studios through Kairos (write-through to BookingVendor), including the desktop app's offline queue.
6. ShiftTool's rollback rehearsal (owner → mirror for shifts) completes in preview in ≤ 30 min.

## Phase 2 — Native booking engine in shadow; website booking through Kairos (≈ 8 weeks)

**Scope:**
- Full booking engine: holds, SessionGate, places, partitions, entitlement selection, penalties, waitlist, approvals.
- Shadow mode for classes and bookings, with the disagreement triage UI.
- Member support assistant integration (H1, H2, confirmations).
- Configuration agent v1 (draft, validate, simulate, impact, approval), used by staff to model the tenant's real policies.

**Acceptance criteria:**
1. The **spot-hold race** (A.3) and **late cancellation with waitlist promotion** (A.4) scenario suites pass, and the concurrency tests pass with the gate on and off.
2. Shadow disagreement rate < 0.2 % over 14 days, with 100 % triaged.
3. Booking performance meets §7.11 under the load test.
4. The config agent passes the eval gates (§14.4) on E-CLS-01, E-CLS-02 and the reference tenant case.
5. Member assistant safety evals at 100 %.

## Phase 3 — Own classes; instructor rostering and substitute finder (≈ 6 weeks)

**Scope:**
- Timetable series in config with materialisation; classes pushed to BookingVendor.
- Instructor schedule solving in the portal.
- Sick calls → substitute finder (H3) → proposals → approval.
- Retire ShiftTool (if 60 days have passed since phase 1).

**Acceptance criteria:**
1. **Instructor sick call** (A.5): vacated slots are created within 5 s. The first offers go out within 60 s. An approved substitute is committed with re-validation. On a deadline miss, the fallback workflow runs.
2. A one-week instructor schedule for 180 slots solves in ≤ 30 s, with stability ≥ 95 % of assignments unchanged on a re-solve with one change.
3. Classes cutover and rollback rehearsals in preview each finish in ≤ 30 min. Push lag p95 < 60 s.

## Phase 4 — Own bookings (≈ 6 weeks)

**Scope:**
- Bookings domain to owner, with entitlement-debit write-through to BookingVendor (saga).
- Checkout for drop-ins through processor authorisation via the gateway.
- Late-cancel and no-show fees through the gateway.

**Acceptance criteria:**
1. Two weeks in owner mode with zero invariant violations (continuous invariant checker in production) and zero unreconciled ledger items with BookingVendor.
2. Rollback rehearsal completes in ≤ 30 min with no lost bookings.
3. Fee charges are idempotent: a replay test produces no duplicate charges.

## Phase 5 — Own members; retire BookingVendor (≈ 8 weeks)

**Scope:**
- Members domain shadow → owner.
- Processor subscriptions for memberships, through the gateway.
- Website checkout and account page served by Kairos plus the processor.
- BookingVendor read-only for 60 days, then retired.

**Acceptance criteria:**
1. All members migrated, with balances equal to BookingVendor's at cutover (checksum by member).
2. Shadow disagreement < 0.1 % for entitlements over 14 days.
3. A retirement sign-off by the owner, with no rollback for 60 days.

## Phase 6 — Generalisation and a second tenant (≈ 10 weeks, partly overlapping)

**Scope:**
- On-demand appointments in production quality (physio/salon).
- Field-service routing (OR-Tools routing, I-31 planned routes).
- Coworking space booking.
- Config agent GA across the full eval set.
- Time clock in the staff portal.

**Acceptance criteria:**
1. All §14.4 gates pass on all 64 cases.
2. A second tenant of a different shape (appointments or space) onboards through the configuration agent alone, with no code changes.
3. The routing benchmark (15 technicians, 120 jobs) runs in ≤ 60 s and keeps I-31.

## Cross-phase definition of done

- Every new endpoint is in OpenAPI, with a generated client and contract tests.
- Every behaviour is flagged off by default and documented in the runbook.
- Invariant property tests are extended for any new table.
- Dashboards: booking latency, gate queue depth, timer lag, outbox backlog, drift rate, disagreement rate, solver runtimes.
