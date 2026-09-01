import Redis from 'ioredis';
import fs from 'node:fs';

// Prefer the Aiven-native VALKEY_URL; fall back to REDIS_URL so the same code
// works with Heroku Redis / other Redis-compatible providers.
const REDIS_URL = process.env.VALKEY_URL || process.env.REDIS_URL;

let redisClient = null;
let isRedisConnected = false;

export function isRedisReady() {
  return Boolean(redisClient && isRedisConnected && redisClient.status === 'ready');
}

if (REDIS_URL) {
  try {
    const isSsl = REDIS_URL.startsWith('rediss://');
    // TLS policy: STRICT verification by default (Aiven's managed services now
    // present publicly-trusted chains, e.g. anchored at ISRG Root X1). Pin a
    // custom CA via VALKEY_CA_CERT/REDIS_CA_CERT, or set VALKEY_INSECURE_TLS=true
    // for self-signed endpoints that can't be pinned.
    const caPath = process.env.VALKEY_CA_CERT || process.env.REDIS_CA_CERT;
    const insecure = String(process.env.VALKEY_INSECURE_TLS || '').toLowerCase() === 'true';
    const opts = {
      enableOfflineQueue: false, // Never hang or queue requests if Redis is unreachable
      maxRetriesPerRequest: 1,   // Fail fast instead of retrying endlessly and causing 500s
      enableReadyCheck: true,
      enableAutoPipelining: true,
      keepAlive: 30000,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 10) return null; // Stop reconnecting if dead
        const delay = Math.min(times * 200, 2000);
        return delay;
      }
    };
    if (isSsl) {
      if (caPath) {
        opts.tls = { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
      } else if (insecure) {
        opts.tls = { rejectUnauthorized: false };
      } else {
        opts.tls = { rejectUnauthorized: true };
      }
    }

    redisClient = new Redis(REDIS_URL, opts);

    redisClient.on('connect', () => console.log('[valkey] connected to Valkey/Redis instance'));
    redisClient.on('ready', () => {
      isRedisConnected = true;
      console.log('[valkey] ready');
    });
    redisClient.on('error', (err) => {
      isRedisConnected = false;
      console.warn('[valkey] connection error:', err.message);
    });
    redisClient.on('close', () => {
      isRedisConnected = false;
      console.warn('[valkey] connection closed');
    });
    redisClient.on('end', () => {
      isRedisConnected = false;
    });

  } catch (e) {
    console.error('[valkey] client initialization error:', e.message);
  }
} else {
  console.log('[valkey] VALKEY_URL/REDIS_URL not set, running in-memory cache mode');
}

/**
 * Get cached JSON value from Redis/Valkey
 */
export async function cacheGet(key) {
  if (!isRedisReady()) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[valkey] cacheGet error for ${key}:`, err.message);
    return null;
  }
}

/**
 * Set cached JSON value in Redis/Valkey with optional TTL in seconds
 */
export async function cacheSet(key, val, ttlSeconds = 300) {
  if (!isRedisReady()) return false;
  try {
    const payload = JSON.stringify(val);
    if (ttlSeconds && ttlSeconds > 0) {
      await redisClient.set(key, payload, 'EX', ttlSeconds);
    } else {
      await redisClient.set(key, payload);
    }
    return true;
  } catch (err) {
    console.warn(`[valkey] cacheSet error for ${key}:`, err.message);
    return false;
  }
}

/**
 * Delete cached key
 */
export async function cacheDel(key) {
  if (!isRedisReady()) return false;
  try {
    await redisClient.del(key);
    return true;
  } catch (err) {
    console.warn(`[valkey] cacheDel error for ${key}:`, err.message);
    return false;
  }
}

/**
 * High-performance fixed-window Rate Limiter via Redis INCR + EXPIRE
 */
export async function rateLimitCheck(identifier, limit = 60, windowSeconds = 60) {
  if (!isRedisReady()) return { allowed: true, current: 0, remaining: limit };
  try {
    const key = `ratelimit:${identifier}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, windowSeconds);
    }
    const allowed = count <= limit;
    return {
      allowed,
      current: count,
      remaining: Math.max(0, limit - count),
      resetSeconds: windowSeconds
    };
  } catch (err) {
    console.warn('[valkey] rateLimitCheck error:', err.message);
    return { allowed: true, current: 0, remaining: limit };
  }
}

