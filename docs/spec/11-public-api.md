# 11. Public API

## 11.1 Style: REST + JSON, described by OpenAPI 3.1 (D-03)

The API is REST, not GraphQL, for five reasons:

- **Caching.** The busiest reads (the timetable and mat maps) are cacheable `GET`s, keyed by URL and `config_epoch`.
- **Precise writes.** Hold, confirm, cancel and approve are commands that need idempotency keys, precise error codes and decision traces.
- **Agent tooling.** Each operation is one typed agent tool with its own allowlist entry.
- **Bounded cost.** Query cost is bounded on single-writer SQLite.
- **Generated clients.** An Effect `HttpApi` definition in `packages/contracts` → OpenAPI 3.1 → clients: `HttpApiClient` for TypeScript (website, desk app, portal, Kairos console) and generated clients for the native apps (§19.11).

`include=` expansions cover the common joins.

## 11.2 Conventions

- **Base URL:** `https://api.<platform>/v1/t/{tenant_slug}/{env}/…`. The token's `tid` and `env` claims must match the path.
- **Auth:** `Authorization: Bearer <JWT>`. The JWT comes from the member or staff sign-in service, or from Kairos token exchange (service and agent tokens, §13.2).
- **`Idempotency-Key`** is required on every state-changing `POST`. Responses are replayed for 72 h. The same key with a different body returns `422 IDEMPOTENCY_MISMATCH`.
- **`ETag` / `If-Match`** apply to mutable resources: sessions, proposals, resources and drafts.
- **Errors** use `application/problem+json` with `code`, `decision_id`, `reasons[]` and `alternatives[]` (see §11.4).
- **Pagination** is cursor-based, with `limit ≤ 200`.
- **`me` alias.** In a path segment or a filter value, `me` means the caller: the caller's person resource ID for a staff token (`/resources/me/availability`, `GET /assignments?resource_id=me`), or the caller's customer ID for a member token (`/customers/me`, `GET /bookings?customer_id=me`). A token without that identity gets `404`.
- **Preview.** Commands that can have side effects on other records accept `"preview": true` **in the body** (never as a query parameter). The response is the impact, with `impact_groups[]`, and nothing is written. The same request without `preview` commits.
- **Times** are RFC 3339 UTC, plus a `local {date, time, zone}` field in the **studio** zone.
- **Versioning:** `/v1` stays backwards compatible. Breaking changes ship as `/v2`, with at least 6 months of overlap.

## 11.3 Endpoints

Roles are listed per group. The full matrix is in §13.2.

### Configuration (owner, admin; config agent for drafts)
| Endpoint | Purpose |
|---|---|
| `GET /config/active`, `GET /config/versions`, `GET /config/versions/{n}`, `GET /config/versions/{n}/migration` | Read config, versions and migration progress |
| `POST /config/drafts`; `GET`/`PATCH /config/drafts/{id}` (JSON Patch, `If-Match`) | Create, read and edit drafts |
| `POST /config/drafts/{id}/validate`, `/simulate`, `/impact`, `/diff`, `/submit` | Check and submit a draft |
| `POST /config/drafts/{id}/approve`, `/reject` | Approve or reject (human only) |
| `POST /config/rollback {to_version, emergency?}` | Roll back (human only) |

