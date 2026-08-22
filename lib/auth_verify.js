/**
 * Cryptographic token verification for the two auth paths Puls accepts:
 *
 *   1. Supabase JWTs (ES256)  — verified against the project's published JWKS
 *      (https://<ref>.supabase.co/auth/v1/.well-known/jwks.json). Keys are
 *      cached in-process for 10 minutes and refreshed on unknown `kid`.
 *
 *   2. "Puls Direct" tokens — minted by /api/auth/google/callback when Supabase
 *      egress is unavailable. These used to carry the literal signature string
 *      "signed_puls_direct", which ANYONE could forge (and authenticate as any
 *      userId). They are now real HS256 JWTs signed with a server-side secret.
 *
 * SECURITY: every fallback path in server.js must go through one of these
 * verifiers. Never trust a decoded payload whose signature wasn't checked.
 */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

const b64urlJson = (s) => {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// ── 1. Puls Direct tokens (HS256) ────────────────────────────────────────────

/**
 * Signing secret for Puls Direct session tokens. Prefers an explicit
 * PULS_SESSION_SECRET; otherwise derives a stable secret from other configured
 * server-only credentials so existing deployments keep working with zero new
 * config. Set PULS_SESSION_SECRET in production for clean key rotation.
 */
export function pulsSessionSecret() {
  const explicit = (process.env.PULS_SESSION_SECRET || '').trim();
  if (explicit) return explicit;
  return createHash('sha256')
    .update(`puls-direct:v1:${process.env.GOOGLE_CLIENT_SECRET || ''}:${process.env.CIRCLE_ENTITY_SECRET || ''}`)
    .digest('hex');
}

/** Mint a signed Puls Direct token (HS256). `payload.sub` must be set. */
export function signPulsDirectToken(payload, expiresInSeconds = 30 * 24 * 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString('base64url');
  const sig = createHmac('sha256', pulsSessionSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Verify a Puls Direct HS256 token. Returns the payload or null. */
export function verifyPulsDirectToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = createHmac('sha256', pulsSessionSecret()).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const payload = b64urlJson(parts[1]);
    if (!payload || typeof payload !== 'object') return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) return null;
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── 2. Supabase tokens (ES256 via JWKS) ─────────────────────────────────────

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // issuer base -> { keys: Map<kid, KeyObject>, fetchedAt }

async function getSupabaseJwks(baseUrl) {
  const cached = jwksCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS && cached.keys.size > 0) return cached.keys;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const { keys } = await res.json();
  const map = new Map();
  for (const k of keys || []) {
    try {
      map.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    } catch { /* unsupported key type — skip */ }
  }
  jwksCache.set(baseUrl, { keys: map, fetchedAt: Date.now() });
  return map;
}

/**
 * Verify a Supabase-signed JWT (ES256/RS* family) against the project JWKS.
 * @param {string} token   raw bearer token
 * @param {string} supabaseUrl  e.g. https://<ref>.supabase.co
 * @returns {object|null} verified payload, or null when anything fails
 */
export async function verifySupabaseJwt(token, supabaseUrl) {
  try {
    const base = (supabaseUrl || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    if (!base || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (!header || !payload) return null;
    // Asymmetric algorithms only — never accept "none"/HS here.
    if (!/^ES|^RS|^PS/.test(String(header.alg || ''))) return null;

    let keys = await getSupabaseJwks(base);
    let key = header.kid ? keys.get(header.kid) : null;
    // Key rotation: refresh cache once when the kid is unknown.
    if (!key && header.kid) {
      jwksCache.delete(base);
      keys = await getSupabaseJwks(base);
      key = keys.get(header.kid);
    }
    if (!key) return null;

    const sig = Buffer.from(parts[2], 'base64url');
    const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return null;
    if (payload.nbf && payload.nbf > nowSec) return null;
    // Issuer must be this Supabase project's auth endpoint.
    if (payload.iss && payload.iss !== `${base}/auth/v1`) return null;
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export default { pulsSessionSecret, signPulsDirectToken, verifyPulsDirectToken, verifySupabaseJwt };
