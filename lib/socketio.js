/**
 * Puls Socket.IO gateway — bridges the internal eventBus to connected
 * Flutter / web clients in real time.
 *
 * Why Socket.IO over raw `ws`:
 *   - Auto-reconnect with backoff (Flutter Web drops on tab sleep).
 *   - Namespaces + rooms (per-user private channels, future: admin queue).
 *   - Built-in ack callbacks (terminal UI can confirm receipt).
 *   - Backward-compatible transport fallback (HTTP long-polling if WS blocked).
 *
 * Single-dyno assumption: this gateway runs in the same process as the
 * eventBus (see lib/events.js). Multi-dyno would need the Redis adapter
 * (@socket.io/redis-adapter) — same `io.emit` surface, transparent to callers.
 *
 * Sanitization:
 *   Event payloads come from Supabase rows and may contain fields that
 *   shouldn't leave the server (Circle `wallet_id`s, raw JWTs, etc.).
 *   `sanitize(event, payload)` whitelists per event type and strips the
 *   generic denylist before broadcasting. NEVER log the raw payload.
 *
 * Wiring (server.js):
 *   import { initSocketIo } from './lib/socketio.js';
 *   const io = initSocketIo(server);
 */
import { Server } from 'socket.io';
import { eventBus, EVENTS } from './events.js';

// Fields that NEVER leave the server, regardless of event type.
const DENYLIST = new Set([
  'wallet_id', 'walletId',
  'entity_secret', 'entitySecret',
  'api_key', 'apiKey', 'key_hash', 'keyHash',
  'private_key', 'privateKey',
  'seed', 'mnemonic', 'password', 'token',
  'fcm_token', 'fcmToken',
]);

// Per-event field whitelists. If an event isn't listed, the full (denylisted)
// payload is broadcast — useful for new events added later.
const WHITELISTS = {
  [EVENTS.TRADE_CREATED]: [
    'id', 'user_id', 'market_id', 'side', 'state', 'usdc_amount',
    'entry_price', 'question', 'tx_hash', 'created_at',
  ],
  [EVENTS.TRADE_COMPLETE]: [
    'id', 'user_id', 'market_id', 'side', 'state', 'usdc_amount',
    'entry_price', 'question', 'tx_hash', 'created_at',
  ],
  [EVENTS.TRADE_FAILED]: [
    'id', 'user_id', 'market_id', 'side', 'state', 'created_at',
  ],
  [EVENTS.MARKET_CREATED]: [
    'slug', 'contract_address', 'deadline', 'resolved', 'outcome',
    'title', 'description', 'category', 'is_user_created', 'created_by_agent',
  ],
  [EVENTS.MARKET_ACTIVATED]: [
    'slug', 'contract_address', 'deadline', 'resolved', 'outcome',
    'title', 'description', 'category',
  ],
  [EVENTS.MARKET_RESOLVED]: ['slug', 'outcome', 'contract_address'],
  [EVENTS.MARKET_ARCHIVED]: ['slug'],
  [EVENTS.WALLET_CREATED]: ['user_id', 'address', 'last_balance'],
  [EVENTS.WALLET_BALANCE_CHANGED]: ['userId', 'address', 'balance'],
  [EVENTS.SIGNAL_PUBLISHED]: [
    'id', 'creator_user_id', 'title', 'market_slug', 'market_question',
    'stance', 'confidence', 'edge_bps', 'horizon', 'teaser', 'price_usdc',
    'onchain_tx', 'published_at',
    // NOTE: `thesis` is paid content — intentionally excluded.
  ],
  [EVENTS.SIGNAL_ARCHIVED]: ['id'],
  [EVENTS.ORDER_LIMIT_PLACED]: [
    'id', 'user_id', 'market_id', 'slug', 'side', 'type',
    'usdc_amount', 'shares', 'target_price', 'status',
  ],
  [EVENTS.ORDER_LIMIT_FILLED]: ['id', 'txHash'],
  [EVENTS.ORDER_LIMIT_CANCELLED]: ['id'],
  [EVENTS.COMMENT_CREATED]: [
    'id', 'user_id', 'target_type', 'target_id', 'body',
    'parent_id', 'created_at',
  ],
  [EVENTS.BLOG_PUBLISHED]: [
    'id', 'author_user_id', 'title', 'excerpt', 'kind',
    'tags', 'published_at',
  ],
  [EVENTS.NOTIFICATION_CREATED]: [
    'user_id', 'title', 'message', 'type', 'created_at',
  ],
};

