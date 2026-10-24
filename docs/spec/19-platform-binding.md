# 19. Platform binding: Cloudflare, Effect, TanStack

§1–§18 describe Kairos in platform-neutral terms: "edge functions", "per-object stores", "one SQLite DB per tenant". This section binds those terms to the chosen stack and states the rules that follow from it. Where this section and an earlier one disagree, this section wins; the earlier sections have been patched to match (D-61 – D-68).

| Concern | Choice |
|---|---|
| Language | TypeScript (strict), ES2022 target, on the Workers runtime (`workerd`) |
| Effects, services, errors | **Effect** (`effect`, `@effect/platform`) |
| Schemas (config, API, events) | **Effect Schema** (`effect/Schema`). Replaces Zod everywhere (D-62) |
| HTTP API and OpenAPI | `@effect/platform` `HttpApi`; OpenAPI 3.1 generated with `OpenApi.fromApi`; TypeScript clients with `HttpApiClient` |
| Compute | Cloudflare **Workers** |
| Tenant databases | **Durable Objects with SQLite storage**, one object per tenant, environment and service (D-61) |
| Timers | Durable Object **alarms**, plus one Cron Trigger as a backstop (§19.5) |
| Object storage | **R2** (exports, audit archive, solver payloads, simulation results) |
| Solver | **Cloudflare Containers**, Python + OR-Tools CP-SAT (D-02 unchanged) |
| Kairos console (UI) | **TanStack Start** (React) on Workers, with TanStack Router, Query, Form and Table (D-67) |
| Tests | Vitest with `@cloudflare/vitest-pool-workers` (real `workerd`, real DO SQLite), `fast-check` for property tests |
| IaC | `wrangler` configs per Worker and environment, applied from CI |

## 19.1 Topology

```
                    ┌────────────── Worker: kairos-api (stateless) ───────────────┐
 members/staff/ ──▶ │ JWT check · tenant resolve · Effect HttpApi decode · Cache API │
 agents             └──┬─────────────────────┬──────────────────────┬─────────────┘
                       │ RPC                 │ RPC                  │ RPC
              ┌────────▼────────┐   ┌────────▼────────┐   ┌─────────▼────────┐
              │ DO TenantCore   │◀──│ DO TenantSync   │   │ DO TenantAgent   │
              │ {t}:{env}       │RPC│ {t}:{env}       │   │ {t}:{env}        │
              │ SQLite: §12     │   │ SQLite: §12.1   │   │ SQLite: §12.1    │
              │ SessionGate     │   │ adapters, drift │   │ hooks, sessions  │
              │ scheduler alarm │   └────────┬────────┘   └─────────┬────────┘
              └──┬──────────┬───┘            │ gateway              │ gateway (llm)
                 │          │ RPC            ▼                      ▼
                 │   ┌──────▼──────────┐   outside systems     LLM provider
                 │   │ DO SimulationRun│
                 │   │ {t}:{env}:sim:id│   ┌──────────────────────────┐
                 │   └─────────────────┘   │ Container: kairos-solver │
                 └── solve jobs (RPC) ────▶│ Python + OR-Tools        │
                                           └──────────────────────────┘
   DO ControlPlane (singleton): tenant registry, key references, lifecycle state
   Worker: kairos-console (TanStack Start) ──▶ kairos-api (same public API as every front end)
```

