-- Sites: one row per external website that calls the API.
CREATE TABLE sites (
  id            TEXT PRIMARY KEY,               -- short slug, e.g. "example"
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  daily_quota   INTEGER NOT NULL DEFAULT 2000,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys: only the SHA-256 hash is stored; plaintext is shown once at creation.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,                  -- first chars, for identification in logs/UI
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);

-- Exact From addresses a site may use. No wildcard / domain-level grants.
CREATE TABLE site_senders (
  site_id       TEXT NOT NULL REFERENCES sites(id),
  address       TEXT NOT NULL,                  -- lowercase, e.g. "no-reply@example.com"
  display_name  TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, address)
);

-- Templates. site_id '*' = shared template, overridable per site.
CREATE TABLE templates (
  site_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  subject       TEXT NOT NULL,
  html          TEXT,
  text          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, name)
);

-- One row per accepted send request. Never stores template variables or bodies.
CREATE TABLE send_log (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL,
  idempotency_key     TEXT,
  request_hash        TEXT NOT NULL,
  status              TEXT NOT NULL,           -- pending | sent | failed
  from_address        TEXT NOT NULL,
  to_address          TEXT NOT NULL,
  template            TEXT,
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  error_code          TEXT,
  error_message       TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX send_log_idem ON send_log(site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX send_log_site_day ON send_log(site_id, created_at);

-- Starter templates are seeded in 0003_english_templates.sql.
