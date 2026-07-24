/**
 * Puls raw-WebSocket gateway — backward-compat for existing Flutter clients
 * (`feed_screen.dart`, `onboarding/live_on_arc.dart`) that use the
 * `web_socket_channel` package and speak plain WS (not Socket.IO).
 *
 * Why both gateways exist:
 *   - Socket.IO (lib/socketio.js) — the new cyberpunk terminal UI uses it
 *     for auto-reconnect, per-event channels, acks, and the unified
 *     `puls:event` envelope. Rich client features.
 *   - Raw `ws` (this file) — existing feed clients expect plain JSON frames
 *     over plain WS. They were here first; rewriting them would break the
 *     feed and the live-on-Arc onboarding flow. Keep them working.
 *
 * Both gateways subscribe to the SAME eventBus and broadcast sanitized
 * payloads — no duplication of sanitization logic, no risk of the raw
 * channel leaking fields Socket.IO strips.
 *
 * Wiring (server.js):
 *   import { initRawWs } from './lib/socketws.js';
 *   const rawWs = initRawWs(server);
 */
import { WebSocketServer } from 'ws';
import { eventBus, EVENTS } from './events.js';

// Re-use the same denylist/whitelist as Socket.IO so both channels carry
// identical (sanitized) payloads.
import { sanitize } from './socketio.js';

/**
 * Attach a raw `ws` WebSocketServer to the given HTTP server and subscribe
 * to the canonical trade events on the internal eventBus. Existing Flutter
 * feed clients expect each frame to be a single JSON-encoded trade row.
 *
 * Uses `noServer: true` + a manual `upgrade` listener so we can coexist
 * with the Socket.IO gateway (which mounts on `/socket.io/`). Without this
 * filter, `ws` would intercept Socket.IO handshakes and break the new
 * cyberpunk UI's transport.
 *
 * @param {import('http').Server} server
 * @returns {import('ws').WebSocketServer}
 */
export function initRawWs(server) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  // Manually handle HTTP 'upgrade' requests, but ONLY for non-Socket.IO paths.
  // Socket.IO clients hit /socket.io/?…; raw ws clients hit / (root).
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    // Defer to Socket.IO for its own path; ignore everything else that isn't
    // a plain WS upgrade to the root.
    if (url.startsWith('/socket.io/')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    clients.add(ws);
    console.log(`[ws] raw client connected (total=${clients.size})`);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] raw client disconnected (total=${clients.size})`);
    });
    ws.on('error', (err) => {
      clients.delete(ws);
      console.warn('[ws] raw client error:', err?.message || err);
    });
  });

  // WebSocket ping/pong keepalive — prevents H15 "Idle connection" errors.
  // Dead connections are terminated and removed from the client set.
  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        client.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, 30_000);
  if (pingInterval.unref) pingInterval.unref();

  // Broadcast every TRADE_COMPLETE to raw ws clients as a single JSON frame.
  // (This is the contract the feed client expects: one trade per frame.)
  eventBus.on(EVENTS.TRADE_COMPLETE, (trade) => {
    if (clients.size === 0) return; // no clients → skip the JSON encode
    const payload = JSON.stringify(sanitize(EVENTS.TRADE_COMPLETE, trade));
    for (const client of clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(payload);
        } catch (err) {
          console.warn('[ws] broadcast failed:', err.message);
        }
      }
    }
  });

  // Also surface market resolution + signal publishes on the raw channel as
  // generic event envelopes (the feed client ignores unknown shapes).
  for (const evt of [EVENTS.MARKET_RESOLVED, EVENTS.SIGNAL_PUBLISHED]) {
    eventBus.on(evt, (payload) => {
      if (clients.size === 0) return;
      const frame = JSON.stringify({
        __event: evt,
        ...(payload && typeof payload === 'object' ? payload : {}),
      });
      for (const client of clients) {
        if (client.readyState === 1) {
          try {
            client.send(frame);
          } catch (_) {}
        }
      }
    });
  }

  console.log('[ws] raw WebSocket gateway attached (backward-compat for feed clients)');
  return wss;
}

export default initRawWs;
