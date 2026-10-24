# 12. Data storage

## 12.1 Services and their data

Each service owns its data. No service reads another service's database (D-05). Services talk through typed HTTP contracts (`packages/contracts`) and events.

| Service | Runtime | Data store | Owns |
|---|---|---|---|
| `kairos-core` | edge functions | **one SQLite DB per tenant per environment**, plus per-object stores (SessionGate per session, TimerObject per tenant-env) | config versions, resources, sessions, assignments, claims, occupancy, places, holds, bookings, waitlists, entitlements, ledger, proposals, tasks, hours, workflow runs, scheduled actions, outbox, decisions, audit, flags, domain modes, `external_ref` |
| `kairos-sync` | edge functions | SQLite DB per tenant per env | adapter cursors, raw outside snapshots (hashes plus the last payload), drift items, shadow disagreements, mapping tables |
| `kairos-agent` | edge functions | SQLite DB per tenant per env | config-agent sessions, drafts in progress (mirrored into core on submit), hook runs, transcripts (retained 30 days), eval results |
| `kairos-worker` | container (solver + simulation) | none (stateless); job payloads in object storage for 7 days | — |
| control plane | edge function | one SQLite DB | tenant registry, database bindings, service keys (references to secrets), env routing |

`kairos-sync` writes mirrored records **through `kairos-core`'s internal typed API** (`POST /internal/mirror/apply`). So mirrored claims go through the same occupancy constraints (I-17) in the same database as owned claims. This is what makes cross-domain enforcement possible while domains are in different modes.

Calls to LLM providers are calls to outside systems, so they go **through the shared gateway** like any other (§18.3).

## 12.2 The guarded batch

The platform's databases are SQLite-compatible and accept **atomic batches** of statements: either all succeed or none apply. Interactive transactions (read, decide, write) are not assumed. Every write therefore follows this pattern:

1. **Read phase:** ordinary queries collect the facts the engine needs, plus the `version` of every row or resource-day the decision depends on.
2. **Decide:** pure engine code.
3. **Write phase:** one batch containing:
   - the writes;
   - **guards** that make the batch fail if any assumption from the read phase no longer holds:
     - unique keys (`occupancy`, `place_claim`, `booking` partial unique);
     - CHECK constraints (`balance >= 0`, `count <= max`);
     - version guards: `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`, followed by an assert row;
     - assert rows: `INSERT INTO batch_assert(ok) SELECT <bool expr>`, where `batch_assert.ok` has `CHECK (ok = 1)`;
   - `DELETE FROM batch_assert` as the last statement.
4. **On failure:** a unique violation maps to a conflict reason (`PLACE_TAKEN`, `RESOURCE_CONFLICT`, …), and a version or assert failure means a retry (up to 3 times with jitter, then `STALE_VERSION`).

```sql
CREATE TABLE batch_assert (ok INTEGER NOT NULL CHECK (ok = 1));
CREATE TABLE lanes (y INTEGER PRIMARY KEY);         -- seeded 0..63
```

Batch limit assumption: ≤ 100 statements and ≤ 1 MB per batch (A-06). Larger operations use sagas (§8.9) or idempotent chunks (§6.8).

## 12.3 Occupancy: the shared calendar, enforced by the database

```sql
CREATE TABLE claim (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('assignment','hold','block')),
  owner_id TEXT, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  occ_start INTEGER NOT NULL, occ_end INTEGER NOT NULL,          -- grain-aligned UTC ms
  mode TEXT NOT NULL CHECK (mode IN ('exclusive','lane')),
  domain TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  state TEXT NOT NULL CHECK (state IN ('active','conflicted','released')),
  expires_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
  CHECK (occ_start < occ_end AND occ_start % 300000 = 0 AND occ_end % 300000 = 0)
);
CREATE INDEX claim_resource_time ON claim(resource_id, occ_start) WHERE state != 'released';

CREATE TABLE occupancy (
  resource_id TEXT NOT NULL, grain INTEGER NOT NULL, lane INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY (resource_id, grain, lane)            -- ← no two claims on one lane-grain, ever
) WITHOUT ROWID;
CREATE INDEX occupancy_claim ON occupancy(claim_id);

CREATE TABLE resource_day (                         -- version rows for neighbour-dependent rules (§8.6)
  resource_id TEXT NOT NULL, day TEXT NOT NULL,     -- local date in the resource's zone
  version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (resource_id, day)
) WITHOUT ROWID;
```

