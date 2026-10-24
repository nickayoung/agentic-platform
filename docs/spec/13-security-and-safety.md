# 13. Security, safety and operations

## 13.1 Tenant and environment isolation

| Layer | Control |
|---|---|
| Storage | Each tenant has its own database per environment: the storage of its `TenantCore`, `TenantSync` and `TenantAgent` objects (§19.1). A request resolves `(tenant, env)` through the control plane before it can address any object. An object name is built only from a slug the control plane has confirmed, never from other user input. Preview and production are separate Worker deployments with separate Durable Object namespaces, so preview code can't address a production object. |
| Tokens | The token's `tid` and `env` must match the path. A mismatch returns `403 TENANT_MISMATCH` and is audited. |
| Durable Objects | Each object is named `"{tenant}:{env}"` (or `"{tenant}:{env}:sim:{run_id}"`) and checks the tenant and environment of every RPC call against its own name. |
| Caches | Keyed by tenant, environment and `config_epoch`. Authenticated responses are `Cache-Control: private`. |
| Agents | Agent tokens are minted per tenant. Prompts and hook inputs contain one tenant's data only. Hook runs are stored in that tenant's `kairos-agent` database. |
| Logs | Every log line carries `tenant` and `env`. The log store (Logpush to R2 under a per-tenant prefix, §19.11) is partitioned by tenant, and people with support access see only the tenants assigned to them. Request bodies of member endpoints are never logged. Logs are kept for 30 days. |
| Solver and simulation | Inputs are pseudonymised. Job payloads are tagged with the tenant and deleted after 7 days. |
| Preview → production | (a) Preview services hold preview gateway credentials only. (b) The gateway maps preview to the outside systems' sandboxes, or to `record_only` (logged, never forwarded). (c) The gateway rejects any preview call aimed at a production endpoint. (d) CI asserts that the preview gateway config has no production endpoints. (e) Preview is seeded weekly from a **pseudonymised** production copy, with names, emails and phones replaced and processor references removed. |

Isolation tests (§14.1) attack every row of this table.

## 13.2 Authentication and authorisation

**Human tokens.** Kairos accepts JWTs from the member sign-in service and the staff sign-in service. It checks:
- the signature, using JWKS (cached for 10 minutes, refreshed on an unknown `kid`);
- `iss`, `aud`, `exp` and `nbf`, with ±60 s of clock skew allowed;
- `tid`.

On every request, Kairos also checks the person's or member's `state` (cached for ≤ 60 s), so an offboarded or suspended identity stops working within a minute. Roles come from `access.role_mappings`, and each role can be restricted to the locations in a claim.

**Service and agent tokens.** A service or agent client presents its credential to Kairos's token exchange and receives a token valid for ≤ 15 minutes. The credential lives in the client's own secret store. An agent token carries `on_behalf_of`, and its effective permissions are the intersection of the principal's permissions and the agent's allowlist.

**Staff who are also members.** These are two identities from two sign-in services. They can be linked (§3A.7), but their permissions are never merged.

**Permission matrix.** `L` = only within the role's locations. `self` = own records only.

| Capability | owner | admin | manager | desk | instructor / staff | member | config agent | member asst. | staff asst. | sub finder |
|---|---|---|---|---|---|---|---|---|---|---|
| Timetable, mat map | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hold, book, cancel | ✓ | ✓ | L | L | — | self | — | self (§10.1) | — | — |
| Waive penalties | ✓ | ✓ | L | L (≤ 1 credit / $15) | — | — | — | — | propose | — |
| Check in | ✓ | ✓ | L | L | own classes | self (kiosk) | — | — | — | — |
| Edit sessions, closures, blocks | ✓ | ✓ | L | blocks (mats) | — | — | — | — | propose | — |
| Assign staff, publish roster | ✓ | ✓ | L | — | — | — | — | — | propose | — (offers only; the engine creates the proposal on accept, D-57) |
| Approve proposals | ✓ | ✓ | L | desk-level kinds | — | — | — | — | — | — |
| Own availability, time off, swaps, offers | ✓ | ✓ | ✓ | self | self | own place offers | — | — | propose for self | create substitute offers |
| Offboard staff | ✓ | ✓ | L | — | — | — | — | — | — | — |
| Merge, suspend, erase members | ✓ | ✓ | L | — | — | erase / export self | — | — | — | — |
| Draft config | ✓ | ✓ | — | — | — | — | ✓ | — | — | — |
| Approve, publish, roll back config | ✓ | ✓ | — | — | — | — | — | — | — | — |
| Access, domain modes, tenant offboarding | ✓ (two-person rule) | — | — | — | — | — | — | — | — | — |
| Flags, agent clients | ✓ | ✓ | — | — | — | — | — | — | — | — |
| PII custom fields | ✓ | ✓ | L | L | own classes' attendees (per `visible_to`) | self | — | self | L (desk) | — |
| Audit log | ✓ | ✓ | L (read) | — | — | — | — | — | — | — |

