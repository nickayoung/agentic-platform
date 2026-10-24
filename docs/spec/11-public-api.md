# 11. Public API

## 11.1 Style: REST + JSON, described by OpenAPI 3.1 (D-03)

REST was chosen over GraphQL for these reasons:

- **Edge caching.** The busiest reads (the timetable, the spot map) are cacheable `GET`s keyed by URL and `config_epoch`. GraphQL `POST` queries defeat the edge cache.
- **Writes are commands, not graph mutations.** Hold, confirm, cancel and approve each need an `Idempotency-Key`, precise error codes and a decision trace. These map directly to REST resources and `POST` actions.
- **Agent tools.** Every operation becomes one typed tool generated from OpenAPI (`@kairos/agent-tools`). Allowlists work per operation. GraphQL would need field-level allowlisting and cost analysis to give the same safety.
- **Bounded cost.** Every endpoint has a fixed query plan and a page limit, with no client-defined joins, which matters for single-writer SQLite databases.
- **Typed contracts.** Zod → OpenAPI → generated TypeScript clients for the three front ends and the native apps. This matches the tenant's "typed service-to-service contracts" rule (§18.3).

Over-fetching is handled with `include=` expansions on a few endpoints (`sessions?include=availability,assignments,places_summary`).

## 11.2 Conventions

- **Base URL:** `https://api.<platform-domain>/v1/t/{tenant_slug}/{env}/…`. Here `env ∈ {preview, production}`. Every token's tenant and environment claims must match the path (§13.1).
- **Auth:** `Authorization: Bearer <JWT>` from the member or staff sign-in service, or a service or agent token minted by the Kairos token exchange (§13.2).
- **Idempotency:** every `POST` that creates or changes state **requires** `Idempotency-Key` (≤ 64 characters). The response is stored for 72 h and replayed for a duplicate key with the same body. A duplicate key with a different body returns `422 IDEMPOTENCY_MISMATCH`.
- **Concurrency:** mutable resources return `ETag: "v<version>"`. `PATCH` and `PUT` require `If-Match`.
- **Errors:** `application/problem+json`:

  ```json
  { "type": "https://docs.kairos.dev/errors/PLACE_TAKEN", "status": 409, "code": "PLACE_TAKEN",
    "title": "That place was just taken", "decision_id": "dec_01J…",
    "reasons": [{ "code": "PLACE_TAKEN", "config_path": null, "facts": { "place": "Bike 12" } }],
    "alternatives": [{ "place_id": "plc_…", "label": "Bike 13" }] }
  ```

- **Pagination:** cursor based: `?limit=50&cursor=…`, with `limit` ≤ 200.
- **Times:** RFC 3339 UTC (`2026-11-03T23:30:00Z`) plus a `local` object `{ date, time, zone }` on session-like resources.
- **Versioning:** `/v1` is backwards compatible. Breaking changes go to `/v2`, with ≥ 6 months of overlap.

## 11.3 Resources and endpoints

### Configuration
| Method & path | Purpose | Roles / scopes |
|---|---|---|
| `GET /config/active` · `GET /config/versions` · `GET /config/versions/{n}` | read config | staff (redacted `access` for non-owners) |
| `POST /config/drafts` · `GET/PATCH /config/drafts/{id}` (JSON Patch) | edit a draft | owner, admin, config agent |
| `POST /config/drafts/{id}/validate` · `/simulate` · `/impact` · `/diff` | checks (§6) | owner, admin, config agent |
| `POST /config/drafts/{id}/submit` | to `awaiting_approval` | owner, admin, config agent |
| `POST /config/drafts/{id}/approve` · `/reject` | approval | owner, admin (human only) |
| `POST /config/rollback` `{ to_version, emergency? }` | rollback | owner, admin (human only) |
| `GET /config/versions/{n}/migration` | migration progress | owner, admin, manager |

