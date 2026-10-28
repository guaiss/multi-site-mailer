// Verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) instead of
// trusting the plain `Cf-Access-Authenticated-User-Email` header, which anyone
// can forge if the Worker is ever reached without Access in front of it.
//
// Requires two Worker vars:
//   ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com"
//   ACCESS_AUD          the Access application's Audience (AUD) tag

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const CERTS_TTL_MS = 10 * 60 * 1000;
let certsCache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function getKeys(team: string, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh && certsCache && certsCache.team === team && Date.now() - certsCache.at < CERTS_TTL_MS) {
    return certsCache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k.kty !== "RSA") continue;
    map.set(
      k.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  certsCache = { team, at: Date.now(), keys: map };
  return map;
}

// Returns the verified, lowercased email, or null if the token is missing/invalid.
export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let key = (await getKeys(team, false)).get(header.kid);
  if (!key) key = (await getKeys(team, true)).get(header.kid); // key rotation
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return payload.email.trim().toLowerCase();
}
