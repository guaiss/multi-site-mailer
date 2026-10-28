// Thread matching. Adapted from Orange Inbox email-worker/src/thread.ts (MIT).
// Strategy, scoped to one mailbox:
//   1. References / In-Reply-To hit an existing message's Message-ID.
//   2. Same normalized subject AND same counterpart within 14 days.
//   3. New thread.

const SUBJECT_FALLBACK_WINDOW_S = 60 * 60 * 24 * 14;

export function normalizeSubject(subject: string | undefined): string {
  let s = (subject ?? "").trim();
  while (true) {
    const stripped = s.replace(/^\s*(?:re|fwd|fw|aw|tr|antw|回复|答复|转发)\s*[:：]\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}

export async function findThread(
  db: D1Database,
  mailboxId: string,
  candidates: string[],
  subjectNormalized: string,
  counterpart: string | null,
): Promise<string | null> {
  const ids = [...new Set(candidates.filter(Boolean))].slice(-50);
  if (ids.length > 0) {
    const hit = await db
      .prepare(
        `SELECT thread_id FROM messages WHERE mailbox_id = ? AND message_id_header IN (${ids.map(() => "?").join(",")})
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .bind(mailboxId, ...ids)
      .first<{ thread_id: string }>();
    if (hit) return hit.thread_id;
  }

  // Subject fallback requires the same counterpart so two customers who both
  // write "Order problem" don't end up in one thread.
  if (!counterpart) return null;
  const cutoff = Math.floor(Date.now() / 1000) - SUBJECT_FALLBACK_WINDOW_S;
  const subj = await db
    .prepare(
      `SELECT id FROM threads WHERE mailbox_id = ? AND subject_normalized = ? AND counterpart = ? AND last_message_at >= ?
       ORDER BY last_message_at DESC LIMIT 1`,
    )
    .bind(mailboxId, subjectNormalized, counterpart, cutoff)
    .first<{ id: string }>();
  return subj?.id ?? null;
}
