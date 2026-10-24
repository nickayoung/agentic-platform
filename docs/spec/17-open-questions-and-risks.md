# 17. Open questions and risks

## 17.1 Open questions

| ID | Question | Owner | Needed by |
|---|---|---|---|
| Q-01 | Does BookingVendor support reserving a spot during checkout? If not, mirror-mode spot holds are advisory, and some confirms will fail with the outside system's "taken" result (§7.12) | Integration lead | Phase 2 |
| Q-02 | Should instructors who also work the desk have a cross-role cap that differs from `desk_week` (for example a total of 45 h including teaching)? This affects labour-law interpretation in New York | Tenant ops + legal | Phase 1 |
| Q-03 | Some tenants may want overnight shifts to end at a fixed **wall-clock** time across DST changes. Add `duration_basis: wall_clock` to templates? | Product | Phase 6 |
| Q-04 | Per-place surcharges (for example a premium front-row price) are not expressible in schema 1.0. Add `price_rules` with `place.attributes` in context? | Product | Phase 4 |
| Q-05 | Should a late-cancel fee be waived when the **session** ended up with no unfilled places at start, even if the specific place wasn't refilled (pooled fairness)? | Tenant owner | Phase 2 |
| Q-06 | Mirror staleness guard: block or warn by default when BookingVendor is unreachable during roster publish? Currently it blocks, with a manager override (§18.6) | Tenant ops | Phase 1 |
| Q-07 | Which roles may approve substitute proposals: only managers, or also lead instructors (a tenant-defined role)? Platform roles are a fixed set today | Product | Phase 3 |
| Q-08 | Data residency: are all tenants in one region? Do edge database locations need pinning? | Security | Phase 6 |
| Q-09 | Guest bookings (`allow_guests`) and family accounts: one booking per person with `group_id`, or a party-size booking? | Product | Phase 4 |
| Q-10 | Should configuration agent conversations be kept longer than 30 days to support audits of why config changed? (Summaries and facts are kept with the version permanently) | Security + product | Phase 2 |

## 17.2 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | **Mirror staleness.** An outside change Kairos hasn't seen yet collides with a new owned desk shift (the outside system assigns a class during an already-published shift) | Medium | Medium | Event ingestion; the targeted pull before staff commits (§18.6); immediate `cross_domain_conflict` alert and task; the conflicted claim still blocks new Kairos claims (I-18) |
| R-02 | Write throughput of the per-tenant single-writer database during booking-open rushes across many sessions at once | Low (yoga tenant) / Medium (big gyms) | High | SessionGate absorbs bursts. Batches are small. Load tests at 3× the expected peak. Option: shard hot timetable writes per location into a separate database (requires cross-database occupancy, which is deferred) |
| R-03 | Maturity of the TypeScript CEL implementation | Medium | Medium | The profile is small, there is a conformance suite, and an in-house fallback (A-13) |
| R-04 | Solver hosting outside the edge adds an operational component for a small team | Medium | Low | Stateless container, IaC, queue with retries. The booking path never depends on it |
| R-05 | LLM config agent produces plausible but wrong configs | Medium | High | Schema boundary, behavioural scenarios in evals, simulation deltas, impact plans, human approval, fast rollback |
| R-06 | Shadow-mode disagreements are dominated by BookingVendor's undocumented rules | High | Medium | Triage categories. Add `config_fix` iterations through the agent. Accept `expected` disagreements explicitly before cutover |
| R-07 | Occupancy row growth for long claims (multi-day blocks, 18-hour sessions) | Low | Low | `occupancy: none` for containers; blocks longer than 7 days are stored as day-level claims; pruning |
| R-08 | Agents mis-sell or mis-explain policies | Medium | Medium | Policy text is rendered from config; the H2 faithfulness checker; confirmation cards for consequences |
| R-09 | Cutover rollback after many owner-mode writes fails due to outside-system limits (rate limits, missing fields) | Medium | High | Continuous `outbound_push` with read-after-write verification; rollback rehearsals in each phase; retire only after 60 days |
| R-10 | Team capacity: one small team working mostly through coding agents | High | Medium | Strict typed contracts, golden fixtures, scenario DSL, property tests as the safety net for agent-written code; phases scoped to the reference tenant first |
