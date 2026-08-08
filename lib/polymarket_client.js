/**
 * Puls Polymarket Gamma API client — resilient wrapper around all calls to
 * https://gamma-api.polymarket.com.
 *
 * Every one of the 15 call sites in server.js + lib/agent_swarm.js goes
 * through this client instead of calling `fetch()` directly. It provides:
 *
 *   1. Retry with exponential backoff (3 retries, 250ms → 500ms → 1s)
 *   2. Timeout (8s default, abortable via AbortController)
 *   3. 429 rate-limit handling (honors Retry-After header)
 *   4. Circuit breaker: serves last-known-good data (tagged `stale: true`)
 *      when a fresh fetch fails after all retries, instead of erroring out
 *   5. Per-minute request counter for rate-limit budget visibility
 *
 * Design: Polymarket is the ONLY market/resolution data source (intentional
 * and permanent). This client is about surviving Polymarket having a bad day
 * — not about replacing it.
 *
 * Wiring (server.js + lib/*.js):
 *   import { fetchGamma } from './lib/polymarket_client.js';
 *   const data = await fetchGamma('/markets?slug=btc-100k');
 */
import { captureException } from './observability.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GAMMA_TIMEOUT_MS || '8000', 10);
const DEFAULT_RETRIES = parseInt(process.env.GAMMA_RETRIES || '3', 10);
const STALE_TTL_MS = parseInt(process.env.GAMMA_STALE_TTL_MS || (10 * 60 * 1000), 10); // 10 min

// ── Circuit breaker: last-known-good cache ────────────────────────────────
// Keyed by full path. Stores { data, ts, stale } so callers can flag delayed
// data to the UI.
const _lastGoodCache = new Map();

/**
 * Returns the cached last-known-good response for a path, or null.
 * Stale entries expire after STALE_TTL_MS (so we don't serve data that's
 * hours old — better to error than serve very stale market data).
 */
function getLastGood(path) {
  const entry = _lastGoodCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.ts > STALE_TTL_MS) {
    _lastGoodCache.delete(path);
    return null;
  }
  return { ...entry.data, _stale: true, _staleAt: entry.ts };
}

function setLastGood(path, data) {
  _lastGoodCache.set(path, { data, ts: Date.now() });
}

// ── Rate-limit budget awareness ───────────────────────────────────────────
// Simple per-minute counter. Logged at the end of each minute window so the
// team can see actual call volume and get ahead of Gamma's rate limits.
let _requestCount = 0;
let _windowStart = Date.now();
let _rateLimited429s = 0;

function _tickRequestCounter() {
  _requestCount++;
  const elapsed = Date.now() - _windowStart;
  if (elapsed >= 60_000) {
    const rps = (_requestCount / (elapsed / 1000)).toFixed(1);
    console.log(
      `[gamma] rate: ${_requestCount} req in ${(elapsed / 1000).toFixed(0)}s ` +
      `(${rps}/s, ${_rateLimited429s} x 429)`
    );
    _requestCount = 0;
    _rateLimited429s = 0;
    _windowStart = Date.now();
  }
}

/** Consecutive failure counter — used by the resolution cron to detect
 *  a Gamma-wide outage vs. a single-market fetch failure. */
let _consecutiveFailures = 0;

/** Returns and resets the consecutive failure counter (for the cron). */
export function drainConsecutiveFailures() {
  const n = _consecutiveFailures;
  _consecutiveFailures = 0;
  return n;
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Fetch from the Gamma API with retry, backoff, timeout, and circuit breaker.
 *
 * @param {string} path — the path + query string (e.g. '/markets?slug=btc-100k')
 * @param {{ retries?: number, timeoutMs?: number, headers?: object, serveStale?: boolean }} opts
 * @returns {Promise<any>} — parsed JSON. If `serveStale` is true (default),
 *   returns last-known-good data (tagged `_stale: true`) when the fresh fetch
 *   fails after all retries. Otherwise throws.
 */
export async function fetchGamma(path, opts = {}) {
  const {
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = { Accept: 'application/json' },
    serveStale = true,
  } = opts;

  _tickRequestCounter();

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${GAMMA_BASE}${path}`, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timer);

      // Rate-limited — honor Retry-After or exponential backoff.
      if (res.status === 429) {
        _rateLimited429s++;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0)
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 10_000);
        console.warn(`[gamma] 429 rate-limited on ${path}, waiting ${waitMs}ms (attempt ${attempt + 1}/${retries + 1})`);
        await _sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Gamma API ${res.status} on ${path}`);
      }

      const data = await res.json();
      setLastGood(path, data);
      _consecutiveFailures = 0;
      return data;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        const backoffMs = Math.min(2 ** attempt * 250, 4000);
        await _sleep(backoffMs);
      }
    }
  }

  // All retries exhausted.
  _consecutiveFailures++;
  console.error(`[gamma] all ${retries + 1} attempts failed for ${path}: ${lastError?.message}`);

  // Circuit breaker: serve stale data if available + requested.
  if (serveStale) {
    const stale = getLastGood(path);
    if (stale) {
      console.warn(`[gamma] serving stale data for ${path} (age: ${Date.now() - stale._staleAt}ms)`);
      return stale;
    }
  }

  throw lastError || new Error(`Gamma API exhausted retries for ${path}`);
}

