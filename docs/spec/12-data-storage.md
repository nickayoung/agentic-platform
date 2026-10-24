# 12. Data storage

## 12.1 Services and their data

Each service owns its data. No service reads another service's database (D-05).

| Service | Runtime | Data | Owns |
|---|---|---|---|
| `kairos-core` | edge functions | one SQLite DB per tenant per environment; per-object stores (SessionGate per class, TimerObject per tenant-env) | config, resources, sessions, assignments, claims, occupancy, places, holds, bookings, waitlists, offers, entitlements, ledger, proposals, tasks, hours, workflows, outbox, decisions, audit, flags, domain modes, `external_ref`, `person_mapping` |
| `kairos-sync` | edge functions | SQLite DB per tenant per environment | adapter cursors, raw outside snapshots, drift items, shadow disagreements, code mapping tables, `inbound_event` dedupe |
| `kairos-agent` | edge functions | SQLite DB per tenant per environment | agent sessions, hook runs, transcripts (30 days), eval results |
| `kairos-worker` | container | stateless; job payloads kept 7 days in object storage | — |
| control plane | edge function | one SQLite DB | tenant registry, database bindings, key references, tenant lifecycle state |

`kairos-sync` writes mirrored records **through `kairos-core`'s internal typed API** (`POST /internal/mirror/apply`). Mirrored claims therefore pass the same occupancy constraints as owned ones (I-17).

LLM provider calls are outside calls, so they go through the gateway.

## 12.2 The guarded batch

The database accepts atomic batches: either every statement applies or none does (A-01). Interactive transactions are not assumed. Every write therefore follows the same steps:

1. **Read.** Query the facts the engine needs, plus the `version` of every row or resource-day the decision depends on.
2. **Decide.** Run pure engine code.
3. **Write one batch** that contains:
   - the writes;
   - the guards:
     - unique keys;
     - CHECK constraints;
     - **version guards with a batch token**: `UPDATE t SET version = version + 1, last_batch = :batch_id WHERE id = ? AND version = ?`, followed by an assert that reads `last_batch`;
     - **assert rows**, always written as `INSERT INTO batch_assert(ok) VALUES ((<scalar subquery>))`. Because of the `VALUES` form, the insert always writes exactly one row, and `ok` is NULL or 0 when the condition is false. `INSERT … SELECT … WHERE` is **forbidden** for asserts, because it inserts zero rows, and so passes silently, when nothing matches;
   - `DELETE FROM batch_assert` as the last statement.
4. **Map failures.** A unique-key violation becomes a conflict reason. An assert or version failure triggers a retry, up to 3 times with jitter, then `STALE_VERSION`.

```sql
CREATE TABLE batch_assert (ok INTEGER NOT NULL CHECK (ok = 1));   -- NULL or 0 aborts the batch
CREATE TABLE lanes (y INTEGER PRIMARY KEY);                       -- seeded 0..15
```

Every table with a version guard has a `last_batch TEXT` column. A batch holds at most 100 statements and 1 MB (A-06). Larger work uses sagas (§8.7) or idempotent chunks (§6.8).

A CI lint rule checks every SQL string under `packages/db/**`. An `INSERT INTO batch_assert` that is not followed by `VALUES ((` fails the build.

## 12.3 Occupancy: the shared calendar

```sql
CREATE TABLE claim (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, owner_type TEXT NOT NULL CHECK (owner_type IN ('assignment','block')),
  owner_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  occ_start INTEGER NOT NULL, occ_end INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('exclusive','lane')),
  domain TEXT NOT NULL CHECK (domain IN ('classes','shifts','blocks')),
  source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  state TEXT NOT NULL CHECK (state IN ('active','conflicted','released')),
  version INTEGER NOT NULL DEFAULT 1, last_batch TEXT,
  CHECK (occ_start < occ_end AND occ_start % 300000 = 0 AND occ_end % 300000 = 0));
CREATE INDEX claim_resource_time ON claim(resource_id, occ_start) WHERE state != 'released';

CREATE TABLE occupancy (resource_id TEXT NOT NULL, grain INTEGER NOT NULL, lane INTEGER NOT NULL,
  claim_id TEXT NOT NULL, PRIMARY KEY (resource_id, grain, lane)) WITHOUT ROWID;   -- ← never two claims on one lane-grain
CREATE INDEX occupancy_claim ON occupancy(claim_id);

CREATE TABLE resource_day (resource_id TEXT NOT NULL, day TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  last_batch TEXT, PRIMARY KEY (resource_id, day)) WITHOUT ROWID;
```

**Exclusive claim** (a teacher, a room, or a desk worker as a person):

```sql
INSERT INTO occupancy (resource_id, grain, lane, claim_id)
WITH RECURSIVE g(x) AS (SELECT :g0 UNION ALL SELECT x + 1 FROM g WHERE x + 1 < :g1)
SELECT :resource, g.x, lanes.y, :claim FROM g JOIN lanes ON lanes.y < :concurrency;
-- any existing row → PRIMARY KEY violation → the whole batch aborts (RESOURCE_CONFLICT)
```