| Spec term | Binding |
|---|---|
| `kairos-core` service (§12.1) | Worker `kairos-api` (routing only) + DO class `TenantCore` (all state and all engine code) |
| `kairos-sync` service | DO class `TenantSync`, reached from `kairos-api` for inbound webhooks (`POST /sync/inbound/{system}`) and from its own alarm for polling |
| `kairos-agent` service | DO class `TenantAgent` |
| `kairos-worker` (container) | Container `kairos-solver` for solves and the L5 probe. Simulations move to DO `SimulationRun` (§19.10) |
| Control plane | DO class `ControlPlane`, one object named `control:{env}` |
| "One SQLite DB per tenant per environment" | One `TenantCore` object per `(tenant, env)`, named `"{tenant}:{env}"`, created with `idFromName` and `locationHint` set from the tenant's region (`enam` for the reference tenant) |
| SessionGate (§7.5.1) | An in-memory, per-session command queue **inside** `TenantCore` (§19.3). It is no longer a separate object |
| TimerObject (§9.5) | `TenantCore`'s own alarm, driven by the scheduler (§19.5) |
| "Guarded batch" (§12.2) | One synchronous SQLite transaction inside `TenantCore` (`ctx.storage.transactionSync`) (§19.2) |
| `POST /internal/mirror/apply` (§12.1) | The RPC method `TenantCore.mirrorApply()`, called by `TenantSync`. It is not exposed over HTTP |
| Preview vs production | Separate deployments of every Worker (`wrangler --env preview|production`). Each has its own DO namespaces, R2 buckets, secrets and gateway credentials, so a preview object can't address a production object |

`kairos-api` holds no state. It checks the token (§13.2), resolves `(tenant, env)` through a cached `ControlPlane` read, decodes the request with the operation's Effect Schema, and calls the matching RPC method on the tenant's object. A tenant name is never built from user input other than the path slug, and only after the control plane has confirmed the slug exists (§13.1).

Services still don't read each other's databases (D-05). They call each other over Durable Object RPC, using Schema-encoded plain objects. Effect values and class instances never cross an RPC boundary.

## 19.2 Transactions replace guarded batches (D-61, D-63)

A Durable Object runs one request handler at a time between `await`s, and `transactionSync` runs its callback atomically. Inside `TenantCore`, read → decide → write is therefore **one transaction** that no other write can interleave with. That changes §12.2:

- **The batch is a transaction.** Everywhere the spec says "batch", it means one `transactionSync` callback in `TenantCore`. If the callback throws, SQLite rolls everything back. The audit row, domain events and outbox rows are written in the same callback (I-29 unchanged).
- **Checks are code.** The scalar `batch_assert` rows, the `batch_assert` table, the `last_batch` columns and the scalar-assert CI lint are removed. A check reads the row and throws a tagged error, for example `PlaceTaken`, inside the transaction. Unique keys, partial unique indexes and CHECK constraints all stay as the last line of defence. A constraint violation is mapped to the same reason code a check would give.
- **No contention retries.** Two transactions on one tenant never overlap, so the "retry 3 times with jitter" step is removed.
- **A transaction never spans an `await`.** The callback is synchronous and touches only `ctx.storage.sql`. It makes no gateway call, RPC, `fetch`, timer or WebCrypto call (the synchronous `node:crypto` hash used for the audit chain is allowed). A command that needs an outside answer runs in two parts:
  1. *Before*: an optional transaction that records intent (for example a hold), then the `await` to the gateway or another object.
  2. *Commit*: a new transaction that **re-reads and re-decides** from scratch. It may not trust anything read before the `await`.
- **Version columns stay for cross-`await` checks.** `version` still exists on the rows listed in §12, for three uses: `ETag`/`If-Match` on the API (§11.2); proposals built from a snapshot that the solver read seconds or minutes earlier (`resource_day.version`, §8.5); and the commit half of a two-part command. If the version moved, the commit re-validates against the new state. `STALE_VERSION` now means only that a client's `If-Match` or a proposal's snapshot no longer matches and re-validation also failed.
- **Size budget.** A transaction must finish within **50 ms of CPU** and write **at most about 500 rows**. The object is single-threaded, so a long transaction stalls the whole tenant. Larger work uses sagas (§3A.1 C6) or idempotent chunks (§6.8), exactly as before; only the limit changed (A-06).
- **Statement limits.** DO SQLite limits each statement to 100 KB of SQL and 100 bound parameters, and each row or blob to 2 MB. The occupancy inserts already use recursive CTEs, so they bind only a handful of parameters. Bulk inserts are chunked to stay under 100 parameters.

