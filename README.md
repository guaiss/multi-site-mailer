# Mailer

Self-hosted email for people who run many small websites, built entirely on Cloudflare.

- **Transactional send API.** Unified API tokens grant Send permission per domain, with exact allow-listed sender addresses (`no-reply@site-a.com`). Templates, idempotency keys, rate limits, daily quotas, and a send log are included.
- **One inbox for every domain.** Mail to `support@site-a.com`, `billing@site-b.com`, … lands in a single admin UI. You can search it, read it with safe HTML rendering, download attachments, reply, and bulk-select conversations to mark read/unread or move them to Trash. Trash is purged after 30 days. Replies always go out from the address the customer wrote to, and threading is preserved.
- **Read API for AI agents.** Domain Read permissions let a scheduled agent fetch the last day's mail and summarize it.
- **Agent-ready docs.** `/api/v1/llms.txt` is one complete guide for sending, reading and summarizing mail, served with your deployment hostname filled in. The former `/api/v1/llms-mail.txt` URL remains a compatibility alias.

It runs as one Cloudflare Worker with D1, R2, Email Routing, and Email Sending. There are no servers to maintain. In practice it costs the Workers Paid plan ($5/mo) plus Email Sending usage.

## How it fits together

```text
websites  ──Bearer mt_…──▶  https://mail.example.com/api/v1/send        ┐
AI agents ──Bearer mt_…──▶  https://mail.example.com/api/v1/mail/*      │  one Worker
you       ──Cloudflare Access──▶ https://mail.example.com (UI + /api/admin) │  (worker/)
customers ──MX──▶ Email Routing ──rule──▶ email() handler               ┘
                         D1: config, threads, messages, FTS   R2: raw .eml, HTML, attachments
```

See [docs/architecture.md](docs/architecture.md) for details and security notes.

## Requirements

- A Cloudflare account on the **Workers Paid** plan. Email Sending to arbitrary recipients requires it.
- **Cloudflare Email Sending** available on the account. It is currently in beta; check the Cloudflare docs for status, quotas, and pricing.
- One hostname for the app (e.g. `mail.example.com`) whose zone is on this account.
- Every domain you want to send from or receive at must use **Cloudflare DNS on the same account**. Its apex MX will point to Cloudflare Email Routing, so don't onboard a domain that already receives mail elsewhere. The admin UI warns you if it does.
- Cloudflare Zero Trust (the free plan is fine) for the admin login.
- Node 22.13+ (including the SQLite-backed integration tests), pnpm, and `wrangler login`.

## Deploy

1. **Clone and log in**
   ```sh
   git clone <this repo> mailer && cd mailer
   cd worker && pnpm install && pnpm exec wrangler login && cd ..
   ```

2. **Create two Cloudflare Access applications** (Zero Trust → Access → Applications → Self-hosted):
   - **Admin**: hostname `mail.example.com`, no path. Use an *Allow* policy that includes your email. Copy its **Application Audience (AUD) tag**.
   - **API bypass**: hostname `mail.example.com`, path `api/v1`. Use a *Bypass* policy that includes *Everyone*. This lets websites and agents call the machine API. Those endpoints authenticate with their own keys and tokens.

   Your team domain (`<team>.cloudflareaccess.com`) is shown under Zero Trust → Settings.

3. **Set up and deploy**
   ```sh
   node scripts/setup.mjs \
     --hostname mail.example.com \
     --admin you@example.com \
     --access-team <team>.cloudflareaccess.com \
     --access-aud <AUD tag>
   ```
   This creates the D1 database and R2 bucket and writes `worker/wrangler.jsonc` from `worker/wrangler.example.jsonc` (your copy is git-ignored). It then builds the UI, applies migrations, and deploys. It is safe to re-run.

4. **Onboard a domain.** This enables Email Sending and Email Routing, creates routing rules, registers the domain and its mailboxes, and checks DNS:
   ```sh
   node scripts/onboard-domain.mjs site-a.com --mailboxes hello --display-name "Site A"
   ```
   The mailbox names are explicit: omitting `--mailboxes` uses only those already configured in the app. No sender addresses are created automatically. Configure your chosen sender address, default sender and quota under **Domains → Sending settings**, then create a token in **API tokens**, granting Send permission for this domain.

   > Enabling Email Sending adds `_dmarc` with `p=reject`. If anything else sends mail as that domain, align its SPF/DKIM first or relax the policy.

