// Read-only mail API for machines (AI summaries, exports), mounted at /api/v1/mail and
// authenticated with `Authorization: Bearer mr_…` read tokens.
import { Hono } from "hono";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";

interface Token {
  id: string;
  allowed_domains: string | null;
}

type ReadVars = { Bindings: Env; Variables: { domains: string[] | null } };

export const readApi = new Hono<ReadVars>();

const err = (code: string, message: string) => ({ error: { code, message } });

readApi.use("*", async (c, next) => {
  const m = /^Bearer\s+(mr_[A-Za-z0-9_-]{20,})$/.exec(c.req.header("authorization") ?? "");
  if (!m) return c.json(err("unauthorized", "invalid or missing read token"), 401);
  const token = await c.env.DB.prepare("SELECT id, allowed_domains FROM read_tokens WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(m[1]))
    .first<Token>();
  if (!token) return c.json(err("unauthorized", "invalid or missing read token"), 401);

  let allowed = false;
  try {
    allowed = (await c.env.RATE_LIMITER.limit({ key: `read:${token.id}` })).success;
  } catch {
    allowed = false;
  }
  if (!allowed) return c.json(err("rate_limited", "too many requests"), 429, { "retry-after": "60" });

  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE read_tokens SET last_used_at = datetime('now') WHERE id = ?").bind(token.id).run());
  c.set("domains", token.allowed_domains ? (JSON.parse(token.allowed_domains) as string[]) : null);
  await next();
});

readApi.onError((e, c) => {
  console.error(JSON.stringify({ evt: "read_api_error", path: c.req.path, error: String(e?.message ?? e) }));
  return c.json(err("internal", "internal error"), 500);
});

// Restricts a query to the token's domains. `alias` is the mailboxes table alias.
function domainScope(domains: string[] | null, alias: string): { sql: string; args: string[] } {
  if (!domains) return { sql: "", args: [] };
  if (domains.length === 0) return { sql: " AND 0", args: [] };
  return { sql: ` AND ${alias}.domain_id IN (${domains.map(() => "?").join(",")})`, args: domains };
}

// Accepts unix seconds, ISO 8601, or a relative duration like "24h" / "7d" / "90m".
export function parseTime(v: string | undefined, now = Date.now()): number | null {
  if (!v) return null;
  const rel = /^(\d+)([mhd])$/.exec(v.trim());
  if (rel) return Math.floor(now / 1000) - Number(rel[1]) * { m: 60, h: 3600, d: 86400 }[rel[2] as "m" | "h" | "d"];
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const iso = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);

interface MsgRow {
  cursor: number;
  id: string;
  thread_id: string;
  mailbox: string;
  domain: string;
  direction: string;
  from_addr: string;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  reply_to_addr: string | null;
  subject: string;
  text_body: string | null;
  auth_spf: string | null;
  auth_dkim: string | null;
  auth_dmarc: string | null;
  sent_at: number;
  created_at: number;
}

const MSG_COLUMNS = `msg.rowid AS cursor, msg.id, msg.thread_id, mb.address AS mailbox, d.name AS domain, msg.direction,
  msg.from_addr, msg.from_name, msg.to_json, msg.cc_json, msg.reply_to_addr, msg.subject, msg.text_body,
  msg.auth_spf, msg.auth_dkim, msg.auth_dmarc, msg.sent_at, msg.created_at`;

async function attachmentsFor(db: D1Database, ids: string[]) {
  const out = new Map<string, { filename: string | null; content_type: string | null; size: number }[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT message_id, filename, content_type, size FROM attachments WHERE message_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ message_id: string; filename: string | null; content_type: string | null; size: number }>();
    for (const a of results) {
      const list = out.get(a.message_id) ?? [];
      list.push({ filename: a.filename, content_type: a.content_type, size: a.size });
      out.set(a.message_id, list);
    }
  }
  return out;
}

function shape(m: MsgRow, maxChars: number, atts: Map<string, { filename: string | null; content_type: string | null; size: number }[]>) {
  const text = m.text_body ?? "";
  return {
    id: m.id,
    thread_id: m.thread_id,
    mailbox: m.mailbox,
    domain: m.domain,
    direction: m.direction === "in" ? "inbound" : "outbound",
    from: { address: m.from_addr, name: m.from_name },
    to: (JSON.parse(m.to_json) as { addr: string; name?: string }[]).map((a) => ({ address: a.addr, name: a.name ?? null })),
    cc: (JSON.parse(m.cc_json) as { addr: string; name?: string }[]).map((a) => ({ address: a.addr, name: a.name ?? null })),
    reply_to: m.reply_to_addr,
    subject: m.subject,
    date: iso(m.sent_at),
    received_at: iso(m.created_at),
    text: text.slice(0, maxChars),
    text_truncated: text.length > maxChars,
    attachments: atts.get(m.id) ?? [],
    auth: m.direction === "in" ? { spf: m.auth_spf, dkim: m.auth_dkim, dmarc: m.auth_dmarc } : null,
  };
}

