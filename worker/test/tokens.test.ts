import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { config } from "../src/admin/config";
import { requireAdmin, type AdminVars } from "../src/admin/auth";
import type { Env } from "../src/env";
import { readApi } from "../src/read/api";
import { sendApi } from "../src/send/api";
import { sha256Hex } from "../src/lib/crypto";
import { domainsFor, parsePermissions } from "../src/tokens/auth";

// Run the actual migration and endpoint SQL against SQLite through a D1 adapter.
let sqlite: DatabaseSync;
let env: Env;
const key = `mt_${"a".repeat(32)}`;
const migrations = readdirSync(new URL("../migrations/", import.meta.url)).sort();
function migrate(files = migrations) {
  for (const file of files) {
    sqlite.exec("BEGIN");
    try { sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")); sqlite.exec("COMMIT"); }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  }
}
function adapter(): D1Database {
  const prepare = (sql: string) => {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) { args = values; return statement; },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...args); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  };
  return { prepare, batch: async (statements: any[]) => Promise.all(statements.map((s) => s.all())) } as unknown as D1Database;
}
async function addToken(permissions: unknown, site: string | null = null) {
  sqlite.prepare("INSERT INTO tokens (id, name, key_hash, key_prefix, permissions, site_id) VALUES ('token', 'Test', ?, 'mt_a', ?, ?)")
    .run(await sha256Hex(key), JSON.stringify(permissions), site);
}
function seedMail() {
  for (const id of ["a", "b"]) sqlite.exec(`
    INSERT INTO domains (id, name) VALUES ('${id}', '${id}.example.com');
    INSERT INTO sites (id, name) VALUES ('site-${id}', 'Site ${id}');
    INSERT INTO site_senders (site_id, address, is_default) VALUES ('site-${id}', 'support@${id}.example.com', 1);
    INSERT INTO mailboxes (id, domain_id, local_part, address) VALUES ('mb-${id}', '${id}', 'support', 'support@${id}.example.com');
    INSERT INTO threads (id, mailbox_id, subject, subject_normalized, last_message_at) VALUES ('thread-${id}', 'mb-${id}', 'Hi', 'hi', unixepoch());
    INSERT INTO messages (id, thread_id, mailbox_id, direction, from_addr, subject, text_body, sent_at)
      VALUES ('msg-${id}', 'thread-${id}', 'mb-${id}', 'in', 'user@example.org', 'Hi', 'Body ${id}', unixepoch());`);
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='domain_senders'").get()) {
    sqlite.exec("INSERT INTO domain_senders SELECT d.id,ss.address,ss.display_name,ss.is_default FROM site_senders ss JOIN domains d ON d.name=substr(ss.address,instr(ss.address,'@')+1)");
  }
}
const context = { waitUntil: vi.fn(), passThroughOnException() {} } as unknown as ExecutionContext;
const admin = new Hono<AdminVars>();
admin.use("*", async (c, next) => { c.set("admin", "test@example.com"); await next(); });
admin.route("/", config);
function read(path: string, token = key) {
  return readApi.request(path, { headers: { authorization: `Bearer ${token}` } }, env, context);
}
function send(body: object, token = key) {
  return sendApi(new Request("http://local/api/v1/send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
}
function manage(path: string, body?: object, method = "POST") {
  return admin.request(path, { method: body === undefined ? "GET" : method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
const mail = { to: "user@example.org", from: "support@a.example.com", subject: "Hello", text: "Test" };
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:"); migrate(); seedMail();
  env = { DB: adapter(), RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) }, EMAIL: { send: vi.fn(async () => ({ messageId: "sent-1" })) } } as unknown as Env;
});
afterEach(() => sqlite.close());

describe("domain grants", () => {
  it("rejects implicit, malformed and duplicate grants", () => {
    for (const value of [null, {}, [{ domain_id: "a", read: true }], [{ domain_id: "a", read: "false", send: false }], [{ domain_id: "a", read: true, send: false }, { domain_id: "a", read: false, send: true }]]) expect(parsePermissions(value)).toBeNull();
    expect(domainsFor({ id: "x", site_id: null, permissions: [] }, "read")).toEqual([]);
    const token = { id: "x", site_id: null, permissions: [{ domain_id: "*", read: true, send: false }, { domain_id: "a", read: false, send: true }] };
    expect(domainsFor(token, "read")).toBeNull(); expect(domainsFor(token, "send")).toEqual(["a"]);
  });
});
describe("read/send endpoints", () => {
  it("uses one token with independent per-domain read/send permissions", async () => {
    await addToken([{ domain_id: "a", read: true, send: true }, { domain_id: "b", read: true, send: false }]);
    expect((await (await read("/messages")).json()).messages).toHaveLength(2);
    expect((await send(mail)).status).toBe(200);
    expect((await send({ ...mail, from: "support@b.example.com" })).status).toBe(403);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
  });
  it("enforces scope on lists, query filters and direct thread IDs", async () => {
    await addToken([{ domain_id: "a", read: true, send: false }]);
    expect((await (await read("/mailboxes")).json()).mailboxes.map((m: any) => m.domain)).toEqual(["a.example.com"]);
    expect((await (await read("/messages")).json()).messages.map((m: any) => m.id)).toEqual(["msg-a"]);
    expect((await (await read("/messages?mailbox=support@b.example.com&domain=b.example.com")).json()).messages).toEqual([]);
    expect((await read("/threads/thread-a")).status).toBe(200);
    expect((await read("/threads/thread-b")).status).toBe(404);
    expect((await send(mail)).status).toBe(403);
  });
  it("denies empty grants, read access for send-only tokens, and revoked credentials", async () => {
    await addToken([]);
    expect((await read("/messages")).status).toBe(403); expect((await send(mail)).status).toBe(403);
    sqlite.prepare("UPDATE tokens SET permissions = ?").run(JSON.stringify([{ domain_id: "*", read: false, send: true }]));
    expect((await read("/messages")).status).toBe(403); expect((await send(mail)).status).toBe(200);
    sqlite.exec("UPDATE tokens SET revoked_at = datetime('now')");
    expect((await read("/messages")).status).toBe(401); expect((await send(mail)).status).toBe(401);
  });
  it("resolves domain defaults, accepts legacy site_id, and has no site ambiguity", async () => {
    await addToken([{ domain_id: "a", read: false, send: true }]);
    const { from, ...withoutFrom } = mail;
    expect((await send(withoutFrom)).status).toBe(400);
    expect((await send({ ...withoutFrom, site_id: "site-a" })).status).toBe(200);
    sqlite.exec("INSERT INTO site_senders (site_id, address) VALUES ('site-b', 'support@a.example.com')");
    expect((await send(mail)).status).toBe(200);
    expect((await send({ ...withoutFrom, domain: "a.example.com" })).status).toBe(200);
    expect((await send({ ...mail, domain: "b.example.com" })).status).toBe(400);
    expect((await send({ ...mail, site_id: "site-a" })).status).toBe(200);
    expect((await send({ ...mail, from: "unknown@a.example.com" })).status).toBe(403);
  });
  it("preserves legacy site boundaries, quotas, site status and idempotency", async () => {
    await addToken([{ domain_id: "*", read: false, send: true }], "site-a");
    expect((await send({ ...mail, site_id: "site-b" })).status).toBe(403);
    expect((await send({ ...mail, from: "support@b.example.com" })).status).toBe(403);
    expect((await send({ ...mail, idempotency_key: "one" })).status).toBe(200);
    expect((await (await send({ ...mail, idempotency_key: "one" })).json()).replayed).toBe(true);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    sqlite.exec("UPDATE domains SET daily_quota = 1 WHERE id = 'a'"); expect((await send(mail)).status).toBe(429);
    sqlite.exec("UPDATE domains SET status = 'disabled' WHERE id = 'a'"); expect((await send(mail)).status).toBe(403);
  });
  it("fails closed on limiter failure or corrupt stored permissions", async () => {
    await addToken([{ domain_id: "*", read: true, send: true }]);
    vi.mocked(env.RATE_LIMITER.limit).mockRejectedValue(new Error("limiter unavailable"));
    expect((await read("/messages")).status).toBe(429); expect((await send(mail)).status).toBe(429);
    sqlite.exec("UPDATE tokens SET permissions = 'invalid'"); expect((await read("/messages")).status).toBe(401);
  });
});
describe("token management", () => {
  it("keeps token administration behind the admin login", async () => {
    await addToken([{ domain_id: "*", read: true, send: true }]);
    const protectedAdmin = new Hono<AdminVars>();
    protectedAdmin.use("*", requireAdmin);
    protectedAdmin.route("/", config);
    expect((await protectedAdmin.request("/tokens", { headers: { authorization: `Bearer ${key}` } }, env)).status).toBe(401);
    expect((await protectedAdmin.request("/tokens", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Unauthorized", permissions: [] }) }, env)).status).toBe(401);
  });
  it("requires explicit grants and known domains; empty grants never mean all domains", async () => {
    expect((await manage("/tokens", { name: "No grants" })).status).toBe(400);
    expect((await manage("/tokens", { name: "Unknown", permissions: [{ domain_id: "unknown", read: true, send: false }] })).status).toBe(400);
    const res = await manage("/tokens", { name: "Empty", permissions: [] }); expect(res.status).toBe(200);
    const result = await res.json(); expect(result.key).toMatch(/^mt_/);
    expect((await read("/messages", result.key)).status).toBe(403); expect((await send(mail, result.key)).status).toBe(403);
  });
  it("edits without rotation, lists permissions, and revokes immediately", async () => {
    await addToken([{ domain_id: "a", read: true, send: false }]);
    expect((await manage("/tokens/token", { name: "Send instead", permissions: [{ domain_id: "b", read: false, send: true }] }, "PATCH")).status).toBe(200);
    expect((await (await manage("/tokens")).json()).tokens[0].name).toBe("Send instead");
    expect((await read("/messages")).status).toBe(403);
    expect((await send({ ...mail, from: "support@b.example.com" })).status).toBe(200);
    expect((await manage("/tokens/token/revoke", {})).status).toBe(200); expect((await send(mail)).status).toBe(401);
    expect((await manage("/tokens/token", { name: "Revoked", permissions: [] }, "PATCH")).status).toBe(404);
  });
  it("refuses legacy creation endpoints with implicit grants", async () => {
    expect((await manage("/read-tokens", { name: "Old" })).status).toBe(410);
    expect((await manage("/sites/site-a/keys", {})).status).toBe(410);
  });
});
describe("legacy migration", () => {
  it("preserves credential values, read scopes, revocations and send-site binding", async () => {
    sqlite.close(); sqlite = new DatabaseSync(":memory:"); migrate(migrations.filter((m) => m < "0007")); seedMail();
    const oldRead = `mr_${"b".repeat(32)}`, oldSend = `mk_${"c".repeat(32)}`;
    sqlite.prepare("INSERT INTO read_tokens (id, name, key_hash, key_prefix, key_plain, allowed_domains) VALUES ('old-read', 'Read A', ?, 'mr_b', ?, '[\"a\"]')").run(await sha256Hex(oldRead), oldRead);
    sqlite.prepare("INSERT INTO api_keys (id, site_id, key_hash, key_prefix, key_plain) VALUES ('old-send', 'site-a', ?, 'mk_c', ?)").run(await sha256Hex(oldSend), oldSend);
    sqlite.exec("INSERT INTO read_tokens (id, name, key_hash, key_prefix, revoked_at) VALUES ('revoked', 'Revoked', 'revoked-hash', 'mr_r', '2026-01-01'); INSERT INTO read_tokens (id, name, key_hash, key_prefix) VALUES ('all', 'All', 'all-hash', 'mr_all')");
    migrate(migrations.filter((m) => m >= "0007"));
    expect((await read("/messages", oldRead)).status).toBe(200); expect((await read("/threads/thread-b", oldRead)).status).toBe(404);
    expect((await send(mail, oldRead)).status).toBe(403); expect((await send(mail, oldSend)).status).toBe(200);
    expect((await read("/messages", oldSend)).status).toBe(403);
    const rows = sqlite.prepare("SELECT * FROM tokens ORDER BY id").all();
    expect(rows.find((r) => r.id === "old-read")?.key_plain).toBe(oldRead);
    expect(rows.find((r) => r.id === "old-send")?.site_id).toBe("site-a");
    expect(rows.find((r) => r.id === "revoked")?.revoked_at).toBe("2026-01-01");
    expect(JSON.parse(String(rows.find((r) => r.id === "all")?.permissions))).toEqual([{ domain_id: "*", read: true, send: false }]);
  });
});

describe("domain sending management", () => {
  it("never invents mailboxes or senders when registering a domain", async () => {
    const result = await (await manage("/domains", { name: "new.example.com" })).json();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE domain_id=?").get(result.id)?.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM domain_senders WHERE domain_id=?").get(result.id)?.n).toBe(0);
    expect((await manage("/mailboxes", { domain_id: result.id, local_part: "hello" })).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM domain_senders WHERE domain_id=?").get(result.id)?.n).toBe(0);
  });
  it("returns domain settings, sender lists and domain usage", async () => {
    await addToken([{ domain_id: "a", read: false, send: true }]);
    await send(mail);
    const result = await (await manage("/domains")).json();
    expect(result.domains.find((d: any) => d.id === "a")).toMatchObject({ status: "active", daily_quota: 2000, sent_today: 1, senders: [{ address: mail.from }] });
    expect((await (await manage("/send-log?domain=a")).json()).entries).toHaveLength(1);
    expect((await (await manage("/send-log?domain=b")).json()).entries).toHaveLength(0);
  });
  it("validates domain settings, sender domains and mutually exclusive defaults", async () => {
    expect((await manage("/domains/a", { daily_quota: 0 }, "PATCH")).status).toBe(400);
    expect((await manage("/domains/missing", { daily_quota: 2 }, "PATCH")).status).toBe(404);
    expect((await manage("/domains/a/senders", { address: "hello@b.example.com" })).status).toBe(400);
    expect((await manage("/domains/a/senders", { address: "hello@a.example.com", is_default: true })).status).toBe(200);
    expect(sqlite.prepare("SELECT address FROM domain_senders WHERE domain_id='a' AND is_default=1").all()).toEqual([{ address: "hello@a.example.com" }]);
    await addToken([{ domain_id: "a", read: false, send: true }]);
    expect((await send({ to: mail.to, domain: "a.example.com", subject: "Hi", text: "Body" })).status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({ from: "hello@a.example.com" }));
    expect((await manage("/domains/a/senders/hello%40a.example.com", {}, "DELETE")).status).toBe(200);
    expect((await send({ to: mail.to, domain: "a.example.com", subject: "Hi", text: "Body" })).status).toBe(403);
  });
  it("shares quota and idempotency across tokens on the same domain", async () => {
    await addToken([{ domain_id: "a", read: false, send: true }]);
    const other = `mt_${"z".repeat(32)}`;
    sqlite.prepare("INSERT INTO tokens (id,name,key_hash,key_prefix,permissions) SELECT 'other','Other',?,'mt_z',permissions FROM tokens WHERE id='token'").run(await sha256Hex(other));
    expect((await send({ ...mail, idempotency_key: "shared" })).status).toBe(200);
    expect((await (await send({ ...mail, idempotency_key: "shared" }, other)).json()).replayed).toBe(true);
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
    await manage("/domains/a", { daily_quota: 1 }, "PATCH");
    expect((await send(mail, other)).status).toBe(429);
  });
  it("uses domain template overrides with shared fallback and compatible variables", async () => {
    await addToken([{ domain_id: "a", read: false, send: true }]);
    expect((await manage("/templates/unknown/test", { subject: "X", text: "Body" }, "PUT")).status).toBe(400);
    expect((await manage("/templates/*/test", { subject: "Shared", text: "Shared body" }, "PUT")).status).toBe(200);
    await manage("/domains/a", { display_name: "Brand A" }, "PATCH");
    await manage("/templates/a/test", { subject: "{{site_name}} — {{domain_name}}", text: "Domain body" }, "PUT");
    const req = { to: mail.to, domain: "a.example.com", template: "test" };
    expect((await send(req)).status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: "Brand A — a.example.com", text: "Domain body" }));
    await manage("/templates/a/test", {}, "DELETE");
    expect((await send(req)).status).toBe(200);
    expect(env.EMAIL.send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: "Shared" }));
  });
  it("blocks old Site management and protects domains with sender configuration or history", async () => {
    expect((await manage("/sites")).status).toBe(410);
    expect((await manage("/sites", { id: "new", name: "New" })).status).toBe(410);
    expect((await manage("/domains/a", {}, "DELETE")).status).toBe(409);
  });
});

