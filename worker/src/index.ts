import { Hono } from "hono";
import { requireAdmin, type AdminVars } from "./admin/auth";
import { config } from "./admin/config";
import { mail } from "./admin/mail";
import type { Env } from "./env";
import { purgeExpiredTrash } from "./admin/purge";
import { handleEmail } from "./inbound/store";
import { readApi } from "./read/api";
import { sendApi } from "./send/api";
import aiGuide from "../../docs/ai-integration.md";

// Admin API for the UI: Cloudflare Access JWT + ADMIN_EMAILS.
const admin = new Hono<AdminVars>();
admin.use("*", requireAdmin);
admin.get("/me", (c) => c.json({ email: c.get("admin") }));
admin.route("/", mail);
admin.route("/", config);
admin.onError((e, c) => {
  console.error(JSON.stringify({ evt: "admin_error", path: c.req.path, error: String(e?.message ?? e) }));
  return c.json({ error: "internal error" }, 500);
});

// Public machine API (unified domain/action tokens). Cloudflare Access bypasses
// /api/v1 so websites and agents can call it without a browser login.
// The guide uses {{BASE_URL}}; fill in this deployment's origin when serving them.
const markdown = (body: string, req: Request) =>
  new Response(body.replaceAll("{{BASE_URL}}", new URL(req.url).origin), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" },
  });
const notFound = { error: { code: "not_found", message: "not found" } };

const v1 = new Hono<{ Bindings: Env }>();
v1.get("/healthz", (c) => c.json({ ok: true }));
v1.all("/send", (c) => sendApi(c.req.raw, c.env));
v1.route("/mail", readApi);
v1.get("/llms.txt", (c) => markdown(aiGuide, c.req.raw));
// Compatibility alias for agents with the former reading-guide URL.
v1.get("/llms-mail.txt", (c) => markdown(aiGuide, c.req.raw));
v1.all("*", (c) => c.json(notFound, 404));

const app = new Hono<{ Bindings: Env }>();
app.route("/api/v1", v1);
app.route("/api/admin", admin);
app.all("/api/*", (c) => c.json(notFound, 404));

export default {
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return app.fetch(req, env, ctx);
    // SPA (index.html fallback is configured in wrangler.jsonc). Assets hold no data.
    return env.ASSETS.fetch(req);
  },
  email: handleEmail,
  // Daily: permanently delete threads that have been in Trash for 30+ days.
  async scheduled(_event, env) {
    const n = await purgeExpiredTrash(env);
    if (n) console.log(JSON.stringify({ evt: "trash_purge", threads: n }));
  },
} satisfies ExportedHandler<Env>;
