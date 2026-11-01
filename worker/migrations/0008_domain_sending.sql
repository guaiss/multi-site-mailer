-- Sending configuration belongs to domains. Legacy site tables remain read-only
-- for old credentials / site_id clients; normal management no longer uses them.
ALTER TABLE domains ADD COLUMN display_name TEXT;
ALTER TABLE domains ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE domains ADD COLUMN daily_quota INTEGER NOT NULL DEFAULT 2000;

UPDATE domains SET
 display_name = (SELECT s.name FROM sites s JOIN site_senders ss ON ss.site_id=s.id WHERE substr(ss.address,instr(ss.address,'@')+1)=domains.name ORDER BY s.id LIMIT 1),
 status = COALESCE((SELECT MAX(s.status) FROM sites s JOIN site_senders ss ON ss.site_id=s.id WHERE substr(ss.address,instr(ss.address,'@')+1)=domains.name), 'active'),
 daily_quota = COALESCE((SELECT MIN(s.daily_quota) FROM sites s JOIN site_senders ss ON ss.site_id=s.id WHERE substr(ss.address,instr(ss.address,'@')+1)=domains.name), 2000);

CREATE TABLE domain_senders (
 domain_id TEXT NOT NULL REFERENCES domains(id),
 address TEXT NOT NULL PRIMARY KEY,
 display_name TEXT,
 is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1))
);
INSERT INTO domain_senders (domain_id,address,display_name,is_default)
SELECT domain_id,address,display_name,CASE WHEN ROW_NUMBER() OVER (PARTITION BY domain_id ORDER BY is_default DESC,site_id,address)=1 THEN 1 ELSE 0 END
FROM (
 SELECT d.id AS domain_id,ss.*,ROW_NUMBER() OVER (PARTITION BY ss.address ORDER BY ss.is_default DESC,ss.site_id) AS address_rank
 FROM site_senders ss JOIN domains d ON d.name=substr(ss.address,instr(ss.address,'@')+1)
) WHERE address_rank=1;
CREATE UNIQUE INDEX domain_default_sender ON domain_senders(domain_id) WHERE is_default=1;

-- Refuse ambiguous template merges instead of silently discarding overrides.
CREATE TABLE domain_merge_guard (ok INTEGER CHECK(ok=1));
INSERT INTO domain_merge_guard SELECT CASE WHEN EXISTS (
 SELECT d.id,t.name FROM templates t JOIN site_senders ss ON ss.site_id=t.site_id
 JOIN domains d ON d.name=substr(ss.address,instr(ss.address,'@')+1)
 GROUP BY d.id,t.name HAVING COUNT(DISTINCT json_array(t.subject,t.html,t.text))>1
) OR EXISTS (
 SELECT 1 FROM templates t WHERE t.site_id!='*' AND NOT EXISTS (SELECT 1 FROM site_senders ss JOIN domains d ON d.name=substr(ss.address,instr(ss.address,'@')+1) WHERE ss.site_id=t.site_id)
) THEN 0 ELSE 1 END;
DROP TABLE domain_merge_guard;

CREATE TABLE domain_templates (
 domain_id TEXT NOT NULL, -- '*' for shared templates
 name TEXT NOT NULL,
 subject TEXT NOT NULL,
 html TEXT,
 text TEXT,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(domain_id,name)
);
INSERT INTO domain_templates SELECT site_id,name,subject,html,text,updated_at FROM templates WHERE site_id='*';
INSERT INTO domain_templates
SELECT d.id,t.name,t.subject,t.html,t.text,MAX(t.updated_at)
FROM templates t JOIN site_senders ss ON ss.site_id=t.site_id
JOIN domains d ON d.name=substr(ss.address,instr(ss.address,'@')+1)
GROUP BY d.id,t.name;

ALTER TABLE send_log ADD COLUMN domain_id TEXT REFERENCES domains(id);
UPDATE send_log SET domain_id=(SELECT d.id FROM domains d WHERE d.name=substr(send_log.from_address,instr(send_log.from_address,'@')+1));
-- Also guards against ambiguous historical idempotency keys across merged sites.
CREATE UNIQUE INDEX send_log_domain_idem ON send_log(domain_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX send_log_domain_day ON send_log(domain_id,created_at);