readApi.get("/mailboxes", async (c) => {
  const scope = domainScope(c.get("domains"), "mb");
  const { results } = await c.env.DB.prepare(
    `SELECT mb.address, d.name AS domain, mb.display_name FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id WHERE 1${scope.sql}
     ORDER BY d.name, mb.local_part`,
  )
    .bind(...scope.args)
    .all();
  return c.json({ mailboxes: results });
});

// Messages received/sent in a time window, oldest first, paginated by cursor.
readApi.get("/messages", async (c) => {
  const since = parseTime(c.req.query("since"));
  const until = parseTime(c.req.query("until"));
  if (c.req.query("since") && since === null) return c.json(err("invalid_request", "invalid `since`"), 400);
  if (c.req.query("until") && until === null) return c.json(err("invalid_request", "invalid `until`"), 400);
  const direction = c.req.query("direction") ?? "inbound";
  if (!["inbound", "outbound", "all"].includes(direction)) return c.json(err("invalid_request", "`direction` must be inbound|outbound|all"), 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const maxChars = Math.min(Math.max(Number(c.req.query("max_chars") ?? 20000) || 20000, 200), 100000);
  const cursor = Number(c.req.query("cursor") ?? 0) || 0;

  // Trashed conversations are hidden from machine readers.
  const where: string[] = ["msg.rowid > ?", "msg.thread_id IN (SELECT id FROM threads WHERE deleted_at IS NULL)"];
  const args: unknown[] = [cursor];
  // Default window: last 24 hours.
  where.push("msg.created_at >= ?");
  args.push(since ?? Math.floor(Date.now() / 1000) - 86400);
  if (until !== null) {
    where.push("msg.created_at < ?");
    args.push(until);
  }
  if (direction !== "all") {
    where.push("msg.direction = ?");
    args.push(direction === "inbound" ? "in" : "out");
  }
  const mailbox = c.req.query("mailbox");
  if (mailbox) {
    where.push("mb.address = ?");
    args.push(mailbox.toLowerCase());
  }
  const domain = c.req.query("domain");
  if (domain) {
    where.push("d.name = ?");
    args.push(domain.toLowerCase());
  }
  const scope = domainScope(c.get("domains"), "mb");

  const { results } = await c.env.DB.prepare(
    `SELECT ${MSG_COLUMNS} FROM messages msg JOIN mailboxes mb ON mb.id = msg.mailbox_id JOIN domains d ON d.id = mb.domain_id
     WHERE ${where.join(" AND ")}${scope.sql} ORDER BY msg.rowid ASC LIMIT ${limit + 1}`,
  )
    .bind(...args, ...scope.args)
    .all<MsgRow>();
  const page = results.slice(0, limit);
  const atts = await attachmentsFor(c.env.DB, page.map((m) => m.id));
  return c.json({
    messages: page.map((m) => shape(m, maxChars, atts)),
    next_cursor: results.length > limit ? String(page[page.length - 1].cursor) : null,
  });
});

// One conversation with every message, oldest first.
readApi.get("/threads/:id", async (c) => {
  const maxChars = Math.min(Math.max(Number(c.req.query("max_chars") ?? 20000) || 20000, 200), 100000);
  const scope = domainScope(c.get("domains"), "mb");
  const thread = await c.env.DB.prepare(
    `SELECT t.id, t.subject, t.counterpart, t.message_count, t.last_message_at, mb.address AS mailbox, d.name AS domain
     FROM threads t JOIN mailboxes mb ON mb.id = t.mailbox_id JOIN domains d ON d.id = mb.domain_id
     WHERE t.id = ? AND t.deleted_at IS NULL${scope.sql}`,
  )
    .bind(c.req.param("id"), ...scope.args)
    .first<{ id: string; subject: string; counterpart: string | null; message_count: number; last_message_at: number; mailbox: string; domain: string }>();
  if (!thread) return c.json(err("not_found", "thread not found"), 404);
  const { results } = await c.env.DB.prepare(
    `SELECT ${MSG_COLUMNS} FROM messages msg JOIN mailboxes mb ON mb.id = msg.mailbox_id JOIN domains d ON d.id = mb.domain_id
     WHERE msg.thread_id = ? ORDER BY msg.created_at, msg.rowid`,
  )
    .bind(thread.id)
    .all<MsgRow>();
  const atts = await attachmentsFor(c.env.DB, results.map((m) => m.id));
  return c.json({
    thread: { ...thread, last_message_at: iso(thread.last_message_at) },
    messages: results.map((m) => shape(m, maxChars, atts)),
  });
});

readApi.all("*", (c) => c.json(err("not_found", "not found"), 404));
