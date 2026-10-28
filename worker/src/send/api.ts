import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { CloudflareProvider, type Provider } from "./provider";
import { render, TemplateError, type Vars } from "./template";
import { parseSendRequest, type SendRequest } from "./validate";

interface Site {
  id: string;
  name: string;
  status: string;
  daily_quota: number;
}

interface LogRow {
  id: string;
  status: string;
  request_hash: string;
  provider_message_id: string | null;
  error_code: string | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const err = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  json(status, { error: { code, message } }, headers);

function log(evt: Record<string, unknown>) {
  console.log(JSON.stringify(evt));
}

async function authenticate(req: Request, db: D1Database): Promise<Site | null> {
  const m = /^Bearer\s+(mk_[A-Za-z0-9_-]{20,})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  return db
    .prepare(
      `SELECT s.id, s.name, s.status, s.daily_quota FROM api_keys k JOIN sites s ON s.id = k.site_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .bind(hash)
    .first<Site>();
}

async function resolveSender(db: D1Database, siteId: string, from?: string) {
  const row = from
    ? await db.prepare("SELECT address, display_name FROM site_senders WHERE site_id = ? AND address = ?").bind(siteId, from).first()
    : await db.prepare("SELECT address, display_name FROM site_senders WHERE site_id = ? AND is_default = 1").bind(siteId).first();
  return row as { address: string; display_name: string | null } | null;
}

async function buildContent(db: D1Database, site: Site, r: SendRequest) {
  if (!r.template) {
    return { subject: r.subject!.replace(/[\r\n]+/g, " "), html: r.html, text: r.text };
  }
  const tpl = await db
    .prepare("SELECT subject, html, text FROM templates WHERE name = ? AND site_id IN (?, '*') ORDER BY site_id = '*' LIMIT 1")
    .bind(r.template, site.id)
    .first<{ subject: string; html: string | null; text: string | null }>();
  if (!tpl) return null;
  const vars: Vars = { site_name: site.name, ...r.variables };
  return {
    subject: render(tpl.subject, vars, "header"),
    html: tpl.html ? render(tpl.html, vars, "html") : undefined,
    text: tpl.text ? render(tpl.text, vars, "text") : undefined,
  };
}

// Claims the send slot. Returns either a log id to proceed with, or a response to return as-is.
async function claim(
  db: D1Database,
  site: Site,
  r: SendRequest,
  requestHash: string,
  from: string,
  provider: string,
): Promise<{ id: string } | { response: Response }> {
  const id = crypto.randomUUID();
  const ins = await db
    .prepare(
      `INSERT INTO send_log (id, site_id, idempotency_key, request_hash, status, from_address, to_address, template, provider)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(id, site.id, r.idempotency_key ?? null, requestHash, from, r.to, r.template ?? null, provider)
    .run();
  if (ins.meta.changes === 1) return { id };

  const existing = await db
    .prepare("SELECT id, status, request_hash, provider_message_id, error_code FROM send_log WHERE site_id = ? AND idempotency_key = ?")
    .bind(site.id, r.idempotency_key ?? null)
    .first<LogRow>();
  if (!existing) return { response: err(500, "internal", "idempotency lookup failed") };
  if (existing.request_hash !== requestHash) {
    return { response: err(422, "idempotency_conflict", "idempotency_key reused with a different request") };
  }
  if (existing.status === "sent") {
    return { response: json(200, { id: existing.id, status: "sent", provider_message_id: existing.provider_message_id, replayed: true }) };
  }
  if (existing.status === "failed") {
    const upd = await db
      .prepare("UPDATE send_log SET status = 'pending', updated_at = datetime('now') WHERE id = ? AND status = 'failed'")
      .bind(existing.id)
      .run();
    if (upd.meta.changes === 1) return { id: existing.id };
  }
  return { response: err(409, "in_progress", "a request with this idempotency_key is in progress") };
}

async function handleSend(req: Request, env: Env, provider: Provider): Promise<Response> {
  const site = await authenticate(req, env.DB);
  if (!site) return err(401, "unauthorized", "invalid or missing API key");
  if (site.status !== "active") return err(403, "site_disabled", "site is disabled");

  // Fail closed: if the limiter itself errors, refuse rather than send unthrottled.
  let allowed = false;
  try {
    allowed = (await env.RATE_LIMITER.limit({ key: site.id })).success;
  } catch {
    allowed = false;
  }
  if (!allowed) return err(429, "rate_limited", "too many requests", { "retry-after": "60" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_json", "body must be JSON");
  }
  const parsed = parseSendRequest(body, req.headers.get("idempotency-key"));
  if (!parsed.ok) return err(400, "invalid_request", parsed.error);
  const r = parsed.req;

  const sender = await resolveSender(env.DB, site.id, r.from);
  if (!sender) {
    return err(403, "sender_not_allowed", r.from ? `from address not allowed for this site` : "site has no default sender");
  }

  let content;
  try {
    content = await buildContent(env.DB, site, r);
  } catch (e) {
    if (e instanceof TemplateError) return err(400, "template_error", e.message);
    throw e;
  }
  if (!content) return err(400, "unknown_template", `template not found: ${r.template}`);

  const used = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM send_log WHERE site_id = ? AND created_at >= date('now') AND status != 'failed'")
    .bind(site.id)
    .first<number>("n");
  if ((used ?? 0) >= site.daily_quota) return err(429, "daily_quota_exceeded", "site daily quota exceeded");

  const requestHash = await sha256Hex(JSON.stringify([sender.address, r.to, r.reply_to, r.template, r.variables, r.subject, r.html, r.text]));
  const claimed = await claim(env.DB, site, r, requestHash, sender.address, provider.name);
  if ("response" in claimed) return claimed.response;
  const id = claimed.id;

  const result = await provider.send({
    from: { email: sender.address, ...(sender.display_name ? { name: sender.display_name } : {}) },
    to: r.to,
    replyTo: r.reply_to,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });

  if (result.ok) {
    await env.DB
      .prepare("UPDATE send_log SET status = 'sent', provider_message_id = ?, attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?")
      .bind(result.messageId, id)
      .run();
    log({ evt: "send", site: site.id, id, status: "sent", template: r.template ?? null, provider_message_id: result.messageId });
    return json(200, { id, status: "sent", provider_message_id: result.messageId });
  }

  await env.DB
    .prepare(
      "UPDATE send_log SET status = 'failed', error_code = ?, error_message = ?, attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(result.code, result.message, id)
    .run();
  log({ evt: "send", site: site.id, id, status: "failed", code: result.code });
  return err(result.retryable ? 503 : 502, result.code, result.message, result.retryable ? { "retry-after": "30" } : {});
}

export async function sendApi(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed", "use POST");
  try {
    return await handleSend(req, env, new CloudflareProvider(env.EMAIL));
  } catch (e) {
    log({ evt: "error", message: String((e as Error)?.message ?? e) });
    return err(500, "internal", "internal error");
  }
}