**Lane claim** (one of the front desk's lanes):

```sql
INSERT INTO occupancy (resource_id, grain, lane, claim_id)
WITH RECURSIVE g(x) AS (SELECT :g0 UNION ALL SELECT x + 1 FROM g WHERE x + 1 < :g1)
SELECT :resource, g.x,
  (SELECT min(l.y) FROM lanes l WHERE l.y < :concurrency AND NOT EXISTS
     (SELECT 1 FROM occupancy o WHERE o.resource_id = :resource AND o.grain = g.x AND o.lane = l.y)),
  :claim
FROM g;      -- a NULL lane violates NOT NULL → abort
```

**Mirror ingestion.** This is the same insert, but each row is written with `ON CONFLICT DO NOTHING`. The next statement in the batch sets the claim's state:

```sql
UPDATE claim SET state = CASE
    WHEN (SELECT count(*) FROM occupancy WHERE claim_id = :claim) = :expected_rows THEN 'active' ELSE 'conflicted' END
WHERE id = :claim;
```

A `conflicted` result raises a `cross_domain_conflict` drift item through the outbox to `kairos-sync`.

**Release and re-home.** When a claim is released, one batch does the following:
1. Deletes the claim's occupancy rows and sets the claim to `released`.
2. For each conflicted claim on the same resource that overlaps the freed range, in `occ_start` order, tries again to insert its missing grains:

   ```sql
   INSERT INTO occupancy (resource_id, grain, lane, claim_id)
   WITH RECURSIVE g(x) AS (SELECT :c_g0 UNION ALL SELECT x + 1 FROM g WHERE x + 1 < :c_g1)
   SELECT :resource, g.x, lanes.y, :conflicted_claim FROM g JOIN lanes ON lanes.y < :concurrency
   WHERE true ON CONFLICT DO NOTHING;
   ```

3. Applies the same state `UPDATE` as above. A claim that is now complete becomes `active`.
4. Resolves the claim's drift item through the outbox.

**Why this enforces "no desk shift during a class you teach".** The teaching claim and the desk-worker claim are both **exclusive claims on the same person resource**, in the same table and the same database. This holds whatever their domain or source. Whichever claim is written second cannot insert its rows. If the second one is an owned desk shift, its batch aborts. If it is a mirrored class, it is stored `conflicted`, its time stays fully blocked, and managers are alerted. Appendix A.5 walks through both orders.

## 12.4 Places, holds, offers

```sql
CREATE TABLE place (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_no INTEGER NOT NULL, spot_resource_id TEXT,
  label TEXT NOT NULL, partition_key TEXT NOT NULL DEFAULT 'general', released_to TEXT, released_at INTEGER,
  reserved_for TEXT CHECK (reserved_for IN ('waitlist')), disabled INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL, UNIQUE (session_id, place_no), UNIQUE (session_id, spot_resource_id));
CREATE TABLE place_claim (session_id TEXT NOT NULL, place_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('hold','booking')),
  holder_id TEXT NOT NULL, customer_id TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (session_id, place_id), CHECK ((kind = 'hold') = (expires_at IS NOT NULL))) WITHOUT ROWID;
CREATE INDEX place_claim_customer ON place_claim(customer_id);
CREATE INDEX place_claim_expiry ON place_claim(expires_at) WHERE kind = 'hold';
CREATE TABLE offer (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('place','substitute')), session_id TEXT NOT NULL,
  waitlist_entry_id TEXT, requirement_key TEXT, customer_id TEXT, resource_id TEXT, state TEXT NOT NULL,
  expires_at INTEGER NOT NULL, reply_text TEXT, created_by TEXT NOT NULL, run_id TEXT,
  CHECK ((customer_id IS NULL) != (resource_id IS NULL)));
CREATE INDEX offer_open ON offer(session_id, state, expires_at);
CREATE UNIQUE INDEX offer_one_open_substitute ON offer(session_id, requirement_key, resource_id) WHERE state = 'sent';
```

**Hold expiry.** The SessionGate alarm releases each hold when it expires. A sweep also runs every minute:

```sql
DELETE FROM place_claim WHERE kind = 'hold' AND expires_at <= :now
```

The sweep then marks those holds `expired` and emits `place.released` for them. Holds claim only places, never occupancy (there are no on-demand bookings in v2.0), so an expired hold can never block a teacher or a room.

## 12.5 Bookings, counters, ledger

```sql
CREATE TABLE booking (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_id TEXT, customer_id TEXT NOT NULL,
  session_start INTEGER NOT NULL, state TEXT NOT NULL, payment TEXT NOT NULL, terms TEXT NOT NULL, group_id TEXT,
  place_refilled INTEGER NOT NULL DEFAULT 0, booked_via TEXT NOT NULL, config_version INTEGER NOT NULL,
  decision_id TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, last_batch TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX booking_one_active ON booking(session_id, customer_id)
  WHERE state IN ('pending_approval','confirmed','checked_in') AND group_id IS NULL;
CREATE INDEX booking_customer ON booking(customer_id, session_start);
CREATE INDEX booking_session ON booking(session_id, state);

CREATE TABLE limit_counter (key TEXT PRIMARY KEY, count INTEGER NOT NULL, max INTEGER NOT NULL, window_end INTEGER NOT NULL,
  CHECK (count >= 0 AND count <= max)) WITHOUT ROWID;
CREATE TABLE entitlement_balance (entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, balance INTEGER, period_start INTEGER,
  version INTEGER NOT NULL DEFAULT 1, last_batch TEXT, PRIMARY KEY (entitlement_id, unit),
  CHECK (balance IS NULL OR balance >= 0)) WITHOUT ROWID;     -- hundredths of a unit; NULL = unlimited
CREATE TABLE ledger (id TEXT PRIMARY KEY, entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, booking_id TEXT, reason TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE);
CREATE INDEX ledger_ent ON ledger(entitlement_id, at);
```

**Counter key formats:**
- `lim:<policy>:<limit>:<customer>:<window_start_local_date>`, or `…:upcoming` for the upcoming window
- `cap:<entitlement>:<cap>:<window_start>`

**Nightly reconciliation.** Every counter and every balance is recomputed from bookings and the ledger. Any mismatch is corrected and raises an alert.

## 12.6 Events, workflows, outbox, audit

```sql
CREATE TABLE domain_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  subject_type TEXT, subject_id TEXT, reason TEXT, data TEXT NOT NULL, causation_depth INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workflow_run (run_key TEXT PRIMARY KEY, workflow_key TEXT, workflow_hash TEXT, subject_id TEXT,
  state TEXT, created_at INTEGER) WITHOUT ROWID;
CREATE TABLE scheduled_action (action_key TEXT PRIMARY KEY, run_key TEXT, fire_at INTEGER NOT NULL, state TEXT NOT NULL,
  lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT) WITHOUT ROWID;
CREATE INDEX scheduled_due ON scheduled_action(state, fire_at);
CREATE TABLE outbox (id TEXT PRIMARY KEY, topic TEXT NOT NULL, target TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);
CREATE TABLE audit (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at INTEGER, actor TEXT, action TEXT, target_type TEXT,
  target_id TEXT, before_hash TEXT, after TEXT, request_id TEXT, config_version INTEGER, prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL);
```

`kairos-sync` deduplicates inbound outside events with `inbound_event(system, event_id, received_at, PRIMARY KEY(system, event_id))`, kept for 7 days. A duplicate webhook is acknowledged with `200` and then dropped.

## 12.7 Other core tables

`resource`, `resource_skill`, `resource_role`, `availability_record`, `time_off`, `customer` (encrypted PII columns, blind indexes), `customer_history`, `session` (`UNIQUE(occurrence_key)`, `(location_key, start_at)`, `(status, start_at)`), `assignment` (`(resource_id, session_id)`, `(session_id, requirement_key)`), `hold`, `waitlist_entry` (`UNIQUE(session_id, position)`, plus a partial unique `(session_id, customer_id) WHERE state IN ('waiting','offered')`), `check_in` (`UNIQUE(client_key)`), `entitlement`, `proposal`, `swap_request`, `task`, `hours_record`, `resource_block`, `decision`, `config_version`, `config_draft`, `domain_mode`, `flag`, `external_ref`, `person_mapping` (`PRIMARY KEY(system, external_person_id)`), `agent_client`, `idempotency`.

## 12.8 Concurrency control summary

| Hazard | Mechanism |
|---|---|
| A person, room or desk lane double-claimed, from any domain or source | `occupancy` primary key |
| Two members on one mat | `place_claim` primary key |
| A waitlisted member bypassed by a new booker | `place.reserved_for` + hold assert (§7.5.2) |
| Double booking by one member | partial unique index on `booking` |
| Over-spending credits | CHECK `balance >= 0` |
| Exceeding a limit or cap | `limit_counter` CHECK |
| Rest, transfer or max-hours rules broken by concurrent writes | `resource_day` version + `last_batch` assert |
| Concurrent proposal edits | `If-Match` on `proposal.version` |
| Booking-rush fairness | SessionGate |
| Lost hold expiry | upsert over expired row + alarm + 1-minute sweep |
| Duplicate side effects | `UNIQUE` idempotency keys (runs, actions, outbox, ledger, check-ins, inbound events) |
| Stale config | `config_epoch` read on every request |

## 12.9 Volume, retention, migrations, backups

- **Volume** (reference tenant, per year): about 16k sessions, 400k bookings, 1M occupancy rows created (and pruned), 2M events and 3M audit rows. That is a few GB per tenant database.
- **Pruning:**

  | Data | Kept for |
  |---|---|
  | Occupancy | 7 days after its grain |
  | Domain events | 90 days |
  | Decision traces | 400 days |
  | Audit log | 7 years; segments older than 90 days are archived (still hash-chained) |

- **Schema migrations:** numbered SQL files in `packages/db/migrations`, applied by the migration runner per tenant database as **expand → migrate → contract**. Code supports schema versions N and N−1. Preview databases migrate first, then production after a 24 h soak.
- **Backups:** the provider's point-in-time restore (≥ 30 days), plus a nightly logical export to S3-compatible object storage at a second provider. Restore drills run quarterly. The engine release process is in §13.10.
