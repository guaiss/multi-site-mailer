# Architecture

```text
websites  ──Bearer mt_…──▶ <host>/api/v1/send ───────────┐
AI agents ──Bearer mt_…──▶ <host>/api/v1/mail/* ─────────┤   Worker "mailer" (worker/)
             (Access app with a Bypass policy on path api/v1) │   ├─ /api/v1/send      send API
admins    ──Cloudflare Access──▶ <host> ──────────────────┤   ├─ /api/v1/mail/*    read-only mail API (domain-scoped tokens)
             (UI + /api/admin)                            │   ├─ /api/v1/llms.txt  unified agent guide (served with <host> filled in)
customers ──MX──▶ Email Routing ──per-address rule──▶ email() ┘   ├─ /api/admin/*      admin API (Access JWT + ADMIN_EMAILS)
                                                              ├─ email()           inbound: parse, thread, store
                                                              └─ static assets     web/dist (React + Mantine)

D1:  tokens · domain_senders · domain_templates · send_log
     legacy compatibility: sites · site_senders · templates · api_keys · read_tokens
     domains · mailboxes · threads · messages · attachments · messages_fts (trigram) · audit_log
R2:  raw/<mailbox>/<id>.eml · html/<mailbox>/<id>.html · att/<message>/<id>
send_email binding → Cloudflare Email Sending
```

## Design notes

- **One Worker, one D1, one R2, one hostname.** The send API, the read API, inbound handling, and the admin UI share one codebase and one deploy.
- **Path-based trust boundaries.**
  - `/api/v1/*` is public at the network level, because an Access *Bypass* app covers that path. Every endpoint under it requires its own credential.
  - Everything else sits behind Cloudflare Access. `/api/admin/*` additionally verifies the `Cf-Access-Jwt-Assertion` JWT (signature, `aud`, `iss`, expiry) and checks the email against `ADMIN_EMAILS`. The plain `Cf-Access-Authenticated-User-Email` header is never trusted. So a misconfigured Access policy alone does not expose the admin API.
- **Unified machine credentials.**
  - New tokens (`mt_…`) have independent Read/Send grants for each domain ID. No grants means no access. Explicit `*` grants cover all current and future domains for the selected action.
  - All read endpoints enforce domain scope in SQL; sending checks the resolved sender domain before rendering, logging or delivering mail.
  - Legacy `mk_…` and `mr_…` credentials are copied into `tokens` by migration 0007, preserving values and revocations. Legacy sending keys keep their site binding and receive Send grants for their site's currently configured sender domains. Adding a new sender domain later also requires editing the token's grants.
  - Admins create, edit and revoke tokens at `/api/admin/tokens`; old creation endpoints return 410. Old tables remain as legacy snapshots but are no longer used for authentication or management. Do not write credentials to the old tables.
  - Permission edits and revocations take effect on subsequent requests. Lookups use SHA-256; plaintext is retained for admin viewing, following the existing storage policy.
- **Domain sending configuration.**
  - Domains own display names, enable/disable, quotas, exact allowed senders and a default sender. Domain-specific templates override shared templates. Sending is addressed with `from` or `domain`; no Site is required.
  - Migration 0008 copies legacy senders/templates/settings and backfills `send_log.domain_id`. Conflicting overrides or historical idempotency keys fail the migration instead of losing history. Multiple sites use the smallest quota and any disabled source disables the domain.
  - Legacy site tables are read-only compatibility data for old keys' sender restrictions and default From resolution. Legacy `site_id` input remains supported. New administration never writes legacy site tables.
  - No mailbox or sender names are invented. Domain registration defaults to no mailboxes; onboarding without explicit names uses those already configured.
- **Sender identity is enforced server-side.**
  - API calls may only use the exact addresses allow-listed for the sender domain, with a Send grant for the sender domain.
  - Admin replies always use the thread's mailbox address. The client cannot choose `From`.
- **Send pipeline.**
  - Idempotency uses a unique `(domain_id, idempotency_key)` row with claim-then-send. Same key plus same body replays the result; same key with a different body returns 422.
  - Per-token and per-domain burst limits are enforced by the Workers Rate Limiting binding, which fails closed. A domain daily quota is tracked in D1.
  - Template variables are HTML-escaped, and a missing variable is a 400 rather than a half-rendered email.
  - The log stores the template name only, never variables or bodies.
- **Inbound.**
  - Only registered addresses get routing rules, and unknown recipients are rejected.
  - Messages are capped at 20 MiB. Duplicate deliveries (same Message-ID) are ignored.
  - The raw `.eml` is kept in R2.
  - Only the first `Authentication-Results` header (prepended by Cloudflare's MX), or the one matching `TRUSTED_AUTHSERV_ID`, is trusted.
- **Threading.**
  - References / In-Reply-To are matched against stored Message-IDs.
  - The fallback is the same normalized subject *and* the same counterpart within 14 days.
  - Outbound messages store the Message-ID returned by Email Sending, which is the one recipients see, so their replies thread correctly.
- **Viewing mail safely.**
  - The HTML body is served as a standalone document with `Content-Security-Policy: sandbox` and rendered in a `sandbox` iframe with neither `allow-scripts` nor `allow-same-origin`.
  - Remote images are blocked until you click to load them, and `cid:` images are inlined as `data:` URIs.
  - Attachments are always downloads (`application/octet-stream`, `nosniff`), and executables need confirmation.
- **Deletion.** Deleting moves a conversation to Trash (`threads.deleted_at`). Trashed conversations are hidden from the read API. A new inbound message moves a conversation back to the inbox. *Delete forever*, *Empty trash*, and a daily cron (30-day retention) purge the D1 rows and the R2 objects (raw `.eml`, HTML, attachments).
- **CSRF.** Admin mutations require `Content-Type: application/json` and a same-origin `Origin`.
- **No Cloudflare API token in the Worker.** Per-domain Cloudflare setup (Email Sending, Email Routing, routing rules) runs locally via `scripts/onboard-domain.mjs` using your wrangler login.

## Observability

- `wrangler tail mailer` shows structured JSON logs: `send`, `inbound`, `admin_error`, `read_api_error`.
- Delivery events (delivered/bounced) are visible in Cloudflare's GraphQL Analytics. In our testing, sending events showed up in the zone-level `emailRoutingAdaptive` dataset.
- The admin UI has a send log and an audit log of admin actions.
