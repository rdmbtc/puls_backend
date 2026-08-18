// Puls Invest — unit tests for agent sponsorship, 80/20 profit sharing math and positions.
//
//   node --test test/invest.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerInvest } from '../lib/invest.js';

test('invest: /api/invest/agents returns public roster with strategy and pool stats', async () => {
  const app = express();
  app.use(express.json());

  // Stub /api/agents/roster
  app.get('/api/agents/roster', (_req, res) => {
    res.json({
      ok: true,
      agents: [
        { key: 'vega', name: 'Vega ⚡', balance: '12.5' },
        { key: 'cygnus', name: 'Cygnus 🛡️', balance: '15.0' },
      ],
    });
  });

  const mockSupabase = {
    from: (table) => {
      if (table === 'investments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === 'trades') {
        return {
          select: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  registerInvest(app, {
    supabase: mockSupabase,
    publicClient: null,
    walletClient: null,
    adminAccount: { address: '0xtreasury123' },
    auth: {},
    circle: null,
    getWalletId: async () => 'wid_123',
    getWalletInfo: async () => ({ address: '0x123' }),
    authenticateUser: (req, _res, next) => next(),
    requireVerifiedUser: (req, _res, next) => next(),
    strictLimiter: (_req, _res, next) => next(),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/invest/agents`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.agents.length >= 8);

    const vega = json.agents.find((a) => a.key === 'vega');
    assert.ok(vega);
    assert.equal(vega.name, 'Vega ⚡');
    assert.ok(vega.strategy.includes('momentum'));
    assert.equal(json.performanceFeePct, 20); // 80/20 split
  } finally {
    server.close();
  }
});
