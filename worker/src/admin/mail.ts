import { Hono } from "hono";
import { MAX_TEXT_CHARS } from "../env";
import { stripHtml } from "../inbound/parse";
import { normalizeSubject } from "../inbound/thread";
import { CloudflareProvider } from "../send/provider";
import { isEmail } from "../send/validate";
import { audit, type AdminVars } from "./auth";
import { purgeThreads } from "./purge";

export const mail = new Hono<AdminVars>();

const PAGE = 50;

interface ThreadRow {
  id: string;
  mailbox_id: string;
  mailbox_address: string;
  subject: string;
  counterpart: string | null;
  snippet: string;
  message_count: number;
  unread_count: number;
  status: string;
  last_message_at: number;
}

// Mailbox list for the sidebar, with open/unread counts.
mail.get("/mailboxes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.local_part, m.display_name, d.id AS domain_id, d.name AS domain,
       (SELECT COUNT(*) FROM threads t WHERE t.mailbox_id = m.id AND t.status = 'open' AND t.deleted_at IS NULL) AS open_count,
       (SELECT COUNT(*) FROM threads t WHERE t.mailbox_id = m.id AND t.unread_count > 0 AND t.deleted_at IS NULL) AS unread_count
     FROM mailboxes m JOIN domains d ON d.id = m.domain_id ORDER BY d.name, m.local_part`,
  ).all();
  return c.json({ mailboxes: results });
});

function ftsQuery(q: string): string {
  // Each whitespace-separated term becomes a quoted phrase; all must match.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" AND ");
}

mail.get("/threads", async (c) => {
  const mailbox = c.req.query("mailbox");
  const domain = c.req.query("domain");
  const status = c.req.query("status") ?? "all";
  const q = (c.req.query("q") ?? "").trim();
  const before = Number(c.req.query("before") ?? 0);

  const where: string[] = [status === "trash" ? "t.deleted_at IS NOT NULL" : "t.deleted_at IS NULL"];
  const args: unknown[] = [];
  if (mailbox) {
    where.push("t.mailbox_id = ?");
    args.push(mailbox);
  }
  if (domain) {
    where.push("m.domain_id = ?");
    args.push(domain);
  }
  if (status === "open" || status === "done") {
    where.push("t.status = ?");
    args.push(status);
  } else if (status === "unread") {
    where.push("t.unread_count > 0");
  }
  if (before > 0) {
    where.push("t.last_message_at < ?");
    args.push(before);
  }
  if (q) {
    // Trigram FTS needs >= 3 chars per term; shorter queries fall back to LIKE.
    const terms = q.split(/\s+/).filter(Boolean);
    if (terms.every((t) => [...t].length >= 3)) {
      where.push("t.id IN (SELECT msg.thread_id FROM messages_fts f JOIN messages msg ON msg.rowid = f.rowid WHERE messages_fts MATCH ?)");
      args.push(ftsQuery(q));
    } else {
      where.push(
        "t.id IN (SELECT thread_id FROM messages WHERE subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR text_body LIKE ?)",
      );
      const like = `%${q.replace(/[%_]/g, "")}%`;
      args.push(like, like, like, like);
    }
  }
  const sql = `SELECT t.id, t.mailbox_id, m.address AS mailbox_address, t.subject, t.counterpart, t.snippet, t.message_count,
      t.unread_count, t.status, t.last_message_at, t.deleted_at
    FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY t.last_message_at DESC LIMIT ${PAGE + 1}`;
  const { results } = await c.env.DB.prepare(sql).bind(...args).all<ThreadRow>();
  const hasMore = results.length > PAGE;
  const threads = results.slice(0, PAGE);
  return c.json({ threads, next_before: hasMore ? threads[threads.length - 1].last_message_at : null });
});

mail.get("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const thread = await c.env.DB.prepare(
    `SELECT t.*, m.address AS mailbox_address, m.display_name AS mailbox_display_name
     FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id WHERE t.id = ?`,
  )
    .bind(id)
    .first();
  if (!thread) return c.json({ error: "not found" }, 404);
  const { results: messages } = await c.env.DB.prepare(
    `SELECT id, direction, message_id_header, from_addr, from_name, to_json, cc_json, reply_to_addr, subject, text_body,
       has_html, size, auth_spf, auth_dkim, auth_dmarc, sent_by, sent_at, read_at, raw_key IS NOT NULL AS has_raw
     FROM messages WHERE thread_id = ? ORDER BY created_at, rowid`,
  )
    .bind(id)
    .all<Record<string, unknown> & { id: string; to_json: string; cc_json: string }>();
  const { results: atts } = await c.env.DB.prepare(
    `SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.content_id, a.disposition, a.is_executable
     FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?`,
  )
    .bind(id)
    .all<{ message_id: string }>();
  return c.json({
    thread,
    messages: messages.map((m) => ({
      ...m,
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      to_json: undefined,
      cc_json: undefined,
      attachments: atts.filter((a) => a.message_id === m.id),
    })),
  });
});

mail.post("/threads/:id/read", async (c) => {
  const id = c.req.param("id");
  const { read } = await c.req.json<{ read: boolean }>();
  const now = Math.floor(Date.now() / 1000);
  if (read) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE thread_id = ?").bind(now, id),
      c.env.DB.prepare("UPDATE threads SET unread_count = 0 WHERE id = ?").bind(id),
    ]);
  } else {
    await c.env.DB.prepare("UPDATE threads SET unread_count = MAX(unread_count, 1) WHERE id = ?").bind(id).run();
  }
  return c.json({ ok: true });
});

mail.post("/threads/:id/status", async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: string }>();
  if (status !== "open" && status !== "done") return c.json({ error: "status must be open|done" }, 400);
  await c.env.DB.prepare("UPDATE threads SET status = ? WHERE id = ?").bind(status, id).run();
  await audit(c.env.DB, c.get("admin"), "thread.status", id, { status });
  return c.json({ ok: true });
});

// Bulk actions from the inbox list. Delete = move to Trash; purge = delete forever
// (only for threads already in Trash).
const BULK_ACTIONS = ["delete", "restore", "read", "unread", "purge"] as const;

mail.post("/threads/bulk", async (c) => {
  const { ids, action } = await c.req.json<{ ids: string[]; action: (typeof BULK_ACTIONS)[number] }>();
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((i) => typeof i === "string")) {
    return c.json({ error: "ids must be 1-500 thread ids" }, 400);
  }
  if (!BULK_ACTIONS.includes(action)) return c.json({ error: `action must be one of ${BULK_ACTIONS.join(", ")}` }, 400);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  let affected = 0;
  if (action === "purge") {
    affected = await purgeThreads(c.env, ids);
  } else {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const m = chunk.map(() => "?").join(",");
      if (action === "delete") {
        affected += (await db.prepare(`UPDATE threads SET deleted_at = ? WHERE id IN (${m}) AND deleted_at IS NULL`).bind(now, ...chunk).run()).meta.changes;
      } else if (action === "restore") {
        affected += (await db.prepare(`UPDATE threads SET deleted_at = NULL WHERE id IN (${m}) AND deleted_at IS NOT NULL`).bind(...chunk).run()).meta.changes;
      } else if (action === "read") {
        const [, r] = await db.batch([
          db.prepare(`UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE thread_id IN (${m})`).bind(now, ...chunk),
          db.prepare(`UPDATE threads SET unread_count = 0 WHERE id IN (${m})`).bind(...chunk),
        ]);
        affected += r.meta.changes;
      } else {
        affected += (await db.prepare(`UPDATE threads SET unread_count = MAX(unread_count, 1) WHERE id IN (${m})`).bind(...chunk).run()).meta.changes;
      }
    }
  }
  if (action === "delete" || action === "restore" || action === "purge") {
    await audit(db, c.get("admin"), `thread.${action}`, null, { count: affected, ids: ids.slice(0, 50) });
  }
  return c.json({ ok: true, affected });
});

mail.post("/trash/empty", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM threads WHERE deleted_at IS NOT NULL").all<{ id: string }>();
  const affected = await purgeThreads(c.env, results.map((r) => r.id));
  await audit(c.env.DB, c.get("admin"), "trash.empty", null, { count: affected });
  return c.json({ ok: true, affected });
});

// HTML body as a standalone document. Served with a CSP sandbox (opaque origin,
// no scripts) and loaded by the UI in a sandboxed iframe. Remote images are
// blocked unless ?images=1. cid: inline images are embedded as data: URIs.
mail.get("/messages/:id/html", async (c) => {
  const id = c.req.param("id");
  const allowImages = c.req.query("images") === "1";
  const msg = await c.env.DB.prepare("SELECT html_key, text_body FROM messages WHERE id = ?").bind(id).first<{
    html_key: string | null;
    text_body: string | null;
  }>();
  if (!msg) return c.text("not found", 404);

  let html: string;
  if (msg.html_key) {
    const obj = await c.env.MAIL.get(msg.html_key);
    html = obj ? await obj.text() : "";
    const { results: inline } = await c.env.DB.prepare(
      "SELECT content_id, content_type, r2_key, size FROM attachments WHERE message_id = ? AND content_id IS NOT NULL AND size <= 2000000",
    )
      .bind(id)
      .all<{ content_id: string; content_type: string; r2_key: string; size: number }>();
    for (const a of inline.slice(0, 20)) {
      if (!html.includes(`cid:${a.content_id}`)) continue;
      const o = await c.env.MAIL.get(a.r2_key);
      if (!o) continue;
      const bytes = new Uint8Array(await o.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const type = /^image\/[a-z0-9.+-]+$/i.test(a.content_type) && a.content_type !== "image/svg+xml" ? a.content_type : "application/octet-stream";
      html = html.split(`cid:${a.content_id}`).join(`data:${type};base64,${btoa(bin)}`);
    }
  } else {
    const esc = (msg.text_body ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = `<pre style="white-space:pre-wrap;font:14px/1.5 system-ui,sans-serif">${esc}</pre>`;
  }

  const csp = [
    "sandbox allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    `img-src data:${allowImages ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">
<style>body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;color:#222;word-wrap:break-word}img{max-width:100%;height:auto}</style>
</head><body>${html}</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=300",
    },
  });
});

