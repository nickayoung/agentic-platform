# Phase 0 status

Tracks §15 Phase 0 against the code. Updated with each Phase 0 change.

## Acceptance (§15)

| # | Criterion | Status | Where |
|---|---|---|---|
| 1 | Both §4b fixtures pass the real validator (L1–L4, lane-aware `COVERAGE_UNCOVERABLE`) in CI | **Done** | `packages/config-schema/test/fixtures.test.ts`, `cel.test.ts` |
| 1 | …compile to their golden hashes | **Done** | `fixtures/configs/golden-hashes.json` |
| 1 | …and publish through the manual pipeline | **Done** | `apps/core/test/config.test.ts`, `apps/api/test/config.test.ts` |
| 1 | `lotus_line.yaml` reports no `NOTICE_MISSING` | **Done** | `fixtures.test.ts` |
| 1 | CI checks `fixtures/configs/*.yaml` equal the YAML blocks in §4b | **Done** (ignores the fixtures' one-line "generated from" header) | `fixtures.test.ts` |
| 1 | L5 probe on `lotus_line.yaml` with a seeded staff set returns feasible | **Not started**: needs the solver container | — |
| 2 | CEL conformance and sandbox-limit tests | **Done**: 421 tests in workerd | `packages/expr/test` |
| 3 | Occupancy property tests over 10⁵ operations | **Done**: 200 × 500 random ops against a model, on DO SQLite | `packages/db/test/occupancy.test.ts` |
| 3 | Every assert-pattern test (§14.1, now "transaction tests") | **Done** for the Phase 0 tables | `packages/db/test/tx.test.ts` |
| 4 | Cross-tenant isolation tests; preview cannot write to production | **Partly**: object scope guard, token tenant/env checks, deployment env check | `apps/core/test/tenant-core.test.ts`, `apps/api/test/api.test.ts` |
| 5 | Lint rules: "never branch on kind" and the transaction rule | **Done** | `tools/eslint-plugin-kairos` |

## Scope (§15, §19)

| Item | Status |
|---|---|
| Infrastructure: `wrangler` config for preview and production (DO classes, R2, Secrets Store, cron) | **Done** for `kairos-api` (hosts `TenantCore`, `TenantSync`, `ControlPlane`); not yet deployed. `SimulationRun`, `TenantAgent`, the solver container and the console are not configured yet |
| Control plane: tenant lifecycle states, wrapped per-tenant keys | **Done** |
| Identity: token validation for both sign-in services, role mapping | **Done**. Token exchange for service and agent clients (§13.2) **not started** |
| Config: schema 2.1 in Zod (2.0 upgraded), CEL | **Done** |
| Manual config pipeline: draft → validate → impact → approve → publish → rollback | **Done**. Impact (L6) returns no groups until sessions exist; `/simulate` and `/diff` not built |
| Storage: core tables, `db.tx`, occupancy, hash-chained audit, outbox, saga runner, flags | **Done** |
| Scheduler (one alarm per object) and backstop cron | **Done** |
| Pruning and R2 archival | **Done** (audit archival to a locked bucket needs the bucket lock set up in Cloudflare) |
| Observability baseline (§13.9) | **Partly**: structured logs, Workers observability on. Analytics Engine metrics and the ops alert cron not started |
| `kairos-sync` skeleton with read-only adapters | **Done** against a normalised gateway contract; real BookingVendor and ShiftTool API details are still open (Q-11) |
| Kairos console (TanStack Start) Phase 0 screens | **Not started** |
| CI on Cloudflare (`apps/ci`, §19.18) | **Built and tested locally**: Worker tests pass, and the runner image ran the full suite against the Artifacts repo. Not deployed yet |
| Phase 0 spikes (§19.17) | **1 done** (CEL interpreter). 2–6 need a Cloudflare account: throughput, solver cold start, console on Workers, PITR drill, storage growth |

## Findings while building

- **Staged config versions waited for an unrelated wake-up.** After a change, `TenantCore` only pulled the alarm forward for new outbox rows, so a version published with a future `effective_from` activated at the next unrelated alarm. Every change now re-arms from all tick sources. Found by running the suite in the `kairos-ci` container at a different time of day; the test now pins the maintenance slot so it fails without the fix at any time.

- **`rowsWritten` counts index writes.** DO SQLite's `rowsWritten` includes index entries, so a one-row UPDATE on an indexed table reports more than 1. `Tx.run` returns `changes()` instead.
- **Unnamed CHECK constraints can't be mapped to reason codes.** SQLite reports them by expression, not by table. Constraints that map to reason codes are named (`entitlement_balance_nonneg`, `limit_counter_within_max`).
- **RPC types.** `unknown` fields make a Durable Object stub's return type `never`, and recursive JSON types are too deep, so RPC payloads use shallow JSON types.
- **Spec gaps** raised while building `@kairos/config-schema` and `@kairos/expr` are listed in the merge commits' agent reports; the main ones: §4.13 issuers have no `aud` value (we default to `"kairos"`); `hasSkill` expiry has no input in the §5.3 types; `event` slot results; `minutesBetween` sign; the cost model in §5.