The `Storage` service (§19.11) exposes only synchronous operations. Engine code that runs inside a transaction has no access to `Gateway`, `Rpc` or `Crypto` services, so a transaction body that tries to `await` fails to type-check.

**Audit chain.** `audit.prev_hash` is read and the new `hash` is written in the same transaction. Writes are single-threaded per tenant, so the chain can't fork, which the D1-style batch design could not guarantee. `crypto.subtle.digest` is async, so the hash uses the synchronous `createHash('sha256')` from `node:crypto` (Workers `nodejs_compat` flag).

**Personal data.** AES-GCM and HMAC through WebCrypto are async too. PII columns are encrypted and blind indexes computed **before** the transaction, and decrypted **after** it. Engine decisions never need PII in clear (§13.3).

## 19.3 SessionGate inside TenantCore (D-64)

Inside a transaction no interleaving is possible. Commands for one class can still interleave **across** an `await`, for example two confirms that each check a payment authorisation with the gateway. The SessionGate is therefore an in-memory FIFO queue per session inside `TenantCore`:

- Commands for one session (hold, confirm, cancel, waitlist join, promotion, offer accept, session timers) are queued in arrival order. Each one runs to completion, including its `await`s, before the next one starts. Commands for other sessions are not blocked.
- The gate caches free counts per partition. The cache is rebuilt from SQLite whenever the object starts (`blockConcurrencyWhile` in the constructor) and updated after each commit.
- Correctness never depends on the gate (principle 5). Everything it guarantees about uniqueness is also enforced by the transaction and the constraints. The gate adds only first-come ordering across `await`s, and fast free counts.
- **A gate outage is no longer a failure mode on its own.** If `TenantCore` is unavailable, the database is unavailable too (§13.8 "Tenant database"). What remains to test is a **lost or late alarm** (§19.5) and an **object restart** that drops the in-memory queues. The scenario DSL's `gate: unavailable` key is replaced by `alarms: dropped` and `restart: after_step_<n>` (§14.1).

## 19.4 Reads and caching

- **Personalised reads** (eligibility, price, the account page) go to `TenantCore` and read SQLite directly. These reads are synchronous and don't queue behind the gate.
- **Anonymous timetable and mat-map reads** are served by `kairos-api` from the Workers Cache API. The cache key is `(tenant, env, config_epoch, url)`. Entries live for 15 s (§7.2), are served stale for up to 10 min if `TenantCore` is unreachable (§13.8), and are never stored for authenticated requests.
- **Throughput budget.** A Durable Object handles about 1,000 simple requests per second. `TenantCore` is sized for **at most 600 requests/s sustained**. The §14.3 load test (300 holds/s plus 2,000 timetable reads/s) passes only if at least 90 % of timetable reads are cache hits. If a tenant outgrows one object, read traffic moves to a read-model object fed from domain events (R-13). Writes stay on `TenantCore`.

## 19.5 Scheduler: one alarm per object (D-65)

A Durable Object has exactly one alarm. `TenantCore` uses it for everything the spec calls an alarm or a sweep: hold expiry, promotion fallback, workflow `scheduled_action`s, built-in session timers, saga leases, outbox delivery, pruning and nightly reconciliation.

- **Next wake time.** After every commit, and at the end of every tick, the scheduler sets the alarm to the earliest of:
  - `min(place_claim.expires_at)` for holds;
  - `place.reserved_at + 30 s` for places reserved for the waitlist (`reserved_at` is set with `reserved_for`, §12.4);
  - `min(scheduled_action.fire_at)` for pending actions;
  - `min(saga.lease_until)` for running sagas;
  - `min(outbox.next_attempt_at)` for pending outbox rows;
  - the next maintenance slot (pruning, reconciliation, export);
  - `now + 60 s`.

  Each of these reads one index. The `now + 60 s` cap is what the spec calls "the 1-minute sweep": an object with any pending work wakes at least once a minute.
