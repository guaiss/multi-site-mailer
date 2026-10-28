// Reads the instance config from worker/wrangler.jsonc so scripts don't hard-code names.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WORKER_DIR = join(ROOT, "worker");

// Minimal JSONC: drop // and /* */ comments outside strings, then trailing commas.
export function parseJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i];
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function loadConfig() {
  let cfg;
  try {
    cfg = parseJsonc(readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8"));
  } catch (e) {
    throw new Error(`worker/wrangler.jsonc not found or invalid — run \`node scripts/setup.mjs\` first (${e.message})`);
  }
  return {
    workerName: cfg.name,
    d1Name: cfg.d1_databases?.[0]?.database_name,
    hostname: cfg.routes?.[0]?.pattern,
  };
}
