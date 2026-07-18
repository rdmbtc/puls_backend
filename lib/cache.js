/**
 * Puls in-memory cache — singleton, hydrated once at boot, kept in sync by
 * the internal eventBus. Eliminates continuous Supabase reads for hot-path
 * data (markets, wallets, signals, trades, limit orders, notifications).
 *
 * Cache misses return null; callers may do a one-time Supabase read for cold
 * data — this is NOT continuous egress. The goal is zero *polling*, not zero
 * reads ever.
 *
 * Memory bounds: Heroku free dyno = 512MB.
 *   - markets / wallets / signals: full tables (small — hundreds of rows).
 *   - trades: LRU capped at TRADES_LRU_CAP (default 5000).
 *   - limitOrders: only status='PENDING' rows (auto-evicted on fill/cancel).
 *   - notifications: per-user ring buffer (last NOTIF_PER_USER per user).
 *
 * Lifecycle:
 *   1. `await cache.hydrate(supabase)` — call once at boot, before app.listen.
 *   2. `cache.subscribe()` — wire bus listeners (call after hydrate).
 *   3. Route handlers + agents read synchronously via cache.markets.get(slug) etc.
 */
import { eventBus, EVENTS } from './events.js';

const TRADES_LRU_CAP = parseInt(process.env.CACHE_TRADES_CAP || '5000', 10);
const NOTIF_PER_USER = parseInt(process.env.CACHE_NOTIF_PER_USER || '50', 10);

// ── Bounded collections ──────────────────────────────────────────────────────

class LRUCache {
  constructor(cap) {
    this.cap = cap;
    this.map = new Map(); // Map preserves insertion order; oldest = first key
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key); // refresh recency
    this.map.set(key, val);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  delete(key) { this.map.delete(key); }
  size() { return this.map.size; }
  values() { return [...this.map.values()]; }
}

class RingBuffer {
  constructor(cap) {
    this.cap = cap;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.shift();
  }
  recent(n) { return this.items.slice(-n); }
  all() { return [...this.items]; }
  size() { return this.items.length; }
}

// ── Singleton cache ─────────────────────────────────────────────────────────

class PulsCache {
  constructor() {
    this.markets = new Map();             // slug -> row
    this.marketsByContract = new Map();   // lowercased 0x address -> slug
    this.wallets = new Map();             // user_id -> row (full wallets row)
    this.walletsByAddress = new Map();    // lowercased address -> user_id
    this.signals = new Map();             // id -> row (status='published' only)
    this.trades = new LRUCache(TRADES_LRU_CAP); // id|tx_id -> row (most recent N)
    this.limitOrders = new Map();         // id -> row (status='PENDING' only)
    this.notifications = new Map();       // user_id -> RingBuffer
    this._hydrated = false;
  }

  // ── Hydration (call once at boot) ───────────────────────────────────────
  async hydrate(supabase) {
    const t0 = Date.now();
    const tasks = [
      this._hydrateMarkets(supabase),
      this._hydrateWallets(supabase),
      this._hydrateSignals(supabase),
      this._hydrateTrades(supabase),
      this._hydrateLimitOrders(supabase),
    ];
    await Promise.allSettled(tasks);
    this._hydrated = true;
    console.log(
      `[cache] hydrated in ${Date.now() - t0}ms: ${this.markets.size} markets, ` +
      `${this.wallets.size} wallets, ${this.signals.size} signals, ` +
      `${this.trades.size()} trades, ${this.limitOrders.size} pending limit orders`
    );
  }

  async _hydrateMarkets(supabase) {
    const { data, error } = await supabase.from('deployed_markets').select('*');
    if (error) return console.warn('[cache] markets hydrate failed:', error.message);
    for (const m of data || []) this._indexMarket(m);
  }

  _indexMarket(m) {
    if (!m || !m.slug) return;
    this.markets.set(m.slug, m);
    if (m.contract_address) {
      this.marketsByContract.set(String(m.contract_address).toLowerCase(), m.slug);
    }
  }

  async _hydrateWallets(supabase) {
    const { data, error } = await supabase.from('wallets').select('*');
    if (error) return console.warn('[cache] wallets hydrate failed:', error.message);
    for (const w of data || []) this._indexWallet(w);
  }

  _indexWallet(w) {
    if (!w || !w.user_id) return;
    this.wallets.set(w.user_id, w);
    const addr = w.address;
    if (addr) this.walletsByAddress.set(String(addr).toLowerCase(), w.user_id);
  }

  async _hydrateSignals(supabase) {
    const { data, error } = await supabase
      .from('creator_signals')
      .select('*')
      .eq('status', 'published');
    if (error) return console.warn('[cache] signals hydrate failed:', error.message);
    for (const s of data || []) this.signals.set(s.id, s);
  }

  async _hydrateTrades(supabase) {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(TRADES_LRU_CAP);
    if (error) return console.warn('[cache] trades hydrate failed:', error.message);
    // reverse so LRU eviction order is correct (oldest inserted first)
    for (const t of (data || []).reverse()) {
      const key = t.id || t.tx_id;
      if (key) this.trades.set(key, t);
    }
  }

  async _hydrateLimitOrders(supabase) {
    const { data, error } = await supabase
      .from('limit_orders')
      .select('*')
      .eq('status', 'PENDING');
    if (error) return console.warn('[cache] limitOrders hydrate failed:', error.message);
    for (const o of data || []) this.limitOrders.set(o.id, o);
  }

