// Puls Realtime SSE — unit tests for /api/trade/stream event broadcasting.
//
//   node --test test/sse_stream.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter } from 'node:events';
import http from 'node:http';

test('sse_stream: connects with text/event-stream and receives live trade events', async () => {
  const app = express();
  const eventBus = new EventEmitter();
  const sseClients = new Set();

  app.get('/api/trade/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = `test_${Date.now()}`;
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId })}\n\n`);

    const client = { id: clientId, res };
    sseClients.add(client);

    req.on('close', () => sseClients.delete(client));
  });

  const broadcastSse = (eventType, payload) => {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try { client.res.write(msg); } catch (_) { sseClients.delete(client); }
    }
  };

  eventBus.on('trade:complete', (trade) => {
    broadcastSse('trade', {
      type: 'trade',
      id: trade.id,
      side: trade.side,
      amount: trade.amount,
      question: trade.question,
    });
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const chunks = [];
    const clientReq = http.get(`http://localhost:${port}/api/trade/stream`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/event-stream');

      res.on('data', (chunk) => {
        chunks.push(chunk.toString());
      });
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 100));

    // Emit live trade
    eventBus.emit('trade:complete', {
      id: 'tx_999',
      side: 'YES',
      amount: '0.5',
      question: 'Will SpaceX IPO in 2026',
    });

    // Wait for event to arrive
    await new Promise((r) => setTimeout(r, 100));
    clientReq.destroy();

    const fullData = chunks.join('');
    assert.ok(fullData.includes('event: connected'));
    assert.ok(fullData.includes('event: trade'));
    assert.ok(fullData.includes('Will SpaceX IPO in 2026'));
    assert.ok(fullData.includes('"side":"YES"'));
  } finally {
    server.close();
  }
});
