import type { Vars } from "./template";

// Deliberately strict: one recipient, plain address, no display-name parsing.
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);
}

export interface SendRequest {
  to: string;
  from?: string;
  reply_to?: string;
  template?: string;
  variables: Vars;
  subject?: string;
  html?: string;
  text?: string;
  idempotency_key?: string;
}

export type Parsed = { ok: true; req: SendRequest } | { ok: false; error: string };

const MAX_BODY = 512 * 1024;

export function parseSendRequest(body: unknown, headerIdemKey: string | null): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (!isEmail(b.to)) return { ok: false, error: "`to` must be a single email address" };
  for (const f of ["from", "reply_to"] as const) {
    if (b[f] !== undefined && !isEmail(b[f])) return { ok: false, error: `\`${f}\` must be an email address` };
  }

  const hasTemplate = b.template !== undefined;
  const hasRaw = b.subject !== undefined || b.html !== undefined || b.text !== undefined;
  if (hasTemplate === hasRaw) return { ok: false, error: "provide either `template` or `subject` + `html`/`text`" };
  if (hasTemplate && (typeof b.template !== "string" || !/^[a-z0-9_]{1,64}$/.test(b.template))) {
    return { ok: false, error: "`template` must match [a-z0-9_]{1,64}" };
  }
  if (hasRaw) {
    if (typeof b.subject !== "string" || !b.subject.trim()) return { ok: false, error: "`subject` required" };
    if (b.html === undefined && b.text === undefined) return { ok: false, error: "`html` or `text` required" };
    for (const f of ["html", "text"] as const) {
      if (b[f] !== undefined && typeof b[f] !== "string") return { ok: false, error: `\`${f}\` must be a string` };
    }
    if (((b.html as string)?.length ?? 0) + ((b.text as string)?.length ?? 0) > MAX_BODY) {
      return { ok: false, error: "body too large" };
    }
  }

  let variables: Vars = {};
  if (b.variables !== undefined) {
    if (!b.variables || typeof b.variables !== "object" || Array.isArray(b.variables)) {
      return { ok: false, error: "`variables` must be an object" };
    }
    for (const [k, v] of Object.entries(b.variables)) {
      if (!["string", "number", "boolean"].includes(typeof v)) return { ok: false, error: `variable \`${k}\` must be a scalar` };
    }
    variables = b.variables as Vars;
  }

  const idem = headerIdemKey ?? b.idempotency_key;
  if (idem !== undefined && idem !== null && (typeof idem !== "string" || idem.length < 1 || idem.length > 200)) {
    return { ok: false, error: "`idempotency_key` must be 1-200 chars" };
  }

  return {
    ok: true,
    req: {
      to: (b.to as string).toLowerCase(),
      from: (b.from as string | undefined)?.toLowerCase(),
      reply_to: b.reply_to as string | undefined,
      template: b.template as string | undefined,
      variables,
      subject: b.subject as string | undefined,
      html: b.html as string | undefined,
      text: b.text as string | undefined,
      idempotency_key: (idem as string | undefined) ?? undefined,
    },
  };
}
