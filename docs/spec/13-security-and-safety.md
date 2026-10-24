# 13. Security and safety

## 13.1 Tenant and environment isolation

- **Physical separation.** Each tenant has a separate database per environment. Every request resolves `(tenant_slug, env)` through the control plane to exactly one database binding before any query runs. The database handle is passed into the request context, and no code path builds a binding from user input.
- **Token checks.** Tokens must carry `tid` and `env` that match the path. A mismatch returns `403 TENANT_MISMATCH` and is audited.
- **Per-object stores** (SessionGate, TimerObject) are named `"{tenant}:{env}:{object}"`, and each one checks the tenant and environment of every message.
- **Caches** are keyed by tenant, environment and `config_epoch`. Responses for authenticated users are marked `Cache-Control: private`.
- **Preview cannot reach production records.** (a) Preview services hold only preview credentials for the gateway. (b) The gateway maps preview identities to the outside systems' sandboxes, or to a `record_only` sink (the call is logged and not forwarded), according to `tenant.environment_guards.preview_outbound`. (c) The gateway rejects any preview-identity call that targets a production endpoint, as a second line of defence. (d) A CI test asserts that the preview gateway configuration contains no production endpoints.
- **Isolation tests** (§14.1): cross-tenant read and write attempts with forged paths, swapped tokens and replayed idempotency keys must all fail.

## 13.2 Authentication and authorisation

**Human tokens.** Kairos validates JWTs from the member sign-in service and from the staff sign-in service. It checks: signature by JWKS (cached for 10 min, with refresh on an unknown `kid`); `iss`, `aud`, `exp` and `nbf` with ±60 s skew; and the `tid` claim. Roles come from `access.role_mappings` (§4.13). Each mapping can be limited to the locations listed in a claim. The platform has **no passwords and no sessions of its own**.

**Service tokens.** Other tenant services (desk app back end, portal back end, notification service callbacks, gateway inbound events) get short-lived Kairos tokens from a token-exchange endpoint. They authenticate to it with a client credential stored in their own secret store. Each token is scoped by service and operation.

**Agent tokens.** These are minted by token exchange from the principal's token plus the agent's client credential. They carry `actor.type = agent`, `agent`, `run_id` and `on_behalf_of`, and live for ≤ 15 min. Effective permissions = (permissions of the principal) ∩ (the agent's allowlist).

**Permission matrix** (abbreviated; `L` = only within the role's locations, `self` = own records only):

| Capability | owner | admin | manager | desk | instructor/staff | member | config agent | member asst. | staff asst. | sub finder |
|---|---|---|---|---|---|---|---|---|---|---|
| Read timetable and spot map | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hold, book, cancel | ✓ | ✓ | L | L | — | self | — | self (§10.1) | — | — |
| Waive penalties | ✓ | ✓ | L | L (≤ policy limit) | — | — | — | — | propose | — |
| Check in | ✓ | ✓ | L | L | L (own sessions) | self (kiosk) | — | — | — | — |
| Edit sessions, capacity | ✓ | ✓ | L | — | — | — | — | — | propose | — |
| Assign staff, publish roster | ✓ | ✓ | L | — | — | — | — | — | propose | propose |
| Approve proposals | ✓ | ✓ | L | desk-level kinds | — | — | — | — | — | — |
| Own availability, time off, swaps | ✓ | ✓ | ✓ | self | self | — | — | — | propose for self | — |
| Draft config | ✓ | ✓ | — | — | — | — | ✓ | — | — | — |
| Approve and publish config, rollback | ✓ | ✓ | — | — | — | — | — | — | — | — |
| Edit `access`, domain modes, flags | ✓ (domain modes: two-person rule) | flags only | — | — | — | — | — | — | — | — |
| Read PII custom fields | ✓ | ✓ | L | L | own sessions' attendees (configured) | self | — | self | L (desk) | — |
| Audit log | ✓ | ✓ | L (read) | — | — | — | — | — | — | — |

## 13.3 Data protection

- **No card data, ever.** Payments use the processor's hosted fields or payment pages. Kairos stores only processor references (payment intent and customer IDs), obtained through the gateway.
- **PII** (customer name, email, phone, custom fields with `pii: true`) is encrypted at the application layer with a per-tenant data key (AES-256-GCM). The key is wrapped by a key in Kairos's secret store and rotated yearly. Lookups use keyed HMAC blind indexes (email, phone).
- **Minimisation.** Agents, logs and simulations receive pseudonymised or redacted data (§6.4, §10.1). Logs never contain request bodies for customer endpoints.
- **Erasure.** A deletion request pseudonymises the customer row, deletes custom-field values, and keeps ledger and booking rows under the pseudonym (financial records). An audit entry records the erasure without restating the PII.
- **Retention:** `custom_fields[].retention` is enforced nightly. Agent transcripts are kept for 30 days.

## 13.4 Audit log

- Every state-changing call writes an `AuditEntry` in the same batch (I-29). It records the actor (including `on_behalf_of` and `run_id` for agents), action, target, a hash of the prior state, the new state (PII fields replaced by `‹redacted:field›`), `request_id` and `config_version`.
- **Hash chain:** `hash = sha256(prev_hash ‖ canonical(entry))`. A daily job verifies the chain and publishes the day's head hash to the archive bucket (write-once retention). Tampering shows up as a chain break.
- Config publications, approvals, domain-mode changes, flag changes, penalty waivers, ledger adjustments and every agent write are **always** audited, and these entries are never pruned.

## 13.5 Configuration safety

- Locked paths (`access`, environment guards) can't be patched by agents (§4.1).
- **Fee ceiling:** penalty fees above a tenant ceiling (default 100.00 in the major currency unit) fail validation. Only an owner can raise the ceiling, through a locked tenant setting.
- **Two-step publish:** an agent drafts, a human approves. Approval is bound to the draft's hash (§6.6).
- **Flags:** new schema features stay inert behind flags until enabled (I-30). A config that uses a feature whose flag is off validates with the warning `FEATURE_FLAG_OFF`, and that part is inactive.

## 13.6 Agent safety (summary of controls)

| Risk | Control |
|---|---|
| Prompt injection through member messages, help articles or email | Content goes to the model as data. The tool allowlist is enforced server-side. Consequential member actions need a member-token confirmation (§11.6). Staff-side changes are proposals only |
| Agent acts for the wrong member | `on_behalf_of` comes from the member's own token. The API rejects a `customer_id` other than the principal for member-assistant tokens |
| Agent books beyond the rules | The engine validates everything. Agents have no override parameters, and `waive`/`force` fields are refused for agent tokens |
| Agent spams staff | Offer and proposal rate limits, quiet hours, fixed templates (§10.4) |
| Config agent writes unsafe config | Schema boundary, validation, simulation, human approval, locked paths, fee ceiling |
| Model outage or regression | Every hook has a deterministic fallback (templated explanations; deterministic substitute mode). Booking never depends on an LLM. Model upgrades are gated by evals (§14.4) |
| Data leaking across members | Hook checkers (§10.3). Member-facing agents can't read other customers or staff contact details |

## 13.7 Abuse and availability

- **Booking-open rushes:** per-member limit of 5 hold attempts per session per minute, global edge rate limits, and SessionGate ordering. Automated clients are detected by a token-bucket score per member, which degrades them to a challenge in the website, not in the API.
- Inbound webhooks from outside systems arrive only through the gateway, signed, with their timestamps checked within 5 min.
- **Service-level objectives:** booking API availability 99.95 % monthly. The SessionGate and the solver worker may degrade without affecting correctness.
