-- Control plane (§3.3 Tenant, §12.1): tenant registry, key references, lifecycle state. One object per environment.

CREATE TABLE tenant (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z][a-z0-9-]*' AND length(slug) <= 63),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning','onboarding','live','offboarding','closed','deleted')),
  legal_hold INTEGER NOT NULL DEFAULT 0, closed_at INTEGER, delete_after INTEGER,
  region_hint TEXT NOT NULL DEFAULT 'enam',
  identity TEXT NOT NULL,          -- JSON: issuers, audiences, JWKS URLs for member and staff sign-in (§13.2)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);

-- Wrapped per-tenant keys (§19.13). The key-encryption key lives in Secrets Store, never here.
CREATE TABLE tenant_key (
  tenant_id TEXT NOT NULL REFERENCES tenant(id), purpose TEXT NOT NULL CHECK (purpose IN ('data','blind_index')),
  key_version INTEGER NOT NULL, wrapped TEXT NOT NULL, kek_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','retiring','destroyed')), created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, purpose, key_version)) WITHOUT ROWID;

CREATE TABLE audit (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at INTEGER, actor TEXT, action TEXT, target_type TEXT,
  target_id TEXT, before_hash TEXT, after TEXT, request_id TEXT, config_version INTEGER, prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL);
