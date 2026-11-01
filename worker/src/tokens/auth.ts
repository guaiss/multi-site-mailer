import { sha256Hex } from "../lib/crypto";

export interface Permission {
  domain_id: string;
  read: boolean;
  send: boolean;
}
export interface Token {
  id: string;
  permissions: Permission[];
  site_id: string | null;
}

// Strict validation shared by management and authentication. Missing grants deny access.
export function parsePermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const seen = new Set<string>();
  const out: Permission[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object" || typeof p.domain_id !== "string" || !p.domain_id ||
        typeof p.read !== "boolean" || typeof p.send !== "boolean" || seen.has(p.domain_id)) return null;
    seen.add(p.domain_id);
    out.push({ domain_id: p.domain_id, read: p.read, send: p.send });
  }
  return out;
}

export function domainsFor(token: Token, action: "read" | "send"): string[] | null {
  const grants = token.permissions.filter((p) => p[action]);
  return grants.some((p) => p.domain_id === "*") ? null : grants.map((p) => p.domain_id);
}

export async function authenticateToken(req: Request, db: D1Database): Promise<Token | null> {
  const match = /^Bearer\s+((?:mt_|mk_|mr_)[A-Za-z0-9_-]{20,})$/.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  const row = await db.prepare("SELECT id, permissions, site_id FROM tokens WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(match[1])).first<{ id: string; permissions: string; site_id: string | null }>();
  if (!row) return null;
  try {
    const permissions = parsePermissions(JSON.parse(row.permissions));
    return permissions ? { ...row, permissions } : null;
  } catch {
    return null;
  }
}
