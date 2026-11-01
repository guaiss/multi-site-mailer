// Provider abstraction so SES (or another service) can be added later without
// touching request handling.

export interface OutboundMessage {
  from: { email: string; name?: string };
  to: string;
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  headers?: Record<string, string>;
  attachments?: EmailAttachment[]; // content as base64 string
}

export type ProviderResult =
  | { ok: true; messageId: string | null }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface Provider {
  name: string;
  send(msg: OutboundMessage): Promise<ProviderResult>;
}

// Errors where retrying the same request later can succeed.
const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED"]);

export class CloudflareProvider implements Provider {
  name = "cloudflare";
  constructor(private binding: SendEmail) {}

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    try {
      // The binding requires name: string on an EmailAddress object. Use the
      // supported plain-address form when the sender has no display name.
      const from = msg.from.name ? { email: msg.from.email, name: msg.from.name } : msg.from.email;
      const res = (await this.binding.send({
        from,
        to: msg.to,
        subject: msg.subject,
        ...(msg.html !== undefined ? { html: msg.html } : {}),
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        ...(msg.cc?.length ? { cc: msg.cc } : {}),
        ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      }));
      return { ok: true, messageId: res?.messageId ?? null };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code ?? "E_UNKNOWN";
      return { ok: false, code, message: String(err.message ?? e).slice(0, 500), retryable: RETRYABLE.has(code) || code === "E_UNKNOWN" };
    }
  }
}
