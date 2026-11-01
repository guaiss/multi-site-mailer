import { Hono, type Handler } from "hono";
import { parsePermissions } from "../tokens/auth";
import { randomKey, sha256Hex } from "../lib/crypto";
import { render, TemplateError } from "../send/template";
import { isEmail } from "../send/validate";
import { audit, type AdminVars } from "./auth";

export const config = new Hono<AdminVars>();

const TEMPLATE_RE = /^[a-z0-9_]{1,64}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LOCAL_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

// ---------- domains & mailboxes ----------

config.get("/domains", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.display_name, d.status, d.daily_quota, d.created_at,
       (SELECT COUNT(*) FROM send_log l WHERE l.domain_id=d.id AND l.created_at>=date('now') AND l.status='sent') AS sent_today,
       (SELECT COUNT(*) FROM send_log l WHERE l.domain_id=d.id AND l.created_at>=date('now') AND l.status='failed') AS failed_today,
       (SELECT json_group_array(json_object('domain_id',ss.domain_id,'address',ss.address,'display_name',ss.display_name,'is_default',ss.is_default)) FROM domain_senders ss WHERE ss.domain_id=d.id) AS senders,
       (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id) AS mailbox_count
     FROM domains d ORDER BY d.name`,
  ).all<{ senders: string }>();
  return c.json({ domains: results.map((d) => ({ ...d, senders: JSON.parse(d.senders) })) });
});

// Registers a domain; mailboxes are created only when explicitly supplied.
// Cloudflare-side setup (Email Routing / Sending, routing rules) is done by
// scripts/onboard-domain.mjs so the Worker never holds a Cloudflare API token.
config.post("/domains", async (c) => {
  const { name, mailboxes } = await c.req.json<{ name: string; mailboxes?: string[] }>();
  const domain = (name ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return c.json({ error: "invalid domain" }, 400);
  if (mailboxes !== undefined && (!Array.isArray(mailboxes) || !mailboxes.every((m) => typeof m === "string"))) return c.json({ error: "invalid mailboxes" }, 400);
  const locals = [...new Set((mailboxes ?? []).map((l) => l.trim().toLowerCase()))];
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
            (SELECT COUNT(*) FROM domain_senders WHERE domain_id = ?) AS senders,
            (SELECT COUNT(*) FROM domain_templates WHERE domain_id = ?) AS templates,
            (SELECT COUNT(*) FROM send_log WHERE domain_id = ?) AS logs`,
  )
    .bind(id, id, id, id)
    .first<{ msgs: number; senders: number; templates: number; logs: number }>();
  if (used && used.msgs > 0) return c.json({ error: `${d.name} has ${used.msgs} message(s); it can't be deleted` }, 409);
  if (used && used.senders > 0) return c.json({ error: `remove the ${d.name} sender addresses first` }, 409);
  if (used && (used.templates > 0 || used.logs > 0)) return c.json({ error: "domain has templates or send history" }, 409);
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

// ---------- domain sending settings ----------
config.patch("/domains/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ display_name?: string | null; status?: string; daily_quota?: number }>();
  if (b.display_name !== undefined && b.display_name !== null && typeof b.display_name !== "string") return c.json({ error: "invalid display name" }, 400);
  if (b.status !== undefined && !["active", "disabled"].includes(b.status)) return c.json({ error: "invalid status" }, 400);
  if (b.daily_quota !== undefined && (!Number.isInteger(b.daily_quota) || b.daily_quota < 1 || b.daily_quota > 1_000_000)) return c.json({ error: "invalid quota" }, 400);
  const d = await c.env.DB.prepare("SELECT id FROM domains WHERE id = ?").bind(id).first();
  if (!d) return c.json({ error: "domain not found" }, 404);
  await c.env.DB.prepare("UPDATE domains SET display_name = CASE WHEN ? THEN ? ELSE display_name END, status = COALESCE(?, status), daily_quota = COALESCE(?, daily_quota) WHERE id = ?")
    .bind(b.display_name !== undefined ? 1 : 0, b.display_name?.trim() || null, b.status ?? null, b.daily_quota ?? null, id).run();
  await audit(c.env.DB, c.get("admin"), "domain.update", id, b);
  return c.json({ ok: true });
});

config.post("/domains/:id/senders", async (c) => {
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT name FROM domains WHERE id = ?").bind(id).first<{ name: string }>();
  if (!d) return c.json({ error: "domain not found" }, 404);
  const { address, display_name, is_default } = await c.req.json<{ address: string; display_name?: string | null; is_default?: boolean }>();
  const addr = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!isEmail(addr) || addr.split("@")[1] !== d.name) return c.json({ error: "sender must belong to this domain" }, 400);
  if (is_default !== undefined && typeof is_default !== "boolean") return c.json({ error: "invalid default flag" }, 400);
  if (display_name !== undefined && display_name !== null && typeof display_name !== "string") return c.json({ error: "invalid display name" }, 400);
  const stmts = [];
  if (is_default) stmts.push(c.env.DB.prepare("UPDATE domain_senders SET is_default = 0 WHERE domain_id = ?").bind(id));
  stmts.push(c.env.DB.prepare(`INSERT INTO domain_senders (domain_id, address, display_name, is_default) VALUES (?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET display_name=excluded.display_name, is_default=excluded.is_default`)
    .bind(id, addr, display_name?.trim() || null, is_default ? 1 : 0));
  await c.env.DB.batch(stmts);
  await audit(c.env.DB, c.get("admin"), "sender.upsert", id, { address: addr, is_default: !!is_default });
  return c.json({ ok: true });
});