/**
 * Strip the denylist + apply the per-event whitelist. Returns a shallow copy;
 * the original payload is untouched (other subscribers may need the full row).
 *
 * Exported so the raw `ws` gateway (lib/socketws.js) can reuse the same
 * sanitization rules — both channels must carry identical payloads.
 */
export function sanitize(event, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const allow = WHITELISTS[event];
  if (!allow) {
    // No whitelist for this event — fall back to denylist strip.
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!DENYLIST.has(k)) out[k] = v;
    }
    return out;
  }
  // Whitelisted event — only carry over allowed fields that are present.
  const out = {};
  for (const k of allow) {
    if (payload[k] !== undefined) out[k] = payload[k];
  }
  return out;
}

/**
 * Initialize the Socket.IO server, attach it to the given http.Server,
 * and subscribe to all canonical events on the internal eventBus.
 *
 * @param {import('http').Server} server
 * @param {{ corsOrigin?: string }} [opts]
 * @returns {import('socket.io').Server}
 */
export function initSocketIo(server, opts = {}) {
  const io = new Server(server, {
    cors: { origin: opts.corsOrigin || '*', methods: ['GET', 'POST'] },
    // Allow large notification messages (agent_decision JSON can be ~2KB).
    maxHttpBufferSize: 1e6,
    // Don't kill the server if a client misbehaves.
    pingTimeout: 30_000,
    pingInterval: 25_000,
  });

  const stats = { connected: 0, broadcasts: 0 };

  // SECURITY (C3 fix): Verify the socket's identity before allowing room
  // subscription. Without this, any client could subscribe to ANY user's
  // private notification room by emitting subscribe:user with a victim's id.
  // The token is verified via the Supabase auth client passed in opts.
  const supabaseAuth = opts.supabaseAuth || null;
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) { socket._verifiedUserId = null; return next(); }
      if (supabaseAuth) {
        const { data } = await supabaseAuth.auth.getUser(String(token));
        if (data?.user) {
          const uid = data.user.id;
          socket._verifiedUserId = (typeof uid === 'string' && (uid.startsWith('supabase_') || uid.startsWith('google_')))
            ? uid : `supabase_${uid}`;
        }
      }
    } catch (_) { /* unverified — no room access */ }
    next();
  });

  io.on('connection', (socket) => {
    stats.connected++;
    console.log(`[socket.io] client connected (id=${socket.id}, total=${stats.connected})`);

    // Clients can opt into per-user rooms for private notifications
    // (e.g. their own trade confirmations). `socket.join(user:<id>)`.
    // SECURITY (C3 fix): Only allow subscribing to the VERIFIED user's own
    // room. An unauthenticated socket gets no private room access.
    socket.on('subscribe:user', (userId) => {
      if (typeof userId !== 'string' || userId.length >= 200) return;
      if (!socket._verifiedUserId || userId !== socket._verifiedUserId) {
        console.warn(`[socket.io] rejected room subscription: socket verified=${socket._verifiedUserId}, requested=${userId}`);
        return;
      }
      socket.join(`user:${userId}`);
    });

    socket.on('disconnect', (reason) => {
      stats.connected = Math.max(0, stats.connected - 1);
      console.log(`[socket.io] client disconnected (id=${socket.id}, reason=${reason}, total=${stats.connected})`);
    });

    socket.on('error', (err) => {
      console.warn(`[socket.io] client error (id=${socket.id}):`, err?.message || err);
    });
  });

  // ── Subscribe to the eventBus → broadcast to all clients ────────────
  // We subscribe to EVERY canonical event in one loop so newly added
  // events automatically flow through (the whitelist falls back to the
  // denylist for unlisted events).
  const allEvents = Object.values(EVENTS);
  for (const evt of allEvents) {
    eventBus.on(evt, (payload) => {
      try {
        const safe = sanitize(evt, payload);
        // Per-event channel: `trade:complete`, `signal:published`, etc.
        io.emit(evt, safe);
        // Unified envelope channel: clients that want one stream of
        // everything subscribe to `puls:event` and dispatch by `type`.
        io.emit('puls:event', { type: evt, payload: safe, ts: Date.now() });
        stats.broadcasts++;
      } catch (e) {
        console.error(`[socket.io] broadcast failed for "${evt}":`, e.message);
      }
    });
  }

  // Expose stats for a future /api/health endpoint.
  io.pulsStats = stats;

  console.log(
    `[socket.io] gateway initialized — bridging ${allEvents.length} eventBus events ` +
    `(cors=${opts.corsOrigin || '*'}, maxHttpBuffer=1MB)`
  );

  return io;
}

export default initSocketIo;
