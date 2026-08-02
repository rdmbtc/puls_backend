// ── Puls Bazaar — public x402 discovery registry on Arc Testnet ───────────────
//
// The first x402 Bazaar on Arc Testnet: a live, searchable catalog of paid
// endpoints. Every service sells USDC nanopayments via Circle Gateway and
// settles on Arc (eip155:5042002). Buyers (humans or agents) discover a
// service here, read its exact payment requirements, and pay with any standard
// x402 client (Circle CLI, @circle-fin/x402-batching GatewayClient, ...).
//
//   GET /api/bazaar            → full catalog
//   GET /api/bazaar/search?q=  → hybrid relevance + quality ranking
//   GET /api/bazaar/:id        → single service + live payment requirements
//
// Mirrors the CDP x402 Bazaar discovery model, but self-hosted on Arc Testnet.

import { x402Paywall } from './x402.js';

const ARC_TESTNET_NETWORK = 'eip155:5042002';
const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000';

// Puls Bazaar catalog: every endpoint Puls itself sells on Arc Testnet.
// `requirements` are the exact Gateway batching params a buyer must sign —
// identical to what x402Paywall advertises in its 402 PAYMENT-REQUIRED header.
const BAZAAR_CATALOG = [
  {
    id: 'puls-lepton',
    name: 'Puls Lepton Oracle',
    description: 'Ask the Puls agent swarm any question — one lepton ($0.000001), one sharp falsifiable forecast with confidence and sources, settled on Arc in under 500ms.',
    endpoint: 'https://api.pulsmarket.tech/api/lepton/ask',
    costUsdc: 0.000001,
    category: 'ai_forecasting',
    dataType: 'swarm_consensus',
    ttlSeconds: 60,
    quality: { l30DaysTotalCalls: 12, l30DaysUniquePayers: 2 },
  },
  {
    id: 'puls-market-snapshot',
    name: 'Puls Market Snapshot',
    description: 'Live prediction-market feed: prices, volume, liquidity and deadlines for the top Polymarket-style markets, in compact LLM-ready JSON. $0.01 per snapshot.',
    endpoint: 'https://api.pulsmarket.tech/api/x402/markets',
    costUsdc: 0.01,
    category: 'prediction_markets',
    dataType: 'market_snapshot',
    ttlSeconds: 30,
    quality: { l30DaysTotalCalls: 4, l30DaysUniquePayers: 2 },
  },
  {
    id: 'puls-alpha-sample',
    name: 'Puls Alpha Signal',
    description: 'Premium house forecast with stance, confidence, thesis and edge — the flagship creator-loop signal at $0.001.',
    endpoint: 'https://api.pulsmarket.tech/api/alpha/sample',
    costUsdc: 0.001,
    category: 'signals',
    dataType: 'alpha_forecast',
    ttlSeconds: 300,
    quality: { l30DaysTotalCalls: 5, l30DaysUniquePayers: 1 },
  },
  {
    id: 'puls-director',
    name: 'Puls Finance Director',
    description: 'A structured, risk-managed prediction portfolio sized to your balance — the highest-tier agent product.',
    endpoint: 'https://api.pulsmarket.tech/api/agent/director',
    costUsdc: 0.5,
    category: 'ai_finance',
    dataType: 'portfolio_plan',
    ttlSeconds: 600,
    quality: { l30DaysTotalCalls: 0, l30DaysUniquePayers: 0 },
  },
];

// Live payment requirements for a service — same params the 402 advertises.
function paymentRequirementsFor(service, sellerAddress) {
  const amount = Math.round(service.costUsdc * 1_000_000);
  return {
    scheme: 'exact',
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amount.toString(),
    payTo: sellerAddress || null,
    maxTimeoutSeconds: 691200,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    },
  };
}

/**
 * CDP-style hybrid search: keyword relevance + quality ranking (log volume).
 * @param {string} query
 * @returns {Array<{service: object, score: number}>} sorted by score desc
 */
function searchBazaar(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];

  const scored = [];
  for (const service of BAZAAR_CATALOG) {
    const haystack = [
      service.name,
      service.description,
      service.category,
      service.dataType,
    ].join(' ').toLowerCase();

    let score = 0;
    const keywords = q.split(/[^a-zA-Z0-9]+/).filter((k) => k.length >= 3);
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        score += service.name.toLowerCase().includes(kw) ? 30 : 15;
      }
    }
    if (score === 0 && q.length > 3 && haystack.includes(q)) score += 10;

    const volumeBoost = Math.log10(service.quality.l30DaysTotalCalls || 1) * 2;
    const reachBoost = Math.log10(service.quality.l30DaysUniquePayers || 1) * 3;
    score += volumeBoost + reachBoost;

    if (score >= 10) scored.push({ service, score: Math.round(score) });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** Full catalog + gateway/seller context. */
export function bazaarCatalog(sellerAddress) {
  return {
    registry: 'Puls Bazaar',
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    sellerAddress: sellerAddress || null,
    count: BAZAAR_CATALOG.length,
    services: BAZAAR_CATALOG.map((s) => ({
      ...s,
      requirements: paymentRequirementsFor(s, sellerAddress),
    })),
  };
}

/**
 * Register Bazaar routes.
 * @param {import('express').Express} app
 */
export function registerBazaar(app) {
  // Full catalog (free — discovery is open; only data itself is paid).
  app.get('/api/bazaar', (req, res) => {
    const seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    res.json(bazaarCatalog(seller));
  });

  // Hybrid search — same discovery model the CDP Bazaar uses.
  app.get('/api/bazaar/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q query parameter required. Try /api/bazaar/search?q=prediction+markets' });
    const seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    const results = searchBazaar(q).map(({ service, score }) => ({
      ...service,
      score,
      searchMethod: 'hybrid',
      requirements: paymentRequirementsFor(service, seller),
    }));
    res.json({
      query: q,
      count: results.length,
      results,
      note: 'Hybrid relevance + quality ranking. Every result pays via Circle Gateway on Arc Testnet.',
    });
  });

  // Single service detail with live payment requirements.
  app.get('/api/bazaar/:id', (req, res) => {
    const service = BAZAAR_CATALOG.find((s) => s.id === req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found in Puls Bazaar' });
    const seller = (process.env.X402_SELLER_ADDRESS || '').trim();
    res.json({
      ...service,
      requirements: paymentRequirementsFor(service, seller),
      payExample: `circle services pay "${service.endpoint}"`,
    });
  });

  console.log('[bazaar] register: /api/bazaar, /api/bazaar/search, /api/bazaar/:id');
}