/**
 * Real-time Leaderboard ZSET (Sorted Set)
 */
export async function updateLeaderboard(member, score) {
  if (!isRedisReady()) return false;
  try {
    await redisClient.zadd('leaderboard:pnl', score, member);
    return true;
  } catch (err) {
    console.warn('[valkey] updateLeaderboard error:', err.message);
    return false;
  }
}

export async function getTopLeaderboard(limit = 10) {
  if (!isRedisReady()) return [];
  try {
    const raw = await redisClient.zrevrange('leaderboard:pnl', 0, limit - 1, 'WITHSCORES');
    const result = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
    }
    return result;
  } catch (err) {
    console.warn('[valkey] getTopLeaderboard error:', err.message);
    return [];
  }
}

/**
 * Express Middleware for Caching Endpoints.
 *
 * Only wire this onto PUBLIC, non-user-specific GET routes — the cache key is
 * the URL and takes no auth identity into account. Data that must never go
 * stale (balances, trade state) must NOT be cached.
 */
export function cacheMiddleware(ttlSeconds = 60, keyPrefix = 'route') {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();

    const cacheKey = `${keyPrefix}:${req.originalUrl || req.url}`;

    // L1: in-memory cache (single dyno) — a Valkey GET was taking ~700ms from
    // the dyno (cross-region TLS), which made even cache HITs slow. Hot public
    // endpoints (markets, stats, …) now serve in a few ms; Valkey stays as L2
    // so the same middleware still works with multiple dynos.
    const now = Date.now();
    const mem = memCache.get(cacheKey);
    if (mem && now - mem.at < MEM_TTL_MS) {
      res.setHeader('X-Cache', 'MEM');
      res.setHeader('X-Cache-Provider', 'in-memory');
      return res.json(mem.data);
    }

    if (!isRedisReady()) return next();

    try {
      const cachedData = await cacheGet(cacheKey);
      if (cachedData) {
        setMemCache(cacheKey, cachedData, now);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Provider', 'Aiven Valkey');
        return res.json(cachedData);
      }

      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Provider', 'Aiven Valkey');
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && body) {
          setMemCache(cacheKey, body, now);
          cacheSet(cacheKey, body, ttlSeconds).catch(() => {});
        }
        return originalJson(body);
      };
      next();
    } catch (e) {
      next();
    }
  };
}

const memCache = new Map();
const MEM_TTL_MS = 15_000;
const MAX_MEM_CACHE_ENTRIES = 500;

function setMemCache(key, data, now) {
  if (memCache.size >= MAX_MEM_CACHE_ENTRIES) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey) memCache.delete(oldestKey);
  }
  memCache.set(key, { at: now, data });
}

/**
 * Valkey-backed store for express-rate-limit (fixed window, INCR + EXPIRE).
 * Counters survive dyno restarts and are shared across dynos, unlike the
 * default in-memory MemoryStore. Returns undefined when Valkey is not
 * configured so express-rate-limit transparently falls back to its own store.
 *
 * CRITICAL RESILIENCE: If Valkey is down, unreachable, or throwing errors,
 * this store fails open gracefully via an internal memory Map rather than
 * throwing unhandled exceptions that crash API requests with 500.
 */
