export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  RATE_LIMITER: RateLimit;
  ASSETS: Fetcher;

  // Cloudflare Access: team domain + application AUD for the admin UI.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // Comma-separated emails allowed into the admin UI (in addition to the Access policy).
  ADMIN_EMAILS: string;
  // authserv-id of the trusted receiver's Authentication-Results header (optional).
  TRUSTED_AUTHSERV_ID?: string;
  // Local dev only: bypass Access and act as this admin. Never set in production.
  DEV_ADMIN_EMAIL?: string;
}

export const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
