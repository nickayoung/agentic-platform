# agentic-platform

Kairos for yoga studios: a scheduling platform that a multi-studio yoga business configures in natural language. An LLM compiles the owner's description into a typed, versioned configuration. Deterministic engines run every booking and rostering decision. Runs entirely on Cloudflare: TypeScript on Workers and Durable Objects, with a TanStack Start console (spec §19).

- Technical specification: [docs/spec/README.md](docs/spec/README.md)
- Config fixtures: [fixtures/configs/](fixtures/configs/) · Gusto CSV example: [fixtures/exports/](fixtures/exports/)
- Configuration-agent eval cases: [evals/config-agent/cases.yaml](evals/config-agent/cases.yaml)
- Reviews: [docs/reviews/](docs/reviews/) (review 3 and the v3.0 revision notes)
- Source: Cloudflare Artifacts `kairos/agentic-platform` (GitHub mirror holds the review PR) · CI: `kairos-ci` (§19.18)
- Phase 0 progress: [docs/phase-0-status.md](docs/phase-0-status.md)

## Development

Node 22 and pnpm 10.

```sh
pnpm install
pnpm typecheck      # every package
pnpm lint           # includes kairos/no-async-in-tx and kairos/no-kind-branch (§14.1, §19.2)
pnpm test           # runs inside workerd with real Durable Object SQLite (§19.16)
OCC_RUNS=20 pnpm --filter @kairos/db test   # shorter occupancy property test while iterating
```

| Path | What it is |
|---|---|
| `apps/api` | Worker `kairos-api`: Hono + `@hono/zod-openapi`, auth, tenant resolution, routes, backstop cron. Hosts the Durable Object classes |
| `apps/core` | `TenantCore` Durable Object: kairos-core database, scheduler, outbox, config pipeline |
| `apps/sync` | `TenantSync` Durable Object: kairos-sync database, gateway adapters, inbound events |
| `apps/ci` | `kairos-ci`: CI on Cloudflare: Workflow per commit, runner Container, results in R2 (§19.18) |
| `apps/control` | `ControlPlane` Durable Object: tenant registry, wrapped keys, lifecycle |
| `packages/db` | Transactions (`db.tx`), migrations, occupancy, audit chain, canonical JSON |
| `packages/scheduler` | The single-alarm scheduler, outbox delivery, saga runner (§19.5, §19.6) |
| `packages/config-schema` | Config schema 2.1 (Zod), YAML parsing, hashing, JSON Patch, validator L1–L4 |
| `packages/expr` | The CEL profile: in-house checker and interpreter (§5, §19.12) |
| `packages/crypto` | Per-tenant keys, field encryption, blind indexes (§19.13) |
| `packages/errors` | Reason codes and `KairosError` |
| `tools/eslint-plugin-kairos` | The Kairos lint rules |

The OpenAPI 3.1 document is served at `GET /v1/openapi.json`.
