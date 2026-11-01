import { authenticateToken, domainsFor } from "../tokens/auth";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { CloudflareProvider, type Provider } from "./provider";
import { render, TemplateError, type Vars } from "./template";
import { parseSendRequest, type SendRequest } from "./validate";

interface SendingDomain {
  display_name: string | null;
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

async function buildContent(db: D1Database, domain: SendingDomain, r: SendRequest) {
  if (!r.template) {
    return { subject: r.subject!.replace(/[\r\n]+/g, " "), html: r.html, text: r.text };
  }
  const tpl = await db
    .prepare("SELECT subject, html, text FROM domain_templates WHERE name = ? AND domain_id IN (?, '*') ORDER BY domain_id = '*' LIMIT 1")
    .bind(r.template, domain.id)
    .first<{ subject: string; html: string | null; text: string | null }>();
  if (!tpl) return null;
  const vars: Vars = { site_name: domain.display_name ?? domain.name, domain_name: domain.name, ...r.variables };
  return {
    subject: render(tpl.subject, vars, "header"),
    html: tpl.html ? render(tpl.html, vars, "html") : undefined,
    text: tpl.text ? render(tpl.text, vars, "text") : undefined,
  };
}

// Claims the send slot. Returns either a log id to proceed with, or a response to return as-is.
async function claim(
  db: D1Database,
  domain: SendingDomain,
  r: SendRequest,
  requestHash: string,
  from: string,
  provider: string,
): Promise<{ id: string } | { response: Response }> {
  const id = crypto.randomUUID();
  const ins = await db
    .prepare(
      `INSERT INTO send_log (id, site_id, domain_id, idempotency_key, request_hash, status, from_address, to_address, template, provider)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(id, domain.id, domain.id, r.idempotency_key ?? null, requestHash, from, r.to, r.template ?? null, provider)
    .run();
  if (ins.meta.changes === 1) return { id };

  const existing = await db
    .prepare("SELECT id, status, request_hash, provider_message_id, error_code FROM send_log WHERE domain_id = ? AND idempotency_key = ?")
    .bind(domain.id, r.idempotency_key ?? null)
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
  const token = await authenticateToken(req, env.DB);
  if (!token) return err(401, "unauthorized", "invalid or missing token");
  const domains = domainsFor(token, "send");
  if (domains?.length === 0) return err(403, "forbidden", "token has no send permission");

  // Throttle before parsing/resolving the send request.
  try {
    if (!(await env.RATE_LIMITER.limit({ key: `token:${token.id}` })).success) {
      return err(429, "rate_limited", "too many requests", { "retry-after": "60" });
    }
  } catch {
    return err(429, "rate_limited", "too many requests", { "retry-after": "60" });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return err(400, "invalid_json", "body must be JSON"); }
  const parsed = parseSendRequest(body, req.headers.get("idempotency-key"));
  if (!parsed.ok) return err(400, "invalid_request", parsed.error);
  const r = parsed.req;
  if (token.site_id && r.site_id && r.site_id !== token.site_id) return err(403, "forbidden", "legacy credential is bound to another sender configuration");
  let from = r.from;
  // Compatibility for existing site_id clients and old keys that omit From.
  const legacySite = token.site_id ?? r.site_id;
  if (legacySite && !from) {
    from = (await env.DB.prepare("SELECT address FROM site_senders WHERE site_id = ? AND is_default = 1")
      .bind(legacySite).first<{ address: string }>())?.address;
  }
  if (token.site_id && from) {
    const allowed = await env.DB.prepare("SELECT address FROM site_senders WHERE site_id = ? AND address = ?")
      .bind(token.site_id, from).first();
    if (!allowed) return err(403, "sender_not_allowed", "from address not allowed for this legacy credential");
  }
  if (!from && !r.domain) return err(400, "invalid_request", "provide `from` or `domain`");
  const domainName = from?.split("@")[1] ?? r.domain;
  if (r.domain && domainName !== r.domain) return err(400, "invalid_request", "`from` must belong to `domain`");
  const domain = await env.DB.prepare("SELECT id, name, display_name, status, daily_quota FROM domains WHERE name = ?")
    .bind(domainName).first<SendingDomain>();
  if (!domain || (domains && !domains.includes(domain.id))) return err(403, "forbidden", "token cannot send from this domain");
  if (domain.status !== "active") return err(403, "domain_disabled", "sending is disabled for this domain");
  const sender = from
    ? await env.DB.prepare("SELECT address, display_name FROM domain_senders WHERE domain_id = ? AND address = ?").bind(domain.id, from).first<{ address: string; display_name: string | null }>()
    : await env.DB.prepare("SELECT address, display_name FROM domain_senders WHERE domain_id = ? AND is_default = 1").bind(domain.id).first<{ address: string; display_name: string | null }>();
  if (!sender) return err(403, "sender_not_allowed", "domain has no matching allowed sender");
  try {
    if (!(await env.RATE_LIMITER.limit({ key: `domain:${domain.id}` })).success) return err(429, "rate_limited", "too many requests", { "retry-after": "60" });
  } catch { return err(429, "rate_limited", "too many requests", { "retry-after": "60" }); }
  await env.DB.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?").bind(token.id).run();

  let content;
  try {
    content = await buildContent(env.DB, domain, r);
  } catch (e) {
    if (e instanceof TemplateError) return err(400, "template_error", e.message);
    throw e;
  }
  if (!content) return err(400, "unknown_template", `template not found: ${r.template}`);

  const used = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM send_log WHERE domain_id = ? AND created_at >= date('now') AND status != 'failed'")
    .bind(domain.id)
    .first<number>("n");
  if ((used ?? 0) >= domain.daily_quota) return err(429, "daily_quota_exceeded", "domain daily quota exceeded");

  const requestHash = await sha256Hex(JSON.stringify([sender.address, r.to, r.reply_to, r.template, r.variables, r.subject, r.html, r.text]));
  const claimed = await claim(env.DB, domain, r, requestHash, sender.address, provider.name);
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
    log({ evt: "send", domain: domain.name, id, status: "sent", template: r.template ?? null, provider_message_id: result.messageId });
    return json(200, { id, status: "sent", provider_message_id: result.messageId });
  }

  await env.DB
    .prepare(
      "UPDATE send_log SET status = 'failed', error_code = ?, error_message = ?, attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(result.code, result.message, id)
    .run();
  log({ evt: "send", domain: domain.name, id, status: "failed", code: result.code });
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
