# 12. Data storage

## 12.1 Services and their data

Each service owns its data. No service reads another service's database (D-05).

| Service | Runtime | Data | Owns |
|---|---|---|---|
| `kairos-core` | Worker `kairos-api` + DO `TenantCore` (§19.1) | one SQLite DB per tenant per environment (the `TenantCore` object's storage); SessionGate queues and the scheduler alarm live in the same object | config, resources, sessions, assignments, claims, occupancy, places, holds, bookings, waitlists, offers, entitlements, ledger, proposals, tasks, hours, workflows, outbox, decisions, audit, flags, domain modes, `external_ref`, `person_mapping` |
| `kairos-sync` | DO `TenantSync` | SQLite DB per tenant per environment | adapter cursors, raw outside snapshots, drift items, shadow disagreements, code mapping tables, `inbound_event` dedupe |
| `kairos-agent` | DO `TenantAgent` | SQLite DB per tenant per environment | agent sessions, hook runs, transcripts (30 days), eval results |
| `kairos-solver` | Cloudflare Container | stateless; job payloads kept 7 days in R2 | — |
| simulations | DO `SimulationRun`, one per run (§19.10) | throwaway SQLite, deleted at the end of the run | — |
| control plane | DO `ControlPlane` | one SQLite DB per environment | tenant registry, database bindings, key references, tenant lifecycle state |

`kairos-sync` writes mirrored records **through `kairos-core`'s internal typed API**, the RPC method `TenantCore.mirrorApply()` (§19.1). Mirrored claims therefore pass the same occupancy constraints as owned ones (I-17).

LLM provider calls are outside calls, so they go through the gateway.

## 12.2 The transaction (formerly "guarded batch")

Each tenant database is the SQLite storage of the tenant's `TenantCore` Durable Object (§19.1, D-61). Writes are single-threaded per object, and `transactionSync` is atomic (A-01). The spec still calls one atomic write a **batch**. A batch is exactly one `transactionSync` callback (§19.2):

1. **Read.** Query the facts the engine needs.
2. **Decide.** Run pure engine code.
3. **Check and write**, in the same callback:
   - the writes;
   - the **checks**, as code: each reads the rows it needs and throws a tagged error (`PlaceTaken`, `HoldExpired`, …) when the condition is false. A throw rolls the whole transaction back;
   - the database guards, kept as the last line of defence: unique keys, partial unique indexes and CHECK constraints;
   - the audit row, domain events and outbox rows (I-29).
4. **Map failures.** A tagged error is its reason code. A constraint violation is mapped to the same reason code as the matching check, for example the `place_claim` primary key to `PLACE_TAKEN`, or the `occupancy` primary key to `RESOURCE_CONFLICT`.

There is no read-to-write gap inside a batch, so there are no contention retries. A batch never spans an `await`. A command that needs an outside answer (the gateway, the solver, another object) commits in a **second** batch that re-reads and re-decides (§19.2). `version` columns remain for checks that cross an `await` or a client round trip: `If-Match` (§11.2), proposal snapshots (`resource_day`, §8.5) and the commit half of a two-part command. If one of those fails and re-validation also fails, the result is `STALE_VERSION`.

```sql
CREATE TABLE lanes (y INTEGER PRIMARY KEY);                       -- seeded 0..15
```

A batch must finish within 50 ms of CPU and write at most about 500 rows (A-06). Larger work uses sagas (§8.7) or idempotent chunks (§6.8). A CI lint rule rejects any `await`, `Gateway` or `Rpc` use inside a transaction body (§19.2).

## 12.3 Occupancy: the shared calendar

```sql
CREATE TABLE claim (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, owner_type TEXT NOT NULL CHECK (owner_type IN ('assignment','block')),
  owner_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  occ_start INTEGER NOT NULL, occ_end INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('exclusive','lane')),
  domain TEXT NOT NULL CHECK (domain IN ('classes','shifts','blocks')),
  source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  state TEXT NOT NULL CHECK (state IN ('active','conflicted','released')),
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (occ_start < occ_end AND occ_start % 300000 = 0 AND occ_end % 300000 = 0));
CREATE INDEX claim_resource_time ON claim(resource_id, occ_start) WHERE state != 'released';

CREATE TABLE occupancy (resource_id TEXT NOT NULL, grain INTEGER NOT NULL, lane INTEGER NOT NULL,
  claim_id TEXT NOT NULL, PRIMARY KEY (resource_id, grain, lane)) WITHOUT ROWID;   -- ← never two claims on one lane-grain
CREATE INDEX occupancy_claim ON occupancy(claim_id);

CREATE TABLE resource_day (resource_id TEXT NOT NULL, day TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, day)) WITHOUT ROWID;   -- bumped by every batch that changes the person-day (§8.5)
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
  reserved_for TEXT CHECK (reserved_for IN ('waitlist')), reserved_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL, UNIQUE (session_id, place_no), UNIQUE (session_id, spot_resource_id));
CREATE TABLE place_claim (session_id TEXT NOT NULL, place_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('hold','booking')),
  holder_id TEXT NOT NULL, customer_id TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (session_id, place_id), CHECK ((kind = 'hold') = (expires_at IS NOT NULL))) WITHOUT ROWID;
CREATE INDEX place_claim_customer ON place_claim(customer_id);
CREATE INDEX place_claim_expiry ON place_claim(expires_at) WHERE kind = 'hold';
CREATE TABLE offer (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('place','substitute')), session_id TEXT NOT NULL,
  waitlist_entry_id TEXT, requirement_key TEXT, customer_id TEXT, resource_id TEXT, state TEXT NOT NULL,
  expires_at INTEGER NOT NULL, reply_text TEXT, hold_id TEXT, proposal_id TEXT, end_reason TEXT,
  created_by TEXT NOT NULL, run_id TEXT,
  CHECK (state IN ('sent','accepted','declined','expired','withdrawn','lapsed')),
  CHECK ((customer_id IS NULL) != (resource_id IS NULL)));   -- Offer.recipient (§3.8)
CREATE INDEX offer_open ON offer(session_id, state, expires_at);
CREATE UNIQUE INDEX offer_one_open_substitute ON offer(session_id, requirement_key, resource_id)
  WHERE kind = 'substitute' AND state = 'sent';
CREATE UNIQUE INDEX offer_one_accepted_substitute ON offer(session_id, requirement_key)
  WHERE kind = 'substitute' AND state = 'accepted';                 -- ← one live acceptance per slot (D-57)
CREATE UNIQUE INDEX offer_one_open_place ON offer(waitlist_entry_id)
  WHERE kind = 'place' AND state IN ('sent','accepted');
```

**Hold expiry.** `TenantCore`'s scheduler sets its alarm to the earliest hold expiry, and wakes at least once a minute while work is pending (§19.5). Each tick finds expired holds with:

```sql
SELECT session_id, place_id, holder_id FROM place_claim WHERE kind = 'hold' AND expires_at <= :now LIMIT 200
```

and releases them **one session per batch** through `release_place` (§7.7). Each batch deletes the place claim (checked on holder and expiry), marks the hold `expired`, sets `reserved_for` and `reserved_at` if the waitlist has waiting entries, and emits `place.released`.

**Substitute accept.** The accept batch updates the offer to `accepted` (the partial unique index rejects a second acceptance for the slot), inserts the proposal, and withdraws the other open offers. A proposal that fails, is rejected or expires sets its offer to `lapsed` in the same batch, which frees the index for the next acceptance (§3A.14).

The same tick runs promotion for places whose `reserved_at` is more than 30 s ago. The tick may never free places with a bare `DELETE`, because that would bypass waitlist priority. Holds claim only places, never occupancy (there are no on-demand bookings in v2.0), so an expired hold can never block a teacher or a room.

## 12.5 Bookings, counters, ledger

```sql
CREATE TABLE booking (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_id TEXT, customer_id TEXT NOT NULL,
  session_start INTEGER NOT NULL, state TEXT NOT NULL, payment TEXT NOT NULL, terms TEXT NOT NULL, group_id TEXT,
  booked_via TEXT NOT NULL, config_version INTEGER NOT NULL,
  decision_id TEXT NOT NULL, source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX booking_one_active ON booking(session_id, customer_id)
  WHERE state IN ('pending_approval','confirmed','checked_in') AND group_id IS NULL;
CREATE INDEX booking_customer ON booking(customer_id, session_start);
CREATE INDEX booking_session ON booking(session_id, state);

CREATE TABLE customer_strike (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('late_cancel','no_show')), at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT,
  UNIQUE (booking_id, kind));
CREATE INDEX customer_strike_window ON customer_strike(customer_id, at) WHERE removed_at IS NULL;

CREATE TABLE limit_counter (key TEXT PRIMARY KEY, count INTEGER NOT NULL, max INTEGER NOT NULL, window_end INTEGER NOT NULL,
  CHECK (count >= 0 AND count <= max)) WITHOUT ROWID;
CREATE TABLE entitlement_balance (entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, balance INTEGER, period_start INTEGER,
  version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entitlement_id, unit),
  CHECK (balance IS NULL OR balance >= 0)) WITHOUT ROWID;     -- hundredths of a unit; NULL = unlimited
CREATE TABLE ledger (id TEXT PRIMARY KEY, entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, booking_id TEXT, reason TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE);
CREATE INDEX ledger_ent ON ledger(entitlement_id, at);
```

**Counter key formats:**
- `lim:<policy>:<limit>:<customer>:<window_start_local_date>`, or `…:upcoming` for the upcoming window
- `cap:<entitlement>:<cap>:<window_start>`

**Counter lifecycle.** A counter is incremented in the batch that confirms (or puts into `pending_approval`) a counted booking. It is decremented in the batch that moves that booking to `cancelled`, `late_cancelled` or `rejected`. An `upcoming` counter is also decremented at session start, by the start timer (§3A.9.6), so it counts only classes that haven't started. Day, week and month counters are never decremented by time; they expire at `window_end`.

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

`resource`, `resource_skill`, `resource_role`, `availability_record`, `time_off`, `customer` (encrypted PII columns, blind indexes), `customer_history`, `session` (`UNIQUE(occurrence_key)`, `(location_key, start_at)`, `(status, start_at)`; columns `cancel_reason`, `over_capacity`), `assignment` (`(resource_id, session_id)`, `(session_id, requirement_key)`), `hold`, `waitlist_entry` (`UNIQUE(session_id, position)`, plus a partial unique `(session_id, customer_id) WHERE state IN ('waiting','offered')`; column `end_reason`), `check_in` (`UNIQUE(client_key)`), `entitlement`, `proposal`, `swap_request`, `task`, `hours_record` (partial unique `(assignment_id) WHERE state != 'voided'`, I-28b; columns `void_reason`, `pay_protected`, `final`), `resource_block`, `decision`, `config_version`, `config_draft`, `domain_mode`, `flag`, `external_ref`, `person_mapping` (`PRIMARY KEY(system, external_person_id)`), `agent_client`, `idempotency`.

```sql
CREATE TABLE saga (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT, step INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('running','done','parked','compensating','failed')),
  lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX saga_due ON saga(state, lease_until);
```

Each saga step's batch checks `saga.step` and advances it in the same transaction, so a step can't run twice (§3A.1 C6). Kinds: `closure`, `session_cancel_bookings`, `session_edit`, `roster_commit`, `customer_merge`, `customer_close`, `tenant_close`, `offboard`, `config_post_activation`, `domain_switch`.

## 12.8 Concurrency control summary

| Hazard | Mechanism |
|---|---|
| A person, room or desk lane double-claimed, from any domain or source | `occupancy` primary key |
| Two members on one mat | `place_claim` primary key |
| A waitlisted member bypassed by a new booker | `place.reserved_for`, set by `release_place` on every freeing path, plus the hold check (§7.5.2); promotion from the scheduler tick if the alarm is late |
| Double booking by one member | partial unique index on `booking` |
| Over-spending credits | CHECK `balance >= 0` |
| Exceeding a limit or cap | `limit_counter` CHECK |
| Rest, transfer or max-hours rules broken by concurrent writes | single-writer transaction; `resource_day.version` for proposals built from an older snapshot (§8.5) |
| Concurrent proposal edits | `If-Match` on `proposal.version` |
| Two writes to one tenant interleaving | impossible inside a transaction (single-writer object); across an `await`, re-read and re-decide (§19.2) |
| Audit chain forks | single-writer object; `prev_hash` read and written in the same transaction (§19.2) |
| Booking-rush fairness | SessionGate queue inside `TenantCore` (§19.3) |
| Lost hold expiry | upsert over expired row + scheduler alarm (≤ 60 s) + 5-minute backstop cron (§19.5) |
| Duplicate side effects | `UNIQUE` idempotency keys (runs, actions, outbox, ledger, check-ins, inbound events) |
| Two substitutes accepted for one slot | partial unique index `offer_one_accepted_substitute` |
| A saga step applied twice | `saga.step` check in the step's transaction |
| Stale config | `config_epoch` read on every request |

## 12.9 Volume, retention, migrations, backups

- **Volume** (reference tenant, per year): about 16k sessions, 400k bookings, 1M occupancy rows created (and pruned), 2M events and 3M audit rows. That is a few GB per tenant database. A Durable Object's SQLite storage is capped at 10 GB, so pruning and archiving to R2 are required (§19.7).
- **Pruning:**

  | Data | Kept for |
  |---|---|
  | Occupancy | 7 days after its grain |
  | Domain events | 90 days |
  | Decision traces | 400 days (archived to R2, §19.7) |
  | Audit log | 7 years; segments older than 90 days are archived to a locked R2 bucket (still hash-chained, §19.7) |

- **Schema migrations:** numbered SQL files in `packages/db/migrations`, applied by each object in its constructor before it serves a request (§19.8), as **expand → migrate → contract**. Code supports schema versions N and N−1. Preview databases migrate first, then production after a 24 h soak.
- **Backups:** Durable Object point-in-time restore (30 days, per object, so per tenant), plus a nightly logical export to R2 that is copied to S3-compatible storage at a second provider (§19.9). Restore drills run quarterly. The engine release process is in §13.10.
