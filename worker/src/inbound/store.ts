import { MAX_TEXT_CHARS, type Env } from "../env";
import { parseEmail, stripHtml, type ParsedMessage } from "./parse";
import { findThread, normalizeSubject } from "./thread";

export interface MailboxRow {
  id: string;
  address: string;
}

export async function findMailbox(db: D1Database, address: string): Promise<MailboxRow | null> {
  return db.prepare("SELECT id, address FROM mailboxes WHERE address = ?").bind(address.toLowerCase()).first<MailboxRow>();
}

function safeName(name: string | null, fallback: string): string {
  const n = (name ?? "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120).trim();
  return n || fallback;
}

// Stores an inbound message. Returns the message id, or null if it was a duplicate.
export async function storeInbound(env: Env, mailbox: MailboxRow, raw: ArrayBuffer): Promise<string | null> {
  const parsed: ParsedMessage = await parseEmail(raw, env.TRUSTED_AUTHSERV_ID);

  // Duplicate delivery (MX retry after a partial failure): same Message-ID in same mailbox.
  const dup = await env.DB
    .prepare("SELECT id FROM messages WHERE mailbox_id = ? AND message_id_header = ? AND direction = 'in' LIMIT 1")
    .bind(mailbox.id, parsed.messageId)
    .first();
  if (dup) return null;

  const id = crypto.randomUUID();
  const counterpart = (parsed.replyToAddr ?? parsed.from.addr).toLowerCase() || null;
  const subjectNormalized = normalizeSubject(parsed.subject);
  const existingThread = await findThread(
    env.DB,
    mailbox.id,
    [...parsed.references, parsed.inReplyTo ?? ""],
    subjectNormalized,
    counterpart,
  );
  const threadId = existingThread ?? crypto.randomUUID();
  const sentAt = Math.floor(parsed.date / 1000);
  const now = Math.floor(Date.now() / 1000);

  // R2 first: if D1 fails afterwards the MX retries and we overwrite the same keys.
  const rawKey = `raw/${mailbox.id}/${id}.eml`;
  await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
  let htmlKey: string | null = null;
  if (parsed.html) {
    htmlKey = `html/${mailbox.id}/${id}.html`;
    await env.MAIL.put(htmlKey, parsed.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  }

  const attRows: { id: string; key: string; a: ParsedMessage["attachments"][number] }[] = [];
  for (const a of parsed.attachments) {
    const attId = crypto.randomUUID();
    const key = `att/${id}/${attId}`;
    await env.MAIL.put(key, a.bytes, {
      httpMetadata: { contentType: a.contentType || "application/octet-stream" },
      customMetadata: { filename: safeName(a.filename, "attachment") },
    });
    attRows.push({ id: attId, key, a });
  }

  const text = (parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "")).slice(0, MAX_TEXT_CHARS);
  const stmts: D1PreparedStatement[] = [];
  if (!existingThread) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO threads (id, mailbox_id, subject, subject_normalized, counterpart, snippet, message_count, unread_count, status, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'open', ?)`,
      ).bind(threadId, mailbox.id, parsed.subject || "(no subject)", subjectNormalized, counterpart, parsed.snippet, now),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO messages (id, thread_id, mailbox_id, direction, message_id_header, in_reply_to, references_chain,
         from_addr, from_name, to_json, cc_json, reply_to_addr, subject, snippet, text_body, has_html, raw_key, html_key, size,
         auth_spf, auth_dkim, auth_dmarc, sent_at)
       VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      threadId,
      mailbox.id,
      parsed.messageId,
      parsed.inReplyTo ?? null,
      parsed.references.join(" ") || null,
      parsed.from.addr.toLowerCase(),
      parsed.from.name ?? null,
      JSON.stringify(parsed.to),
      JSON.stringify(parsed.cc),
      parsed.replyToAddr,
      parsed.subject || "(no subject)",
      parsed.snippet,
      text,
      parsed.html ? 1 : 0,
      rawKey,
      htmlKey,
      raw.byteLength,
      parsed.authResults?.spf ?? null,
      parsed.authResults?.dkim ?? null,
      parsed.authResults?.dmarc ?? null,
      sentAt,
    ),
  );
  for (const { id: attId, key, a } of attRows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, is_executable, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(attId, id, a.filename, a.contentType, a.bytes.byteLength, a.contentId ?? null, a.disposition, a.isExecutable ? 1 : 0, key),
    );
  }
  // New inbound mail reopens the thread and bumps it to the top. Ordering uses
  // receipt time, not the sender-controlled Date header.
  stmts.push(
    env.DB.prepare(
      `UPDATE threads SET message_count = message_count + 1, unread_count = unread_count + 1, status = 'open',
         snippet = ?, counterpart = COALESCE(?, counterpart), last_message_at = MAX(last_message_at, ?) WHERE id = ?`,
    ).bind(parsed.snippet, counterpart, now, threadId),
  );
  await env.DB.batch(stmts);
  return id;
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const to = message.to.toLowerCase();
  const mailbox = await findMailbox(env.DB, to);
  if (!mailbox) {
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > 20 * 1024 * 1024) {
    message.setReject("Message too large (max 20 MB)");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  try {
    const id = await storeInbound(env, mailbox, raw);
    console.log(JSON.stringify({ evt: "inbound", mailbox: mailbox.address, id, duplicate: id === null, size: raw.byteLength }));
  } catch (e) {
    console.error(JSON.stringify({ evt: "inbound_error", mailbox: mailbox.address, error: String((e as Error)?.message ?? e) }));
    // Rethrow so Email Routing reports a temporary failure and the sender's MX retries.
    throw e;
  }
}
