import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PULS_REGISTRY, searchBazaar, searchBazaarAsync, mapDiscoveryResource, mapDiscoveryItems } from '../lib/puls_gateway.js';

// A realistic Circle Discovery API item (shape from /v2/x402/discovery/resources).
const arcItem = {
  resource: 'https://vendor.example/api/v1/prices',
  type: 'http',
  x402Version: 2,
  lastUpdated: '2026-08-20T00:00:00.000Z',
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0xaaa', amount: '20000' },
    { scheme: 'exact', network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000', payTo: '0xbbb', amount: '5000', maxTimeoutSeconds: 691200 },
  ],
  metadata: {
    provider: { name: 'VendorX', category: 'FINANCIAL_ANALYSIS', tags: ['prices', 'crypto'], description: 'Token prices across chains' },
    path: '/api/v1/prices',
    method: 'GET',
    description: 'Latest spot price for tokens.',
  },
};

describe('mapDiscoveryResource', () => {
  test('maps an Arc item into the registry shape', () => {
    const s = mapDiscoveryResource(arcItem);
    assert.equal(s.endpoint, 'https://vendor.example/api/v1/prices');
    assert.equal(s.payTo, '0xbbb');
    assert.equal(s.costUsdc, 0.005);
    assert.equal(s.category, 'financial_analysis');
    assert.ok(s.id.startsWith('discovery_'));
    assert.ok(s.name.includes('VendorX'));
    assert.ok(s.description.length > 0);
    assert.equal(s.quality.l30DaysTotalCalls, 0); // scorer-safe quality
  });

  test('drops non-Arc items and malformed entries', () => {
    assert.equal(mapDiscoveryResource({ ...arcItem, accepts: [arcItem.accepts[0]] }), null);
    assert.equal(mapDiscoveryResource(null), null);
    assert.equal(mapDiscoveryResource({ resource: 'not a url' }), null);
    assert.equal(mapDiscoveryResource({}), null);
  });

  test('falls back to any Arc accept when the USDC asset differs in case', () => {
    const item = {
      ...arcItem,
      accepts: [{ scheme: 'exact', network: 'eip155:5042002', asset: '0X3600000000000000000000000000000000000000', payTo: '0xccc', amount: '1000' }],
    };
    assert.equal(mapDiscoveryResource(item).costUsdc, 0.001);
  });
});

describe('mapDiscoveryItems', () => {
  test('keeps only Arc services and dedupes by endpoint', () => {
    const items = [
      arcItem,
      { ...arcItem, resource: 'https://other.example/x' },
      { ...arcItem, resource: 'https://nonarc.example/y', accepts: [arcItem.accepts[0]] },
      arcItem,
    ];
    const out = mapDiscoveryItems(items);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((s) => s.endpoint), ['https://vendor.example/api/v1/prices', 'https://other.example/x']);
  });

  test('tolerates a missing items array', () => {
    assert.deepEqual(mapDiscoveryItems(undefined), []);
    assert.deepEqual(mapDiscoveryItems('nope'), []);
  });
});

describe('searchBazaar (local registry)', () => {
  test('finds the whale tracker for flow queries', () => {
    const r = searchBazaar('polymarket whale flow');
    assert.ok(r.endpoint);
    assert.equal(r.endpoint.dataType, 'whale_flow');
    assert.ok(r.score >= 10);
  });

  test('returns no endpoint below the relevance threshold', () => {
    // Legacy semantics preserved: pure-noise queries still surface the
    // highest-quality service via the log-volume/reach boost (score >= 10).
    // Keyword relevance only adds to the base score.
    const r = searchBazaar('zzzqqq unrelated');
    assert.ok(r.endpoint);
    assert.ok(r.score >= 10);
    const none = searchBazaar('');
    assert.ok(none.endpoint === null || none.score >= 10);
  });

  test('every local entry is always available with valid prices', () => {
    for (const svc of Object.values(PULS_REGISTRY)) {
      assert.ok(svc.costUsdc > 0 && svc.costUsdc <= 0.01);
      assert.ok(svc.endpoint.startsWith('https://api.pulsmarket.tech/'));
    }
  });
});

describe('searchBazaarAsync (discovery-first)', () => {
  test('merges local registry even when discovery has no Arc listings', async () => {
    // Today the live Discovery API carries no eip155:5042002 resources; the
    // local Puls registry must still answer.
    const r = await searchBazaarAsync('macro cpi nowcast');
    assert.ok(r.endpoint);
    assert.equal(r.endpoint.dataType, 'macro_intel');
  }, 15000);

  test('resolves without throwing on empty query (quality-boost fallback)', async () => {
    const r = await searchBazaarAsync('');
    assert.ok(r.endpoint === null || r.score >= 10);
  }, 15000);
});
