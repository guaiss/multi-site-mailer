-- One credential type, with independent read/send grants per domain.
-- Old tables are retained as legacy snapshots; all runtime authentication uses tokens.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_plain TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  site_id TEXT REFERENCES sites(id), -- preserves the sending-site boundary of legacy keys
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

INSERT INTO tokens (id, name, key_hash, key_prefix, key_plain, permissions, created_at, last_used_at, revoked_at)
SELECT id, name, key_hash, key_prefix, key_plain,
  CASE WHEN allowed_domains IS NULL THEN '[{"domain_id":"*","read":true,"send":false}]'
  ELSE (SELECT json_group_array(json_object('domain_id', value, 'read', json('true'), 'send', json('false'))) FROM json_each(allowed_domains)) END,
  created_at, last_used_at, revoked_at FROM read_tokens;

INSERT INTO tokens (id, name, key_hash, key_prefix, key_plain, permissions, site_id, created_at, revoked_at)
SELECT k.id, 'Send: ' || s.name, k.key_hash, k.key_prefix, k.key_plain,
  (SELECT json_group_array(json_object('domain_id', d.id, 'read', json('false'), 'send', json('true')))
   FROM domains d WHERE EXISTS (SELECT 1 FROM site_senders ss WHERE ss.site_id = k.site_id AND substr(ss.address, instr(ss.address, '@') + 1) = d.name)),
  k.site_id, k.created_at, k.revoked_at FROM api_keys k JOIN sites s ON s.id = k.site_id;