## 13.3 Personal data

| Data | Why it is stored | Retention |
|---|---|---|
| Member name, email, phone (encrypted, blind-indexed) | Account, notifications through recipient references, desk lookup | Until erasure. A closed account is erased 2 years after closure unless the member returns |
| Waivers and consents | Legal record of consent | 7 years after last visit |
| Intake fields (`pii: true`) such as injuries and due date | Teacher safety | `retention` per field (26–52 weeks) |
| Bookings, ledger, payment references (processor IDs, never card data) | Financial records | 7 years, pseudonymised after erasure |
| Staff personal fields | Contact, scheduling | 90 days after offboarding (§3A.6) |
| Staff assignments and hours | Payroll and audit | 7 years |
| Gusto CSV export files (names, payroll IDs, hours) | Manager upload to Gusto | 30 days; signed download links valid 24 h; every download audited |
| Agent transcripts | Debugging, evals | 30 days |

- **Encryption:** application-layer encryption with a per-tenant data key (AES-256-GCM, WebCrypto), wrapped by a key-encryption key in Cloudflare Secrets Store and rotated yearly. Encryption happens before a transaction and decryption after it (§19.2). Destroying the key crypto-shreds the tenant (§3A.3, §19.13).
- **Export and erasure** for members: §3A.7. Kairos stores no card data at any point (§7.5.4).

## 13.4 Audit log

- **What is recorded:** every state change, with the actor (including `on_behalf_of` and `run_id`), action, target, prior-state hash, new state (PII redacted), `request_id` and `config_version`.
- **Tamper evidence:** each entry's hash is `sha256(prev_hash ‖ entry)`. The chain is verified daily, and the day's head hash is published to a write-once archive (a locked R2 bucket, §19.7).
- **Never pruned:** config publications, approvals, domain-mode changes, flag changes, waivers, ledger adjustments, agent writes, offboarding and erasure.
- **Per event:** each lifecycle card in §3A names what its audit entry records beyond the defaults (§3A.1 C1).
- **Readers:** owner and admin see everything. Managers see entries for their locations. Retention is 7 years.

## 13.5 Configuration safety

- Locked paths (§4.1.1).
- Fees above `tenant.fee_ceiling` fail validation (`FEE_ABOVE_CEILING`).
- Agents draft and humans approve. An approval is bound to the draft's hash.
- A feature whose flag is off stays inert (`FEATURE_FLAG_OFF` warning).

## 13.6 Agent safety

| Risk | Control |
|---|---|
| Prompt injection | Untrusted content is passed as data. Allowlists are enforced server-side. Consequential member actions need a member-token confirmation. Staff changes are proposals only |
| Acting for the wrong member | `on_behalf_of` comes from the member's own token. Member-assistant tokens reject any other `customer_id` |
| Booking beyond the rules | The engine validates everything. The `waive` and `force` fields are refused for agent tokens |
| Spamming staff | Offer limits, quiet hours and fixed templates |
| Unsafe config | Schema boundary, validation, simulation, approval, locked paths, fee ceiling |
| Model outage or regression | Deterministic fallbacks; eval gates on model changes |
| Leakage between members | H2 checker. Member-facing agents can't read other members' data or staff contact details |

## 13.7 Abuse

