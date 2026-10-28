import { Hono } from "hono";
import { randomKey, sha256Hex } from "../lib/crypto";
import { render, TemplateError } from "../send/template";
import { isEmail } from "../send/validate";
import { audit, type AdminVars } from "./auth";

export const config = new Hono<AdminVars>();

const SITE_ID_RE = /^[a-z0-9-]{2,40}$/;
const TEMPLATE_RE = /^[a-z0-9_]{1,64}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

// ---------- domains & mailboxes ----------

config.get("/domains", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.created_at,
       (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id) AS mailbox_count
     FROM domains d ORDER BY d.name`,
  ).all();
  return c.json({ domains: results });
});

// Registers a domain in the app and creates support@ / billing@ mailboxes.
// Cloudflare-side setup (Email Routing / Sending, routing rules) is done by
// scripts/onboard-domain.mjs so the Worker never holds a Cloudflare API token.
config.post("/domains", async (c) => {
  const { name, mailboxes } = await c.req.json<{ name: string; mailboxes?: string[] }>();
  const domain = (name ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return c.json({ error: "invalid domain" }, 400);
  const locals = (mailboxes ?? ["support", "billing"]).map((l) => l.trim().toLowerCase());
  if (!locals.every((l) => LOCAL_RE.test(l))) return c.json({ error: "invalid mailbox name" }, 400);
  const exists = await c.env.DB.prepare("SELECT id FROM domains WHERE name = ?").bind(domain).first();
  if (exists) return c.json({ error: "domain already exists" }, 409);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO domains (id, name) VALUES (?, ?)").bind(id, domain),
    ...locals.map((l) =>
      c.env.DB.prepare("INSERT INTO mailboxes (id, domain_id, local_part, address) VALUES (?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        id,
        l,
        `${l}@${domain}`,
      ),
    ),
  ]);
  await audit(c.env.DB, c.get("admin"), "domain.create", domain, { mailboxes: locals });
  return c.json({ ok: true, id });
});

config.post("/mailboxes", async (c) => {
  const { domain_id, local_part, display_name } = await c.req.json<{ domain_id: string; local_part: string; display_name?: string }>();
  const local = (local_part ?? "").trim().toLowerCase();
  if (!LOCAL_RE.test(local)) return c.json({ error: "invalid mailbox name" }, 400);
  const d = await c.env.DB.prepare("SELECT name FROM domains WHERE id = ?").bind(domain_id).first<{ name: string }>();
  if (!d) return c.json({ error: "unknown domain" }, 400);
  const address = `${local}@${d.name}`;
  const dup = await c.env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first();
  if (dup) return c.json({ error: "mailbox already exists" }, 409);
  await c.env.DB.prepare("INSERT INTO mailboxes (id, domain_id, local_part, address, display_name) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), domain_id, local, address, display_name?.trim() || null)
    .run();
  await audit(c.env.DB, c.get("admin"), "mailbox.create", address);
  return c.json({ ok: true, address });
});

config.patch("/mailboxes/:id", async (c) => {
  const { display_name } = await c.req.json<{ display_name: string | null }>();
  await c.env.DB.prepare("UPDATE mailboxes SET display_name = ? WHERE id = ?")
    .bind(display_name?.trim() || null, c.req.param("id"))
    .run();
  await audit(c.env.DB, c.get("admin"), "mailbox.update", c.req.param("id"), { display_name });
  return c.json({ ok: true });
});

// Public-DNS pre-check before onboarding: is the zone on Cloudflare, and does
// it already receive mail elsewhere (an MX we would replace)?
async function doh(name: string, type: string): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
      });
      if (!r.ok) throw new Error(`DoH ${r.status}`);
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      return (j.Answer ?? []).map((a) => a.data);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

config.get("/domains/check", async (c) => {
  const domain = (c.req.query("name") ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return c.json({ error: "invalid domain" }, 400);
  const [ns, mx] = await Promise.all([doh(domain, "NS"), doh(domain, "MX")]);
  const mxHosts = mx.map((m) => m.split(/\s+/).pop()!.replace(/\.$/, "").toLowerCase());
  return c.json({
    domain,
    nameservers: ns.map((n) => n.replace(/\.$/, "")),
    on_cloudflare: ns.length > 0 && ns.every((n) => /\.ns\.cloudflare\.com\.?$/i.test(n)),
    mx: mxHosts,
    // MX already pointing at Cloudflare Email Routing is ours (or will be), not a conflict.
    existing_mail: mxHosts.filter((h) => !h.endsWith(".mx.cloudflare.net")),
  });
});

// Deleting is only allowed while nothing references the domain/mailbox, so no
// mail is ever lost. Cloudflare routing rules are not touched here.
config.delete("/domains/:id", async (c) => {
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT name FROM domains WHERE id = ?").bind(id).first<{ name: string }>();
  if (!d) return c.json({ error: "not found" }, 404);
  const used = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM messages x JOIN mailboxes m ON m.id = x.mailbox_id WHERE m.domain_id = ?) AS msgs,
            (SELECT COUNT(*) FROM site_senders WHERE address LIKE ?) AS senders`,
  )
    .bind(id, `%@${d.name}`)
    .first<{ msgs: number; senders: number }>();
  if (used && used.msgs > 0) return c.json({ error: `${d.name} has ${used.msgs} message(s); it can't be deleted` }, 409);
  if (used && used.senders > 0) return c.json({ error: `remove the ${d.name} sender addresses from Sites & keys first` }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM mailboxes WHERE domain_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(id),
  ]);
  await audit(c.env.DB, c.get("admin"), "domain.delete", d.name);
  return c.json({ ok: true });
});

