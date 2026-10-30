import type { Env } from "../env";

export const TRASH_RETENTION_DAYS = 30;

// Permanently removes trashed threads: R2 objects (raw .eml, HTML, attachments)
// and D1 rows. Only threads already in Trash are touched.
export async function purgeThreads(env: Env, ids: string[]): Promise<number> {
  let purged = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    const { results: trashed } = await env.DB.prepare(`SELECT id FROM threads WHERE id IN (${marks}) AND deleted_at IS NOT NULL`)
      .bind(...chunk)
      .all<{ id: string }>();
    if (trashed.length === 0) continue;
    const tids = trashed.map((t) => t.id);
    const tm = tids.map(() => "?").join(",");
    const [{ results: msgs }, { results: atts }] = await env.DB.batch([
      env.DB.prepare(`SELECT raw_key, html_key FROM messages WHERE thread_id IN (${tm})`).bind(...tids),
      env.DB.prepare(`SELECT a.r2_key FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id IN (${tm})`).bind(...tids),
    ]) as [D1Result<{ raw_key: string | null; html_key: string | null }>, D1Result<{ r2_key: string }>];
    const keys = [...msgs.flatMap((m) => [m.raw_key, m.html_key]), ...atts.map((a) => a.r2_key)].filter((k): k is string => !!k);
    for (let k = 0; k < keys.length; k += 1000) await env.MAIL.delete(keys.slice(k, k + 1000));
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id IN (${tm}))`).bind(...tids),
      env.DB.prepare(`DELETE FROM messages WHERE thread_id IN (${tm})`).bind(...tids),
      env.DB.prepare(`DELETE FROM threads WHERE id IN (${tm})`).bind(...tids),
    ]);
    purged += tids.length;
  }
  return purged;
}

export async function purgeExpiredTrash(env: Env): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - TRASH_RETENTION_DAYS * 86400;
  const { results } = await env.DB.prepare("SELECT id FROM threads WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 2000")
    .bind(cutoff)
    .all<{ id: string }>();
  return purgeThreads(env, results.map((r) => r.id));
}