- **Tick.** The alarm handler handles up to 200 due items per kind, each in its own transaction, in this order: holds, promotions, built-in timers, scheduled actions, saga steps, outbox. It then re-arms. An item that needs an `await` (outbox delivery, auto-charge) is claimed with a lease in one transaction and completed in another (§19.2).
- **Delivery.** Alarms are delivered at least once and are retried by the platform if the handler throws. Every tick item is idempotent (run keys, action keys and saga steps, §9.5, §3A.1 C6). A duplicated alarm is harmless.
- **Backstop.** A Cron Trigger on `kairos-api` runs every 5 minutes. It asks `ControlPlane` for active tenants and calls `TenantCore.ensureAlarm()` on each one. `ensureAlarm()` sets the alarm if it is missing, and records `alarm_missing` if it was. This covers an object whose alarm was lost, for example through a bug that cleared it.
- **Timer lag target** (§9.5) is unchanged: p95 within 15 s of `fire_at`, p99 within 60 s.

`TenantSync` and `TenantAgent` use the same scheduler module for their own work: polling cadence (§18.5) and transcript pruning.

## 19.6 Outbox delivery

The outbox stays a table in `TenantCore`, and delivery is part of the scheduler tick. No queue product is used.

- A tick claims due rows (`state = 'pending' AND next_attempt_at ≤ now`) and leases them for 60 s. It then delivers each one with `fetch` to the gateway or notification service, or with RPC for internal targets (`TenantSync`, the solver, other subscribers), sending `Idempotency-Key = outbox.idempotency_key`.
- At most **6 deliveries are in flight per object**, which is the Workers limit on simultaneous outbound connections per invocation. Money jobs (refunds, fees, captures) are sent first.
- The result is recorded in a second transaction. On failure, the retry schedule in §3A.1 C5 applies (1 m, 5 m, 30 m, 2 h, 12 h, then `dead`).
- Domain events published to other services (§11.7) are outbox rows with an RPC or webhook target. Order per subject is the `domain_event.seq` order.

## 19.7 Storage size and archival (D-68)

A SQLite-backed Durable Object can hold at most **10 GB**. The reference tenant writes a few GB a year (§12.9). The hot database stays small because data is pruned or archived:

| Data | Hot in `TenantCore` | Then |
|---|---|---|
| Occupancy | 7 days after its grain | Deleted |
| Domain events | 90 days | Deleted |
| Decision traces | 400 days | Archived to R2 (NDJSON, gzip), then deleted |
| Audit log | 90 days | Archived to R2 as daily segments that carry their head and tail hashes, then deleted. The archive bucket has a bucket lock (write-once) for 7 years |
| Everything else | Kept | Kept until erasure or offboarding |

- The daily audit head hash is written to the same locked bucket (§13.4). Chain verification reads the hot table plus the archive.
- An alert fires when a `TenantCore` database passes **6 GB**. That is the point to tighten retention or split cold tables into a second object.

## 19.8 Schema migrations and deploys

- Migrations stay numbered SQL files in `packages/db/migrations`. Each SQLite-backed object applies its pending migrations in its constructor inside `blockConcurrencyWhile`, before it serves any request, and records them in `_migrations`. A migration that fails leaves the object unable to serve; it raises a page and is fixed forward.
- Expand → migrate → contract stays mandatory, and code keeps supporting schema versions N and N−1 (§12.9). With Workers gradual deployments, different objects run different code versions during a rollout, and a rollback can move an object back to the older code. N−1 support is what makes that safe. Backfills in the "migrate" step run as idempotent chunks from the scheduler, never inside the constructor.
- Preview deploys first. Production follows after the 24 h soak (§13.10). The per-tenant canary uses gradual deployments plus the location-scoped flags already in §13.10.
- RPC methods between objects carry a protocol version, and every object accepts N and N−1 (§13.10).