config.delete("/domains/:id/senders/:address", async (c) => {
  const id = c.req.param("id");
  const address = c.req.param("address").toLowerCase();
  await c.env.DB.prepare("DELETE FROM domain_senders WHERE domain_id = ? AND address = ?").bind(id, address).run();
  await audit(c.env.DB, c.get("admin"), "sender.delete", id, { address });
  return c.json({ ok: true });
});
// Sites are archived compatibility data; refuse new writes through old clients.
config.all("/sites", (c) => c.json({ error: "manage sending settings under /domains" }, 410));
config.all("/sites/*", (c) => c.json({ error: "manage sending settings under /domains" }, 410));

// Legacy creation endpoints deliberately refuse implicit broad grants.
config.post("/sites/:id/keys", (c) => c.json({ error: "create a token with explicit permissions at /tokens" }, 410));
config.post("/read-tokens", (c) => c.json({ error: "create a token with explicit permissions at /tokens" }, 410));

// ---------- unified tokens ----------
config.get("/tokens", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, key_prefix, key_plain, permissions, site_id, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC",
  ).all<{ permissions: string }>();
  return c.json({ tokens: results.map((t) => ({ ...t, permissions: JSON.parse(t.permissions) })) });
});

const saveToken: Handler<AdminVars> = async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!b || typeof b.name !== "string" || !b.name.trim()) return c.json({ error: "name required" }, 400);
  const permissions = parsePermissions(b.permissions);
  if (!permissions) return c.json({ error: "permissions must be unique domain grants with boolean read/send fields" }, 400);
  const ids = permissions.filter((p) => p.domain_id !== "*").map((p) => p.domain_id);
  if (ids.length) {
    const { results } = await c.env.DB.prepare("SELECT id FROM domains WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
    if (results.length !== ids.length) return c.json({ error: "unknown domain" }, 400);
  }
  const name = b.name.trim();
  if (c.req.method === "PATCH") {
    const id = c.req.param("id")!;
    const token = await c.env.DB.prepare("SELECT id FROM tokens WHERE id = ? AND revoked_at IS NULL").bind(id).first();
    if (!token) return c.json({ error: "active token not found" }, 404);
    await c.env.DB.prepare("UPDATE tokens SET name = ?, permissions = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(name, JSON.stringify(permissions), id).run();
    await audit(c.env.DB, c.get("admin"), "token.update", id, { name, permissions });
    return c.json({ ok: true });
  }
  const id = crypto.randomUUID();
  const key = randomKey();
  await c.env.DB.prepare("INSERT INTO tokens (id, name, key_hash, key_prefix, key_plain, permissions) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(key), key.slice(0, 10), key, JSON.stringify(permissions)).run();
  await audit(c.env.DB, c.get("admin"), "token.create", id, { name, permissions });
  return c.json({ id, key });
};
config.post("/tokens", saveToken);
config.patch("/tokens/:id", saveToken);

config.post("/tokens/:id/revoke", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
  await audit(c.env.DB, c.get("admin"), "token.revoke", id);
  return c.json({ ok: true });
});

// ---------- templates ----------

config.get("/templates", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT domain_id, name, subject, html, text, updated_at FROM domain_templates ORDER BY domain_id, name").all();
  return c.json({ templates: results });
});

config.put("/templates/:domain/:name", async (c) => {
  const domain = c.req.param("domain");
  const name = c.req.param("name");
  if (domain !== "*" && !await c.env.DB.prepare("SELECT id FROM domains WHERE id = ?").bind(domain).first()) return c.json({ error: "unknown domain" }, 400);
  if (!TEMPLATE_RE.test(name)) return c.json({ error: "template name must match [a-z0-9_]{1,64}" }, 400);
  const { subject, html, text } = await c.req.json<{ subject: string; html?: string; text?: string }>();
  if (!subject?.trim()) return c.json({ error: "subject required" }, 400);
  if (!html?.trim() && !text?.trim()) return c.json({ error: "html or text required" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO domain_templates (domain_id, name, subject, html, text, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (domain_id, name) DO UPDATE SET subject = excluded.subject, html = excluded.html, text = excluded.text, updated_at = excluded.updated_at`,
  )
    .bind(domain, name, subject, html?.trim() ? html : null, text?.trim() ? text : null)
    .run();
  await audit(c.env.DB, c.get("admin"), "template.upsert", `${domain}/${name}`);
  return c.json({ ok: true });
});

config.delete("/templates/:domain/:name", async (c) => {
  const domain = c.req.param("domain");
  const name = c.req.param("name");
  await c.env.DB.prepare("DELETE FROM domain_templates WHERE domain_id = ? AND name = ?").bind(domain, name).run();
  await audit(c.env.DB, c.get("admin"), "template.delete", `${domain}/${name}`);
  return c.json({ ok: true });
});

config.post("/templates/preview", async (c) => {
  const { subject, html, text, variables } = await c.req.json<{ subject: string; html?: string; text?: string; variables?: Record<string, string> }>();
  const vars = { site_name: "Example", domain_name: "example.com", ...(variables ?? {}) };
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
  const domain = c.req.query("domain");
  const status = c.req.query("status");
  const where: string[] = [];
  const args: unknown[] = [];
  if (domain) {
    where.push("l.domain_id = ?");
    args.push(domain);
  }
  if (status) {
    where.push("l.status = ?");
    args.push(status);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.domain_id, d.name AS domain, l.status, l.from_address, l.to_address, l.template, l.provider_message_id, l.error_code, l.error_message, l.attempts, l.created_at
     FROM send_log l LEFT JOIN domains d ON d.id=l.domain_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.created_at DESC, l.rowid DESC LIMIT 200`,
  )
    .bind(...args)
    .all();
  return c.json({ entries: results });
});

config.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, actor, action, target, detail, at FROM audit_log ORDER BY id DESC LIMIT 200").all();
  return c.json({ entries: results });
});