/**
 * Fetch markets from Gamma with the closed=true flag first (for resolution),
 * then fall back to the open query. Returns the first market in the list or null.
 *
 * Used by the resolution cron — encapsulates the "try closed first, then open"
 * pattern that was duplicated inline.
 */
export async function fetchMarketForResolution(slug) {
  // Try closed markets first (resolved markets come back as closed).
  let list = await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}&closed=true`, {
    serveStale: false, // resolution must use fresh data
  }).catch(() => []);

  if (!Array.isArray(list) || list.length === 0) {
    // Fall back to open markets (still-running ones).
    list = await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}`, {
      serveStale: false,
    }).catch(() => []);
  }

  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

/**
 * Batched variant of {@link fetchMarketForResolution}.
 *
 * The resolution cron used to call the single-slug version once per market,
 * and each call is up to two Gamma round-trips (closed, then open), each with
 * its own retry/backoff budget. A few dozen past-deadline markets therefore
 * cost a hundred-plus sequential HTTP requests per tick — minutes of wall time
 * before the first market could even be resolved.
 *
 * Gamma's /markets accepts a repeated `slug` parameter, so one request covers
 * a whole chunk. If Gamma ever stops honouring the repeated parameter it would
 * silently return the default top-of-book page instead, so every response is
 * checked against the slugs we asked for; anything unexpected falls back to
 * the per-slug path, which is exactly the old behaviour.
 *
 * @param {string[]} slugs
 * @returns {Promise<Map<string, any>>} slug → market (missing slugs are absent)
 */
export async function fetchMarketsForResolution(slugs) {
  const found = new Map();
  const unique = [...new Set(slugs.filter(Boolean))];
  if (unique.length === 0) return found;

  const CHUNK = 20;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const wanted = new Set(chunk);

    // Closed first (a settled market comes back closed), then open for the rest.
    let batchUsable = true;
    for (const suffix of ['&closed=true', '']) {
      const remaining = chunk.filter((s) => !found.has(s));
      if (remaining.length === 0) break;
      const query = remaining.map((s) => `slug=${encodeURIComponent(s)}`).join('&');

      let list = [];
      try {
        list = await fetchGamma(`/markets?${query}${suffix}`, { serveStale: false });
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) list = [];

      // Guard: if anything came back that we did not ask for, the repeated
      // `slug` parameter was ignored and this page is unrelated data.
      if (list.some((m) => !wanted.has(m?.slug))) {
        batchUsable = false;
        break;
      }
      for (const m of list) {
        if (m?.slug && !found.has(m.slug)) found.set(m.slug, m);
      }
    }

    if (!batchUsable) {
      for (const slug of chunk) {
        if (found.has(slug)) continue;
        const m = await fetchMarketForResolution(slug).catch(() => null);
        if (m) found.set(slug, m);
      }
    }
  }

  return found;
}

/** Stats for health-check / monitoring endpoints. */
export function gammaStats() {
  return {
    requestsThisMinute: _requestCount,
    rateLimited429s: _rateLimited429s,
    consecutiveFailures: _consecutiveFailures,
    staleCacheSize: _lastGoodCache.size,
  };
}

export default { fetchGamma, fetchMarketForResolution, fetchMarketsForResolution, drainConsecutiveFailures, gammaStats };
