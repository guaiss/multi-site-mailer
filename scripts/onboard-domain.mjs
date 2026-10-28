#!/usr/bin/env node
// Onboards one domain end to end. Idempotent: safe to re-run.
//
//   node scripts/onboard-domain.mjs <domain> [--mailboxes support,billing] [--site <site_id> --site-name <name>] [--dry-run]
//
// Steps:
//   1. Email Sending enable  (Cloudflare adds cf-bounce MX/SPF, DKIM, _dmarc)
//   2. Email Routing enable  (Cloudflare adds apex MX + SPF)
//   3. Routing rule per mailbox: <local>@<domain> -> Worker "mailer"
//   4. Register domain + mailboxes in D1 (shows up in the admin UI)
//   5. Optional: create a sending site with no-reply@<domain> as default sender
//      (create its API key in the admin UI afterwards)
//   6. Verify DNS over DoH
//
// Worker and D1 names come from worker/wrangler.jsonc.
// Requires: wrangler logged in (`pnpm exec wrangler whoami` in worker/) with
// email_routing / email_sending / d1 permissions. The domain's DNS must be on
// this Cloudflare account and the apex must not already receive mail elsewhere.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, WORKER_DIR } from "./lib/config.mjs";

const { workerName: WORKER_NAME, d1Name: D1_NAME, hostname: HOSTNAME } = loadConfig();

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const dryRun = flag("--dry-run");
const mailboxes = opt("--mailboxes", "support,billing").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const siteId = opt("--site");
const siteName = opt("--site-name");
const domain = (argv[0] ?? "").toLowerCase();

if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
  console.error("usage: node scripts/onboard-domain.mjs <domain> [--mailboxes support,billing] [--site id --site-name Name] [--dry-run]");
  process.exit(1);
}
if (!mailboxes.every((m) => /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(m))) throw new Error("invalid mailbox name");
if (siteId && !/^[a-z0-9-]{2,40}$/.test(siteId)) throw new Error("site id must match [a-z0-9-]{2,40}");

const step = (s) => console.log(`\n▸ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);

function wrangler(args, { allowFail = false, read = false } = {}) {
  if (dryRun && !read) {
    console.log(`  [dry-run] wrangler ${args.join(" ")}`);
    return "";
  }
  try {
    return execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: WORKER_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (allowFail) return String(e.stdout ?? "") + String(e.stderr ?? "");
    throw new Error(`wrangler ${args.join(" ")} failed:\n${e.stderr || e.stdout}`);
  }
}

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
function d1(sql) {
  if (dryRun) {
    console.log(`  [dry-run] d1: ${sql.slice(0, 120)}…`);
    return [];
  }
  const out = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", sql]);
  return JSON.parse(out).flatMap((r) => r.results ?? []);
}

async function doh(name, type) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`, { headers: { accept: "application/dns-json" } });
  const j = await r.json();
  return (j.Answer ?? []).map((a) => a.data);
}

const enabled = (out) => /Enabled:\s+true/i.test(out);

step(`Email Sending: ${domain}`);
if (enabled(wrangler(["email", "sending", "settings", domain], { allowFail: true, read: true }))) ok("already enabled");
else {
  wrangler(["email", "sending", "enable", domain]);
  ok("enabled");
}

step(`Email Routing: ${domain}`);
if (enabled(wrangler(["email", "routing", "settings", domain], { allowFail: true, read: true }))) ok("already enabled");
else {
  wrangler(["email", "routing", "enable", domain]);
  ok("enabled");
}

step("Routing rules");
const listing = wrangler(["email", "routing", "rules", "list", domain], { allowFail: true, read: true });
// Parse "Rule: <id> … Matchers: to:<addr> … Actions: worker:<name>" blocks.
const rules = listing
  .split(/\n(?=Rule: )/)
  .map((b) => ({
    id: /Rule:\s+(\S+)/.exec(b)?.[1],
    to: /Matchers:\s+to:(\S+)/.exec(b)?.[1],
    action: /Actions:\s+(\S+)/.exec(b)?.[1],
  }))
  .filter((r) => r.id && r.to);
const ruleArgs = (local) => [
  "--name", `${local}-to-${WORKER_NAME}`,
  "--enabled", "true",
  "--match-type", "literal",
  "--match-field", "to",
  "--match-value", `${local}@${domain}`,
  "--action-type", "worker",
  "--action-value", WORKER_NAME,
];
for (const local of mailboxes) {
  const addr = `${local}@${domain}`;
  const rule = rules.find((r) => r.to === addr);
  if (rule?.action === `worker:${WORKER_NAME}`) {
    ok(`${addr} already routed to ${WORKER_NAME}`);
  } else if (rule) {
    wrangler(["email", "routing", "rules", "update", domain, rule.id, ...ruleArgs(local)]);
    ok(`${addr}: ${rule.action} → worker:${WORKER_NAME}`);
  } else {
    wrangler(["email", "routing", "rules", "create", domain, ...ruleArgs(local)]);
    ok(`${addr} → worker:${WORKER_NAME}`);
  }
}

step("Register in app database");
const domainRow = d1(`SELECT id FROM domains WHERE name = ${q(domain)}`)[0];
const domainId = domainRow?.id ?? randomUUID();
if (!domainRow) d1(`INSERT INTO domains (id, name) VALUES (${q(domainId)}, ${q(domain)})`);
for (const local of mailboxes) {
  d1(
    `INSERT OR IGNORE INTO mailboxes (id, domain_id, local_part, address) VALUES (${q(randomUUID())}, ${q(domainId)}, ${q(local)}, ${q(`${local}@${domain}`)})`,
  );
}
ok(`domain + ${mailboxes.length} mailbox(es)`);

if (siteId) {
  step(`Sending site ${siteId}`);
  d1(`INSERT OR IGNORE INTO sites (id, name) VALUES (${q(siteId)}, ${q(siteName ?? siteId)})`);
  d1(
    `INSERT OR IGNORE INTO site_senders (site_id, address, display_name, is_default) VALUES (${q(siteId)}, ${q(`no-reply@${domain}`)}, ${q(siteName ?? null)}, 1)`,
  );
  ok(`site ${siteId}, default sender no-reply@${domain} — get its API key at https://${HOSTNAME}/sites`);
}

step("DNS check (DoH)");
const checks = [
  [domain, "MX", (v) => v.some((x) => x.includes("mx.cloudflare.net"))],
  [`cf-bounce.${domain}`, "MX", (v) => v.length > 0],
  [`cf-bounce._domainkey.${domain}`, "TXT", (v) => v.some((x) => x.includes("DKIM1"))],
  [`_dmarc.${domain}`, "TXT", (v) => v.some((x) => x.includes("DMARC1"))],
];
let allOk = true;
for (const [name, type, pass] of checks) {
  const v = dryRun ? [] : await doh(name, type);
  const good = pass(v);
  allOk &&= good;
  console.log(`  ${good ? "✓" : "…"} ${name} ${type}${good ? "" : " (not visible yet — propagation can take a few minutes)"}`);
}
console.log(`\n${allOk ? "Done." : "Done; re-run later to re-check DNS."}`);