**Exclusive claim** (a class's room, an instructor, a desk-shift worker): every lane of every grain.

```sql
INSERT INTO occupancy (resource_id, grain, lane, claim_id)
WITH RECURSIVE g(x) AS (SELECT :g0 UNION ALL SELECT x + 1 FROM g WHERE x + 1 < :g1)
SELECT :resource, g.x, lanes.y, :claim FROM g JOIN lanes ON lanes.y < :concurrency;
-- any existing row on (resource, grain, lane) → UNIQUE violation → the whole batch aborts
```

**Lane claim** (a PT session in a four-lane zone): the lowest free lane per grain. A `NULL` lane (none free) violates `NOT NULL`, which aborts the batch.

```sql
INSERT INTO occupancy (resource_id, grain, lane, claim_id)
WITH RECURSIVE g(x) AS (SELECT :g0 UNION ALL SELECT x + 1 FROM g WHERE x + 1 < :g1)
SELECT :resource, g.x,
       (SELECT min(l.y) FROM lanes l WHERE l.y < :concurrency
          AND NOT EXISTS (SELECT 1 FROM occupancy o WHERE o.resource_id = :resource
                          AND o.grain = g.x AND o.lane = l.y)),
       :claim
FROM g;
```

**Release:** `DELETE FROM occupancy WHERE claim_id = :claim` and `UPDATE claim SET state = 'released'`, in one batch. The same batch then **re-homes** conflicted mirrored claims that overlap the freed range:

```sql
INSERT INTO occupancy (resource_id, grain, lane, claim_id)
SELECT … FROM (missing grains of each conflicted claim on :resource overlapping the freed range)
ON CONFLICT DO NOTHING;
UPDATE claim SET state = 'active' WHERE id IN (…) AND (SELECT count(*) FROM occupancy WHERE claim_id = claim.id)
                                                    = ((occ_end - occ_start) / 300000) * <lanes per mode>;
```

**Mirror ingestion** (classes in mirror mode, §18.4): a mirrored class's instructor assignment is written as a claim with `source = 'mirror'`. The occupancy insert uses `ON CONFLICT DO NOTHING`. If fewer rows were inserted than expected, the claim is stored as `conflicted` and a `cross_domain_conflict` drift item is raised (I-18). Mirrored claims are never refused: the outside system is the record for that domain.

**Why this satisfies "a person who teaches at 9:00 cannot work the desk at 9:00":** the teaching claim (mirrored or owned) and the desk-shift claim (owned) are both exclusive claims on the **same `resource_id`** for the same grains. Whichever is written second cannot insert its occupancy rows. For an owned desk shift, that means the assignment batch aborts with `RESOURCE_CONFLICT`. The check does not depend on application code remembering to look across domains. Appendix A.6 walks through it.

## 12.4 Places and holds

```sql
CREATE TABLE place (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
  place_no INTEGER NOT NULL, spot_resource_id TEXT, label TEXT NOT NULL,
  partition_key TEXT NOT NULL DEFAULT 'general', released_to TEXT,
  released_at INTEGER,                              -- for FIFO refill ordering (§7.3)
  attributes TEXT NOT NULL,                         -- JSON
  UNIQUE (session_id, place_no), UNIQUE (session_id, spot_resource_id)
);
CREATE TABLE place_claim (
  session_id TEXT NOT NULL, place_id TEXT NOT NULL REFERENCES place(id),
  kind TEXT NOT NULL CHECK (kind IN ('hold','booking')),
  holder_id TEXT NOT NULL, customer_id TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (session_id, place_id),               -- ← one claimant per place
  CHECK ((kind = 'hold') = (expires_at IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX place_claim_customer ON place_claim(customer_id);
CREATE INDEX place_claim_expiry ON place_claim(expires_at) WHERE kind = 'hold';
```

The hold, confirm and release SQL is in §7.5.2–7.5.4.

## 12.5 Bookings, counters, ledger

```sql
CREATE TABLE booking (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_id TEXT, customer_id TEXT NOT NULL,
  session_start INTEGER NOT NULL,                   -- denormalised for account and limit queries
  state TEXT NOT NULL, payment TEXT NOT NULL, terms TEXT NOT NULL, group_id TEXT,
  place_refilled INTEGER NOT NULL DEFAULT 0, config_version INTEGER NOT NULL,
  decision_id TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX booking_one_active ON booking(session_id, customer_id)
  WHERE state IN ('pending_approval','confirmed','checked_in') AND group_id IS NULL;
CREATE INDEX booking_customer ON booking(customer_id, session_start);
CREATE INDEX booking_session ON booking(session_id, state);

CREATE TABLE limit_counter (                        -- booking limits and entitlement caps
  key TEXT PRIMARY KEY,         -- e.g. "lim:spin_policy:daily_max:cus_…:2026-11-03"
  count INTEGER NOT NULL, max INTEGER NOT NULL,     --      "cap:ent_…:two_a_day:2026-11-03"
  window_end INTEGER NOT NULL,                      --      "lim:…:upcoming:cus_…"   (no date part)
  CHECK (count >= 0 AND count <= max)
) WITHOUT ROWID;
-- increment: INSERT INTO limit_counter VALUES (:k, 1, :max, :end)
--            ON CONFLICT(key) DO UPDATE SET count = count + 1;   -- CHECK aborts at max

CREATE TABLE entitlement_balance (
  entitlement_id TEXT NOT NULL, unit TEXT NOT NULL,
  balance INTEGER,                                  -- NULL = unlimited
  period_start INTEGER, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entitlement_id, unit),
  CHECK (balance IS NULL OR balance >= 0)
) WITHOUT ROWID;
CREATE TABLE ledger (
  id TEXT PRIMARY KEY, entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, booking_id TEXT, reason TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX ledger_ent ON ledger(entitlement_id, at);
```

Units are stored as integers in **hundredths** (`1 credit = 100`), so fractional units (coworking room hours) are exact. Counters for `upcoming` limits are decremented when a booking is cancelled or completed. A nightly job reconciles every counter against the bookings it counts. Any mismatch is fixed and alerted.

## 12.6 Events, workflows, outbox, audit

```sql
CREATE TABLE domain_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, subject_type TEXT, subject_id TEXT, data TEXT NOT NULL,
  causation_depth INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0);
CREATE INDEX domain_event_pending ON domain_event(dispatched, seq);

CREATE TABLE workflow_run (run_key TEXT PRIMARY KEY, workflow_key TEXT, workflow_hash TEXT,
  subject_id TEXT, state TEXT, created_at INTEGER) WITHOUT ROWID;
CREATE TABLE scheduled_action (action_key TEXT PRIMARY KEY, run_key TEXT, fire_at INTEGER NOT NULL,
  state TEXT NOT NULL, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT) WITHOUT ROWID;
CREATE INDEX scheduled_due ON scheduled_action(state, fire_at);

CREATE TABLE outbox (id TEXT PRIMARY KEY, topic TEXT NOT NULL, target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);

CREATE TABLE audit (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at INTEGER, actor TEXT, action TEXT,
  target_type TEXT, target_id TEXT, before_hash TEXT, after TEXT, request_id TEXT,
  config_version INTEGER, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
```

The `outbox` dispatcher (alarm plus a 1-minute sweep) calls the gateway, the notification service, subscribing services and the solver worker, each with the row's idempotency key. It retries with exponential backoff up to 24 h, then marks the row `dead` and raises an alert.

## 12.7 Other core tables (outline)

`resource`, `resource_skill`, `resource_role`, `availability_record`, `time_off`, `customer` (PII columns encrypted, §13.3), `customer_history` (counts per tag and template, maintained in booking batches), `session` (`UNIQUE(occurrence_key)`, index `(location_key, start_at)`, `(start_at)`, `(status, start_at)`), `assignment` (index `(resource_id, session_id)`, `(session_id, requirement_key)`), `hold`, `waitlist_entry` (`UNIQUE(session_id, position)`, partial `UNIQUE(session_id, customer_id) WHERE state IN ('waiting','offered')`), `check_in`, `entitlement`, `proposal`, `swap_request`, `task`, `hours_record`, `decision`, `config_version`, `config_draft`, `domain_mode`, `flag`, `external_ref` (`UNIQUE(system, entity_type, external_id)`, `UNIQUE(entity_type, entity_id, system)`), `idempotency` (`key PRIMARY KEY`, response, expires_at).

## 12.8 Concurrency control summary

| Hazard | Mechanism | Layer |
|---|---|---|
| Two claims on a person, room or spot at the same time, from any domain | `occupancy` primary key | DB |
| Two customers on one place | `place_claim` primary key | DB |
| Double booking by one customer | partial unique index on `booking` | DB |
| Over-spending credits | `CHECK (balance >= 0)` | DB |
| Exceeding a booking limit or entitlement cap | `limit_counter` CHECK | DB |
| Rest, transfer and max-hours rules broken by concurrent assignments | `resource_day` version guards | DB (optimistic) |
| Fair ordering in a booking rush | SessionGate serialisation | per-object store |
| Lost hold expiry | Upsert-over-expired + alarm + sweep | DB + per-object store |
| Duplicate side effects | `UNIQUE` idempotency keys on runs, actions, outbox, ledger | DB |
| Stale config | `config_epoch` read with every request | DB |

## 12.9 Volume, retention, migrations, backups

- **Reference tenant estimate per year:** about 16k sessions, 400k bookings, 1.0M occupancy rows created (pruned), 2M domain events, 3M audit rows. That is well within a few GB per tenant database.
- **Pruning:** occupancy rows for grains older than 7 days are deleted (claims are kept). Domain events: 90 days. Decision traces: 400 days. Audit: 7 years, with segments older than 90 days archived to object storage, still hash-chained and verifiable.
- **Schema migrations:** numbered SQL migrations in `packages/db/migrations`, applied per tenant database by a migration runner (IaC pipeline) in **expand → migrate → contract** steps. Code always supports schema N and N−1. Preview databases migrate first, and production follows after a 24 h soak.
- **Backups:** the database provider's point-in-time restore (≥ 30 days), plus a nightly logical export to S3-compatible object storage at a second provider. Restore drills run quarterly per environment.
