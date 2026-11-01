#!/usr/bin/env node
// Onboards one domain end to end. Idempotent: safe to re-run.
//
//   node scripts/onboard-domain.mjs <domain> [--mailboxes <names>] [--display-name <name>] [--dry-run]
//
// Steps:
//   1. Email Sending enable  (Cloudflare adds cf-bounce MX/SPF, DKIM, _dmarc)
//   2. Email Routing enable  (Cloudflare adds apex MX + SPF)
//   3. Routing rule per mailbox: <local>@<domain> -> Worker "mailer"
//   4. Register domain + mailboxes in D1 (shows up in the admin UI)
//   5. Optional: set the domain display name (senders and tokens are managed in the UI)
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
const mailboxArg = opt("--mailboxes");
let mailboxes = mailboxArg === undefined ? null : mailboxArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const legacySite = opt("--site");
const displayName = opt("--display-name") ?? opt("--site-name");
const domain = (argv[0] ?? "").toLowerCase();

if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
  console.error("usage: node scripts/onboard-domain.mjs <domain> [--mailboxes <names>] [--display-name Name] [--dry-run]");
  process.exit(1);
}
if (mailboxes && !mailboxes.every((m) => /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(m))) throw new Error("invalid mailbox name");
if (legacySite) console.log("--site is obsolete: sending settings now belong to the domain; no sender addresses are created automatically.");

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
function d1(sql, { read = false } = {}) {
  if (dryRun && !read) {
    console.log(`  [dry-run] d1: ${sql.slice(0, 120)}…`);
    return [];
  }
  const out = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", sql], { read });
  return JSON.parse(out).flatMap((r) => r.results ?? []);
}

async function doh(name, type) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`, { headers: { accept: "application/dns-json" } });
  const j = await r.json();
  return (j.Answer ?? []).map((a) => a.data);
}

const enabled = (out) => /Enabled:\s+true/i.test(out);

// Omitting --mailboxes uses the names already configured in the app. Never
// invent addresses: onboarding must match the user's mailbox configuration.
if (mailboxes === null) {
  mailboxes = d1(`SELECT m.local_part FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.name=${q(domain)} ORDER BY m.local_part`, { read: true }).map((m) => m.local_part);
}
console.log(`Receiving mailboxes: ${mailboxes.length ? mailboxes.map((m) => `${m}@${domain}`).join(", ") : "none configured"}`);

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

if (displayName) d1(`UPDATE domains SET display_name=${q(displayName)} WHERE id=${q(domainId)}`);
ok(`configure allowed senders under https://${HOSTNAME}/domains and tokens under https://${HOSTNAME}/tokens`);

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