mail.get("/messages/:id/raw", async (c) => {
  const msg = await c.env.DB.prepare("SELECT raw_key, subject FROM messages WHERE id = ?").bind(c.req.param("id")).first<{
    raw_key: string | null;
    subject: string;
  }>();
  if (!msg?.raw_key) return c.text("not found", 404);
  const obj = await c.env.MAIL.get(msg.raw_key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="message.eml"; filename*=UTF-8''${encodeURIComponent((msg.subject || "message").slice(0, 80))}.eml`,
      "x-content-type-options": "nosniff",
    },
  });
});

mail.get("/attachments/:id", async (c) => {
  const a = await c.env.DB.prepare("SELECT filename, content_type, r2_key FROM attachments WHERE id = ?").bind(c.req.param("id")).first<{
    filename: string | null;
    content_type: string | null;
    r2_key: string;
  }>();
  if (!a) return c.text("not found", 404);
  const obj = await c.env.MAIL.get(a.r2_key);
  if (!obj) return c.text("not found", 404);
  const name = a.filename || "attachment";
  // Always a download, never rendered inline on our origin.
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
});

interface OutAttachment {
  filename: string;
  type: string;
  content: string; // base64
}

interface OutgoingBody {
  html: string;
  text?: string;
  cc?: string[];
  attachments?: OutAttachment[];
}

const MAX_OUT_BYTES = 5 * 1024 * 1024; // Cloudflare Email Sending per-message limit

function validateOutgoing(b: OutgoingBody): string | null {
  if (typeof b.html !== "string" || !b.html.trim()) return "body required";
  if (b.cc && (!Array.isArray(b.cc) || !b.cc.every(isEmail))) return "invalid cc";
  let size = b.html.length + (b.text?.length ?? 0);
  for (const a of b.attachments ?? []) {
    if (typeof a.filename !== "string" || typeof a.content !== "string" || typeof a.type !== "string") return "invalid attachment";
    size += Math.floor((a.content.length * 3) / 4);
  }
  if (size > MAX_OUT_BYTES) return "message exceeds 5 MB";
  return null;
}

async function sendAndStore(
  env: AdminVars["Bindings"],
  admin: string,
  opts: {
    mailbox: { id: string; address: string; display_name: string | null };
    threadId: string;
    newThread: boolean;
    to: string;
    subject: string;
    body: OutgoingBody;
    inReplyTo?: string;
    references?: string[];
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { mailbox, body } = opts;
  const text = body.text ?? stripHtml(body.html).replace(/\s+\n/g, "\n").trim();
  const headers: Record<string, string> = {};
  if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
  if (opts.references?.length) headers["References"] = opts.references.slice(-50).join(" ");

  const provider = new CloudflareProvider(env.EMAIL);
  const res = await provider.send({
    from: { email: mailbox.address, ...(mailbox.display_name ? { name: mailbox.display_name } : {}) },
    to: opts.to,
    subject: opts.subject,
    html: body.html,
    text,
    cc: body.cc,
    headers,
    attachments: body.attachments?.map((a) => ({
      disposition: "attachment" as const,
      filename: a.filename.slice(0, 200),
      type: a.type || "application/octet-stream",
      content: a.content,
    })),
  });
  if (!res.ok) return { ok: false, error: `${res.code}: ${res.message}` };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const htmlKey = `html/${mailbox.id}/${id}.html`;
  await env.MAIL.put(htmlKey, body.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  const stmts: D1PreparedStatement[] = [];
  const snippet = text.replace(/\s+/g, " ").slice(0, 200);
  if (opts.newThread) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO threads (id, mailbox_id, subject, subject_normalized, counterpart, snippet, message_count, unread_count, status, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'open', ?)`,
      ).bind(opts.threadId, mailbox.id, opts.subject, normalizeSubject(opts.subject), opts.to, snippet, now),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO messages (id, thread_id, mailbox_id, direction, message_id_header, in_reply_to, references_chain, from_addr,
         from_name, to_json, cc_json, subject, snippet, text_body, has_html, html_key, size, sent_by, sent_at, read_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      opts.threadId,
      mailbox.id,
      res.messageId,
      opts.inReplyTo ?? null,
      opts.references?.join(" ") || null,
      mailbox.address,
      mailbox.display_name,
      JSON.stringify([{ addr: opts.to }]),
      JSON.stringify((body.cc ?? []).map((addr) => ({ addr }))),
      opts.subject,
      snippet,
      text.slice(0, MAX_TEXT_CHARS),
      htmlKey,
      body.html.length,
      admin,
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE threads SET message_count = message_count + 1, last_message_at = ?, snippet = ? WHERE id = ?",
    ).bind(now, snippet, opts.threadId),
  );
  // Outbound attachments are kept so the thread shows what was sent.
  for (const a of body.attachments ?? []) {
    const attId = crypto.randomUUID();
    const key = `att/${id}/${attId}`;
    const bin = Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0));
    await env.MAIL.put(key, bin);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, content_type, size, disposition, r2_key) VALUES (?, ?, ?, ?, ?, 'attachment', ?)",
      ).bind(attId, id, a.filename, a.type, bin.byteLength, key),
    );
  }
  await env.DB.batch(stmts);
  await audit(env.DB, admin, "mail.send", opts.threadId, { to: opts.to, message_id: res.messageId });
  return { ok: true, id };
}

