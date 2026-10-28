# Mailer Send API — integration guide for AI coding agents

You are integrating a website backend with an internal transactional email service.
Follow this document exactly. Do not guess fields that are not listed here.

## What this service does

- Sends **transactional** email (sign-in codes, password resets, order/billing notices) from the website's own domain, e.g. `no-reply@example.com`.
- Marketing / bulk email is **not allowed**. Send to one recipient per request.
- It does **not** generate, store, or verify codes. The website owns code generation, expiry, verification, and per-user rate limiting. This service only delivers the email.

## Credentials (ask the human for these; never invent or hard-code them)

| Env var | Value |
|---|---|
| `MAILER_API_URL` | `{{BASE_URL}}/api/v1/send` |
| `MAILER_API_KEY` | Site API key, starts with `mk_`. Created by an admin in the Mailer admin UI (Sites & Keys), where it can be viewed and copied. |

- Read both from environment variables / secret manager. Never commit the key, never log it, never send it to a browser or mobile client. Call the API **server-side only**.
- Each key belongs to exactly one site and may only send from that site's allow-listed From addresses. If the human hasn't set up a site/key yet, tell them to do it in the admin UI at `{{BASE_URL}}` → Sites & Keys.

## Request

```
POST {{BASE_URL}}/api/v1/send
Authorization: Bearer <MAILER_API_KEY>
Content-Type: application/json
Idempotency-Key: <unique id for this logical email>      (strongly recommended)
```

Body is a JSON object. Use **either** a template **or** raw content — not both.

### Option A — template (preferred)

```json
{
  "to": "user@example.org",
  "template": "login_code",
  "variables": { "code": "482916", "expires_minutes": 10 }
}
```

### Option B — raw content

```json
{
  "to": "user@example.org",
  "subject": "Your order #1042 has shipped",
  "html": "<p>Good news! Your order is on its way.</p>",
  "text": "Good news! Your order is on its way."
}
```

### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string | yes | Exactly one plain email address. No arrays, no display names (`"Name <a@b.c>"` is rejected). |
| `template` | string | A | Template name, `[a-z0-9_]{1,64}`. |
| `variables` | object | with A | Flat object; values must be string, number, or boolean. Every `{{var}}` used by the template must be present, otherwise 400. |
| `subject` | string | B | Non-empty. Newlines are stripped. |
| `html` | string | B (html or text) | Full HTML body. You are responsible for escaping user data you put into it. |
| `text` | string | B (html or text) | Plain-text body. Provide both `html` and `text` when possible. |
| `from` | string | no | Must be one of the site's allow-listed addresses; omit to use the site's default sender. |
| `reply_to` | string | no | Single email address. |
| `idempotency_key` | string | no | 1–200 chars. Same as the `Idempotency-Key` header (header wins if both are sent). |

Limits: body (html + text) ≤ 512 KB; 60 requests/minute per site; per-site daily quota (set by admin).

### Built-in templates

| Name | Variables | Purpose |
|---|---|---|
| `login_code` | `code`, `expires_minutes` | One-time sign-in / verification code |
| `password_reset` | `reset_url`, `expires_minutes` | Password reset link |

