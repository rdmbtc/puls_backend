import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

let redisClient = null;
let redisPub = null;
let redisSub = null;

if (REDIS_URL) {
  try {
    const isSsl = REDIS_URL.startsWith('rediss://');
    const opts = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      }
    };
    if (isSsl) {
      opts.tls = { rejectUnauthorized: false };
    }

    redisClient = new Redis(REDIS_URL, opts);

    redisClient.on('connect', () => console.log('[redis] connected to Redis/Valkey instance'));
    redisClient.on('error', (err) => console.warn('[redis] connection error:', err.message));

  } catch (e) {
    console.error('[redis] client initialization error:', e.message);
  }
} else {
  console.log('[redis] REDIS_URL not set, running in-memory cache mode');
}

/**
 * Get cached JSON value from Redis/Valkey
 */
export async function cacheGet(key) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[redis] cacheGet error for ${key}:`, err.message);
    return null;
  }
}

/**
 * Set cached JSON value in Redis/Valkey with optional TTL in seconds
 */
export async function cacheSet(key, val, ttlSeconds = 300) {
  if (!redisClient) return false;
  try {
    const payload = JSON.stringify(val);
    if (ttlSeconds && ttlSeconds > 0) {
      await redisClient.set(key, payload, 'EX', ttlSeconds);
    } else {
      await redisClient.set(key, payload);
    }
    return true;
  } catch (err) {
    console.warn(`[redis] cacheSet error for ${key}:`, err.message);
    return false;
  }
}

/**
 * Delete cached key
 */
export async function cacheDel(key) {
  if (!redisClient) return false;
  try {
    await redisClient.del(key);
    return true;
  } catch (err) {
    console.warn(`[redis] cacheDel error for ${key}:`, err.message);
    return false;
  }
}

/**
 * High-performance sliding window Rate Limiter via Redis INCR + EXPIRE
 */
export async function rateLimitCheck(identifier, limit = 60, windowSeconds = 60) {
  if (!redisClient) return { allowed: true, current: 0, remaining: limit };
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
    console.warn('[redis] rateLimitCheck error:', err.message);
    return { allowed: true, current: 0, remaining: limit };
  }
}

/**
 * Real-time Leaderboard ZSET (Sorted Set)
 */
export async function updateLeaderboard(member, score) {
  if (!redisClient) return false;
  try {
    await redisClient.zadd('leaderboard:pnl', score, member);
    return true;
  } catch (err) {
    console.warn('[redis] updateLeaderboard error:', err.message);
    return false;
  }
}

export async function getTopLeaderboard(limit = 10) {
  if (!redisClient) return [];
  try {
    const raw = await redisClient.zrevrange('leaderboard:pnl', 0, limit - 1, 'WITHSCORES');
    const result = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
    }
    return result;
  } catch (err) {
    console.warn('[redis] getTopLeaderboard error:', err.message);
    return [];
  }
}

/**
 * Express Middleware for Caching Endpoints
 */
export function cacheMiddleware(ttlSeconds = 60, keyPrefix = 'route') {
  return async (req, res, next) => {
    if (!redisClient || req.method !== 'GET') return next();

    const cacheKey = `${keyPrefix}:${req.originalUrl || req.url}`;
    try {
      const cachedData = await cacheGet(cacheKey);
      if (cachedData) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Provider', 'Valkey/Redis');
        return res.json(cachedData);
      }

      res.setHeader('X-Cache', 'MISS');
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && body) {
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

export { redisClient };