// Reply in a thread. From is always the thread's mailbox; the client cannot choose it.
mail.post("/threads/:id/reply", async (c) => {
  const threadId = c.req.param("id");
  const body = await c.req.json<OutgoingBody>();
  const bad = validateOutgoing(body);
  if (bad) return c.json({ error: bad }, 400);

  const t = await c.env.DB.prepare(
    `SELECT t.id, t.subject, m.id AS mailbox_id, m.address, m.display_name FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id WHERE t.id = ?`,
  )
    .bind(threadId)
    .first<{ id: string; subject: string; mailbox_id: string; address: string; display_name: string | null }>();
  if (!t) return c.json({ error: "not found" }, 404);

  const last = await c.env.DB.prepare(
    `SELECT direction, message_id_header, references_chain, from_addr, reply_to_addr, to_json FROM messages
     WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(threadId)
    .first<{ direction: string; message_id_header: string | null; references_chain: string | null; from_addr: string; reply_to_addr: string | null; to_json: string }>();
  const lastIn = await c.env.DB.prepare(
    "SELECT from_addr, reply_to_addr FROM messages WHERE thread_id = ? AND direction = 'in' ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(threadId)
    .first<{ from_addr: string; reply_to_addr: string | null }>();

  let to: string | undefined;
  if (lastIn) to = lastIn.reply_to_addr ?? lastIn.from_addr;
  else if (last) to = (JSON.parse(last.to_json) as { addr: string }[])[0]?.addr;
  if (!to || !isEmail(to)) return c.json({ error: "no valid recipient in thread" }, 400);

  const subject = /^\s*(re|回复)\s*[:：]/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
  const refs = [...(last?.references_chain?.split(" ").filter(Boolean) ?? []), ...(last?.message_id_header ? [last.message_id_header] : [])];
  const result = await sendAndStore(c.env, c.get("admin"), {
    mailbox: { id: t.mailbox_id, address: t.address, display_name: t.display_name },
    threadId,
    newThread: false,
    to,
    subject,
    body,
    inReplyTo: last?.message_id_header ?? undefined,
    references: refs,
  });
  if (!result.ok) return c.json({ error: result.error }, 502);
  return c.json({ ok: true, message_id: result.id });
});

// Start a new conversation from one of our mailboxes.
mail.post("/compose", async (c) => {
  const body = await c.req.json<OutgoingBody & { mailbox_id: string; to: string; subject: string }>();
  if (!isEmail(body.to)) return c.json({ error: "invalid recipient" }, 400);
  if (typeof body.subject !== "string" || !body.subject.trim()) return c.json({ error: "subject required" }, 400);
  const bad = validateOutgoing(body);
  if (bad) return c.json({ error: bad }, 400);
  const mb = await c.env.DB.prepare("SELECT id, address, display_name FROM mailboxes WHERE id = ?")
    .bind(body.mailbox_id)
    .first<{ id: string; address: string; display_name: string | null }>();
  if (!mb) return c.json({ error: "unknown mailbox" }, 400);
  const threadId = crypto.randomUUID();
  const result = await sendAndStore(c.env, c.get("admin"), {
    mailbox: mb,
    threadId,
    newThread: true,
    to: body.to.toLowerCase(),
    subject: body.subject.replace(/[\r\n]+/g, " ").trim(),
    body,
  });
  if (!result.ok) return c.json({ error: result.error }, 502);
  return c.json({ ok: true, thread_id: threadId });
});
