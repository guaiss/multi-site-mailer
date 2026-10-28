// MIME parsing for inbound mail. Adapted from Orange Inbox email-worker/src/parse.ts
// (MIT), trimmed to what the support inbox needs.
import PostalMime, { type Address, type Attachment, type Header } from "postal-mime";
import { isExecutable } from "./attachment-safety";
import { extractAuthservId, parseAuthenticationResults, type AuthResults } from "./auth-results";

export interface AddressInfo {
  addr: string;
  name?: string;
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  disposition: string | null;
  contentId?: string;
  bytes: ArrayBuffer;
  isExecutable: boolean;
}

export interface ParsedMessage {
  messageId: string;
  inReplyTo?: string;
  references: string[];
  from: AddressInfo;
  to: AddressInfo[];
  cc: AddressInfo[];
  replyToAddr: string | null;
  subject: string;
  date: number; // ms
  text?: string;
  html?: string;
  snippet: string;
  attachments: ParsedAttachment[];
  authResults: AuthResults | null;
}

export async function parseEmail(raw: ArrayBuffer | ReadableStream, trustedAuthservId?: string): Promise<ParsedMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const from = flattenOne(parsed.from) ?? { addr: "" };

  // SECURITY: only trust the Authentication-Results header our MX prepended
  // (first one, or the one matching TRUSTED_AUTHSERV_ID). Never merge.
  const authHeaders = collectHeaders(parsed.headers, "authentication-results");
  const trusted = selectTrustedAuthResultsHeader(authHeaders, trustedAuthservId);

  const replyTo = flattenOne(parsed.replyTo?.[0]);
  const replyToLower = replyTo?.addr?.toLowerCase() ?? null;

  return {
    messageId: parsed.messageId ?? `<${crypto.randomUUID()}@mailer.local>`,
    inReplyTo: parsed.inReplyTo,
    references: splitReferences(parsed.references),
    from,
    to: flattenMany(parsed.to),
    cc: flattenMany(parsed.cc),
    replyToAddr: replyToLower && replyToLower !== from.addr.toLowerCase() ? replyToLower : null,
    subject: parsed.subject ?? "",
    date: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
    text: parsed.text,
    html: parsed.html,
    snippet: makeSnippet(parsed.text, parsed.html),
    attachments: (parsed.attachments ?? []).map(toParsedAttachment),
    authResults: parseAuthenticationResults(trusted),
  };
}

function collectHeaders(headers: Header[] | undefined, lowerName: string): string[] {
  return (headers ?? []).filter((h) => h.key.toLowerCase() === lowerName && h.value).map((h) => h.value);
}

function selectTrustedAuthResultsHeader(headers: string[], trustedAuthservId?: string): string | null {
  if (headers.length === 0) return null;
  const trusted = trustedAuthservId?.trim().toLowerCase();
  if (trusted) return headers.find((h) => extractAuthservId(h) === trusted) ?? null;
  return headers[0];
}

export function splitReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function flattenOne(addr: Address | undefined): AddressInfo | undefined {
  if (!addr) return undefined;
  if ("address" in addr && addr.address) return { addr: addr.address, name: addr.name || undefined };
  if ("group" in addr && addr.group) return flattenOne(addr.group[0]);
  return undefined;
}

function flattenMany(addrs: Address[] | undefined): AddressInfo[] {
  const out: AddressInfo[] = [];
  for (const a of addrs ?? []) {
    if ("address" in a && a.address) out.push({ addr: a.address, name: a.name || undefined });
    else if ("group" in a && a.group) for (const m of a.group) out.push({ addr: m.address, name: m.name || undefined });
  }
  return out;
}

export function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text || (html ? stripHtml(html) : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function toParsedAttachment(a: Attachment): ParsedAttachment {
  const filename = a.filename ?? null;
  return {
    filename,
    contentType: a.mimeType,
    disposition: a.disposition ?? null,
    contentId: a.contentId?.replace(/^<|>$/g, ""),
    bytes: toArrayBuffer(a.content),
    isExecutable: isExecutable(filename, a.mimeType),
  };
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}
