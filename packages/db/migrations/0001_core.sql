-- 0001 core tables (§12). Phase 0 set; later phases add tables in new migrations (expand only, §19.8).
-- Times are UTC ms. JSON columns hold canonical JSON text.

CREATE TABLE lanes (y INTEGER PRIMARY KEY);
WITH RECURSIVE n(y) AS (SELECT 0 UNION ALL SELECT y + 1 FROM n WHERE y < 15) INSERT INTO lanes (y) SELECT y FROM n;

-- §3.3 config, modes, flags ---------------------------------------------------------------------------------

CREATE TABLE config_version (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, content_hash TEXT NOT NULL,
  document TEXT NOT NULL, compiled TEXT NOT NULL, parent_number INTEGER,
  published_at INTEGER NOT NULL, published_by TEXT NOT NULL, effective_from INTEGER NOT NULL,
  migration_plan_id TEXT, summary TEXT NOT NULL, rollback_of INTEGER,
  state TEXT NOT NULL CHECK (state IN ('staged','active','superseded')));
CREATE UNIQUE INDEX config_version_one_active ON config_version(state) WHERE state = 'active';   -- I-01

CREATE TABLE config_draft (
  id TEXT PRIMARY KEY, base_number INTEGER, document TEXT NOT NULL, patches TEXT NOT NULL DEFAULT '[]',
  validation TEXT, simulation TEXT, impact TEXT,
  state TEXT NOT NULL CHECK (state IN ('editing','validated','awaiting_approval','published','abandoned')),
  author TEXT NOT NULL, approved_by TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE domain_mode (
  domain TEXT PRIMARY KEY CHECK (domain IN ('classes','bookings','members','shifts')),   -- I-04
  mode TEXT NOT NULL CHECK (mode IN ('mirror','shadow','owner')),
  outside_system TEXT, outbound_push INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0,
  write_freeze INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (retired = 0 OR mode = 'owner'));

CREATE TABLE flag (
  key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, allow_locations TEXT, allow_roles TEXT,
  owner TEXT NOT NULL, remove_by TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1);

-- §3.4 resources ---------------------------------------------------------------------------------------------

CREATE TABLE resource (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('person','space','spot')),
  type_key TEXT NOT NULL, config_key TEXT, staff_key TEXT UNIQUE, name TEXT NOT NULL, parent_id TEXT REFERENCES resource(id),
  location_keys TEXT NOT NULL DEFAULT '[]', home_location_key TEXT, timezone TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]', roles TEXT NOT NULL DEFAULT '[]',
  concurrency INTEGER NOT NULL DEFAULT 1 CHECK (concurrency BETWEEN 1 AND 16),   -- I-08; lanes seeded 0..15
  layout_key TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','out_of_service','leaving','inactive')),
  leaves_at INTEGER, payroll_ref TEXT, payroll_type TEXT CHECK (payroll_type IN ('employee','contractor')),
  calendar_sync INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX resource_config_key ON resource(config_key) WHERE config_key IS NOT NULL;

CREATE TABLE resource_block (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id), start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  reason TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','released')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL);

-- §3.6 sessions and assignments --------------------------------------------------------------------------------

CREATE TABLE session (
  id TEXT PRIMARY KEY, template_key TEXT NOT NULL, series_key TEXT, occurrence_key TEXT UNIQUE,   -- I-11
  location_key TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','needs_staff','needs_resource','needs_mapping','cancelled','completed')),
  cancel_reason TEXT, capacity_total INTEGER NOT NULL DEFAULT 0, booked_count INTEGER NOT NULL DEFAULT 0,
  waitlist_count INTEGER NOT NULL DEFAULT 0, over_capacity INTEGER NOT NULL DEFAULT 0,
  exception TEXT, detached INTEGER NOT NULL DEFAULT 0, config_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (start_at < end_at AND start_at % 300000 = 0 AND end_at % 300000 = 0),   -- I-10
  CHECK (booked_count >= 0 AND waitlist_count >= 0));
CREATE INDEX session_location_start ON session(location_key, start_at);
CREATE INDEX session_status_start ON session(status, start_at);

CREATE TABLE assignment (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), requirement_key TEXT NOT NULL,
  resource_id TEXT REFERENCES resource(id),
  state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','released')),
  claim_id TEXT, assigned_by TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('platform','mirror')),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX assignment_resource_session ON assignment(resource_id, session_id);
CREATE INDEX assignment_session_requirement ON assignment(session_id, requirement_key);

-- §12.3 occupancy ---------------------------------------------------------------------------------------------

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
  claim_id TEXT NOT NULL, PRIMARY KEY (resource_id, grain, lane)) WITHOUT ROWID;
CREATE INDEX occupancy_claim ON occupancy(claim_id);

CREATE TABLE resource_day (resource_id TEXT NOT NULL, day TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, day)) WITHOUT ROWID;

-- §12.4 places, holds, offers ------------------------------------------------------------------------------------

