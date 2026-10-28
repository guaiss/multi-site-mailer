-- Inbound/outbound support mail. Times are unix seconds.

CREATE TABLE domains (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,            -- lowercase, e.g. "example.com"
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE mailboxes (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL REFERENCES domains(id),
  local_part    TEXT NOT NULL,                 -- "support"
  address       TEXT NOT NULL UNIQUE,          -- "support@example.com"
  display_name  TEXT,                          -- used as From name on replies
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (domain_id, local_part)
);

CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL REFERENCES mailboxes(id),
  subject             TEXT NOT NULL,
  subject_normalized  TEXT NOT NULL,
  counterpart         TEXT,                    -- external address of the latest inbound sender
  snippet             TEXT NOT NULL DEFAULT '',
  message_count       INTEGER NOT NULL DEFAULT 0,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'open',   -- open | done
  last_message_at     INTEGER NOT NULL,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX threads_mailbox_last ON threads(mailbox_id, last_message_at DESC);
CREATE INDEX threads_status_last ON threads(status, last_message_at DESC);
CREATE INDEX threads_subject ON threads(mailbox_id, subject_normalized, last_message_at);

CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id),
  mailbox_id         TEXT NOT NULL REFERENCES mailboxes(id),
  direction          TEXT NOT NULL,            -- in | out
  message_id_header  TEXT,
  in_reply_to        TEXT,
  references_chain   TEXT,                     -- space-separated
  from_addr          TEXT NOT NULL,
  from_name          TEXT,
  to_json            TEXT NOT NULL DEFAULT '[]',
  cc_json            TEXT NOT NULL DEFAULT '[]',
  reply_to_addr      TEXT,
  subject            TEXT NOT NULL,
  snippet            TEXT NOT NULL DEFAULT '',
  text_body          TEXT,                     -- plain text, capped, used for display fallback + search
  has_html           INTEGER NOT NULL DEFAULT 0,
  raw_key            TEXT,                     -- R2 key of original .eml (inbound)
  html_key           TEXT,                     -- R2 key of HTML body
  size               INTEGER NOT NULL DEFAULT 0,
  auth_spf           TEXT,
  auth_dkim          TEXT,
  auth_dmarc         TEXT,
  sent_by            TEXT,                     -- admin email for outbound
  sent_at            INTEGER NOT NULL,         -- Date header (in) / send time (out)
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at            INTEGER
);
CREATE INDEX messages_thread ON messages(thread_id, sent_at);
CREATE INDEX messages_msgid ON messages(mailbox_id, message_id_header);

CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id),
  filename       TEXT,
  content_type   TEXT,
  size           INTEGER NOT NULL,
  content_id     TEXT,                         -- for cid: inline images
  disposition    TEXT,
  is_executable  INTEGER NOT NULL DEFAULT 0,
  r2_key         TEXT NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id);

-- Full-text search over subject / sender / body.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_addr, from_name, text_body,
  content='messages', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, text_body)
  VALUES (new.rowid, new.subject, new.from_addr, new.from_name, new.text_body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, text_body)
  VALUES ('delete', old.rowid, old.subject, old.from_addr, old.from_name, old.text_body);
END;

-- Who did what in the admin UI.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  at          INTEGER NOT NULL DEFAULT (unixepoch())
);