5. **Use it**
   - Admin UI: `https://mail.example.com`
   - Websites: give your coding agent `https://mail.example.com/api/v1/llms.txt` and set `MAILER_API_KEY` yourself.
   - Daily summaries: create a token with Read permission under **API tokens** and give your agent `https://mail.example.com/api/v1/llms.txt`.

## Send API at a glance

```sh
curl -X POST https://mail.example.com/api/v1/send \
  -H "Authorization: Bearer $MAILER_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: login-123" \
  -d '{"from":"no-reply@site-a.com","to":"user@example.org","template":"login_code","variables":{"code":"482916","expires_minutes":10}}'
```

The full contract is in [docs/ai-integration.md](docs/ai-integration.md): fields, error codes, retry rules, and Node and Python clients. The same guide includes the read API and daily-summary recipe.

## Token permissions and upgrading

In **API tokens**, create one token and independently check **Read mail** / **Send mail** for each domain. Empty permissions grant no access. **All domains** is explicit and also covers domains added later. Edit permissions without changing the credential; revoke to disable both reading and sending immediately. Admin access stays separate behind Cloudflare Access.

New tokens use `mt_`. Sending requires `from` or `domain`; `domain` uses that domain's configured default sender. Domain settings own allowed senders, templates, daily quota and rate limit. **API tokens** includes one AI integration guide link and a copy button.

For existing deployments, build the UI, apply migrations with `cd worker && pnpm db:migrate:remote`, then deploy the matching Worker/UI:

- `0007_unified_tokens.sql` copies existing credentials and revocations into unified tokens; values remain valid.
- `0008_domain_sending.sql` copies sender addresses, defaults, domain display names, quotas, templates and send history ownership from Sites into Domains. Multiple legacy sites on one domain use the smallest quota and remain disabled if any source was disabled. Conflicting template overrides or historical idempotency keys abort the migration rather than discard data. Sites must have a registered sender before their private templates can be mapped to domains.
- Legacy sending keys retain their original sender restrictions and default sender. Existing `site_id` calls remain compatible. Old tables remain as compatibility data; all current sender/template management uses the new domain tables. `/sites` redirects to Domains; the old Site admin API and CLI refuse writes. Create and manage credentials only under API tokens.

## Development

```sh
cd worker
cp wrangler.example.jsonc wrangler.jsonc        # if you haven't run setup.mjs
printf 'DEV_ADMIN_EMAIL=dev@local\nADMIN_EMAILS=dev@local\n' > .dev.vars   # skips Access locally
pnpm db:migrate:local && pnpm exec wrangler dev --port 8797
# in another shell
cd web && pnpm install && pnpm dev               # proxies /api to :8797
# simulate inbound mail
curl -X POST 'http://localhost:8797/cdn-cgi/handler/email?from=a@x.com&to=support@site-a.com' --data-binary @mail.eml
```

Tests: `cd worker && pnpm test`. Logs: `pnpm exec wrangler tail mailer`.

## Repository layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker: send API, read API, admin API, inbound `email()` handler, migrations, tests |
| `web/` | Admin UI (React + Mantine), built into `web/dist` and served as Worker assets |
| `scripts/` | `setup.mjs` (deploy), `onboard-domain.mjs` (per-domain Cloudflare setup), `site.mjs` (retired compatibility entry point) |
| `docs/` | Architecture and the agent-facing API guides |

## Limitations

- **Single tenant.** Every admin sees every domain's mail.
- **Transactional mail only**, per Cloudflare Email Sending policy. Max 5 MiB per outbound message; inbound is capped at 20 MiB.
- **No IMAP/POP3.** The web UI and the read API are the only ways in.
- **Send keys and read tokens are stored in D1 in plaintext as well as hashed**, so you can view them again in the UI. If that's not acceptable for you, drop the `key_plain` columns.

## License

MIT; see [LICENSE](LICENSE). Parts of `worker/src/inbound/` are adapted from [Orange Inbox](https://github.com/InventiveHQ/orange-inbox) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