### Catalog, studios, rooms, people
| Endpoint | Purpose |
|---|---|
| `GET /locations`, `GET /templates`, `GET /entitlement-products` | Compiled config views |
| `GET /policies/{key}/text?locale=` | Rendered policy text, for the website and agents |
| `POST /locations/{key}/closures {start, end, reason, preview?}` | Studio closure (§3A.4.1). Manager |
| `GET /resources?kind=&role=&location=`, `GET /resources/{id}` | Rooms, desks and people (staff-visible fields) |
| `PATCH /resources/{id}` | People: skills and expiry, roles, `payroll_ref`, `payroll_type`, `home_location_key`, `calendar_sync`. Manager |
| `POST /resources/{id}/blocks {start, end, reason, preview?}`, `DELETE /resources/{id}/blocks/{blk}` | Take a room or mat out of service (§3A.5.1). Manager or desk |
| `POST /resources/{id}/deactivate {effective, reason}`, `POST /resources/{id}/reactivate` | Staff offboarding and rehire (§3A.6). Manager; also fired by the directory |
| `GET`/`POST /resources/{id}/availability`, `DELETE …/{avl}` | Availability (self or manager) |
| `GET`/`POST /time-off`, `POST /time-off/{id}/approve`, `/reject`, `/cancel` | Time off, including immediate sick calls |

### Sessions and mat maps
| Endpoint | Purpose |
|---|---|
| `GET /sessions?from=&to=&location=&template_tags=&kind=&assigned_to=&include=availability,assignments,places_summary` | Timetable; shift and teaching schedules (`assigned_to=me`) |
| `GET /sessions/{id}`, `GET /sessions/{id}/places` | Session detail and mat map |
| `POST /sessions` | One-off class or shift (manager, desk) |
| `PATCH /sessions/{id} {start?, room?, capacity?, preview?, acknowledge?: string[], keep_assignments_or_fail?}` (`If-Match`) | Edit "this one": retime, room, capacity (§4.7, §3A.9.2). A substitute is set through a proposal |
| `POST /sessions/{id}/cancel {reason, preview?}` | Studio cancel (§3A.9.4) |
| `GET /sessions/{id}/waitlist` | Waitlist entries and open offers (desk, manager) |
| `GET /sessions/{id}/roster` | Attendee list for the desk and the teacher |
| `GET /sessions/{id}/substitutes?requirement=` | Ranked valid candidates |

### Booking
| Endpoint | Purpose |
|---|---|
| `POST /holds {session_id, place_id?, customer_id?, intake?}`, `DELETE /holds/{id}` | Hold, with quote and `confirmation` for agents |
| `POST /bookings {hold_id, payment?: {processor_authorization_id}, confirmation_token?}` | Confirm |
| `GET /bookings?customer_id=me&state=&from=`, `GET /bookings/{id}` | Account page, desk |
| `POST /bookings/{id}/cancel {preview?, confirmation_token?, waive?}` | Cancel; `preview` returns the penalty and a confirmation. `waive` is staff only, never agents |
| `POST /bookings/{id}/move {to_session_id, place_id?}` | Move to another class, only before `free_cancel_until` (§3A.12.9) |
| `POST /bookings/{id}/attendance {state, reason}` | No-show correction (staff) |
| `POST /check-ins {booking_id, client_key}` | Check-in; `client_key` is the idempotency key for the offline queue |
| `POST /sessions/{id}/waitlist {preferred_place_ids?, auto_charge_consent?, payment_method_ref?}`, `DELETE /sessions/{id}/waitlist/me` | Waitlist |
| `GET /waitlist-entries?customer_id=me&state=` | A member's own waitlist entries (account page); staff may pass any customer ID |
| `GET /approvals`, `POST /approvals/{id}/decide` | Booking approvals |
| `GET /decisions/{id}` | Decision trace (members: own decisions, redacted) |

### Offers
| Endpoint | Purpose |
|---|---|
| `POST /offers {kind: substitute, session_id, requirement_key, resource_id, expires_at, note?}` | Substitute offer (substitute finder, manager). Place offers are created only by the engine |
| `GET /offers?recipient=me&state=sent` | Open offers for a teacher (phone app) or a member |
| `GET /offers/{id}` | Offer detail |
| `POST /offers/{id}/accept`, `POST /offers/{id}/decline` | The recipient's own token only. For `kind: place`, accept creates the hold in the same batch and returns `{ hold_id, expires_at, quote }`; the member then confirms with `POST /bookings`. For `kind: substitute`, accept creates the proposal in the same batch and returns `{ proposal_id, validation }`; a second accept for the same slot gets `409 OFFER_FILLED` (§3A.14) |
| `POST /offers/{id}/reply {text, interpreted}` | Substitute finder records an SMS/email reply |
| `POST /offers/{id}/withdraw` | Creator or manager |

