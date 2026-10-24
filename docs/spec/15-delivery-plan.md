# 15. Phased delivery plan

Every new behaviour ships behind a flag that is off by default (I-30). Each flag rolls out in the same order: preview, then one studio (Park Slope), then all studios. Every flag has an `owner` and a `remove_by` date. Within 30 days of a feature being fully on, its flag is removed from code and config. CI warns once `remove_by` has passed. No phase depends on a later phase.

## Phase 0: Foundations (≈ 6 weeks)

**Scope**
- **Infrastructure (IaC, §19):** `wrangler` configs for `kairos-api`, `kairos-console` and the Durable Object classes (`TenantCore`, `TenantSync`, `TenantAgent`, `ControlPlane`, `SimulationRun`) in preview and production; the `kairos-solver` container; R2 buckets (exports, locked audit archive, solver payloads); Secrets Store keys; the 5-minute backstop cron.
- **Phase 0 spikes** (§19.17), each with a written result before the acceptance review.
- **Control plane:** tenant lifecycle states (`provisioning` → `onboarding`).
- **Identity:** token validation for both sign-in services; role mapping; token exchange for service and agent clients.
- **Config:** schema 2.1 in Effect Schema (2.0 documents accepted and upgraded); `packages/expr` (CEL interpreter, §19.12); the `HttpApi` definition in `packages/contracts`.
- **Manual config pipeline**, used without the agent: draft → validate L1–L4 → impact → approve → publish → rollback.
- **Storage:** core tables and migrations-on-start (§19.8); the `Storage` service and transaction helper with the transaction lint (§19.2); occupancy; hash-chained audit; the scheduler (§19.5) and outbox delivery (§19.6); the saga runner (§3A.1 C6); pruning and R2 archival (§19.7); flags.
- **Kairos console** (§19.14): the Phase 0 screens (config pipeline, domain modes and flags, tenant lifecycle).
- **Ops and sync:** observability baseline (§13.9); `kairos-sync` skeleton with read-only BookingVendor and ShiftTool adapters through the gateway.

**Acceptance**
1. Both §4b fixtures pass the **real** validator (L1–L4, including the lane-aware `COVERAGE_UNCOVERABLE`, run in CI on every commit), compile to their golden hashes, and publish through the manual pipeline. `lotus_line.yaml` reports no `NOTICE_MISSING`. CI also checks that `fixtures/configs/*.yaml` are identical to the YAML blocks in §4b, and the L5 probe on `lotus_line.yaml` with a seeded staff set returns feasible.
2. CEL conformance and sandbox-limit tests pass.
3. Occupancy property tests pass over 10⁵ operations on `workerd`. Every transaction test (§14.1) passes.
4. Cross-tenant isolation tests pass, and preview cannot write to production.
5. Lint rules are active: "never branch on kind" and the transaction rule (§19.2).
6. A point-in-time restore of a preview `TenantCore` completes, and the backstop cron re-arms a deliberately cleared alarm.

## Phase 1: MVP. Mirror classes, bookings and members; shadow then own desk shifts (≈ 8 weeks)

**Scope**
- **Onboarding:** run for the reference tenant as defined in §3A.3: backfill, person mapping, preview seeding, go-live checklist.
- **Mirror ingestion and drift:** mirror classes (including teacher claims), bookings and members. Drift detection includes `unmapped_person`.
- **Desk shifts, shadow then owned (D-47):** shift mapping (§18.5); 14 days of shifts shadow (validator verdicts, coverage and hours compared with ShiftTool, §18.7); then the cutover. Owned: templates and coverage; availability, time off and swaps; the person-rule validator with `resource_day` versions; the desk roster solver; proposals; the roster saga; the staleness guard. Lifecycle cards §3A.6, §3A.10, §3A.11, §3A.16.
- **ShiftTool:** `outbound_push` so ShiftTool stays current.
- **Hours:** hours records and the Gusto CSV export (§18.8); calendar sync.
- **Staff lifecycle:** onboarding and offboarding (§3A.6).
- **Write-through façade** (§7.12): holds, bookings, cancellations and check-ins are forwarded to BookingVendor, with only the pre-checks run locally. Built-in policy behaviour stays off for mirrored domains (§7.13).
- **Front ends:** the portal and desk app use `/assignments`, `/desk/now`, `/sessions?include=assignments`, `/tasks`, `/check-ins` (write-through), and the offline queue. The website timetable and mat map read the mirror, and bookings are written through.
- **Workflows:** notify and create_task, with the timer driver; workflow `scope`, event domains and events from mirror ingestion (§9.3, §18.6). With `member_messaging: kairos`, Kairos sends every member and staff message from go-live, and BookingVendor's member messages are switched off (§3A.3, D-51).

**Acceptance**
1. **A.5 passes on preview data seeded from production**, including the mode-guard variant (Kairos never cancels or promotes on mirrored classes). A teacher of a mirrored class can't be given an overlapping desk shift through the portal, the API or the solver. A conflicting mirror import raises `cross_domain_conflict` within 60 s. An unmapped teacher blocks desk assignments at that studio and time, and raises an alert.
2. The desk roster for 3 studios × 2 weeks solves in ≤ 15 s. Infeasible coverage returns a minimal conflict set.
3. Seeded drift is detected 100 % of the time. The mirror stays at most 2 min behind BookingVendor at p95.
4. **Shifts shadow gate:** for 14 days, disagreement is below 0.2 % and 100 % triaged (§18.7). **After the cutover:** for the first 21 days of the 60-day push period, Kairos's desk hours match ShiftTool's computed hours exactly. Only Kairos's Gusto CSV is uploaded for desk hours (§18.8). A dry-run upload of each Kairos file into the real Gusto payroll is accepted without errors and then cancelled before submitting. (The full 60-day match is the ShiftTool retirement gate in Phase 3.)
5. A staff deactivation takes effect within 60 s. Future shifts are vacated and tokens are refused.
6. A rollback rehearsal for shifts (owner → mirror) completes in ≤ 30 min.