- Each member may make 5 hold attempts per class per minute.
- Edge rate limits apply in front of the API.
- Inbound webhooks arrive only through the gateway, signed, and are rejected if their timestamp is more than 5 minutes off.

## 13.8 Failure behaviour

| Component down | What members and staff see | What retries | What can be lost |
|---|---|---|---|
| Tenant database (`TenantCore` object) | Booking, cancelling and staff writes fail with `503 Retry-After`. Anonymous timetable is served from the edge cache (≤ 15 s old, then a stale banner for up to 10 min) | Clients retry with the same idempotency key | Nothing committed. Desk check-ins queue offline |
| Scheduler alarm (late or lost) | Timers, hold expiry and promotion run up to 60 s late (next tick), or up to 5 min late if the alarm was lost (backstop) | Next tick; 5-minute backstop cron (§19.5) | Nothing |
| Notification service | Messages delayed | Outbox retries for 24 h, then `dead` plus a manager task | Messages older than 24 h are not sent, and the failure is visible in the task list |
| Gateway | Mirror-mode writes: `OUTSIDE_UNAVAILABLE` (§7.12). Owned-mode refunds, fees and pushes are delayed. Payroll CSV exports are unaffected, because they need no gateway call | Outbox retries for 24 h, then `dead` plus an alert | No money moves without a successful gateway call, and every pending money job stays in the outbox |
| Solver container | Roster jobs show "pending". Substitute candidates still work (no solver needed) | Job queue | Nothing |
| LLM provider | Hooks fall back to deterministic mode, so the member assistant falls back to templated answers | — | Nothing |

## 13.9 Observability

- **Logs.** Structured JSON with `ts`, `tenant`, `env`, `service`, `request_id`, `decision_id`, `actor_type`, `route`, `status`, `latency_ms` and `code`. No PII.
- **Traces.** Workers tracing spans (§19.11) for `kairos-api` → `TenantCore` RPC → SessionGate queue → transaction → outbox → gateway, sampled at 10 %, and at 100 % on errors.
- **Metrics and alerts** (each alert links to a runbook in `ops/runbooks/<alert>.md`):

| Metric | Alert threshold |
|---|---|
| Booking API 5xx rate | > 1 % for 5 min (page) |
| Hold / confirm p95 latency | > 2× target for 10 min |
| `PLACE_TAKEN` rate in a rush | Informational only |
| Invariant checker violations (continuous, production) | Any (page) |
| Timer lag p95 | > 60 s for 10 min |
| `alarm_missing` recorded by the backstop | Any |
| `TenantCore` storage size | > 6 GB (§19.7) |
| `TenantCore` requests/s | > 600 sustained for 5 min (§19.4) |
| Outbox backlog / `dead` rows | > 1,000 / any money job |
| Drift rate / `cross_domain_conflict` / `unmapped_person` | > 0.5 % for 1 h / any / any |
| Mirror staleness | > 15 min |
| Solver job failures / timeouts | > 2 in 1 h |
| Expression error bursts | ≥ 10 per hour per expression |

- **Incident dashboards:**
  - Booking health: latency, error codes, SessionGate queue depth, transaction CPU time.
  - Sync health: staleness, drift, disagreements, push lag.
  - Async health: timer lag, outbox backlog by target.
  - Rostering: job runtimes and statuses.
  - Per-tenant overview.
- **Measuring performance targets:** synthetic probes every minute (§7.11), plus the load-test gates in §15.

## 13.10 Deploying and rolling back the engines

- **Build:** an immutable build per commit. `wrangler` deploys it to preview first.
- **Rollout:** a canary per tenant. Preview for 24 h, then one studio's traffic (routed by a location-scoped flag), then everything. Worker and Durable Object code roll out with gradual deployments (§19.8).
- **Automatic rollback:** triggered if any page-level alert fires during the canary.
- **Compatibility:** Workers and Durable Objects share an RPC protocol version, and every component accepts versions N and N−1. Database schema follows expand/contract (§12.9), so rolling back the code never needs a schema rollback.
- **Rollback:** redeploy the previous build with one `wrangler` command (`wrangler rollback`). Target: ≤ 5 min.
- **Solver container:** versioned images, with a rollback to the previous tag. Golden-IR tests must pass before promotion.