### Members and entitlements
| Endpoint | Purpose |
|---|---|
| `GET /customers/me`, `PATCH /customers/me` | Profile, home studio, own custom fields |
| `GET /customers?query=`, `GET /customers/{id}`, `POST /customers` (desk guest) | Staff lookup and guest creation |
| `POST /customers/{id}/merge {into}` | Merge duplicates (manager) |
| `POST /customers/{id}/suspend {until?, reason, cancel_future}`, `POST /customers/{id}/unsuspend` | Suspension (manager) |
| `POST /customers/me/close`, `POST /customers/{id}/close` | Close an account |
| `POST /customers/{id}/export`, `POST /customers/{id}/erase` | Data subject export and erasure (self or manager) |
| `POST /resources/me/link-member {customer_id}` (staff token) → `{ link_id }`; `POST /customers/me/link-staff {link_id}` (member token) | Link a member account to the same person's staff identity. Both tokens are required, and the verified emails must match (§3A.7) |
| `GET /customers/{id}/strikes`, `DELETE /customers/{id}/strikes/{stk}` | Strikes within the window; manager removal (audited) |
| `GET /customers/{id}/entitlements`, `GET /entitlements/{id}/ledger` | Credits and memberships |
| `POST /entitlements {customer_id, product_key, processor_ref}` | Grant (members domain owned) |
| `POST /entitlements/{id}/adjust {unit, delta, reason}` | Adjustment, bounded by role |
| `POST /entitlements/{id}/freeze {from, until}`, `POST /entitlements/{id}/unfreeze` | Freeze and unfreeze |
| `POST /entitlements/{id}/cancel {at: period_end \| now}` | Cancel a membership or pack (§3A.15). Member for their own; manager |
| `POST /refunds {booking_id, amount, reason}` | Creates a `refund` proposal (partial refunds) |

### Staff operations
| Endpoint | Purpose |
|---|---|
| `GET /assignments?resource_id=&from=&to=` | My shifts and classes, each with `source` |
| `POST /assignments`, `DELETE /assignments/{id}` | Manager edits (validated, §8.5) |
| `POST /rosters/solve {kind, scope, horizon}` → `202 {job_id}`, `GET /rosters/jobs/{id}` | Solver jobs |
| `GET /proposals?state=`, `POST /proposals`, `GET /proposals/{id}`, `POST /proposals/{id}/ops` (`If-Match`), `POST /proposals/{id}/approve`, `/reject` | Proposals |
| `POST /swaps`, `POST /swaps/{id}/accept`, `/approve`, `/reject`, `/withdraw` | Swaps (§3A.11.4) |
| `GET /desk/now?location=` | Who is on the desk now and next |
| `GET`/`POST /tasks`, `POST /tasks/{id}/complete` | Desk checklists and manager inbox |
| `GET /hours?from=&to=&resource_id=`, `PATCH /hours/{id} {actual_start?, actual_end?, state?: voided, void_reason?}`, `POST /hours/{id}/approve` | Hours, corrections before export, and approvals (§3A.16). Manager |
| `POST /exports/hours {period_start, period_end}` → `{export_id, version, summary}`; `GET /exports/hours/{id}`; `GET /exports/hours/{id}/files/{employees\|contractors}` (signed CSV URL, 24 h); `POST /exports/hours/{id}/mark-submitted`; `GET /exports/hours/{id}/corrections.csv`; `POST /exports/hours/{id}/corrections/{c}/done` | Gusto CSV export (§18.8). Manager or owner; downloads are audited |
| `POST /time-clock/punches` | Time clock (later phase) |

