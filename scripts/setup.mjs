#!/usr/bin/env node
// First-time setup / redeploy. Idempotent.
//
//   node scripts/setup.mjs --hostname mail.example.com --admin you@example.com \
//     --access-team myteam.cloudflareaccess.com --access-aud <AUD tag> [--no-deploy]
//
// Creates (or reuses) the D1 database and R2 bucket, writes worker/wrangler.jsonc
// from worker/wrangler.example.jsonc, installs deps, builds the UI, applies
// migrations, and deploys. Re-running with an existing wrangler.jsonc keeps its
// values unless you pass new flags.
//
// Prerequisites (see README): wrangler logged in, Workers Paid plan, the
// hostname's zone on this Cloudflare account, and two Access applications.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc, ROOT, WORKER_DIR } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const noDeploy = argv.includes("--no-deploy");

const CONFIG = join(WORKER_DIR, "wrangler.jsonc");
const EXAMPLE = join(WORKER_DIR, "wrangler.example.jsonc");

const step = (s) => console.log(`\n▸ ${s}`);
const run = (cmd, args, cwd = WORKER_DIR, capture = false) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
const wrangler = (args, capture = true) => run("pnpm", ["exec", "wrangler", ...args], WORKER_DIR, capture);

// Current values: existing config first, then flags override.
let current = {};
if (existsSync(CONFIG)) {
  const c = parseJsonc(readFileSync(CONFIG, "utf8"));
  current = {
    hostname: c.routes?.[0]?.pattern,
    d1Name: c.d1_databases?.[0]?.database_name,
    d1Id: c.d1_databases?.[0]?.database_id,
    bucket: c.r2_buckets?.[0]?.bucket_name,
    ...c.vars,
  };
}
const v = {
  hostname: opt("--hostname") ?? current.hostname,
  admin: opt("--admin") ?? current.ADMIN_EMAILS,
  team: opt("--access-team") ?? current.ACCESS_TEAM_DOMAIN,
  aud: opt("--access-aud") ?? current.ACCESS_AUD,
  d1Name: current.d1Name ?? "mailer",
  bucket: current.bucket ?? "mailer-mail",
};
const missing = Object.entries({ "--hostname": v.hostname, "--admin": v.admin, "--access-team": v.team, "--access-aud": v.aud })
  .filter(([, val]) => !val || String(val).startsWith("REPLACE_ME"))
  .map(([k]) => k);
if (missing.length) {
  console.error(`missing: ${missing.join(" ")}\n\nusage: node scripts/setup.mjs --hostname mail.example.com --admin you@example.com --access-team myteam.cloudflareaccess.com --access-aud <AUD>`);
  process.exit(1);
}

step("Installing dependencies");
run("pnpm", ["install", "--silent"], WORKER_DIR);
run("pnpm", ["install", "--silent"], join(ROOT, "web"));

step("Checking wrangler login");
try {
  wrangler(["whoami"]);
} catch {
  console.error("wrangler is not logged in: run `cd worker && pnpm exec wrangler login`");
  process.exit(1);
}

step(`D1 database "${v.d1Name}"`);
let d1Id = current.d1Id && !current.d1Id.startsWith("REPLACE_ME") ? current.d1Id : null;
if (!d1Id) {
  const list = JSON.parse(wrangler(["d1", "list", "--json"]));
  d1Id = list.find((d) => d.name === v.d1Name)?.uuid ?? null;
}
if (!d1Id) {
  const out = wrangler(["d1", "create", v.d1Name]);
  d1Id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(out)?.[0];
  if (!d1Id) throw new Error(`could not parse D1 id from:\n${out}`);
  console.log(`  created ${d1Id}`);
} else console.log(`  using ${d1Id}`);

step(`R2 bucket "${v.bucket}"`);
try {
  wrangler(["r2", "bucket", "info", v.bucket]);
  console.log("  exists");
} catch {
  wrangler(["r2", "bucket", "create", v.bucket]);
  console.log("  created");
}

step("Writing worker/wrangler.jsonc");
const template = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : readFileSync(EXAMPLE, "utf8");
const setVar = (text, key, value) => text.replace(new RegExp(`("${key}":\\s*)"[^"]*"`), `$1${JSON.stringify(value)}`);
let cfg = template.replace(/("pattern":\s*)"[^"]*"/, `$1${JSON.stringify(v.hostname)}`);
cfg = setVar(cfg, "database_name", v.d1Name);
cfg = setVar(cfg, "database_id", d1Id);
cfg = setVar(cfg, "bucket_name", v.bucket);
cfg = setVar(cfg, "ACCESS_TEAM_DOMAIN", v.team);
cfg = setVar(cfg, "ACCESS_AUD", v.aud);
cfg = setVar(cfg, "ADMIN_EMAILS", v.admin);
writeFileSync(CONFIG, cfg);
console.log("  ok");

step("Building the admin UI");
run("pnpm", ["build"], join(ROOT, "web"));

step("Applying migrations");
wrangler(["d1", "migrations", "apply", "DB", "--remote"], false);

if (noDeploy) {
  console.log("\n--no-deploy: skipping deploy. Run `cd worker && pnpm exec wrangler deploy` when ready.");
} else {
  step("Deploying");
  wrangler(["deploy"], false);
}

console.log(`
Done. Next:
  • Open https://${v.hostname} (Cloudflare Access login) — you should land in the inbox.
  • Onboard a domain:  node scripts/onboard-domain.mjs example.com --mailboxes hello --display-name Example
  • Give your website / AI agent: https://${v.hostname}/api/v1/llms.txt (sending, reading and summaries)`);