### Catalog and resources
| Method & path | Purpose |
|---|---|
| `GET /locations` · `GET /templates` · `GET /entitlement-products` | compiled config views for front ends |
| `GET /resources?kind=&role=&location=` · `GET /resources/{id}` | people (staff-visible fields) and structural resources |
| `PATCH /resources/{id}` | people: skills, roles, attributes (manager); structural resources are config-only |
| `GET/POST /resources/{id}/availability` · `DELETE …/{avl_id}` | staff availability (self or manager) |
| `GET/POST /time-off` · `POST /time-off/{id}/approve` | time off, including immediate sick calls |
| `POST /resources/{id}/blocks` | block a resource (maintenance) |

### Sessions, timetable, places
| Method & path | Purpose |
|---|---|
| `GET /sessions?from=&to=&location=&template_tags=&kind=&assigned_to=&include=` | timetable, shifts and teaching schedules. `assigned_to=me` for the staff portal |
| `GET /sessions/{id}` · `GET /sessions/{id}/places` | session detail and spot map |
| `POST /sessions` | create a one-off session (manager, desk) |
| `PATCH /sessions/{id}` | retime, change capacity, add a note (validated; may need a proposal) |
| `POST /sessions/{id}/cancel` `{ reason, refund }` | cancel with refunds |
| `GET /sessions/{id}/roster` | attendee list for the desk (bookings, check-in state, intake flags) |
| `GET /sessions/{id}/substitutes?requirement=` | ranked valid candidates (§8.7) |

### Booking
| Method & path | Purpose |
|---|---|
| `POST /availability/search` | on-demand and arrival-window slot search |
| `POST /holds` `{ session_id | on_demand{…}, place_id?, customer_id?, intake? }` | hold + quote (+ `confirmation` for agents) |
| `DELETE /holds/{id}` | release a hold |
| `POST /bookings` `{ hold_id, payment?: { processor_authorization_id }, confirmation_token? }` | confirm |
| `GET /bookings?customer_id=me&state=&from=` · `GET /bookings/{id}` | account page, desk |
| `POST /bookings/{id}/cancel` `{ preview?: boolean, confirmation_token?, waive?: boolean }` | cancel. `preview` returns penalty + confirmation |
| `POST /bookings/{id}/move` `{ to_session_id, place_id? }` | reschedule = hold new + cancel old, atomic where same policy |
| `POST /bookings/{id}/attendance` `{ state: attended | no_show, reason }` | staff correction |
| `POST /check-ins` `{ booking_id | { session_id, customer_id } }` | desk/kiosk check-in (walk-ins use `online:false` partitions) |
| `POST /sessions/{id}/waitlist` · `DELETE /sessions/{id}/waitlist/me` · `POST /waitlist/{id}/accept` | waitlist |
| `GET /approvals` · `POST /approvals/{id}/decide` | pending-approval bookings |
| `GET /decisions/{id}` | decision trace (member: own decisions only, redacted) |

### Customers and entitlements
| Method & path | Purpose |
|---|---|
| `GET /customers/me` · `GET /customers?query=` (staff) · `GET /customers/{id}` | profile, tier, history counts |
| `PATCH /customers/{id}` | custom fields within `editable_by` |
| `GET /customers/{id}/entitlements` · `GET /entitlements/{id}/ledger` | credits and memberships |
| `POST /entitlements` `{ customer_id, product_key, processor_ref }` | grant after purchase (members domain owner) |
| `POST /entitlements/{id}/adjust` `{ unit, delta, reason }` | staff adjustment (bounded by role) |

### Staff operations
| Method & path | Purpose |
|---|---|
| `GET /assignments?resource_id=&from=&to=` | my shifts and classes (portal) |
| `POST /assignments` · `DELETE /assignments/{id}` | manager edits (validated, §8.6) |
| `POST /rosters/solve` `{ kind, scope, horizon }` → `202 { job_id }` · `GET /rosters/jobs/{id}` | solver jobs |
| `POST /swaps` · `POST /swaps/{id}/accept` · `/approve` | shift and class swaps |
| `GET /proposals?state=` · `POST /proposals` · `POST /proposals/{id}/approve` · `/reject` | proposals (agents create, humans approve) |
| `GET /desk/now?location=` | who is on the desk now and next, today's sessions with staffing state |
| `GET/POST /tasks` · `POST /tasks/{id}/complete` | desk checklists and reminders |
| `GET /hours?from=&to=&resource_id=` · `POST /exports/hours` | hours records and payroll export (§18.8) |
| `POST /time-clock/punches` | later phase: actual start and end |