  // ── Read API (synchronous) ─────────────────────────────────────────────
  marketBySlug(slug) { return this.markets.get(slug) || null; }
  marketByContract(addr) {
    if (!addr) return null;
    const slug = this.marketsByContract.get(String(addr).toLowerCase());
    return slug ? this.markets.get(slug) : null;
  }
  allMarkets() { return [...this.markets.values()]; }
  resolvedMarkets() { return this.allMarkets().filter((m) => m.resolved); }
  unresolvedMarkets() {
    return this.allMarkets().filter((m) => !m.resolved && !m.archived);
  }

  walletByUser(userId) { return this.wallets.get(userId) || null; }
  walletByAddress(addr) {
    if (!addr) return null;
    const userId = this.walletsByAddress.get(String(addr).toLowerCase());
    return userId ? this.wallets.get(userId) : null;
  }

  signalById(id) { return this.signals.get(id) || null; }
  publishedSignals() { return [...this.signals.values()]; }
  signalsByCreator(creatorUserId) {
    return this.publishedSignals().filter((s) => s.creator_user_id === creatorUserId);
  }

  tradeById(id) { return this.trades.get(id) || null; }
  recentTrades(n = 100) { return this.trades.values().slice(-n); }
  tradesByUser(userId, n = 100) {
    return this.trades.values().filter((t) => t.user_id === userId).slice(-n);
  }
  tradesByMarket(marketId, n = 100) {
    return this.trades.values().filter((t) => t.market_id === marketId).slice(-n);
  }
  recentHumanTrades(n = 100) {
    // "Human" = non-agent userId (agents use `agent_supabase_*` / `agent_` ids
    // per agent_swarm.js convention). Includes only COMPLETE trades.
    return this.trades
      .values()
      .filter(
        (t) =>
          t.state === 'COMPLETE' &&
          t.user_id &&
          !String(t.user_id).startsWith('agent_')
      )
      .slice(-n);
  }

  pendingLimitOrders() { return [...this.limitOrders.values()]; }
  limitOrderById(id) { return this.limitOrders.get(id) || null; }
  pendingLimitOrdersForMarket(marketId) {
    return this.pendingLimitOrders().filter((o) => o.market_id === marketId);
  }

  notificationsFor(userId, n = 50) {
    const buf = this.notifications.get(userId);
    return buf ? buf.recent(n) : [];
  }

  // ── Bus subscriptions (call once at boot, after hydrate) ───────────────
  subscribe() {
    // Trades
    eventBus.on(EVENTS.TRADE_CREATED, (t) => this._upsertTrade(t));
    eventBus.on(EVENTS.TRADE_COMPLETE, (t) => this._upsertTrade(t));
    eventBus.on(EVENTS.TRADE_FAILED, (t) => this._upsertTrade(t));

    // Markets
    eventBus.on(EVENTS.MARKET_CREATED, (m) => this._indexMarket(m));
    eventBus.on(EVENTS.MARKET_ACTIVATED, (m) => this._indexMarket(m));
    eventBus.on(EVENTS.MARKET_RESOLVED, ({ slug, outcome }) => {
      const m = this.markets.get(slug);
      if (m) { m.resolved = true; m.outcome = outcome; }
    });
    eventBus.on(EVENTS.MARKET_ARCHIVED, ({ slug }) => {
      const m = this.markets.get(slug);
      if (m) m.archived = true;
    });

    // Wallets
    eventBus.on(EVENTS.WALLET_CREATED, (w) => this._indexWallet(w));
    eventBus.on(EVENTS.WALLET_BALANCE_CHANGED, ({ userId, address, balance }) => {
      const w = this.wallets.get(userId);
      if (w) w.last_balance = String(balance);
      else if (address) {
        const uid = this.walletsByAddress.get(String(address).toLowerCase());
        if (uid) this.wallets.get(uid).last_balance = String(balance);
      }
    });

    // Signals
    eventBus.on(EVENTS.SIGNAL_PUBLISHED, (s) => {
      if (s && s.id && s.status === 'published') this.signals.set(s.id, s);
    });
    eventBus.on(EVENTS.SIGNAL_ARCHIVED, ({ id }) => this.signals.delete(id));

    // Limit orders
    eventBus.on(EVENTS.ORDER_LIMIT_PLACED, (o) => {
      if (o && o.id && o.status === 'PENDING') this.limitOrders.set(o.id, o);
    });
    eventBus.on(EVENTS.ORDER_LIMIT_FILLED, ({ id }) => this.limitOrders.delete(id));
    eventBus.on(EVENTS.ORDER_LIMIT_CANCELLED, ({ id }) => this.limitOrders.delete(id));

    // Notifications (per-user ring buffer)
    eventBus.on(EVENTS.NOTIFICATION_CREATED, (n) => {
      if (!n || !n.user_id) return;
      let buf = this.notifications.get(n.user_id);
      if (!buf) {
        buf = new RingBuffer(NOTIF_PER_USER);
        this.notifications.set(n.user_id, buf);
      }
      buf.push(n);
    });

    console.log('[cache] subscribed to eventBus');
  }

  _upsertTrade(t) {
    if (!t) return;
    const key = t.id || t.tx_id;
    if (key) this.trades.set(key, t);
  }

  isHydrated() { return this._hydrated; }

  stats() {
    return {
      hydrated: this._hydrated,
      markets: this.markets.size,
      wallets: this.wallets.size,
      signals: this.signals.size,
      trades: this.trades.size(),
      limitOrders: this.limitOrders.size,
      notificationUsers: this.notifications.size,
    };
  }
}

export const cache = new PulsCache();
export default cache;
