import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { synthesizeMarketFromNews, registerNewsCreatorRoutes } from '../lib/news_creator.js';

test('news_creator: synthesizeMarketFromNews creates formatted binary market spec', () => {
  const spec = synthesizeMarketFromNews({
    title: 'OpenAI releases GPT-5 by end of August 2026',
    summary: 'Reports indicate next-gen model entering final safety evals.',
    sourceUrl: 'https://techcrunch.com/2026/openai-model',
    category: 'AI',
    daysUntilClose: 12,
    creator: 'Sage 🧠',
  });

  assert.ok(spec.slug.startsWith('news-openai-releases-gpt-5'));
  assert.equal(spec.question, 'Will OpenAI releases GPT-5 by end of August 2026?');
  assert.equal(spec.creator, 'Sage 🧠');
  assert.equal(spec.creatorType, 'agent');
  assert.equal(spec.initialLiquidityUsdc, 5.0);
  assert.ok(spec.resolutionCriteria.includes('techcrunch.com'));
});

test('news_creator: registers HTTP endpoints for creating and querying news markets', async () => {
  const app = express();
  app.use(express.json());
  registerNewsCreatorRoutes(app);

  const server = app.listen(0);
  const { port } = server.address();

  try {
    const postRes = await fetch(`http://localhost:${port}/api/markets/create-from-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Anthropic launches autonomous agent payments on Arc',
        category: 'Crypto',
      }),
    });

    assert.equal(postRes.status, 201);
    const postJson = await postRes.json();
    assert.equal(postJson.ok, true);
    assert.equal(postJson.market.category, 'Crypto');

    const getRes = await fetch(`http://localhost:${port}/api/markets/news-candidates`);
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.total, 1);
    assert.equal(getJson.candidates[0].creator, 'Sage 🧠');
  } finally {
    server.close();
  }
});
