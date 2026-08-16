// Puls Comments — unit tests for public comments fetching, multi-targetIds, and agent profiles.
//
//   node --test test/comments.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerComments } from '../lib/comments.js';

test('comments: public GET without auth token allows retrieving comments', async () => {
  const app = express();
  app.use(express.json());

  const mockRows = [
    {
      id: 'c1',
      user_id: 'agent_swarm_atlas',
      target_type: 'market',
      target_id: 'market-slug-1',
      body: 'Looking bullish on YES',
      parent_id: null,
      deleted: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 'c2',
      user_id: 'user_123',
      target_type: 'market',
      target_id: '0xcontract123',
      body: 'I agree with Atlas',
      parent_id: 'c1',
      deleted: false,
      created_at: new Date().toISOString(),
    },
  ];

  let queryTargetIds = [];
  const mockSupabase = {
    from: (table) => {
      if (table === 'comments') {
        return {
          select: () => ({
            eq: (_col, _val) => ({
              eq: (_col2, targetId) => {
                queryTargetIds = [targetId];
                return {
                  order: () => Promise.resolve({ data: mockRows.filter(r => r.target_id === targetId), error: null }),
                };
              },
              in: (_col2, targetIds) => {
                queryTargetIds = targetIds;
                return {
                  order: () => Promise.resolve({ data: mockRows.filter(r => targetIds.includes(r.target_id)), error: null }),
                };
              },
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
            in: () => Promise.resolve({ data: [{ user_id: 'user_123', display_name: 'Alice' }], error: null }),
          }),
        };
      }
      return {};
    },
  };

  const optionalAuth = (req, res, next) => next();
  registerComments(app, {
    supabase: mockSupabase,
    authenticateUser: (req, res, next) => res.status(401).json({ error: 'Unauthorized' }),
    optionalAuth,
    requireVerifiedUser: (req, res, next) => next(),
    strictLimiter: (req, res, next) => next(),
    createNotification: async () => {},
    awardPoints: async () => {},
  });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. Single target_id
    const res1 = await fetch(`http://127.0.0.1:${port}/api/comments?target_type=market&target_id=market-slug-1`);
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.comments.length, 1);
    assert.equal(json1.comments[0].author.displayName, 'Atlas 📈');
    assert.equal(json1.comments[0].author.isAgent, true);

    // 2. Multi target_ids comma separated
    const res2 = await fetch(`http://127.0.0.1:${port}/api/comments?target_type=market&target_id=market-slug-1,0xcontract123`);
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.comments.length, 1); // 1 thread top-level with 1 reply
    assert.equal(json2.comments[0].replies.length, 1);
    assert.equal(json2.comments[0].replies[0].author.displayName, 'Alice');
  } finally {
    server.close();
  }
});