CREATE TABLE place (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_no INTEGER NOT NULL, spot_resource_id TEXT,
  label TEXT NOT NULL, partition_key TEXT NOT NULL DEFAULT 'general', released_to TEXT, released_at INTEGER,
  reserved_for TEXT CHECK (reserved_for IN ('waitlist')), reserved_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL, UNIQUE (session_id, place_no), UNIQUE (session_id, spot_resource_id),
  CHECK ((reserved_for IS NULL) = (reserved_at IS NULL)));
CREATE INDEX place_reserved ON place(reserved_at) WHERE reserved_for IS NOT NULL;

CREATE TABLE place_claim (session_id TEXT NOT NULL, place_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('hold','booking')),
  holder_id TEXT NOT NULL, customer_id TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (session_id, place_id), CHECK ((kind = 'hold') = (expires_at IS NOT NULL))) WITHOUT ROWID;
CREATE INDEX place_claim_customer ON place_claim(customer_id);
CREATE INDEX place_claim_expiry ON place_claim(expires_at) WHERE kind = 'hold';

CREATE TABLE hold (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, place_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','converted','expired','released')),
  expires_at INTEGER NOT NULL, quote TEXT, offer_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE offer (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('place','substitute')), session_id TEXT NOT NULL,
  waitlist_entry_id TEXT, requirement_key TEXT, customer_id TEXT, resource_id TEXT, state TEXT NOT NULL,
  expires_at INTEGER NOT NULL, reply_text TEXT, hold_id TEXT, proposal_id TEXT, end_reason TEXT,
  created_by TEXT NOT NULL, run_id TEXT,
  CHECK (state IN ('sent','accepted','declined','expired','withdrawn','lapsed')),
  CHECK ((customer_id IS NULL) != (resource_id IS NULL)));
CREATE INDEX offer_open ON offer(session_id, state, expires_at);
CREATE UNIQUE INDEX offer_one_open_substitute ON offer(session_id, requirement_key, resource_id)
  WHERE kind = 'substitute' AND state = 'sent';
CREATE UNIQUE INDEX offer_one_accepted_substitute ON offer(session_id, requirement_key)
  WHERE kind = 'substitute' AND state = 'accepted';
CREATE UNIQUE INDEX offer_one_open_place ON offer(waitlist_entry_id)
  WHERE kind = 'place' AND state IN ('sent','accepted');

-- §12.5 bookings, counters, ledger ----------------------------------------------------------------------------

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
  CHECK (balance IS NULL OR balance >= 0)) WITHOUT ROWID;
CREATE TABLE ledger (id TEXT PRIMARY KEY, entitlement_id TEXT NOT NULL, unit TEXT NOT NULL, delta INTEGER NOT NULL,
  kind TEXT NOT NULL, booking_id TEXT, reason TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE);
CREATE INDEX ledger_ent ON ledger(entitlement_id, at);

-- §12.6 events, workflows, outbox, audit -------------------------------------------------------------------------

CREATE TABLE domain_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  subject_type TEXT, subject_id TEXT, reason TEXT, data TEXT NOT NULL, causation_depth INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0);
CREATE INDEX domain_event_undispatched ON domain_event(seq) WHERE dispatched = 0;
CREATE INDEX domain_event_at ON domain_event(at);
CREATE TABLE workflow_run (run_key TEXT PRIMARY KEY, workflow_key TEXT, workflow_hash TEXT, subject_id TEXT,
  state TEXT, created_at INTEGER) WITHOUT ROWID;
CREATE TABLE scheduled_action (action_key TEXT PRIMARY KEY, run_key TEXT, fire_at INTEGER NOT NULL, state TEXT NOT NULL,
  lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT) WITHOUT ROWID;
CREATE INDEX scheduled_due ON scheduled_action(state, fire_at);
CREATE TABLE outbox (id TEXT PRIMARY KEY, topic TEXT NOT NULL, target TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','leased','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 1,
  lease_until INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);
CREATE TABLE audit (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at INTEGER, actor TEXT, action TEXT, target_type TEXT,
  target_id TEXT, before_hash TEXT, after TEXT, request_id TEXT, config_version INTEGER, prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL);

-- §12.7 other core tables (Phase 0 subset) ---------------------------------------------------------------------

CREATE TABLE saga (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT, step INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('running','done','parked','compensating','failed')),
  lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX saga_due ON saga(state, lease_until);

CREATE TABLE decision (id TEXT PRIMARY KEY, kind TEXT NOT NULL, request TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','pending')), steps TEXT NOT NULL,
  config_version INTEGER NOT NULL, flags_hash TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX decision_at ON decision(at);

CREATE TABLE idempotency (key TEXT PRIMARY KEY, actor TEXT NOT NULL, route TEXT NOT NULL, body_hash TEXT NOT NULL,
  status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX idempotency_created ON idempotency(created_at);

CREATE TABLE scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
