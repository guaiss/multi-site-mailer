-- Read-only tokens for machine access to stored mail (e.g. a daily AI summary job).
-- Separate from site send keys: a read token can never send, and a send key can never read.
CREATE TABLE read_tokens (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  key_hash         TEXT NOT NULL UNIQUE,
  key_prefix       TEXT NOT NULL,
  allowed_domains  TEXT,                    -- JSON array of domain ids; NULL = all domains
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at     TEXT,
  revoked_at       TEXT
);