describe("domain migration", () => {
  function beforeDomainMigration() {
    sqlite.close(); sqlite = new DatabaseSync(":memory:"); migrate(migrations.filter((m) => m < "0008")); seedMail();
  }
  it("copies sender defaults, domain display names, quotas, templates and historical idempotency", async () => {
    beforeDomainMigration();
    await addToken([{ domain_id: "a", read: false, send: true }], "site-a");
    sqlite.exec("UPDATE sites SET daily_quota=123 WHERE id='site-a'; INSERT INTO templates (site_id,name,subject,text) VALUES ('site-a','test','Old override','Old body')");
    const hash = await sha256Hex(JSON.stringify([mail.from, mail.to, undefined, undefined, {}, mail.subject, undefined, mail.text]));
    sqlite.prepare("INSERT INTO send_log (id,site_id,idempotency_key,request_hash,status,from_address,to_address,provider,provider_message_id) VALUES ('old-log','site-a','historical',?,'sent',?,?,'cloudflare','old-id')").run(hash, mail.from, mail.to);
    migrate(migrations.filter((m) => m >= "0008"));
    expect(sqlite.prepare("SELECT display_name,daily_quota FROM domains WHERE id='a'").get()).toEqual({ display_name: "Site a", daily_quota: 123 });
    expect(sqlite.prepare("SELECT address,is_default FROM domain_senders WHERE domain_id='a'").get()).toEqual({ address: mail.from, is_default: 1 });
    expect(sqlite.prepare("SELECT subject FROM domain_templates WHERE domain_id='a' AND name='test'").get()?.subject).toBe("Old override");
    const response = await (await send({ ...mail, idempotency_key: "historical" })).json();
    expect(response).toMatchObject({ replayed: true, id: "old-log", provider_message_id: "old-id" });
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });
  it("merges multiple sites conservatively without duplicating sender addresses", () => {
    beforeDomainMigration();
    sqlite.exec("UPDATE sites SET daily_quota=10,status='disabled' WHERE id='site-b'; INSERT INTO site_senders (site_id,address,is_default) VALUES ('site-b','support@a.example.com',1)");
    migrate(migrations.filter((m) => m >= "0008"));
    expect(sqlite.prepare("SELECT daily_quota,status FROM domains WHERE id='a'").get()).toEqual({ daily_quota: 10, status: "disabled" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM domain_senders WHERE domain_id='a'").get()?.n).toBe(1);
  });
  it("refuses conflicting domain template overrides and rolls back the migration", () => {
    beforeDomainMigration();
    sqlite.exec("INSERT INTO site_senders (site_id,address) VALUES ('site-b','other@a.example.com'); INSERT INTO templates (site_id,name,subject,text) VALUES ('site-a','conflict','A','A'),('site-b','conflict','B','B')");
    expect(() => migrate(migrations.filter((m) => m >= "0008"))).toThrow(/CHECK/);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='domain_senders'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM templates WHERE name='conflict'").get()?.n).toBe(2);
  });
  it("refuses conflicting historical idempotency keys rather than dropping send history", () => {
    beforeDomainMigration();
    sqlite.exec("INSERT INTO send_log (id,site_id,idempotency_key,request_hash,status,from_address,to_address,provider) VALUES ('one','site-a','same','hash','sent','support@a.example.com','u@example.org','test'),('two','site-b','same','hash','sent','other@a.example.com','u@example.org','test')");
    expect(() => migrate(migrations.filter((m) => m >= "0008"))).toThrow(/UNIQUE/);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM send_log").get()?.n).toBe(2);
  });
});