`site_name` is injected automatically (the site's display name). In templates, variables are HTML-escaped automatically. Admins can add or override templates per site in the admin UI (Templates); ask the human for the template name and variables if you need something else.

## Response

Success — HTTP 200:
```json
{ "id": "38f1affd-…", "status": "sent", "provider_message_id": "<…@example.com>" }
```
A repeated request with the same idempotency key returns the original result plus `"replayed": true` and does **not** send again.

Errors — JSON `{ "error": { "code": "<code>", "message": "<text>" } }`:

| HTTP | `error.code` (examples) | Meaning | What your code should do |
|---|---|---|---|
| 400 | `invalid_request`, `invalid_json`, `template_error`, `unknown_template` | Bad input | Fix the request. Do not retry. |
| 401 | `unauthorized` | Missing/invalid/revoked key | Config error. Do not retry. Alert. |
| 403 | `site_disabled`, `sender_not_allowed` | Site disabled, or `from` not allow-listed | Config error. Do not retry. |
| 409 | `in_progress` | Same idempotency key is being processed | Retry after ~1 s with the same key. |
| 422 | `idempotency_conflict` | Same idempotency key reused with a different body | Bug: use a new key per distinct email. |
| 429 | `rate_limited`, `daily_quota_exceeded` | Too many requests | Retry after `Retry-After` seconds (rate limit) or fail gracefully (quota). |
| 502 | provider code, e.g. `E_RECIPIENT_SUPPRESSED`, `E_VALIDATION_ERROR` | Provider rejected this message | Do not retry. Show a generic "couldn't send email" message. |
| 503 | provider code, e.g. `E_RATE_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR` | Temporary failure | Retry with backoff using the **same** idempotency key. |
| 500 | `internal` | Service error | Retry with backoff using the same idempotency key. |

## Idempotency rules (important)

- Generate one idempotency key per **logical email**, e.g. `login-<loginAttemptId>`, `reset-<resetTokenId>`, `order-shipped-<orderId>`.
- Reuse that same key for every retry of that email. Never reuse it for a different email.
- Without a key, a network retry can deliver the email twice.

## Reference implementations

### Node.js (18+, no dependencies)

```js
// lib/mailer.js
const MAILER_API_URL = process.env.MAILER_API_URL ?? "{{BASE_URL}}/api/v1/send";

export class MailerError extends Error {
  constructor(status, code, message) {
    super(`mailer ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/**
 * Send one transactional email.
 * @param {{to: string, template?: string, variables?: Record<string, string|number|boolean>,
 *          subject?: string, html?: string, text?: string, from?: string, replyTo?: string,
 *          idempotencyKey: string}} msg
 */
export async function sendMail(msg) {
  const body = {
    to: msg.to,
    ...(msg.template ? { template: msg.template, variables: msg.variables ?? {} } : { subject: msg.subject, html: msg.html, text: msg.text }),
    ...(msg.from ? { from: msg.from } : {}),
    ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(MAILER_API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.MAILER_API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": msg.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      lastErr = e; // network error / timeout: retry with the same key
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res.json();
    const data = await res.json().catch(() => ({}));
    const err = new MailerError(res.status, data?.error?.code ?? "unknown", data?.error?.message ?? "");
    const retryable = res.status >= 500 && res.status !== 502 || res.status === 409 || (res.status === 429 && err.code === "rate_limited");
    if (!retryable) throw err;
    lastErr = err;
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 500 * 2 ** attempt)));
  }
  throw lastErr;
}

// Usage — sign-in code (the app generates/stores/verifies the code itself):
// await sendMail({ to: user.email, template: "login_code",
//   variables: { code, expires_minutes: 10 }, idempotencyKey: `login-${attempt.id}` });
```

### Python (requests)

```python
import os, time, requests

MAILER_API_URL = os.environ.get("MAILER_API_URL", "{{BASE_URL}}/api/v1/send")

def send_mail(to, idempotency_key, template=None, variables=None, subject=None, html=None, text=None):
    body = {"to": to}
    if template:
        body.update(template=template, variables=variables or {})
    else:
        body.update(subject=subject, html=html, text=text)
    for attempt in range(3):
        try:
            r = requests.post(MAILER_API_URL, json=body, timeout=10, headers={
                "Authorization": f"Bearer {os.environ['MAILER_API_KEY']}",
                "Idempotency-Key": idempotency_key,
            })
        except requests.RequestException:
            time.sleep(0.5 * 2 ** attempt)
            continue
        if r.ok:
            return r.json()
        code = (r.json().get("error") or {}).get("code") if r.headers.get("content-type", "").startswith("application/json") else None
        retryable = (r.status_code >= 500 and r.status_code != 502) or r.status_code == 409 or (r.status_code == 429 and code == "rate_limited")
        if not retryable:
            raise RuntimeError(f"mailer {r.status_code} {code}: {r.text}")
        time.sleep(max(float(r.headers.get("Retry-After", 0)), 0.5 * 2 ** attempt))
    raise RuntimeError("mailer unavailable")
```

### curl (manual test)

```sh
curl -X POST "$MAILER_API_URL" \
  -H "Authorization: Bearer $MAILER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d '{"to":"you@example.org","template":"login_code","variables":{"code":"123456","expires_minutes":10}}'
```

## Checklist for the integration you write

1. Key and URL come from env vars; the key never reaches client-side code or logs.
2. Calls happen server-side, with a 10 s timeout.
3. Every call passes a deterministic idempotency key; retries reuse it.
4. Retry only 409 / 429 `rate_limited` / 5xx except 502; never retry 400/401/403/422/502.
5. Don't log codes, reset URLs, or template variables.
6. The app rate-limits by recipient, IP, and account (for example, one sign-in code per email per 60 s). The service's 60/min limit is only a per-site backstop.
7. A send failure must not crash the user flow: show "We couldn't send the email, please try again" and log the error code.
8. Use `template` for codes and resets. Use raw `html`/`text` only for content that has no template, and escape any user-provided data you insert.

## Do not

- Send marketing, newsletters, or bulk mail. Every recipient must have triggered the email.
- Put the API key in frontend code, mobile apps, or public repos.
- Set `from` to an address the human hasn't allow-listed (you'll get 403).
- Send arrays in `to`, or display-name formats.
- Call admin endpoints (`/api/admin/*`); they need a browser login and are not for machines. Your only endpoint is `POST /api/v1/send` (plus `GET /api/v1/healthz` and this document at `GET /api/v1/llms.txt`).
