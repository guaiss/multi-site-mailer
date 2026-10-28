import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { verifyAccessJwt } from "../lib/access-jwt";

export type AdminVars = { Variables: { admin: string }; Bindings: Env };

// Every /api request must carry a valid Cloudflare Access JWT for an allowlisted
// admin. The plain Cf-Access-Authenticated-User-Email header is never trusted.
export const requireAdmin: MiddlewareHandler<AdminVars> = async (c, next) => {
  const env = c.env;
  let email: string | null = null;

  if (env.DEV_ADMIN_EMAIL) {
    email = env.DEV_ADMIN_EMAIL.toLowerCase();
  } else {
    const token = c.req.header("cf-access-jwt-assertion");
    if (token && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
      email = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD).catch(() => null);
    }
  }
  if (!email) return c.json({ error: "unauthenticated" }, 401);

  const allowed = (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email)) return c.json({ error: "forbidden" }, 403);

  // CSRF: state-changing requests must be same-origin JSON.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    // Skipped in local dev, where the Vite proxy makes Origin differ from the Worker URL.
    if (origin && !env.DEV_ADMIN_EMAIL && new URL(origin).host !== new URL(c.req.url).host) {
      return c.json({ error: "bad origin" }, 403);
    }
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("application/json")) return c.json({ error: "content-type must be application/json" }, 415);
  }

  c.set("admin", email);
  await next();
};

export async function audit(db: D1Database, actor: string, action: string, target: string | null, detail?: unknown) {
  await db
    .prepare("INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)")
    .bind(actor, action, target, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