## 19.9 Backups and restore

- **Point-in-time restore.** SQLite-backed Durable Objects keep 30 days of point-in-time history. To restore one tenant's `TenantCore` (or `TenantSync`, or `TenantAgent`), an operator gets a bookmark with `ctx.storage.getBookmarkForTime(t)`, calls `onNextSessionRestoreBookmark(bookmark)`, and restarts the object. That restores one tenant without touching any other. The runbook is `ops/runbooks/restore-tenant.md`.
- **Nightly logical export.** The scheduler writes an NDJSON export per table to R2. A `kairos-api` cron job copies each new export to an S3-compatible bucket at a second provider, using signed `fetch` requests (§12.9).
- Restore drills (quarterly, §12.9) cover both paths.

## 19.10 Solver and simulations

**Solver (`kairos-solver`).** A Cloudflare Container running the stateless Python worker from §8.1, reached through its container-backed Durable Object.
- `TenantCore` writes the JSON IR to R2 under `solver/{tenant}/{env}/{job_id}.json`, with a 7-day lifecycle rule (§13.1). It then sends the job by RPC, and the result comes back by RPC to `TenantCore.solverResult()`.
- CP-SAT runs with `num_workers` equal to the instance's vCPUs. The §15 timing targets (desk roster ≤ 15 s, teacher week ≤ 30 s) are measured **end to end, including container start**, on the instance type chosen in Phase 0.
- When a manager opens a roster screen in the console, the console sends a warm-up ping. Containers sleep after 10 idle minutes.
- If the container is unavailable, jobs stay `pending` (§8.1, §13.8).

**Simulations (`SimulationRun`).** Simulations need the TypeScript engine, which runs on Workers, not in the Python container. Each simulation (§6.4) and each L5 impact simulation therefore runs in a throwaway Durable Object named `"{tenant}:{env}:sim:{run_id}"`:
1. `TenantCore` writes a pseudonymised snapshot (§13.1) to R2.
2. The `SimulationRun` object loads the snapshot into its own SQLite with the same migrations as production, so the SQL dialect and constraints are identical.
3. It replays demand with a virtual `Clock` layer (§19.11). It works in chunks of at most 20 s of CPU per alarm, so it stays inside the object's CPU limit.
4. It writes the results to R2, reports back to the caller, and calls `ctx.storage.deleteAll()`.

This replaces "batch worker with an in-memory SQLite" in §6.4 and §7 (D-66). The L5 feasibility probe still runs in the solver container.

## 19.11 Effect conventions (D-62)

- **Schemas.** The config schema 2.1 (§4) is written once as Effect Schema in `packages/config-schema`. JSON Schema for agent tools comes from `JSONSchema.make`; the API components come from the `HttpApi` definition. `SCHEMA_INVALID` (L1, §6.3) is a failed `Schema.decodeUnknownEither`, and its `ParseError` is reported as JSON Pointer paths. Event contracts in `packages/contracts` are Effect Schemas too, published as versioned JSON Schema (§11.7).
- **API.** `packages/contracts` defines the public API as an `HttpApi`. `kairos-api` implements it with `HttpApiBuilder` and serves it with `HttpApiBuilder.toWebHandler`. The OpenAPI 3.1 document is generated from it, and contract tests check that the generated document matches the committed one (§15 definition of done). TypeScript consumers, including the console, use `HttpApiClient`. Native apps use clients generated from the OpenAPI document.
- **Errors.** Every reason code in §7.9 is a `Schema.TaggedError` with its HTTP status and fields. The `application/problem+json` body (§11.4) is produced from the error in one place. Defects (bugs) become `500` and are never shown as reason codes.
- **Services.** Ports are `Context.Tag`s with `Layer` implementations:

  | Service | Production layer | Test / simulation layer |
  |---|---|---|
  | `Storage` (sync SQL, transactions) | `ctx.storage.sql` | the same, in `vitest-pool-workers` or `SimulationRun` |
  | `Clock` | Effect's default clock | `TestClock` / virtual clock |
  | `Gateway`, `Notifier` | `fetch` with the service identity | recorded stubs (§14.3) |
  | `Crypto` (DEK, blind index) | WebCrypto + Secrets Store | fixed test keys |
  | `IdGen` | ULID | seeded |

  The engine (`packages/engine`) depends only on `Storage` and `Clock`, so principle 1 (same config, snapshot, request and clock give the same decision) holds by construction.
