-- kairos-sync database (§12.1): adapter cursors, raw outside snapshots, drift items, shadow disagreements,
-- code mapping tables and inbound event dedupe.

CREATE TABLE adapter_cursor (system TEXT NOT NULL, entity_type TEXT NOT NULL, cursor TEXT,
  next_poll_at INTEGER NOT NULL, last_success_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (system, entity_type)) WITHOUT ROWID;

CREATE TABLE raw_snapshot (system TEXT NOT NULL, entity_type TEXT NOT NULL, external_id TEXT NOT NULL,
  external_version TEXT, content_hash TEXT NOT NULL, payload TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, changed_at INTEGER NOT NULL,
  PRIMARY KEY (system, entity_type, external_id)) WITHOUT ROWID;
CREATE INDEX raw_snapshot_changed ON raw_snapshot(changed_at);

CREATE TABLE drift_item (id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('field_mismatch','missing_local','missing_outside','cross_domain_conflict','unmapped_person','push_failed')),
  system TEXT NOT NULL, entity_type TEXT NOT NULL, external_id TEXT, detail TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','resolved','ignored')), created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT);
CREATE UNIQUE INDEX drift_one_open ON drift_item(kind, system, entity_type, external_id) WHERE state = 'open';

CREATE TABLE shadow_disagreement (id TEXT PRIMARY KEY, domain TEXT NOT NULL, subject_id TEXT NOT NULL, kairos TEXT NOT NULL,
  outside TEXT NOT NULL, category TEXT, state TEXT NOT NULL CHECK (state IN ('open','triaged')), created_at INTEGER NOT NULL);

CREATE TABLE code_mapping (system TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('class_type','room','location')),
  outside_code TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (system, kind, outside_code)) WITHOUT ROWID;

CREATE TABLE inbound_event (system TEXT NOT NULL, event_id TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (system, event_id)) WITHOUT ROWID;
CREATE INDEX inbound_event_received ON inbound_event(received_at);

CREATE TABLE inbound_buffer (seq INTEGER PRIMARY KEY AUTOINCREMENT, system TEXT NOT NULL, event_id TEXT NOT NULL,
  payload TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','applied','failed')));

CREATE TABLE scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
