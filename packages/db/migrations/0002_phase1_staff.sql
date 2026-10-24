-- 0002 Phase 1 staff tables (§12.7): time off, hours records, tasks, person mapping, external refs. Expand only.

CREATE TABLE time_off (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id), start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sick','vacation','personal','leave_of_absence','other')),
  immediate INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('requested','approved','rejected','cancelled')),
  note TEXT, created_by TEXT NOT NULL, decided_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (start_at < end_at));
CREATE INDEX time_off_resource ON time_off(resource_id, start_at) WHERE state IN ('requested','approved');

-- One non-voided hours record per confirmed owned assignment (I-28b)
CREATE TABLE hours_record (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resource(id), assignment_id TEXT NOT NULL,
  session_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('shift','teaching')),
  location_key TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, minutes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','worked','approved','voided')),
  void_reason TEXT, pay_protected INTEGER NOT NULL DEFAULT 0, final INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX hours_one_live ON hours_record(assignment_id) WHERE state != 'voided';
CREATE INDEX hours_resource_start ON hours_record(resource_id, start_at);
CREATE INDEX hours_start ON hours_record(start_at);

CREATE TABLE task (
  id TEXT PRIMARY KEY, list TEXT NOT NULL CHECK (list IN ('desk_checklist','manager_inbox')), location_key TEXT,
  title TEXT NOT NULL, detail TEXT, subject_type TEXT, subject_id TEXT, due_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('open','done','cancelled')), created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, done_at INTEGER, done_by TEXT);
CREATE INDEX task_open ON task(list, state, due_at);

CREATE TABLE person_mapping (
  system TEXT NOT NULL, external_person_id TEXT NOT NULL, resource_id TEXT,
  match TEXT NOT NULL CHECK (match IN ('email','manual','unmatched')), matched_at INTEGER, matched_by TEXT,
  PRIMARY KEY (system, external_person_id)) WITHOUT ROWID;

CREATE TABLE external_ref (
  id TEXT PRIMARY KEY, system TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  external_id TEXT NOT NULL, external_version TEXT, content_hash TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
  last_pushed_at INTEGER, UNIQUE (system, entity_type, external_id));
CREATE INDEX external_ref_entity ON external_ref(entity_type, entity_id);

-- people: email for person mapping (§18.5), kept with the resource
ALTER TABLE resource ADD COLUMN email TEXT;
CREATE INDEX resource_email ON resource(email) WHERE email IS NOT NULL;
