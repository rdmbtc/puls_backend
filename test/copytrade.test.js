// Puls Copy-Trade — unit tests for following, leaders listing, and status checks.
//
//   node --test test/copytrade.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerCopyTrade } from '../lib/copytrade.js';

test('copytrade: leaders listing returns 8 swarm leaders and copiers count', async () => {
  const app = express();
  app.use(express.json());

  const mockFollowRows = [
    { leader_user_id: 'agent_swarm_vega' },
    { leader_user_id: 'agent_swarm_vega' },
    { leader_user_id: 'agent_swarm_cygnus' },
  ];

  const mockSupabase = {
    from: (table) => {
      if (table === 'copy_follows') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: mockFollowRows, error: null }),
          }),
        };
      }
      return {};
    },
  };

  registerCopyTrade(app, {
    supabase: mockSupabase,
    circle: null,
    USDC: '0xUSDC',
    publicClient: null,
    getWalletId: async () => 'wid_123',
    getWalletInfo: async () => ({ address: '0x123', usdcBalance: '10' }),
    getOrDeployMarket: async () => '0xmarket',
    isApproved: async () => true,
    saveTrade: async () => ({ id: 't1' }),
    authenticateUser: (req, _res, next) => next(),
    requireVerifiedUser: (req, _res, next) => next(),
    strictLimiter: (_req, _res, next) => next(),
    clampPrice: (p) => p,
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/copy/leaders`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.leaders.length >= 8);

    const vega = json.leaders.find((l) => l.id === 'agent_swarm_vega');
    assert.ok(vega);
    assert.equal(vega.copiersCount, 2);
    assert.equal(vega.name, 'Vega ⚡');

    const cygnus = json.leaders.find((l) => l.id === 'agent_swarm_cygnus');
    assert.ok(cygnus);
    assert.equal(cygnus.copiersCount, 1);
  } finally {
    server.close();
  }
});

test('copytrade: follow endpoint validates and stores active copy subscription', async () => {
  const app = express();
  app.use(express.json());

  let upsertedRow = null;
  const mockSupabase = {
    from: (table) => {
      if (table === 'copy_follows') {
        return {
          upsert: (row) => {
            upsertedRow = row;
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { ...row, id: 'f_1' }, error: null }),
              }),
            };
          },
        };
      }
      return {};
    },
  };

  registerCopyTrade(app, {
    supabase: mockSupabase,
    circle: null,
    USDC: '0xUSDC',
    publicClient: null,
    getWalletId: async () => 'wid_123',
    getWalletInfo: async () => ({ address: '0x123' }),
    getOrDeployMarket: async () => '0xmarket',
    isApproved: async () => true,
    saveTrade: async () => ({ id: 't1' }),
    authenticateUser: (req, _res, next) => {
      req.body.userId = 'user_trader_1';
      next();
    },
    requireVerifiedUser: (_req, _res, next) => next(),
    strictLimiter: (_req, _res, next) => next(),
    clampPrice: (p) => p,
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/copy/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaderUserId: 'agent_swarm_atlas', maxPerTradeUsdc: 5 }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(upsertedRow.follower_user_id, 'user_trader_1');
    assert.equal(upsertedRow.leader_user_id, 'agent_swarm_atlas');
    assert.equal(upsertedRow.max_per_trade_usdc, 5);
    assert.equal(upsertedRow.active, true);
  } finally {
    server.close();
  }
});
