/**
 * Puls API keys — long-lived credentials for the Puls CLI / external agents.
 *
 * Flow: a signed-in user generates a key in the app (Profile → API Keys). The
 * raw key (`pk_live_…`) is shown ONCE; we store only its SHA-256 hash. The CLI
 * sends it as `Authorization: Bearer pk_live_…` (or an `x-api-key` header), and
 * the `apiKeyOrAuth` wrapper in server.js resolves it to the owner's userId so
 * the existing authed endpoints (agent chat, wallet, copilot) work unchanged.
 *
 * Data model (see migrations/2026-06-25-api-keys.sql):
 *   api_keys(id, user_id, key_hash unique, key_prefix, label, created_at,
 *            last_used_at, revoked)
 *
 * Security:
 *   - Only the SHA-256 hash is stored — the raw key is unrecoverable.
 *   - Keys are scoped to the owner's userId (same identity as the app).
 *   - Verified accounts only (web3 guests can't mint keys); strictLimiter throttles.
 *   - Capped at MAX_KEYS active keys per user.
 */
import crypto from 'node:crypto';

const KEY_PREFIX = 'pk_live_';
const MAX_KEYS = 10;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function generateRawKey() {
  // pk_live_ + 48 hex chars (24 random bytes).
  return KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}

/**
 * Resolve a raw API key to its owner's userId (or null). Touches last_used_at
 * best-effort. Used by the `apiKeyOrAuth` wrapper in server.js.
 */
export async function resolveApiKey(supabase, rawKey) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith(KEY_PREFIX)) return null;
  try {
    const hash = sha256(rawKey.trim());
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, user_id, revoked')
      .eq('key_hash', hash)
      .maybeSingle();
    if (error || !data || data.revoked) return null;
    // Fire-and-forget — never block the request on the bookkeeping update.
    supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {}, () => {});
    return data.user_id;
  } catch {
    return null;
  }
}

export function registerApiKeys(app, deps) {
  const { supabase, requireVerifiedUser, strictLimiter, apiKeyOrAuth } = deps;
  const limiter = strictLimiter || ((_req, _res, next) => next());

  // POST /api/keys/generate — mint a new key. The raw key is returned ONCE.
  app.post('/api/keys/generate', apiKeyOrAuth, requireVerifiedUser, limiter, async (req, res) => {
    try {
      const userId = req.body.userId; // forced to the verified id by authenticateUser
      if (!userId) return res.status(401).json({ error: 'Sign in required' });
      const label =
        (typeof req.body.label === 'string' ? req.body.label : '').trim().slice(0, 40) || 'Puls CLI';

      const { count } = await supabase
        .from('api_keys')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('revoked', false);
      if ((count || 0) >= MAX_KEYS) {
        return res
          .status(400)
          .json({ error: `You already have ${MAX_KEYS} active keys — revoke one first.` });
      }

      const rawKey = generateRawKey();
      const keyHash = sha256(rawKey);
      const keyPrefix = rawKey.slice(0, 12); // e.g. pk_live_ab12 (safe to display)
      const { data, error } = await supabase
        .from('api_keys')
        .insert({ user_id: userId, key_hash: keyHash, key_prefix: keyPrefix, label })
        .select('id, key_prefix, label, created_at')
        .single();
      if (error) throw error;

      res.json({
        ok: true,
        id: String(data.id), // serial int in legacy schema — always string out
        key: rawKey, // the ONLY time the raw key is ever returned
        prefix: data.key_prefix,
        label: data.label,
        createdAt: data.created_at,
      });
    } catch (e) {
      console.error('[api_keys] generate error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/keys - list my keys (never the raw key or its hash). The
  // middleware (JWT or pk_live_ key) forces req.query/body.userId to the
  // verified identity, so the look-up always matches how generate stored it.
  app.get('/api/keys', apiKeyOrAuth, async (req, res) => {
    try {
      const userId = req.query.userId || req.body.userId || null;
      if (!userId) return res.json({ ok: true, keys: [] });

      const { data, error } = await supabase
        .from('api_keys')
        .select('id, key_prefix, label, created_at, last_used_at, revoked')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) return res.json({ ok: true, keys: [] });
      res.json({
        ok: true,
        keys: (data || []).map((k) => ({
          id: String(k.id), // serial int in legacy schema — always string out
          prefix: k.key_prefix,
          label: k.label,
          createdAt: k.created_at,
          lastUsedAt: k.last_used_at,
          revoked: k.revoked,
        })),
      });
    } catch (e) {
      res.json({ ok: true, keys: [] });
    }
  });

  // POST /api/keys/revoke — revoke one of my keys.
  app.post('/api/keys/revoke', apiKeyOrAuth, requireVerifiedUser, limiter, async (req, res) => {
    try {
      const userId = req.body.userId;
      const id = req.body.id;
      if (!id) return res.status(400).json({ error: 'Key id required' });
      const { error } = await supabase
        .from('api_keys')
        .update({ revoked: true })
        .eq('id', id)
        .eq('user_id', userId);
      if (error) throw error;
      res.json({ ok: true, revoked: id });
    } catch (e) {
      console.error('[api_keys] revoke error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[api_keys] routes registered (generate / list / revoke)');
}