### Agents, sync, flags, events, audit, tenant
| Endpoint | Purpose |
|---|---|
| `POST /agents/clients {agent, allowlist}`, `DELETE /agents/clients/{id}` | Register or revoke agent clients (owner) |
| `POST /events/custom {name, data}` | Custom events (agent-scoped names only) |
| `GET /sync/domains`, `POST /sync/domains/{d}/mode {mode, outbound_push}` → creates a `domain_mode` proposal | Domain modes. Owner proposes; a **different** owner or admin approves through `POST /proposals/{id}/approve` (two-person rule, §18.7) |
| `POST /sync/domains/{d}/reconcile {window}`, `GET /sync/drift`, `POST /sync/drift/{id}/resolve` | Drift |
| `GET /sync/person-mappings?state=unmatched`, `PUT /sync/person-mappings/{system}/{external_id} {resource_id}` | Person mapping (manager) |
| `GET /sync/shadow-disagreements`, `PATCH …/{id}` | Shadow triage |
| `POST /sync/inbound/{system}` | Outside events, delivered by the gateway (signed) |
| `GET`/`PUT /flags/{key}` | Feature flags |
| `POST /subscriptions {events[], target_service}` | Typed event delivery to other services |
| `GET /audit?target=&actor=&from=` | Audit log |
| `POST /tenant/offboard {mode: hand_back \| close}` → creates a `tenant_offboard` proposal; `GET /tenant/exports/{id}` | Tenant offboarding. Two-person rule, as for domain modes |
| `GET /tenant/status` | Onboarding checklist and go-live state |

## 11.4 Example: hold and confirm

```http
POST /v1/t/lotus/production/holds
Authorization: Bearer <member JWT>
Idempotency-Key: 7c1e…
{ "session_id": "ses_01JB…", "place_id": "plc_01JB…mat12" }

201 Created
{ "hold_id": "hld_01JB…", "expires_at": "2027-03-08T15:05:00Z",
  "place": { "id": "plc_01JB…mat12", "label": "Mat 12", "attributes": { "by_wall": true, "front_row": false } },
  "quote": { "payment": "units", "unit": "class_credit", "amount": 1, "entitlement_id": "ent_01J…",
             "terms": { "free_cancel_until": "2027-03-09T00:00:00Z", "late": "credit forfeited",
                        "no_show": "credit forfeited, $15 fee for memberships" }, "approval_required": false },
  "decision_id": "dec_01JB…" }

409 Conflict (the other member)
{ "code": "PLACE_TAKEN", "title": "That mat was just taken", "decision_id": "dec_01JB…",
  "alternatives": [{ "place_id": "plc_…mat18", "label": "Mat 18" }, { "place_id": "plc_…mat24", "label": "Mat 24" }] }
```

## 11.5 Multi-tenancy

- Each tenant has one database per environment, resolved through the control-plane registry before any query runs.
- Tokens carry `tid` and `env`.
- Caches, Durable Object names and logs are keyed or tagged by tenant and environment (§13.1, §19.1).

## 11.6 Confirmations

When an agent requests an action with money or penalty consequences, the API returns a `confirmation`. It is single-use and bound to the exact action and terms:

```json
{ "token": "cnf_…", "expires_at": "…", "binds": { "action": "cancel", "booking_id": "bkg_…", "penalty": {…}, "terms_hash": "…" },
  "summary": "Cancel Tue 18:30 Vinyasa. It's within 12 hours, so a $10 late fee applies unless your mat is re-booked." }
```

Only a member token for the same customer can redeem it. In chat, that is a confirm card. In email or SMS, it is a signed link to a confirm page. If any bound fact changes before redemption, it fails with `CONFIRMATION_STALE`.

## 11.7 Events to other services

Kairos publishes typed domain events (§9.2) to subscribing services through the outbox, at least once, each with an `event_id`. Each event has a versioned JSON Schema in `packages/contracts`. No service reads Kairos's database.
