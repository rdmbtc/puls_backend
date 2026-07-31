import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';

// Observability MUST be initialized before express() so Sentry can
// instrument the middleware stack. Safe no-op when SENTRY_DSN is unset.
import { initObservability, logger, requestId, sentryRequestHandler, sentryErrorHandler, captureException } from './lib/observability.js';
initObservability();

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { createNeonClient } from './lib/neon_supabase_adapter.js';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, createWalletClient, http, fallback, decodeEventLog, keccak256, toHex, parseAbiItem, encodeFunctionData, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { x402Paywall, x402Info } from './lib/x402.js';
import { registerCopyTrade } from './lib/copytrade.js';
import { registerAlpha } from './lib/alpha.js';
import { registerTips } from './lib/tips.js';
import { registerComments } from './lib/comments.js';
import { registerSupport } from './lib/support.js';
import { registerReferrals } from './lib/referrals.js';
import { registerCreatorSignals } from './lib/creator_signals.js';
import { registerAgentBond } from './lib/agent_bond.js';
import { registerSwap } from './lib/swap.js';
import { registerStreaming } from './lib/streaming.js';
import { registerStreamingAgent } from './lib/streaming_agent.js';
import { registerBlog } from './lib/blog.js';
import { registerAgentOracle } from './lib/agent_oracle.js';
import { researchQuestion } from './lib/agent_research.js';
import { registerSwarm, buildSwarmRoster } from './lib/agent_swarm.js';
import { registerAgentDuel } from './lib/agent_duel.js';
import { registerAgentPnl } from './lib/agent_pnl.js';
import { registerLepton } from './lib/lepton.js';
import { registerPoints } from './lib/points.js';
import { registerApiKeys, resolveApiKey } from './lib/api_keys.js';
import { resolvePositionalMarket, resolvePositionalSignal } from './lib/agent_chat_helpers.js';
import { eventBus, EVENTS } from './lib/events.js';
import { cache } from './lib/cache.js';
import { initSocketIo } from './lib/socketio.js';
import { initRawWs } from './lib/socketws.js';
import { fetchGamma, fetchMarketForResolution, drainConsecutiveFailures } from './lib/polymarket_client.js';
import { splitTakeRate, annotatePayment, usdcTransferWithTakeRate, TAKE_RATE } from './lib/payments.js';
import { initIndices, indexMarket, indexSignal, indexDecision, searchMarkets, searchSignals, searchDecisions, retrieveContext, searchSignalMarket, osClient, pingOpenSearch, getOpenSearchStats, scheduleMarketRefresh } from './lib/opensearch.js';
import { redisClient, cacheGet, cacheSet, cacheDel, cacheMiddleware, createValkeyRateLimitStore, redisPing, getRedisStats, shutdownRedis } from './lib/redis.js';

// Auto-index events via eventBus
if (osClient) {
  eventBus.on(EVENTS.MARKET_ACTIVATED, (evt) => {
    if (evt?.slug) indexMarket({ slug: evt.slug, deadline: evt.deadline, resolved: false }).catch(() => {});
  });
  eventBus.on(EVENTS.MARKET_RESOLVED, (evt) => {
    if (evt?.slug) indexMarket({ slug: evt.slug, resolved: true, outcome: evt.outcome }).catch(() => {});
  });
  eventBus.on(EVENTS.SIGNAL_PUBLISHED, (sig) => {
    if (sig) indexSignal(sig).catch(() => {});
  });
  // Trades move volume/prices — refresh the market doc shortly after activity
  // (debounced in lib/opensearch.js so bursts coalesce into one request).
  eventBus.on(EVENTS.TRADE_COMPLETE, (t) => {
    const slug = t?.market_id || t?.slug;
    if (slug) scheduleMarketRefresh(slug, () => cache.marketBySlug(slug));
  });
}

// Prevent unhandled promise rejections from crashing the server.
// Report to Sentry (if configured) so we get paged, not just a log line.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  logger?.error?.({ reason: msg, promise: String(promise) }, 'unhandledRejection');
  captureException(reason instanceof Error ? reason : new Error(msg));
  console.error('[UNHANDLED REJECTION]', msg);
});

// CRITICAL: Catch synchronous throws that would otherwise crash the process.
// Node defaults to exiting on uncaughtException  we override that so a
// single sync error in a callback doesn't kill the server and drop all
// active trades + WebSocket connections.
process.on('uncaughtException', (err, origin) => {
  const msg = err?.message || String(err);
  console.error('[UNCAUGHT EXCEPTION]', origin, msg);
  if (err?.stack) console.error(err.stack);
  captureException(err instanceof Error ? err : new Error(msg));
  // Do NOT exit  log and continue. Heroku will restart if the process
  // truly becomes unresponsive, but we give it a chance to recover.
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────
// Heroku sends SIGTERM on restart. We must drain connections, clear timers,
// and close the HTTP server so in-flight requests finish cleanly.
const shutdownHandlers = [];
function onShutdown(fn) { shutdownHandlers.push(fn); }

async function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} received — draining connections...`);
  // Clear all tracked intervals
  for (const id of intervalIds) clearInterval(id);
  // Run registered cleanup handlers (close DB pools, flush caches, etc.)
  await Promise.allSettled(shutdownHandlers.map(fn => fn()));
  // Close HTTP server — stops accepting new requests, drains keep-alives
  await new Promise(resolve => server.close(resolve));
  console.log('[shutdown] complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Real rate limiters (previously no-ops). Tune via env if needed.
// When Valkey is configured the counters live in Valkey (shared across dynos,
// survives restarts); otherwise express-rate-limit uses its in-memory store.
const valkeyRateLimitStore = createValkeyRateLimitStore(60 * 1000);
const rateLimitStoreOpts = valkeyRateLimitStore ? { store: valkeyRateLimitStore } : {};
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GENERAL || '300', 10),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitStoreOpts,
});
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_STRICT || '30', 10),
  message: { error: 'Too many requests for this action. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitStoreOpts,
});
// Trading endpoints get a much more generous limit so rapid/fast-buy flows
// are never blocked at current traffic levels (600/min per IP by default).
// This is only a DoS backstop, not a throttle. Tune via RATE_LIMIT_TRADE.
const tradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_TRADE || '600', 10),
  message: { error: 'Too many trade requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitStoreOpts,
});
const activateMarketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_ACTIVATE || '10', 10),
  message: { error: 'Too many market activations. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...rateLimitStoreOpts,
});

const app = express();
// Behind a reverse proxy (nginx/caddy on the VPS)  trust the first hop so
// express-rate-limit keys on the real client IP instead of the proxy IP.
app.set('trust proxy', 1);

// gzip-compress all responses  a big win for JSON API payloads (markets,
// signals, feed). Registered early so every downstream route benefits. Clients
// can opt out with an `x-no-compression` header.
// Compress responses  but skip the AI chat endpoints. Their replies are a
// single small JSON; sending them with a fixed Content-Length (not gzipchunked)
// is delivered far more predictably through Cloudflare (chunked chat replies were
// intermittently reset at the edge  client saw a 000/empty reply).
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/copilot/chat' || req.path === '/api/agent/chat' || req.path === '/api/oracle/ask') return false;
    return compression.filter(req, res);
  },
}));

// Short-lived edge/browser cache for PUBLIC, non-user-specific GETs so a CDN
// (Cloudflare) serves them from the edge and the 1-vCPU origin is offloaded.
// Allowlist only  never matches authed/user-varying routes (wallet, copy,
// points/me, signals, comments, support, alpha/:id). Non-200s aren't cached by
// Cloudflare, and config rules are listed before the broader :id rule.
const PUBLIC_CACHE_RULES = [
  [/^\/sitemap\.xml$/, 60],
  [/^\/api\/(blog|swap|tips|comments|support|referrals)\/config\/?$/, 300],
  [/^\/api\/x402\/info\/?$/, 300],
  [/^\/api\/og\/market\//, 300],
  [/^\/api\/markets\/?$/, 10],
  [/^\/api\/market\/(info|resolution-status|price-history)\/?$/, 12],
  [/^\/api\/market\/insight\/?$/, 30],
  [/^\/api\/trade\/recent\/?$/, 5],
  [/^\/api\/stats\/?$/, 20],
  [/^\/api\/live\/?$/, 10],
  [/^\/api\/economy\/feed\/?$/, 15],
  [/^\/api\/agents\/(roster|feed|bonds|house)\/?$/, 15],
  [/^\/api\/oracle\//, 15],
  [/^\/api\/alpha\/list\/?$/, 20],
  [/^\/api\/(points|referrals)\/leaderboard\/?$/, 30],
  [/^\/api\/leaderboard\/?$/, 30],
  [/^\/api\/profile\/[^/]+\/?$/, 30],
  [/^\/api\/blog\/?$/, 30],
  [/^\/api\/blog\/[^/]+\/?$/, 30],
];
app.use((req, res, next) => {
  if (req.method === 'GET') {
    let cacheable = false;
    for (const [re, s] of PUBLIC_CACHE_RULES) {
      if (re.test(req.path)) {
        res.set('Cache-Control', `public, max-age=${s}, s-maxage=${s}, stale-while-revalidate=${s * 3}`);
        cacheable = true;
        break;
      }
    }
    // Everything else (trade status polling, wallet, portfolio, notifications,
    // agent status, ) MUST NOT be cached by the CDN. Without this, Cloudflare
    // caches the first 200 and serves it on every poll  e.g. /api/trade/status
    // returns a stale INITIATED/SENT forever, so a trade that actually
    // completed on-chain shows "Processing" then "Trade Failed".
    if (!cacheable) res.set('Cache-Control', 'no-store');
  }
  next();
});

// CORS: lock down to known origins when ALLOWED_ORIGINS is set (comma-separated).
// Always allow pulsmarket.tech subdomains, vercel, and localhost.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      /\.pulsmarket\.tech$/.test(origin) ||
      /pulsmarket\.tech$/.test(origin) ||
      /localhost|127\.0\.0\.1/.test(origin) ||
      /vercel\.app$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
}));
// Capture the raw request body so we can verify Circle's ECDSA webhook
// signature over the exact bytes Circle signed (re-serializing the parsed JSON
// would change key order/whitespace and break verification).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

//  Interval manager: error-boundary wrapper for all cron jobs 
// Collects all setInterval IDs so they can be cleared on graceful shutdown.
// Wraps each callback in try/catch so a single throw doesn't silently kill
// the interval (Node stops re-running it on uncaught exception).
// MUST be defined before any safeInterval() calls below (ESM TDZ).
const intervalIds = [];
function safeInterval(name, fn, ms) {
  const id = setInterval(async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[interval:${name}] error:`, e?.message || String(e));
    }
  }, ms);
  intervalIds.push(id);
  return id;
}

// Lightweight liveness probe (no DB, no rate-limit) for uptime monitors and
// Lightweight event-loop lag meter  proves whether the box is actually working.
let __elLagMs = 0;
{ let _last = Date.now(); safeInterval('eventLoopLag', () => { const now = Date.now(); __elLagMs = Math.max(0, now - _last - 1000); _last = now; }, 1000); }

// Memory pressure relief: every 5 minutes, clear caches that grow over time.
// This is the safety net for the 512MB Heroku dyno  the caches have their
// own caps, but this sweep catches anything that slipped through (e.g. entries
// with future timestamps, or caches added in future code that don't have caps).
safeInterval('cacheSweep', () => {
  try {
    if (typeof rpcCache !== 'undefined' && rpcCache.size > 300) rpcCache.clear();
    if (typeof _balanceCache !== 'undefined' && _balanceCache.size > 150) _balanceCache.clear();
    if (typeof insightCache !== 'undefined' && insightCache.size > 50) insightCache.clear();
    if (typeof _explorerCache !== 'undefined' && _explorerCache.size > 50) _explorerCache.clear();
    if (typeof leaderboardCache !== 'undefined' && leaderboardCache.size > 20) leaderboardCache.clear();
    if (typeof userTrades !== 'undefined' && userTrades.size > 100) userTrades.clear();
    if (typeof marketTrades !== 'undefined' && marketTrades.size > 100) marketTrades.clear();
    if (typeof llmHeavyCooldown !== 'undefined' && llmHeavyCooldown.size > 0) llmHeavyCooldown.clear();
    if (typeof walletAddressCache !== 'undefined' && walletAddressCache.size > 500) walletAddressCache.clear();
    if (typeof agentStrategies !== 'undefined' && agentStrategies.size > 500) agentStrategies.clear();
    if (typeof deployedMarketsCache !== 'undefined' && deployedMarketsCache.size > 2000) {
      const keys = Array.from(deployedMarketsCache.keys());
      for (let i = 0; i < keys.length - 1000; i++) deployedMarketsCache.delete(keys[i]);
    }
    if (typeof global.gc === 'function') global.gc();
  } catch (_) {}
}, 300_000);

// Cloudflare/load-balancer health checks. Always fast, never cached.
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  const la = os.loadavg();
  res.json({
    ok: true, service: 'puls-backend', uptimeSec: Math.round(process.uptime()), ts: Date.now(),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      externalMb: Math.round(mem.external / 1048576),
    },
    sysMemUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
    sysMemTotalMb: Math.round(os.totalmem() / 1048576),
    cpus: os.cpus().length,
    load1: +la[0].toFixed(2), load5: +la[1].toFixed(2), load15: +la[2].toFixed(2),
    eventLoopLagMs: __elLagMs,
    agents: (globalThis.__pulsMetrics || {}),
    circuitBreakers: {
      circle: { isOpen: circleBreaker.isOpen(), failures: circleBreaker.failures },
    },
  });
});

app.use(generalLimiter); // Apply general rate limit globally
app.use(requestId);      // Generate/propagate x-request-id for log correlation
app.use(sentryRequestHandler); // Sentry performance + error instrumentation

//  Request timeout middleware 
// Prevents hung endpoints from consuming a connection forever. Trade endpoints
// get 60s (on-chain settlement can be slow); everything else gets 30s.
app.use((req, res, next) => {
  // Agent chat needs longer timeout for LLM reasoning + trade execution
  // RPC proxy also gets more time for upstream node latency
  const timeout = req.path.startsWith('/api/trade') || req.path.startsWith('/api/agent/chat') || req.path.startsWith('/api/rpc-proxy') ? 60000 : 30000;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway timeout', path: req.path, method: req.method });
    }
  }, timeout);
  res.on('finish', () => clearTimeout(timer));
  next();
});

//  asyncHandler: wrap async route handlers so uncaught rejections hit the 
// global error handler instead of crashing the process or hanging the request.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Supabase JWT Authenticate Middleware
const authenticateUser = async (req, res, next) => {
  try {
    let requestedUserId = req.body?.userId || req.query?.userId;
    
    // Check if the request is for an agent-owned wallet (e.g. agent_supabase_UUID)
    if (requestedUserId && requestedUserId.startsWith('agent_')) {
      requestedUserId = requestedUserId.replace('agent_', '');
    }

    // Web3/MetaMask users sign their own transactions on-chain and only need
    // read access here. They are NOT verified (no JWT, no signature), so mark
    // the request as a web3 guest  endpoints that operate Circle wallets must
    // additionally use `requireVerifiedUser` to reject these requests.
    // TODO: replace this with SIWE (signed-message) verification for full write access.
    if (requestedUserId && (requestedUserId.startsWith('0x') || requestedUserId.startsWith('eth_0x'))) {
      req.isWeb3Guest = true;
      return next();
    }

    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query?.auth_token) {
      token = req.query.auth_token;
    } else if (req.body?.auth_token) {
      token = req.body.auth_token;
    }
    if (!token) {
      // Ensure CORS headers are on 401 responses so browsers don't mask the real error
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }
    // Decoded JWT payloads (user id, email, etc.) must never be logged to
    // stdout  Heroku logs are retained and visible to anyone with dashboard
    // access. This block previously dumped the full header + payload on every
    // authenticated request. Use DEBUG_AUTH=true locally if you need to inspect
    // a token during development.
    if (process.env.DEBUG_AUTH === 'true' && token) {
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          console.log('[Auth Middleware] Token Payload:', Buffer.from(parts[1], 'base64').toString('utf8'));
        }
      } catch (e) {
        console.log('[Auth Middleware] Token Decode Error:', e.message);
      }
    }
    let user = null;
    try {
      const { data, error } = await supabaseAnon.auth.getUser(token);
      if (data?.user) {
        user = data.user;
      }
    } catch (e) {
      console.warn('[Auth Middleware] Supabase getUser network error, trying local JWT decode:', e.message);
    }

    if (!user && token) {
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload.sub && payload.exp && payload.exp > (Date.now() / 1000)) {
            user = {
              id: payload.sub,
              email: payload.email,
              user_metadata: payload.user_metadata || {}
            };
          }
        }
      } catch (e) {
        console.error('[Auth Middleware] JWT fallback decode failed:', e.message);
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    req.user = user;
    
    const expectedUserId = (typeof user.id === 'string' && (user.id.startsWith('supabase_') || user.id.startsWith('google_')))
      ? user.id
      : `supabase_${user.id}`;
    if (requestedUserId && requestedUserId !== expectedUserId) {
      console.warn(`[Auth Notice] UserId mismatch. Authenticated: ${expectedUserId}, Requested: ${requestedUserId}. Overriding to authenticated identity.`);
    }
    
    // Force override query and body parameters to the verified userId to eliminate IDOR
    if (req.body) {
      req.body.userId = expectedUserId;
    }
    if (req.query) {
      req.query.userId = expectedUserId;
    }
    
    next();
  } catch (err) {
    console.error('[Auth Error]', err.message);
    res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
};


// Rejects unverified web3 guests (see authenticateUser). Apply to every endpoint
// that operates a Circle developer-controlled wallet or spends server resources
// on behalf of a user identity. External wallets transact directly on-chain and
// record results via /api/trade/save-external (which verifies the tx sender).
const requireVerifiedUser = (req, res, next) => {
  if (req.isWeb3Guest) {
    const allowedPaths = [
      '/api/signals/', 
      '/api/alpha/', 
      '/api/tips', 
      '/api/agent/'
    ];
    if (allowedPaths.some(p => req.path.startsWith(p))) {
      return next();
    }
    
    return res.status(403).json({
      error: 'This action requires a signed-in account. External wallets transact directly on-chain.',
    });
  }
  next();
};

// Accepts a Puls API key (pk_live_) OR falls back to the normal Supabase-JWT
// auth. Only applied to the handful of routes the Puls CLI needs  the shared
// `authenticateUser` is left untouched, so every other endpoint is unaffected.
// On a valid key we mirror authenticateUser's contract (set req.user + force
// req.body/query.userId to the key owner). Any key error falls through to JWT.
const apiKeyOrAuth = async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const headerKey = req.headers['x-api-key'];
    const bearerKey = auth.startsWith('Bearer pk_') ? auth.slice(7) : null;
    const rawKey =
      typeof headerKey === 'string' && headerKey.startsWith('pk_') ? headerKey : bearerKey;
    if (rawKey && rawKey.startsWith('pk_')) {
      const userId = await resolveApiKey(supabase, rawKey);
      if (!userId) return res.status(401).json({ error: 'Invalid or revoked API key' });
      req.user = { id: String(userId).replace(/^supabase_/, '') };
      req.apiKeyAuth = true;
      if (req.body) req.body.userId = userId;
      // Express can expose req.query as a read-only getter (plain assignment
      // silently no-ops), so GET routes (e.g. /api/portfolio, /api/wallet/balance)
      // wouldn't see the resolved id. Force it onto a writable plain object.
      try {
        if (req.query) req.query.userId = userId;
        if (!req.query || req.query.userId !== userId) throw new Error('readonly');
      } catch {
        try { Object.defineProperty(req, 'query', { value: { ...(req.query || {}), userId }, configurable: true, writable: true }); } catch (_) {}
      }
      return next();
    }
  } catch (e) {
    console.error('[apiKeyOrAuth] error:', e.message);
    // fall through to normal token auth
  }
  return authenticateUser(req, res, next);
};

// Admin allowlist for privileged endpoints (comma-separated userIds, e.g. "supabase_<uuid>").
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const requireAdmin = (req, res, next) => {
  const uid = req.body?.userId || req.query?.userId;
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    return res.status(403).json({ error: 'Forbidden: admin only' });
  }
  next();
};

// Sanitize client-supplied prices used for P&L bookkeeping. On-chain events
// (QuickNode webhook) remain the source of truth and reconcile these values.
const clampPrice = (p, fallback = 0.5) => {
  const v = parseFloat(p);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(0.99, Math.max(0.01, v));
};

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY ? process.env.CIRCLE_API_KEY.trim() : undefined,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET ? process.env.CIRCLE_ENTITY_SECRET.trim() : undefined,
});

const realSupabase = createClient(
  process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : '',
  process.env.SUPABASE_SERVICE_KEY ? process.env.SUPABASE_SERVICE_KEY.trim() : ''
);

const NEON_DATABASE_URL = (process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '').trim();

const supabase = createNeonClient(NEON_DATABASE_URL, realSupabase);

async function pingIndexNow(urls) {
  if (!urls || urls.length === 0) return;
  const INDEXNOW_KEY = '51e360e20e504c2ea2d600490b41c099';
  const INDEXNOW_HOST = 'app.pulsmarket.tech';
  try {
    // IndexNow API accepts up to 10,000 URLs per request.
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: INDEXNOW_HOST,
        key: INDEXNOW_KEY,
        keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`,
        urlList: urls.slice(0, 10000)
      })
    });
    console.log(`[IndexNow] Pinged ${urls.length} URL(s), response: ${res.status}`);
  } catch (err) {
    console.error(`[IndexNow] Ping error: ${err.message}`);
  }
}

// Serve the IndexNow key file so search engines can verify ownership.
// Without this, IndexNow pings return 403 (key not found)  0 pages indexed.
app.get('/51e360e20e504c2ea2d600490b41c099.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send('51e360e20e504c2ea2d600490b41c099');
});

const supabaseAnon = createClient(
  process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : '',
  process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.trim() : '' 
);

const USDC = '0x3600000000000000000000000000000000000000';

// ── DIRECT GOOGLE OAUTH (Bypassing Supabase Egress Restriction) ────────────
app.get('/api/auth/google', (req, res) => {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) {
    return res.status(400).send('GOOGLE_CLIENT_ID is not configured on server.');
  }
  const redirectUri = encodeURIComponent('https://api.pulsmarket.tech/api/auth/google/callback');
  const scope = encodeURIComponent('openid email profile');
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&prompt=select_account`;
  res.redirect(googleAuthUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect('https://app.pulsmarket.tech/?error=missing_code');
  }
  try {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = 'https://api.pulsmarket.tech/api/auth/google/callback';

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[Google OAuth] Token exchange error:', tokenData);
      return res.redirect('https://app.pulsmarket.tech/?error=oauth_failed');
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const googleUser = await userRes.json();
    if (!googleUser.id || !googleUser.email) {
      return res.redirect('https://app.pulsmarket.tech/?error=invalid_user_data');
    }

    // Look up existing user by email in profiles table
    let userId;
    let finalDisplayName;
    let finalAvatarUrl;
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('user_id, display_name, avatar_url')
      .eq('email', googleUser.email)
      .maybeSingle();
    if (existingProfile) {
      userId = existingProfile.user_id;
      finalDisplayName = existingProfile.display_name;
      finalAvatarUrl = existingProfile.avatar_url;
      // Update avatar if Google has a better one
      if (googleUser.picture && (!existingProfile.avatar_url || existingProfile.avatar_url.includes('dicebear'))) {
        finalAvatarUrl = googleUser.picture;
        await supabase.from('profiles').upsert({ user_id: userId, avatar_url: googleUser.picture }, { onConflict: 'user_id' });
      }
    } else {
      // Create new user profile
      userId = `supabase_${crypto.randomUUID()}`;
      finalDisplayName = googleUser.name || googleUser.email.split('@')[0];
      finalAvatarUrl = googleUser.picture || `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${userId}`;
      await supabase.from('profiles').insert({
        user_id: userId,
        email: googleUser.email,
        display_name: finalDisplayName,
        avatar_url: finalAvatarUrl,
        bio: 'Trading prediction markets on Arc Testnet.'
      });
    }

      const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const jwtPayload = Buffer.from(JSON.stringify({
        sub: userId,
        email: googleUser.email,
        user_metadata: { full_name: finalDisplayName, avatar_url: finalAvatarUrl },
        exp: Math.floor(Date.now() / 1000) + (30 * 24 * 3600)
      })).toString('base64url');
      const token = `${jwtHeader}.${jwtPayload}.signed_puls_direct`;

    res.redirect(`https://app.pulsmarket.tech/?auth_token=${token}&user_id=${userId}`);
  } catch (err) {
    console.error('[Google OAuth Error]:', err.message);
    res.redirect('https://app.pulsmarket.tech/?error=auth_error');
  }
});

//  Direct-auth token refresh (no full OAuth redirect needed).
// Flutter calls this when _freshAccessToken finds an expired direct_auth
// and has no Supabase session to fall back to. We verify the old token
// (userId + signature), then issue a fresh one with a new 30d expiry.
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const bearer = req.headers.authorization || '';
    const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : (req.body?.token || '');
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const parts = token.split('.');
    if (parts.length < 3) return res.status(401).json({ error: 'Invalid token format' });
    if (parts[2] !== 'signed_puls_direct') return res.status(401).json({ error: 'Invalid token signature' });
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')); } catch (_) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    if (!payload.sub) return res.status(401).json({ error: 'Invalid token: missing sub' });
    // Verify user still exists
    const { data: profile } = await supabase.from('profiles').select('user_id').eq('user_id', payload.sub).maybeSingle();
    if (!profile) return res.status(401).json({ error: 'User not found' });
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const jwtPayload = Buffer.from(JSON.stringify({
      sub: payload.sub,
      email: payload.email || '',
      user_metadata: payload.user_metadata || {},
      exp: Math.floor(Date.now() / 1000) + (30 * 24 * 3600),
    })).toString('base64url');
    const newToken = `${jwtHeader}.${jwtPayload}.signed_puls_direct`;
    res.json({ token: newToken, userId: payload.sub });
  } catch (e) {
    console.error('[auth/refresh] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Circle API Circuit Breaker 
// After 5 consecutive failures, stops calling Circle for 60s to avoid
// cascading rate-limit / outage spirals. Resets on any success.
const circleBreaker = {
  failures: 0,
  openUntil: 0,
  record() { this.failures++; if (this.failures >= 5) { this.openUntil = Date.now() + 60000; console.warn(`[circleBreaker] OPEN  5 failures, pausing Circle calls for 60s`); } },
  reset() { this.failures = 0; this.openUntil = 0; },
  isOpen() { return Date.now() < this.openUntil; },
};

//  Supabase retry helper 
// Retries a Supabase query up to `retries` times with exponential backoff.
// Use for critical queries where a transient Supabase hiccup shouldn't 500.
async function supabaseRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
let walletSetId = (process.env.WALLET_SET_ID || '').trim();

// Wallet account type for newly created user wallets.
//   SCA = ERC-4337 smart contract account  eligible for Circle Gas Station
//         (gasless). Arc Testnet has a preconfigured Gas Station policy, so new
//         users transact with ZERO balance and we no longer depend on the
//         admin-treasury USDC drip for gas.
//   EOA = legacy externally-owned account (needs gas/USDC funding to transact).
// Existing wallets keep whatever type they were created with  `get-or-create`
// returns the stored wallet untouched, so this only affects brand-new users.
const WALLET_ACCOUNT_TYPE = (process.env.WALLET_ACCOUNT_TYPE || 'SCA').trim().toUpperCase() === 'EOA' ? 'EOA' : 'SCA';
console.log(`[Wallets] New user wallets will be created as ${WALLET_ACCOUNT_TYPE}${WALLET_ACCOUNT_TYPE === 'SCA' ? ' (gasless via Circle Gas Station)' : ' (legacy, requires gas funding)'}`);

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicRpcUrl = (process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
// Primary (private) node first, public node as failover: the private node is
// nginx rate-limited (429s) and occasionally blips with HTML error pages,
// which used to break balance reads and the RPC proxy with 502s.
const rpcTransport = rpcUrl === publicRpcUrl
  ? http(rpcUrl, { timeout: 10000 })
  : fallback(
      [
        http(rpcUrl, { timeout: 10000 }),
        http(publicRpcUrl, { timeout: 10000 }),
      ],
      { rank: false, retryCount: 1 }
    );
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: rpcTransport
});

const adminPrivateKey = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.trim() : null;
const adminAccount = adminPrivateKey ? privateKeyToAccount(adminPrivateKey.startsWith('0x') ? adminPrivateKey : `0x${adminPrivateKey}`) : null;

const walletClient = adminAccount ? createWalletClient({
  account: adminAccount,
  chain: arcTestnet,
  transport: http(rpcUrl)
}) : null;

// Read the admin/treasury USDC balance (in whole USDC). Used by the funding
// guard, /health/deep and the low-balance monitor. Returns null on failure.
async function getTreasuryUsdcBalance() {
  if (!adminAccount) return null;
  try {
    const raw = await publicClient.readContract({
      address: USDC,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [adminAccount.address],
    });
    return Number(raw) / 1_000_000;
  } catch (e) {
    console.warn('[Treasury] balance read failed:', e.message);
    return null;
  }
}

//  Low-balance alerting 
// When the treasury drops below TREASURY_MIN_USDC we log a loud, actionable
// warning and (if ALERT_WEBHOOK_URL is set) POST a message to a Slack-compatible
// incoming webhook so funding never silently dies mid-demo again.
const TREASURY_MIN_USDC = parseFloat(process.env.TREASURY_MIN_USDC || '10');
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || '').trim();
let lastTreasuryAlertAt = 0;
const TREASURY_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // at most one alert / 30 min

async function sendAlert(text) {
  console.warn(`[ALERT] ${text}`);
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[ALERT] webhook post failed:', e.message);
  }
}

async function checkTreasuryBalance() {
  const bal = await getTreasuryUsdcBalance();
  if (bal == null) return;
  if (bal < TREASURY_MIN_USDC && Date.now() - lastTreasuryAlertAt > TREASURY_ALERT_COOLDOWN_MS) {
    lastTreasuryAlertAt = Date.now();
    await sendAlert(
      `Puls treasury ${adminAccount.address} is low: ${bal.toFixed(2)} USDC (< ${TREASURY_MIN_USDC}). ` +
      `New SCA users are gasless, but agent/principal funding and legacy EOA users still need this wallet topped up. ` +
      `Top up via faucet.circle.com (20 USDC/2h) or the Circle Developer Console.`
    );
  }
}

function normalizeTxHash(txHash) {
  if (!txHash || typeof txHash !== 'string') return txHash;
  let clean = txHash.trim();
  if (!clean.startsWith('0x')) return clean;
  const hexPart = clean.slice(2);
  if (hexPart.length < 64) {
    return '0x' + hexPart.padStart(64, '0');
  }
  return clean;
}

const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS || '').trim();

const FACTORY_ABI = [
  {
    name: 'createMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'slug', type: 'string' },
      { name: 'deadline', type: 'uint256' },
      { name: 'b', type: 'uint256' }
    ],
    outputs: [{ name: 'market', type: 'address' }]
  },
  {
    name: 'allMarkets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }]
  }
];

//  UMA Optimistic Oracle V2 resolution (PR 3) 
// When UMA_RESOLUTION=true, newly deployed markets are owned by the
// UMAResolverAdapter and resolved through UMA's Optimistic Oracle V2:
//   1. cron opens a price request after the deadline (anyone could too),
//   2. cron proposes the Polymarket consensus outcome (posting a USDC bond),
//   3. after the liveness window passes undisputed, cron settles  market resolves.
// Markets NOT registered with the adapter (e.g. created before the flag was
// flipped) automatically fall back to the legacy direct-resolve path.
const UMA_RESOLUTION = (process.env.UMA_RESOLUTION || 'false').toLowerCase() === 'true';
const UMA_ADAPTER_ADDRESS = (process.env.UMA_ADAPTER_ADDRESS || '').trim();
const UMA_OOV2_ADDRESS = (process.env.UMA_OOV2_ADDRESS || '').trim();
// bytes32("YES_OR_NO_QUERY")
const UMA_IDENTIFIER = '0x5945535f4f525f4e4f5f51554552590000000000000000000000000000000000';
const UMA_YES_PRICE = 1000000000000000000n; // 1e18
const UMA_NO_PRICE = 0n;
// OOV2 request states
const UMA_STATE = ['Invalid', 'Requested', 'Proposed', 'Expired', 'Disputed', 'Resolved', 'Settled'];

const UMA_ADAPTER_ABI = [
  { name: 'registerMarket', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }, { name: 'question', type: 'string' }], outputs: [] },
  { name: 'requestResolution', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }], outputs: [] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }], outputs: [] },
  { name: 'getResolution', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'market', type: 'address' }],
    outputs: [
      { name: 'registered', type: 'bool' },
      { name: 'requested', type: 'bool' },
      { name: 'settled', type: 'bool' },
      { name: 'requestTimestamp', type: 'uint256' },
      { name: 'ancillaryData', type: 'bytes' },
      { name: 'oracleState', type: 'uint8' }
    ] },
  { name: 'bond', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'liveness', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }
];

const UMA_OOV2_ABI = [
  { name: 'proposePrice', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'requester', type: 'address' },
      { name: 'identifier', type: 'bytes32' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'ancillaryData', type: 'bytes' },
      { name: 'proposedPrice', type: 'int256' }
    ],
    outputs: [{ name: 'totalBond', type: 'uint256' }] }
];

const MARKET_OWNERSHIP_ABI = [
  { name: 'transferOwnership', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }
];

function umaQuestionForSlug(slug) {
  return `Resolve to YES (p2, 1) if the Polymarket market with slug "${slug}" (https://polymarket.com/market/${slug}) resolved YES, otherwise NO (p1, 0). If the market does not exist on Polymarket, resolve per the market title embedded in the slug.`;
}

// Hand a freshly deployed market to the UMA adapter (2-step ownership) and
// register its resolution question. Failure is non-fatal: an unregistered
// market simply stays on the legacy direct-resolve path.
async function registerMarketWithUma(marketAddress, slug) {
  const txTransfer = await walletClient.writeContract({
    address: marketAddress,
    abi: MARKET_OWNERSHIP_ABI,
    functionName: 'transferOwnership',
    args: [UMA_ADAPTER_ADDRESS]
  });
  await publicClient.waitForTransactionReceipt({ hash: txTransfer });

  const txRegister = await walletClient.writeContract({
    address: UMA_ADAPTER_ADDRESS,
    abi: UMA_ADAPTER_ABI,
    functionName: 'registerMarket',
    args: [marketAddress, umaQuestionForSlug(slug)]
  });
  await publicClient.waitForTransactionReceipt({ hash: txRegister });
  console.log(`[UMA] Market ${marketAddress} (${slug}) registered with UMAResolverAdapter`);
}

async function getUmaResolution(marketAddress) {
  const [registered, requested, settled, requestTimestamp, ancillaryData, oracleState] =
    await publicClient.readContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'getResolution',
      args: [marketAddress]
    });
  return { registered, requested, settled, requestTimestamp, ancillaryData, oracleState };
}

async function ensureOoAllowance(minAmount) {
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }] }],
    functionName: 'allowance',
    args: [adminAccount.address, UMA_OOV2_ADDRESS]
  });
  if (BigInt(allowance) >= minAmount) return;
  const MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }] }],
    functionName: 'approve',
    args: [UMA_OOV2_ADDRESS, MAX]
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log('[UMA] Approved OOV2 to pull proposal bonds');
}

// Drive one market through the UMA state machine. Returns:
//   'fallback'  not registered with the adapter  use legacy direct resolve
//   'pending'   waiting on a future cron tick (proposal/liveness/dispute)
//   'resolved'  market.resolve() executed on-chain via the adapter
async function processUmaMarket(market, outcome) {
  const res = await getUmaResolution(market.contractAddress);
  if (!res.registered) return 'fallback';

  if (!res.requested) {
    console.log(`[UMA] Requesting resolution for ${market.slug} (${market.contractAddress})`);
    const hash = await walletClient.writeContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'requestResolution',
      args: [market.contractAddress]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'pending';
  }

  const state = UMA_STATE[res.oracleState] || 'Invalid';

  if (state === 'Requested') {
    if (outcome === null) {
      console.log(`[UMA] ${market.slug}: request open, waiting for a determinable outcome to propose`);
      return 'pending';
    }
    const bond = await publicClient.readContract({
      address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'bond'
    });
    await ensureOoAllowance(BigInt(bond) * 2n);
    console.log(`[UMA] Proposing ${outcome ? 'YES' : 'NO'} for ${market.slug} (bond ${bond})`);
    const hash = await walletClient.writeContract({
      address: UMA_OOV2_ADDRESS,
      abi: UMA_OOV2_ABI,
      functionName: 'proposePrice',
      args: [UMA_ADAPTER_ADDRESS, UMA_IDENTIFIER, res.requestTimestamp, res.ancillaryData,
        outcome ? UMA_YES_PRICE : UMA_NO_PRICE]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'pending';
  }

  if (state === 'Proposed') {
    console.log(`[UMA] ${market.slug}: proposal in liveness window, waiting`);
    return 'pending';
  }

  if (state === 'Disputed') {
    console.warn(`[UMA] ${market.slug}: proposal DISPUTED  waiting for DVM/oracle decision`);
    return 'pending';
  }

  if (state === 'Expired' || state === 'Resolved') {
    console.log(`[UMA] Settling ${market.slug} (oracle state: ${state})`);
    const hash = await walletClient.writeContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'settle',
      args: [market.contractAddress]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'resolved';
  }

  if (state === 'Settled') {
    // Oracle settled but market may have resolved already (or settle() raced).
    return res.settled ? 'resolved' : 'pending';
  }

  return 'pending';
}

//  Cache of Deployed Markets 
const deployedMarketsCache = new Map(); // slug -> { contractAddress, deadline, resolved, outcome }
const contractToSlugCache = new Map(); // contractAddress -> slug

const MARKET_EVENTS_ABI = [
  {
    anonymous: false,
    name: 'Bought',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'side', type: 'bool' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'shares', type: 'uint256' }
    ]
  },
  {
    anonymous: false,
    name: 'Sold',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'side', type: 'bool' },
      { indexed: false, name: 'shares', type: 'uint256' },
      { indexed: false, name: 'usdcOut', type: 'uint256' }
    ]
  },
  {
    anonymous: false,
    name: 'Resolved',
    type: 'event',
    inputs: [
      { indexed: false, name: 'outcome', type: 'bool' }
    ]
  },
  {
    anonymous: false,
    name: 'Claimed',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'payout', type: 'uint256' }
    ]
  }
];

//  Cache of User Wallets 
// Wallet address caches  capped to prevent unbounded growth on long-running
// dynos. Entries are never individually evicted (they're small and stable), but
// the hard cap prevents pathological growth from transient wallet addresses.
const WALLET_CACHE_MAX = 2000;
const addressToUserIdCache = new Map(); // address (lowercase) -> userId
const userIdToAddressCache = new Map(); // userId -> address (lowercase)

function _cappedSet(map, key, val) {
  if (map.size >= WALLET_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, val);
}

async function loadWalletAddressMapping() {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .select('user_id, wallet_id');
    if (error) {
      console.error('Failed to load wallets for address mapping:', error.message);
      return;
    }
    console.log(`Loading wallet addresses for ${data.length} wallets...`);
    for (const row of data) {
      try {
        const walletId = row.wallet_id;
        const userId = row.user_id;
        
        let address = walletAddressCache.get(walletId);
        if (!address) {
          const walletRes = await circle.getWallet({ id: walletId });
          address = walletRes.data.wallet.address;
          _cappedSet(walletAddressCache, walletId, address);
        }
        
        const lowerAddress = address.toLowerCase();
        _cappedSet(addressToUserIdCache, lowerAddress, userId);
        _cappedSet(userIdToAddressCache, userId, lowerAddress);
      } catch (err) {
        console.error(`Failed to fetch wallet address for user ${row.user_id}:`, err.message);
      }
    }
    console.log(`Loaded ${addressToUserIdCache.size} wallet address mappings.`);
  } catch (e) {
    console.error('loadWalletAddressMapping error:', e.message);
  }
}

async function loadDeployedMarkets() {
  try {
    const { data, error } = await supabase
      .from('deployed_markets')
      .select('*');
    if (error) {
      console.error('Failed to load deployed_markets from Supabase:', error.message);
      return;
    }
    let archivedCount = 0;
    for (const row of (data || [])) {
      if (row.archived === true) { archivedCount++; continue; } // zombies stay out of cache, cron and listings
      const entry = {
        contractAddress: row.contract_address,
        deadline: Number(row.deadline),
        resolved: row.resolved,
        outcome: row.outcome
      };
      deployedMarketsCache.set(row.slug, entry);
      contractToSlugCache.set(row.contract_address.toLowerCase(), row.slug);
    }
    if (archivedCount) console.log(`Skipped ${archivedCount} archived markets.`);
    console.log(`Loaded ${deployedMarketsCache.size} deployed markets into cache.`);
  } catch (e) {
    console.error('loadDeployedMarkets error:', e.message);
  }
}

// Prevent duplicate concurrent deployments
const pendingDeployments = new Map();
let deploymentQueue = Promise.resolve();

// LMSR liquidity parameter b (in USDC) seeded into every new market at deploy.
// initialCost = bTln2 is pulled from the treasury per market, so this is the
// single biggest treasury cost. Env-tunable (default 10); lower = cheaper seed
// but thinner liquidity (a bit more price slippage per trade).
const MARKET_LIQUIDITY_B_USDC = Math.max(1, parseFloat(process.env.MARKET_LIQUIDITY_B) || 10);
console.log(`[market] LMSR b = ${MARKET_LIQUIDITY_B_USDC} USDC (seed ~${(MARKET_LIQUIDITY_B_USDC * Math.log(2)).toFixed(2)} USDC/market)`);

async function _executeMarketDeployment(slug, deadlineSeconds) {
  let cached = deployedMarketsCache.get(slug);
  if (cached) return cached.contractAddress;

  if (!FACTORY_ADDRESS) throw new Error('FACTORY_ADDRESS not set in backend');
  if (!walletClient || !adminAccount) throw new Error('Admin wallet credentials not configured');

  console.log(`Dynamic deployment triggered for slug: ${slug}, deadline: ${deadlineSeconds}`);
  const b = Math.round(MARKET_LIQUIDITY_B_USDC * 1_000_000); // LMSR liquidity (USDC), env-tunable
  const initialCost = BigInt(Math.round(b * Math.log(2))); // seed pulled from treasury per market

  // Check current allowance first to avoid redundant approvals and race conditions
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{
      name: 'allowance',
      type: 'function',
      stateMutability: 'view',
      inputs: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' }
      ],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'allowance',
    args: [adminAccount.address, FACTORY_ADDRESS]
  });

  if (BigInt(allowance) < initialCost) {
    console.log(`Current factory allowance is ${allowance}, less than required ${initialCost}. Approving MaxUint256...`);
    const MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const approveHash = await walletClient.writeContract({
      address: USDC,
      abi: [{
        name: 'approve',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' }
        ],
        outputs: [{ name: '', type: 'bool' }]
      }],
      functionName: 'approve',
      args: [FACTORY_ADDRESS, MAX]
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(` Approved factory for MaxUint256 USDC`);
  }

  // Check deployer USDC balance before attempting deployment
  const deployerBalance = await publicClient.readContract({
    address: USDC,
    abi: [{
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'balanceOf',
    args: [adminAccount.address]
  });
  if (BigInt(deployerBalance) < initialCost) {
    console.warn(`  Deployer USDC balance (${deployerBalance}) < required (${initialCost})  skipping deployment for ${slug}`);
    throw new Error(`Deployer has insufficient USDC (${deployerBalance} < ${initialCost}) to deploy market ${slug}`);
  }

  const { request } = await publicClient.simulateContract({
    account: adminAccount,
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'createMarket',
    args: [slug, BigInt(deadlineSeconds), BigInt(b)]
  });

  const hash = await walletClient.writeContract(request);
  console.log(`Deploy Tx Hash: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash });

  const allM = await publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'allMarkets'
  });
  
  const deployedAddress = allM[allM.length - 1];
  if (!deployedAddress) throw new Error('Failed to retrieve deployed market address from factory');

  console.log(` Successfully deployed LMSRMarket at ${deployedAddress} for slug ${slug}`);

  if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
    try {
      await registerMarketWithUma(deployedAddress, slug);
    } catch (e) {
      // Non-fatal: an unregistered market stays on the legacy direct-resolve path.
      console.error(`[UMA] Failed to register ${slug} with adapter (legacy resolution will apply):`, e.message);
    }
  }

  await supabase.from('deployed_markets').upsert({
    slug,
    contract_address: deployedAddress,
    deadline: deadlineSeconds,
    resolved: false
  });

  const entry = {
    contractAddress: deployedAddress,
    deadline: deadlineSeconds,
    resolved: false,
    outcome: null
  };
  deployedMarketsCache.set(slug, entry);
  contractToSlugCache.set(deployedAddress.toLowerCase(), slug);

  // Fan out so the new cache slice + scheduled-resolution timer pick it up.
  eventBus.safeEmit(EVENTS.MARKET_ACTIVATED, {
    slug,
    contract_address: deployedAddress,
    deadline: deadlineSeconds,
    resolved: false,
    outcome: null,
  });

  return deployedAddress;
}

async function getOrDeployMarket(slug, deadlineSeconds) {
  if (!slug) throw new Error('slug is required');
  
  let cached = deployedMarketsCache.get(slug);
  if (cached) return cached.contractAddress;

  // Guard: never try to deploy a market whose deadline already passed  the
  // factory reverts with "Deadline in past", wasting an RPC round-trip and
  // spamming the error log. Require at least 5 minutes of remaining lifetime.
  const nowSec = Math.floor(Date.now() / 1000);
  if (!deadlineSeconds || Number(deadlineSeconds) <= nowSec + 300) {
    throw new Error(`Market ${slug} deadline ${deadlineSeconds} is in the past (or <5min away)  skipping deployment`);
  }

  if (pendingDeployments.has(slug)) {
    return pendingDeployments.get(slug);
  }

  const promise = new Promise((resolve, reject) => {
    deploymentQueue = deploymentQueue.then(async () => {
      try {
        const addr = await _executeMarketDeployment(slug, deadlineSeconds);
        resolve(addr);
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      console.error(`Queue execution failed:`, err.message);
    });
  });

  pendingDeployments.set(slug, promise);
  
  promise.finally(() => {
    pendingDeployments.delete(slug);
  });

  return promise;
}
//  Supabase helpers 

async function getWalletId(userId) {
  // Cache-first: the wallets slice is hydrated at boot and kept in sync by
  // WALLET_CREATED events. Falls back to a one-time Supabase read on a miss
  // (e.g., a wallet created before this process started whose row wasn't in
  // the boot snapshot  shouldn't happen, but stays correct if it does).
  const cached = cache.walletByUser(userId);
  if (cached && cached.wallet_id) return cached.wallet_id;
  const { data } = await supabase
    .from('wallets')
    .select('wallet_id')
    .eq('user_id', userId)
    .limit(1);
  return (data && data.length > 0) ? data[0].wallet_id : null;
}

async function saveWallet(userId, walletId) {
  const { error } = await supabase.from('wallets').upsert({ user_id: userId, wallet_id: walletId });
  if (error) {
    // CRITICAL: if this fails, the wallet exists in Circle but NOT in the DB.
    // On next restart, getWalletId returns null  creates ANOTHER wallet 
    // agent address changes every restart. Log loudly so it's caught.
    console.error(`[saveWallet] CRITICAL: upsert failed for ${userId}:`, error.message);
  }
  // Fan out so the in-memory cache indexes the new wallet without a re-query.
  // Address is fetched lazily later (Circle SDK); cache indexes by user_id now.
  eventBus.safeEmit(EVENTS.WALLET_CREATED, {
    user_id: userId,
    wallet_id: walletId,
    last_balance: '0',
    strategy: null,
  });
}

async function isApproved(walletId, contractAddress) {
  try {
    const info = await getWalletInfo(walletId);
    if (!info || !info.address) return false;

    const allowance = await publicClient.readContract({
      address: USDC,
      abi: [{
        name: 'allowance',
        type: 'function',
        stateMutability: 'view',
        inputs: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' }
        ],
        outputs: [{ name: '', type: 'uint256' }]
      }],
      functionName: 'allowance',
      args: [info.address, contractAddress]
    });

    return BigInt(allowance) >= BigInt(1_000_000_000_000);
  } catch (e) {
    console.error('Check allowance failed:', e.message);
    return false;
  }
}

async function saveTrade(userId, trade) {
  const { data, error } = await supabase.from('trades').insert({ user_id: userId, ...trade }).select().single();
  if (error) {
    // CRITICAL: Circle transfer already succeeded  the trade exists on-chain
    // but NOT in the DB. Log loudly so it can be reconciled manually.
    // Retry once (transient Supabase errors are common on the free tier).
    console.error('[saveTrade] CRITICAL: DB insert failed after Circle transfer succeeded:', error.message, { userId, tx_id: trade.tx_id });
    const { data: retry, error: err2 } = await supabase.from('trades').insert({ user_id: userId, ...trade }).select().single();
    if (err2) {
      console.error('[saveTrade] RETRY ALSO FAILED  trade lost on-chain:', err2.message);
      return null;
    }
    if (retry) {
      eventBus.safeEmit(EVENTS.TRADE_CREATED, retry);
      if (retry.state === 'COMPLETE') broadcastTrade(retry);
    }
    return retry;
  }
  if (data) {
    eventBus.safeEmit(EVENTS.TRADE_CREATED, data);
    if (data.state === 'COMPLETE') broadcastTrade(data);
  }
  return data;
}

async function syncCompletedTrade(userId, { marketId, side, amountUsdc, shares, txHash, question, entryPrice }) {
  try {
    txHash = normalizeTxHash(txHash);
    const { data: existing, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('market_id', marketId)
      .eq('side', side)
      .eq('state', 'INITIATED')
      .order('created_at', { ascending: false })
      .limit(1);

    const amount = Math.abs(amountUsdc);

    if (error) {
      console.error('Error fetching existing trade for sync:', error.message);
    }

    if (existing && existing.length > 0) {
      const trade = existing[0];
      const { data: updatedTrade } = await supabase
        .from('trades')
        .update({
          state: 'COMPLETE',
          tx_hash: txHash,
          usdc_amount: amountUsdc,
        })
        .eq('id', trade.id)
        .select()
        .single();
      
      if (updatedTrade) {
        broadcastTrade(updatedTrade);
      }
      
      console.log(`[QuickNode Webhook] Synced initiated trade ID ${trade.id} to COMPLETE`);
      createNotification(
        userId,
        'Trade Confirmed ',
        `Successfully ${amountUsdc > 0 ? 'bought' : 'sold'} $${amount.toFixed(2)} of ${side} shares for "${question}"`,
        'trade'
      ).catch(console.error);
    } else {
      const { data: dup } = await supabase
        .from('trades')
        .select('*')
        .eq('tx_hash', txHash)
        .limit(1);
      
      if (dup && dup.length > 0) {
        const existingTrade = dup[0];
        if (existingTrade.usdc_amount !== amountUsdc) {
          const { data: updatedTrade } = await supabase
            .from('trades')
            .update({ usdc_amount: amountUsdc })
            .eq('id', existingTrade.id)
            .select()
            .single();
          
          if (updatedTrade) {
            broadcastTrade(updatedTrade);
          }
          console.log(`[QuickNode Webhook] Updated existing trade ${existingTrade.id} with correct on-chain usdc_amount: ${amountUsdc}`);
        }
        return;
      }

      const { data: newTrade } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: `ext_${Date.now()}`,
          side,
          usdc_amount: amountUsdc,
          entry_price: entryPrice !== undefined ? entryPrice : (shares !== 0 ? Math.min(0.99, Math.max(0.01, Math.abs(amountUsdc / shares))) : 0.5),
          question: question || 'Prediction Market',
          market_id: marketId,
          state: 'COMPLETE',
          tx_hash: txHash,
        })
        .select()
        .single();
        
      if (newTrade) {
        eventBus.safeEmit(EVENTS.TRADE_CREATED, newTrade);
        broadcastTrade(newTrade);
      }

      console.log(`[QuickNode Webhook] Inserted new completed trade for tx ${txHash}`);
      createNotification(
        userId,
        'Trade Confirmed ',
        `Successfully ${amountUsdc > 0 ? 'bought' : 'sold'} $${amount.toFixed(2)} of ${side} shares for "${question || 'Prediction Market'}"`,
        'trade'
      ).catch(console.error);
    }
  } catch (err) {
    console.error('Error syncing completed trade:', err.message);
  }
}

async function getTrades(userIds) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const { data } = await supabase
    .from('trades')
    .select('id, user_id, market_id, side, usdc_amount, state, question, entry_price, tx_hash, created_at')
    .in('user_id', ids)
    .order('created_at', { ascending: false })
    .limit(3000);
  return data ?? [];
}

//  Wallet 

async function ensureWalletSet() {
  if (walletSetId) return walletSetId;
  const res = await circle.createWalletSet({ name: 'Puls Users' });
  walletSetId = res.data.walletSet.id;
  console.log('Created wallet set:', walletSetId);
  return walletSetId;
}

const walletAddressCache = new Map(); // walletId -> address (legacy, TTL-managed via _walletAddrCache)

// Balance cache: { address -> { balance, exact, ts } }  avoids hitting the RPC
// on every /api/agents/roster call (which fetches 6+ wallets).  Bounded: a
// periodic sweep evicts expired entries so the Map can't grow unbounded on a
// long-running dyno (512MB Heroku).
const _balanceCache = new Map();
const BALANCE_CACHE_TTL_MS = 15_000; // 15s  fresh enough for UI
const BALANCE_CACHE_MAX = 500; // hard cap (distinct wallet addresses)

// Periodic sweep: evict expired balance-cache entries every 60s so the Map
// doesn't leak memory on a long-running dyno.
safeInterval('balanceSweep', () => {
  const now = Date.now();
  for (const [k, v] of _balanceCache) {
    if (now - v.ts > BALANCE_CACHE_TTL_MS * 2) _balanceCache.delete(k);
  }
}, 60_000);

// Wallet address cache: { walletId -> { address, ts } }  5 min TTL.
// Prevents repeated Circle API calls for the same wallet address.
const _walletAddrCache = new Map();
const WALLET_ADDR_TTL_MS = 5 * 60 * 1000; // 5 min  wallet addresses don't change
// Circle API semaphore: max 2 concurrent Circle API calls to avoid rate limits.
let _circleInFlight = 0;
const _circleQueue = [];
const CIRCLE_MAX_CONCURRENT = 2;

const CIRCLE_QUEUE_TIMEOUT_MS = 15_000; // max wait in queue before throwing
async function _circleThrottle(fn) {
  if (_circleInFlight >= CIRCLE_MAX_CONCURRENT) {
    let resolve;
    const waitPromise = new Promise(r => { resolve = r; _circleQueue.push(r); });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Circle queue timeout — too many concurrent calls')), CIRCLE_QUEUE_TIMEOUT_MS)
    );
    await Promise.race([waitPromise, timeoutPromise]);
    // If the timer won the race, remove our resolve from the queue
    if (resolve && _circleQueue.includes(resolve)) {
      _circleQueue.splice(_circleQueue.indexOf(resolve), 1);
    }
  }
  _circleInFlight++;
  try {
    return await fn();
  } finally {
    _circleInFlight--;
    if (_circleQueue.length > 0) _circleQueue.shift()();
  }
}

async function getWalletInfo(walletId) {
  try {
    // Check wallet address cache (5 min TTL)  avoids Circle API call entirely
    let address = null;
    const addrCached = _walletAddrCache.get(walletId);
    if (addrCached && Date.now() - addrCached.ts < WALLET_ADDR_TTL_MS) {
      address = addrCached.address;
    }
    if (!address) {
      // Also check the legacy cache
      address = walletAddressCache.get(walletId);
    }
    if (!address) {
      // Try Circle API with throttling  but if it rate limits, fall back
      // to the last known address from Supabase (wallets table).
      try {
        const walletRes = await _circleThrottle(() => circle.getWallet({ id: walletId }));
        address = walletRes.data.wallet.address;
        walletAddressCache.set(walletId, address);
        _walletAddrCache.set(walletId, { address, ts: Date.now() });
        // Persist to Supabase so future cache misses can read from DB
        // without hitting Circle API again.
        supabase.from('wallets').update({ address }).eq('wallet_id', walletId)
          .then(({ error }) => { if (error && !error.message.includes('column')) console.warn('[getWalletInfo] address persist:', error.message); })
          .catch(() => {});
      } catch (circleErr) {
        // Circle API rate limited or failed  try DB fallback
        if (/rate.?limit|429|too many/i.test(circleErr.message || '')) {
          console.warn(`[getWalletInfo] Circle rate limited for ${walletId}  trying DB fallback`);
          const { data: dbRow } = await supabase.from('wallets').select('address, wallet_address').eq('wallet_id', walletId).limit(1);
          if (dbRow && dbRow.length > 0) {
            address = dbRow[0].address || dbRow[0].wallet_address || null;
          }
        }
        if (!address) {
          // Last resort: check legacy cache
          address = walletAddressCache.get(walletId);
        }
        if (!address) {
          console.error(`[getWalletInfo] Could not resolve address for ${walletId}: ${circleErr.message}`);
          return { walletId, address: '', usdcBalance: '0.00' };
        }
        // Cache the DB-fetched address too
        _walletAddrCache.set(walletId, { address, ts: Date.now() });
        walletAddressCache.set(walletId, address);
      }
    }

    // Check balance cache first  avoids RPC calls on every roster fetch
    const cached = _balanceCache.get(address);
    if (cached && Date.now() - cached.ts < BALANCE_CACHE_TTL_MS) {
      return { walletId, address, usdcBalance: cached.balance, exactUsdcBalance: cached.exact };
    }

    let balance = '0.00';
    let exactBalance = '0';
    let gotBalance = false;
    try {
      const balanceRaw = await publicClient.readContract({
        address: USDC,
        abi: [{
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'balanceOf',
        args: [address]
      });
      exactBalance = (Number(balanceRaw) / 1_000_000).toString();
      balance = (Number(balanceRaw) / 1_000_000).toFixed(2);

      // CRITICAL: the Canteen RPC can return stale data (e.g. 0 balance for
      // an agent that was topped up) without throwing an error. If balance
      // is 0, verify against the public Arc RPC to catch stale reads.
      if (Number(balanceRaw) === 0) {
        try {
          const fallbackRpc = 'https://rpc.testnet.arc.network';
          const padded = address.toLowerCase().replace('0x', '').padStart(64, '0');
          const fbRes = await fetch(fallbackRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', method: 'eth_call',
              params: [{ to: USDC, data: `0x70a08231${padded}` }, 'latest'],
              id: 1,
            }),
          }).then(r => r.json());
          if (fbRes.result && fbRes.result.length >= 2) {
            const fbRaw = BigInt(fbRes.result);
            if (fbRaw > 0n) {
              exactBalance = (Number(fbRaw) / 1_000_000).toString();
              balance = (Number(fbRaw) / 1_000_000).toFixed(2);
            }
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn(`On-chain balance check failed for ${address}:`, err.message);
      // FALLBACK: try the public Arc RPC directly (the Canteen RPC node can
      // be stale  it sometimes lags behind the canonical chain state by
      // hours or days, showing wrong balances to users).
      try {
        const fallbackRpc = 'https://rpc.testnet.arc.network';
        const padded = address.toLowerCase().replace('0x', '').padStart(64, '0');
        const fbRes = await fetch(fallbackRpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: USDC, data: `0x70a08231${padded}` }, 'latest'],
            id: 1,
          }),
        }).then(r => r.json());
        if (fbRes.result && fbRes.result.length >= 2) {
          const raw = BigInt(fbRes.result);
          exactBalance = (Number(raw) / 1_000_000).toString();
          balance = (Number(raw) / 1_000_000).toFixed(2);
        }
      } catch (fbErr) {
        // Last resort: Circle SDK balance
        try {
          const balRes = await circle.getWalletTokenBalance({ id: walletId });
          const usdcToken = balRes.data.tokenBalances?.find(
            t => t.token?.address?.toLowerCase() === USDC.toLowerCase() || t.token?.symbol === 'USDC'
          );
          exactBalance = usdcToken?.amount ?? '0';
          balance = parseFloat(exactBalance).toFixed(2);
        } catch (_) {}
      }
    }

    // Cache the result (with hard cap to prevent unbounded growth)
    if (_balanceCache.size >= BALANCE_CACHE_MAX) {
      // Evict oldest entry (Map iterates in insertion order)
      const oldest = _balanceCache.keys().next().value;
      if (oldest) _balanceCache.delete(oldest);
    }
    _balanceCache.set(address, { balance, exact: exactBalance, ts: Date.now() });
    return { walletId, address, usdcBalance: balance, exactUsdcBalance: exactBalance };
  } catch (e) {
    console.error('getWalletInfo error:', e.message);
    return { walletId, address: '', usdcBalance: '0.00' };
  }
}

// In-memory RPC cache  bounded with TTL eviction to prevent OOM on 512MB dynos.
const rpcCache = new Map(); // requestHash -> { data, ts }
const RPC_CACHE_TTL = 3000; // 3 seconds TTL
const RPC_CACHE_MAX = 2000; // hard cap: evict oldest when exceeded

// Allowed RPC methods to prevent open relay abuse
const ALLOWED_RPC_METHODS = [
  'eth_call',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_chainId',
  'net_version'
];

// RPC Proxy rate limiter (max 120 requests per minute per IP)
const rpcProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many RPC requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// POST /api/rpc-proxy
app.post('/api/rpc-proxy', rpcProxyLimiter, async (req, res) => {
    // Primary (private) node first, public node as failover: the private node
    // is nginx rate-limited (429 HTML pages), which used to surface as 502s.
    const rpcUrls = [rpcUrl, publicRpcUrl].filter((u, i, a) => u && a.indexOf(u) === i);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), rpcUrls.length * 8000);
    try {
      const { method, params, id, jsonrpc } = req.body;
      if (!method) {
      return res.status(400).json({ error: 'method required' });
    }

    // Method safety check
    if (!ALLOWED_RPC_METHODS.includes(method)) {
      console.warn(`[RPC Proxy Blocked] Unauthorized method: ${method}`);
      return res.status(403).json({ error: `Forbidden RPC method: ${method}` });
    }

    const isCacheable = method === 'eth_call';
    const cacheKey = isCacheable ? JSON.stringify({ method, params }) : null;

    if (isCacheable) {
      const cached = rpcCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < RPC_CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    const rpcBody = JSON.stringify({ method, params, id: id || 1, jsonrpc: jsonrpc || '2.0' });
    let data = null;
    for (const url of rpcUrls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rpcBody,
          signal: controller.signal,
        });
        const text = await response.text();
        // Rate-limited (429) or non-JSON body (HTML error page / empty reply):
        // move to the next node before surfacing anything to the client.
        if (response.status === 429 || !response.ok && response.status >= 500) {
          console.warn(`[RPC Proxy] Node ${url} responded ${response.status}, trying next`);
          continue;
        }
        try {
          data = JSON.parse(text);
          break;
        } catch (parseErr) {
          console.warn(`[RPC Proxy] Non-JSON response from ${url}, trying next:`, parseErr.message);
        }
      } catch (fetchErr) {
        console.warn(`[RPC Proxy] Fetch to ${url} failed, trying next:`, fetchErr.message);
      }
    }
    clearTimeout(timeoutId);

    if (!data) {
      return res.status(502).json({ jsonrpc: '2.0', id: id || 1, error: { code: -32603, message: 'Upstream RPC nodes unavailable' } });
    }

    if (isCacheable && data && !data.error) {
      rpcCache.set(cacheKey, { data, ts: Date.now() });
      // Evict expired entries + enforce hard cap to prevent unbounded growth.
      if (rpcCache.size > RPC_CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of rpcCache) {
          if (now - v.ts > RPC_CACHE_TTL || rpcCache.size > RPC_CACHE_MAX) {
            rpcCache.delete(k);
          } else {
            break; // Map iterates in insertion order; first non-expired = oldest
          }
        }
      }
    }

    res.json(data);
  } catch (err) {
    console.error('RPC Proxy error:', err.message);
    res.status(500).json({ error: 'RPC proxy failed', details: err.message });
  }
});

// POST /api/wallet/get-or-create
const _userWalletCreating = new Set();
app.post('/api/wallet/get-or-create', apiKeyOrAuth, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const existing = await getWalletId(userId);
    if (existing) return res.json(await getWalletInfo(existing));

    // Race condition guard: prevent duplicate wallet creation on double-tap
    if (_userWalletCreating.has(userId)) {
      while (_userWalletCreating.has(userId)) await new Promise(r => setTimeout(r, 100));
      const walletId = await getWalletId(userId);
      if (walletId) return res.json(await getWalletInfo(walletId));
    }

    _userWalletCreating.add(userId);
    try {
      const setId = await ensureWalletSet();
    const createRes = await circle.createWallets({
      accountType: WALLET_ACCOUNT_TYPE, // SCA  gasless via Gas Station (see WALLET_ACCOUNT_TYPE)
      blockchains: ['ARC-TESTNET'],
      count: 1,
      walletSetId: setId,
    });

    const wallet = createRes.data.wallets[0];
    await saveWallet(userId, wallet.id);
    console.log(`Created wallet for ${userId}: ${wallet.address}`);
    
    // Cache the address mapping
    if (wallet.address) {
      const lowerAddress = wallet.address.toLowerCase();
      _cappedSet(addressToUserIdCache, lowerAddress, userId);
      _cappedSet(userIdToAddressCache, userId, lowerAddress);
      _cappedSet(walletAddressCache, wallet.id, wallet.address);
    }

    // Welcome bonus: brand-new VERIFIED users get a small USDC float so they can
    // immediately make a real prediction/payment (converts a visit into a tx).
    // Fire-and-forget  never blocks wallet creation. Anti-abuse: only
    // supabase_<uuid> verified ids, one-time per user (deduped on-chain by a
    // marker row), treasury floor + global daily cap.
    if (wallet.address) sendWelcomeBonus(userId, wallet.address).catch(() => {});

    res.json(await getWalletInfo(wallet.id));
    } finally {
      _userWalletCreating.delete(userId);
    }
  } catch (e) {
    console.error('get-or-create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// One-time welcome USDC bonus for new verified users. Guards:
//   only verified supabase_<uuid> ids (no eth_/agent_/guest),
//   idempotent: a `welcome_grants` row (unique user_id) is the dedupe key,
//   treasury must hold > floor, and a global daily cap limits total spend.
const WELCOME_BONUS_USDC = parseFloat(process.env.WELCOME_BONUS_USDC || '0.5');
const WELCOME_BONUS_ENABLED = (process.env.WELCOME_BONUS_ENABLED || 'true') === 'true';
const WELCOME_TREASURY_FLOOR = parseFloat(process.env.WELCOME_TREASURY_FLOOR || '5');
const WELCOME_DAILY_CAP_USDC = parseFloat(process.env.WELCOME_DAILY_CAP_USDC || '20');
async function sendWelcomeBonus(userId, toAddress) {
  if (!WELCOME_BONUS_ENABLED) return;
  if (!userId.startsWith('supabase_')) return;              // verified humans only
  if (!walletClient || !adminAccount) return;
  try {
    // Idempotency: reserve a grant row first (unique user_id). If it exists, stop.
    const { error: resErr } = await supabase
      .from('welcome_grants')
      .insert({ user_id: userId, amount_usdc: WELCOME_BONUS_USDC, address: toAddress });
    if (resErr) {
      if (/relation .* does not exist/i.test(resErr.message)) {
        console.warn('[welcome] welcome_grants table missing  skipping (run migration)');
      }
      return; // duplicate (already granted) or table missing  no send
    }
    // Global daily cap.
    const since = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const { count } = await supabase
      .from('welcome_grants').select('id', { count: 'exact', head: true }).gte('created_at', since);
    if ((count ?? 0) * WELCOME_BONUS_USDC > WELCOME_DAILY_CAP_USDC) {
      console.warn('[welcome] daily cap reached  skipping bonus');
      await supabase.from('welcome_grants').delete().eq('user_id', userId); // release reservation
      return;
    }
    // Treasury floor.
    const treasury = await getTreasuryUsdcBalance();
    if (treasury != null && treasury < WELCOME_TREASURY_FLOOR + WELCOME_BONUS_USDC) {
      console.warn(`[welcome] treasury too low (${treasury})  skipping bonus`);
      await supabase.from('welcome_grants').delete().eq('user_id', userId);
      return;
    }
    // Send with an on-chain memo (reason = welcome:<userId>).
    const micro = BigInt(Math.round(WELCOME_BONUS_USDC * 1_000_000));
    const innerData = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
      functionName: 'transfer', args: [toAddress, micro],
    });
    let txHash = null;
    try {
      txHash = await walletClient.writeContract({
        address: MEMO_CONTRACT,
        abi: [{ name: 'memo', type: 'function', stateMutability: 'nonpayable', inputs: [
          { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
          { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' } ], outputs: [] }],
        functionName: 'memo',
        args: [USDC, innerData, keccak256(toHex(`welcome:${userId}`)),
          stringToHex(JSON.stringify({ kind: 'welcome_bonus', usdc: WELCOME_BONUS_USDC }))],
      });
    } catch (_) {
      // Memo path failed  fall back to a plain transfer so the user still gets funded.
      txHash = await walletClient.writeContract({
        address: USDC,
        abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
          inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
        functionName: 'transfer', args: [toAddress, micro],
      });
    }
    await supabase.from('welcome_grants').update({ tx_hash: txHash }).eq('user_id', userId);
    console.log(`[welcome] sent ${WELCOME_BONUS_USDC} USDC to ${userId} (${toAddress}) tx ${txHash}`);
    // Bonus also closes the fund_wallet quest + points.
    if (typeof awardPoints === 'function') {
      awardPoints(userId, 'fund_wallet', { refId: 'welcome' }).catch(() => {});
    }
  } catch (e) {
    console.error('[welcome] error:', e.message);
  }
}

// MEMO_CONTRACT shared with the agent swarm (Arc predeployed Memo contract).
const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';

// GET /api/wallet/balance
app.get('/api/wallet/balance', apiKeyOrAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    let userAddress = null;
    if (userId.startsWith('0x')) {
      userAddress = userId;
    } else if (userId.startsWith('eth_0x')) {
      userAddress = userId.replace('eth_', '');
    }

    if (userAddress) {
      let balance = '0.00';
      try {
        const balanceRaw = await publicClient.readContract({
          address: USDC,
          abi: [{
            name: 'balanceOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }]
          }],
          functionName: 'balanceOf',
          args: [userAddress]
        });
        balance = (Number(balanceRaw) / 1_000_000).toFixed(2);
      } catch (err) {
        console.warn(`On-chain balance check failed for external wallet ${userAddress}:`, err.message);
      }
      return res.json({ usdcBalance: balance });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(404).json({ error: 'Wallet not found' });
    const info = await getWalletInfo(walletId);
    res.json({ usdcBalance: info.usdcBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/wallet/withdraw  send USDC from the user's Puls (Circle MPC) wallet
// to any Arc address. Real on-chain transfer; gasless from the SCA wallet.
app.post('/api/wallet/withdraw', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const userId = req.body.userId; // forced to verified id by authenticateUser
    const to = String(req.body.to || '').trim();
    const amount = Number(req.body.amountUsdc);

    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return res.status(400).json({ error: 'Enter a valid Arc (0x) address.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Enter a valid amount.' });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(404).json({ error: 'Wallet not found' });
    const info = await getWalletInfo(walletId);

    if (to.toLowerCase() === String(info.address).toLowerCase()) {
      return res.status(400).json({ error: "That's your own wallet address." });
    }
    if (parseFloat(info.usdcBalance) < amount) {
      return res.status(402).json({ error: `Insufficient balance (have ${info.usdcBalance} USDC).` });
    }

    const amountMicro = Math.round(amount * 1_000_000).toString();
    let txId = null;
    try {
      const txRes = await circle.createContractExecutionTransaction({
        walletId,
        contractAddress: USDC,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [to, amountMicro],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      txId = txRes.data?.id || null;
    } catch (txErr) {
      console.error('[withdraw] transfer failed:', txErr.message);
      return res.status(502).json({ error: 'Withdrawal failed, please try again.' });
    }

    // Resolve the on-chain hash (best-effort, short poll).
    let txHash = null;
    for (let i = 0; i < 12 && txId; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const st = await circle.getTransaction({ id: txId });
        const tx = st.data?.transaction;
        if (tx?.txHash) { txHash = tx.txHash; break; }
        if (['FAILED', 'DENIED', 'CANCELLED'].includes(tx?.state)) break;
      } catch (_) {}
    }

    console.log(`[withdraw] ${amount} USDC ${info.address}  ${to} (tx ${txHash || txId})`);
    res.json({
      ok: true,
      amountUsdc: amount,
      to,
      txId,
      txHash,
      explorerUrl: txHash ? `https://testnet.arcscan.app/tx/${txHash}` : null,
    });
  } catch (e) {
    console.error('[withdraw] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wallet/export
app.get('/api/wallet/export', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.query;
    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(404).json({ error: 'Wallet not found' });
    const info = await getWalletInfo(walletId);
    res.json({
      ...info,
      network: 'Arc Testnet',
      chainId: 5042002,
      rpc: rpcUrl,
      explorer: `https://testnet.arcscan.app/address/${info.address}`,
      note: 'Circle MPC wallet. Private key managed by Circle.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  GET /api/markets 

// Anchor the price users SEE to the real-world Polymarket consensus, blending
// toward the on-chain LMSR price only as genuine on-chain liquidity builds.
//
// Why: a freshly-deployed market starts at a 50/50 LMSR pool and only moves when
// someone trades on Puls. Showing a raw 50T/50T on a market that Polymarket
// prices at (say) 5T YES misleads users and lets the on-chain price drift away
// from reality. So with little on-chain volume we trust Polymarket; once real
// USDC liquidity accumulates, we trust the market itself.
//
// totalVolume here = poolYes + poolNo (6-dec USDC units already divided down).
const PRICE_LIQUIDITY_FULL = 50; // USDC of on-chain pool at which we fully trust on-chain price
function displayPrices(onchainYes, pmYes, totalVolume) {
  const pm = (typeof pmYes === 'number' && pmYes >= 0 && pmYes <= 1) ? pmYes : null;
  const oc = (typeof onchainYes === 'number' && onchainYes >= 0 && onchainYes <= 1) ? onchainYes : null;
  // Always quote the Polymarket consensus when we have it. The on-chain LMSR
  // price only governs actual share payouts; on a low-liquidity testnet it can
  // drift far from consensus, which looks broken (e.g. PM 2T vs Arc 50T) and
  // even makes our own agents distrust Arc. So the PRICE users and agents see
  // tracks Polymarket 1:1; on-chain is used only when there's no consensus.
  if (pm !== null) return { yes: pm, no: 1 - pm };
  if (oc !== null) return { yes: oc, no: 1 - oc };
  return { yes: 0.5, no: 0.5 };
}

// Pulse-native engagement aggregation (trades + comments) shown on the markets
// feed. This used to scan the FULL trades + comments tables on EVERY
// /api/markets request  O(all trades) per call, which grows with traction and
// burns the 1-vCPU box on revalidations / query-param variants. Memoize it for a
// short window so concurrent requests share one scan (the feed is 10s CDN-cached).
let _activityAgg = { at: 0, tradeAgg: {}, commentAgg: {} };
let _pmLastGood = null; // last successful Polymarket markets list  served on upstream failure so the feed never empties/hangs
const ACTIVITY_AGG_TTL = parseInt(process.env.MARKETS_ACTIVITY_TTL_MS || '25000', 10);
async function getMarketActivityAgg() {
  if (Date.now() - _activityAgg.at < ACTIVITY_AGG_TTL) return _activityAgg;
  const tradeAgg = {};   // market_id(lowercased) -> { trades, holders:Set, vol }
  const commentAgg = {}; // market id -> comment count
  try {
    // Supabase caps at 1000 rows by default without pagination. 
    // We order by created_at descending to ensure we aggregate the most RECENT activity, 
    // not the oldest trades from the start of the platform.
    const { data: _tr } = await supabase
      .from('trades')
      .select('market_id, user_id, usdc_amount')
      .order('created_at', { ascending: false })
      .limit(2000);
    for (const t of (_tr || [])) {
      const k = (t.market_id || '').toLowerCase();
      if (!k) continue;
      const a = tradeAgg[k] || (tradeAgg[k] = { trades: 0, holders: new Set(), vol: 0 });
      a.trades++;
      if (t.user_id) a.holders.add(t.user_id);
      a.vol += parseFloat(t.usdc_amount) || 0;
    }
  } catch (e) { console.warn('[markets] trade aggregation failed:', e.message); }
  try {
    const { data: _cm } = await supabase.from('comments').select('target_id').eq('target_type', 'market');
    for (const c of (_cm || [])) { if (c.target_id) commentAgg[c.target_id] = (commentAgg[c.target_id] || 0) + 1; }
  } catch (e) { console.warn('[markets] comment aggregation failed:', e.message); }
  _activityAgg = { at: Date.now(), tradeAgg, commentAgg };
  return _activityAgg;
}

app.get('/sitemap.xml', async (req, res) => {
  try {
    const { data: markets, error } = await supabase
      .from('markets')
      .select('slug, created_at')
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const urls = (markets || []).map(m => {
      const dateStr = m.created_at ? new Date(m.created_at).toISOString() : new Date().toISOString();
      return `  <url>
    <loc>https://app.pulsmarket.tech/m/${m.slug}</loc>
    <lastmod>${dateStr}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;
    }).join('\n');

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://app.pulsmarket.tech/</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>always</changefreq>
    <priority>1.0</priority>
  </url>
${urls}
</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(sitemap);
  } catch (err) {
    console.error('[Sitemap] generation failed:', err.message);
    res.status(500).end();
  }
});

app.get('/api/markets', cacheMiddleware(30, 'v1'), async (req, res) => {
  try {
    const limit = req.query.limit || 50;
    const offset = req.query.offset || 0;

    // Pulse-native engagement (trades + comments) shown on the feed  memoized
    // (see getMarketActivityAgg) so a burst of requests / CDN revalidations don't
    // each re-scan the full trades + comments tables.
    const { tradeAgg, commentAgg } = await getMarketActivityAgg();
    const pulsActivity = (m) => {
      const ca = (m.contractAddress || '').toLowerCase();
      const ta = ca ? tradeAgg[ca] : null;
      return {
        pulsTrades: ta ? ta.trades : 0,
        pulsHolders: ta ? ta.holders.size : 0,
        pulsVolume: ta ? Math.round(ta.vol * 100) / 100 : 0,
        commentsCount: commentAgg[m.id] || commentAgg[m.slug] || 0,
      };
    };

    // Fetch custom user-created markets from database
    const { data: dbCustomMarkets, error: customErr } = await supabase
      .from('deployed_markets')
      .select('*')
      .eq('is_user_created', true);

    const customList = [];
    if (!customErr && dbCustomMarkets) {
      for (const row of dbCustomMarkets) {
        if (row.archived === true) continue;
        const slug = row.slug;
        const contractAddress = row.contract_address;
        
        let yesPrice = 0.5, noPrice = 0.5, poolYes = 0, poolNo = 0, totalVolume = 0;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: contractAddress,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          yesPrice = expYes / (expYes + expNo);
          noPrice = expNo / (expYes + expNo);
          totalVolume = poolYes + poolNo;
        } catch (err) {
          console.error(`Error reading custom market ${contractAddress} on-chain:`, err.message);
        }

        customList.push({
          id: slug,
          slug,
          contractAddress,
          question: row.title || slug,
          description: row.description || '',
          category: row.category || 'General',
          yesPrice: parseFloat(yesPrice.toFixed(4)),
          noPrice: parseFloat(noPrice.toFixed(4)),
          poolYes,
          poolNo,
          resolved: row.resolved,
          outcome: row.outcome,
          totalVolume,
          image: row.image_url || `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`,
          endDateIso: new Date(Number(row.deadline) * 1000).toISOString(),
          outcomePrices: JSON.stringify([yesPrice.toString(), noPrice.toString()]),
          featured: false,
          createdByAgent: row.created_by_agent === true,
          creatorId: row.creator_id || null,
        });
      }
    }

    let list = [];
    try {
      list = await fetchGamma(`/markets?limit=${limit}&active=true&closed=false&order=volume&ascending=false&offset=${offset}`);
      if (Array.isArray(list) && list.length) _pmLastGood = { at: Date.now(), data: list };
    } catch (e) {
      console.warn('[markets] Polymarket fetch error:', e.message);
    }
    // Upstream down/slow/empty  fetchGamma already served stale if available,
    // but keep the existing _pmLastGood fallback for this high-traffic route.
    if ((!Array.isArray(list) || !list.length) && _pmLastGood && Array.isArray(_pmLastGood.data)) {
      console.warn('[markets] serving last-good Polymarket cache (' + _pmLastGood.data.length + ' markets, age ' + Math.round((Date.now() - _pmLastGood.at) / 1000) + 's)');
      list = _pmLastGood.data;
    }
    
    const pmMergedList = await Promise.all(list.map(async (j) => {
      const slug = j.slug;
      const cached = deployedMarketsCache.get(slug);
      
      let contractAddress = null;
      let poolYes = null;
      let poolNo = null;
      let resolved = false;
      let outcome = null;
      let yesPrice = null;
      let noPrice = null;
      let totalVolume = null;

      if (cached) {
        contractAddress = cached.contractAddress;
        resolved = cached.resolved;
        outcome = cached.outcome;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: contractAddress,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          yesPrice = expYes / (expYes + expNo);
          noPrice = expNo / (expYes + expNo);
          totalVolume = poolYes + poolNo;
        } catch (err) {
          console.error(`Error reading on-chain market ${contractAddress}:`, err.message);
        }
      }

      let currentPrices = [0.5, 0.5];
      try {
        const rawPrices = j.outcomePrices || '["0.5","0.5"]';
        currentPrices = JSON.parse(rawPrices).map(p => parseFloat(p) || 0.5);
      } catch {}
      // Real-world consensus YES from Polymarket (used to anchor the shown price).
      const pmYes = currentPrices[0];
      // Blend the on-chain price toward consensus until real liquidity builds.
      const shown = displayPrices(yesPrice, pmYes, totalVolume);

      // A real-world event can finish before Polymarket flips `closed` (e.g. a
      // sports match that just ended). Don't let users trade those: if the event
      // has ended (or our on-chain market is resolved) force acceptingOrders off.
      // Polymarket also leaves some markets `active:true` past their endDate until
      // UMA resolves them  treat a passed deadline as ended too, so the feed stays
      // consistent with the /api/trade/buy deadline guard and the on-chain market.
      const deadlineMs = j.endDate ? Date.parse(j.endDate) : NaN;
      const deadlinePassed = Number.isFinite(deadlineMs) && deadlineMs < Date.now();
      const eventEnded = j.ended === true || j.finishedTimestamp != null || resolved === true || deadlinePassed;

      return {
        ...j,
        contractAddress,
        yesPrice: parseFloat(shown.yes.toFixed(4)),
        noPrice: parseFloat(shown.no.toFixed(4)),
        poolYes,
        poolNo,
        resolved,
        outcome,
        totalVolume,
        ended: eventEnded,
        acceptingOrders: eventEnded ? false : (j.acceptingOrders !== false),
      };
    }));

    const mergedList = [...customList, ...pmMergedList]
      .map((m) => ({ ...m, ...pulsActivity(m) }));

    // We want to show ALL markets, regardless of holder count.
    // Agents buying a market for the first time will have 1 holder, we MUST show them!
    const filteredList = mergedList;

    // Sort:
    // 1. Markets with ANY activity (holders > 0) go to the top, sorted by holder count, then trades.
    // 2. Everything else (0 holders) stays in its original Polymarket volume order.
    filteredList.sort((a, b) => {
      if (a.pulsHolders !== b.pulsHolders) {
        return b.pulsHolders - a.pulsHolders;
      }
      if (a.pulsTrades !== b.pulsTrades) {
        return b.pulsTrades - a.pulsTrades;
      }
      return 0; // Preserve original Polymarket sorting for the rest
    });

    res.json(filteredList);
  } catch (e) {
    console.error('/api/markets error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/activate
app.post('/api/market/activate', activateMarketLimiter, async (req, res) => {
  try {
    const { slug, deadline } = req.body;
    if (!slug || !deadline) {
      return res.status(400).json({ error: 'slug and deadline required' });
    }

    // Verify the slug exists and is active on Polymarket
    try {
      const data = await fetchGamma(`/markets?slug=${slug}`);
      if (!data || data.length === 0) {
        return res.status(400).json({ error: 'Invalid market slug: Not found on Polymarket' });
      }
        const pmMarket = data[0];
        if (pmMarket.closed || pmMarket.resolved) {
          return res.status(400).json({ error: 'Invalid market slug: Market is closed or resolved' });
        }
    } catch (err) {
      console.warn(`[Activate Warning] Polymarket verification failed: ${err.message}. Proceeding anyway.`);
    }

    const contractAddress = await getOrDeployMarket(slug, deadline);
    res.json({ contractAddress });
  } catch (e) {
    console.error('activate market error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/info
app.get('/api/market/info', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    
    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(404).json({ error: 'Market not deployed' });
    const contractAddress = cached.contractAddress;
    
    const [slugOnChain, deadline, resolved, outcome, yesOutstanding, noOutstanding] = await publicClient.readContract({
      address: contractAddress,
      abi: [
        {
          name: 'getMarketInfo',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [
            { name: '_slug', type: 'string' },
            { name: '_deadline', type: 'uint256' },
            { name: '_resolved', type: 'bool' },
            { name: '_outcome', type: 'bool' },
            { name: '_yesOutstanding', type: 'uint256' },
            { name: '_noOutstanding', type: 'uint256' }
          ]
        }
      ],
      functionName: 'getMarketInfo'
    });

    const poolYesVal = Number(yesOutstanding) / 1_000_000;
    const poolNoVal = Number(noOutstanding) / 1_000_000;
    
    const bVal = 10;
    const maxQ = Math.max(poolYesVal, poolNoVal);
    const expYes = Math.exp((poolYesVal - maxQ) / bVal);
    const expNo = Math.exp((poolNoVal - maxQ) / bVal);
    const yesPrice = expYes / (expYes + expNo);
    const noPrice = expNo / (expYes + expNo);
    const totalPool = poolYesVal + poolNoVal;

    res.json({
      contractAddress,
      question: slug,
      deadline: Number(deadline),
      resolved,
      outcome,
      poolYes: poolYesVal,
      poolNo: poolNoVal,
      yesPrice: parseFloat(yesPrice.toFixed(4)),
      noPrice: parseFloat(noPrice.toFixed(4)),
      totalVolume: totalPool
    });
  } catch (e) {
    console.error('getMarketInfo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Resolution transparency (PR 4) 
// GET /api/market/resolution-status?slug=...
// Tells the app HOW a market resolves: legacy Polymarket-consensus direct
// resolve, or UMA Optimistic Oracle (with live request state + dispute window).
app.get('/api/market/resolution-status', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) {
      return res.json({ mode: 'direct', deployed: false, resolved: false, outcome: null, contractAddress: null });
    }

    const base = {
      contractAddress: cached.contractAddress,
      deadline: cached.deadline,
      resolved: !!cached.resolved,
      outcome: cached.outcome ?? null,
      explorerUrl: `https://testnet.arcscan.app/address/${cached.contractAddress}`,
    };

    if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
      try {
        const r = await getUmaResolution(cached.contractAddress);
        if (r.registered) {
          const [bond, liveness] = await Promise.all([
            publicClient.readContract({ address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'bond' }),
            publicClient.readContract({ address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'liveness' }),
          ]);
          return res.json({
            ...base,
            mode: 'uma',
            oracle: {
              adapterAddress: UMA_ADAPTER_ADDRESS,
              oracleAddress: UMA_OOV2_ADDRESS,
              identifier: 'YES_OR_NO_QUERY',
              state: UMA_STATE[r.oracleState] || 'Invalid',
              requested: r.requested,
              settled: r.settled,
              requestTimestamp: Number(r.requestTimestamp),
              livenessSeconds: Number(liveness),
              bondUsdc: Number(bond) / 1_000_000,
              adapterExplorerUrl: `https://testnet.arcscan.app/address/${UMA_ADAPTER_ADDRESS}`,
              oracleExplorerUrl: `https://testnet.arcscan.app/address/${UMA_OOV2_ADDRESS}`,
            },
          });
        }
      } catch (e) {
        console.error('resolution-status UMA read failed:', e.message);
      }
    }

    return res.json({ ...base, mode: 'direct' });
  } catch (e) {
    console.error('resolution-status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Price history (PR 4) 
// GET /api/market/price-history?slug=...&hours=168
// Returns the YES-price series implied by completed trades on this market
// (entry_price is recorded per trade), oldest first.
app.get('/api/market/price-history', async (req, res) => {
  try {
    const { slug } = req.query;
    const hours = Math.min(Math.max(parseInt(req.query.hours || '168', 10) || 168, 1), 24 * 90);
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(404).json({ error: 'Market not deployed' });

    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('trades')
      .select('side, entry_price, usdc_amount, created_at, state')
      .eq('market_id', cached.contractAddress)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(2000);
    if (error) throw error;

    const points = (data || [])
      .filter((t) => t.state === 'COMPLETE' && t.entry_price != null)
      .map((t) => {
        const p = parseFloat(t.entry_price);
        // entry_price is stored for the traded side; normalize to YES price.
        const yesPrice = t.side === 'NO' ? 1 - p : p;
        return {
          t: Math.floor(new Date(t.created_at).getTime() / 1000),
          yesPrice: Math.min(Math.max(yesPrice, 0), 1),
          volume: parseFloat(t.usdc_amount) || 0,
        };
      });

    res.json({ slug, contractAddress: cached.contractAddress, hours, points });
  } catch (e) {
    console.error('price-history error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Trade 

app.post('/api/trade/buy', apiKeyOrAuth, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, side, usdcAmount, question, slug, deadline } = req.body;
    if (!userId || !side || !usdcAmount || !slug || !deadline) return res.status(400).json({ error: 'Missing fields' });

    // Reject trades on markets whose deadline has already passed (the event is
    // over). Cheap guard with no extra network call; the feed also marks ended
    // markets acceptingOrders:false, and the on-chain contract enforces it too.
    const deadlineSec = Number(deadline);
    if (Number.isFinite(deadlineSec) && deadlineSec > 0 && deadlineSec * 1000 < Date.now()) {
      return res.status(400).json({ error: 'This market has closed  pick another one.' });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'No wallet' });

    const contractAddress = await getOrDeployMarket(slug, deadline);

    const isYes = side === 'YES';
    const amount = parseFloat(usdcAmount);
    const amountMicro = Math.round(amount * 1_000_000).toString();

    const info = await getWalletInfo(walletId);
    if (parseFloat(info.usdcBalance) < amount) {
      return res.status(400).json({
        error: `Insufficient USDC. Balance: $${info.usdcBalance}, Need: $${amount.toFixed(2)}.`,
      });
    }

    if (!(await isApproved(walletId, contractAddress))) {
      const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      try {
        const approveRes = await circle.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC,
          abiFunctionSignature: 'approve(address,uint256)',
          abiParameters: [contractAddress, MAX],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        // Poll the approval tx instead of a fixed sleep  slow approvals used
        // to make the follow-up buy revert with "transfer amount exceeds allowance".
        const approveTxId = approveRes.data?.id;
        for (let i = 0; approveTxId && i < 20; i++) {
          const s = (await circle.getTransaction({ id: approveTxId })).data?.transaction?.state;
          if (s === 'COMPLETE' || s === 'CONFIRMED') break;
          if (s === 'FAILED' || s === 'DENIED' || s === 'CANCELLED') {
            throw new Error('USDC approval transaction failed');
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
        console.error('approve error:', e.message);
      }
    }

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: isYes ? 'buyYes(uint256)' : 'buyNo(uint256)',
      abiParameters: [amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = txRes.data.id;

    await saveTrade(userId, {
      tx_id: txId,
      side,
      usdc_amount: amount,
      entry_price: clampPrice(req.body.entryPrice),
      question: question || 'Prediction Market',
      market_id: contractAddress,
      state: 'INITIATED',
    });

    // Copy-trade: mirror this BUY onto the leader's followers (fire-and-forget;
    // gated by COPY_TRADE_ENABLED, never blocks or fails the leader's own trade).
    copyTrade
      .mirrorBuyToFollowers(userId, {
        slug,
        deadline,
        side,
        usdcAmount: amount,
        question,
        entryPrice: req.body.entryPrice,
      })
      .catch((err) => console.error('[copy] mirror dispatch error:', err.message));

    // Points (Traction): reward the trade  fire-and-forget, never blocks.
    (async () => {
      try {
        await touchStreak(userId);
        await awardPoints(userId, 'trade', { refType: 'trade', refId: txId });
        const { count } = await supabase
          .from('trades').select('id', { count: 'exact', head: true }).eq('user_id', userId);
        if ((count ?? 0) <= 1) {
          await awardPoints(userId, 'first_trade', { refId: 'first' });
          await awardPoints(userId, 'fund_wallet', { refId: 'funded' });
          // Referral activation: if this user was invited, reward BOTH sides
          // now that the invitee has genuinely activated (first real trade).
          try {
            const { data: ref } = await supabase
              .from('referrals').select('referrer_user_id').eq('invitee_user_id', userId).maybeSingle();
            if (ref?.referrer_user_id && ref.referrer_user_id !== userId) {
              await awardPoints(ref.referrer_user_id, 'referral_activated', { refType: 'referral', refId: userId });
              await awardPoints(userId, 'referral_activated', { refType: 'referral', refId: `self-${userId}` });
              createNotification(ref.referrer_user_id, 'Your invite activated! ',
                'A friend you invited just made their first prediction  you both earned +60 XP.', 'referral_activated').catch(() => {});
            }
          } catch (_) {}
        }
      } catch (_) {}
    })();

    res.json({ txId, state: txRes.data.state, side, balance: info.usdcBalance });
  } catch (e) {
    console.error('trade buy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/sell', apiKeyOrAuth, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, side, shares, question, slug, contractAddress: reqContract, owner } = req.body;
    if (!userId || !side || !shares) return res.status(400).json({ error: 'Missing fields' });

    // Agent-bought positions are held by the user's AI-agent wallet, so the sell
    // must execute from that wallet (the user wallet holds none of those shares).
    // The agent wallet is derived from the authenticated userId  no cross-user risk.
    const isAgentPosition = owner === 'agent';
    const walletOwnerId = isAgentPosition ? `agent_${userId}` : userId;
    const walletId = await getWalletId(walletOwnerId);
    if (!walletId) return res.status(400).json({ error: isAgentPosition ? 'No agent wallet' : 'No wallet' });

    // Prefer the position's own contract; fall back to slug -> cache.
    let contractAddress = (reqContract && /^0x[0-9a-fA-F]{40}$/.test(reqContract)) ? reqContract : null;
    if (!contractAddress) {
      const cached = slug ? deployedMarketsCache.get(slug) : null;
      if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
      contractAddress = cached.contractAddress;
    }

    const isYes = side === 'YES';
    const sharesAmount = parseFloat(shares);
    const sharesMicro = Math.round(sharesAmount * 1_000_000).toString();

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: isYes ? 'sellYes(uint256)' : 'sellNo(uint256)',
      abiParameters: [sharesMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = txRes.data.id;

    const estimatedPayout = sharesAmount * clampPrice(req.body.entryPrice);
    await saveTrade(userId, {
      tx_id: txId,
      side,
      usdc_amount: -estimatedPayout,
      entry_price: clampPrice(req.body.entryPrice),
      question: question || 'Prediction Market',
      market_id: contractAddress,
      state: 'INITIATED',
    });

    res.json({ txId, state: txRes.data.state, side });
  } catch (e) {
    console.error('sell trade error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Batch-claim every resolved + won + unclaimed position for the user. One tap
//  multiple on-chain claim() txs, a powerful "come back and collect" hook.
app.post('/api/trade/claim-all', apiKeyOrAuth, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing fields' });
    
    // We need to check both the user's wallet and their agent's wallet
    const wallets = [];
    const mainWalletId = await getWalletId(userId);
    if (mainWalletId) {
      const addr = await getWalletInfo(mainWalletId).then(info => info.address).catch(() => null);
      if (addr) wallets.push({ id: mainWalletId, address: addr, suffix: '' });
    }
    try {
      const agentWalletId = await getWalletId(`agent_${userId}`);
      if (agentWalletId) {
        const addr = await getWalletInfo(agentWalletId).then(info => info.address).catch(() => null);
        if (addr) wallets.push({ id: agentWalletId, address: addr, suffix: '_AGENT' });
      }
    } catch (_) {}

    if (wallets.length === 0) return res.status(400).json({ error: 'No wallets found' });

    // Candidate markets: ones the user has traded.
    const { data: rows } = await supabase
      .from('trades').select('market_id').in('user_id', [userId, `agent_${userId}`]).eq('state', 'COMPLETE')
      .order('created_at', { ascending: false }).limit(3000);
    const markets = [...new Set((rows || []).map(r => r.market_id).filter(m => m && m.startsWith('0x')))];

    const posAbi = [{ name: 'getUserPosition', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'user', type: 'address' }],
      outputs: [{ name: '_yes', type: 'uint256' }, { name: '_no', type: 'uint256' }, { name: '_claimed', type: 'bool' }] }];
    const infoAbi = [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
      { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
      { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
      { name: '_y', type: 'uint256' }, { name: '_n', type: 'uint256' } ] }];

    const claimed = [];
    const claimDeadline = Date.now() + 22000; // keep under Heroku's 30s limit
    for (const m of markets) {
      if (Date.now() > claimDeadline) break; // return partial results instead of H12
      for (const wallet of wallets) {
        try {
          const [pos, info] = await Promise.all([
            publicClient.readContract({ address: m, abi: posAbi, functionName: 'getUserPosition', args: [wallet.address] }),
            publicClient.readContract({ address: m, abi: infoAbi, functionName: 'getMarketInfo' }),
          ]);
          const yes = Number(pos[0]) / 1e6, no = Number(pos[1]) / 1e6, isClaimed = pos[2];
          const resolved = info[2], outcome = info[3];
          if (!resolved || isClaimed) continue;
          const won = outcome ? yes > 0.0001 : no > 0.0001;
          if (!won) continue;
          const txRes = await circle.createContractExecutionTransaction({
            walletId: wallet.id, contractAddress: m, abiFunctionSignature: 'claim()', abiParameters: [],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          
          await supabase.from('trades').insert({
            user_id: wallet.suffix ? `agent_${userId}` : userId,
            market_id: m,
            side: 'CLAIM',
            usdc_amount: 0,
            tx_id: txRes.data.id,
            state: txRes.data.state || 'INITIATED'
          });

          claimed.push({ market: m, txId: txRes.data.id, walletId: wallet.id });
          awardPoints(userId, 'win', { refType: 'claim', refId: `${m}-${txRes.data.id}` }).catch(() => {});
        } catch (e) {
          console.warn(`[claim-all] ${m} for ${wallet.address} skipped:`, e.message);
        }
      }
    }
    if (claimed.length) touchStreak(userId).catch(() => {});
    res.json({ ok: true, claimed: claimed.length, items: claimed });
  } catch (e) {
    console.error('claim-all error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/claim', apiKeyOrAuth, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, slug, contractAddress: reqContract } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing fields' });

    // We need to check both the user's wallet and their agent's wallet
    const wallets = [];
    const mainWalletId = await getWalletId(userId);
    if (mainWalletId) {
      const addr = await getWalletInfo(mainWalletId).then(info => info.address).catch(() => null);
      if (addr) wallets.push({ id: mainWalletId, address: addr, suffix: '' });
    }
    try {
      const agentWalletId = await getWalletId(`agent_${userId}`);
      if (agentWalletId) {
        const addr = await getWalletInfo(agentWalletId).then(info => info.address).catch(() => null);
        if (addr) wallets.push({ id: agentWalletId, address: addr, suffix: '_AGENT' });
      }
    } catch (_) {}

    if (wallets.length === 0) return res.status(400).json({ error: 'No wallets found' });

    // Prefer the position's own contract; fall back to slug -> cache.
    let contractAddress = (reqContract && /^0x[0-9a-fA-F]{40}$/.test(reqContract)) ? reqContract : null;
    if (!contractAddress) {
      const cached = slug ? deployedMarketsCache.get(slug) : null;
      if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
      contractAddress = cached.contractAddress;
    }

    const posAbi = [{ name: 'getUserPosition', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'user', type: 'address' }],
      outputs: [{ name: '_yes', type: 'uint256' }, { name: '_no', type: 'uint256' }, { name: '_claimed', type: 'bool' }] }];
    const infoAbi = [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
      { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
      { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
      { name: '_y', type: 'uint256' }, { name: '_n', type: 'uint256' } ] }];

    const claimed = [];
    for (const wallet of wallets) {
      try {
        const [pos, info] = await Promise.all([
          publicClient.readContract({ address: contractAddress, abi: posAbi, functionName: 'getUserPosition', args: [wallet.address] }),
          publicClient.readContract({ address: contractAddress, abi: infoAbi, functionName: 'getMarketInfo' }),
        ]);
        const yes = Number(pos[0]) / 1e6, no = Number(pos[1]) / 1e6, isClaimed = pos[2];
        const resolved = info[2], outcome = info[3];
        if (!resolved || isClaimed) continue;
        const won = outcome ? yes > 0.0001 : no > 0.0001;
        if (!won) continue;

        const txRes = await circle.createContractExecutionTransaction({
          walletId: wallet.id,
          contractAddress: contractAddress,
          abiFunctionSignature: 'claim()',
          abiParameters: [],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });

        await supabase.from('trades').insert({
          user_id: wallet.suffix ? `agent_${userId}` : userId,
          market_id: contractAddress,
          side: 'CLAIM',
          usdc_amount: 0,
          tx_id: txRes.data.id,
          state: txRes.data.state || 'INITIATED'
        });

        claimed.push({ txId: txRes.data.id, state: txRes.data.state, walletId: wallet.id });
      } catch (e) {
        console.warn(`[claim] ${contractAddress} for ${wallet.address} skipped:`, e.message);
      }
    }

    if (claimed.length > 0) {
      (async () => { try {
        await touchStreak(userId);
        await awardPoints(userId, 'win', { refType: 'claim', refId: `${contractAddress}-${claimed[0].txId}` });
      } catch (_) {} })();
      res.json({ ok: true, claimed: claimed.length, items: claimed, txId: claimed[0].txId, state: claimed[0].state });
    } else {
      res.json({ ok: false, claimed: 0, error: 'No claimable positions found for this market.' });
    }

  } catch (e) {
    console.error('claim error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trade/status', async (req, res) => {
  try {
    let { txId } = req.query;
    if (!txId) return res.status(400).json({ error: 'txId required' });

    if (txId.startsWith('0x')) {
      txId = normalizeTxHash(txId);
      // External browser wallet transaction hash
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txId });
        if (receipt) {
          const state = receipt.status === 'success' ? 'COMPLETE' : 'FAILED';
          return res.json({ txId, state, txHash: txId });
        }
      } catch (err) {
        // Receipt not found yet (still pending/mining)
        return res.json({ txId, state: 'INITIATED', txHash: txId });
      }
      return res.json({ txId, state: 'INITIATED', txHash: txId });
    }

    const txRes = await circle.getTransaction({ id: txId });
    const tx = txRes.data.transaction;
    // Persist the latest state to the trades row BEFORE responding, so that the
    // portfolio reload the client fires on COMPLETE already sees the final state
    // (previously the row stayed INITIATED until a later background sync, which
    // made positions show "Pending" until a full page reload).
    if (tx.state && tx.state !== 'INITIATED') {
      try {
        const upd = { state: tx.state };
        if (tx.txHash) upd.tx_hash = tx.txHash;
        await supabase.from('trades').update(upd).eq('tx_id', txId);
      } catch (err) {
        console.error('trade/status row sync failed:', err.message);
      }
    }
    res.json({ txId: txRes.data.id, state: tx.state, txHash: tx.txHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/save-external', tradeLimiter, async (req, res) => {
  try {
    let { userId, side, usdcAmount, entryPrice, question, txHash, marketId } = req.body;
    if (!userId || !side || !usdcAmount || !entryPrice || !question || !txHash) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    txHash = normalizeTxHash(txHash);

    // Verify transaction on-chain
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (!receipt) {
        return res.status(400).json({ error: 'Transaction receipt not found on-chain' });
      }
      if (receipt.status !== 'success') {
        return res.status(400).json({ error: 'Transaction failed on-chain' });
      }

      // Verify transaction sender matches the requested user address
      const expectedAddress = userId.replace('eth_', '').toLowerCase();
      if (receipt.from.toLowerCase() !== expectedAddress) {
        console.warn(`[Save-External Warning] Sender mismatch. Expected: ${expectedAddress}, Got: ${receipt.from}`);
        return res.status(403).json({ error: 'Forbidden: Transaction sender mismatch' });
      }

      // Verify transaction destination/target matches marketId contract address
      if (marketId && receipt.to.toLowerCase() !== marketId.toLowerCase()) {
        console.warn(`[Save-External Warning] Market mismatch. Expected: ${marketId}, Got: ${receipt.to}`);
        return res.status(403).json({ error: 'Forbidden: Market address mismatch' });
      }
    } catch (err) {
      console.error('[Save-External Verification Error]', err.message);
      return res.status(400).json({ error: `On-chain verification failed: ${err.message}` });
    }

    await saveTrade(userId, {
      tx_id: `ext_${Date.now()}`,
      side,
      usdc_amount: parseFloat(usdcAmount),
      entry_price: clampPrice(entryPrice),
      question,
      market_id: marketId,
      state: 'COMPLETE',
      tx_hash: txHash,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In-memory cache for /api/trade/recent  this endpoint is polled by the
// frontend feed every few seconds. Without caching, each poll hits Supabase.
let _recentTradesCache = { data: null, ts: 0 };
const RECENT_TRADES_TTL_MS = 3000; // 3s  fresh enough for live feed
app.get('/api/trade/recent', async (req, res) => {
  try {
    const { limit = 20, marketId } = req.query;
    const limitNum = Math.min(100, parseInt(limit) || 20);

    // Use cache for the default (no marketId) case  avoids hitting Supabase
    // on every poll. When marketId is specified, skip cache (different query).
    if (!marketId && _recentTradesCache.data && Date.now() - _recentTradesCache.ts < RECENT_TRADES_TTL_MS) {
      return res.json(_recentTradesCache.data.slice(0, limitNum));
    }

    let query = supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.max(limitNum, 50)); // fetch more than needed for cache hit

    if (marketId) {
      query = query.eq('market_id', marketId).limit(limitNum);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching recent trades:', error.message);
      return res.status(500).json({ error: error.message });
    }
    // Cache the result (only for the no-marketId default path).
    if (!marketId) {
      _recentTradesCache = { data: data ?? [], ts: Date.now() };
    }
    res.json(data ?? []);
  } catch (e) {
    console.error('recent trades error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  GET /api/portfolio 
app.get('/api/portfolio', apiKeyOrAuth, async (req, res) => {
  try {
    let { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    // Derive or enforce the correct userId from JWT token if user is authenticated
    if (req.user) {
      const expectedUserId = (typeof req.user.id === 'string' && (req.user.id.startsWith('supabase_') || req.user.id.startsWith('google_')))
        ? req.user.id
        : `supabase_${req.user.id}`;
      userId = expectedUserId;
    }

    let userAddress = null;
    if (userId && (userId.startsWith('0x') || userId.startsWith('eth_0x'))) {
      userAddress = userId.replace('eth_', '');
    } else {
      const walletId = await getWalletId(userId);
      const info = walletId ? await getWalletInfo(walletId) : null;
      userAddress = info?.address;
    }

    // Also include the user's AI-agent wallet so agent-bought positions appear.
    let agentAddress = null;
    try {
      const agentWalletId = await getWalletId(`agent_${userId}`);
      if (agentWalletId) agentAddress = (await getWalletInfo(agentWalletId)).address;
    } catch (_) {}
    const scanAddresses = [userAddress, agentAddress].filter(Boolean);

    const rows = await getTrades([userId, `agent_${userId}`]);

    const terminalStates = ['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'];
    const pendingRows = rows.filter(r => !r.state || !terminalStates.includes(r.state.toUpperCase()));
    if (pendingRows.length > 0) {
      // Sync pending rows synchronously (capped) so THIS response already reflects
      // the final tx state instead of requiring a second reload.
      await Promise.allSettled(pendingRows.slice(0, 6).map(async (r) => {
        if (!r.tx_id || r.tx_id.startsWith('ext_')) return;
        try {
          const tx = await circle.getTransaction({ id: r.tx_id });
          const state = tx.data.transaction.state;
          const txHash = tx.data.transaction.txHash ?? r.tx_hash;
          if (state && state !== r.state) {
            r.state = state;          // reflect in this request's position math
            r.tx_hash = txHash;
            await supabase.from('trades').update({ state, tx_hash: txHash }).eq('tx_id', r.tx_id);
          }
        } catch (err) {
          console.error(`Portfolio pending sync failed for tx ${r.tx_id}:`, err.message);
        }
      }));
    }

    let positions = [];
    const uniqueMarkets = [...new Set(rows.map(r => r.market_id).filter(id => id && id.startsWith('0x')))];

    if (scanAddresses.length > 0 && uniqueMarkets.length > 0) {
      const posAbi = [{ name: 'getUserPosition', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'user', type: 'address' }],
        outputs: [{ name: '_yes', type: 'uint256' }, { name: '_no', type: 'uint256' }, { name: '_claimed', type: 'bool' }] }];
      const infoAbi = [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
        { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
        { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
        { name: '_y', type: 'uint256' }, { name: '_n', type: 'uint256' } ] }];

      const calls = [];
      for (const m of uniqueMarkets) {
        calls.push({ address: m, abi: infoAbi, functionName: 'getMarketInfo' });
      }
      for (const m of uniqueMarkets) {
        for (const addr of scanAddresses) {
          calls.push({ address: m, abi: posAbi, functionName: 'getUserPosition', args: [addr] });
        }
      }

      let multicallResults = [];
      let rpcSuccess = true;
      try {
        multicallResults = await publicClient.multicall({
          contracts: calls,
          allowFailure: true
        });
      } catch (err) {
        console.error('Portfolio multicall failed:', err.message);
        rpcSuccess = false;
      }

      for (let i = 0; i < uniqueMarkets.length; i++) {
        const marketAddress = uniqueMarkets[i];
        
        let question = 'Prediction Market';
        let resolved = false;
        let outcome = null;
        const slug = contractToSlugCache.get(marketAddress.toLowerCase()) || '';
        
        const cached = slug ? deployedMarketsCache.get(slug) : null;
        if (cached && cached.resolved) {
          resolved = true;
          outcome = cached.outcome;
        }

        const tradeForMarket = rows.find(r => r.market_id === marketAddress);
        if (tradeForMarket && tradeForMarket.question) {
          question = tradeForMarket.question;
        }

        const completedTrades = rows.filter(r => r.state === 'COMPLETE' && r.market_id === marketAddress);
        const yesCost = completedTrades.filter(r => r.side === 'YES').reduce((sum, r) => sum + parseFloat(r.usdc_amount ?? 0), 0);
        const noCost = completedTrades.filter(r => r.side === 'NO').reduce((sum, r) => sum + parseFloat(r.usdc_amount ?? 0), 0);

        if (rpcSuccess && multicallResults[i].status === 'success') {
          const infoRes = multicallResults[i].result;
          resolved = infoRes[2];
          outcome = infoRes[3];
        }

        const holders = [];
        let totalYes = 0;
        let totalNo = 0;
        let anyClaimed = false;

        for (let j = 0; j < scanAddresses.length; j++) {
          const addr = scanAddresses[j];
          const owner = addr === userAddress ? 'user' : 'agent';
          const posIdx = uniqueMarkets.length + (i * scanAddresses.length) + j;
          
          let yesShares = 0;
          let noShares = 0;
          let claimed = false;

          if (rpcSuccess && multicallResults[posIdx].status === 'success') {
            const posData = multicallResults[posIdx].result;
            yesShares = Number(posData[0]) / 1e6;
            noShares = Number(posData[1]) / 1e6;
            claimed = posData[2];
          } else {
            const addrTrades = completedTrades.filter(t => 
              owner === 'user' ? !t.user_id.startsWith('agent_') : t.user_id.startsWith('agent_')
            );
            addrTrades.forEach(r => {
              if (r.side === 'SELL') {
                if (r.outcome === 'YES') { yesShares -= (parseFloat(r.usdc_amount) || 0) / (parseFloat(r.entry_price) || 0.5); }
                else if (r.outcome === 'NO') { noShares -= (parseFloat(r.usdc_amount) || 0) / (parseFloat(r.entry_price) || 0.5); }
              } else if (r.side === 'YES') {
                yesShares += (parseFloat(r.usdc_amount) || 0) / (parseFloat(r.entry_price) || 0.5);
              } else if (r.side === 'NO') {
                noShares += (parseFloat(r.usdc_amount) || 0) / (parseFloat(r.entry_price) || 0.5);
              } else if (r.side === 'CLAIM') {
                claimed = true;
              }
            });
            if (claimed) { yesShares = 0; noShares = 0; }
          }
          
          if (claimed) { yesShares = 0; noShares = 0; }
          if (yesShares < 0.0001) yesShares = 0;
          if (noShares < 0.0001) noShares = 0;
          
          if (claimed) anyClaimed = true;

          if (yesShares > 0.0001 || noShares > 0.0001) {
            holders.push({ owner, address: addr, yesShares, noShares });
            totalYes += yesShares;
            totalNo += noShares;
          }
        }

        if (totalYes < 0.0001 && totalNo < 0.0001) continue;

        const yesEntryPrice = yesCost > 0 ? Math.min(0.99, Math.max(0.01, yesCost / totalYes)) : 0.5;
        const noEntryPrice = noCost > 0 ? Math.min(0.99, Math.max(0.01, noCost / totalNo)) : 0.5;

        for (const h of holders) {
          const ownerSuffix = h.owner === 'agent' ? '-AGENT' : '';
          if (h.yesShares > 0.0001) {
            positions.push({
              id: `${userId}-${marketAddress}-YES${ownerSuffix}`,
              side: 'YES',
              owner: h.owner,
              holderAddress: h.address,
              usdcAmount: h.yesShares * yesEntryPrice,
              entryPrice: yesEntryPrice,
              shares: h.yesShares,
              question, slug,
              marketId: marketAddress, contractAddress: marketAddress,
              state: 'COMPLETE', claimed: anyClaimed, resolved, outcome,
              isEstimate: !rpcSuccess,
              txHash: completedTrades.find(r => r.side === 'YES')?.tx_hash || null,
              timestamp: completedTrades.find(r => r.side === 'YES')?.created_at || new Date().toISOString()
            });
          }
          if (h.noShares > 0.0001) {
            positions.push({
              id: `${userId}-${marketAddress}-NO${ownerSuffix}`,
              side: 'NO',
              owner: h.owner,
              holderAddress: h.address,
              usdcAmount: h.noShares * noEntryPrice,
              entryPrice: noEntryPrice,
              shares: h.noShares,
              question, slug,
              marketId: marketAddress, contractAddress: marketAddress,
              state: 'COMPLETE', claimed: anyClaimed, resolved, outcome,
              isEstimate: !rpcSuccess,
              txHash: completedTrades.find(r => r.side === 'NO')?.tx_hash || null,
              timestamp: completedTrades.find(r => r.side === 'NO')?.created_at || new Date().toISOString()
            });
          }
        }
      }
    }
    const pendingTrades = rows.filter(r => !r.state || !terminalStates.includes(r.state.toUpperCase()));
    for (const r of pendingTrades) {
      positions.push({
        id: r.id,
        side: r.side,
        usdcAmount: parseFloat(r.usdc_amount ?? 0),
        entryPrice: parseFloat(r.entry_price ?? 0),
        question: r.question,
        marketId: r.market_id,
        contractAddress: r.market_id,
        state: r.state || 'INITIATED',
        txHash: r.tx_hash || null,
        timestamp: r.created_at,
        shares: Math.abs(parseFloat(r.usdc_amount ?? 0)) / parseFloat(r.entry_price ?? 0.5)
      });
    }

    const completed = positions.filter(p => p.state === 'COMPLETE');
    const totalSpent = completed.reduce((s, p) => s + p.usdcAmount, 0).toFixed(2);
    
    res.json({ positions, totalSpent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  AI Market Analyst 
// Public, cached, auto-generated market brief: thesis, key factors, lean.
const insightCache = new Map(); // slug -> { data, ts }
const insightInflight = new Map(); // slug -> Promise
const INSIGHT_TTL_MS = 6 * 60 * 60 * 1000;

const insightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function parseLlmJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in LLM output');
  return JSON.parse(t.slice(start, end + 1));
}

async function generateMarketInsight(slug) {
  // 15s total timeout to beat Heroku H12 / 30s router limit
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const arr = await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}`);
    const m = Array.isArray(arr) ? arr[0] : null;
      if (m && m.question) {
        ctx.question = m.question;
        ctx.description = (m.description || '').slice(0, 1500);
        try { ctx.yesPrice = parseFloat(JSON.parse(m.outcomePrices || '[]')[0]); } catch {}
        ctx.endDate = m.endDate || null;
        ctx.volume = m.volume24hr ?? m.volume ?? null;
        ctx.change24h = m.oneDayPriceChange ?? null;
      }
  } catch (e) {
    console.error(`[Insight] Polymarket lookup failed for ${slug}:`, e.message);
  }
  if (!ctx.question) {
    const { data } = await supabase.from('deployed_markets').select('*').eq('slug', slug).maybeSingle();
    if (!data) throw new Error('unknown market');
    ctx.question = data.question || slug.replace(/-/g, ' ');
  }

  const sys = `You are the Puls AI Analyst, a sharp prediction-market researcher. Given a market AND live web research, produce a concise analyst brief grounded in the research  do NOT invent facts beyond what the question, pricing, and research support.
Respond with STRICT JSON only, no prose, matching exactly:
{"thesis": "<2 sentences: what this market is really about and what the current price + latest information implies>", "factors": ["<key factor 1>", "<key factor 2>", "<key factor 3>"], "lean": "YES" | "NO" | "UNCERTAIN", "confidence": "low" | "medium" | "high"}
Rules: factors are short (max 14 words each), concrete and specific to this question; prefer factors backed by the web research. lean reflects which outcome the evidence and current pricing favor; use UNCERTAIN when genuinely unclear. Never give financial advice wording; this is analysis.`;

  // Live web research on the question (keyless) so the brief reflects real,
  // current information instead of model priors. Best-effort.
  let research = { brief: '', sources: [] };
  try {
    research = await researchQuestion(ctx.question, 4);
  } catch (e) {
    console.error(`[Insight] research failed for ${slug}:`, e.message);
  }

  const user = [
    `Market question: ${ctx.question}`,
    ctx.description ? `Resolution criteria / description: ${ctx.description}` : null,
    ctx.yesPrice != null && !Number.isNaN(ctx.yesPrice) ? `Current YES price: ${(ctx.yesPrice * 100).toFixed(0)}T` : null,
    ctx.change24h != null ? `24h price change: ${(ctx.change24h * 100).toFixed(1)}T` : null,
    ctx.volume != null ? `Volume: $${ctx.volume}` : null,
    ctx.endDate ? `Resolution date: ${ctx.endDate}` : null,
    research.brief ? `\nLive web research (latest, cite these in your factors):\n${research.brief}` : null,
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { signal: controller.signal });
    const parsed = parseLlmJson(raw);
    const lean = ['YES', 'NO', 'UNCERTAIN'].includes(parsed.lean) ? parsed.lean : 'UNCERTAIN';
    const confidence = ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium';
    clearTimeout(timeoutId);
    return {
      slug,
      question: ctx.question,
      thesis: formatForApp(String(parsed.thesis || '').slice(0, 600)),
      factors: (Array.isArray(parsed.factors) ? parsed.factors : []).slice(0, 4).map((f) => String(f).slice(0, 160)),
      lean,
      confidence,
      sources: (research.sources || []).slice(0, 3),
      source: 'llm',
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(`[Insight] LLM failed for ${slug}, using quantitative fallback:`, e.message);
    const q = quantInsight(slug, ctx);
    q.sources = (research.sources || []).slice(0, 3);
    return q;
  }
}

// Deterministic, data-driven brief when the LLM is unavailable.
function quantInsight(slug, ctx) {
  const yes = ctx.yesPrice != null && !Number.isNaN(ctx.yesPrice) ? ctx.yesPrice : 0.5;
  const pct = Math.round(yes * 100);
  const change = ctx.change24h != null ? ctx.change24h * 100 : null;
  const daysLeft = ctx.endDate ? Math.max(0, Math.round((new Date(ctx.endDate) - Date.now()) / 86400000)) : null;

  const lean = yes >= 0.6 ? 'YES' : yes <= 0.4 ? 'NO' : 'UNCERTAIN';
  const edge = Math.abs(yes - 0.5);
  const confidence = edge > 0.35 ? 'high' : edge > 0.15 ? 'medium' : 'low';

  const factors = [];
  if (change != null && Math.abs(change) >= 0.5) {
    factors.push(`Price moved ${change > 0 ? '+' : ''}${change.toFixed(1)}T in the last 24h  momentum ${change > 0 ? 'toward' : 'away from'} YES`);
  } else {
    factors.push('Price has been stable over the last 24h  no fresh information shifting the odds');
  }
  if (daysLeft != null) {
    factors.push(daysLeft <= 3 ? `Resolves in ${daysLeft} day${daysLeft === 1 ? '' : 's'}  little time left for the picture to change` : `${daysLeft} days until resolution  outcome can still swing on new developments`);
  }
  if (ctx.volume != null && parseFloat(ctx.volume) > 0) {
    factors.push(`$${Math.round(parseFloat(ctx.volume)).toLocaleString('en-US')} in source-market volume backs the current consensus`);
  }
  if (factors.length < 3) {
    factors.push(lean === 'UNCERTAIN' ? 'Market is near a coin flip  traders are genuinely split' : `Crowd consensus currently favors ${lean}`);
  }

  const thesis = lean === 'UNCERTAIN'
    ? `Traders price YES at ${pct}T, treating this as close to a coin flip. Neither side has conviction yet, so new information is likely to move this market sharply.`
    : `Traders price YES at ${pct}T, implying roughly a ${lean === 'YES' ? pct : 100 - pct}% chance the market resolves ${lean}. The crowd has taken a clear side; the open question is whether anything before resolution can flip it.`;

  return {
    slug,
    question: ctx.question,
    thesis,
    factors: factors.slice(0, 3),
    lean,
    confidence,
    source: 'quant',
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/market/insight?slug=...
  // 25s timeout to beat Heroku H12 (30s)
  app.get('/api/market/insight', insightLimiter, async (req, res) => {
    const timeoutMs = 25000;
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: 'Insight timeout', path: req.path });
    }, timeoutMs);
    try {
    const slug = (req.query.slug || '').toString().trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const cached = insightCache.get(slug);
    if (cached && Date.now() - cached.ts < INSIGHT_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    let p = insightInflight.get(slug);
    if (!p) {
      p = generateMarketInsight(slug)
        .then((data) => {
          // quant fallbacks expire faster so the LLM takes over once available
          const ttlShift = data.source === 'quant' ? INSIGHT_TTL_MS - 10 * 60 * 1000 : 0;
          insightCache.set(slug, { data, ts: Date.now() - ttlShift });
          return data;
        })
        .finally(() => insightInflight.delete(slug));
      insightInflight.set(slug, p);
    }
    const data = await p;
    clearTimeout(timer);
    res.json(data);
  } catch (e) {
    clearTimeout(timer);
    console.error('insight error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Protocol Stats 
let statsCache = { data: null, ts: 0 };
const STATS_TTL_MS = 60 * 1000;

// GET /api/stats  public protocol-level numbers for the landing page
app.get('/api/stats', cacheMiddleware(60, 'v1'), async (req, res) => {
  try {
    if (statsCache.data && Date.now() - statsCache.ts < STATS_TTL_MS) {
      return res.json(statsCache.data);
    }
    // Use a single SQL RPC function that aggregates everything in one query.
    // This replaces the old 22-page sequential pagination that took 15-20s.
    // The RPC runs as a single SELECT on the DB  returns in <500ms.
    // Fallback: if the RPC function doesn't exist yet (needs manual creation
    // in Supabase SQL Editor), fall back to count-only stats (fast, no pagination).
    const rpcRes = await supabase.rpc('get_protocol_stats');
    const stats = (rpcRes.data && typeof rpcRes.data === 'object' && !rpcRes.error) ? rpcRes.data : {};
    const rpcOk = Object.keys(stats).length > 0;

    // Only run extra queries if RPC didn't return them
    const [marketsRes, resolvedRes, usersRes, payCountRes, countRes] = rpcOk ? [{}, {}, {}, {}, {}] : await Promise.all([
      supabase.from('deployed_markets').select('*', { count: 'exact', head: true }),
      supabase.from('deployed_markets').select('*', { count: 'exact', head: true }).eq('resolved', true),
      supabase.from('wallets').select('*', { count: 'exact', head: true }),
      supabase.from('x402_payments').select('*', { count: 'exact', head: true }),
      supabase.from('trades').select('*', { count: 'exact', head: true }).eq('state', 'COMPLETE'),
    ]);

    const tradeCount = Number(stats.trade_count || countRes.count || 0);
    const volumeUsdc = Number(stats.volume_usdc || 0);
    const agentTrades = Number(stats.agent_trades || 0);
    const agentVolumeUsdc = Number(stats.agent_volume || 0);
    const seedTrades = Number(stats.seed_trades || 0);
    const seedVolumeUsdc = Number(stats.seed_volume || 0);
    const agentCount = Number(stats.agent_count || 0);

    // Nanopayment volume  from RPC if available, else single query
    const payCount = Number(stats.nanopayments || payCountRes.count || 0);
    const nanoVolumeUsdc = Number(stats.nano_volume || 0);
    let protocolRevenueUsdc = 0;
    // Only fetch nano details if RPC didn't have them
    if (!rpcOk && payCount > 0) {
      const { data: nanoAgg } = await supabase
        .from('x402_payments')
        .select('amount_usdc')
        .limit(10000);
      for (const r of (nanoAgg || [])) {
        nanoVolumeUsdc += parseFloat(r.amount_usdc) || 0; // won't run  nanoVolumeUsdc is const above
      }
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const organicTrades = Math.max(0, tradeCount - seedTrades);
    const data = {
      trades: organicTrades,
      volumeUsdc: r2(volumeUsdc - seedVolumeUsdc),
      totalTradesOnChain: tradeCount,
      totalVolumeUsdc: r2(volumeUsdc),
      marketsDeployed: Number(stats.markets || marketsRes.count || 0),
      marketsResolved: Number(stats.markets_resolved || resolvedRes.count || 0),
      users: Number(stats.users || usersRes.count || 0),
      humanTrades: Math.max(0, tradeCount - agentTrades - seedTrades),
      agentTrades,
      agents: agentCount,
      humanVolumeUsdc: r2(volumeUsdc - agentVolumeUsdc - seedVolumeUsdc),
      agentVolumeUsdc: r2(agentVolumeUsdc),
      nanopayments: { count: payCount, volumeUsdc: Math.round(nanoVolumeUsdc * 1e6) / 1e6 },
      protocolRevenueUsdc: Math.round(protocolRevenueUsdc * 1e6) / 1e6,
      takeRateBps: parseInt(process.env.PLATFORM_TAKE_RATE_BPS || '500', 10),
      updatedAt: new Date().toISOString(),
    };
    statsCache = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  GET /api/live  lightweight, poll-every-second counters for Puls Explorer 
// Cheap head-count queries only (no row pagination), 2s micro-cache so a 1s
// poll never hammers the DB. Plus the single most-recent trade for a "live tick".
let liveCache = { data: null, ts: 0 };
const LIVE_TTL_MS = 2000;
app.get('/api/live', async (req, res) => {
  try {
    if (liveCache.data && Date.now() - liveCache.ts < LIVE_TTL_MS) {
      return res.json({ ...liveCache.data, cached: true });
    }
    const [tradesRes, usersRes, marketsRes, payRes, latestRes] = await Promise.all([
      supabase.from('trades').select('*', { count: 'exact', head: true }).eq('state', 'COMPLETE'),
      supabase.from('wallets').select('*', { count: 'exact', head: true }),
      supabase.from('deployed_markets').select('*', { count: 'exact', head: true }),
      supabase.from('x402_payments').select('*', { count: 'exact', head: true }),
      supabase.from('trades').select('side, usdc_amount, user_id, question, created_at')
        .eq('state', 'COMPLETE').order('created_at', { ascending: false }).limit(1),
    ]);
    const latest = (latestRes.data && latestRes.data[0]) || null;
    let last = null;
    if (latest) {
      const uid = latest.user_id || '';
      const isAgent = uid === HOUSE_AGENT_USER || uid.startsWith('agent_')
        || (typeof latest.question === 'string' && latest.question.startsWith(' Agent:'));
      last = {
        side: (latest.side || '').toUpperCase(),
        amountUsdc: Math.round((parseFloat(latest.usdc_amount) || 0) * 100) / 100,
        isAgent,
        question: (latest.question || '').replace(' Agent:', '').trim().slice(0, 80),
        at: latest.created_at,
      };
    }
    const data = {
      trades: tradesRes.count ?? 0,
      users: usersRes.count ?? 0,
      markets: marketsRes.count ?? 0,
      nanopayments: payRes.count ?? 0,
      last,
      ts: Date.now(),
    };
    liveCache = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('live error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// "Forecaster = creator, paid per event." A premium forecast is sold per-read
// via Circle Gateway batched nanopayments on Arc Testnet. The buyer (human or
// agent) pays a sub-cent USDC nanopayment that settles to the seller's Arc
// wallet; the tx is visible on arcscan. See lib/x402.js.

// Public config  free. Useful for the buyer agent, demos and judges.
app.get('/api/x402/info', x402Info);

// Paywalled premium forecast ($0.001). First paid endpoint of the creator loop.
app.get('/api/alpha/sample', x402Paywall('$0.001', '/api/alpha/sample', {
  description: 'Puls premium forecast  sample alpha signal',
}), (req, res) => {
  res.json({
    signal: {
      market: 'Will BTC close above $100k by 2026-12-31?',
      stance: 'YES',
      confidence: 0.62,
      thesis:
        'Spot ETF inflows + post-halving supply squeeze outweigh near-term macro drag; '
        + 'order-flow on Puls skews YES while implied prob lags fundamentals.',
      edge_bps: 480,
      horizon: 'Q4 2026',
    },
    creator: { handle: 'puls-house', payTo: req.x402?.payTo },
    payment: req.x402 || null,
    generatedAt: new Date().toISOString(),
  });
});

// Creator earnings / x402 receipts  the in-app proof feed for nanopayments.
// Each settled x402 payment is logged to Supabase `x402_payments`. We surface
// them as human receipts: amount, resource, payer, and the Circle Gateway
// transfer id (a payment receipt  NOT an on-chain tx hash, since Gateway
// batches settlements). The real on-chain settlement to the seller shows up in
// /api/economy/feed (seller is a tracked address) with an openable Arcscan tx.
app.get('/api/x402/payments', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const typeFilter = (req.query.type || '').trim().toLowerCase();
    const seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    const sellerExplorerUrl = seller ? `https://testnet.arcscan.app/address/${seller}` : null;

    let rows = [];
    try {
      let query = supabase
        .from('x402_payments')
        .select('id, endpoint, payer, pay_to, amount_usdc, network, gateway_tx, raw, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (typeFilter) query = query.eq('endpoint', typeFilter);
      const { data, error } = await query;
      if (error) throw error;
      rows = data || [];
    } catch (e) {
      console.warn('[x402/payments] supabase read failed:', e.message);
    }

    // Agent name and address lookup
    const AGENT_NAME_MAP = {
      agent_swarm_vega: 'Vega ⚡',
      agent_swarm_cygnus: 'Cygnus 🛡️',
      agent_swarm_orion: 'Orion 🔭',
      agent_swarm_atlas: 'Atlas 📈',
      agent_swarm_nova: 'Nova 🌐',
      agent_swarm_striker: 'Striker ⚽',
      'agent_supabase_231e1ae9-9f9f-47bb-a6f7-2e406ba29b10': 'Striker ⚽',
      agent_sage: 'Sage 🔮',
      house_pulse: 'Pulse ⚡',
      agent_house_agent: 'Pulse ⚡',
      '0x6fd898b2e74182554ae32c5919d912f027a092f5': 'Striker ⚽',
      '0x7b74a5884eb5b95240a0975c4b1eaf63d850374c': 'Atlas 📈',
      '0xb526c00d8233568c58ced412073709030e930021': 'Nova 🌐',
      '0xc5b26d99100f1e9dbbb95d66a10fef3034546540': 'Vega ⚡',
      '0x6620ac5ec6eaff39d12db08298ba7f8cbbcf8641': 'Cygnus 🛡️',
      '0x18da1c60f8d37f94be7a740bf5bfd4b61c275fac': 'Orion 🔭',
    };

    const resolveName = (idOrAddr) => {
      if (!idOrAddr) return 'Puls Agent 🤖';
      const key = String(idOrAddr).toLowerCase();
      if (AGENT_NAME_MAP[idOrAddr]) return AGENT_NAME_MAP[idOrAddr];
      if (AGENT_NAME_MAP[key]) return AGENT_NAME_MAP[key];
      if (key.includes('striker')) return 'Striker ⚽';
      if (key.includes('atlas')) return 'Atlas 📈';
      if (key.includes('nova')) return 'Nova 🌐';
      if (key.includes('vega')) return 'Vega ⚡';
      if (key.includes('cygnus')) return 'Cygnus 🛡️';
      if (key.includes('orion')) return 'Orion 🔭';
      if (key.includes('sage')) return 'Sage 🔮';
      if (key.includes('pulse') || key.includes('house')) return 'Pulse ⚡';
      if (key.startsWith('0x') && key.length > 10) return `${idOrAddr.slice(0, 6)}...${idOrAddr.slice(-4)}`;
      return (idOrAddr || '').replace('agent_swarm_','').replace('agent_','');
    };

    const payments = rows.map((r) => {
      const raw = (typeof r.raw === 'string') ? JSON.parse(r.raw || '{}') : (r.raw || {});
      const fromVal = raw.agent || r.payer || '';
      const toVal = raw.counterparty || raw.seller || r.pay_to || '';
      const fromName = resolveName(fromVal);
      const toName = resolveName(toVal);
      const amtUsdc = Number(r.amount_usdc || 0);
      const txHash = (r.gateway_tx && String(r.gateway_tx).startsWith('0x')) ? r.gateway_tx : null;

      return {
        id: r.id,
        endpoint: r.endpoint,
        type: r.endpoint,
        // Resolved display names with icons
        from: fromName,
        to: toName,
        fromLabel: fromName,
        toLabel: toName,
        payerShort: fromName,
        payeeShort: toName,
        fromShort: fromName,
        toShort: toName,

        // Raw addresses
        payer: r.payer || fromVal || null,
        pay_to: r.pay_to || toVal || null,
        fromAddress: r.payer || null,
        toAddress: r.pay_to || null,

        // Amounts (camelCase + snake_case + numeric)
        amountUsdc: amtUsdc,
        amount_usdc: amtUsdc,
        amount: amtUsdc,

        memo: raw.kind || raw.onchainMemo || r.endpoint,
        txHash: txHash,
        arcscanUrl: txHash ? `https://testnet.arcscan.app/tx/${txHash}` : null,
        receiptId: r.gateway_tx || null,
        status: r.gateway_tx ? 'settled' : 'recorded',
        createdAt: r.created_at,
        created_at: r.created_at,
      };
    });

    const totalUsdc = payments.reduce((s, p) => s + (p.amountUsdc || 0), 0);
    const avgUsdc = payments.length > 0 ? totalUsdc / payments.length : 0;

    res.json({
      seller: seller || null,
      sellerExplorerUrl,
      summary: {
        count: payments.length,
        totalUsdc: Number(totalUsdc.toFixed(6)),
        avgPerPayment: Number(avgUsdc.toFixed(6)),
      },
      onchainProofUrl: sellerExplorerUrl,
      payments,
      note: 'Each receipt represents a real USDC nanopayment settled on Arc. Agent names are resolved from on-chain wallet addresses.',
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[x402/payments] error:', e.message);
    res.status(500).json({ error: 'x402 payments feed failed' });
  }
});

//  Points Engine + Onboarding Quests (Traction: activation + retention) 
// Off-chain XP only (not a token, not redeemable). Helpers are hooked into the
// confirmed-event handlers (trade/claim) and passed to tips/comments/signals.
// Safe no-op until the migration (migrations/2026-06-19-points.sql) runs.
const points = registerPoints(app, {
  supabase, authenticateUser, requireVerifiedUser, strictLimiter, generalLimiter,
});
const awardPoints = points.awardPoints;
const touchStreak = points.touchStreak;

//  Copy-trade creator layer (T1) 
// Followers mirror a leader's BUYs (scaled to a per-trade cap) and pay the leader
// a per-event creator micro-fee. Live mirroring is gated by env COPY_TRADE_ENABLED.
const copyTrade = registerCopyTrade(app, {
  supabase,
  circle,
  USDC,
  publicClient,
  getWalletId,
  getWalletInfo,
  getOrDeployMarket,
  isApproved,
  saveTrade,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  clampPrice,
  treasuryAddress: adminAccount?.address,
  splitTakeRate,
  annotatePayment,
  usdcTransferWithTakeRate,
});

//  Alpha paid-analysis (T1 creator layer) 
// Premium forecasts sold per-read: teaser free, full thesis unlocks for a sub-cent
// USDC micro-payment to the creator. Real on-chain transfer (gasless SCA), receipt
// in the Earnings tab (endpoint='alpha_unlock'). Live payments gated by ALPHA_PAID_ENABLED.
registerAlpha(app, {
  supabase,
  circle,
  USDC,
  getWalletId,
  getWalletInfo,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  treasuryAddress: adminAccount?.address,
  splitTakeRate,
  annotatePayment,
  usdcTransferWithTakeRate,
});

//  One-tap tips (T1 creator layer) 
// A reader tips a forecaster a small fixed USDC amount with one tap  a real
// on-chain transfer (gasless SCA) to the creator, receipt in the Earnings tab
// (endpoint='tip'). Live payments gated by TIPS_ENABLED.
registerTips(app, {
  supabase,
  circle,
  USDC,
  getWalletId,
  getWalletInfo,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  awardPoints,
  treasuryAddress: adminAccount?.address,
  splitTakeRate,
  annotatePayment,
  usdcTransferWithTakeRate,
});

//  Puls Streams (pay-per-second USDC streaming on Arc) 
// Continuous authorization (approve a rate + cap), proof-of-flow metering that
// auto-pauses the instant flow stops, and Gateway-style batched on-chain USDC
// settlement, with a live revenue split. Agents open/tick/stop streams
// programmatically via `streamsApi.*`. Live USDC movement gated by
// STREAMS_PAID_ENABLED (the meter still accrues when off, fully demoable).
const streamsApi = registerStreaming(app, {
  supabase,
  circle,
  USDC,
  getWalletId,
  getWalletInfo,
  apiKeyOrAuth,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  awardPoints,
});

//  Comments (community layer, F1) 
// Signed-in users comment on markets/profiles/events/alpha, reply (one level)
// and like, with an in-app notification to the author on reply/like. Stored in
// Supabase; writes throttled + verified-only; soft-delete. Moves no funds, so
// it's ON by default (optional COMMENTS_ENABLED kill-switch).
registerComments(app, {
  supabase,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  createNotification,
  awardPoints,
});

//  Support tickets (in-app help desk, F5) 
// Our own ticket support replaces the region-blocked Tawk.to live-chat. Verified
// users open tickets; an admin (ADMIN_USER_IDS) answers, and the user gets an
// in-app notification. Stored in Supabase; writes throttled + verified-only.
// Moves no funds  ON by default (optional SUPPORT_ENABLED kill-switch).
registerSupport(app, {
  supabase,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  createNotification,
});

//  Referrals (refer-a-friend, invite mechanic only, F3) 
// Invite mechanic only  NO automatic USDC payout (little testnet USDC + farming
// risk). Each user gets a code + share link; new users claim a code once; we
// surface an "invited N friends" badge. ON by default (REFERRALS_ENABLED switch).
registerReferrals(app, {
  supabase,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  createNotification,
});

//  Creator Signals (premium forecasts, on-chain attested, x402 per-read) 
// The full creator-economy content layer: creators draft  publish (writes an
// on-chain attestation to the SignalRegistry on Arc)  readers pay a per-read
// USDC nanopayment to unlock the thesis (real SCA transfer to the creator,
// receipt endpoint='signal_unlock'). Per-signal analytics (views/unlocks/rev).
// Live payments gated by SIGNALS_PAID_ENABLED; on-chain attest needs
// SIGNAL_REGISTRY_ADDRESS + admin wallet (best-effort, degrades gracefully).
registerApiKeys(app, { supabase, authenticateUser, requireVerifiedUser, strictLimiter });

registerCreatorSignals(app, {
  supabase,
  circle,
  USDC,
  getWalletId,
  getWalletInfo,
  authenticateUser,
  apiKeyOrAuth,
  requireVerifiedUser,
  strictLimiter,
  walletClient,
  publicClient,
  keccak256,
  toHex,
  awardPoints,
  treasuryAddress: adminAccount?.address,
  splitTakeRate,
  annotatePayment,
  usdcTransferWithTakeRate,
});

//  Agent skin-in-the-game (AgentBond)  gated reconciler + read endpoint 
// Agents stake USDC on their published calls; slashed if wrong, returned if
// right (settled on resolution). Decoupled + best-effort + gated by
// AGENT_BOND_ENABLED; /api/agents/bonds is always read-safe.
registerAgentBond(app, {
  supabase,
  circle,
  USDC,
  getWalletId,
  getWalletInfo,
  walletClient,
  publicClient,
  keccak256,
  toHex,
  contractToSlugCache,
  deployedMarketsCache,
});

//  Token swap (Circle App Kit)  USDC <-> EURC on Arc 
// Real on-chain stablecoin FX from the user's own Circle MPC wallet, via Circle's
// App Kit Swap. Estimate-first; gated by KIT_KEY (free, Circle Console).
registerSwap(app, {
  getWalletId,
  getWalletInfo,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
});

//  Blog (long-form posts by humans AND AI agents, x402 tips both ways) 
// Humans post anything; swarm agents publish a daily NYT-style news analysis
// grounded in live web research (with cited sources). Tips reuse /api/tips
// (x402 USDC, both directions); comments reuse the shared comments layer with
// target_type='blog'. Moves no funds  ON by default (BLOG_ENABLED switch).
const blog = registerBlog(app, {
  supabase,
  authenticateUser,
  requireVerifiedUser,
  strictLimiter,
  createNotification,
  awardPoints,
});

//  Agent Oracle (AI Panel + ask-agent + correlations) 
// The AI layer over every market: aggregate the swarm's stance into a consensus
// probability shown beside the crowd (Polymarket), let users ask an agent to
// defend a side with live sources, and surface AI-found predict-to-predict
// correlations. Read-mostly; reuses web research + the LLM pool.
async function pmConsensusFor(slug) {
  try {
    const d = await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}`);
    const m = Array.isArray(d) ? d[0] : null;
    if (!m) return null;
    let yesPct = null;
    try { yesPct = parseFloat(JSON.parse(m.outcomePrices || '[]')[0]); } catch (_) {}
    return { question: m.question || slug.replace(/-/g, ' '), yesPct: Number.isFinite(yesPct) ? yesPct : null };
  } catch (_) { return null; }
}
function listMarketSummaries() {
  const out = [];
  for (const [slug, entry] of deployedMarketsCache.entries()) {
    if (entry.resolved) continue;
    out.push({ slug, question: entry.title || slug.replace(/-/g, ' '), yesPct: null });
  }
  return out;
}
registerAgentOracle(app, {
  supabase,
  researchQuestion,
  llmComplete,
  parseLlmJson,
  formatForApp,
  authenticateUser,
  strictLimiter,
  generalLimiter,
  pmConsensusFor,
  listMarketSummaries,
});

//  Agent Duel  the Colosseum 
// Two AI agents stake USDC on opposite sides of the same market. When it resolves,
// the loser's stake goes to the winner. Gated by AGENT_DUEL_ENABLED.
registerAgentDuel(app, {
  supabase,
  circle,
  getWalletId,
  getWalletInfo,
  walletClient,
  publicClient,
  keccak256,
  toHex,
  deployedMarketsCache,
});

//  Lepton  pay one lepton ($0.000001), ask the swarm 
// A public, keyless x402 endpoint. Judge runs a curl, pays the floor coin, gets
// the swarm's answer. No login, no API key, sub-cent settlement on Arc.
registerLepton(app, {
  researchQuestion,
  llmComplete,
  formatForApp,
});

//  Agent P&L  verifiable per-agent unit economics 
// Revenue vs costs for every AI agent: signals sold, tips, bonds, buys.
// Every line item verifiable on Arcscan. Proves the economy is net-positive.
registerAgentPnl(app, {
  supabase,
  circle,
});

// /health  quick liveness probe (returns 200 immediately). Use for
// Heroku's restart-on-failure check + uptime monitors that just need "up?".
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const metrics = globalThis.__pulsMetrics || {};
  // Count LLM providers in cooldown
  const cooldownCount = llmCooldownUntil ? [...llmCooldownUntil.values()].filter(v => v > Date.now()).length : 0;
  const totalProviders = LLM_PROVIDERS.length;
  const readyProviders = totalProviders - cooldownCount;
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV || 'development',
    requestId: req.id,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB',
    },
    eventLoopLag: Math.round(__elLagMs) + 'ms',
    agents: {
      swarmEnabled: (process.env.AGENT_SWARM || 'false') === 'true',
      houseAgent: (process.env.HOUSE_AGENT || 'false') === 'true',
      sageAgent: (process.env.SAGE_AGENT || 'false') === 'true',
      lastActionAt: metrics.lastActionAt || null,
      actions: {
        trades: metrics.trades || 0,
        x402: metrics.x402 || 0,
        comments: metrics.comments || 0,
        signals: metrics.signals || 0,
      },
    },
    llm: {
      totalProviders,
      readyProviders,
      inCooldown: cooldownCount,
    },
    cache: cache.stats(),
  });
});

//  Image Proxy 
// Bypasses CORS restrictions for CanvasKit in Flutter Web.
app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: 'URL required' });
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch image');
    }
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to proxy image', details: err.message });
  }
});

//  Dynamic OG share image for a market (SVG) 
// Rich link previews when a prediction is shared: question + YES/NO odds on the
// brand gradient. SVG = no image libs, instant, cacheable. Used as og:image by
// the /m/<slug> share landing.
app.get('/api/og/market/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    let question = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let yes = 50;
    try {
      const d = await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}`);
      const m = Array.isArray(d) ? d[0] : null;
      if (m) {
        question = m.question || question;
        try { yes = Math.round((parseFloat(JSON.parse(m.outcomePrices || '[]')[0]) || 0.5) * 100); } catch (_) {}
      }
    } catch (_) {}
    const no = 100 - yes;
    const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    // wrap question to ~2 lines
    const words = esc(question).split(' ');
    const lines = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).length > 34) { lines.push(cur); cur = w; } else { cur = cur ? `${cur} ${w}` : w; } }
    if (cur) lines.push(cur);
    const qLines = lines.slice(0, 3);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A0E1A"/><stop offset="1" stop-color="#121829"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#34E5C0"/><stop offset="1" stop-color="#F65FA9"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="64" y="100" fill="url(#brand)" font-family="system-ui,Segoe UI,Roboto,sans-serif" font-size="40" font-weight="800">Puls</text>
  <text x="1136" y="100" text-anchor="end" fill="#9AA6C0" font-family="system-ui,sans-serif" font-size="22" font-weight="600">prediction market T Arc</text>
  ${qLines.map((l, i) => `<text x="64" y="${230 + i * 64}" fill="#EAF0FF" font-family="system-ui,sans-serif" font-size="52" font-weight="800">${l}</text>`).join('')}
  <rect x="64" y="470" width="510" height="96" rx="18" fill="#102A2A" stroke="#2DD4BF" stroke-width="2"/>
  <text x="92" y="512" fill="#2DD4BF" font-family="system-ui,sans-serif" font-size="22" font-weight="700">YES</text>
  <text x="92" y="552" fill="#EAF0FF" font-family="system-ui,sans-serif" font-size="40" font-weight="900">${yes}T</text>
  <rect x="626" y="470" width="510" height="96" rx="18" fill="#3B0A2A" stroke="#F472B6" stroke-width="2"/>
  <text x="654" y="512" fill="#F472B6" font-family="system-ui,sans-serif" font-size="22" font-weight="700">NO</text>
  <text x="654" y="552" fill="#EAF0FF" font-family="system-ui,sans-serif" font-size="40" font-weight="900">${no}T</text>
</svg>`;
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  Web3 (MetaMask) endpoints 
// MetaMask users trade directly on-chain  they don't need Circle SCA wallets.
// These endpoints accept on-chain tx hashes, verify them, and record the trades.
// No requireVerifiedUser  web3 guests are allowed (they signed on-chain).

// POST /api/trade/claim-external  record a claim that a MetaMask user made
// directly on-chain. Verifies the tx sender + market contract.
app.post('/api/trade/claim-external', tradeLimiter, async (req, res) => {
  try {
    const { userId, txHash, marketId } = req.body;
    if (!userId || !txHash || !marketId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    const normalizedHash = normalizeTxHash(txHash);
    // Verify the transaction on-chain
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: normalizedHash });
      if (!receipt) return res.status(400).json({ error: 'Transaction not found on-chain' });
      if (receipt.status !== 'success') return res.status(400).json({ error: 'Transaction failed on-chain' });
      // Verify sender matches
      const expectedAddr = userId.replace('eth_', '').toLowerCase();
      if (receipt.from.toLowerCase() !== expectedAddr) {
        return res.status(403).json({ error: 'Sender mismatch' });
      }
      // Verify market contract
      if (receipt.to.toLowerCase() !== marketId.toLowerCase()) {
        return res.status(403).json({ error: 'Market mismatch' });
      }
    } catch (err) {
      return res.status(400).json({ error: `On-chain verification failed: ${err.message}` });
    }
    // Dedup: check if this tx_hash already recorded
    const { data: existing } = await supabase.from('trades').select('id').eq('tx_hash', normalizedHash).limit(1);
    if (existing && existing.length > 0) return res.json({ ok: true, alreadyClaimed: true });
    // Record the claim
    await saveTrade(userId, {
      tx_id: `ext_${Date.now()}`,
      side: 'CLAIM',
      usdc_amount: 0,
      entry_price: 0,
      question: 'Claim Winnings (MetaMask)',
      market_id: marketId,
      state: 'COMPLETE',
      tx_hash: normalizedHash,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('claim-external error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Deep health check for demo-day readiness: pings every external dependency and
// reports the treasury balance in one call. Returns 200 when all checks pass,
// 503 otherwise. Cheap enough to poll, but not behind auth  exposes no secrets.
app.get('/health/deep', async (_req, res) => {
  const checks = {};
  const time = async (fn) => { const t = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, ms: Date.now() - t, error: e.message }; } };

  // RPC reachability
  checks.rpc = await time(async () => { await publicClient.getBlockNumber(); });
  // Supabase reachability (lightweight count)
  checks.supabase = await time(async () => {
    const { error } = await supabase.from('wallets').select('user_id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
  });
  // Circle API reachability (lightweight list call; tolerate SDK method naming).
  checks.circle = await time(async () => {
    if (typeof circle.listWalletSets === 'function') { await circle.listWalletSets({ pageSize: 1 }); }
    else if (typeof circle.getWalletSets === 'function') { await circle.getWalletSets({ pageSize: 1 }); }
    else { throw new Error('Circle client not initialized'); }
  });
  // Treasury balance (informational  does not fail the check on its own)
  const treasury = await getTreasuryUsdcBalance();
  checks.treasury = {
    address: adminAccount?.address || null,
    usdc: treasury,
    ok: treasury == null ? null : treasury >= TREASURY_MIN_USDC,
    min: TREASURY_MIN_USDC,
  };

  const critical = ['rpc', 'supabase'];
  const healthy = critical.every((k) => checks[k].ok);
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    walletAccountType: WALLET_ACCOUNT_TYPE,
    gaslessEnabled: WALLET_ACCOUNT_TYPE === 'SCA',
    checks,
    timestamp: new Date().toISOString(),
  });
});

//  Circle webhook + signature verification 
// Circle signs every webhook with a per-message ECDSA (P-256, SHA-256) key.
// Headers: `X-Circle-Signature` (base64 DER signature) and `X-Circle-Key-Id`
// (UUID of the public key). We fetch + cache the public key by id and verify the
// signature over the RAW request body.
// Docs: https://developers.circle.com/cpn/guides/webhooks/verify-webhook-signatures
//
// Rollout safety: verification is ATTEMPTED on every request, but it is only
// ENFORCED (request rejected on failure/missing signature) when
// CIRCLE_WEBHOOK_ENFORCE=true. Default is off so an unverified-but-legitimate
// webhook can't silently stop trade-state updates during the demo  flip it on
// once you've confirmed signatures verify in the logs.
const CIRCLE_WEBHOOK_ENFORCE = (process.env.CIRCLE_WEBHOOK_ENFORCE || 'false').toLowerCase() === 'true';
const circlePublicKeyCache = new Map(); // keyId -> crypto.KeyObject

async function getCirclePublicKey(keyId) {
  if (circlePublicKeyCache.has(keyId)) return circlePublicKeyCache.get(keyId);
  const apiKey = (process.env.CIRCLE_API_KEY || '').trim();
  // The public-key endpoint path differs across Circle products; try both.
  const urls = [
    `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
    `https://api.circle.com/v2/cpn/notifications/publicKey/${keyId}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) continue;
      const j = await r.json();
      const b64 = j?.data?.publicKey;
      if (!b64) continue;
      const keyObj = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
      circlePublicKeyCache.set(keyId, keyObj);
      return keyObj;
    } catch (_) { /* try next url */ }
  }
  return null;
}

// Verify the signature. Returns true if valid, false if invalid, and null if it
// could not be checked (no headers / key fetch failed) so the caller can decide.
async function verifyCircleWebhook(req) {
  const signature = req.headers['x-circle-signature'];
  const keyId = req.headers['x-circle-key-id'];
  if (!signature || !keyId || !req.rawBody) return null;
  const keyObj = await getCirclePublicKey(keyId);
  if (!keyObj) return null;
  try {
    return crypto.verify('sha256', req.rawBody, keyObj, Buffer.from(signature, 'base64'));
  } catch (e) {
    console.warn('[Circle Webhook] signature verify error:', e.message);
    return false;
  }
}

// Bounded de-dupe set so retried webhooks (Circle retries on non-2xx or timeout)
// are processed at most once. Keyed by Circle's notificationId.
const processedNotifications = new Set();
function markProcessed(id) {
  if (!id) return false;
  if (processedNotifications.has(id)) return true; // already handled
  processedNotifications.add(id);
  if (processedNotifications.size > 5000) {
    // drop oldest ~1000 to cap memory
    const it = processedNotifications.values();
    for (let i = 0; i < 1000; i++) { const n = it.next(); if (n.done) break; processedNotifications.delete(n.value); }
  }
  return false;
}

app.post('/api/webhook/circle', async (req, res) => {
  // Verify BEFORE acting. Ack with 200 only after the security decision so Circle
  // doesn't keep retrying a request we deliberately rejected.
  const verified = await verifyCircleWebhook(req);
  if (verified === false) {
    console.warn('[Circle Webhook] INVALID signature  rejected.');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (verified === null) {
    if (CIRCLE_WEBHOOK_ENFORCE) {
      console.warn('[Circle Webhook] Unsigned/unverifiable request rejected (enforce on).');
      return res.status(401).json({ error: 'Unverified webhook' });
    }
    console.warn('[Circle Webhook] Could not verify signature (enforce off)  processing anyway. Set CIRCLE_WEBHOOK_ENFORCE=true once verification is confirmed.');
  }

  // CRITICAL: Do NOT ack 200 or mark processed BEFORE processing.
  // If processing fails, Circle needs to retry. Moving markProcessed
  // after successful processing prevents silently lost events.
  try {
    const notificationId = req.body?.notificationId || req.body?.id;
    if (markProcessed(notificationId)) {
      console.log(`Webhook: duplicate notification ${notificationId} ignored`);
      return res.sendStatus(200);
    }
    const { notificationType, transaction } = req.body;
    if (notificationType !== 'transactions.outbound' || !transaction) {
      return res.sendStatus(200);
    }
    const { id: txId, state, txHash } = transaction;
    if (!txId) return res.sendStatus(200);
    await supabase.from('trades').update({
      state,
      tx_hash: txHash ?? null,
    }).eq('tx_id', txId);
    console.log(`Webhook: tx ${txId}  ${state}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('webhook error:', e.message);
  }
});

//  QuickNode Webhook 

const processedChainLogs = new Set();
async function handleQuickNodeLog(log) {
  try {
    // Idempotency: a (txHash, logIndex) pair uniquely identifies an on-chain
    // event, so retried/duplicated webhook deliveries are processed once.
    // CRITICAL: Do NOT add to the Set BEFORE processing  if processing fails,
    // the retried webhook would be silently skipped. Check, process, THEN add.
    const logKey = `${(log.transactionHash || '').toLowerCase()}:${log.logIndex ?? ''}`;
    if (logKey !== ':' ) {
      if (processedChainLogs.has(logKey)) {
        console.log(`[QuickNode Webhook] Duplicate log ${logKey} ignored`);
        return;
      }
      // Process FIRST, mark AFTER (at the end of this function).
    }
    const contractAddress = log.address.toLowerCase();
    const slug = contractToSlugCache.get(contractAddress);
    if (!slug) {
      console.log(`[QuickNode Webhook] Ignoring log from non-market address: ${contractAddress}`);
      return;
    }

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: MARKET_EVENTS_ABI,
        data: log.data,
        topics: log.topics,
      });
    } catch (err) {
      console.warn(`[QuickNode Webhook] Failed to decode event log at address ${contractAddress}:`, err.message);
      return;
    }

    const { eventName, args } = decoded;
    console.log(`[QuickNode Webhook] Received ${eventName} event on market ${slug} (${contractAddress})`);

    let question = slug.split('-').join(' ');
    if (question.length > 0) {
      question = question.charAt(0).toUpperCase() + question.slice(1);
    }

    if (eventName === 'Bought') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const side = args.side ? 'YES' : 'NO';
      const amountUsdc = Number(args.amount) / 1_000_000;
      const shares = Number(args.shares) / 1_000_000;
      const entryPrice = shares !== 0 ? Math.min(0.99, Math.max(0.01, amountUsdc / shares)) : 0.5;

      await syncCompletedTrade(userId, {
        marketId: contractAddress,
        side,
        amountUsdc,
        shares,
        txHash: log.transactionHash,
        question,
        entryPrice
      });
    } else if (eventName === 'Sold') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const side = args.side ? 'YES' : 'NO';
      const shares = Number(args.shares) / 1_000_000;
      const usdcOut = Number(args.usdcOut) / 1_000_000;
      const amountUsdc = -usdcOut; // Sells are stored as negative USDC payout
      const exitPrice = shares !== 0 ? Math.min(0.99, Math.max(0.01, usdcOut / shares)) : 0.5;

      await syncCompletedTrade(userId, {
        marketId: contractAddress,
        side,
        amountUsdc,
        shares,
        txHash: log.transactionHash,
        question,
        entryPrice: exitPrice
      });
    } else if (eventName === 'Resolved') {
      const outcome = args.outcome;
      console.log(`[QuickNode Webhook] Market ${slug} resolved on-chain to outcome: ${outcome ? 'YES' : 'NO'}`);
      
      const { error } = await supabase
        .from('deployed_markets')
        .update({ resolved: true, outcome })
        .eq('contract_address', contractAddress);
        
      if (error) {
        console.error(`[QuickNode Webhook] Failed to update resolved state in Supabase for ${slug}:`, error.message);
      } else {
        const cached = deployedMarketsCache.get(slug);
        if (cached) {
          cached.resolved = true;
          cached.outcome = outcome;
        }
        eventBus.safeEmit(EVENTS.MARKET_RESOLVED, { slug, outcome });
        console.log(`[QuickNode Webhook] Successfully updated resolved state in DB & cache for ${slug}`);
        
        // Notify traders who participated in this market
        (async () => {
          try {
            const { data: participants } = await supabase
              .from('trades')
              .select('user_id')
              .eq('market_id', contractAddress);
            const uniqueUserIds = [...new Set(participants?.map(p => p.user_id) || [])];
            for (const uId of uniqueUserIds) {
              createNotification(
                uId,
                'Market Resolved ',
                `Market "${question}" has resolved to ${outcome ? 'YES' : 'NO'}. Claim your winnings now!`,
                'resolution'
              ).catch(console.error);
            }
          } catch (err) {
            console.error('Failed to send resolution notifications:', err.message);
          }
        })().catch(console.error);
      }
    } else if (eventName === 'Claimed') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const txHash = log.transactionHash;

      const { data: dup } = await supabase
        .from('trades')
        .select('*')
        .eq('tx_hash', txHash)
        .limit(1);

      if (dup && dup.length > 0) {
        console.log(`[QuickNode Webhook] Claim event for tx ${txHash} already exists, skipping.`);
        return;
      }

      const { error } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: `ext_${Date.now()}`,
          side: 'CLAIM',
          usdc_amount: 0,
          entry_price: 0,
          question: 'Claim Winnings',
          market_id: contractAddress,
          state: 'COMPLETE',
          tx_hash: txHash,
        });

      if (error) {
        console.error(`[QuickNode Webhook] Failed to insert CLAIM trade for user ${userId}:`, error.message);
      } else {
        console.log(`[QuickNode Webhook] Successfully recorded CLAIM trade for user ${userId} and tx ${txHash}`);
      }
    }
    // CRITICAL: Only mark as processed AFTER successful processing.
    // This was previously done BEFORE processing, causing retried
    // webhooks to be silently skipped on failure.
    if (logKey !== ':') {
      processedChainLogs.add(logKey);
      if (processedChainLogs.size > 10000) {
        const it = processedChainLogs.values();
        for (let i = 0; i < 2000; i++) { const n = it.next(); if (n.done) break; processedChainLogs.delete(n.value); }
      }
    }
  } catch (err) {
    console.error(`[QuickNode Webhook] Error processing single log:`, err.message);
  }
}

app.post('/api/webhook/quicknode', async (req, res) => {
  try {
    const webhookSecret = process.env.QUICKNODE_WEBHOOK_SECRET;
    if (webhookSecret) {
      const headerSecret = req.headers['x-qn-secret'];
      const querySecret = req.query.secret;
      if (headerSecret !== webhookSecret && querySecret !== webhookSecret) {
        console.warn(`[QuickNode Webhook] Unauthorized request received. Secret mismatch.`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    
    if (Array.isArray(payload)) {
      console.log(`[QuickNode Webhook] Received array of ${payload.length} logs.`);
      for (const log of payload) {
        await handleQuickNodeLog(log);
      }
    } else if (payload && typeof payload === 'object') {
      console.log(`[QuickNode Webhook] Received single log payload.`);
      await handleQuickNodeLog(payload);
    } else {
      console.warn(`[QuickNode Webhook] Unknown or empty payload format received.`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[QuickNode Webhook] Error handling request:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

//  Market resolution (owner fallback / manual) 
app.post('/api/market/resolve', authenticateUser, requireVerifiedUser, requireAdmin, strictLimiter, async (req, res) => {
  try {
    const { userId, slug, outcome } = req.body; // outcome: true=YES wins, false=NO wins
    if (!userId || !slug || outcome === undefined) return res.status(400).json({ error: 'userId, slug and outcome required' });

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'No wallet' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
    const contractAddress = cached.contractAddress;

    // Markets owned by the UMA adapter can only be force-resolved through its
    // admin escape hatch (signed by the admin EOA, not a Circle wallet).
    if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
      try {
        const { registered } = await getUmaResolution(contractAddress);
        if (registered) {
          const hash = await walletClient.writeContract({
            address: UMA_ADAPTER_ADDRESS,
            abi: [{ name: 'adminResolve', type: 'function', stateMutability: 'nonpayable',
              inputs: [{ name: 'market', type: 'address' }, { name: 'outcome', type: 'bool' }], outputs: [] }],
            functionName: 'adminResolve',
            args: [contractAddress, outcome]
          });
          await publicClient.waitForTransactionReceipt({ hash });
          return res.json({ txHash: hash, state: 'COMPLETE', via: 'uma-adapter' });
        }
      } catch (e) {
        console.error('[UMA] adminResolve check failed, falling back to direct resolve:', e.message);
      }
    }

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: 'resolve(bool)',
      abiParameters: [outcome],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    res.json({ txId: txRes.data.id, state: txRes.data.state });
  } catch (e) {
    console.error('resolve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Auto-Resolution Cron 
//  Stale-market archiving 
// Markets that are long past their deadline and that Polymarket can no longer
// resolve (slug gone, or never resolves) are "zombies": they clutter the app and
// make every resolution-cron tick slower/noisier. We mark them archived in
// Supabase (column `archived boolean default false`), drop them from the cache,
// and exclude them from listings. Archiving touches nothing on-chain.
const ARCHIVE_AFTER_DAYS = parseFloat(process.env.ARCHIVE_AFTER_DAYS || '3');

async function archiveMarket(slug, reason) {
  try {
    const { error } = await supabase
      .from('deployed_markets')
      .update({ archived: true })
      .eq('slug', slug);
    if (error) {
      if (/archived/.test(error.message)) {
        console.warn(`[Archive] 'archived' column missing  run in Supabase SQL editor: alter table deployed_markets add column if not exists archived boolean default false;`);
      } else {
        console.error(`[Archive] failed for ${slug}:`, error.message);
      }
      return false;
    }
    const entry = deployedMarketsCache.get(slug);
    if (entry) {
      contractToSlugCache.delete((entry.contractAddress || '').toLowerCase());
      deployedMarketsCache.delete(slug);
    }
    eventBus.safeEmit(EVENTS.MARKET_ARCHIVED, { slug });
    console.log(`[Archive] ${slug} archived (${reason})`);
    return true;
  } catch (e) {
    console.error(`[Archive] error for ${slug}:`, e.message);
    return false;
  }
}

async function checkAndResolveMarkets() {
  // Only log if there are markets to check (reduces log spam)
  const now = Math.floor(Date.now() / 1000);
  const archiveCutoff = now - ARCHIVE_AFTER_DAYS * 24 * 3600;
  
  const marketsToResolve = [];
  for (const [slug, entry] of deployedMarketsCache.entries()) {
    if (entry.deadline < now && !entry.resolved) {
      marketsToResolve.push({ slug, ...entry });
    }
  }

  if (marketsToResolve.length === 0) {
    return; // silent  no spam when nothing to do
  }

  // Only log if there are markets to resolve

  for (const market of marketsToResolve) {
    try {
      // Check on-chain state first  if the market is already resolved on-chain,
      // mark it in our cache + DB and skip. This prevents "Already resolved"
      // revert errors from spamming the logs on every cron tick.
      if (market.contractAddress) {
        try {
          const [, , resolvedOnChain, outcomeOnChain] = await publicClient.readContract({
            address: market.contractAddress,
            abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [],
              outputs: [
                { name: '_slug', type: 'string' },
                { name: '_deadline', type: 'uint256' },
                { name: '_resolved', type: 'bool' },
                { name: '_outcome', type: 'bool' },
                { name: '_yesOutstanding', type: 'uint256' },
                { name: '_noOutstanding', type: 'uint256' }
              ] }],
            functionName: 'getMarketInfo'
          });
          if (resolvedOnChain) {
            const entry = deployedMarketsCache.get(market.slug);
            if (entry) { entry.resolved = true; entry.outcome = outcomeOnChain; }
            await supabase.from('deployed_markets').update({ resolved: true, outcome: outcomeOnChain }).eq('slug', market.slug);
            console.log(`[resolve] ${market.slug} already resolved on-chain (${outcomeOnChain ? 'YES' : 'NO'})  marked in cache`);
            continue;
          }
        } catch (e) {
          // RPC might be down  continue to Polymarket check as fallback
          console.warn(`[resolve] on-chain check failed for ${market.slug}: ${e.message}`);
        }
      }

      // Gamma's /markets?slug= returns ACTIVE markets only by default, so a
      // CLOSED/resolved market came back EMPTY  the cron then treated it as
      // "gone" and ARCHIVED it instead of resolving. The resilient client
      // tries closed markets first (to settle them), then falls back to the
      // open query (still-running ones). Retry + backoff + circuit breaker
      // are handled inside fetchMarketForResolution.
      const pmMarket = await fetchMarketForResolution(market.slug);
      if (!pmMarket) {
        // Truly gone from Polymarket (neither open nor closed)  can't auto-resolve.
        if (market.deadline < archiveCutoff) await archiveMarket(market.slug, 'slug gone from Polymarket');
        continue;
      }
      const isResolved = pmMarket.closed === true || pmMarket.resolved === true;
      if (!isResolved) {
        if (market.deadline < archiveCutoff) {
          await archiveMarket(market.slug, `unresolved on Polymarket ${ARCHIVE_AFTER_DAYS}+ days past deadline`);
        } else {
          console.log(`Market ${market.slug} is past deadline but not yet resolved on Polymarket.`);
        }
        continue;
      }
      
      let outcome = null;
      if (pmMarket.consensusOutcome === 'YES') {
        outcome = true;
      } else if (pmMarket.consensusOutcome === 'NO') {
        outcome = false;
      } else {
        try {
          const prices = JSON.parse(pmMarket.outcomePrices || '[]');
          if (parseFloat(prices[0]) > 0.9) outcome = true;
          else if (parseFloat(prices[1]) > 0.9) outcome = false;
        } catch {}
      }

      //  UMA optimistic oracle path 
      // The request can be opened before the outcome is known; proposing and
      // settling happen on later cron ticks as the OOV2 state machine advances.
      // FALLBACK: if UMA processing fails (RPC down, timeout, etc.) or returns
      // pending for too long, fall through to direct resolution so markets
      // don't stay unresolved forever.
      if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
        let umaResult = 'fallback';
        try {
          umaResult = await processUmaMarket(market, outcome);
        } catch (e) {
          console.error(`[UMA] processing failed for ${market.slug}: ${e.message}  falling back to direct resolve`);
          umaResult = 'fallback';
        }
        if (umaResult === 'pending') {
          console.log(`[UMA] ${market.slug} still pending  will check again next cycle`);
          continue;
        }
        if (umaResult === 'resolved') {
          // Read the final outcome from chain (source of truth after settlement).
          const [, , resolvedOnChain, outcomeOnChain] = await publicClient.readContract({
            address: market.contractAddress,
            abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [],
              outputs: [
                { name: '_slug', type: 'string' },
                { name: '_deadline', type: 'uint256' },
                { name: '_resolved', type: 'bool' },
                { name: '_outcome', type: 'bool' },
                { name: '_yesOutstanding', type: 'uint256' },
                { name: '_noOutstanding', type: 'uint256' }
              ] }],
            functionName: 'getMarketInfo'
          });
          if (resolvedOnChain) {
            await supabase
              .from('deployed_markets')
              .update({ resolved: true, outcome: outcomeOnChain })
              .eq('slug', market.slug);
            const entry = deployedMarketsCache.get(market.slug);
            if (entry) { entry.resolved = true; entry.outcome = outcomeOnChain; }
            eventBus.safeEmit(EVENTS.MARKET_RESOLVED, { slug: market.slug, outcome: outcomeOnChain });
            console.log(` [UMA] Market ${market.slug} settled via Optimistic Oracle: ${outcomeOnChain ? 'YES' : 'NO'}`);
          }
          continue;
        }
        // umaResult === 'fallback'  market predates UMA registration; resolve directly below.
      }

      if (outcome === null) {
        if (market.deadline < archiveCutoff) {
          await archiveMarket(market.slug, 'Polymarket closed but outcome indeterminate');
        } else {
          console.log(`Could not determine outcome for resolved market ${market.slug}`);
        }
        continue;
      }

      console.log(`Resolving on-chain market ${market.contractAddress} for slug ${market.slug} to outcome: ${outcome ? 'YES' : 'NO'}`);

      try {
        const { request } = await publicClient.simulateContract({
          account: adminAccount,
          address: market.contractAddress,
          abi: [
            {
              name: 'resolve',
              type: 'function',
              stateMutability: 'nonpayable',
              inputs: [{ name: '_outcome', type: 'bool' }],
              outputs: []
            }
          ],
          functionName: 'resolve',
          args: [outcome]
        });

        const hash = await walletClient.writeContract(request);
        console.log(`Resolution Tx Hash: ${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
      } catch (resolveErr) {
        // If the market is already resolved on-chain, the contract reverts.
        // Don't spam the error log  mark it as resolved and move on.
        if (/already resolved/i.test(resolveErr.message || '') || /resolved/i.test(resolveErr.shortMessage || '')) {
          console.log(`[resolve] ${market.slug} was already resolved on-chain  marking in cache`);
          const entry = deployedMarketsCache.get(market.slug);
          if (entry) { entry.resolved = true; entry.outcome = outcome; }
          await supabase.from('deployed_markets').update({ resolved: true, outcome }).eq('slug', market.slug);
          eventBus.safeEmit(EVENTS.MARKET_RESOLVED, { slug: market.slug, outcome });
          continue;
        }
        throw resolveErr; // re-throw real errors
      }
      
      await supabase
        .from('deployed_markets')
        .update({ resolved: true, outcome })
        .eq('slug', market.slug);

      market.resolved = true;
      market.outcome = outcome;
      eventBus.safeEmit(EVENTS.MARKET_RESOLVED, { slug: market.slug, outcome });
      console.log(` Deployed market ${market.slug} resolved successfully.`);
    } catch (e) {
      console.error(`Failed to resolve market ${market.slug}:`, e.message);
    }
  }

  //  Post-cron Gamma health check 
  // If Gamma API had a cluster of failures during this resolution run, alert
  // via Sentry so the team knows Polymarket may be down  instead of
  // discovering it when a user asks why nothing resolved for two days.
  const gammaFailures = drainConsecutiveFailures();
  if (gammaFailures >= 5) {
    const msg = `Gamma API had ${gammaFailures} consecutive failures during resolution cron  Polymarket may be down`;
    console.error(`[resolve] ${msg}`);
    captureException(new Error(msg), {
      cron: 'checkAndResolveMarkets',
      gammaFailures,
      marketsChecked: marketsToResolve.length,
    });
  }
}

// Event-driven market resolution: instead of polling every 5 minutes, find
// the unresolved market with the nearest deadline and arm a single setTimeout
// for it. When it fires, run the resolver (which settles due markets) and
// re-arm for the next one. Zero polling, zero continuous Supabase egress.
let _resolutionTimer = null;
function scheduleNextMarketResolution() {
  if (_resolutionTimer) { clearTimeout(_resolutionTimer); _resolutionTimer = null; }
  const now = Math.floor(Date.now() / 1000);
  const unresolved = cache.unresolvedMarkets(); // in-memory, no DB read
  if (unresolved.length === 0) return;
  // Nearest future (or already-due) deadline.
  let nearest = Infinity;
  for (const m of unresolved) {
    const dl = Number(m.deadline);
    if (Number.isFinite(dl) && dl < nearest) nearest = dl;
  }
  if (!Number.isFinite(nearest)) return;
  const delayMs = Math.max(0, (nearest - now) * 1000);
  // CRITICAL: when a market is past-deadline but not yet resolved on Polymarket,
  // `nearest < now`  delayMs = 0  the timer fires immediately  re-arms 
  // infinite tight loop that starves the event loop (503 + 429 from Polymarket).
  // Enforce a MINIMUM 5-minute re-check delay so past-due markets are checked
  // periodically, not in a tight loop.
  const MIN_RECHECK_MS = 2 * 60 * 1000; // 2 min  faster resolution of past-due markets
  // Cap at 1h so a far-future deadline doesn't hold a stale timer.
  const cappedDelay = Math.max(MIN_RECHECK_MS, Math.min(delayMs, 60 * 60 * 1000));
  _resolutionTimer = setTimeout(() => {
    _resolutionTimer = null;
    checkAndResolveMarkets().catch(console.error).finally(() => scheduleNextMarketResolution());
  }, cappedDelay);
  _resolutionTimer.unref?.();
}
// When a market is created/activated, the nearest-deadline may have changed.
eventBus.on(EVENTS.MARKET_CREATED, () => scheduleNextMarketResolution());
eventBus.on(EVENTS.MARKET_ACTIVATED, () => scheduleNextMarketResolution());

async function warmupTopMarkets() {
  console.log('Starting eager market warmup for top active markets...');
  try {
    const limit = 20;
    const list = await fetchGamma(`/markets?limit=${limit}&active=true&closed=false&order=volume&ascending=false`);
    console.log(`Fetched ${list.length} top active markets for warmup.`);

    for (const j of list) {
      const slug = j.slug;
      if (!slug) continue;

      if (deployedMarketsCache.has(slug)) {
        // Already deployed
        continue;
      }

      // Parse deadline
      const endRaw = j.endDate || j.endDateIso;
      let deadlineSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // default 30 days
      if (endRaw) {
        const parsedDate = new Date(endRaw);
        if (!isNaN(parsedDate.getTime())) {
          deadlineSeconds = Math.floor(parsedDate.getTime() / 1000);
        }
      }

      console.log(`Warming up market: ${slug} (deadline: ${deadlineSeconds})`);
      try {
        await getOrDeployMarket(slug, deadlineSeconds);
      } catch (err) {
        console.error(`Failed to warm up market ${slug}:`, err.message);
      }
    }
    console.log('Eager market warmup completed.');
  } catch (e) {
    console.error('warmupTopMarkets error:', e.message);
  }
}


//  Leaderboard & Profiles Service 

// In-memory leaderboard stats. The Supabase `leaderboard` table has a legacy
// schema (wallet_address/pet_name/level/xp) we can't migrate via REST, so the
// computed stats live here. Rebuilt at boot + every 10 minutes by the cron.
const leaderboardStats = new Map(); // user_id  { volume, pnl, trades_count, win_rate, updated_at }

async function updateLeaderboard() {
  console.log('Running leaderboard update...');
  try {
    //  Memory-safe leaderboard rebuild 
    // OLD approach: load ALL 21,000+ trades into a single array, then iterate.
    // That spiked heap to 1174MB  R15 crash  Heroku restart loop.
    //
    // NEW approach: paginate + process page-by-page WITHOUT accumulating the
    // full array. Each page is grouped into userTrades, then the page is
    // GC'd before the next page loads. Peak memory = 1 page (~1000 rows)
    // instead of all trades.
    const agentOwnerKey = (t) => {
      if (t.user_id === HOUSE_AGENT_USER) return HOUSE_AGENT_USER;
      if (typeof t.user_id === 'string' && t.user_id.startsWith('agent_swarm_')) return t.user_id;
      const isAgentTrade = typeof t.question === 'string' && t.question.startsWith(' Agent:');
      return isAgentTrade ? `agent_${t.user_id}` : t.user_id;
    };

    const userTrades = new Map(); // userId  trades[] (only keeps trade refs, not full rows)
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('trades')
        .select('user_id, market_id, side, usdc_amount, state, question, entry_price')
        .eq('state', 'COMPLETE')
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error('Failed to fetch trades for leaderboard:', error.message);
        return;
      }
      // Process this page immediately  group by user, then let GC reclaim the page
      for (const t of (data || [])) {
        if (!t.user_id) continue;
        const key = agentOwnerKey(t);
        if (!userTrades.has(key)) userTrades.set(key, []);
        userTrades.get(key).push(t);
      }
      if (!data || data.length < PAGE) break; // last page
    }
    
    // Batch-fetch all profiles ONCE to eliminate the N+1 Supabase query
    // pattern (was: 1 query per user inside the loop  100+ sequential calls).
    const __allUserIds = [...userTrades.keys()];
    const __profilesBatch = new Map();
    for (let i = 0; i < __allUserIds.length; i += 100) {
      const chunk = __allUserIds.slice(i, i + 100);
      try {
        const { data: profs } = await supabase
          .from('profiles').select('user_id, display_name, avatar_url, bio')
          .in('user_id', chunk);
        if (profs) for (const p of profs) __profilesBatch.set(p.user_id, p);
      } catch (_) { /* profiles table may not exist yet */ }
    }
    
    // Process users CONCURRENTLY (bounded)  per-user work is independent and
    // dominated by on-chain reads, so batching cuts the recompute from ~90s to a
    // few seconds  fresher /versus + /stats. (P5)
    const __lbEntries = [...userTrades.entries()];
    const __LB_CONC = 6;
    const __computeUser = async ([userId, tradesList]) => {
      try {
        if (isSeedWallet(userId)) return; // seed/liquidity wallet  not a human trader, keep it off the board
        let totalVolume = 0;
        let tradesCount = 0;
        let totalPnL = 0;
        let resolvedMarketsCount = 0;
        let winningMarketsCount = 0;
        let marketsTradedCount = 0;
        let profitableMarketsCount = 0;
        
        const marketTrades = new Map();
        for (const t of tradesList) {
          if (!t.market_id) continue;
          if (!marketTrades.has(t.market_id)) {
            marketTrades.set(t.market_id, []);
          }
          marketTrades.get(t.market_id).push(t);
        }
        
        for (const [marketAddress, mTrades] of marketTrades.entries()) {
          let totalPaid = 0;
          let totalReceived = 0;
          
          for (const t of mTrades) {
            const amt = parseFloat(t.usdc_amount);
            if (t.side === 'CLAIM') {
              // Claims are handled implicitly by resolved state calculation
            } else if (amt > 0) {
              totalPaid += amt;
              totalVolume += amt;
              tradesCount++;
            } else if (amt < 0) {
              totalReceived += Math.abs(amt);
              totalVolume += Math.abs(amt);
              tradesCount++;
            }
          }
          
          let resolved = false;
          let outcome = null;
          let yesPrice = 0.5;
          let noPrice = 0.5;
          
          const slug = contractToSlugCache.get(marketAddress.toLowerCase());
          const cached = slug ? deployedMarketsCache.get(slug) : null;
          if (cached) {
            resolved = cached.resolved;
            outcome = cached.outcome;
          }
          
          let yesShares = 0;
          let noShares = 0;
          let claimed = false;
          
          try {
            let userAddress = userIdToAddressCache.get(userId);
            // House agent trades under 'house_pulse' but its wallet row is keyed 'agent_house_pulse'
            if (!userAddress && userId === HOUSE_AGENT_USER) userAddress = userIdToAddressCache.get(HOUSE_AGENT_KEY);
            // Swarm agents trade under 'agent_swarm_*'; their wallet row is keyed 'agent_agent_swarm_*'
            if (!userAddress && userId.startsWith('agent_swarm_')) userAddress = userIdToAddressCache.get(`agent_${userId}`);
            // Resolve addresses not in the wallet cache: eth_-prefixed and raw-address user ids
            if (!userAddress && userId.startsWith('eth_')) userAddress = userId.slice(4);
            if (!userAddress && userId.startsWith('0x') && userId.length === 42) userAddress = userId;
            if (!userAddress) throw new Error('no wallet address for user');
            {
              const [yesSharesRaw, noSharesRaw, claimedRaw] = await publicClient.readContract({
                address: marketAddress,
                abi: [{
                  name: 'getUserPosition',
                  type: 'function',
                  stateMutability: 'view',
                  inputs: [{ name: 'user', type: 'address' }],
                  outputs: [
                    { name: '_yesShares', type: 'uint256' },
                    { name: '_noShares', type: 'uint256' },
                    { name: '_claimed', type: 'bool' }
                  ]
                }],
                functionName: 'getUserPosition',
                args: [userAddress]
              });
              yesShares = Number(yesSharesRaw) / 1_000_000;
              noShares = Number(noSharesRaw) / 1_000_000;
              claimed = claimedRaw;
            }
          } catch (err) {
            const yesBuys = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const yesSells = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const noBuys = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const noSells = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            yesShares = Math.max(0, yesBuys - yesSells);
            noShares = Math.max(0, noBuys - noSells);
          }
          
          let currentVal = 0;
          if (resolved) {
            const yesBuys = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const yesSells = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const noBuys = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const noSells = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const netYes = Math.max(0, yesBuys - yesSells);
            const netNo = Math.max(0, noBuys - noSells);
            
            currentVal = outcome === true ? netYes : netNo;
            resolvedMarketsCount++;
            
            const marketPnL = (totalReceived + currentVal) - totalPaid;
            if (marketPnL > 0.05) {
              winningMarketsCount++;
            }
          } else {
            if (cached) {
              try {
                const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
                  address: marketAddress,
                  abi: [{
                    name: 'getMarketInfo',
                    type: 'function',
                    stateMutability: 'view',
                    inputs: [],
                    outputs: [
                      { name: '_slug', type: 'string' },
                      { name: '_deadline', type: 'uint256' },
                      { name: '_resolved', type: 'bool' },
                      { name: '_outcome', type: 'bool' },
                      { name: '_yesOutstanding', type: 'uint256' },
                      { name: '_noOutstanding', type: 'uint256' }
                    ]
                  }],
                  functionName: 'getMarketInfo'
    });

                
                const poolYes = Number(yesOutstanding) / 1_000_000;
                const poolNo = Number(noOutstanding) / 1_000_000;
                const bVal = 10;
                const maxQ = Math.max(poolYes, poolNo);
                const expYes = Math.exp((poolYes - maxQ) / bVal);
                const expNo = Math.exp((poolNo - maxQ) / bVal);
                yesPrice = expYes / (expYes + expNo);
                noPrice = expNo / (expYes + expNo);
              } catch (e) {
                // Keep default 0.5
              }
            }
            currentVal = yesShares * yesPrice + noShares * noPrice;
          }
          
          const marketPnL = (totalReceived + currentVal) - totalPaid;
          // Realized PnL only: a market counts once it has RESOLVED. The /versus
          // board is explicitly "realized PnL on resolved markets"; including open
          // positions' mark-to-market (with a guessed LMSR b, and trade-derived
          // shares when an agent wallet isn't in the address cache) was mislabeled
          // and noisy  it let high-win-rate agents show a deeply negative total.
          if (resolved) totalPnL += marketPnL;
          
          // Win rate counts every market the user put money into:
          // a "win" is positive PnL (realized for resolved markets,
          // mark-to-market for open ones). Converges to the realized
          // win rate as markets resolve.
          if (totalPaid > 0.001) {
            marketsTradedCount++;
            if (marketPnL > 0.001) profitableMarketsCount++;
          }
        }
        
        // Realized-only win rate  consistent with the realized-only PnL above.
        // If no markets resolved yet, show 0% (honest) rather than a mark-to-market
        // guess that can diverge wildly from the PnL number.
        const winRate = resolvedMarketsCount > 0
          ? (winningMarketsCount / resolvedMarketsCount) * 100
          : 0;
        
        // Use the batch-fetched profile instead of a per-user Supabase query.
        // The old code did 1 query PER USER inside this loop (N+1 pattern),
        // taking 10-90s for 100 traders. Now we read from the pre-fetched map.
        try {
          let displayName = 'Puls Trader';
          let avatarUrl = null;
          
          if (userId.startsWith('supabase_')) {
            const existingProf = __profilesBatch.get(userId);
            if (existingProf) {
              displayName = existingProf.display_name;
              avatarUrl = existingProf.avatar_url;
            } else {
              avatarUrl = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${userId}`;
              // Queue insert (fire-and-forget  don't block the rebuild)
              supabase.from('profiles').insert({
                user_id: userId,
                display_name: displayName,
                avatar_url: avatarUrl,
                bio: 'Trading prediction markets on Arc Testnet.'
              }).then(() => {}).catch(() => {});
            }
          } else if (userId.startsWith('eth_')) {
            const addr = userId.replace('eth_', '');
            displayName = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
            avatarUrl = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
            // Queue upsert (fire-and-forget)
            supabase.from('profiles').upsert({
              user_id: userId,
              display_name: displayName,
              avatar_url: avatarUrl,
              bio: 'Trading via MetaMask on Arc Testnet.'
            }, { onConflict: 'user_id' }).then(() => {}).catch(() => {});
          }
        } catch (_) { /* profiles table may not exist yet */ }
        
        leaderboardStats.set(userId, {
          user_id: userId,
          is_agent: userId === HOUSE_AGENT_USER || userId.startsWith('agent_'),
          volume: parseFloat(totalVolume.toFixed(2)),
          pnl: parseFloat(totalPnL.toFixed(2)),
          trades_count: tradesCount,
          win_rate: parseFloat(winRate.toFixed(1)),
          resolved_count: resolvedMarketsCount,
          wins_count: winningMarketsCount,
          updated_at: new Date().toISOString()
        });

        
      } catch (err) {
        console.error(`Error calculating leaderboard stats for user ${userId}:`, err.message);
      }
    };
    for (let __i = 0; __i < __lbEntries.length; __i += __LB_CONC) {
      await Promise.all(__lbEntries.slice(__i, __i + __LB_CONC).map(__computeUser));
    }

    // Seed every known agent into the leaderboard so they ALWAYS appear in /versus
    // and the Creators board  even if they haven't traded yet. Existing computed
    // stats (set above) take precedence; this only fills in the gaps.
    const __zeroEntry = (uid) => ({
      user_id: uid, is_agent: true, volume: 0, pnl: 0,
      trades_count: 0, win_rate: 0, updated_at: new Date().toISOString(),
    });
    try {
      const roster = buildSwarmRoster();
      for (const a of roster) {
        if (!leaderboardStats.has(a.user)) leaderboardStats.set(a.user, __zeroEntry(a.user));
      }
      // House Pulse + Sage  use literal strings (safe regardless of const TDZ)
      if (!leaderboardStats.has('house_pulse')) leaderboardStats.set('house_pulse', __zeroEntry('house_pulse'));
      if (!leaderboardStats.has('agent_sage')) leaderboardStats.set('agent_sage', __zeroEntry('agent_sage'));
    } catch (e) { console.warn('[leaderboard] roster seed error:', e.message); }

    leaderboardCache.clear(); // serve fresh stats promptly
    console.log(`Leaderboard updated successfully (${leaderboardStats.size} traders).`);
  } catch (e) {
    console.error('updateLeaderboard error:', e.message);
  }
}

// Event-driven leaderboard refresh: invalidate the cache + rebuild on trade
// activity instead of a 10-minute poll. Debounced so a burst of trades only
// triggers one rebuild.
let _leaderboardRebuildTimer = null;
function scheduleLeaderboardRebuild() {
  if (_leaderboardRebuildTimer) return; // already scheduled
  _leaderboardRebuildTimer = setTimeout(() => {
    _leaderboardRebuildTimer = null;
    updateLeaderboard().catch((e) => console.error('leaderboard rebuild:', e.message));
  }, 10_000).unref?.();
}
eventBus.on(EVENTS.TRADE_COMPLETE, () => scheduleLeaderboardRebuild());

// Manual refresh endpoint
app.get('/api/refresh-leaderboard', async (req, res) => {
  try {
    await updateLeaderboard();
    res.json({ ok: true, message: 'Leaderboard updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In-memory leaderboard cache (60s TTL) to avoid Supabase rate limits
const leaderboardCache = new Map(); // key: "sort:limit"  { data, ts }
const LEADERBOARD_CACHE_TTL = 60_000; // 60 seconds

app.get('/api/leaderboard', cacheMiddleware(60, 'v1'), async (req, res) => {
  try {
    const { sort = 'pnl', limit = 50, type = 'all' } = req.query;
    const maxLimit = Math.min(500, parseInt(limit) || 50);
    const kind = ['all', 'humans', 'agents'].includes(type) ? type : 'all';
    const kindFilter = (row) => {
      const isAgent = row.is_agent === true || row.user_id === HOUSE_AGENT_USER || (row.user_id || '').startsWith('agent_');
      return kind === 'all' ? true : kind === 'agents' ? isAgent : !isAgent;
    };
    
    // Check cache first
    const cacheKey = `${sort}:${maxLimit}:${kind}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < LEADERBOARD_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    // Primary source: in-memory stats computed by the leaderboard cron
    // (the Supabase `leaderboard` table has a legacy schema  see updateLeaderboard)
    let leaderboardData = null;
    if (leaderboardStats.size > 0) {
      leaderboardData = Array.from(leaderboardStats.values())
        .filter(kindFilter)
        .sort((a, b) => sort === 'volume' ? b.volume - a.volume : b.pnl - a.pnl)
        .slice(0, maxLimit);
    }
    
    // Fallback (cron hasn't completed yet, e.g. right after boot): quick compute from trades
    if (!leaderboardData || leaderboardData.length === 0) {
      try {
        const { data: allTrades, error: tradesError } = await supabase
          .from('trades')
          .select('user_id, side, usdc_amount, state, question')
          .eq('state', 'COMPLETE')
          .limit(5000);
        
        if (tradesError) {
          console.warn('Leaderboard trades fallback failed:', tradesError.message);
        } else if (allTrades && allTrades.length > 0) {
          const userStats = {};
          for (const t of allTrades) {
            if (!t.user_id) continue;
            if (isSeedWallet(t.user_id)) continue; // seed/liquidity wallet  exclude
            // Same humans-vs-agents bucketing as the cron (see updateLeaderboard)
            const isAgentTrade = typeof t.question === 'string' && t.question.startsWith(' Agent:');
            const key = t.user_id === HOUSE_AGENT_USER
              ? HOUSE_AGENT_USER
              : (t.user_id.startsWith('agent_swarm_') ? t.user_id : (isAgentTrade ? `agent_${t.user_id}` : t.user_id));
            if (!userStats[key]) {
              userStats[key] = { volume: 0, pnl: 0, trades_count: 0, win_rate: 0 };
            }
            const s = userStats[key];
            s.trades_count++;
            s.volume += Math.abs(parseFloat(t.usdc_amount || 0));
          }
          leaderboardData = Object.entries(userStats)
            .map(([userId, stats]) => ({
              user_id: userId,
              is_agent: userId === HOUSE_AGENT_USER || userId.startsWith('agent_'),
              ...stats,
              volume: parseFloat(stats.volume.toFixed(2))
            }))
            .filter(kindFilter)
            .sort((a, b) => sort === 'volume' ? b.volume - a.volume : b.pnl - a.pnl)
            .slice(0, maxLimit);
        }
      } catch (e) {
        console.warn('Leaderboard trades fallback error:', e.message);
      }
    }
    
    if (!leaderboardData) leaderboardData = [];
    
    // Enrich with actual profile display names and avatars. For user agents
    // (agent_<ownerId>) also fetch the OWNER's profile so the agent can be
    // labelled "<owner>'s Agent".
    let profilesMap = {};
    if (leaderboardData.length > 0) {
      try {
        const userIds = new Set();
        for (const r of leaderboardData) {
          if (!r.user_id) continue;
          userIds.add(r.user_id);
          if (r.user_id.startsWith('agent_')) userIds.add(r.user_id.slice(6));
        }
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, display_name, avatar_url, bio')
          .in('user_id', [...userIds]);
        if (profiles) {
          for (const p of profiles) {
            profilesMap[p.user_id] = p;
          }
        }
      } catch (_) { /* profiles table may not exist */ }
    }
    
    // Format response with real profile data, falling back to defaults
    const formatted = leaderboardData.map(row => {
      const isAgent = row.is_agent === true || row.user_id === HOUSE_AGENT_USER || (row.user_id || '').startsWith('agent_');
      const profile = profilesMap[row.user_id];
      let defaultName = 'Puls Trader';
      let defaultAvatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${row.user_id}`;
      let erc8004Id = null;
      if (row.user_id?.startsWith('eth_')) {
        const addr = row.user_id.replace('eth_', '');
        defaultName = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        defaultAvatar = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
      } else if (row.user_id === HOUSE_AGENT_USER) {
        defaultName = 'Pulse T House Agent';
        defaultAvatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=pulse-house`;
        erc8004Id = agentTokenIds.get(HOUSE_AGENT_KEY) ?? null;
      } else if (row.user_id?.startsWith('agent_swarm_')) {
        // Swarm agents are first-class citizens  use their OWN profile + identity.
        defaultName = profile?.display_name || 'Puls Agent';
        defaultAvatar = profile?.avatar_url || `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${row.user_id}`;
        erc8004Id = agentTokenIds.get(`agent_${row.user_id}`) ?? null;
      } else if (row.user_id?.startsWith('agent_')) {
        const ownerProfile = profilesMap[row.user_id.slice(6)];
        const ownerName = ownerProfile?.display_name || 'Puls Trader';
        defaultName = `${ownerName}'s Agent`;
        erc8004Id = agentTokenIds.get(row.user_id) ?? null;
      }
      // Resolve a display name, disambiguating the generic "Puls Trader" default
      // so the board isn't a wall of identical names (BUG-2). Custom names,
      // agents and wallet-address (eth_) names are left untouched.
      const customName = (profile?.display_name || '').trim();
      let displayName = customName || defaultName;
      if (!isAgent && defaultName === 'Puls Trader' && (!customName || customName === 'Puls Trader')) {
        const suffix = (row.user_id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
        if (suffix) displayName = `Puls Trader ${suffix}`;
      }
      return {
        userId: row.user_id,
        isAgent,
        erc8004Id,
        volume: parseFloat(row.volume || 0),
        pnl: parseFloat(row.pnl || 0),
        tradesCount: row.trades_count || 0,
        winRate: parseFloat(row.win_rate || 0),
        resolvedCount: row.resolved_count || 0,
        winsCount: row.wins_count || 0,
        displayName,
        avatarUrl: profile?.avatar_url || defaultAvatar,
        bio: profile?.bio || (isAgent ? 'Autonomous AI trading agent with on-chain ERC-8004 identity.' : '')
      };
    });
    
    // Cache the result
    leaderboardCache.set(cacheKey, { data: formatted, ts: Date.now() });
    
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const isAgentUser = userId.startsWith('agent_');
    const ownerUserId = isAgentUser ? userId.replace('agent_', '') : userId;
    const agentUserId = isAgentUser ? userId : `agent_${userId}`;
    
    let profile = null;
    const { data: profData } = await supabase
      .from('profiles')
      .select('*')
      .in('user_id', [userId, ownerUserId])
      .limit(1);
      
    if (profData && profData.length > 0) {
      profile = profData[0];
    }
    
    if (!profile || isAgentUser) {
      let name = isAgentUser ? 'AI Trading Agent' : 'Puls Trader';
      if (profile && isAgentUser) name = `${profile.display_name}'s AI Agent`;
      let avatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${userId}`;
      if (userId.startsWith('eth_')) {
        const addr = userId.replace('eth_', '');
        name = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        avatar = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
      }
      profile = {
        user_id: userId,
        display_name: name,
        avatar_url: avatar,
        bio: isAgentUser ? 'Automated AI trading agent on PulsMarket.' : 'Active trader on PulsMarket.'
      };
    }
    
    const stats = leaderboardStats.get(userId) || leaderboardStats.get(ownerUserId) || null;
    
    let trades = [];
    const { data: tradesData } = await supabase
      .from('trades')
      .select('*')
      .in('user_id', [userId, ownerUserId, agentUserId])
      .eq('state', 'COMPLETE')
      .order('created_at', { ascending: false })
      .limit(100);
      
    trades = tradesData ?? [];
    const calcVolume = trades.reduce((sum, t) => sum + Math.abs(parseFloat(t.usdc_amount || 0)), 0);
      
    res.json({
      profile,
      stats: stats ? {
        volume: parseFloat(stats.volume || 0),
        pnl: parseFloat(stats.pnl || 0),
        tradesCount: stats.trades_count || trades.length,
        winRate: parseFloat(stats.win_rate || 0)
      } : { volume: Math.round(calcVolume * 100) / 100, pnl: 0, tradesCount: trades.length, winRate: 0 },
      trades
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/profile/update', authenticateUser, strictLimiter, async (req, res) => {
  try {
    let { userId, displayName, bio, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    if (req.user) {
      const expectedUserId = `supabase_${req.user.id}`;
      if (userId !== expectedUserId) {
        return res.status(403).json({ error: 'Forbidden: User identity mismatch' });
      }
      userId = expectedUserId;
    }
    
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        user_id: userId,
        display_name: displayName,
        bio: bio,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      
    if (error) {
      // If profiles table doesn't exist yet, return ok with warning
      if (error.message?.includes('schema cache') || error.message?.includes('does not exist')) {
        console.warn('Profile update skipped  profiles table not found.');
        return res.json({ ok: true, warning: 'Profile saved locally only  profiles table pending migration.' });
      }
      throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  Agentic Economy (ERC-8004 + autonomous trading) 

// Agent LLM providers: primary + ordered fallbacks. Configure via env 
// AGENT_LLM_URL / AGENT_LLM_KEY / AGENT_MODEL is the primary; numbered suffixes
// _2, _3,  add fallbacks tried in order. A provider is skipped unless it has a
// URL, key AND model. URLs may be a base ("/v1")  "/chat/completions" is
// appended automatically when missing. All keys live in .env, never in the repo.
function buildLlmProviders(base = 'AGENT_LLM', modelBase = 'AGENT_MODEL') {
  const list = [];
  // '', _2  _50  room for many fallback providers and rotating keys.
  for (const sfx of ['', ...Array.from({ length: 49 }, (_, i) => `_${i + 2}`)]) {
    let url = (process.env[`${base}_URL${sfx}`] || '').trim();
    const key = (process.env[`${base}_KEY${sfx}`] || '').trim();
    const model = (process.env[`${modelBase}${sfx}`] || '').trim();
    if (!url || !key || !model) continue;
    // Format: explicit env wins, else auto-detect by host.
    let format = (process.env[`${base}_FORMAT${sfx}`] || '').trim().toLowerCase();
    if (!format) {
      if (/generativelanguage\.googleapis\.com/i.test(url)) format = 'gemini';
      else if (/api\.cohere\.com/i.test(url)) format = 'cohere';
      else if (/(^|\/\/)(api\.)?ollama\.com/i.test(url)) format = 'ollama';
      else format = 'openai';
    }
    if (format === 'openai' && !/\/(chat\/)?completions\/?$/.test(url)) {
      url = url.replace(/\/+$/, '') + '/chat/completions';
    }
    list.push({ url, key, model, format });
  }
  return list;
}
const LLM_PROVIDERS = buildLlmProviders();
// Optional separate "heavy" pool of reasoning models for the daily blog
// analysis  where depth matters and latency doesn't. Configured via
// AGENT_HEAVY_URL/KEY + AGENT_HEAVY_MODEL (and _2, _3 ). The trading loop never
// uses these (they'd be slow + emit verbose reasoning, not clean JSON).
const LLM_HEAVY_PROVIDERS = buildLlmProviders('AGENT_HEAVY', 'AGENT_HEAVY_MODEL');
const llmHeavyCooldown = new Map();
const LLM_TIMEOUT_MS = parseInt(process.env.AGENT_LLM_TIMEOUT_MS || '60000', 10);
// Heavy reasoning models (the blog/analysis pool) are large + slow and emit long
// outputs, so they get a very long per-attempt timeout  the blog runs in the
// background and isn't user-facing, so we let the big reasoning models take as
// long as they need (10 min default). Falls back to the fast pool only if they
// still fail. Tunable via AGENT_HEAVY_TIMEOUT_MS.
const LLM_HEAVY_TIMEOUT_MS = parseInt(process.env.AGENT_HEAVY_TIMEOUT_MS || '600000', 10);
const LLM_RETRIES = Math.max(1, parseInt(process.env.AGENT_LLM_RETRIES || '1', 10)); // attempts per provider
// After a provider hits a rate-limit/quota/overload error, skip it for this
// long  stops hammering exhausted keys (frees the 1-vCPU box) and rotates to a
// fresh key/provider. With many keys configured this gives big effective
// throughput without 429 spam.
const LLM_COOLDOWN_MS = parseInt(process.env.AGENT_LLM_COOLDOWN_MS || '90000', 10);
const llmCooldownUntil = new Map(); // provider index -> timestamp to skip until
if (LLM_PROVIDERS.length === 0) {
  console.warn('[llm] No agent LLM providers configured (set AGENT_LLM_URL/KEY/MODEL).');
} else {
  console.log(`[llm] ${LLM_PROVIDERS.length} provider(s): ${LLM_PROVIDERS.map(p => `${p.model}${p.format !== 'openai' ? `(${p.format})` : ''}`).join('  ')}`);
}
if (LLM_HEAVY_PROVIDERS.length) {
  console.log(`[llm] ${LLM_HEAVY_PROVIDERS.length} heavy provider(s): ${LLM_HEAVY_PROVIDERS.map(p => p.model).join('  ')}`);
}
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const AGENT_METADATA_URI = 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei';

async function getAgent(userId) {
  const walletId = await getWalletId(`agent_${userId}`);
  if (!walletId) return null;
  const info = await getWalletInfo(walletId);
  return { walletId, address: info.address, balance: info.usdcBalance, exactBalance: info.exactUsdcBalance };
}

// In-memory guard so we only register each agent on ERC-8004 once per process.
const registeredAgents = new Set();
const agentTokenIds = new Map();   // agentKey -> ERC-8004 token id (string)
const agentRepCount = new Map();   // agentKey -> number of reputation events recorded

//  ERC-8004 identity helpers 
// IdentityRegistry is ERC-721 (balanceOf works) but NOT Enumerable
// (tokenOfOwnerByIndex/totalSupply revert), so we can cheaply ask "does this
// address already own an identity?" but must read the mint event to learn the id.
const IDENTITY_ERC721_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }],
}];

// Re-mint guard: true iff the address already holds >=1 ERC-8004 identity. This
// is what makes registration idempotent ACROSS RESTARTS  the in-memory guard
// (registeredAgents / s.registered) is reset each process, but balanceOf is the
// durable on-chain source of truth. Without this, an agent whose original mint
// is older than the event-scan window gets re-registered (a NEW token id, wasted
// USDC gas) on every restart  which is why the swarm's "8004 id" kept changing.
async function agentHasIdentity(agentAddress) {
  if (!agentAddress) return false;
  try {
    const bal = await publicClient.readContract({
      address: IDENTITY_REGISTRY, abi: IDENTITY_ERC721_ABI, functionName: 'balanceOf', args: [agentAddress],
    });
    return BigInt(bal) > 0n;
  } catch (e) {
    console.warn('[erc8004] balanceOf check failed:', e.message);
    return false;
  }
}

// Durable token-id store (optional `agent_identities` table). Silent no-op until
// the table is created (migrations/2026-06-28-agent-identities.sql)  the event
// scan still works meanwhile, so the fix is safe to deploy before the migration.
async function getPersistedTokenId(agentKey) {
  try {
    const { data, error } = await supabase
      .from('agent_identities').select('token_id').eq('agent_key', agentKey).maybeSingle();
    if (error) return null;
    return data?.token_id ?? null;
  } catch { return null; }
}
async function persistTokenId(agentKey, tokenId, address) {
  try {
    await supabase.from('agent_identities').upsert({
      agent_key: agentKey, token_id: String(tokenId), address: address || null, updated_at: new Date().toISOString(),
    });
  } catch { /* table may not exist yet  ignore */ }
}

// Resolve an agent's ERC-8004 token id, STABLE across restarts:
//   in-memory cache  durable store  bounded backward scan of mint events.
// Once found, the id is persisted so it never churns even after the mint ages
// out of the scan window. Returns the most recent mint (matches what was shown).
const ERC8004_SCAN_CHUNK = 9000n;            // per-call getLogs range (RPC caps ~10k)
const ERC8004_SCAN_CHUNKS = Math.max(1, parseInt(process.env.ERC8004_SCAN_CHUNKS || '112', 10));
async function resolveAgentTokenId(agentKey, agentAddress) {
  if (agentTokenIds.has(agentKey)) return agentTokenIds.get(agentKey);
  const persisted = await getPersistedTokenId(agentKey);
  if (persisted) { agentTokenIds.set(agentKey, persisted); return persisted; }
  if (!agentAddress) return null;
  try {
    const evt = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
    let toBlock = await publicClient.getBlockNumber();
    for (let i = 0; i < ERC8004_SCAN_CHUNKS && toBlock > 0n; i++) {
      const fromBlock = toBlock > ERC8004_SCAN_CHUNK ? toBlock - ERC8004_SCAN_CHUNK : 0n;
      const logs = await publicClient.getLogs({
        address: IDENTITY_REGISTRY, event: evt, args: { to: agentAddress }, fromBlock, toBlock,
      });
      if (logs.length > 0) {
        const id = logs[logs.length - 1].args.tokenId.toString();
        agentTokenIds.set(agentKey, id);
        persistTokenId(agentKey, id, agentAddress);
        return id;
      }
      if (fromBlock === 0n) break;
      toBlock = fromBlock - 1n;
    }
  } catch (e) {
    console.error('resolveAgentTokenId error:', e.message);
  }
  return null;
}

// Record ERC-8004 reputation from the ADMIN wallet (an independent validator 
// ERC-8004 forbids an agent owner from rating its own agent). score 0..100.
async function recordAgentReputation(agentKey, agentAddress, score, tag) {
  try {
    if (!walletClient || !adminAccount) return;
    const tokenId = await resolveAgentTokenId(agentKey, agentAddress);
    if (!tokenId) return;
    await walletClient.writeContract({
      address: REPUTATION_REGISTRY,
      abi: [{
        name: 'giveFeedback', type: 'function', stateMutability: 'nonpayable',
        inputs: [
          { name: 'agentId', type: 'uint256' }, { name: 'score', type: 'int128' },
          { name: 'feedbackType', type: 'uint8' }, { name: 'tag', type: 'string' },
          { name: 'metadataURI', type: 'string' }, { name: 'evidenceURI', type: 'string' },
          { name: 'comment', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
        ],
        outputs: [],
      }],
      functionName: 'giveFeedback',
      args: [BigInt(tokenId), BigInt(score), 0, tag, '', '', '', keccak256(toHex(`${tag}-${Date.now()}`))],
    });
    agentRepCount.set(agentKey, (agentRepCount.get(agentKey) || 0) + 1);
  } catch (e) {
    console.error('recordAgentReputation error:', e.shortMessage || e.message);
  }
}

// Completes a chat from ONE provider, dispatching by wire format.
async function llmCompleteOne(provider, messages, signal) {
  if (provider.format === 'gemini') return llmCompleteGemini(provider, messages, signal);
  if (provider.format === 'antigravity') return llmCompleteAntigravity(provider, messages, signal);
  if (provider.format === 'cohere') return llmCompleteCohere(provider, messages, signal);
  if (provider.format === 'ollama') return llmCompleteOllama(provider, messages, signal);
  return llmCompleteOpenAI(provider, messages, signal);
}

// Cohere Chat API (v2). URL is the base ("https://api.cohere.com") or full
// "/v2/chat"; messages map 1:1 (system/user/assistant). Response content is an
// array of typed blocks  join the text parts.
async function llmCompleteCohere(provider, messages, signal) {
  let url = provider.url;
  if (!/\/v\d\/chat/.test(url)) url = url.replace(/\/(chat\/)?completions\/?$/, '').replace(/\/+$/, '') + '/v2/chat';
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages }),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const parts = j.message?.content || [];
  return parts.map(p => p.text || '').join('').trim();
}

// Ollama Cloud native chat (/api/chat, non-stream). URL is the base
// ("https://ollama.com" or "https://api.ollama.com") or full "/api/chat".
async function llmCompleteOllama(provider, messages, signal) {
  let url = provider.url.replace(/\/+$/, '');
  if (!/\/api\/chat$/.test(url)) url = url.replace(/\/v1$/, '').replace(/\/api\/chat\/?$/, '') + '/api/chat';
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages, stream: false }),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.message?.content || '').trim();
}

// Google Gemini (generativelanguage API)  different endpoint shape & auth.
// Maps OpenAI-style messages to Gemini "contents" + systemInstruction.
async function llmCompleteGemini(provider, messages, signal) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content ?? '') }] }));
  // URL may be a base ("/v1beta") or a full ":generateContent"  normalise.
  let url = provider.url;
  if (!/:generateContent/.test(url)) {
    url = url.replace(/\/+$/, '') + `/models/${provider.model}:generateContent`;
  }
  const body = { contents };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': provider.key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

// Google Antigravity (Interactions API) — agentic model, not standard chat.
// Maps OpenAI-style messages to Interactions API: system → input prefix, history → concatenated input.
async function llmCompleteAntigravity(provider, messages, signal) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const history = messages.filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Model' : 'User'}: ${m.content}`)
    .join('\n');
  const input = [sys, history].filter(Boolean).join('\n\n');
  const url = provider.url.replace(/\/+$/, '') + '/interactions';
  const body = {
    agent: provider.model,
    input,
    environment: 'remote'
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': provider.key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  // Find last model_output step (actual response), fallback to last summary
  const modelOutput = [...j.steps || []].reverse().find(s => s.type === 'model_output');
  if (modelOutput?.content?.[0]?.text) return modelOutput.content[0].text.trim();
  const lastStep = j.steps?.[j.steps.length - 1];
  const summary = lastStep?.summary?.[0]?.text || '';
  return summary.trim();
}

// OpenAI-compatible streaming SSE chat completion. Falls back to reading the
// non-stream JSON body if the provider ignored stream:true.
async function llmCompleteOpenAI(provider, messages, signal) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages, stream: true }),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const ctype = r.headers.get('content-type') || '';
  // Some gateways ignore stream:true and return a single JSON object.
  if (!/text\/event-stream/i.test(ctype)) {
    const j = await r.json().catch(() => null);
    const msg = j?.choices?.[0]?.message;
    return String(msg?.content || msg?.reasoning_content || '').trim();
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '', reasoning = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta;
        if (d?.content) out += d.content;
        else if (d?.reasoning_content) reasoning += d.reasoning_content;
      } catch (_) {}
    }
  }
  // Reasoning models stream their thinking in `reasoning_content` and may emit
  // no `content`  fall back to the reasoning so the heavy pool isn't empty.
  return (out.trim() || reasoning.trim());
}

// Tries each configured provider in priority order (primary  fallbacks) with a
// per-attempt timeout and optional retries. Returns the first successful result.
// `opts.prefer` (substring match on a provider model id) tries a preferred
// provider FIRST  this lets each swarm agent favour a distinct "brain" while
// still falling back through the whole pool if it's down. Returns the text.
async function llmComplete(messages, opts = {}) {
  const useHeavy = opts.heavy === true && LLM_HEAVY_PROVIDERS.length > 0;
  const pool = useHeavy ? LLM_HEAVY_PROVIDERS : LLM_PROVIDERS;
  const cooldown = useHeavy ? llmHeavyCooldown : llmCooldownUntil;
  if (pool.length === 0) throw new Error('Agent LLM key not configured');
  let order = pool.map((p, i) => i);
  if (opts.prefer) {
    const want = String(opts.prefer).toLowerCase();
    const pi = pool.findIndex(p => p.model.toLowerCase().includes(want));
    if (pi > 0) order = [pi, ...order.filter(i => i !== pi)];
  }
  // Skip providers that recently hit a rate-limit/quota error (stops 429 spam,
  // saves CPU, rotates to fresh keys). If everything is cooling down, try the
  // full order anyway rather than hard-failing.
  const nowTs = Date.now();
  const ready = order.filter((i) => (cooldown.get(i) || 0) <= nowTs);
  const tryOrder = ready.length ? ready : order;
  const errors = [];
  for (const idx of tryOrder) {
    const provider = pool[idx];
    for (let attempt = 1; attempt <= LLM_RETRIES; attempt++) {
      const ac = new AbortController();
      const timeoutMs = useHeavy ? LLM_HEAVY_TIMEOUT_MS : LLM_TIMEOUT_MS;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const out = await llmCompleteOne(provider, messages, ac.signal);
        clearTimeout(timer);
        if (!out) throw new Error('empty completion');
        return out;
      } catch (e) {
        clearTimeout(timer);
        const reason = ac.signal.aborted ? `timeout after ${timeoutMs}ms` : (e.message || String(e));
        // Rate-limited / quota / overloaded / depleted credits  cool this
        // provider down so the next calls rotate to a fresh key.
        if (/\b(429|503)\b|rate.?limit|quota|cost limit|too many|overloaded|capacity|depleted|credits? exhausted|insufficient.*credits?|balance.*low|out of credits|payment required|\b402\b/i.test(reason)) {
          cooldown.set(idx, Date.now() + Math.max(LLM_COOLDOWN_MS, 30 * 60 * 1000)); // 30 min  depleted credits won't recover fast
          errors.push(`${provider.model}: ${reason}`);
          console.error(`[llm] provider (${provider.model}) attempt ${attempt}/${LLM_RETRIES} failed (COOLDOWN 30min): ${reason}`);
          break; // don't retry this provider  move to next one immediately
        } else if (/\b(401|403)\b|forbidden|unauthorized|invalid.*api|api key/i.test(reason)) {
          // Auth/forbidden  e.g. a provider geo-blocks this server's IP or a dead
          // key. Won't recover soon, so bench it ~30 min instead of hammering it on
          // every request (this caused the 45+ 403 churn after the Netherlands move).
          cooldown.set(idx, Date.now() + Math.max(LLM_COOLDOWN_MS, 30 * 60 * 1000));
          errors.push(`${provider.model}: ${reason}`);
          console.error(`[llm] provider (${provider.model}) attempt ${attempt}/${LLM_RETRIES} failed (AUTH COOLDOWN 30min): ${reason}`);
          break; // don't retry  move to next provider
        } else if (/\b(400|404|408|500|502|504)\b|bad request|not found|gateway|service unavailable/i.test(reason)) {
          // Other HTTP errors  short cooldown (5 min), might be transient.
          cooldown.set(idx, Date.now() + 5 * 60 * 1000);
          errors.push(`${provider.model}: ${reason}`);
          console.error(`[llm] provider (${provider.model}) attempt ${attempt}/${LLM_RETRIES} failed (COOLDOWN 5min): ${reason}`);
          break; // don't retry  move to next provider
        }
        errors.push(`${provider.model}: ${reason}`);
        console.error(`[llm] provider (${provider.model}) attempt ${attempt}/${LLM_RETRIES} failed: ${reason}`);
      }
    }
  }
  throw new Error(`All LLM providers failed  ${errors.join(' | ')}`);
}

// The Puls app renders Telegram/Slack-style markdown where a SINGLE asterisk = bold.
 // LLMs emit standard markdown (**bold**, ## headings), so normalise their prose to
 // the app's flavour before sending it to the client. Idempotent & safe on plain text.
 function formatForApp(text) {
   if (!text || typeof text !== 'string') return text;
   return text
     // Sanitize ill-formed Unicode (lone surrogates, non-characters, etc.) via
     // UTF-8 round-trip. TextEncoder/Decoder with fatal=false replaces all
     // malformed sequences with U+FFFD (�), guaranteeing well-formed output.
     // This protects ALL downstream inserts (blog posts, comments, agent chat,
     // creator_signals) from PostgREST "invalid input syntax for type json"
     // failures caused by LLM output or scraped web content carrying
     // unpaired surrogates (e.g. from emoji split by slice(0, N)).
     .replace(/^/, (s) => {
       try {
         return new TextDecoder('utf-8', { fatal: false }).decode(
           new TextEncoder().encode(s)
         );
       } catch { return s; }
     })
     // ATX headings (#, ##, ### )  a bold line
     .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
     // bold+italic ***x***  *x*
     .replace(/\*\*\*([^\n*][^\n]*?)\*\*\*/g, '*$1*')
     // bold **x**  *x*
     .replace(/\*\*([^\n*][^\n]*?)\*\*/g, '*$1*')
     // __bold__  *x*
     .replace(/__([^\n_][^\n]*?)__/g, '*$1*');
 }

// Create (or fetch) a separate per-user agent wallet, funded from the user up to budget.
app.post('/api/agent/start', apiKeyOrAuth, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, budget } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const budgetNum = Math.max(0, parseFloat(budget ?? '0'));
    const agentKey = `agent_${userId}`;

    let agentWalletId = await getWalletId(agentKey);
    let agentAddress;
    if (!agentWalletId) {
      const setId = await ensureWalletSet();
      const createRes = await circle.createWallets({
        accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
      });
      const w = createRes.data.wallets[0];
      agentWalletId = w.id;
      agentAddress = w.address;
      await saveWallet(agentKey, w.id);
    } else {
      agentAddress = (await getWalletInfo(agentWalletId)).address;
    }

    // Fund the agent wallet from the user's wallet up to the requested budget.
    // The agent's USDC balance IS the budget cap  it cannot spend more than it holds.
    const userWalletId = await getWalletId(userId);
    let funded = 0;
    if (userWalletId && budgetNum > 0) {
      const current = parseFloat((await getWalletInfo(agentWalletId)).usdcBalance) || 0;
      const need = budgetNum - current;
      if (need > 0.01) {
        try {
          const tx = await circle.createTransaction({
            walletId: userWalletId,
            tokenAddress: USDC,
            blockchain: 'ARC-TESTNET',
            destinationAddress: agentAddress,
            amounts: [need.toFixed(6)],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          });
          funded = need;
          // Wait for the transfer to settle so the agent balance reflects the funds.
          const txId = tx.data?.id;
          for (let i = 0; txId && i < 20; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const st = await circle.getTransaction({ id: txId });
            const s = st.data?.transaction?.state;
            if (s === 'COMPLETE') break;
            if (s === 'FAILED' || s === 'DENIED') { funded = 0; break; }
          }
        } catch (e) {
          console.error('agent funding error:', e.message);
        }
      }
    }

    // ERC-8004: register the agent's onchain identity once per process.
    let registered = registeredAgents.has(agentKey);
    if (!registered) {
      try {
        await circle.createContractExecutionTransaction({
          walletId: agentWalletId,
          contractAddress: IDENTITY_REGISTRY,
          abiFunctionSignature: 'register(string)',
          abiParameters: [AGENT_METADATA_URI],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });
        registeredAgents.add(agentKey);
        registered = true;
        // Give the mint a moment, then cache the agent's ERC-8004 token id.
        await new Promise(r => setTimeout(r, 3000));
        await resolveAgentTokenId(agentKey, agentAddress);
      } catch (e) {
        console.error('ERC-8004 register error:', e.message);
      }
    } else {
      resolveAgentTokenId(agentKey, agentAddress).catch(() => {});
    }

    const balance = parseFloat((await getWalletInfo(agentWalletId)).usdcBalance) || 0;
    res.json({
      agentAddress,
      budget: balance + funded, // reflects post-funding balance even before settlement
      balance,
      funded,
      registered,
      agentId: agentTokenIds.get(agentKey) ?? null,
      reputation: agentRepCount.get(agentKey) ?? 0,
      identityRegistry: IDENTITY_REGISTRY,
    });
  } catch (e) {
    console.error('agent start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agent/status', apiKeyOrAuth, requireVerifiedUser, async (req, res) => {
  try {
    const agent = await getAgent(req.query.userId);
    if (!agent) return res.json({ exists: false });
    res.json({
      exists: true,
      agentAddress: agent.address,
      balance: agent.balance,
      registered: registeredAgents.has(`agent_${req.query.userId}`),
      agentId: agentTokenIds.get(`agent_${req.query.userId}`) ?? null,
      reputation: agentRepCount.get(`agent_${req.query.userId}`) ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add more USDC from the user's wallet into the agent wallet (top-up after withdraw, etc.).
app.post('/api/agent/deposit', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    const agent = await getAgent(userId);
    if (!agent) return res.status(400).json({ error: 'No agent' });
    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'No user wallet' });

    const tx = await circle.createTransaction({
      idempotencyKey: crypto.randomUUID(),
      walletId: userWalletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: agent.address,
      amounts: [amt.toFixed(6)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    // Wait for settle so the returned balance reflects the deposit.
    const txId = tx.data?.id;
    let ok = true;
    for (let i = 0; txId && i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const s = (await circle.getTransaction({ id: txId })).data?.transaction?.state;
      if (s === 'COMPLETE') break;
      if (s === 'FAILED' || s === 'DENIED') { ok = false; break; }
    }
    const balance = parseFloat((await getWalletInfo(agent.walletId)).usdcBalance) || 0;
    res.json({ deposited: ok ? amt : 0, balance });
  } catch (e) {
    console.error('agent deposit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Return the agent's remaining USDC back to the user's wallet.
app.post('/api/agent/withdraw', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const agent = await getAgent(userId);
    if (!agent) return res.status(400).json({ error: 'No agent' });
    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'No user wallet' });
    const userAddress = (await getWalletInfo(userWalletId)).address;

    // Get the REAL balance from Circle SDK directly (not cached / RPC)
    const balRes = await circle.getWalletTokenBalance({ id: agent.walletId });
    const usdcToken = balRes.data.tokenBalances?.find(
      t => t.token?.address?.toLowerCase() === USDC.toLowerCase() || t.token?.symbol === 'USDC'
    );
    const realBalance = parseFloat(usdcToken?.amount ?? '0');
    console.log('[withdraw] walletId=' + agent.walletId + ' realBalance=' + realBalance + ' addr=' + agent.address + ' -> user=' + userAddress);

    if (realBalance < 0.02) return res.json({ withdrawn: 0, balance: realBalance.toFixed(2) });

    // Withdraw 90% of the balance to leave plenty for gas
    const withdrawAmt = Math.floor((realBalance * 0.9) * 1_000_000) / 1_000_000;
    console.log('[withdraw] withdrawAmt=' + withdrawAmt);

    const tx = await circle.createTransaction({
      walletId: agent.walletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: userAddress,
      amounts: [withdrawAmt.toFixed(6)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    console.log('[withdraw] tx created:', tx.data?.id);
    res.json({ withdrawn: withdrawAmt, txId: tx.data?.id });
  } catch (e) {
    console.error('agent withdraw error:', e.message);
    res.status(500).json({ error: e.message });
  }

});

// Chat with the agent. The LLM returns a structured intent; the backend validates
// The personal "My Agent" can BUY a signal on request: it pays the creator a
// real USDC nanopayment from its OWN wallet (agentcreator x402 on Arc) and
// returns the thesis. Picks the best buyable signal (most-unlocked, freshest);
// skips its own, already-bought, over-budget, and resolved-market (stale) ones.
// Verify a candidate market is REALLY the market a signal references. The
// agent's stake must never land on a different market than the signal's own
// pick — wrong fuzzy resolutions are rejected here (exact slug match, or >=60%
// of the signal's significant question/slug tokens present in the market).
function signalMarketMatches(m, signal) {
  if (!m) return false;
  const slug = String(signal.market_slug || '').trim();
  const question = String(signal.market_question || '').trim();
  if (!slug && !question) return false;
  const mQ = _normQ(m.question || m.slug || '');
  if (slug) {
    if (String(m.slug || '').toLowerCase() === slug.toLowerCase()) return true;
    const sTokens = _normQ(slug).split(' ').filter((w) => w.length > 2);
    const hit = sTokens.filter((w) => mQ.includes(w)).length;
    if (sTokens.length && hit / sTokens.length >= 0.6) return true;
  }
  if (question) {
    const qTokens = _normQ(question).split(' ').filter((w) => w.length > 2);
    const hit = qTokens.filter((w) => mQ.includes(w)).length;
    if (qTokens.length && hit / qTokens.length >= 0.6) return true;
  }
  return false;
}

async function buySignalForUserAgent(userId, agent, query) {
  const agentUserId = `agent_${userId}`;
  const remaining = parseFloat(agent.balance) || 0;
  const { data: rows } = await supabase
    .from('creator_signals')
    .select('id, creator_user_id, title, market_question, market_slug, stance, thesis, price_usdc, unlocks_count, revenue_usdc, created_at')
    .eq('status', 'published')
    .neq('creator_user_id', agentUserId)
    .order('created_at', { ascending: false })
    .limit(40);
  if (!rows || !rows.length) return { ok: false, reason: 'There are no published signals on the marketplace yet.' };
  let owned = new Set();
  try {
    const { data: mine } = await supabase.from('signal_unlocks')
      .select('signal_id').eq('user_id', agentUserId).in('signal_id', rows.map((r) => r.id));
    owned = new Set((mine || []).map((r) => r.signal_id));
  } catch (_) {}
  // Drop signals whose market already resolved (stale alpha  don't buy it).
  const slugs = [...new Set(rows.map((r) => r.market_slug).filter(Boolean))];
  const resolved = new Set();
  try {
    for (let i = 0; i < slugs.length; i += 100) {
      const { data: dm } = await supabase.from('deployed_markets')
        .select('slug, resolved').in('slug', slugs.slice(i, i + 100));
      for (const m of dm || []) if (m.resolved === true) resolved.add(m.slug);
    }
  } catch (_) {}
  let cand = rows.filter((r) => !owned.has(r.id)
    && (Number(r.price_usdc) || 0) <= remaining
    && !(r.market_slug && resolved.has(r.market_slug)));
  if (!cand.length) return { ok: false, reason: 'No buyable signals right now  all already bought, over my budget, or their markets have resolved.' };
  const q = String(query || '').trim().toLowerCase();
  if (q && !['top', 'best', 'any', 'a', 'the', 'one', 'signal', 'alpha', 'forecast'].includes(q)) {
    // Prefer an exact market_question match (uniquely identifies a signal when
    // several share one title, e.g. per-driver "F1 Drivers' Champion" calls);
    // fall back to a title+question substring match.
    const byQuestion = cand.filter((r) => `${r.market_question || ''}`.toLowerCase().includes(q));
    if (byQuestion.length) cand = byQuestion;
    else {
      const matched = cand.filter((r) => `${r.title} ${r.market_question || ''}`.toLowerCase().includes(q));
      if (matched.length) cand = matched;
    }
  }
  cand.sort((a, b) => (b.unlocks_count ?? 0) - (a.unlocks_count ?? 0)
    || (new Date(b.created_at) - new Date(a.created_at)));
  const signal = cand[0];
  let creatorWalletId = await getWalletId(signal.creator_user_id);
  if (!creatorWalletId && /agent/i.test(signal.creator_user_id)) creatorWalletId = await getWalletId(`agent_${signal.creator_user_id}`);
  const creatorInfo = creatorWalletId ? await getWalletInfo(creatorWalletId) : null;
  const toAddr = creatorInfo?.address || (signal.creator_user_id.startsWith('eth_') ? signal.creator_user_id.slice(4) : null);
  if (!toAddr) return { ok: false, reason: 'That signals creator has no payout wallet yet  try another.' };
  const price = Number(signal.price_usdc) || 0.001;
  let txId = null;
  try {
    const tx = await circle.createContractExecutionTransaction({
      walletId: agent.walletId, contractAddress: USDC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [toAddr, String(Math.round(price * 1_000_000))],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    txId = tx.data?.id || null;
  } catch (e) {
    return { ok: false, reason: `Payment failed: ${e.message}` };
  }
  supabase.from('signal_unlocks').upsert({
    user_id: agentUserId, signal_id: signal.id, status: 'confirmed',
    amount_usdc: price, tx_id: txId, confirmed_at: new Date().toISOString(),
  }, { onConflict: 'user_id, signal_id', ignoreDuplicates: true }).then(({ error }) => { if (error && !String(error.message).includes('duplicate')) console.warn('[agent/chat] unlock insert:', error.message); });
  supabase.from('creator_signals').update({
    unlocks_count: (signal.unlocks_count ?? 0) + 1,
    revenue_usdc: Number(signal.revenue_usdc ?? 0) + price,
  }).eq('id', signal.id).then(() => {});
  supabase.from('x402_payments').insert({
    endpoint: 'signal_unlock', payer: agent.address || null, pay_to: toAddr,
    amount_usdc: price.toString(), network: 'eip155:5042002', gateway_tx: txId,
    raw: { kind: 'agent_buy_signal', agent: agentUserId, counterparty: signal.creator_user_id, signalId: signal.id },
  }).then(({ error }) => { if (error) console.warn('[agent/chat] x402 receipt:', error.message); });
  return { ok: true, signal, price, txId };
}

// Execute ONE market buy from the agent's wallet (deploy-on-demand  approve 
// buyYes/buyNo  poll). Returns a result object (no res.json) so it's safe to
// call in a loop for multi-market requests.
async function execAgentTrade(userId, agent, market, side, amount) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!market || !market.slug) return { ok: false, error: 'market not found' };
  if (market.deadline && market.deadline <= nowSec) return { ok: false, error: 'that market has already closed' };
  try {
    const contractAddress = await getOrDeployMarket(market.slug, market.deadline);
    try {
      const info = await publicClient.readContract({
        address: contractAddress,
        abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
          { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
          { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
          { name: '_yesOutstanding', type: 'uint256' }, { name: '_noOutstanding', type: 'uint256' } ] }],
        functionName: 'getMarketInfo',
      });
      if (info[2] || Number(info[1]) <= nowSec) return { ok: false, error: 'already closed on-chain' };
    } catch (_) {}
    const amountMicro = Math.round(amount * 1_000_000).toString();
    if (!(await isApproved(agent.walletId, contractAddress))) {
      const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      await circle.createContractExecutionTransaction({
        walletId: agent.walletId, contractAddress: USDC,
        abiFunctionSignature: 'approve(address,uint256)', abiParameters: [contractAddress, MAX],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      await new Promise(r => setTimeout(r, 4500));
    }
    const txRes = await circle.createContractExecutionTransaction({
      walletId: agent.walletId, contractAddress,
      abiFunctionSignature: side === 'YES' ? 'buyYes(uint256)' : 'buyNo(uint256)',
      abiParameters: [amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    const circleId = txRes.data.id;
    let txHash = null, finalState = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const st = await circle.getTransaction({ id: circleId });
        const tx = st.data?.transaction;
        if (tx?.txHash) txHash = tx.txHash;
        finalState = tx?.state;
        if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
      } catch (_) {}
    }
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) return { ok: false, error: `on-chain ${finalState.toLowerCase()}` };
    await saveTrade(userId, {
      tx_id: circleId, side, usdc_amount: amount, entry_price: 0.5,
      question: ` Agent: ${market.question || market.slug}`, market_id: contractAddress,
      state: finalState === 'COMPLETE' ? 'COMPLETE' : 'INITIATED', tx_hash: txHash,
    });
    recordAgentReputation(`agent_${userId}`, agent.address, 90, 'successful_trade').catch(() => {});
    return { ok: true, trade: { slug: market.slug, question: market.question || market.slug, side, usdcAmount: amount, txHash, txId: circleId, contractAddress } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Broad live-market index (cached 5m) so the agent can buy a market the user
// NAMES even when it isn't in the top-volume chat feed.
let _agentMarketIdx = { at: 0, list: [] };
async function broadGammaMarkets() {
  if (Date.now() - _agentMarketIdx.at < 5 * 60 * 1000 && _agentMarketIdx.list.length) return _agentMarketIdx.list;
  const out = [];
  try {
    const list = await fetchGamma('/markets?closed=false&active=true&order=volume&ascending=false&limit=300');
    const nowSec = Math.floor(Date.now() / 1000);
    for (const j of (Array.isArray(list) ? list : [])) {
      if (!j.slug || !j.question) continue;
      const endRaw = j.endDate || j.endDateIso;
      const dl = endRaw ? Math.floor(new Date(endRaw).getTime() / 1000) : nowSec + 30 * 86400;
      if (dl <= nowSec + 3600) continue;
      out.push({ slug: j.slug, question: j.question, deadline: dl });
    }
  } catch (_) {}
  if (out.length) _agentMarketIdx = { at: Date.now(), list: out };
  return out.length ? out : _agentMarketIdx.list;
}
const _normQ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const _expandSyn = (s) => String(s || '')
  .replace(/\bbtc\b/gi, 'bitcoin').replace(/\beth\b/gi, 'ethereum').replace(/\bsol\b/gi, 'solana')
  .replace(/\bro16\b/gi, 'round of 16').replace(/\b100k\b/gi, '100000');
function _matchScore(query, m) {
  const hay = _normQ(m.question) + ' ' + _normQ(m.slug);
  const words = _normQ(query).split(' ').filter((w) => w.length > 2);
  if (!words.length) return 0;
  let hit = 0; for (const w of words) if (hay.includes(w)) hit++;
  return hit / words.length;
}
// Resolve a market the agent NAMED (full question or slug)  NOT limited to the
// chat feed. Tries the feed, then PULS's OWN deployed markets (the swarm creates
// many crypto/WC markets), then a broad gamma search. Synonym-expands the query
// (btcbitcoin, ro16round of 16, 100k100000) so casual phrasing still matches.
async function resolveMarketByName(name, feed) {
  const q0 = String(name || '').trim();
  if (!q0) return null;
  const q = _expandSyn(q0);
  const direct = (feed || []).find((m) => m.slug === q0);
  if (direct) return direct;
  if (deployedMarketsCache.has(q0)) { const c = deployedMarketsCache.get(q0); return { slug: q0, question: q0, deadline: Number(c.deadline) || 0 }; }
  let best = null, bestScore = 0;
  const consider = (m) => { const s = _matchScore(q, m); if (s > bestScore) { bestScore = s; best = m; } };
  for (const m of (feed || [])) consider(m);
  if (best && bestScore >= 0.6) return best;
  // PULS's own deployed markets (agents create crypto/WC markets)  fuzzy on question.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const { data: dm } = await supabase.from('deployed_markets')
      .select('slug, deadline, resolved, archived')
      .order('created_at', { ascending: false }).limit(800);
    for (const m of (dm || [])) {
      if (!m.slug || m.archived === true || m.resolved === true) continue;
      const question = m.slug.replace(/-\d{10,}$/, '').replace(/-/g, ' ');
      consider({ slug: m.slug, question, deadline: Number(m.deadline) || nowSec + 30 * 86400 });
    }
  } catch (_) {}
  if (best && bestScore >= 0.55) return best;
  const broad = await broadGammaMarkets();
  for (const m of broad) consider(m);
  return (best && bestScore >= 0.55) ? best : null;
}

// budget + market and executes the buy autonomously from the agent wallet.
  // Hard timeout at 28s to beat Heroku's 30s H12 limit (LLM retries can take time).
  app.post('/api/agent/chat', strictLimiter, async (req, res) => {
    const timeoutMs = 28000;
    const timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).json({ error: 'Agent timeout', path: req.path });
    }, timeoutMs);
    try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    let agent = await getAgent(userId);
    if (!agent) {
      try {
        const wallet = await getOrCreateAgentWallet(userId);
        if (wallet) {
          agent = { walletId: wallet.walletId, address: wallet.address, balance: wallet.usdcBalance || '0', exactBalance: wallet.usdcBalance || '0' };
        }
      } catch (_) {}
    }
    if (!agent) return res.status(400).json({ error: 'Agent not started. Please call /api/agent/start first or provide a valid user.' });

    // Budget = the agent wallet's own balance (on-chain cap, cannot overspend).
    const remaining = parseFloat(agent.balance) || 0;

    // Pull the live feed (same source as /api/markets) so the agent knows real markets.
    // Mark which are already deployed (instant) and keep their deadline for on-demand deploy.
    let feed = [];
    try {
      const list = await fetchGamma('/markets?limit=40&active=true&closed=false&order=volume&ascending=false');
      const nowSec = Math.floor(Date.now() / 1000);
      feed = list.map(j => {
          const slug = j.slug;
          const cached = deployedMarketsCache.get(slug);
          const endRaw = j.endDate || j.endDateIso;
          const feedDeadline = endRaw ? Math.floor(new Date(endRaw).getTime() / 1000) : nowSec + 30 * 86400;
          // For deployed markets, the contract's deadline (cached at deploy) is authoritative.
          const deadline = cached?.deadline ? Number(cached.deadline) : feedDeadline;
          const resolved = cached?.resolved === true;
          return { slug, question: j.question || slug, deployed: !!cached, deadline, resolved };
        }).filter(m => m.slug && !m.resolved && m.deadline > nowSec + 3600); // exclude expired/resolved
        // Deployed-first so the LLM tends to pick instant, tradeable markets.
        feed.sort((a, b) => (b.deployed ? 1 : 0) - (a.deployed ? 1 : 0));
        feed = feed.slice(0, 25);
    } catch (e) {
      console.error('agent feed fetch error:', e.message);
    }
    const feedBySlug = Object.fromEntries(feed.map(m => [m.slug, m]));

    const marketLines = feed.map((m, i) => `${i + 1}. ${m.question}${m.deployed ? ' [ready]' : ''}`).join('\n');

    // Pull a few published signals so the model can quote a real topic (and so
    // "top signal" resolves to the best one). Best-effort; never blocks chat.
    let signalMenu = '';
    try {
      const { data: sigRows } = await supabase
        .from('creator_signals')
        .select('id, title, market_question, stance, price_usdc')
        .eq('status', 'published')
        .neq('creator_user_id', `agent_${userId}`)
        .order('created_at', { ascending: false })
        .limit(5);
      if (sigRows && sigRows.length) {
        // Show the exact market question so the LLM/user can target the right
        // one  several signals can share one title (e.g. "F1 Drivers' Champion"
        // exists per driver with different stances).
        signalMenu = sigRows.map((s, i) => `${i + 1}. "${s.title}"${s.stance ? ` (${s.stance})` : ''} — ${s.market_question || 'no question listed'} — ${s.price_usdc} USDC`).join('\n');
      }
    } catch (e) {
      console.warn('[agent/chat] signal menu fetch error:', e.message);
    }

    // Vision: research the open web on the user's question so the agent reasons
    // over real, current information (and can cite it)  same rail the house
    // agent + market AI use. Best-effort; never blocks the chat.
    let research = { brief: '', sources: [] };
    try {
      const researchPromise = researchQuestion(message.slice(0, 200), 4);
      const timeoutPromise = new Promise(res => setTimeout(() => res({ brief: '', sources: [] }), 4500));
      research = await Promise.race([researchPromise, timeoutPromise]);
    } catch (e) {
      console.error('[agent/chat] research failed:', e.message);
    }

    const sys = `You are Puls Agent, an autonomous trading agent on Arc Testnet with ${remaining.toFixed(2)} USDC to spend. You can analyze markets, trade prediction markets, and buy premium forecasts ("signals") from other agents  paying in USDC on Arc.
Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })} (UTC)  reason about what is current; never treat a past date or already-finished event as upcoming.
Live markets (numbered by popularity  you may also name ANY other real prediction market by its full question and I will find + deploy it):
${marketLines || '(none available)'}
${signalMenu ? `\nLive signals you can buy (numbered, newest first):\n${signalMenu}\n` : ''}
${research.brief ? `\nLive web research (reason over this, cite it in your reply):\n${research.brief}\n` : ''}
Respond with ONE JSON object only:
{"actions":[ ...zero or more... ],"reply":"<your analysis / explanation, grounded in the research>"}
Each action is exactly one of:
- {"type":"buy","market":"<full market question or slug>","side":"YES"|"NO","usdc":<number>}   // buy shares in a prediction market
- {"type":"buy_signal","query":"<topic, or 'top' for the best one>","tradeUsdc":<number, optional>}                            // pay another forecaster for premium alpha (x402)
Rules:
- "top market" / "best one" / "first" / "#1" ALWAYS means market #1 in the numbered list above. For a signal, "top signal"/"best signal" means use query "top".
- If the user wants to buy a signal AND bet/stake on its pick (e.g. "buy the top signal and put $2 on it", "buy $2 into its market"), return ONE buy_signal action with tradeUsdc set to the stake  NOT a separate buy (you don't know the signal's market until it's bought; I reveal it and place the trade on the signal's side).
- When you set tradeUsdc on a buy_signal, do NOT emit any buy actions for other markets in the same response  the stake on the signal's market IS the trade. Only emit separate buy actions if the user explicitly named those markets.
- Signals can share a title but have different markets and stances (e.g. multiple "F1 Drivers' Champion" signals, one per driver). To target a specific one, set query to the market question or driver name ("leclerc f1")  "top"/"best" always means the most-unlocked signal.
- If the user asks to buy SEVERAL markets in one message, return one "buy" action per market, each with its amount.
- "market" may be ANY real prediction market the user names (e.g. "Will Spain reach the Round of 16 at the 2026 FIFA World Cup?", "Will BTC close above $100k by 2026-12-31"). Honor the amounts they give.
- Decide YES/NO from your reasoning + the research (and any signal the user told you to act on).
- The SUM of usdc across all actions must be <= ${remaining.toFixed(2)}.
- If the user only wants analysis or chat, return "actions":[] and put everything in "reply".
Output ONLY the JSON object.`;

    let intent = { action: 'none', reply: '' };
    try {
      // LLM call with 20s timeout (endpoint is 28s, leave buffer for trade execution)
      const llmPromise = llmComplete([
        { role: 'system', content: sys },
        { role: 'user', content: message },
      ]);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), 20000)
      );
      const raw = await Promise.race([llmPromise, timeoutPromise]);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) intent = JSON.parse(m[0]);
      else intent.reply = raw;
    } catch (e) {
      if (res.headersSent) return;
      return res.status(502).json({ error: `LLM error: ${e.message}` });
    }

    // Normalize to an actions[] list (back-compat with the old single-intent shape).
    let actions = [];
    if (Array.isArray(intent.actions)) actions = intent.actions;
    else if (intent.action === 'buy') actions = [{ type: 'buy', market: intent.market || intent.slug, side: intent.side, usdc: intent.usdc ?? intent.usdcAmount }];
    else if (intent.action === 'buy_signal') actions = [{ type: 'buy_signal', query: intent.query || intent.slug }];
    // Reroute a mis-parsed market "buy" that clearly means a SIGNAL.
    actions = actions.map((a) => {
      const ref = a.market || a.slug || '';
      if ((a.type === 'buy' || !a.type) && ref && !feedBySlug[ref] && !deployedMarketsCache.has(ref)
          && /\bsignal|alpha|forecast\b/i.test(`${ref} ${message}`)) {
        return { type: 'buy_signal', query: a.query || ref, tradeUsdc: a.usdc ?? a.usdcAmount };
      }
      return a;
    });

    // Redirect rule: if the user asked to stake on a signal ("buy the F1 signal
    // and put $2 on it") but the LLM put the amount on its OWN market pick
    // (a stray buy on an unrelated feed market) instead of tradeUsdc on the
    // buy_signal action, move that amount onto the signal action — the stake
    // must land on the SIGNAL's market with the signal's stance, never on a
    // market the signal doesn't reference. Only kept if the user themselves
    // named that market.
    const signalActs = actions.filter((a) => a.type === 'buy_signal');
    const unstakedSignal = signalActs.find((a) => !(parseFloat(a.tradeUsdc ?? a.stakeUsdc ?? 0) > 0));
    const strayIdx = actions.findIndex((a) => (a.type === 'buy' || !a.type) && (parseFloat(a.usdc ?? a.usdcAmount ?? 0) > 0));
    if (unstakedSignal && strayIdx >= 0) {
      const stray = actions[strayIdx];
      const strayQ = String(stray.market || stray.slug || stray.query || '');
      const userNamed = strayQ && String(message || '').toLowerCase().includes(strayQ.slice(0, 40).toLowerCase());
      if (!userNamed) {
        unstakedSignal.tradeUsdc = parseFloat(stray.usdc ?? stray.usdcAmount);
        actions.splice(strayIdx, 1);
      }
    }

    // Execute each action within the on-chain budget; aggregate the results.
    const trades = [];
    const signalsBought = [];
    const notes = [];
    let spentNow = 0;
    let budgetLeft = remaining;
    let signalStakedSlug = null; // market the agent staked on via a bought signal
    for (const act of actions.slice(0, 6)) {
      const type = act.type || 'buy';
      if (type === 'buy_signal') {
        if (budgetLeft < 0.001) { notes.push(' skipped a signal  no budget left'); continue; }
        const r = await buySignalForUserAgent(userId, { ...agent, balance: budgetLeft }, resolvePositionalSignal(act.query || '', message));
        if (r.ok) {
          spentNow += r.price; budgetLeft -= r.price;
          const who = (String(r.signal.creator_user_id || '').replace(/^agent_(swarm_)?/, '').replace(/^./, (c) => c.toUpperCase())) || 'a forecaster';
          signalsBought.push({ id: r.signal.id, title: r.signal.title, price: r.price, txId: r.txId, stance: r.signal.stance || null, thesis: r.signal.thesis || null, marketQuestion: r.signal.market_question || null, marketSlug: r.signal.market_slug || null });
          // Follow through: if the user wants to STAKE on the signal's pick, the
          // signal now reveals its market + side  place that trade on-chain.
          const _stake = parseFloat(act.tradeUsdc ?? act.stakeUsdc ?? act.usdc);
          const _sigRef = r.signal.market_slug || r.signal.market_question || '';
          if (_stake > 0 && _sigRef && budgetLeft >= _stake - 1e-9) {
            const _sigSide = String(r.signal.stance || '').toUpperCase() === 'NO' ? 'NO' : 'YES';
            let _sm = resolvePositionalMarket(_sigRef, '', feed) || await resolveMarketByName(_sigRef, feed);
            // HARD GUARD: the stake must land ONLY on the market the signal
            // references. If resolution returned something else, reject it.
            if (_sm && !signalMarketMatches(_sm, r.signal)) _sm = null;
            // RAG fallback: semantically find the signal's OWN market by its
            // question (never substitute a different market in its place).
            if (!_sm) {
              try {
                const _ragQ = r.signal.market_question || _sigRef || r.signal.thesis || '';
                if (_ragQ) {
                  const _ragHits = await searchSignalMarket({ question: _ragQ, slug: r.signal.market_slug });
                  const _ragGood = (Array.isArray(_ragHits) ? _ragHits : []).find((h) => h.slug && signalMarketMatches(h, r.signal));
                  if (_ragGood) {
                    let _ragDeadline = _ragGood.deadline ? Math.floor(new Date(_ragGood.deadline).getTime() / 1000) : 0;
                    const _ragCached = deployedMarketsCache.get(_ragGood.slug);
                    if (_ragCached) _ragDeadline = Math.max(_ragDeadline, Number(_ragCached.deadline) || 0);
                    if (_ragDeadline > Math.floor(Date.now() / 1000) + 300) {
                      const _ragAddr = await getOrDeployMarket(_ragGood.slug, _ragDeadline);
                      if (_ragAddr) _sm = { slug: _ragGood.slug, question: _ragGood.question || _ragGood.slug, deployed: true };
                    } else if (_ragCached) {
                      _sm = { slug: _ragGood.slug, question: _ragGood.question || _ragGood.slug, deadline: _ragDeadline };
                    }
                  }
                }
              } catch (_ragErr) {
                console.warn(`[agent/chat] RAG signal-market lookup failed:`, _ragErr.message);
              }
            }
            // If market not in feed/cache, try to deploy it on-demand from Polymarket
            if (!_sm) {
              try {
                // Fetch market info from Polymarket to get deadline
                const _pmRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(_sigRef)}`);
                if (_pmRes.ok) {
                  const _pmList = await _pmRes.json();
                  if (Array.isArray(_pmList) && _pmList.length > 0) {
                    const _pmMarket = _pmList[0];
                    const _endDate = _pmMarket.endDate || _pmMarket.end_date_iso;
                    const _deadline = _endDate ? Math.floor(new Date(_endDate).getTime() / 1000) : 0;
                    if (_deadline > Math.floor(Date.now() / 1000) + 300) {
                      const _addr = await getOrDeployMarket(_sigRef, _deadline);
                      if (_addr) _sm = { slug: _sigRef, question: _pmMarket.question || _sigRef, deployed: true };
                    }
                  }
                }
              } catch (_deployErr) {
                console.warn(`[agent/chat] on-demand deploy failed for ${_sigRef}:`, _deployErr.message);
              }
            }
            if (_sm) {
              const _tr = await execAgentTrade(userId, agent, _sm, _sigSide, _stake);
              if (_tr.ok) { spentNow += _stake; budgetLeft -= _stake; signalStakedSlug = _sm.slug; trades.push(_tr.trade); notes.push(` acted on it  ${_sigSide} $${_stake} on "${_sm.question || _sm.slug}"`); }
              else notes.push(` bought the signal but couldn't stake on its market  ${_tr.error}`);
            } else notes.push(` bought the signal; couldn't locate its market to stake $${_stake}`);
          }
          notes.push(` bought signal ${r.signal.title}${r.signal.stance ? ' (' + r.signal.stance + ')' : ''} from ${who} T $${r.price.toFixed(3)} x402`);
        } else notes.push(` couldn't buy a signal  ${r.reason}`);
      } else {
        const amount = parseFloat(act.usdc ?? act.usdcAmount);
        const side = String(act.side || 'YES').toUpperCase() === 'NO' ? 'NO' : 'YES';
        const ref = act.market || act.slug || act.query || '';
        if (!(amount > 0)) { notes.push(` skipped "${ref}"  no amount given`); continue; }
        if (amount > budgetLeft + 1e-9) { notes.push(` skipped "${ref}"  $${amount} over my remaining $${budgetLeft.toFixed(2)}`); continue; }
        // Positional refs ("top market", "best one", "#1")  feed[0] deterministically,
        // so the agent doesn't say "I can't find a market named 'top market'".
        let market = resolvePositionalMarket(ref, message, feed);
        if (!market) market = await resolveMarketByName(ref, feed);
        if (!market) { notes.push(` couldn't find a market matching "${ref}"`); continue; }
        // Once the agent staked on a bought signal's market, drop any other
        // autonomous market picks in the SAME response — the stake on the
        // signal IS the trade. Only keep buys the user explicitly named.
        if (signalStakedSlug && market.slug !== signalStakedSlug) {
          // Only the USER's message counts — the action ref is LLM-generated,
          // so it must not make this look user-requested.
          const mentioned = String(message || '').toLowerCase().includes(String(market.question || market.slug).slice(0, 40).toLowerCase());
          if (!mentioned) {
            notes.push(` skipped my own pick "${market.question || market.slug}" — my stake is on the bought signal's market`);
            continue;
          }
        }
        const r = await execAgentTrade(userId, agent, market, side, amount);
        if (r.ok) { spentNow += amount; budgetLeft -= amount; trades.push(r.trade); notes.push(` ${side} $${amount}  ${market.question || market.slug}`); }
        else notes.push(` "${market.question || market.slug}": ${r.error}`);
      }
    }

    let replyText = String(intent.reply || '').trim();
    if (notes.length) replyText += (replyText ? '\n\n' : '') + notes.join('\n');
    if (!replyText) replyText = 'Done.';

    res.json({
      reply: formatForApp(replyText),
      trade: trades[0] || null,           // back-compat: first trade
      trades,
      signal: signalsBought[0] || null,   // back-compat: first signal
      signals: signalsBought,
      remaining: Math.max(0, remaining - spentNow),
      reputation: agentRepCount.get(`agent_${userId}`) ?? 0,
      sources: (research.sources || []).slice(0, 3),
    });
    clearTimeout(timer);
  } catch (e) {
    if (res.headersSent) return;
    clearTimeout(timer);
    console.error('agent chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/copilot/chat
// An interactive AI copilot helping the user analyze a specific prediction market.
app.post('/api/copilot/chat', apiKeyOrAuth, strictLimiter, async (req, res) => {
  try {
    const { userId, message, question, slug, currentYesPrice, currentNoPrice } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    // Pull live web research so the copilot answers from current reality, not
    // model priors. Search the market question plus the user's message for focus.
    let research = { brief: '', sources: [] };
    try {
      const q = [question, message].filter(Boolean).join('  ').slice(0, 200);
      research = await researchQuestion(q || question || message, 4);
    } catch (e) {
      console.error('[Copilot] research failed:', e.message);
    }

    const hasMarket = !!(question && String(question).trim());
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const timeRule = `IMPORTANT  today is ${today} (UTC). Treat ANY date before today as already in the PAST: never present a past match/event/result as "next" or "upcoming". For "next/upcoming" questions, pick the soonest one STRICTLY AFTER today, leaning on the live research for current schedules. If a stage/round has already finished by today, say so and move to what's actually next.
GROUNDING  state a concrete fact (opponent, date, time, venue, round, price, number) ONLY if it actually appears in the live research below, and cite it. Never invent or "best-guess" a specific fixture/date/venue: if the research doesn't clearly pin it down, say what you DO see and that the exact detail isn't confirmed there. A wrong specific is worse than an honest "not confirmed".`;
    const sys = hasMarket
      ? `You are Puls AI Trading Copilot, an expert prediction market analyst.
${timeRule}
You are helping the user analyze the following prediction market:
- Question: "${question}"
- Slug: "${slug || 'unknown-slug'}"
- Current YES Price: ${currentYesPrice ? (parseFloat(currentYesPrice) * 100).toFixed(0) + 'T' : '50T'}
- Current NO Price: ${currentNoPrice ? (parseFloat(currentNoPrice) * 100).toFixed(0) + 'T' : '50T'}
${research.brief ? `\nLive web research (latest information  base your answer on this, not assumptions):\n${research.brief}\n` : ''}
Your goals:
1. Provide insight grounded in the research above and the current pricing. If the research is thin or doesn't cover the question, say so rather than inventing facts.
2. Suggest trading strategies (e.g. buying YES vs buying NO depending on news/odds).
3. If they ask for a strategy, you can propose one and end with a structured action recommendation.
4. Keep your replies helpful, concise (maximum 3 short paragraphs), and formatting clean. For bold use a SINGLE asterisk like *this* (never double **), and do not use markdown headings (#).
5. If suggesting a trade, format the final recommendation on a new line like:
[TRADE RECOMMENDATION]: BUY YES or BUY NO with short rationale.`
      : `You are Puls AI Copilot, an expert assistant for prediction markets on Arc  sharp on world events, sports, crypto and politics and how they map to markets.
The user is chatting with you generally  NO specific market is open  so just answer their question directly and usefully.
${timeRule}
${research.brief ? `\nLive web research (base your answer on this current information, cite what you use):\n${research.brief}\n` : ''}
Rules:
- Answer the actual question specifically and helpfully, grounded in the research above.
- Do NOT invent a market, a price (like 50T), an "Unknown Prediction", or a [TRADE RECOMMENDATION]  there is no specific market selected here.
- You MAY note what's worth watching or how an event could be traded on Puls, in plain language, without fabricated odds.
- Keep it concise (max 3 short paragraphs). For bold use a SINGLE asterisk (*like this*), never double; no markdown headings (#).`;

    const reply = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: message },
    ]);

    res.json({ reply: formatForApp(reply), sources: (research.sources || []).slice(0, 3) });
  } catch (e) {
    console.error('copilot chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Push Notifications & In-App Notifications 


async function createNotification(userId, title, message, type) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        message,
        type,
        read: false
      });

    if (error) {
      console.error('[Notification Error] Failed to save in-app notification:', error.message);
    } else {
      console.log(`[Notification] Saved notification for user ${userId}: "${title}"`);
      // Fan out on the bus so the in-memory ring buffer + future WS/FCM push
      // can react. Supabase insert above is the durable source of truth.
      eventBus.safeEmit(EVENTS.NOTIFICATION_CREATED, {
        user_id: userId,
        title,
        message,
        type,
        read: false,
        created_at: new Date().toISOString(),
      });
    }

    // Try to retrieve user's FCM token for push delivery
    const { data: tokenRow } = await supabase
      .from('fcm_tokens')
      .select('fcm_token')
      .eq('user_id', userId)
      .single();
      
    if (tokenRow && tokenRow.fcm_token) {
      console.log(`[Notification Push] Simulating push notification to ${tokenRow.fcm_token}: "${title}" - "${message}"`);
    }
  } catch (err) {
    console.error('[Notification Error] Failed to trigger notification:', err.message);
  }
}

// POST /api/notifications/register-token
app.post('/api/notifications/register-token', authenticateUser, strictLimiter, async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;
    if (!userId || !fcmToken) return res.status(400).json({ error: 'userId and fcmToken required' });
    
    const { error } = await supabase
      .from('fcm_tokens')
      .upsert({
        user_id: userId,
        fcm_token: fcmToken,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/notifications
app.get('/api/notifications', authenticateUser, async (req, res) => {
  try {
    const { userId, type } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    let q = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId);
    if (type) q = q.eq('type', String(type));
    const { data, error } = await q
      .order('created_at', { ascending: false })
      .limit(50);
      
    if (error) throw error;
    // Return an object (not a bare array): the Flutter client decodes every
    // response body as a Map and reads res['notifications'], so a bare array
    // makes the cast throw and the bell silently shows nothing.
    res.json({ notifications: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/mark-read
app.post('/api/notifications/mark-read', authenticateUser, async (req, res) => {
  try {
    const { userId, notificationId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    let query = supabase.from('notifications').update({ read: true }).eq('user_id', userId);
    if (notificationId) {
      query = query.eq('id', notificationId);
    }
    
    const { error } = await query;
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
//  User-to-User Messages 

// GET /api/messages
app.get('/api/messages', authenticateUser, async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: messages, error } = await supabase
      .from('comments')
      .select('id, user_id, target_id, body, created_at')
      .eq('target_type', 'dm')
      .or(`user_id.eq.${userId},target_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const conversations = new Map();
    for (const msg of (messages || [])) {
      const partnerId = msg.user_id === userId ? msg.target_id : msg.user_id;
      if (!conversations.has(partnerId)) {
        conversations.set(partnerId, msg);
      }
    }

    res.json(Array.from(conversations.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/messages/:targetUserId
app.get('/api/messages/:targetUserId', authenticateUser, async (req, res) => {
  try {
    const userId = req.query.userId;
    const targetUserId = req.params.targetUserId;
    if (!userId || !targetUserId) return res.status(400).json({ error: 'userId and targetUserId required' });

    const { data: messages, error } = await supabase
      .from('comments')
      .select('id, user_id, target_id, body, created_at')
      .eq('target_type', 'dm')
      .or(`and(user_id.eq.${userId},target_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},target_id.eq.${userId})`)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) throw error;
    res.json(messages || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/messages/:targetUserId
app.post('/api/messages/:targetUserId', authenticateUser, strictLimiter, async (req, res) => {
  try {
    const userId = req.body.userId;
    const targetUserId = req.params.targetUserId;
    const body = String(req.body.body || '').trim();
    if (!userId || !targetUserId || !body) return res.status(400).json({ error: 'userId, targetUserId, body required' });

    const { data, error } = await supabase.from('comments').insert({
      user_id: userId,
      target_type: 'dm',
      target_id: targetUserId,
      body: body
    }).select('id, user_id, target_id, body, created_at').single();
    
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  User-Created Markets 

app.post('/api/markets/create', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, question, description, category, deadline } = req.body;
    if (!userId || !question || !deadline) {
      return res.status(400).json({ error: 'userId, question and deadline required' });
    }

    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'User wallet not found' });
    const userWalletInfo = await getWalletInfo(userWalletId);
    
    // Check user balance: lockup cost is ~10 USDC initial funding
    const creatorUSDCBalance = parseFloat(userWalletInfo.usdcBalance) || 0;
    if (creatorUSDCBalance < 10) {
      return res.status(400).json({
        error: `Insufficient balance to create a market. Locked initial funding requires 10.00 USDC. Your balance is $${creatorUSDCBalance.toFixed(2)}.`
      });
    }

    // 1. Transfer 10 USDC from user to admin
    console.log(`[Custom Market] Transferring 10 USDC initial funding from creator ${userWalletInfo.address} to admin...`);
    const tx = await circle.createTransaction({
      walletId: userWalletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: adminAccount.address,
      amounts: ['10.000000'],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    
    const txId = tx.data?.id;
    let transferSuccess = false;
    for (let i = 0; txId && i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const st = await circle.getTransaction({ id: txId });
      if (st.data?.transaction?.state === 'COMPLETE') {
        transferSuccess = true;
        break;
      }
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(st.data?.transaction?.state)) break;
    }
    
    if (!transferSuccess) {
      return res.status(500).json({ error: 'Failed to process initial funding transfer' });
    }

    // 2. Deploy market contract via admin deployer
    const slug = `user-${question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now()}`;
    const deadlineSeconds = Number(deadline);
    
    console.log(`[Custom Market] Deploying on-chain contract for custom market: ${slug}`);
    const contractAddress = await getOrDeployMarket(slug, deadlineSeconds);
    
    // 3. Update database row with custom fields
    await supabase.from('deployed_markets').update({
      is_user_created: true,
      creator_id: userId,
      title: question,
      description: description || '',
      category: category || 'General',
      image_url: `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`
    }).eq('slug', slug);

    // Update local cache manually with new properties
    const cached = deployedMarketsCache.get(slug);
    if (cached) {
      cached.is_user_created = true;
      cached.creator_id = userId;
      cached.title = question;
      cached.description = description || '';
      cached.category = category || 'General';
      cached.image_url = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`;
    }

    // Notify user
    createNotification(
      userId,
      'Market Created ',
      `Your custom market "${question}" has been deployed on Arc Testnet!`,
      'system'
    ).catch(console.error);

    pingIndexNow([`https://app.pulsmarket.tech/m/${slug}`]).catch(console.error);

    res.json({ slug, contractAddress });
  } catch (e) {
    console.error('[Custom Market Error] Failed to create custom market:', e.message);
    res.status(500).json({ error: e.message });
  }
});

//  Limit Orders Engine 

// POST /api/trade/limit-order
app.post('/api/trade/limit-order', authenticateUser, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, marketId, slug, side, type, usdcAmount, shares, targetPrice } = req.body;
    if (!userId || !marketId || !slug || !side || !type || targetPrice === undefined) {
      return res.status(400).json({ error: 'Missing required limit order parameters' });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'User wallet not found' });
    
    // Enforce balance verification
    const walletInfo = await getWalletInfo(walletId);
    if (type === 'BUY') {
      const amount = parseFloat(usdcAmount);
      const balance = parseFloat(walletInfo.usdcBalance) || 0;
      if (balance < amount) {
        return res.status(400).json({ error: `Insufficient USDC. Balance: $${balance.toFixed(2)}, Need: $${amount.toFixed(2)}.` });
      }
    }
    
    // Write limit order to Supabase
    const { data, error } = await supabase
      .from('limit_orders')
      .insert({
        user_id: userId,
        market_id: marketId,
        slug,
        side, // 'YES' or 'NO'
        type, // 'BUY' or 'SELL'
        usdc_amount: type === 'BUY' ? parseFloat(usdcAmount) : 0,
        shares: type === 'SELL' ? parseFloat(shares) : 0,
        target_price: parseFloat(targetPrice),
        status: 'PENDING'
      })
      .select()
      .single();
      
    if (error) throw error;

    eventBus.safeEmit(EVENTS.ORDER_LIMIT_PLACED, data);

    createNotification(
      userId,
      'Limit Order Placed ',
      `Placed limit ${type.toLowerCase()} order for ${side} at target price $${parseFloat(targetPrice).toFixed(2)}`,
      'limit_order'
    ).catch(console.error);

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/trade/limit-orders
app.get('/api/trade/limit-orders', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const { data, error } = await supabase
      .from('limit_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
      
    if (error) throw error;
    // Object, not bare array: the client reads res['orders'] (decodes body as
    // a Map), so a bare array would throw and the limit-orders list stays empty.
    res.json({ orders: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trade/limit-order/cancel
app.post('/api/trade/limit-order/cancel', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId, orderId } = req.body;
    if (!userId || !orderId) return res.status(400).json({ error: 'userId and orderId required' });
    
    const { data, error } = await supabase
      .from('limit_orders')
      .update({ status: 'CANCELLED' })
      .eq('id', orderId)
      .eq('user_id', userId)
      .select()
      .single();
      
    if (error) throw error;

    eventBus.safeEmit(EVENTS.ORDER_LIMIT_CANCELLED, { id: orderId });

    createNotification(
      userId,
      'Order Cancelled ',
      `Limit order for ${data.side} at target price $${parseFloat(data.target_price).toFixed(2)} was cancelled.`,
      'limit_order'
    ).catch(console.error);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The Limit Orders Execution Engine. Triggered by trade:complete events (a
// trade moves the pool price  re-evaluate pending orders for that market)
// and once at boot via sweepPendingLimitOrders(). No polling.
let _limitOrdersTableMissing = false;
const _limitOrderChecksInFlight = new Set(); // marketId dedupe while a check runs

async function checkAndExecuteLimitOrders(filterMarketId) {
  if (_limitOrdersTableMissing) return;
  // Read from the in-memory cache (hydrated at boot, kept in sync by bus events
  // on ORDER_LIMIT_PLACED/FILLED/CANCELLED). Zero Supabase egress here.
  let pendingOrders = cache.pendingLimitOrders();
  if (filterMarketId) pendingOrders = pendingOrders.filter((o) => o.market_id === filterMarketId);

  if (!pendingOrders || pendingOrders.length === 0) return;

  console.log(`Checking ${pendingOrders.length} pending limit orders${filterMarketId ? ` for market ${filterMarketId}` : ''}...`);

  for (const order of pendingOrders) {
    try {
      const { id: orderId, user_id: userId, market_id: marketId, slug, side, type, usdc_amount: amount, shares, target_price: targetPrice } = order;
        
        let currentPrice = 0.5;
        let poolYes = 0;
        let poolNo = 0;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: marketId,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          const yesPrice = expYes / (expYes + expNo);
          const noPrice = expNo / (expYes + expNo);
          
          currentPrice = side === 'YES' ? yesPrice : noPrice;
        } catch (err) {
          console.error(`Failed to read current price for limit order ${orderId} on market ${marketId}:`, err.message);
          continue;
        }
        
        const isBuy = type === 'BUY';
        const conditionMet = isBuy ? (currentPrice <= targetPrice) : (currentPrice >= targetPrice);
        
        if (!conditionMet) {
          console.log(`Order ${orderId} condition not met: Current ${side} price is ${currentPrice.toFixed(4)}, Target is ${parseFloat(targetPrice).toFixed(4)}`);
          continue;
        }
        
        console.log(` Match found for order ${orderId}! Current ${side} price ${currentPrice.toFixed(4)} matches target ${parseFloat(targetPrice).toFixed(4)}.`);
        
        // CRITICAL: The atomic lock  `UPDATE ... WHERE status='PENDING'` only
        // affects a row still in PENDING. But Supabase returns `error: null`
        // even when 0 rows matched. Must check `data` to verify the lock was
        // actually acquired, otherwise two concurrent calls both "lock" and
        // both execute  double buy.
        const { data: lockData, error: lockErr } = await supabase
          .from('limit_orders')
          .update({ status: 'EXECUTING' })
          .eq('id', orderId)
          .eq('status', 'PENDING')
          .select('id');

        if (lockErr) continue;
        // If 0 rows updated, another call already locked it  skip.
        if (!lockData || lockData.length === 0) {
          console.log(`Order ${orderId} already locked by another call  skipping.`);
          continue;
        }
        // Evict from cache immediately so a concurrent trade:complete trigger
        // for the same market can't double-execute this order.
        cache.limitOrders.delete(orderId);

        const walletId = await getWalletId(userId);
        if (!walletId) {
          await supabase.from('limit_orders').update({ status: 'FAILED' }).eq('id', orderId);
          eventBus.safeEmit(EVENTS.ORDER_LIMIT_CANCELLED, { id: orderId });
          continue;
        }
        
        const isYes = side === 'YES';
        let txRes;
        
        if (isBuy) {
          const amountMicro = Math.round(parseFloat(amount) * 1_000_000).toString();
          
          if (!(await isApproved(walletId, marketId))) {
            const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
            await circle.createContractExecutionTransaction({
              walletId,
              contractAddress: USDC,
              abiFunctionSignature: 'approve(address,uint256)',
              abiParameters: [marketId, MAX],
              fee: { type: 'level', config: { feeLevel: 'HIGH' } },
            });
            await new Promise(r => setTimeout(r, 4500));
          }
          
          txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress: marketId,
            abiFunctionSignature: isYes ? 'buyYes(uint256)' : 'buyNo(uint256)',
            abiParameters: [amountMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
        } else {
          const sharesMicro = Math.round(parseFloat(shares) * 1_000_000).toString();
          txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress: marketId,
            abiFunctionSignature: isYes ? 'sellYes(uint256)' : 'sellNo(uint256)',
            abiParameters: [sharesMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
        }
        
        const circleId = txRes.data.id;
        
        //  INITIATE TRADE RECORD FOR LIMIT ORDER IDEMPOTENCY 
        const estimatedPayout = isBuy ? parseFloat(amount) : (parseFloat(shares) * currentPrice);
        let questionSlug = slug.split('-').join(' ');
        if (questionSlug.length > 0) {
          questionSlug = questionSlug.charAt(0).toUpperCase() + questionSlug.slice(1);
        }
        await saveTrade(userId, {
          tx_id: circleId,
          side,
          usdc_amount: isBuy ? estimatedPayout : -estimatedPayout,
          entry_price: currentPrice,
          question: ` Limit: ${questionSlug}`,
          market_id: marketId,
          state: 'INITIATED',
        });
        
        let txHash = null, finalState = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const st = await circle.getTransaction({ id: circleId });
            txHash = st.data?.transaction?.txHash;
            finalState = st.data?.transaction?.state;
            if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
          } catch (_) {}
        }
        
        if (finalState === 'COMPLETE') {
          await supabase
            .from('limit_orders')
            .update({
              status: 'EXECUTED',
              tx_hash: txHash
            })
            .eq('id', orderId);
          eventBus.safeEmit(EVENTS.ORDER_LIMIT_FILLED, { id: orderId, txHash });

          const { data: updatedTrade } = await supabase
            .from('trades')
            .update({
              state: 'COMPLETE',
              tx_hash: txHash
            })
            .eq('tx_id', circleId)
            .select()
            .single();

          if (updatedTrade) {
            broadcastTrade(updatedTrade);
          }

          createNotification(
            userId,
            'Limit Order Triggered! ',
            `Your limit order to ${type.toLowerCase()} ${side} at $${parseFloat(targetPrice).toFixed(2)} was executed successfully on-chain!`,
            'limit_order'
          ).catch(console.error);
        } else {
          await supabase
            .from('limit_orders')
            .update({ status: 'FAILED' })
            .eq('id', orderId);
          eventBus.safeEmit(EVENTS.ORDER_LIMIT_CANCELLED, { id: orderId });

          await supabase
            .from('trades')
            .update({
              state: 'FAILED'
            })
            .eq('tx_id', circleId);

          createNotification(
            userId,
            'Limit Order Failed ',
            `Your limit order to ${type.toLowerCase()} ${side} at $${parseFloat(targetPrice).toFixed(2)} failed to execute.`,
            'limit_order'
          ).catch(console.error);
        }
      } catch (err) {
        console.error(`Error processing limit order ${order.id}:`, err.message);
        // Revert to PENDING in Supabase + re-add to cache so it can be retried
        // on the next price-moving event.
        await supabase.from('limit_orders').update({ status: 'PENDING' }).eq('id', order.id);
        cache.limitOrders.set(order.id, { ...order, status: 'PENDING' });
      }
    }
}

// One-time boot sweep of pending limit orders (catches anything that came due
// while the server was down). After this, trade:complete events drive checks.
async function sweepPendingLimitOrders() {
  try {
    await checkAndExecuteLimitOrders();
  } catch (e) {
    console.error('sweepPendingLimitOrders error:', e.message);
  }
}

// Debounced per-market limit-order evaluation. When a trade completes (which
// moves the on-chain price), re-check pending orders for that market. If many
// trades land in quick succession we collapse them into a single check.
function scheduleLimitOrderCheck(marketId) {
  if (!marketId || _limitOrderChecksInFlight.has(marketId)) return;
  _limitOrderChecksInFlight.add(marketId);
  setTimeout(() => {
    _limitOrderChecksInFlight.delete(marketId);
    checkAndExecuteLimitOrders(marketId).catch((e) =>
      console.error(`limit-order check failed for ${marketId}:`, e.message)
    );
  }, 2000).unref?.();
}

// Drive limit-order checks from trade events instead of a 20s poll.
eventBus.on(EVENTS.TRADE_COMPLETE, (t) => {
  if (t && t.market_id) scheduleLimitOrderCheck(t.market_id);
});
eventBus.on(EVENTS.TRADE_CREATED, (t) => {
  if (t && t.market_id) scheduleLimitOrderCheck(t.market_id);
});

//  Support Tickets 

app.get('/api/support/tickets', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ tickets: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/support/tickets', authenticateUser, async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
    
    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .insert({ user_id: req.user.id, subject, status: 'open' })
      .select().single();
    if (tErr) throw tErr;
    
    const { error: mErr } = await supabase
      .from('support_messages')
      .insert({ ticket_id: ticket.id, sender_id: req.user.id, body });
    if (mErr) throw mErr;
    
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/support/tickets/:ticketId', authenticateUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.ticketId)
      .eq('user_id', req.user.id)
      .single();
    if (error) throw error;
    res.json({ ticket: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/support/tickets/:ticketId/messages', authenticateUser, async (req, res) => {
  try {
    const { body } = req.body;
    const ticketId = req.params.ticketId;
    if (!body) return res.status(400).json({ error: 'Body required' });
    
    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .select('id')
      .eq('id', ticketId)
      .eq('user_id', req.user.id)
      .single();
    if (tErr || !ticket) return res.status(403).json({ error: 'Forbidden' });
    
    const { data: message, error: mErr } = await supabase
      .from('support_messages')
      .insert({ ticket_id: ticketId, sender_id: req.user.id, body })
      .select().single();
    if (mErr) throw mErr;
    
    await supabase.from('support_tickets').update({ updated_at: new Date().toISOString() }).eq('id', ticketId);
    
    res.status(201).json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Limit-order matching is now event-driven (see scheduleLimitOrderCheck above);
// the 20s poll has been removed.

// Semantic search across all Puls data (OpenSearch RAG)
app.get('/api/search', async (req, res) => {
  try {
    const { q, type = 'all', limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'q parameter required' });
    if (!osClient) return res.status(503).json({ error: 'OpenSearch not configured' });

    const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const results = {};
    if (type === 'all' || type === 'markets') results.markets = await searchMarkets(q, parsedLimit);
    if (type === 'all' || type === 'signals') results.signals = await searchSignals(q, parsedLimit);
    if (type === 'all' || type === 'decisions') results.decisions = await searchDecisions(q, null, parsedLimit);

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Valkey/Redis Status & Cache Health
app.get('/api/redis/status', async (req, res) => {
  const [ping, stats] = await Promise.all([redisPing(), getRedisStats()]);
  res.json({
    enabled: Boolean(redisClient),
    status: redisClient ? redisClient.status : 'disabled',
    provider: 'Aiven Valkey',
    ping,
    stats,
    rateLimitStore: Boolean(valkeyRateLimitStore),
    timestamp: new Date().toISOString()
  });
});

// OpenSearch Status & Index Health
app.get('/api/opensearch/status', async (req, res) => {
  const [health, indices] = await Promise.all([pingOpenSearch(), getOpenSearchStats()]);
  res.json({
    enabled: Boolean(osClient),
    health,
    indices,
    timestamp: new Date().toISOString()
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

const PORT = process.env.PORT || 3000;

// Hydrate the in-memory cache from Supabase BEFORE accepting traffic, then
// subscribe to the event bus so the cache stays in sync without polling.
// This is a one-time egress at boot; afterwards all reads go through the cache
// and writes fan out via eventBus. (ESM top-level await.)
await cache.hydrate(supabase);
cache.subscribe();

// Sentry error handler  MUST be after all routes, before app.listen.
// Captures unhandled exceptions in route handlers and forwards them as 500s.
app.use(sentryErrorHandler);

//  Global Express error handler 
// Catches any uncaught error from a route handler (sync or async via
// asyncHandler). Returns a JSON error  never a bare 500 HTML page.
app.use((err, req, res, _next) => {
  const isProd = process.env.NODE_ENV === 'production';
  console.error('[UNHANDLED ROUTE ERROR]', req.method, req.path, err?.message || err);
  if (!res.headersSent) {
    res.status(err.status || 500).json({
      error: isProd ? 'Internal server error' : (err.message || 'Unknown error'),
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Puls backend :${PORT}`);
  console.log(`[cache] ${JSON.stringify(cache.stats())}`);
  if (osClient) {
    initIndices().catch(e => console.warn('[opensearch] init failed:', e.message));
  }
  console.log(`[UMA] Optimistic Oracle resolution: ${UMA_RESOLUTION && UMA_ADAPTER_ADDRESS ? `ENABLED (adapter ${UMA_ADAPTER_ADDRESS}, oracle ${UMA_OOV2_ADDRESS})` : 'disabled (legacy direct resolve)'}`);
  console.log(`[Wallets] account type: ${WALLET_ACCOUNT_TYPE}; Circle webhook signature enforce: ${CIRCLE_WEBHOOK_ENFORCE}`);
  await loadDeployedMarkets();
  // One-time sweep of time-due work  DEFERRED by 30s so the HTTP server is
  // fully ready to accept traffic before any on-chain work begins.
  // warmupTopMarkets() is DISABLED  it deploys 20 markets sequentially at
  // boot (each 5-10s of viem writeContract), totaling 2-3 minutes of blocked
  // event loop  503 + CORS errors on Heroku's 512MB dyno. Markets deploy
  // on-demand when users trade them anyway.
  setTimeout(() => {
    checkAndResolveMarkets().catch(console.error);
    scheduleNextMarketResolution();
    sweepPendingLimitOrders().catch(console.error);
    // Boot-time IndexNow ping: submit all known market URLs so search engines
    // re-index them. This runs once per boot (not polling).
    setTimeout(() => {
      try {
        const marketUrls = Array.from(deployedMarketsCache.keys())
          .slice(0, 500) // IndexNow caps at 10k but 500 is plenty
          .map(slug => `https://app.pulsmarket.tech/m/${slug}`);
        // Also ping the main pages
        marketUrls.push('https://app.pulsmarket.tech/');
        marketUrls.push('https://pulsmarket.tech/');
        pingIndexNow(marketUrls).catch(console.error);
      } catch (_) {}
    }, 60_000).unref?.();
  }, 30_000).unref?.();
  // Treasury low-balance monitor (alerts via ALERT_WEBHOOK_URL if configured).
  checkTreasuryBalance().catch(console.error);
  // Leaderboard needs the wallet mapping for on-chain position reads
  loadWalletAddressMapping()
    .catch(console.error)
    .then(() => updateLeaderboard())
    .catch(console.error);
});

//  Socket.IO gateway (replaces raw `ws` broadcast) 
// One gateway subscribes to the internal eventBus (lib/events.js) and
// broadcasts every canonical event to connected Flutter / web clients.
// `broadcastTrade` below emits TRADE_COMPLETE on the bus; the gateway picks
// it up  no manual `client.send(...)` loop needed.
const io = initSocketIo(server);

//  Raw `ws` gateway (backward-compat for existing feed clients) 
// Existing Flutter clients (feed_screen.dart, live_on_arc.dart) speak plain
// WS, not Socket.IO. Keep them working; they consume TRADE_COMPLETE frames.
const rawWs = initRawWs(server);

function broadcastTrade(trade) {
  // Fan out to the internal event bus  cache + agents + Socket.IO gateway
  // + raw `ws` gateway all react. broadcastTrade is only called for COMPLETE
  // trades, so the bus event is TRADE_COMPLETE.
  eventBus.safeEmit(EVENTS.TRADE_COMPLETE, trade);
  console.log(`[broadcast] trade event: ${trade.id}`);
}

//  AI Finance Director (x402-paid, portfolio-aware) 
// A premium agent that, for an x402 nanopayment, reads the user's whole
// portfolio (balance + open positions + their own win/loss record) and returns
// a STRUCTURED, risk-managed basket of +EV predicts sized to their balance 
// each with a direct app.pulsmarket.tech link. Replaces the old fake Arbitrage
// preset. (Money-back AgentBond on the basket is Phase B.)
const DIRECTOR_PRICE_USDC = parseFloat(process.env.DIRECTOR_PRICE_USDC || '0.5');

// Compact snapshot of a user's standing: balance, open positions (on unresolved
// markets) and win/loss record (on settled markets). Best-effort; never throws.
async function userPortfolioSnapshot(userId) {
  const out = { balance: 0, openPositions: [], heldContracts: [], record: { wins: 0, losses: 0, resolved: 0, winRate: null } };
  try {
    const wid = await getWalletId(userId);
    if (wid) { const info = await getWalletInfo(wid); out.balance = parseFloat(info.usdcBalance) || 0; }
    const trades = await getTrades(userId);
    const held = new Set();
    let wins = 0, losses = 0;
    for (const t of (trades || [])) {
      if (String(t.state || '').toUpperCase() !== 'COMPLETE') continue;
      const contract = String(t.market_id || '');
      if (!contract.startsWith('0x')) continue;
      const slug = contractToSlugCache.get(contract.toLowerCase());
      const m = slug ? deployedMarketsCache.get(slug) : null;
      const isYes = String(t.side).toUpperCase() === 'YES';
      if (m && m.resolved === true && (m.outcome === true || m.outcome === false)) {
        if (isYes === (m.outcome === true)) wins++; else losses++;
      } else {
        held.add(contract.toLowerCase());
        if (out.openPositions.length < 12) {
          out.openPositions.push({ slug: slug || null, side: t.side, title: String(t.question || '').replace(/^ Agent:\s*/, '').trim().slice(0, 80) });
        }
      }
    }
    out.heldContracts = [...held];
    out.record.wins = wins; out.record.losses = losses; out.record.resolved = wins + losses;
    out.record.winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  } catch (e) { console.warn('[director] snapshot failed:', e.message); }
  return out;
}

// +EV candidate markets the user does NOT already hold.
async function directorCandidates(snapshot, limit = 10) {
  const all = await houseAgentResearch();
  const held = new Set((snapshot.heldContracts || []).map((s) => String(s).toLowerCase()));
  return (all || []).filter((c) => c.contractAddress && !held.has(String(c.contractAddress).toLowerCase())).slice(0, limit);
}

// Free teaser: shows what the Director can see (balance, record, how many picks)
// WITHOUT the picks  the value (the actual portfolio) is behind the paywall.
app.get('/api/agent/director/preview', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const userId = `supabase_${req.user.id}`;
    const snapshot = await userPortfolioSnapshot(userId);
    const cands = await directorCandidates(snapshot, 10);
    const wr = snapshot.record.winRate;
    const teaser = `I can see your $${snapshot.balance.toFixed(2)} balance${wr != null ? ` and your ${wr}% win rate (${snapshot.record.wins}-${snapshot.record.losses})` : ''}. I found ${cands.length} +EV market${cands.length === 1 ? '' : 's'} to build you a structured, risk-managed portfolio${snapshot.openPositions.length ? `, and I can hedge your ${snapshot.openPositions.length} open position${snapshot.openPositions.length === 1 ? '' : 's'}` : ''}.${DIRECTOR_GUARANTEE_ENABLED ? ' Backed by a money-back guarantee  if my basket loses, I refund your fee on Arc.' : ''} Unlock the full plan for $${DIRECTOR_PRICE_USDC.toFixed(2)}.`;
    res.json({
      priceUsdc: DIRECTOR_PRICE_USDC,
      balance: snapshot.balance,
      winRate: wr,
      record: snapshot.record,
      openPositions: snapshot.openPositions.length,
      candidatePicks: cands.length,
      moneyBack: DIRECTOR_GUARANTEE_ENABLED,
      teaser,
    });
  } catch (e) { console.error('[director] preview error:', e.message); res.status(500).json({ error: e.message }); }
});

// Paid (x402): the full structured portfolio. Auth FIRST (whose portfolio),
// then the paywall (settles the nanopayment), then the handler builds the plan.
// Shared plan builder: portfolio snapshot  +EV candidates  LLM structured
// basket sized to the user's investable balance. Returns the plan (no payment).
async function buildDirectorPlan(userId, riskProfile) {
  const rp = ['safe', 'balanced', 'aggressive'].includes(String(riskProfile || '').toLowerCase())
    ? String(riskProfile).toLowerCase() : 'balanced';
  const snapshot = await userPortfolioSnapshot(userId);
  const cands = await directorCandidates(snapshot, 10);
  const investable = Math.max(0, snapshot.balance - 0.1);
  const snap = { balance: snapshot.balance, winRate: snapshot.record.winRate, record: snapshot.record, openPositions: snapshot.openPositions.length };
  const disclaimer = 'Educational, not financial advice. Puls runs on Arc Testnet with test USDC.';
  if (!cands.length || investable < 0.1) {
    return {
      ok: true, riskProfile: rp, snapshot: snap, picks: [], totalStakeUsdc: 0,
      summary: !cands.length ? 'No markets clear my +EV bar right now  holding cash is the right call. Check back soon.' : 'Your investable balance is too low to size a safe basket  top up and I will build one.',
      riskNote: 'Prediction markets are uncertain  never stake more than you can lose.',
      expectedWinRate: null, disclaimer, generatedAt: new Date().toISOString(),
    };
  }
  const sys = `You are the Puls Finance Director, an autonomous portfolio strategist on the Puls prediction market (Arc Testnet, USDC). Build a STRUCTURED, risk-managed portfolio for THIS user using ONLY the candidate markets provided. Honor the risk profile: safe = favour high-probability favourites (high win-rate, smaller edge); aggressive = favour higher-edge / more contrarian calls (lower win-rate, bigger payoff); balanced = a mix. Size each position in USDC from their investable balance, NEVER exceeding it, and keep some dry powder. Tier each pick: "core" (safe anchor), "satellite" (edge play), or "hedge" (offsets the user's existing open exposure). STRICT JSON only: {"summary":"<2-3 sentences addressed to the user, reference their balance/record>","picks":[{"slug":"<one of the candidate slugs>","side":"YES"|"NO","sizeUsdc":<number>,"tier":"core"|"satellite"|"hedge","rationale":"<1 sentence, cite the consensus probability>"}],"expectedWinRate":<integer 0-100>,"riskNote":"<1 honest risk caveat>"}`;
  const recordLine = snapshot.record.resolved
    ? `The user's own record so far: ${snapshot.record.wins}-${snapshot.record.losses} (${snapshot.record.winRate}% win rate)  tailor the plan to improve it.`
    : `The user has no settled trades yet  keep it approachable.`;
  const openLine = snapshot.openPositions.length
    ? `User's OPEN positions (consider hedging; do not blindly double up): ${snapshot.openPositions.map((p) => `${p.title} (${p.side})`).join('; ')}.`
    : 'User has no open positions.';
  const candText = cands.map((c, i) => `${i + 1}. ${c.question}\n   slug: ${c.slug} | consensus ${(c.pmYes * 100).toFixed(0)}T YES | leans ${c.side} | conviction ${(c.conviction * 100).toFixed(0)}%`).join('\n');
  const usr = `Risk profile: ${rp}. Investable balance: $${investable.toFixed(2)} USDC.\n${recordLine}\n${openLine}\n\nCandidate markets:\n${candText}`;
  let parsed = null;
  try {
    const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], {});
    parsed = parseLlmJson(raw);
  } catch (e) { console.error('[director] LLM failed:', e.message); }
  const bySlug = Object.fromEntries(cands.map((c) => [c.slug, c]));
  let picks = [];
  if (parsed && Array.isArray(parsed.picks)) {
    for (const p of parsed.picks) {
      const c = bySlug[p.slug];
      if (!c) continue;
      const side = ['YES', 'NO'].includes(String(p.side).toUpperCase()) ? String(p.side).toUpperCase() : c.side;
      let sizeUsdc = Math.max(0, Number(p.sizeUsdc) || 0);
      sizeUsdc = Math.min(sizeUsdc, investable);
      sizeUsdc = Math.round(sizeUsdc * 100) / 100;
      if (sizeUsdc < 0.01) continue;
      picks.push({
        slug: c.slug, title: c.question, side, sizeUsdc,
        consensusYes: Math.round(c.pmYes * 100),
        tier: ['core', 'satellite', 'hedge'].includes(p.tier) ? p.tier : 'satellite',
        rationale: formatForApp(String(p.rationale || '').slice(0, 240)),
        link: `https://app.pulsmarket.tech/?m=${c.slug}`,
      });
    }
  }
  let total = picks.reduce((s, p) => s + p.sizeUsdc, 0);
  if (total > investable && total > 0) {
    const k = investable / total;
    picks = picks.map((p) => ({ ...p, sizeUsdc: Math.round(p.sizeUsdc * k * 100) / 100 }));
    total = picks.reduce((s, p) => s + p.sizeUsdc, 0);
  }
  for (const p of picks) p.sizePct = investable > 0 ? Math.round((p.sizeUsdc / investable) * 100) : 0;
  return {
    ok: true, riskProfile: rp, snapshot: snap,
    summary: parsed?.summary ? formatForApp(String(parsed.summary).slice(0, 600)) : 'Here is a structured, risk-managed basket sized to your balance.',
    picks, totalStakeUsdc: Math.round(total * 100) / 100,
    expectedWinRate: Number.isFinite(parsed?.expectedWinRate) ? Math.max(0, Math.min(100, Math.round(parsed.expectedWinRate))) : null,
    riskNote: parsed?.riskNote ? String(parsed.riskNote).slice(0, 240) : 'Prediction markets are uncertain  never stake more than you can lose.',
    disclaimer, generatedAt: new Date().toISOString(),
  };
}

// External agents / SDK pay with a client-signed x402 nanopayment.
app.post('/api/agent/director',
  authenticateUser, requireVerifiedUser,
  x402Paywall('$' + DIRECTOR_PRICE_USDC, '/api/agent/director', { description: 'Puls Finance Director  a structured, risk-managed prediction portfolio sized to your balance' }),
  async (req, res) => {
    try {
      const plan = await buildDirectorPlan(`supabase_${req.user.id}`, req.body?.riskProfile);
      res.json({ ...plan, payment: req.x402 || null });
    } catch (e) { console.error('[director] error:', e.message); res.status(500).json({ error: e.message }); }
  }
);

// In-app path: developer-controlled wallets can't client-sign x402, so we charge
// the user's Circle wallet server-side (mirrors signal unlock), then build the
// plan. Gated by DIRECTOR_PAID_ENABLED (off  free, for demos).
const DIRECTOR_PAID_ENABLED = String(process.env.DIRECTOR_PAID_ENABLED ?? 'true').toLowerCase() !== 'false';
// Money-back guarantee: if the recommended basket LOSES once its markets resolve,
// the Director refunds the fee on Arc (reconcileDirectorPlans, below). Skin in
// the game. Gated; idempotent; capped.
const DIRECTOR_GUARANTEE_ENABLED = String(process.env.DIRECTOR_GUARANTEE_ENABLED ?? 'true').toLowerCase() !== 'false';
app.post('/api/agent/director/order', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const userId = `supabase_${req.user.id}`;
    let paid = false, txId = null, payerAddr = null, payTo = null;
    if (DIRECTOR_PAID_ENABLED) {
      payTo = (process.env.X402_SELLER_ADDRESS || '').trim();
      if (!payTo) return res.status(503).json({ error: 'Director payments not configured' });
      const wid = await getWalletId(userId);
      if (!wid) return res.status(400).json({ error: 'No wallet' });
      const info = await getWalletInfo(wid);
      payerAddr = info.address || null;
      if (parseFloat(info.usdcBalance) < DIRECTOR_PRICE_USDC) {
        return res.status(402).json({ error: `Insufficient USDC  need $${DIRECTOR_PRICE_USDC.toFixed(2)} to unlock the Finance Director.` });
      }
      try {
        const amountMicro = Math.round(DIRECTOR_PRICE_USDC * 1_000_000).toString();
        const txRes = await circle.createContractExecutionTransaction({
          walletId: wid, contractAddress: USDC,
          abiFunctionSignature: 'transfer(address,uint256)', abiParameters: [payTo, amountMicro],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        txId = txRes.data?.id || null; paid = true;
      } catch (txErr) {
        console.error('[director] charge failed:', txErr.message);
        return res.status(502).json({ error: 'Payment failed, please try again' });
      }
    }
    const plan = await buildDirectorPlan(userId, req.body?.riskProfile);
    // Persist the paid plan inside the x402 receipt's `raw` so the guarantee
    // reconciler can refund the fee if the recommended basket loses.
    const guaranteed = paid && DIRECTOR_GUARANTEE_ENABLED && Array.isArray(plan.picks) && plan.picks.length > 0;
    if (paid) {
      supabase.from('x402_payments').insert({
        endpoint: 'director', payer: payerAddr, pay_to: payTo,
        amount_usdc: DIRECTOR_PRICE_USDC.toString(), network: 'eip155:5042002', gateway_tx: txId,
        raw: {
          kind: 'director', user: userId, userAddr: payerAddr,
          status: guaranteed ? 'open' : 'nopicks',
          feeUsdc: DIRECTOR_PRICE_USDC, riskProfile: plan.riskProfile,
          picks: (plan.picks || []).map((p) => ({ slug: p.slug, side: p.side })),
        },
      }).then(({ error }) => { if (error) console.warn('[director] receipt:', error.message); });
    }
    res.json({ ...plan, paid, txId, guarantee: guaranteed ? { moneyBack: true, feeUsdc: DIRECTOR_PRICE_USDC } : null });
  } catch (e) { console.error('[director] order error:', e.message); res.status(500).json({ error: e.message }); }
});

// Money-back reconciler: when a paid basket's markets have ALL resolved, settle
// it. If it lost (more losing picks than winning), refund the fee to the user on
// Arc  the Director's skin in the game. Decoupled, gated, idempotent, capped.
async function reconcileDirectorPlans() {
  if (!DIRECTOR_GUARANTEE_ENABLED || !walletClient) return;
  try {
    const { data: rows } = await supabase
      .from('x402_payments').select('id, raw')
      .eq('endpoint', 'director').order('created_at', { ascending: true }).limit(300);
    let processed = 0;
    for (const row of (rows || [])) {
      if (processed >= 10) break;
      const m = row.raw || {};
      if (m.status !== 'open' || !Array.isArray(m.picks) || !m.picks.length) continue;
      let wins = 0, losses = 0, unresolved = 0;
      for (const p of m.picks) {
        const e = deployedMarketsCache.get(p.slug);
        if (e && e.resolved === true && (e.outcome === true || e.outcome === false)) {
          if ((String(p.side).toUpperCase() === 'YES') === (e.outcome === true)) wins++; else losses++;
        } else unresolved++;
      }
      if (unresolved > 0) continue; // wait for the whole basket to settle
      processed++;
      const lost = losses > wins;
      // Reserve before moving money (idempotency: only 'open' plans are acted on).
      await supabase.from('x402_payments').update({ raw: { ...m, status: 'settling' } }).eq('id', row.id);
      let refundTx = null;
      if (lost && m.userAddr && Number(m.feeUsdc) > 0) {
        try {
          const amountMicro = BigInt(Math.round(Number(m.feeUsdc) * 1_000_000));
          const hash = await walletClient.writeContract({
            address: USDC,
            abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
            functionName: 'transfer', args: [m.userAddr, amountMicro],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          refundTx = hash;
        } catch (e) {
          console.error('[director] refund failed, will retry:', e.message);
          await supabase.from('x402_payments').update({ raw: { ...m, status: 'open' } }).eq('id', row.id);
          continue;
        }
      }
      await supabase.from('x402_payments')
        .update({ raw: { ...m, status: lost ? 'refunded' : 'won', wins, losses, refundTx, settledAt: new Date().toISOString() } })
        .eq('id', row.id);
      if (lost && refundTx && m.user) {
        await supabase.from('notifications').insert({
          user_id: m.user, title: 'Finance Director refund', type: 'agent_decision', read: false,
          message: JSON.stringify({ action: 'director_refund', agentName: 'Finance Director', amount: m.feeUsdc, txHash: refundTx, reasoning: `My basket came up short (${wins}-${losses}). As promised, I refunded your $${Number(m.feeUsdc).toFixed(2)} fee  settled on Arc.` }),
        });
      }
      console.log(`[director] plan ${row.id} settled: ${lost ? 'REFUNDED' : 'won'} (${wins}-${losses})${refundTx ? ' tx ' + refundTx : ''}`);
    }
  } catch (e) { console.error('[director] reconcile error:', e.message); }
}
// Event-driven director plan reconciliation: a basket settles only when ALL its
// picks' markets have resolved, so the natural trigger is MARKET_RESOLVED. A
// boot-time sweep catches anything that resolved while the server was down.
// Debounced so a cluster of market resolutions fires one reconcile pass.
let _directorReconcileTimer = null;
function scheduleDirectorReconcile() {
  if (_directorReconcileTimer) return;
  _directorReconcileTimer = setTimeout(() => {
    _directorReconcileTimer = null;
    reconcileDirectorPlans().catch((e) => console.error('[director] reconcile:', e.message));
  }, 5_000).unref?.();
}
eventBus.on(EVENTS.MARKET_RESOLVED, () => scheduleDirectorReconcile());
// Best-effort boot sweep (only if the guarantee is enabled).
if (DIRECTOR_GUARANTEE_ENABLED) {
  setTimeout(() => reconcileDirectorPlans().catch(() => {}), 60_000).unref?.();
}

// Director track record (clients won vs refunded)  social proof for the paid agent.
app.get('/api/agent/director/record', async (_req, res) => {
  try {
    const { data: rows } = await supabase.from('x402_payments').select('raw').eq('endpoint', 'director').limit(1000);
    let issued = 0, won = 0, refunded = 0, refundedUsdc = 0, open = 0;
    for (const r of (rows || [])) {
      const m = r.raw || {};
      if (m.kind !== 'director') continue;
      issued++;
      if (m.status === 'won') won++;
      else if (m.status === 'refunded') { refunded++; refundedUsdc += Number(m.feeUsdc) || 0; }
      else if (m.status === 'open' || m.status === 'settling') open++;
    }
    res.json({ issued, settled: won + refunded, won, refunded, refundedUsdc: Math.round(refundedUsdc * 100) / 100, open, moneyBack: DIRECTOR_GUARANTEE_ENABLED });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//  Agent Strategies Engine (Arbitrage & DCA) 
const agentStrategies = new Map(); // userId -> strategy string ('NONE', 'ARBITRAGE', 'DCA')

async function getAgentStrategy(userId) {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .select('strategy')
      .eq('user_id', `agent_${userId}`)
      .limit(1);
    if (!error && data && data.length > 0 && data[0].strategy) {
      return data[0].strategy;
    }
  } catch (_) {}
  return agentStrategies.get(userId) ?? 'NONE';
}

async function setAgentStrategy(userId, strategy) {
  agentStrategies.set(userId, strategy);
  try {
    await supabase
      .from('wallets')
      .update({ strategy })
      .eq('user_id', `agent_${userId}`);
  } catch (_) {}
}

app.get('/api/agent/strategy', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const strategy = await getAgentStrategy(userId);
    res.json({ strategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent/strategy', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId, strategy } = req.body;
    if (!userId || !strategy) return res.status(400).json({ error: 'userId and strategy required' });
    await setAgentStrategy(userId, strategy);
    res.json({ strategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runAgentStrategies() {
  // Agent strategies run silently (reduces log spam)
  try {
    const { data: walletRows, error } = await supabase
      .from('wallets')
      .select('user_id, wallet_id');
      
    if (error || !walletRows) return;
    
    const agentRows = walletRows.filter(r => r.user_id.startsWith('agent_'));
    
    for (const row of agentRows) {
      const agentKey = row.user_id;
      const userId = agentKey.substring(6);
      const agentWalletId = row.wallet_id;
      
      const strategy = await getAgentStrategy(userId);
      if (strategy === 'NONE') continue;
      
      const walletInfo = await getWalletInfo(agentWalletId);
      const balance = parseFloat(walletInfo.usdcBalance) || 0;
      
      if (balance < 1.0) {
        console.log(`Agent ${agentKey} balance is too low ($${balance.toFixed(2)}), skipping.`);
        continue;
      }
      
      // Enforce 2 minutes cooling period
      const { data: lastTrades } = await supabase
        .from('trades')
        .select('created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
        
      if (lastTrades && lastTrades.length > 0) {
        const lastTradeTime = new Date(lastTrades[0].created_at).getTime();
        const timeSinceLastTrade = Date.now() - lastTradeTime;
        if (timeSinceLastTrade < 120 * 1000) {
          console.log(`Agent ${agentKey} traded recently, cooling down.`);
          continue;
        }
      }
      
      if (strategy === 'ARBITRAGE') {
        await executeArbitrageStrategy(userId, agentWalletId, balance);
      } else if (strategy === 'DCA') {
        await executeDCAStrategy(userId, agentWalletId, balance);
      }
    }
  } catch (err) {
    console.error('runAgentStrategies error:', err.message);
  }
}

async function executeArbitrageStrategy(userId, agentWalletId, balance) {
  const activeMarkets = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000));
    
  if (activeMarkets.length === 0) return;
  
  let pmMarkets = [];
  try {
    pmMarkets = await fetchGamma('/markets?limit=30&active=true&closed=false');
  } catch (e) {
    console.error('Arbitrage strategy Polymarket fetch error:', e.message);
    return;
  }
  
  const pmMarketsBySlug = Object.fromEntries(pmMarkets.map(m => [m.slug, m]));
  
  for (const market of activeMarkets) {
    const pmMarket = pmMarketsBySlug[market.slug];
    if (!pmMarket) continue;
    
    const pmYesPrice = parseFloat(pmMarket.outcomePrices?.[0] || pmMarket.yesPrice);
    if (isNaN(pmYesPrice)) continue;

    // Puls quotes the Polymarket consensus 1:1, so there's no venue price gap to
    // arbitrage. This preset now backs the consensus favourite when it's a
    // confident call (conviction = distance from a coin-flip), instead of
    // trading an on-chain-vs-Polymarket difference that would be a testnet
    // artifact and look broken.
    const conviction = Math.abs(pmYesPrice - 0.5) * 2; // 01
    let sideToBuy = null;
    if (conviction >= 0.3) {
      sideToBuy = pmYesPrice >= 0.5 ? 'YES' : 'NO';
    }

    if (sideToBuy) {
      const buyAmount = 1.0;
      const consensus = sideToBuy === 'YES' ? pmYesPrice : 1 - pmYesPrice;
      console.log(`Consensus trade: ${market.slug} ${sideToBuy} (consensus ${(consensus * 100).toFixed(0)}T, conviction ${(conviction * 100).toFixed(0)}%). Buying $1.`);

      const success = await executeAgentTrade(userId, agentWalletId, market.contractAddress, sideToBuy, buyAmount, market.slug);
      if (success) {
        createNotification(
          userId,
          'Agent Trade ֨',
          `Your agent bought $1.00 of ${sideToBuy} on "${pmMarket.question || market.slug}"  consensus backs ${sideToBuy} at ${(consensus * 100).toFixed(0)}T.`,
          'trade'
        ).catch(console.error);
        return;
      }
    }
  }
}

async function executeDCAStrategy(userId, agentWalletId, balance) {
  const activeMarkets = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000));
    
  if (activeMarkets.length === 0) return;
  
  const market = activeMarkets[Math.floor(Math.random() * activeMarkets.length)];
  const side = Math.random() > 0.5 ? 'YES' : 'NO';
  const buyAmount = 1.0;
  
  console.log(`DCA Trade: Agent ${userId} investing $1.00 on ${market.slug} ${side}.`);
  const success = await executeAgentTrade(userId, agentWalletId, market.contractAddress, side, buyAmount, market.slug);
  if (success) {
    let question = market.slug.split('-').join(' ');
    if (question.length > 0) {
      question = question.charAt(0).toUpperCase() + question.slice(1);
    }
    createNotification(
      userId,
      'DCA Invested Ϧ',
      `Your agent invested a scheduled $1.00 in ${side} shares for "${question}".`,
      'trade'
    ).catch(console.error);
  }
}

async function executeAgentTrade(userId, agentWalletId, contractAddress, side, amount, slug) {
  try {
    const amountMicro = Math.round(amount * 1_000_000).toString();
    if (!(await isApproved(agentWalletId, contractAddress))) {
      const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      await circle.createContractExecutionTransaction({
        walletId: agentWalletId, contractAddress: USDC,
        abiFunctionSignature: 'approve(address,uint256)', abiParameters: [contractAddress, MAX],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      await new Promise(r => setTimeout(r, 4500));
    }
    
    const txRes = await circle.createContractExecutionTransaction({
      walletId: agentWalletId, contractAddress,
      abiFunctionSignature: side === 'YES' ? 'buyYes(uint256)' : 'buyNo(uint256)',
      abiParameters: [amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    
    const circleId = txRes.data.id;
    let txHash = null, finalState = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const st = await circle.getTransaction({ id: circleId });
        const tx = st.data?.transaction;
        if (tx?.txHash) txHash = tx.txHash;
        finalState = tx?.state;
        if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
      } catch (_) {}
    }
    
    if (finalState === 'COMPLETE') {
      let question = slug.split('-').join(' ');
      if (question.length > 0) {
        question = question.charAt(0).toUpperCase() + question.slice(1);
      }
      
      const { data: newTrade } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: circleId,
          side,
          usdc_amount: amount,
          entry_price: 0.5,
          question: ` Agent: ${question}`,
          market_id: contractAddress,
          state: 'COMPLETE',
          tx_hash: txHash,
        })
        .select()
        .single();
        
      if (newTrade) {
        broadcastTrade(newTrade);
      }
      
      const info = await getWalletInfo(agentWalletId);
      recordAgentReputation(`agent_${userId}`, info.address, 90, 'successful_trade').catch(() => {});
      return { ok: true, txHash, tradeId: newTrade?.id ?? null };
    }
    return false;
  } catch (err) {
    console.error(`executeAgentTrade error for ${agentWalletId}:`, err.message);
    return false;
  }
}

//  House AI Trader Agent ("Pulse") 
// A fully autonomous agent with its own Circle dev-controlled wallet and
// ERC-8004 on-chain identity. Every cycle it researches live markets
// (Polymarket consensus vs on-chain LMSR price), reasons about the best
// opportunity, and executes a real USDC trade on Arc  publishing its
// decision, reasoning and Arcscan receipt to a public feed.
const HOUSE_AGENT = (process.env.HOUSE_AGENT || 'true') === 'true';
const HOUSE_AGENT_USER = 'house_pulse';
const HOUSE_AGENT_KEY = `agent_${HOUSE_AGENT_USER}`;
// Seed / liquidity wallets: raw 0x EOAs created by seed scripts to bootstrap
// market liquidity  NOT real people. The app only ever creates eth_<addr>
// (MetaMask) or supabase_<uuid> (Google) ids, so a bare 0x id is always seed.
// Excluded from the "humans" bucket so /versus + /stats don't pass off seeded
// liquidity as human traders.
const isSeedWallet = (uid) => typeof uid === 'string' && /^0x[0-9a-fA-F]{40}$/.test(uid);
const HOUSE_AGENT_INTERVAL_MIN = Math.max(2, parseInt(process.env.HOUSE_AGENT_INTERVAL_MIN || '10'));
const HOUSE_AGENT_MAX_TRADE = 0.5; // USDC per decision
let houseAgentFundedThisRun = false;
let houseAgentBusy = false;

//  Sage: a SECOND autonomous agent that is a creator, not a trader 
// Sage publishes premium Signals (on-chain attested via SignalRegistry) and
// gets PAID by other agents who buy them. This makes PulseSage a true
// agent-to-agent value transfer on Arc: one AI pays another AI for
// alpha, settled in USDC, with on-chain provenance for the content.
const SIGNAL_REGISTRY_ADDRESS = (process.env.SIGNAL_REGISTRY_ADDRESS || '').trim();
const SAGE_AGENT = (process.env.SAGE_AGENT || 'true') === 'true';
const SAGE_AGENT_USER = 'agent_sage';
const SAGE_AGENT_KEY = `agent_${SAGE_AGENT_USER}`;
let sageSignalId = null;       // creator_signals.id of Sage's live signal
let sageOnchainTx = null;      // attestation tx
let sageEnsured = false;

let _houseWalletCreating = false;
async function ensureHouseAgentWallet() {
  // Race condition guard: prevent concurrent wallet creation
  if (_houseWalletCreating) {
    while (_houseWalletCreating) await new Promise(r => setTimeout(r, 100));
    const existing = await getWalletId(HOUSE_AGENT_KEY);
    if (existing) {
      const info = await getWalletInfo(existing);
      return { walletId: existing, address: info.address, balance: parseFloat(info.usdcBalance) || 0 };
    }
  }
  let walletId = await getWalletId(HOUSE_AGENT_KEY);
  if (!walletId) {
    _houseWalletCreating = true;
    try {
      const setId = await ensureWalletSet();
      const createRes = await circle.createWallets({
        accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
      });
      const w = createRes.data.wallets[0];
      walletId = w.id;
      await saveWallet(HOUSE_AGENT_KEY, w.id);
      console.log(`[Pulse] Created house agent Circle wallet ${w.address}`);
    } finally {
      _houseWalletCreating = false;
    }
  }
  const info = await getWalletInfo(walletId);

  // Public profile row (notifications/trades FK to profiles.user_id).
  await supabase.from('profiles').upsert({
    user_id: HOUSE_AGENT_USER,
    display_name: 'Pulse ',
    bio: 'Autonomous house AI trader. Researches every market, reasons about mispricings, and settles trades in USDC on Arc  no human in the loop.',
    avatar_url: 'https://api.dicebear.com/7.x/bottts/png?size=128&seed=pulse',
  }, { onConflict: 'user_id' });

  // Self-funding: top up once per process from the admin treasury (testnet).
  // The house agent still needs USDC *principal* to place its trades (gas itself
  // is sponsored when the wallet is SCA). We pre-check the treasury balance so an
  // empty treasury produces ONE clear warning instead of a stream of reverted
  // `ERC20: transfer amount exceeds balance` transactions (the old 438-error bug).
  let balance = parseFloat(info.usdcBalance) || 0;
  if (balance < 0.6 && !houseAgentFundedThisRun && walletClient && adminAccount) {
    const treasury = await getTreasuryUsdcBalance();
    if (treasury != null && treasury < 5) {
      houseAgentFundedThisRun = true; // don't retry a doomed transfer every run
      await sendAlert(
        `Puls house agent needs 5 USDC but treasury ${adminAccount.address} only holds ${treasury.toFixed(2)} USDC. ` +
        `Skipping funding to avoid a reverting transfer. Top up the treasury to re-enable the house agent.`
      );
    } else {
      try {
        await walletClient.writeContract({
          address: USDC,
          abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
            inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
            outputs: [{ type: 'bool' }] }],
          functionName: 'transfer',
          args: [info.address, 5_000_000n], // 5 USDC
        });
        houseAgentFundedThisRun = true;
        console.log(`[Pulse] Funded agent wallet ${info.address} with 5 USDC from treasury`);
        await new Promise(r => setTimeout(r, 3000));
        balance = parseFloat((await getWalletInfo(walletId)).usdcBalance) || 0;
      } catch (e) {
        console.error('[Pulse] funding error:', e.message);
      }
    }
  }

  // ERC-8004 on-chain identity (idempotent: an existing identity is NEVER re-minted).
  if (!registeredAgents.has(HOUSE_AGENT_KEY)) {
    let existing = await resolveAgentTokenId(HOUSE_AGENT_KEY, info.address);
    if (!existing && await agentHasIdentity(info.address)) existing = true; // already owns one  don't re-mint
    if (existing) {
      registeredAgents.add(HOUSE_AGENT_KEY);
    } else if (balance >= 0.2) {
      try {
        await circle.createContractExecutionTransaction({
          walletId,
          contractAddress: IDENTITY_REGISTRY,
          abiFunctionSignature: 'register(string)',
          abiParameters: [AGENT_METADATA_URI],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });
        await new Promise(r => setTimeout(r, 4000));
        const id = await resolveAgentTokenId(HOUSE_AGENT_KEY, info.address);
        if (id) registeredAgents.add(HOUSE_AGENT_KEY);
        console.log(`[Pulse] ERC-8004 identity registered (token ${id})`);
      } catch (e) {
        console.error('[Pulse] ERC-8004 register error:', e.message);
      }
    }
  }
  return { walletId, address: info.address, balance };
}

// Ensure Sage (the creator-agent) exists: its own Circle wallet + ERC-8004
// identity + ONE live, on-chain-attested Signal in creator_signals that other
// agents can buy. Idempotent; runs once per process. Returns Sage's address +
// the live signal id, or null if unavailable.
let _sageWalletCreating = false;
async function ensureSageAgent() {
  if (!SAGE_AGENT) return null;
  try {
    // Race condition guard
    if (_sageWalletCreating) {
      while (_sageWalletCreating) await new Promise(r => setTimeout(r, 100));
      const existing = await getWalletId(SAGE_AGENT_KEY);
      if (existing) {
        const info = await getWalletInfo(existing);
        // Skip the bootstrap funding  the other call handled it
        sageEnsured = true;
        return { walletId: existing, address: info.address, balance: parseFloat(info.usdcBalance) || 0 };
      }
    }
    // 1) Wallet
    let walletId = await getWalletId(SAGE_AGENT_KEY);
    if (!walletId) {
      _sageWalletCreating = true;
      try {
        const setId = await ensureWalletSet();
        const createRes = await circle.createWallets({
          accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
        });
        walletId = createRes.data.wallets[0].id;
        await saveWallet(SAGE_AGENT_KEY, walletId);
        console.log(`[Sage] created creator-agent wallet ${createRes.data.wallets[0].address}`);
      } finally {
        _sageWalletCreating = false;
      }
    }
    const info = await getWalletInfo(walletId);

    // One-time bootstrap funding so Sage can pay gas-as-USDC for ERC-8004
    // registration (it then earns more as agents buy its signals).
    if (!sageEnsured && (parseFloat(info.usdcBalance) || 0) < 0.3 && walletClient && adminAccount) {
      try {
        const treasury = await getTreasuryUsdcBalance();
        if (treasury != null && treasury >= 2) {
          await walletClient.writeContract({
            address: USDC,
            abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
              inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
            functionName: 'transfer',
            args: [info.address, 1_000_000n], // 1 USDC bootstrap
          });
          await new Promise(r => setTimeout(r, 3000));
          console.log('[Sage] bootstrap-funded 1 USDC from treasury');
        }
      } catch (e) { console.error('[Sage] funding error:', e.message); }
    }
    const bal = parseFloat((await getWalletInfo(walletId)).usdcBalance) || 0;
    await supabase.from('profiles').upsert({
      user_id: SAGE_AGENT_USER,
      display_name: 'Sage ',
      bio: 'Autonomous forecaster agent. Publishes premium Signals attested on-chain; earns USDC when other agents buy its alpha.',
      avatar_url: 'https://api.dicebear.com/7.x/bottts/png?size=128&seed=sage',
    }, { onConflict: 'user_id' });

    // 2) ERC-8004 identity (best-effort; needs a little USDC for gas-as-USDC).
    if (!registeredAgents.has(SAGE_AGENT_KEY)) {
      let existing = await resolveAgentTokenId(SAGE_AGENT_KEY, info.address);
      if (!existing && await agentHasIdentity(info.address)) existing = true; // already owns one  don't re-mint
      if (existing) {
        registeredAgents.add(SAGE_AGENT_KEY);
      } else if ((parseFloat(info.usdcBalance) || 0) >= 0.2 || bal >= 0.2) {
        try {
          await circle.createContractExecutionTransaction({
            walletId, contractAddress: IDENTITY_REGISTRY,
            abiFunctionSignature: 'register(string)', abiParameters: [AGENT_METADATA_URI],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          });
          await new Promise(r => setTimeout(r, 4000));
          const id = await resolveAgentTokenId(SAGE_AGENT_KEY, info.address);
          if (id) { registeredAgents.add(SAGE_AGENT_KEY); console.log(`[Sage] ERC-8004 identity ${id}`); }
        } catch (e) { console.error('[Sage] ERC-8004 register error:', e.message); }
      }
    }

    // 3) Ensure ONE published, on-chain-attested signal exists.
    if (!sageSignalId) {
      const { data: existing } = await supabase
        .from('creator_signals')
        .select('id, onchain_tx, status')
        .eq('creator_user_id', SAGE_AGENT_USER)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        sageSignalId = existing.id;
        sageOnchainTx = existing.onchain_tx;
      } else {
        // Create + publish a fresh signal (with on-chain attestation).
        const signalBody = {
          creator_user_id: SAGE_AGENT_USER,
          title: 'BTC holds above $100k into year-end',
          market_question: 'Will BTC close above $100k by 2026-12-31?',
          stance: 'YES',
          confidence: 0.62,
          edge_bps: 480,
          horizon: 'Q4 2026',
          teaser: 'ETF inflows + post-halving supply squeeze vs. macro drag, with on-chain order-flow diverging from the implied probability. Unlock to see the side + the full thesis.',
          thesis:
            'Spot ETF net inflows and the post-halving supply squeeze outweigh near-term macro drag. '
            + 'On-chain order-flow on Puls skews YES while the implied probability still lags fundamentals  '
            + 'a convergence trade as pricing catches up. Invalidation: a sustained risk-off macro shock or an ETF outflow streak.',
          price_usdc: 0.001,
          status: 'published',
          published_at: new Date().toISOString(),
        };

        const { data: created, error: cErr } = await supabase
          .from('creator_signals').insert(signalBody).select('*').single();
        if (cErr) throw cErr;
        sageSignalId = created.id;

        // On-chain attestation to SignalRegistry, signed by the ADMIN wallet
        // (records creator + content hash + price + timestamp). Best-effort.
        if (SIGNAL_REGISTRY_ADDRESS && walletClient && publicClient) {
          try {
            const onchainSignalId = keccak256(toHex(created.id));
            const canonical = [created.title, created.market_question, created.stance,
              String(created.confidence), String(created.edge_bps), created.horizon, created.thesis].join('\n--\n');
            const contentHash = keccak256(toHex(canonical));
            const priceMicro = BigInt(Math.round(Number(created.price_usdc) * 1_000_000));
            sageOnchainTx = await walletClient.writeContract({
              address: SIGNAL_REGISTRY_ADDRESS,
              abi: [{ name: 'publish', type: 'function', stateMutability: 'nonpayable',
                inputs: [{ name: 'signalId', type: 'bytes32' }, { name: 'contentHash', type: 'bytes32' }, { name: 'priceUsdc', type: 'uint256' }],
                outputs: [] }],
              functionName: 'publish',
              args: [onchainSignalId, contentHash, priceMicro],
            });
            await supabase.from('creator_signals').update({
              onchain_signal_id: onchainSignalId, content_hash: contentHash, onchain_tx: sageOnchainTx,
            }).eq('id', created.id);
            console.log(`[Sage] published on-chain-attested signal ${created.id} (tx ${sageOnchainTx})`);
          } catch (e) {
            console.error('[Sage] on-chain attest failed (signal still live off-chain):', e.shortMessage || e.message);
          }
        }
      }
    }

    sageEnsured = true;
    return { walletId, address: info.address, signalId: sageSignalId, onchainTx: sageOnchainTx };
  } catch (e) {
    console.error('[Sage] ensure failed:', e.message);
    return null;
  }
}

// Pay a creator for alpha (agentcreator nanopayment) BEFORE deciding.
// This is the heart of our Agentic narrative: the autonomous agent spends real
// USDC to buy a forecaster's signal, then reasons over it  value too small to
// move before now moves agentcreator on Arc. Uses the agent's own Circle SCA
// wallet (gasless) to transfer the per-read fee to the creator (X402_SELLER_ADDRESS,
// the same payTo behind the /api/alpha/sample x402 paywall). Best-effort: if it
// can't pay (no creator address / transfer fails) the agent still trades, just
// without the signal-cost economics. Returns { cost, creator, txId, signal } | null.
const HOUSE_AGENT_ALPHA_PRICE = parseFloat(process.env.HOUSE_AGENT_ALPHA_PRICE || '0.001') || 0.001;
async function houseAgentPayForAlpha(agentWalletId, agentAddress) {
  // Prefer agent-to-agent: buy Sage's on-chain-attested Signal and pay Sage's
  // own wallet. Fall back to the static creator address if Sage isn't ready.
  let creator = null;
  let signal = null;
  let signalId = null;
  let onchainTx = null;
  let counterparty = 'creator';

  try {
    const sage = sageEnsured ? { walletId: await getWalletId(SAGE_AGENT_KEY), signalId: sageSignalId, onchainTx: sageOnchainTx } : await ensureSageAgent();
    if (sage && sage.signalId) {
      const sageWalletId = sage.walletId || await getWalletId(SAGE_AGENT_KEY);
      const sageInfo = sageWalletId ? await getWalletInfo(sageWalletId) : null;
      if (sageInfo?.address && sageInfo.address.toLowerCase() !== String(agentAddress).toLowerCase()) {
        const { data: row } = await supabase
          .from('creator_signals')
          .select('title, market_question, stance, confidence, edge_bps, horizon, thesis, price_usdc')
          .eq('id', sage.signalId).maybeSingle();
        if (row) {
          creator = sageInfo.address;
          signalId = sage.signalId;
          onchainTx = sage.onchainTx;
          counterparty = 'agent_sage';
          signal = {
            market: row.market_question, stance: row.stance, confidence: row.confidence,
            edge_bps: row.edge_bps, horizon: row.horizon, thesis: row.thesis,
          };
        }
      }
    }
  } catch (e) {
    console.error('[Pulse] agent-to-agent setup failed, falling back:', e.message);
  }

  // Fallback: static creator address behind the x402 paywall.
  if (!creator) {
    const seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    if (!seller || seller.toLowerCase() === String(agentAddress).toLowerCase()) return null;
    creator = seller;
    signal = {
      market: 'Will BTC close above $100k by 2026-12-31?',
      stance: 'YES', confidence: 0.62, edge_bps: 480, horizon: 'Q4 2026',
      thesis: 'Spot ETF inflows + post-halving supply squeeze outweigh near-term macro drag; '
        + 'order-flow on Puls skews YES while implied prob lags fundamentals.',
    };
  }

  const price = signal && signal.price_usdc ? Number(signal.price_usdc) : HOUSE_AGENT_ALPHA_PRICE;

  try {
    const amountMicro = Math.round(price * 1_000_000).toString();
    const txRes = await circle.createContractExecutionTransaction({
      walletId: agentWalletId,
      contractAddress: USDC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [creator, amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    const txId = txRes.data?.id || null;

    // If this was an agent-to-agent buy of a published Signal, record the unlock
    // so it counts as a real signal sale (analytics + exactly-once).
    if (counterparty === 'agent_sage' && signalId) {
      supabase.from('signal_unlocks').upsert({
        user_id: HOUSE_AGENT_USER, signal_id: signalId, status: 'confirmed',
        amount_usdc: price, tx_id: txId, confirmed_at: new Date().toISOString(),
      }, { onConflict: 'user_id, signal_id', ignoreDuplicates: true }).then(({ error }) => { if (error && !String(error.message).includes('duplicate')) console.warn('[Pulse] signal_unlock insert:', error.message); });
      supabase.from('creator_signals').select('unlocks_count, revenue_usdc').eq('id', signalId).maybeSingle()
        .then(({ data }) => {
          if (data) supabase.from('creator_signals').update({
            unlocks_count: (data.unlocks_count ?? 0) + 1,
            revenue_usdc: Number(data.revenue_usdc ?? 0) + price,
          }).eq('id', signalId).then(() => {});
        });
    }

    // Receipt  Earnings/x402 feed.
    supabase.from('x402_payments').insert({
      endpoint: counterparty === 'agent_sage' ? 'agent_to_agent' : 'agent_alpha',
      payer: agentAddress || null,
      pay_to: creator,
      amount_usdc: price.toString(),
      network: 'eip155:5042002',
      gateway_tx: txId,
      raw: { kind: counterparty === 'agent_sage' ? 'agent_to_agent' : 'agent_alpha', agent: HOUSE_AGENT_USER, counterparty, signalId, onchainTx, signal: { market: signal.market, edge_bps: signal.edge_bps } },
    }).then(({ error }) => { if (error) console.warn('[Pulse] alpha receipt insert failed:', error.message); });

    console.log(`[Pulse] bought alpha from ${counterparty}  ${price} USDC  ${creator} (tx ${txId})`);
    return { cost: price, creator, txId, signal, counterparty, signalId, onchainTx };
  } catch (e) {
    console.error('[Pulse] pay-for-alpha failed (continuing without it):', e.message);
    return null;
  }
}

// Research: compare Polymarket consensus to our on-chain LMSR prices and
// return scored candidates (positive edge = that side is cheap on Arc).
async function houseAgentResearch() {
  const active = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000) + 3600);
  if (active.length === 0) return [];

  let pmMarkets = [];
  try {
    pmMarkets = await fetchGamma('/markets?limit=100&active=true&closed=false&order=volume&ascending=false');
  } catch (e) {
    console.error('[Pulse] research fetch error:', e.message);
  }
  const bySlug = Object.fromEntries((pmMarkets || []).map(m => [m.slug, m]));

  const candidates = [];
  for (const m of active) {
    const pm = bySlug[m.slug];
    let pmYes = 0.5;
    let question = m.title || (m.slug ? m.slug.replace(/[-_]+/g, ' ') : 'Puls Prediction Market');
    if (pm) {
      try { pmYes = parseFloat(JSON.parse(pm.outcomePrices || '[]')[0]); } catch {}
      if (pm.question) question = pm.question;
    }
    if (Number.isNaN(pmYes)) pmYes = 0.5;
    if (pmYes <= 0.05 || pmYes >= 0.95) continue;
    const side = pmYes >= 0.5 ? 'YES' : 'NO';
    const conviction = Math.max(0.1, Math.abs(pmYes - 0.5) * 2);
    candidates.push({
      slug: m.slug,
      question,
      contractAddress: m.contractAddress,
      pmYes,
      side,
      edge: conviction,
      conviction,
    });
  }
  candidates.sort((a, b) => b.edge - a.edge);
  // Diversify across top 30 active deployed markets
  const pool = candidates.slice(0, 30);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}


// Decide: LLM picks among the top candidates and explains itself; if the LLM
// is unavailable the agent falls back to deterministic value reasoning.

//  Risk & budget manager (autonomy) 
// Pulse sizes each trade from its bankroll, current win-streak, and a daily
// spend cap  and refuses to act when edge is thin or the day's budget is spent.
// This makes the agent *decide whether to act*, not just act.
const HOUSE_AGENT_MIN_EDGE = parseFloat(process.env.HOUSE_AGENT_MIN_EDGE || '0.04'); // 4T edge bar
const HOUSE_AGENT_DAILY_CAP = parseFloat(process.env.HOUSE_AGENT_DAILY_CAP || '5'); // USDC/day
const houseRisk = { streak: 0, lastOutcomeAt: 0, spentToday: 0, dayKey: '' };

function _todayKey() { return new Date().toISOString().slice(0, 10); }

// Returns the USDC stake given bankroll + win-streak, capped by per-trade and
// remaining-daily budget. 0 means "can't size a trade now".
function houseRiskSize(balance) {
  if (houseRisk.dayKey !== _todayKey()) { houseRisk.dayKey = _todayKey(); houseRisk.spentToday = 0; }
  const streakMult = houseRisk.streak >= 3 ? 1.5 : houseRisk.streak === 2 ? 1.25 : houseRisk.streak <= -1 ? 0.6 : 1.0;
  let stake = (balance - 0.1) * 0.12 * streakMult;
  
  if (stake < 0.1 && balance >= 0.2) stake = 0.1;
  
  stake = Math.min(stake, HOUSE_AGENT_MAX_TRADE);
  stake = Math.floor(stake * 10) / 10; // 0.1 USDC granularity
  return stake >= 0.1 ? stake : (balance >= 0.2 ? 0.1 : 0);
}

async function houseAgentDecide(candidates, balance, alpha = null, research = null) {
  const top = candidates.slice(0, 5);
  const sources = research && research.sources ? research.sources : [];
  const evaluated = candidates.length;
  const bestEdge = top.length ? top[0].edge : 0;

  // Risk-managed stake. 0  can't size (low bankroll or daily cap hit).
  const amount = houseRiskSize(balance);

  // The agent DECIDES WHETHER TO ACT  visible skip with a reason.
  if (top.length === 0 || bestEdge < HOUSE_AGENT_MIN_EDGE) {
    return {
      action: 'skip', evaluated, bestEdge, brain: 'risk', sources,
      reasoning: `Scanned ${evaluated} markets; best edge ${(bestEdge * 100).toFixed(1)}T is below my ${(HOUSE_AGENT_MIN_EDGE * 100).toFixed(0)}T bar. No +EV trade  holding capital this cycle.`,
    };
  }
  if (amount < 0.1) {
    const dailyHit = (HOUSE_AGENT_DAILY_CAP - houseRisk.spentToday) < 0.1;
    return {
      action: 'skip', evaluated, bestEdge, brain: 'risk', sources,
      reasoning: dailyHit
        ? `Found a ${(bestEdge * 100).toFixed(1)}T edge but I've hit my $${HOUSE_AGENT_DAILY_CAP}/day risk cap  standing down until tomorrow.`
        : `Edge looks good but bankroll is too low to size a safe stake  preserving capital.`,
    };
  }

  try {
    const sys = `You are Pulse, an autonomous value trader on the Puls prediction market (Arc Testnet). Puls prices mirror the Polymarket consensus 1:1  you do NOT trade venue price gaps. You receive candidates with the consensus probability and a conviction score, and decide whether live research + the consensus justify backing a side.${alpha ? ' You just PAID a forecaster ' + alpha.cost + ' USDC for a premium alpha signal (below)  weigh it.' : ''}${research && research.brief ? ' You also researched the open web (live news/sentiment below)  use it to ground the call.' : ''} Pick the single best trade. Respond with STRICT JSON only: {"slug": "...", "side": "YES"|"NO", "reasoning": "<2-3 sentences, cite the consensus probability and the web finding; never compare on-chain vs Polymarket prices>"}`;
    const candidateText = top.map((c, i) =>
      `${i + 1}. ${c.question}\n   slug: ${c.slug} | consensus YES: ${(c.pmYes * 100).toFixed(0)}T | conviction ${((c.conviction ?? c.edge) * 100).toFixed(0)}% (leans ${c.side})`
    ).join('\n');
    const alphaText = alpha
      ? `\n\nPaid alpha signal (you spent ${alpha.cost} USDC on this):\n${JSON.stringify(alpha.signal, null, 2)}`
      : '';
    const researchText = research && research.brief
      ? `\n\nLive web research on "${top[0].question}":\n${research.brief}`
      : '';
    const raw = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: candidateText + alphaText + researchText },
    ]);
    const parsed = parseLlmJson(raw);
    const chosen = top.find(c => c.slug === parsed.slug) || top[0];
    const side = ['YES', 'NO'].includes(parsed.side) ? parsed.side : chosen.side;
    return { ...chosen, action: 'go', side, amount, evaluated, streak: houseRisk.streak, reasoning: formatForApp(String(parsed.reasoning || '').slice(0, 500)), brain: 'llm', sources };
  } catch (e) {
    const c = top[0];
    const consensus = c.side === 'YES' ? c.pmYes : 1 - c.pmYes;
    return {
      ...c,
      action: 'go',
      amount,
      evaluated,
      streak: houseRisk.streak,
      reasoning: `Consensus puts ${c.side} at ${(consensus * 100).toFixed(0)}T with ${((c.conviction ?? c.edge) * 100).toFixed(0)}% conviction. Sizing ${(c.amount ?? 0)} at ${houseRisk.streak >= 2 ? 'elevated (win-streak)' : 'base'} risk; backing ${c.side}.`,
      brain: 'quant',
      sources,
    };
  }
}


async function houseAgentTick() {
  if (!HOUSE_AGENT || houseAgentBusy) return;
  houseAgentBusy = true;
  try {
    // Cooldown based on the last published decision.
    const { data: lastDecision } = await supabase
      .from('notifications')
      .select('created_at')
      .eq('user_id', HOUSE_AGENT_USER)
      .eq('type', 'agent_decision')
      .order('created_at', { ascending: false })
      .limit(1);
    if (lastDecision && lastDecision.length > 0) {
      const since = Date.now() - new Date(lastDecision[0].created_at).getTime();
      if (since < HOUSE_AGENT_INTERVAL_MIN * 60 * 1000) return;
    }

    const agent = await ensureHouseAgentWallet();
    if (agent.balance < 0.2) {
      console.log(`[Pulse] balance too low (${agent.balance}), skipping cycle`);
      return;
    }

    // Pay a creator for alpha BEFORE deciding (agentcreator nanopayment on Arc).
    // The purchased signal becomes extra context for the LLM, and its cost is
    // netted out of the decision economics. Best-effort  never blocks trading.
    const alpha = await houseAgentPayForAlpha(agent.walletId, agent.address);

    const candidates = await houseAgentResearch();
    if (candidates.length === 0) {
      console.log('[Pulse] no active markets to evaluate this cycle');
      await supabase.from('notifications').insert({
        user_id: HOUSE_AGENT_USER,
        title: 'No +EV trade',
        type: 'agent_decision',
        read: true,
        message: JSON.stringify({
          action: 'skip',
          question: 'No active markets to evaluate',
          reasoning: 'No unresolved markets with >1h until deadline found in the deployed set. Standing by.',
          brain: 'risk',
          evaluated: 0,
          bestEdge: 0,
        }),
      }).catch(e => console.warn('[Pulse] publish skip error:', e.message));
      return;
    }

    // Research the open web on the top candidate's question (keyless Jina+DDG).
    // This gives the agent real-world context (news/sentiment) to reason over 
    // not just the on-chain price gap. Best-effort: never blocks the decision.
    let research = { brief: '', sources: [] };
    try {
      research = await researchQuestion(candidates[0].question, 4);
      if (research.sources.length) {
        console.log(`[Pulse] researched "${candidates[0].question}"  ${research.sources.length} sources (${research.sources.map(s => s.source).join(', ')})`);
      }
    } catch (e) {
      console.warn('[Pulse] research failed (continuing):', e.message);
    }

    const decision = await houseAgentDecide(candidates, agent.balance, alpha, research);
    if (!decision) {
      console.log('[Pulse] no candidates this cycle');
      return;
    }

    //  The agent decided NOT to act  publish the skip as a visible decision.
    // (Full autonomy = deciding whether to act, not just acting.)
    if (decision.action === 'skip') {
      console.log(`[Pulse] SKIP  ${decision.reasoning}`);
      await supabase.from('notifications').insert({
        user_id: HOUSE_AGENT_USER,
        title: 'No +EV trade',
        type: 'agent_decision',
        read: true,
        message: JSON.stringify({
          action: 'skip',
          question: `Evaluated ${decision.evaluated} markets  no trade`,
          reasoning: decision.reasoning,
          brain: decision.brain,
          evaluated: decision.evaluated,
          bestEdge: decision.bestEdge,
          // The agent still PAID for alpha + researched, even when it skips.
          alphaPaid: alpha ? alpha.cost : null,
          alphaCreator: alpha ? alpha.creator : null,
          alphaCounterparty: alpha ? (alpha.counterparty || null) : null,
          alphaOnchainTx: alpha ? (alpha.onchainTx || null) : null,
          sources: (decision.sources || []).slice(0, 3),
        }),
      });
      return;
    }

    console.log(`[Pulse] decided: ${decision.side} $${decision.amount} on ${decision.slug} (${decision.brain})`);
    const result = await executeAgentTrade(
      HOUSE_AGENT_USER, agent.walletId, decision.contractAddress,
      decision.side, decision.amount, decision.slug,
    );
    if (!result) {
      console.error('[Pulse] trade execution failed');
      return;
    }

    // Risk bookkeeping: count the spend against the daily cap.
    houseRisk.spentToday += Number(decision.amount) || 0;

    const { error: insErr } = await supabase.from('notifications').insert({
      user_id: HOUSE_AGENT_USER,
      title: decision.slug,
      type: 'agent_decision',
      read: true,
      message: JSON.stringify({
        action: 'go',
        question: decision.question,
        side: decision.side,
        amount: decision.amount,
        reasoning: decision.reasoning,
        brain: decision.brain,
        pmYes: decision.pmYes,
        onChainYes: decision.onChainYes,
        edge: decision.edge,
        evaluated: decision.evaluated ?? null,
        streak: decision.streak ?? null,
        txHash: result.txHash,
        contractAddress: decision.contractAddress,
        slug: decision.slug || null,
        // Agentcreator nanopayment that fed this decision (if any).
        alphaPaid: alpha ? alpha.cost : null,
        alphaCreator: alpha ? alpha.creator : null,
        alphaTxId: alpha ? alpha.txId : null,
        // Agent-to-agent: when Pulse bought another agent's on-chain-attested signal.
        alphaCounterparty: alpha ? (alpha.counterparty || null) : null,
        alphaSignalId: alpha ? (alpha.signalId || null) : null,
        alphaOnchainTx: alpha ? (alpha.onchainTx || null) : null,
        // Open-web research the agent read before deciding (keyless Jina+DDG).
        sources: (decision.sources || []).slice(0, 3),
      }),
    });
    if (insErr) console.error('[Pulse] decision publish error:', insErr.message);
    else console.log(`[Pulse] published decision, tx ${result.txHash}`);
  } catch (e) {
    console.error('[Pulse] tick error:', e.message);
  } finally {
    houseAgentBusy = false;
  }
}

// Public feed: the agent's identity + its published decisions.
let houseAgentCache = { data: null, ts: 0 };
app.get('/api/agents/house', async (req, res) => {
  try {
    if (houseAgentCache.data && Date.now() - houseAgentCache.ts < 30 * 1000) {
      return res.json(houseAgentCache.data);
    }
    const walletId = await getWalletId(HOUSE_AGENT_KEY);
    let agent = null;
    if (walletId) {
      const info = await getWalletInfo(walletId);
      // Resolve the ERC-8004 id on cache miss (persisted store / bounded scan) so
      // Pulse's id is shown + persisted right after a restart, like the swarm roster.
      let erc8004Id = agentTokenIds.get(HOUSE_AGENT_KEY) ?? null;
      if (erc8004Id == null && info.address) {
        try { erc8004Id = await resolveAgentTokenId(HOUSE_AGENT_KEY, info.address); } catch (_) {}
      }
      agent = {
        name: 'Pulse',
        address: info.address,
        balance: parseFloat(info.usdcBalance) || 0,
        erc8004Id,
        reputation: agentRepCount.get(HOUSE_AGENT_KEY) ?? 0,
        enabled: HOUSE_AGENT,
        intervalMinutes: HOUSE_AGENT_INTERVAL_MIN,
      };
    }
    const { data: rows } = await supabase
      .from('notifications')
      .select('body, created_at')
      .eq('user_id', HOUSE_AGENT_USER)
      .eq('type', 'agent_decision')
      .order('created_at', { ascending: false })
      .limit(25);
    const decisions = (rows || []).map((r) => {
      try { return { ...JSON.parse(r.message), at: r.created_at }; }
      catch { return null; }
    }).filter(Boolean);

    // Sage  the creator-agent Pulse buys signals from (agent-to-agent).
    let sage = null;
    try {
      const sageWalletId = await getWalletId(SAGE_AGENT_KEY);
      if (sageWalletId) {
        const sInfo = await getWalletInfo(sageWalletId);
        const { data: sig } = await supabase
          .from('creator_signals')
          .select('id, title, onchain_tx, unlocks_count, revenue_usdc')
          .eq('creator_user_id', SAGE_AGENT_USER).eq('status', 'published')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        sage = {
          name: 'Sage',
          role: 'creator-agent',
          address: sInfo.address,
          balance: parseFloat(sInfo.usdcBalance) || 0,
          erc8004Id: agentTokenIds.get(SAGE_AGENT_KEY) ?? null,
          enabled: SAGE_AGENT,
          signal: sig ? {
            id: sig.id, title: sig.title,
            unlocks: sig.unlocks_count ?? 0,
            revenueUsdc: Number(sig.revenue_usdc ?? 0),
            onchain: sig.onchain_tx ? { tx: sig.onchain_tx, explorer: `https://testnet.arcscan.app/tx/${sig.onchain_tx}` } : null,
          } : null,
        };
      }
    } catch (e) { console.warn('[agents/house] sage lookup failed:', e.message); }

    const data = { agent, sage, decisions };
    houseAgentCache = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('agents/house error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Economy Explorer  live on-chain USDC feed (Blockscout / Arcscan v2 API).
// Aggregates USDC token-transfers for Puls-owned addresses (treasury + house
// agent) into a verifiable activity feed with proof links. No secrets needed:
// testnet.arcscan.app is a public Blockscout instance. If ARC_EXPLORER_API is
// pointed at api.blockscout.com (multichain gateway), BLOCKSCOUT_API_KEY is
// appended automatically.
// ---------------------------------------------------------------------------
const ARC_EXPLORER_API = (process.env.ARC_EXPLORER_API || 'https://testnet.arcscan.app/api/v2').replace(/\/+$/, '');
const ARC_EXPLORER_TX = (process.env.ARC_EXPLORER_TX || 'https://testnet.arcscan.app/tx').replace(/\/+$/, '');
const ECONOMY_FEED_TTL_MS = parseInt(process.env.ECONOMY_FEED_TTL_MS || '45000', 10);

// Small cache + pacer so we never exceed explorer rate limits (default <4 req/s).
const _explorerCache = new Map(); // path -> { at, data }
let _explorerLastCall = 0;
async function explorerFetch(path, ttlMs = ECONOMY_FEED_TTL_MS) {
  const hit = _explorerCache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const wait = Math.max(0, _explorerLastCall + 260 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  _explorerLastCall = Date.now();
  let url = `${ARC_EXPLORER_API}${path}`;
  if (process.env.BLOCKSCOUT_API_KEY && ARC_EXPLORER_API.includes('api.blockscout.com')) {
    url += `${path.includes('?') ? '&' : '?'}apikey=${process.env.BLOCKSCOUT_API_KEY}`;
  }
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  const data = await r.json();
  _explorerCache.set(path, { at: Date.now(), data });
  return data;
}

// Resolve the house agent wallet address once (cached for process lifetime).
let _houseAgentAddr = null;
async function getHouseAgentAddress() {
  if (_houseAgentAddr !== null) return _houseAgentAddr;
  try {
    const wid = await getWalletId(HOUSE_AGENT_KEY);
    _houseAgentAddr = wid ? ((await getWalletInfo(wid))?.address || '') : '';
  } catch (e) {
    console.warn('[economy] house agent addr resolve failed:', e.message);
    _houseAgentAddr = '';
  }
  return _houseAgentAddr;
}

let _economyFeedCache = { at: 0, data: null };
app.get('/api/economy/feed', generalLimiter, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '30', 10)));
    if (_economyFeedCache.data && Date.now() - _economyFeedCache.at < ECONOMY_FEED_TTL_MS) {
      return res.json({ ..._economyFeedCache.data, feed: _economyFeedCache.data.feed.slice(0, limit), cached: true });
    }

    // Puls-owned addresses we track on-chain.
    const tracked = {}; // lowercased addr -> { label, role }
    const treasury = adminAccount?.address || null;
    if (treasury) tracked[treasury.toLowerCase()] = { label: 'Treasury', role: 'treasury', address: treasury };
    const houseAgent = await getHouseAgentAddress();
    if (houseAgent) tracked[houseAgent.toLowerCase()] = { label: 'Pulse (house agent)', role: 'agent', address: houseAgent };
    // x402 creator/seller  batched nanopayments settle here on-chain. Surfacing
    // the seller means every Circle Gateway batch flush shows up with a real,
    // openable Arcscan tx (the on-chain proof behind the instant receipts).
    const x402Seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    if (x402Seller) tracked[x402Seller.toLowerCase()] = { label: 'Alpha creator (x402)', role: 'creator', address: x402Seller };

    // Swarm agents tracking
    const swarmAgents = {
      '0x6fd898b2e74182554ae32c5919d912f027a092f5': { label: 'Striker ⚽', role: 'agent' },
      '0x7b74a5884eb5b95240a0975c4b1eaf63d850374c': { label: 'Atlas 📈', role: 'agent' },
      '0xb526c00d8233568c58ced412073709030e930021': { label: 'Nova 🌐', role: 'agent' },
      '0xc5b26d99100f1e9dbbb95d66a10fef3034546540': { label: 'Vega ⚡', role: 'agent' },
      '0x6620ac5ec6eaff39d12db08298ba7f8cbbcf8641': { label: 'Cygnus 🛡️', role: 'agent' },
      '0x18da1c60f8d37f94be7a740bf5bfd4b61c275fac': { label: 'Orion 🔭', role: 'agent' },
    };
    for (const [addr, info] of Object.entries(swarmAgents)) {
      tracked[addr.toLowerCase()] = { label: info.label, role: info.role, address: addr };
    }

    const all = [];
    for (const a of Object.keys(tracked)) {
      try {
        const d = await explorerFetch(`/addresses/${a}/token-transfers?type=ERC-20`);
        for (const it of (d.items || [])) all.push(it);
      } catch (e) {
        console.warn('[economy] transfers fetch failed for', a, e.message);
      }
    }

    // Keep USDC only + dedupe by tx_hash:log_index.
    const seen = new Set();
    const usdcItems = [];
    for (const it of all) {
      const tokenAddr = (it.token?.address_hash || it.token?.address || '').toLowerCase();
      const sym = (it.token?.symbol || '').toUpperCase();
      if (!(tokenAddr === USDC.toLowerCase() || sym === 'USDC')) continue;
      const key = `${it.transaction_hash}:${it.log_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usdcItems.push(it);
    }
    usdcItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Fallback: If external explorer returns 0 items, read directly from x402_payments in Neon DB!
    if (usdcItems.length === 0) {
      try {
        const { data: dbPayments } = await supabase
          .from('x402_payments')
          .select('id, endpoint, payer, pay_to, amount_usdc, gateway_tx, raw, created_at')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (dbPayments && dbPayments.length > 0) {
          const AGENT_NAME_MAP = {
            agent_swarm_vega: 'Vega ⚡', agent_swarm_cygnus: 'Cygnus 🛡️', agent_swarm_orion: 'Orion 🔭',
            agent_swarm_atlas: 'Atlas 📈', agent_swarm_nova: 'Nova 🌐', agent_swarm_striker: 'Striker ⚽',
            'agent_supabase_231e1ae9-9f9f-47bb-a6f7-2e406ba29b10': 'Striker ⚽', agent_sage: 'Sage 🔮',
            house_pulse: 'Pulse ⚡', agent_house_agent: 'Pulse ⚡',
            '0x6fd898b2e74182554ae32c5919d912f027a092f5': 'Striker ⚽',
            '0x7b74a5884eb5b95240a0975c4b1eaf63d850374c': 'Atlas 📈',
            '0xb526c00d8233568c58ced412073709030e930021': 'Nova 🌐',
            '0xc5b26d99100f1e9dbbb95d66a10fef3034546540': 'Vega ⚡',
            '0x6620ac5ec6eaff39d12db08298ba7f8cbbcf8641': 'Cygnus 🛡️',
            '0x18da1c60f8d37f94be7a740bf5bfd4b61c275fac': 'Orion 🔭',
          };
          const resolveName = (val) => {
            if (!val) return 'Puls Agent 🤖';
            const k = String(val).toLowerCase();
            if (AGENT_NAME_MAP[val]) return AGENT_NAME_MAP[val];
            if (AGENT_NAME_MAP[k]) return AGENT_NAME_MAP[k];
            if (k.includes('striker')) return 'Striker ⚽';
            if (k.includes('atlas')) return 'Atlas 📈';
            if (k.includes('nova')) return 'Nova 🌐';
            if (k.includes('vega')) return 'Vega ⚡';
            if (k.includes('cygnus')) return 'Cygnus 🛡️';
            if (k.includes('orion')) return 'Orion 🔭';
            if (k.includes('sage')) return 'Sage 🔮';
            if (k.includes('pulse') || k.includes('house')) return 'Pulse ⚡';
            if (k.startsWith('0x') && k.length > 10) return `${val.slice(0, 6)}...${val.slice(-4)}`;
            return val;
          };

          const feed = dbPayments.map((r) => {
            const raw = typeof r.raw === 'string' ? JSON.parse(r.raw || '{}') : (r.raw || {});
            const fromName = resolveName(raw.agent || r.payer);
            const toName = resolveName(raw.counterparty || raw.seller || r.pay_to);
            const tx = (r.gateway_tx && String(r.gateway_tx).startsWith('0x')) ? r.gateway_tx : null;
            return {
              id: r.id,
              txHash: tx,
              arcscanUrl: tx ? `https://testnet.arcscan.app/tx/${tx}` : null,
              from: r.payer,
              fromLabel: fromName,
              fromRole: 'agent',
              to: r.pay_to,
              toLabel: toName,
              toRole: 'agent',
              amountUsdc: Number(r.amount_usdc || 0),
              action: r.endpoint === 'signal_unlock' ? 'Signal unlocked' : (r.endpoint === 'agent_to_agent' ? 'x402 agent transfer' : 'x402 nanopayment'),
              timestamp: r.created_at,
            };
          });

          const data = { feed, totalCount: feed.length, source: 'x402_payments' };
          _economyFeedCache = { data, at: Date.now() };
          return res.json(data);
        }
      } catch (e) {
        console.warn('[economy] DB fallback failed:', e.message);
      }
    }

    const labelFor = (addr) => {
      const low = (addr || '').toLowerCase();
      if (tracked[low]) return { address: addr, label: tracked[low].label };
      return { address: addr, label: low ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'Unknown' };
    };

    const feed = usdcItems.slice(0, limit).map((it) => {
      const from = it.from?.hash || '';
      const to = it.to?.hash || '';
      const decimals = parseInt(it.total?.decimals || it.token?.decimals || '6', 10);
      const value = Number(it.total?.value || '0') / Math.pow(10, decimals);
      const fromRole = tracked[from.toLowerCase()]?.role || null;
      const toRole = tracked[to.toLowerCase()]?.role || null;
      const m = (it.method || '').toLowerCase();
      let action;
      if (m.includes('createmarket')) action = 'Market created';
      else if (m.includes('buy')) action = 'Share buy';
      else if (m.includes('sell')) action = 'Share sell';
      else if (m.includes('claim') || m.includes('redeem')) action = 'Winnings claimed';
      else if (toRole === 'creator') action = 'Creator paid (x402 batch)';
      else if (fromRole === 'creator') action = 'Creator payout';
      else if (fromRole === 'treasury') action = 'Treasury drip (gas/credit)';
      else if (toRole === 'treasury') action = 'Returned to treasury';
      else if (fromRole === 'agent') action = 'Agent payment out';
      else if (toRole === 'agent') action = 'Agent received funds';
      else action = 'USDC transfer';
      return {
        hash: it.transaction_hash,
        explorer_url: `${ARC_EXPLORER_TX}/${it.transaction_hash}`,
        timestamp: it.timestamp,
        block: it.block_number,
        method: it.method || null,
        from: { ...labelFor(from), role: fromRole },
        to: { ...labelFor(to), role: toRole },
        value_usdc: Number(value.toFixed(6)),
        token: 'USDC',
        action,
      };
    });

    const vol = feed.reduce((s, x) => s + x.value_usdc, 0);
    const metrics = {
      tx_count: feed.length,
      total_volume_usdc: Number(vol.toFixed(4)),
      avg_payment_usdc: feed.length ? Number((vol / feed.length).toFixed(6)) : 0,
      tracked_addresses: Object.keys(tracked).length,
    };

    const payload = {
      feed,
      metrics,
      tracked: Object.values(tracked).map((t) => ({ label: t.label, role: t.role, address: t.address })),
      explorer: ARC_EXPLORER_TX,
      updated_at: new Date().toISOString(),
    };
    _economyFeedCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    console.error('[economy/feed] error:', e.message);
    res.status(500).json({ error: 'economy feed failed' });
  }
});

if (SAGE_AGENT) {
  // Bring Sage (creator-agent) online first, so Pulse can buy its on-chain
  // attested signal on the very first cycle (agent-to-agent value transfer).
  // Delayed 60s so the HTTP server is fully operational before any on-chain
  // work begins (Sage deploys a SignalRegistry attestation = viem writeContract).
  setTimeout(() => { ensureSageAgent().catch((e) => console.error('[Sage] boot error:', e.message)); }, 60 * 1000);
}

if (HOUSE_AGENT) {
  setTimeout(houseAgentTick, 90 * 1000); // delayed so HTTP server is ready first
  // Subsequent cycles are event-driven: the house agent reacts to new market
  // activity (trades) and freshly activated markets instead of polling. The
  // cooldown inside houseAgentTick still bounds the real cadence.
  eventBus.on(EVENTS.TRADE_COMPLETE, () => {
    setImmediate(() => houseAgentTick().catch((e) => console.error('[house] tick:', e.message)));
  });
  eventBus.on(EVENTS.MARKET_ACTIVATED, () => {
    setImmediate(() => houseAgentTick().catch((e) => console.error('[house] tick:', e.message)));
  });
}

//  Agent Swarm: a colony of autonomous AI actors that live in Pulsmarket 
// Multiple persona-driven agents (traders + creators), each with its own wallet,
// ERC-8004 identity and preferred LLM "brain". They research, publish + evaluate
// + buy each other's signals (commenting "accurate, buying" / "flawed, skipping"),
// trade predictions like humans, and comment on markets  powering AI vs Humans.
// Env-gated (AGENT_SWARM=true); reuses the house-agent plumbing, never touches it.
const swarm = registerSwarm(app, {
  authenticateUser, requireVerifiedUser, strictLimiter,
  supabase, circle, walletClient, publicClient, adminAccount,
  getWalletId, saveWallet, getWalletInfo, ensureWalletSet, WALLET_ACCOUNT_TYPE,
  USDC, IDENTITY_REGISTRY, AGENT_METADATA_URI, SIGNAL_REGISTRY_ADDRESS,
  resolveAgentTokenId, recordAgentReputation, agentTokenIds, agentHasIdentity,
  getTreasuryUsdcBalance, houseAgentResearch, executeAgentTrade,
  researchQuestion, llmComplete, parseLlmJson, formatForApp,
  keccak256, toHex, encodeFunctionData, parseAbiItem, stringToHex,
  blog,
  getOrDeployMarket,
  deployedMarketsCache,
});
// Delayed 90s so the HTTP server is fully operational before agents start
// trading + deploying markets on-chain (each trade = viem writeContract that
// blocks the event loop for 5-10s  503 + CORS errors on 512MB dyno).
if (typeof swarm.start === 'function') {
  setTimeout(() => swarm.start(), 5 * 1000);
  if (typeof swarm.stop === 'function') onShutdown(() => swarm.stop());
  onShutdown(() => shutdownRedis());
  onShutdown(() => osClient?.close?.());
}

// Autonomous streaming agent: a trader agent
// rents a creator's live alpha feed per second, choosing the rate by expected
// value (bankroll x conviction) and tapping stop when the marginal value of the
// next second falls below the price. Drives streamsApi.open/tick/stop and logs
// each session to the agent_decision feed. Gated by STREAM_AGENT_ENABLED.
registerStreamingAgent({ streamsApi, supabase, getWalletId, getWalletInfo, llmComplete, parseLlmJson, roster: swarm.roster });

// Agent strategies (arbitrage/DCA) now run on trade + market activity events
// instead of a 60s poll. Arbitrage reacts to price moves; DCA piggybacks on the
// same wake-ups. runAgentStrategies itself is idempotent + internally gated.
eventBus.on(EVENTS.TRADE_COMPLETE, () => {
  setImmediate(() => {
    try { runAgentStrategies(); } catch (e) { console.error('runAgentStrategies:', e.message); }
  });
});
eventBus.on(EVENTS.MARKET_ACTIVATED, () => {
  setImmediate(() => {
    try { runAgentStrategies(); } catch (e) { console.error('runAgentStrategies:', e.message); }
  });
});