config.delete("/mailboxes/:id", async (c) => {
  const id = c.req.param("id");
  const m = await c.env.DB.prepare("SELECT address FROM mailboxes WHERE id = ?").bind(id).first<{ address: string }>();
  if (!m) return c.json({ error: "not found" }, 404);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?").bind(id).first<number>("n");
  if (n && n > 0) return c.json({ error: `${m.address} has ${n} message(s); it can't be deleted` }, 409);
  await c.env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run();
  await audit(c.env.DB, c.get("admin"), "mailbox.delete", m.address);
  return c.json({ ok: true });
});

// ---------- sites, senders, keys ----------

config.get("/sites", async (c) => {
  const db = c.env.DB;
  const [sites, senders, keys, usage] = await db.batch([
    db.prepare("SELECT id, name, status, daily_quota, created_at FROM sites ORDER BY id"),
    db.prepare("SELECT site_id, address, display_name, is_default FROM site_senders ORDER BY site_id, address"),
    db.prepare("SELECT id, site_id, key_prefix, key_plain, created_at, revoked_at FROM api_keys ORDER BY created_at DESC"),
    db.prepare(
      "SELECT site_id, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed FROM send_log WHERE created_at >= date('now') GROUP BY site_id",
    ),
  ]);
  return c.json({ sites: sites.results, senders: senders.results, keys: keys.results, usage_today: usage.results });
});

config.post("/sites", async (c) => {
  const { id, name, daily_quota } = await c.req.json<{ id: string; name: string; daily_quota?: number }>();
  if (!SITE_ID_RE.test(id ?? "")) return c.json({ error: "site id must match [a-z0-9-]{2,40}" }, 400);
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  const quota = Number(daily_quota ?? 2000);
  if (!Number.isInteger(quota) || quota < 1 || quota > 1_000_000) return c.json({ error: "invalid quota" }, 400);
  const dup = await c.env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(id).first();
  if (dup) return c.json({ error: "site already exists" }, 409);
  await c.env.DB.prepare("INSERT INTO sites (id, name, daily_quota) VALUES (?, ?, ?)").bind(id, name.trim(), quota).run();
  await audit(c.env.DB, c.get("admin"), "site.create", id);
  return c.json({ ok: true });
});

config.patch("/sites/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ name?: string; status?: string; daily_quota?: number }>();
  if (b.status !== undefined && b.status !== "active" && b.status !== "disabled") return c.json({ error: "invalid status" }, 400);
  if (b.daily_quota !== undefined && (!Number.isInteger(b.daily_quota) || b.daily_quota < 1)) return c.json({ error: "invalid quota" }, 400);
  await c.env.DB.prepare(
    "UPDATE sites SET name = COALESCE(?, name), status = COALESCE(?, status), daily_quota = COALESCE(?, daily_quota) WHERE id = ?",
  )
    .bind(b.name?.trim() || null, b.status ?? null, b.daily_quota ?? null, id)
    .run();
  await audit(c.env.DB, c.get("admin"), "site.update", id, b);
  return c.json({ ok: true });
});