export function createValkeyRateLimitStore(windowMs, tag = '') {
  if (!redisClient) return undefined;
  const prefix = `rl:${tag ? tag + ':' : ''}`;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const bucketKey = (key) => `${prefix}${key}:${Math.floor(Date.now() / windowMs)}`;
  const resetTime = () => new Date((Math.floor(Date.now() / windowMs) + 1) * windowMs);

  // Fallback in-memory map for when Redis is disconnected or errors
  const localFallback = new Map();

  return {
    localKeys: false,
    prefix,
    async increment(key) {
      const k = bucketKey(key);
      if (isRedisReady()) {
        try {
          const count = await redisClient.incr(k);
          if (count === 1) {
            await redisClient.expire(k, windowSeconds);
          }
          return { totalHits: count, resetTime: resetTime() };
        } catch (err) {
          console.warn(`[valkey rate-limit] increment fallback for ${k}:`, err.message);
        }
      }
      // Fail-open in-memory fallback
      const prev = localFallback.get(k) || 0;
      const nextCount = prev + 1;
      localFallback.set(k, nextCount);
      if (localFallback.size > 2000) {
        const first = localFallback.keys().next().value;
        if (first) localFallback.delete(first);
      }
      return { totalHits: nextCount, resetTime: resetTime() };
    },
    async get(key) {
      const k = bucketKey(key);
      if (isRedisReady()) {
        try {
          const raw = await redisClient.get(k);
          if (raw != null) return { totalHits: parseInt(raw, 10) || 0, resetTime: resetTime() };
        } catch (err) {
          console.warn(`[valkey rate-limit] get fallback for ${k}:`, err.message);
        }
      }
      const val = localFallback.get(k);
      return val != null ? { totalHits: val, resetTime: resetTime() } : undefined;
    },
    async decrement(key) {
      const k = bucketKey(key);
      if (isRedisReady()) {
        try {
          const v = await redisClient.decr(k);
          if (v < 0) await redisClient.del(k);
          return;
        } catch (_) {}
      }
      const val = (localFallback.get(k) || 0) - 1;
      if (val <= 0) localFallback.delete(k);
      else localFallback.set(k, val);
    },
    async resetKey(key) {
      const k = bucketKey(key);
      localFallback.delete(k);
      if (isRedisReady()) {
        try { await redisClient.del(k); } catch (_) {}
      }
    },
    async resetAll() {
      localFallback.clear();
      if (isRedisReady()) {
        try {
          const keys = await redisClient.keys(`${prefix}*`);
          if (keys.length) await redisClient.del(keys);
        } catch (_) {}
      }
    },
    async shutdown() {
      await shutdownRedis();
    }
  };
}

/**
 * Ping the instance — for health/status endpoints.
 */
export async function redisPing() {
  if (!redisClient) return null;
  try {
    const pong = await redisClient.ping();
    return pong === 'PONG' ? 'PONG' : String(pong);
  } catch (err) {
    console.warn('[valkey] ping error:', err.message);
    return null;
  }
}

/**
 * Lightweight server stats for /api/redis/status (INFO-based, no heavy SCAN).
 */
export async function getRedisStats() {
  if (!redisClient) return null;
  try {
    const [server, memory, clients] = await Promise.all([
      redisClient.info('server'),
      redisClient.info('memory'),
      redisClient.info('clients'),
    ]);
    return {
      version: /^redis_version:(\S+)/m.exec(server)?.[1] || null,
      mode: /^redis_mode:(\S+)/m.exec(server)?.[1] || null,
      usedMemory: /^used_memory_human:(\S+)/m.exec(memory)?.[1] || null,
      connectedClients: /^connected_clients:(\d+)/m.exec(clients)?.[1] || null,
    };
  } catch (err) {
    console.warn('[valkey] stats error:', err.message);
    return null;
  }
}

/**
 * Graceful disconnect — call on SIGTERM/SIGINT so Heroku restarts don't leak
 * sockets into the next process.
 */
export async function shutdownRedis() {
  if (!redisClient) return;
  try {
    await redisClient.quit();
  } catch (_) {
    redisClient.disconnect();
  }
}

export { redisClient };
