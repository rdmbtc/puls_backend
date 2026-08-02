// ── x402 Markets — buy live market data for $0.01 ─────────────────────────────
//
// The first paid market-data endpoint in the Puls x402 Bazaar: anyone (human
// or agent) pays $0.01 USDC via Circle Gateway on Arc Testnet and receives a
// live snapshot of the prediction-market feed — prices, volume, liquidity,
// deadlines — in compact JSON ready for LLM prompts.
//
//   curl -H 'payment-signature: ...' https://api.pulsmarket.tech/api/x402/markets
//   curl -H 'payment-signature: ...' 'https://api.pulsmarket.tech/api/x402/markets?count=5'
//
// Paired with /api/x402/info (payment config) and /api/bazaar (discovery).

import { x402Paywall } from './x402.js';

const MARKETS_PRICE = '$0.01'; // ten lepton-coins: the bazaar's mid tier

export function registerX402Markets(app, deps) {
  const { fetchGamma } = deps;

  // The paid endpoint: $0.01 per snapshot.
  app.get('/api/x402/markets', x402Paywall(MARKETS_PRICE, '/api/x402/markets', {
    description: 'Live prediction-market snapshot: prices, volume, liquidity, deadlines — settled on Arc.',
  }), async (req, res) => {
    try {
      const count = Math.min(50, Math.max(1, parseInt(req.query.count || '20', 10)));
      const category = String(req.query.category || '').trim();

      let list = [];
      try {
        list = await fetchGamma(`/markets?limit=${count}&active=true&closed=false&order=volume&ascending=false`);
      } catch (e) {
        console.error('[x402/markets] gamma fetch failed:', e.message);
      }
      if (!Array.isArray(list)) list = [];

      const snapshot = list
        .filter((m) => !category || String(m.category || '').toLowerCase() === category.toLowerCase())
        .map((m) => {
          let yes = 0.5, no = 0.5;
          try {
            const p = JSON.parse(m.outcomePrices || '["0.5","0.5"]').map((x) => parseFloat(x) || 0.5);
            yes = p[0]; no = p[1];
          } catch (_) {}
          return {
            slug: m.slug || null,
            question: m.question || null,
            category: m.category || 'General',
            yesPrice: parseFloat(yes.toFixed(4)),
            noPrice: parseFloat(no.toFixed(4)),
            volume: m.volume ? parseFloat(m.volume) : null,
            liquidity: m.liquidity ? parseFloat(m.liquidity) : null,
            endDate: m.endDate || null,
            acceptingOrders: m.closed !== true && m.resolved !== true,
            createdAt: m.createdAt || null,
          };
        });

      res.json({
        ok: true,
        paid: MARKETS_PRICE,
        count: snapshot.length,
        markets: snapshot,
        settled: req.x402 ? { by: req.x402.payer, tx: req.x402.transaction, arcscan: req.x402.transaction ? `https://testnet.arcscan.app/tx/${req.x402.transaction}` : null } : null,
        note: 'Live market snapshot purchased via x402 on Arc Testnet. Prices are Polymarket consensus blended with on-chain Puls liquidity.',
      });
    } catch (e) {
      console.error('[x402/markets] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[x402/markets] register: /api/x402/markets (${MARKETS_PRICE} per snapshot)`);
}
