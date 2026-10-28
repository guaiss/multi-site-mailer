#!/usr/bin/env node
// Admin CLI for send-api. Talks to D1 through wrangler, so there is no admin
// HTTP surface on the Worker. Usage:
//
//   node scripts/site.mjs add-site    <site_id> <name> [daily_quota] [--local]
//   node scripts/site.mjs add-sender  <site_id> <address> [display_name] [--default] [--local]
//   node scripts/site.mjs add-key     <site_id> [--local]
//   node scripts/site.mjs revoke-key  <key_id> [--local]
//   node scripts/site.mjs list        [--local]
//   node scripts/site.mjs log         [site_id] [--local]      # last 20 sends

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadConfig, WORKER_DIR as API_DIR } from "./lib/config.mjs";

const { d1Name } = loadConfig();
const args = process.argv.slice(2);
const flag = (f) => {
  const i = args.indexOf(f);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const local = flag("--local");
const isDefault = flag("--default");
const [cmd, ...rest] = args;

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

function d1(sql) {
  const out = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", d1Name, local ? "--local" : "--remote", "--json", "--command", sql],
    { cwd: API_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out).flatMap((r) => r.results ?? []);
}

function need(n, usage) {
  if (rest.length < n) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
}

switch (cmd) {
  case "add-site": {
    need(2, "add-site <site_id> <name> [daily_quota]");
    const [id, name, quota = "2000"] = rest;
    if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("site_id must match [a-z0-9-]{2,40}");
    d1(`INSERT INTO sites (id, name, daily_quota) VALUES (${q(id)}, ${q(name)}, ${Number(quota)})`);
    console.log(`site ${id} created`);
    break;
  }
  case "add-sender": {
    need(2, "add-sender <site_id> <address> [display_name] [--default]");
    const [site, address, displayName] = rest;
    const addr = address.toLowerCase();
    if (isDefault) d1(`UPDATE site_senders SET is_default = 0 WHERE site_id = ${q(site)}`);
    d1(
      `INSERT INTO site_senders (site_id, address, display_name, is_default) VALUES (${q(site)}, ${q(addr)}, ${q(displayName ?? null)}, ${isDefault ? 1 : 0})`,
    );
    console.log(`sender ${addr} allowed for ${site}${isDefault ? " (default)" : ""}`);
    break;
  }
  case "add-key": {
    need(1, "add-key <site_id>");
    const [site] = rest;
    const key = `mk_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(key).digest("hex");
    const id = randomUUID();
    d1(
      `INSERT INTO api_keys (id, site_id, key_hash, key_prefix, key_plain) VALUES (${q(id)}, ${q(site)}, ${q(hash)}, ${q(key.slice(0, 10))}, ${q(key)})`,
    );
    console.log(`key id: ${id}\nAPI key:\n${key}`);
    break;
  }
  case "revoke-key": {
    need(1, "revoke-key <key_id>");
    d1(`UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ${q(rest[0])}`);
    console.log("revoked");
    break;
  }
  case "list": {
    console.table(d1("SELECT id, name, status, daily_quota FROM sites"));
    console.table(d1("SELECT site_id, address, display_name, is_default FROM site_senders ORDER BY site_id"));
    console.table(d1("SELECT id, site_id, key_prefix, created_at, revoked_at FROM api_keys ORDER BY site_id"));
    break;
  }
  case "log": {
    const where = rest[0] ? `WHERE site_id = ${q(rest[0])}` : "";
    console.table(
      d1(
        `SELECT created_at, site_id, status, to_address, template, provider_message_id, error_code FROM send_log ${where} ORDER BY created_at DESC LIMIT 20`,
      ),
    );
    break;
  }
  default:
    console.error("commands: add-site | add-sender | add-key | revoke-key | list | log  (append --local for local D1)");
    process.exit(1);
}
