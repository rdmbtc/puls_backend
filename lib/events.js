/**
 * Puls internal event bus — single-process pub/sub.
 *
 * Replaces Supabase polling for cross-module coordination. Route handlers
 * and agent functions emit events after successful writes; the cache and
 * interested agents subscribe to stay in sync without touching the DB.
 *
 * Single-dyno assumption: this bus lives in-process (verified: Heroku logs
 * show only `web.1`, no Procfile, no worker dynos). If the app ever scales
 * horizontally, swap `eventBus` for a Redis Pub/Sub adapter preserving the
 * same `emit`/`on`/`safeEmit` surface — subscribers stay unchanged.
 *
 * Contract for emitters:
 *   - Emit ONLY after the Supabase write has succeeded (Supabase is source
 *     of truth; the cache must never hold data that failed to persist).
 *   - Pass the full row (or a payload with enough fields to update cache
 *     slices and let agents react without a re-query).
 *
 * Contract for listeners:
 *   - Must not throw (safeEmit catches errors, but plain `emit` does not —
 *     use safeEmit from route handlers; listeners should still try/catch).
 *   - Slow work (LLM calls, on-chain writes) MUST defer via setImmediate
 *     so the HTTP response that triggered the emit is not blocked.
 */
import { EventEmitter } from 'node:events';

/**
 * Canonical event names. Import EVENTS.* instead of string literals so
 * typos surface as `undefined` emits (silent no-op) rather than phantom
 * subscriptions that never fire.
 */
export const EVENTS = {
  // Trades (lifecycle of a `trades` row)
  TRADE_CREATED: 'trade:created',       // row inserted, state=INITIATED
  TRADE_COMPLETE: 'trade:complete',     // state=COMPLETE (on-chain confirmed)
  TRADE_FAILED: 'trade:failed',         // state=FAILED | DENIED | CANCELLED

  // Markets (deployed_markets table)
  MARKET_CREATED: 'market:created',     // row inserted (may not be activated yet)
  MARKET_ACTIVATED: 'market:activated', // contract deployed + row updated
  MARKET_RESOLVED: 'market:resolved',   // resolved=true, outcome set
  MARKET_ARCHIVED: 'market:archived',  // archived=true

  // Wallets
  WALLET_CREATED: 'wallet:created',            // new wallet row
  WALLET_BALANCE_CHANGED: 'wallet:balance_changed', // balance updated

  // Creator signals
  SIGNAL_PUBLISHED: 'signal:published',  // status=published
  SIGNAL_ARCHIVED: 'signal:archived',     // status=archived

  // Limit orders
  ORDER_LIMIT_PLACED: 'order:limit_placed',     // new PENDING order
  ORDER_LIMIT_FILLED: 'order:limit_filled',      // status=EXECUTED
  ORDER_LIMIT_CANCELLED: 'order:limit_cancelled',// status=CANCELLED

  // Social
  COMMENT_CREATED: 'comment:created',
  BLOG_PUBLISHED: 'blog:published',

  // Notifications (fired by createNotification so the WS/FCM layer can push)
  NOTIFICATION_CREATED: 'notification:created',
};

class PulsEventBus extends EventEmitter {
  constructor() {
    super();
    // Many subscribers: cache + each agent + ws broadcast + notification writer
    this.setMaxListeners(100);
  }

  /**
   * Emit without throwing on listener errors. One bad subscriber must never
   * 500 the HTTP request that triggered the emit. Listeners are still
   * encouraged to try/catch their own async work.
   */
  safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (e) {
      console.error(`[eventBus] listener error on "${event}":`, e.message);
    }
  }
}

export const eventBus = new PulsEventBus();
export default eventBus;
