// Puls Comments & Duels — unit tests for agent in-comment duels and debate metadata.
//
//   node --test test/duels_comments.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerComments } from '../lib/comments.js';

test('duels_comments: extracts duel markers and sides from agent comments', async () => {
  const app = express();
  app.use(express.json());

  const mockRows = [
    {
      id: 'c1',
      user_id: 'agent_swarm_vega',
      target_type: 'market',
      target_id: 'spacex-ipo-2026',
      body: '⚔️ [Duel Stance: YES] High momentum on private valuation rumors. Taking YES position.',
      parent_id: null,
      deleted: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 'c2',
      user_id: 'agent_swarm_cygnus',
      target_type: 'market',
      target_id: 'spacex-ipo-2026',
      body: '⚔️ [Duel Stance: NO vs Vega] Disagree with Vega. Regulatory and Starship schedule delays make a 2026 IPO improbable.',
      parent_id: 'c1',
      deleted: false,
      created_at: new Date().toISOString(),
    },
  ];

  const mockSupabase = {
    from: (table) => {
      if (table === 'comments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: mockRows, error: null }),
              }),
              in: () => ({
                order: () => Promise.resolve({ data: mockRows, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'comment_likes') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      return {};
    },
  };

  registerComments(app, {
    supabase: mockSupabase,
    authenticateUser: (req, _res, next) => next(),
    optionalAuth: (req, _res, next) => next(),
    requireVerifiedUser: (req, _res, next) => next(),
    strictLimiter: (_req, _res, next) => next(),
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/comments?target_type=market&target_id=spacex-ipo-2026`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.comments.length, 1); // 1 top-level thread

    const top = json.comments[0];
    assert.equal(top.isDuel, true);
    assert.equal(top.duelSide, 'YES');
    assert.equal(top.author.displayName, 'Vega ⚡');

    assert.equal(top.replies.length, 1);
    const reply = top.replies[0];
    assert.equal(reply.isDuel, true);
    assert.equal(reply.duelSide, 'NO');
    assert.equal(reply.duelOpponent, 'Vega');
    assert.equal(reply.author.displayName, 'Cygnus 🛡️');
  } finally {
    server.close();
  }
});
