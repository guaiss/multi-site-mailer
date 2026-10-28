import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    credentials: "same-origin",
    headers: init?.body !== undefined || (init?.method && init.method !== "GET") ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : init?.method && init.method !== "GET" ? "{}" : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as { error?: unknown } | null)?.error;
    const msg = typeof e === "string" ? e : (e as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const fmtTime = (unix: number) => dayjs.unix(unix).format("MMM D, YYYY, HH:mm");
export const fromNow = (unix: number) => {
  const d = dayjs.unix(unix);
  return dayjs().diff(d, "day") < 1 ? d.fromNow() : d.format(dayjs().isSame(d, "year") ? "MMM D, HH:mm" : "MMM D, YYYY");
};
export const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const MAX_SEND_BYTES = 5 * 1024 * 1024;

// ---- types ----

export interface Mailbox {
  id: string;
  address: string;
  local_part: string;
  display_name: string | null;
  domain_id: string;
  domain: string;
  open_count: number;
  unread_count: number;
}

export interface ThreadSummary {
  id: string;
  mailbox_id: string;
  mailbox_address: string;
  subject: string;
  counterpart: string | null;
  snippet: string;
  message_count: number;
  unread_count: number;
  status: "open" | "done";
  last_message_at: number;
}

export interface Attachment {
  id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  is_executable: number;
  content_id: string | null;
  disposition: string | null;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  from_addr: string;
  from_name: string | null;
  to: { addr: string; name?: string }[];
  cc: { addr: string; name?: string }[];
  reply_to_addr: string | null;
  subject: string;
  text_body: string | null;
  has_html: number;
  size: number;
  auth_spf: string | null;
  auth_dkim: string | null;
  auth_dmarc: string | null;
  sent_by: string | null;
  sent_at: number;
  has_raw: number;
  attachments: Attachment[];
}

export interface ThreadDetail {
  thread: ThreadSummary & { mailbox_display_name: string | null };
  messages: Message[];
}

export interface OutAttachment {
  filename: string;
  type: string;
  content: string;
}

export interface Site {
  id: string;
  name: string;
  status: "active" | "disabled";
  daily_quota: number;
  created_at: string;
}
export interface Sender {
  site_id: string;
  address: string;
  display_name: string | null;
  is_default: number;
}
export interface ApiKey {
  id: string;
  site_id: string;
  key_prefix: string;
  key_plain: string | null;
  created_at: string;
  revoked_at: string | null;
}
export interface SitesResponse {
  sites: Site[];
  senders: Sender[];
  keys: ApiKey[];
  usage_today: { site_id: string; sent: number; failed: number }[];
}
export interface Domain {
  id: string;
  name: string;
  created_at: number;
  mailbox_count: number;
}
export interface Template {
  site_id: string;
  name: string;
  subject: string;
  html: string | null;
  text: string | null;
  updated_at: string;
}