config.post("/sites/:id/senders", async (c) => {
  const site = c.req.param("id");
  const { address, display_name, is_default } = await c.req.json<{ address: string; display_name?: string; is_default?: boolean }>();
  const addr = (address ?? "").trim().toLowerCase();
  if (!isEmail(addr)) return c.json({ error: "invalid address" }, 400);
  // Only domains registered in the app (and therefore onboarded for sending) are allowed.
  const domain = addr.split("@")[1];
  const known = await c.env.DB.prepare("SELECT id FROM domains WHERE name = ?").bind(domain).first();
  if (!known) return c.json({ error: `domain ${domain} is not registered` }, 400);
  const stmts = [];
  if (is_default) stmts.push(c.env.DB.prepare("UPDATE site_senders SET is_default = 0 WHERE site_id = ?").bind(site));
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO site_senders (site_id, address, display_name, is_default) VALUES (?, ?, ?, ?)
       ON CONFLICT (site_id, address) DO UPDATE SET display_name = excluded.display_name, is_default = excluded.is_default`,
    ).bind(site, addr, display_name?.trim() || null, is_default ? 1 : 0),
  );
  await c.env.DB.batch(stmts);
  await audit(c.env.DB, c.get("admin"), "sender.upsert", site, { address: addr, is_default: !!is_default });
  return c.json({ ok: true });
});

config.delete("/sites/:id/senders/:address", async (c) => {
  const site = c.req.param("id");
  const address = decodeURIComponent(c.req.param("address")).toLowerCase();
  await c.env.DB.prepare("DELETE FROM site_senders WHERE site_id = ? AND address = ?").bind(site, address).run();
  await audit(c.env.DB, c.get("admin"), "sender.delete", site, { address });
  return c.json({ ok: true });
});

config.post("/sites/:id/keys", async (c) => {
  const site = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(site).first();
  if (!exists) return c.json({ error: "unknown site" }, 404);
  const key = randomKey();
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO api_keys (id, site_id, key_hash, key_prefix, key_plain) VALUES (?, ?, ?, ?, ?)")
    .bind(id, site, await sha256Hex(key), key.slice(0, 10), key)
    .run();
  await audit(c.env.DB, c.get("admin"), "key.create", site, { key_id: id });
  return c.json({ id, key });
});

config.post("/keys/:id/revoke", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
  await audit(c.env.DB, c.get("admin"), "key.revoke", id);
  return c.json({ ok: true });
});

// ---------- read tokens (machine read access to mail) ----------

config.get("/read-tokens", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, key_plain, allowed_domains, created_at, last_used_at, revoked_at FROM read_tokens ORDER BY created_at DESC",
  ).all<{ allowed_domains: string | null }>();
  return c.json({ tokens: results.map((t) => ({ ...t, allowed_domains: t.allowed_domains ? JSON.parse(t.allowed_domains) : null })) });
});

config.post("/read-tokens", async (c) => {
  const { name, allowed_domains } = await c.req.json<{ name: string; allowed_domains?: string[] | null }>();
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  let domains: string[] | null = null;
  if (allowed_domains && allowed_domains.length > 0) {
    const { results } = await c.env.DB.prepare(`SELECT id FROM domains WHERE id IN (${allowed_domains.map(() => "?").join(",")})`)
      .bind(...allowed_domains)
      .all<{ id: string }>();
    if (results.length !== allowed_domains.length) return c.json({ error: "unknown domain" }, 400);
    domains = allowed_domains;
  }
  const key = randomKey("mr_");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO read_tokens (id, name, key_hash, key_prefix, key_plain, allowed_domains) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, name.trim(), await sha256Hex(key), key.slice(0, 10), key, domains ? JSON.stringify(domains) : null)
    .run();
  await audit(c.env.DB, c.get("admin"), "read_token.create", id, { name: name.trim(), domains });
  return c.json({ id, key });
});

config.post("/read-tokens/:id/revoke", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE read_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
  await audit(c.env.DB, c.get("admin"), "read_token.revoke", id);
  return c.json({ ok: true });
});

// ---------- templates ----------

config.get("/templates", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT site_id, name, subject, html, text, updated_at FROM templates ORDER BY site_id, name").all();
  return c.json({ templates: results });
});

config.put("/templates/:site/:name", async (c) => {
  const site = c.req.param("site");
  const name = c.req.param("name");
  if (site !== "*" && !SITE_ID_RE.test(site)) return c.json({ error: "invalid site" }, 400);
  if (!TEMPLATE_RE.test(name)) return c.json({ error: "template name must match [a-z0-9_]{1,64}" }, 400);
  const { subject, html, text } = await c.req.json<{ subject: string; html?: string; text?: string }>();
  if (!subject?.trim()) return c.json({ error: "subject required" }, 400);
  if (!html?.trim() && !text?.trim()) return c.json({ error: "html or text required" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO templates (site_id, name, subject, html, text, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (site_id, name) DO UPDATE SET subject = excluded.subject, html = excluded.html, text = excluded.text, updated_at = excluded.updated_at`,
  )
    .bind(site, name, subject, html?.trim() ? html : null, text?.trim() ? text : null)
    .run();
  await audit(c.env.DB, c.get("admin"), "template.upsert", `${site}/${name}`);
  return c.json({ ok: true });
});

config.delete("/templates/:site/:name", async (c) => {
  const site = c.req.param("site");
  const name = c.req.param("name");
  await c.env.DB.prepare("DELETE FROM templates WHERE site_id = ? AND name = ?").bind(site, name).run();
  await audit(c.env.DB, c.get("admin"), "template.delete", `${site}/${name}`);
  return c.json({ ok: true });
});

config.post("/templates/preview", async (c) => {
  const { subject, html, text, variables } = await c.req.json<{ subject: string; html?: string; text?: string; variables?: Record<string, string> }>();
  const vars = { site_name: "Example", ...(variables ?? {}) };
  try {
    return c.json({
      subject: render(subject ?? "", vars, "header"),
      html: html ? render(html, vars, "html") : null,
      text: text ? render(text, vars, "text") : null,
    });
  } catch (e) {
    if (e instanceof TemplateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---------- logs ----------

config.get("/send-log", async (c) => {
  const site = c.req.query("site");
  const status = c.req.query("status");
  const where: string[] = [];
  const args: unknown[] = [];
  if (site) {
    where.push("site_id = ?");
    args.push(site);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, site_id, status, from_address, to_address, template, provider_message_id, error_code, error_message, attempts, created_at
     FROM send_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(...args)
    .all();
  return c.json({ entries: results });
});

config.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, actor, action, target, detail, at FROM audit_log ORDER BY id DESC LIMIT 200").all();
  return c.json({ entries: results });
});