## Phase 2: Native booking engine in shadow; website books through Kairos (≈ 8 weeks)

**Scope**
- **Booking engine:** holds, the SessionGate queue (§19.3), places and partitions, entitlements (freeze, past-due), penalties and refunds (including `refund.late`), the waitlist with reservations and offers, approvals, the minimum-attendance and unstaffed timers. All run as dry runs in shadow (§3A.2); lifecycle cards §3A.12–§3A.13, §3A.15.
- **Shadow mode** for classes and bookings, with triage.
- **Member lifecycle:** account, guest, merge, suspend, close, export and erase.
- **Member assistant:** H1, H2 and confirmations.
- **Config agent v1**, with the eval suite (§14.4).

**Acceptance**
1. Scenario suites for A.2 (mat race) and A.3 (late cancel and waitlist, all variants) pass. Concurrency tests pass with alarms delivered, alarms dropped, and object restarts (§14.1).
2. The shadow disagreement rate is below 0.2 % for 14 days, and 100 % of disagreements are triaged.
3. §7.11 targets are met under the load test.
4. The config agent passes the §14.4 gates, including 100 % on Y-REF-01.
5. The member-assistant safety evals score 100 %.

## Phase 3: Own classes; teacher rostering; substitute finder (≈ 6 weeks)

**Scope**
- **Timetable in config:** series and materialisation, with the three edit scopes and runtime session edits (§3A.9.2).
- **Classes cutover:** adoption of mirrored future sessions into series (§3A.18, D-60); classes pushed to BookingVendor, including session cancels, which BookingVendor then applies to its bookings (D-44).
- **Workflow `invoke_hook` action** and H3 hosted in `kairos-agent` (§10.4).
- **Teacher rostering:** schedule solving.
- **Substitutes:** sick call → offers → proposal → approval, plus the unstaffed policy.
- **ShiftTool retired**, once it has run 60 days since the shifts cutover with desk hours matching exactly.

**Acceptance**
1. The A.4 scenario suite passes, including the Phase 3 variant (`bookings: shadow`). Vacated slots appear within 5 s. The first offers go out within 60 s. Two simultaneous accepts produce exactly one proposal. If no substitute is found, the built-in unstaffed check cancels the class in Kairos and pushes the cancel to BookingVendor within 60 s; BookingVendor's resulting booking cancellations are mirrored back; Kairos writes no refunds. A failed push raises the urgent task within 10 min.
2. One week of 180 slots solves in ≤ 30 s. A re-solve after one change keeps at least 95 % of assignments stable.
3. Classes cutover and rollback rehearsals each take ≤ 30 min. Push lag is under 60 s at p95.

## Phase 4: Own bookings (≈ 6 weeks)

**Scope**
- Bookings move to owner mode. Entitlement debits are written through to BookingVendor as a saga.
- Drop-in checkout through Stripe PaymentIntents (manual capture), saved cards with SetupIntent consent, and waitlist auto-charge (§18.10).
- Fees and refunds through Stripe via the gateway.

**Acceptance**
1. The A.3 suite and the A.4 owner-mode suite pass on production-like data: Kairos cancels bookings, refunds and notifies members itself. The bookings cutover follows §3A.18: imported bookings carry `origin: imported_at_cutover`, and BookingVendor waitlists are imported in order.
2. Two weeks in owner mode with 0 invariant violations and 0 unreconciled debits.
3. A rollback rehearsal completes in ≤ 30 min with no bookings lost.
4. Replaying fee and refund jobs creates no duplicate charges.

## Phase 5: Own members; retire BookingVendor (≈ 8 weeks)

**Scope**
- The members domain goes shadow → owner.
- Stripe Checkout for packs and memberships; Stripe Billing subscriptions, dunning webhooks and freeze (`pause_collection`) (§18.10).
- Account page and checkout fully on Kairos.
- BookingVendor stays read-only for 60 days, then is retired.

**Acceptance**
1. Balances match BookingVendor for every member at cutover.
2. Entitlement disagreements stay below 0.1 % for 14 days.
3. The owner signs off on retirement after 60 days with no rollback.

## Phase 6: Hardening and a second yoga tenant (≈ 6 weeks)

**Scope**
- Time clock in the portal.
- Tenant offboarding (§3A.3), tested end to end on a preview tenant.
- Onboarding of a second yoga tenant through the config agent only, starting from the starter config.

**Acceptance**
1. The second tenant goes live with no code changes.
2. The offboarding drill produces a complete export, revokes all tokens and gateway routes, and issues a deletion certificate after the retention period (shortened for the drill).

## Definition of done (every phase)

- OpenAPI updated, generated clients rebuilt, contract tests passing.
- New behaviour behind a flag, with an owner and a `remove_by` date.
- Runbook entries written for any new alerts.
- Property tests extended for any new table.
- Dashboards updated (§13.9).
- Console screens for the phase shipped (§19.14).