- **Synchronous transaction bodies.** A transaction body is an `Effect<A, E, TxServices>` that is run with `Effect.runSyncExit` inside `transactionSync`. If it ever suspends asynchronously, `runSyncExit` returns a failure, the transaction rolls back, and the defect is logged. A test in `packages/db` checks this behaviour.
- **SQL access.** `packages/db` wraps `ctx.storage.sql` in a small typed `Storage` service. An `@effect/sql` client may replace the wrapper only if it keeps `transactionSync` semantics. That is a Phase 0 spike.
- **Runtime.** Each Worker and each Durable Object class builds one `ManagedRuntime` from its layers per isolate. Request handling uses `Effect.withSpan`, and traces are exported over OTLP with `@effect/opentelemetry`, sampled as §13.9 says.

## 19.12 CEL on Workers

Workers forbid generating code at runtime (`eval`, `new Function`). The CEL library behind `packages/expr` (§5.1, A-13) must therefore **interpret** a checked AST, not compile it to JavaScript. Compiled expressions are cached per `config_epoch` as checked ASTs, in object memory. Cost limits (§5) are enforced by the interpreter. The Phase 0 conformance run happens inside `workerd`, so a library that needs code generation fails in CI.

## 19.13 Secrets and encryption

- **Per-tenant data key (DEK).** AES-256-GCM through WebCrypto. The DEK is wrapped by a key-encryption key (KEK) kept in Cloudflare Secrets Store. The wrapped DEK and its version live in `ControlPlane`. `TenantCore` unwraps it at startup and keeps it in memory only.
- **Blind indexes.** HMAC-SHA-256 with a per-tenant index key, derived and stored the same way.
- **Rotation.** The KEK and DEKs rotate yearly. Data is re-encrypted lazily on read-write and by a background chunked job; both key versions stay readable until that job finishes.
- **Crypto-shredding** (§3A.3 Delete). Delete the wrapped DEK and index key from `ControlPlane`. Then call `deleteAll()` on every object of the tenant, and delete the tenant's R2 prefixes, except the locked audit archive, whose PII is already redacted (§13.4).
- **Service identity** for the gateway and notification service is a Worker secret per environment. Outside credentials stay in the gateway (§18.3).

## 19.14 Kairos console (TanStack Start) (D-67)

The tenant's three front ends (§18.4) remain the tenant's. Kairos ships one UI of its own: **`kairos-console`**, for owners, admins and managers. It is a TanStack Start app deployed as a Worker.

**Rules.**
- The console is an API client like any other front end. It calls the public API through `HttpApiClient`, wrapped in TanStack Query. It has no database access, no service binding to the Durable Objects, and no scheduling logic.
- TanStack Start server functions are used only for the sign-in redirect (staff sign-in service) and for keeping the session cookie that carries the staff token. They do not proxy business calls.
- Lists that the API paginates (§11.2) use cursor pagination in TanStack Table. Forms use TanStack Form with the operation's Effect Schema as the validator, so the client checks the same shape the server does, and the server stays authoritative.
- Previews (`preview: true`, §11.2) are shown before every commit that has impact groups, and the commit sends `acknowledge`.

**Screens by phase.**