### Sync, flags, events, audit (admin)
| Method & path | Purpose |
|---|---|
| `GET /sync/domains` · `POST /sync/domains/{domain}/mode` `{ mode, outbound_push }` | domain modes (§18.5); owner only, two-person rule for `owner`↔`mirror` |
| `POST /sync/domains/{domain}/reconcile` `{ window }` | run drift scan |
| `GET /sync/drift?state=open` · `POST /sync/drift/{id}/resolve` | drift items |
| `GET /sync/shadow-disagreements` · `PATCH …/{id}` (triage) | shadow mode |
| `POST /sync/inbound/{system}` | the outside system's events, delivered through the gateway (signed) |
| `GET/PUT /flags/{key}` | feature flags |
| `POST /subscriptions` `{ events[], target_service }` | typed event delivery to other services (§18.3) |
| `GET /audit?target=&actor=&from=` | audit log |

## 11.4 Example: hold and confirm

```http
POST /v1/t/cadence/production/holds
Authorization: Bearer eyJ… (member token)
Idempotency-Key: 7c1e…
Content-Type: application/json

{ "session_id": "ses_01JB…", "place_id": "plc_01JB…bike12" }
```

```http
201 Created
{ "hold_id": "hld_01JB…", "expires_at": "2026-11-03T17:05:00Z",
  "place": { "id": "plc_01JB…bike12", "label": "Bike 12", "attributes": { "front_row": true } },
  "quote": { "payment": "units", "unit": "class_credit", "amount": 1, "entitlement_id": "ent_01J…",
             "terms": { "free_cancel_until": "2026-11-03T11:30:00Z", "late": "credit forfeited",
                        "no_show": "credit forfeited, $20 fee for memberships" },
             "approval_required": false },
  "decision_id": "dec_01JB…" }
```

```http
POST /v1/t/cadence/production/bookings
Idempotency-Key: 9a44…
{ "hold_id": "hld_01JB…" }
→ 201 { "booking_id": "bkg_01JB…", "state": "confirmed", … }
```

## 11.5 Multi-tenancy

- **Database per tenant per environment** (D-04): the path's `tenant_slug` and `env` select the database binding through the control-plane registry. Code paths cannot reach another tenant's database (§13.1).
- Tokens carry `tid` (tenant) and `env`. Both must match the path. Service tokens are minted per tenant and environment.
- Edge caches are keyed by tenant, environment and `config_epoch`.

## 11.6 Confirmations (agent-initiated consequential actions)

```json
"confirmation": { "token": "cnf_01JB…", "expires_at": "2026-11-03T17:05:00Z",
  "binds": { "action": "cancel", "booking_id": "bkg_…", "penalty": { "fee": { "minor": 1500, "currency": "USD" },
             "forfeit_units": true }, "terms_hash": "…" },
  "summary": "Cancel Tue 18:30 Spin. It's within 12 hours, so a $15 late fee applies unless your bike is re-booked." }
```

The token is single-use and bound to the exact parameters and the current terms. Redeeming it needs a **member token for the same customer**. Front ends render it as a confirm card. Email and SMS channels send a signed short link to a confirm page on the website. If any bound fact changes before it is redeemed, it fails with `CONFIRMATION_STALE`.

## 11.7 Events to other services

Kairos publishes typed domain events (§9.2) to subscribing services through the outbox, with at-least-once delivery and an `event_id` for dedupe. Each event type has a versioned JSON Schema in `packages/contracts`. Events are the only way other services learn about Kairos changes, because no service reads Kairos's database.