| Phase | Screens |
|---|---|
| 0 | Config drafts: YAML editor, JSON Patch diff, validation L1–L6 report, impact groups, approve, publish, rollback (§6, manual path). Domain modes and flags. Tenant lifecycle (admin) |
| 1 | Drift and shadow triage (§18.5, §18.7). Person mapping. Desk roster: solve, proposal editor with `If-Match`, approve. Time off and swaps approval. Hours review, approval and Gusto CSV export (§18.8). Staff offboarding |
| 2 | Config-agent chat with draft review. Member lookup, merge, suspend, close (§3A.7). Booking shadow disagreement triage |
| 3 | Timetable series editor with the three edit scopes. Session edits with impact. Teacher roster solve. Substitute proposals and approvals |
| 4–5 | Refunds and fee waivers. Entitlement adjustments. Stripe payment status (read-only) |

If Kairos is later asked to build any of the tenant's own front ends, the same rules apply, and §18.4 stays the feature contract (A-19).

## 19.15 Repository layout

```
apps/
  api/            Worker kairos-api: HttpApi handlers, auth, cache, cron backstop
  core/           DO TenantCore + SimulationRun (engine wiring, scheduler, outbox)
  sync/           DO TenantSync (adapters, drift, shadow)
  agent/          DO TenantAgent (hooks, config agent)
  control/        DO ControlPlane
  console/        TanStack Start app (kairos-console)
  solver/         Python container image (OR-Tools CP-SAT)
packages/
  contracts/      HttpApi definition, event schemas, generated OpenAPI
  config-schema/  config schema 2.1 (Effect Schema), YAML parse, canonical JSON
  expr/           CEL profile (interpreter, §19.12)
  engine/         booking engine, person-rule validator (pure; Storage + Clock)
  workflow/       workflow engine
  db/             Storage service, migrations, SQL, audit chain
  export/         Gusto CSV export
  scheduler/      alarm scheduler shared by all DO classes
fixtures/ evals/ ops/runbooks/
```

The monorepo uses pnpm workspaces. The lint rules in §14.1 ("never branch on kind", the `template.kind` read rule) and the new transaction rule (§19.2: no `await`, `Gateway` or `Rpc` in a transaction body) run in CI on every commit.

## 19.16 Testing on `workerd`

- Unit, property and scenario tests run in `@cloudflare/vitest-pool-workers`. Each test gets real Durable Objects with real SQLite storage and isolated state. `runInDurableObject` gives direct access to SQL for assertions, and `runDurableObjectAlarm` fires the scheduler on demand.
- **Interleavings.** Inside one transaction nothing can interleave, so concurrency tests (§14.1) interleave at **`await` boundaries**: stubbed gateway calls resolve in every order, and alarms fire between any two commands.
- The scenario runner (§14.1) runs each scenario in a fresh `TenantCore` with the virtual clock. Its `alarms: dropped` key disables the alarm, so only the backstop and the next command can make progress. Its `restart` key restarts the object between steps, keeping storage and the alarm but losing in-memory state. The `concurrent` step submits its requests in the same event-loop turn.
- Load tests (§14.3) run against preview `kairos-api` from outside Cloudflare, in three regions.

## 19.17 Phase 0 spikes

Each spike has a written result in `docs/spikes/` before the Phase 0 acceptance review:

1. **CEL interpreter** passes the conformance subset inside `workerd` (A-13, §19.12).
2. **Throughput:** one `TenantCore` sustains 300 holds/s on one class plus 300 other requests/s, with p95 inside §7.11 (R-03, R-13).
3. **Solver cold start** and solve times for the §15 targets, on the chosen instance type.
4. **`@effect/sql` on DO SQLite** keeps `transactionSync` semantics, or the in-house wrapper stays.
5. **Point-in-time restore drill** on a preview tenant.
6. **Storage growth:** a year of reference-tenant volume (§12.9), generated synthetically, stays under the 6 GB alert with the §19.7 retention.
