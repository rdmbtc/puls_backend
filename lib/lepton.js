// ── Pay a Lepton, Ask the Swarm ─────────────────────────────────────────────
//
// A public, keyless x402 endpoint where anyone pays exactly $0.000001 (one
// lepton, the smallest coin) and receives the Puls agent swarm's live consensus
// on any question. No login, no API key — judge runs a single curl, sees a
// real sub-cent nanopayment settle on Arc, and gets a real AI answer.
//
//   curl -H 'accept-payment: ...' https://api.pulsmarket.tech/api/lepton/ask?q=Will+Solana+flip+Ethereum
//
// Paired with an info endpoint showing the endpoint's x402 config so the
// buyer's GatewayClient can construct the payment.

import { x402Paywall } from './x402.js';

const LEPTON_PRICE = '$0.000001'; // one lepton — the smallest coin

export function registerLepton(app, deps) {
  const { researchQuestion, llmComplete, formatForApp } = deps;

  // Public x402 config for buyer agents — includes the lepton endpoint.
  app.get('/api/lepton/info', (req, res) => {
    return res.json({
      network: 'eip155:5042002',
      asset: '0x3600000000000000000000000000000000000000',
      gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      configured: true,
      paywalledEndpoints: [
        { path: '/api/alpha/sample', price: '$0.001', method: 'GET' },
        { path: '/api/lepton/ask', price: LEPTON_PRICE, method: 'GET' },
      ],
      receiptsEndpoint: '/api/x402/payments',
      leptonNote: 'One lepton ($0.000001) — the smallest coin, clearing in under 500ms on Arc. curl -H "payment-signature: ..." https://api.pulsmarket.tech/api/lepton/ask?q=Will+Solana+flip+Ethereum',
    });
  });

  // The paid endpoint: $0.000001 per question to the swarm.
  app.get('/api/lepton/ask', x402Paywall(LEPTON_PRICE, '/api/lepton/ask', {
    description: 'Ask the Puls agent swarm — one lepton, one answer, settled on Arc.',
  }), async (req, res) => {
    try {
      const question = String(req.query.q || req.query.question || '').trim();
      if (!question) return res.status(400).json({ error: 'Question required. Try ?q=Will+Solana+flip+Ethereum' });

      // Research the question using the same pipeline the agents use
      let brief = '', sources = [];
      try {
        const r = await researchQuestion(question, 6);
        brief = r?.brief || '';
        sources = Array.isArray(r?.sources) ? r.sources.slice(0, 10) : [];
      } catch (_) {}

      // Ask the LLM to provide a sharp, calibrated forecast
      let answer = '', confidence = null, lean = 'UNCERTAIN';
      try {
        const sys = `You are an autonomous forecasting agent on Puls. A user paid one lepton ($0.000001) for your best prediction on their question. Output a SHARP, FALSIFIABLE forecast — no hedging, no "it depends." Include a confidence (50-95%) and a one-sentence invalidation. STRICT JSON only: {"answer":"<3-4 sentence forecast with key drivers>","confidence":<0.5-0.95>,"lean":"YES"|"NO"|"UNCERTAIN"}`;
        const u = `Question: "${question}"${brief ? `\n\nLive research:\n${brief}` : ''}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], {});
        const j = JSON.parse(raw || '{}');
        answer = formatForApp(String(j.answer || raw || '').slice(0, 1000));
        confidence = typeof j.confidence === 'number' ? Math.max(0.5, Math.min(0.95, j.confidence)) : null;
        lean = ['YES', 'NO'].includes(j.lean) ? j.lean : 'UNCERTAIN';
      } catch (_) {
        answer = 'The swarm couldn\'t form a consensus right now — try a different question.';
      }

      res.json({
        ok: true,
        question,
        answer,
        confidence,
        lean,
        sourcesCount: sources.length,
        sources: sources.map((s) => ({ title: s.title, url: s.url, source: s.source })),
        paid: LEPTON_PRICE,
        settled: req.x402 ? { by: req.x402.payer, tx: req.x402.transaction, arcscan: req.x402.transaction ? `https://testnet.arcscan.app/tx/${req.x402.transaction}` : null } : null,
        note: 'One lepton paid — the smallest coin, clearing in under 500ms on Arc.',
      });
    } catch (e) {
      console.error('[lepton] ask error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Demo endpoint: free answer (no x402 payment) — rate limited per IP.
  // Lets judges test without an x402 wallet.
  const _demoRateLimit = new Map(); // ip -> lastRequestTs
  app.get('/api/lepton/demo', async (req, res) => {
    try {
      // Rate limit: 1 request per IP per 5 min
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const lastTs = _demoRateLimit.get(ip) || 0;
      if (Date.now() - lastTs < 5 * 60 * 1000) {
        return res.status(429).json({ error: 'Demo rate limited — try again in a few minutes, or use the paid endpoint with x402.' });
      }
      _demoRateLimit.set(ip, Date.now());

      const question = String(req.query.q || req.query.question || 'Will BTC hit $100k in 2026?').trim();

      let brief = '', sources = [];
      try {
        const r = await researchQuestion(question, 3);
        brief = r?.brief || '';
        sources = Array.isArray(r?.sources) ? r.sources.slice(0, 5) : [];
      } catch (_) {}

      let answer = '', confidence = null, lean = 'UNCERTAIN';
      try {
        const sys = `You are an autonomous forecasting agent on Puls (Arc Testnet). Answer with a SHARP, FALSIFIABLE forecast. STRICT JSON: {"answer":"<3-4 sentences with key drivers>","confidence":<0.5-0.95>,"lean":"YES"|"NO"|"UNCERTAIN"}`;
        const u = `Question: "${question}"${brief ? `\n\nLive research:\n${brief}` : ''}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], {});
        const j = JSON.parse(raw || '{}');
        answer = formatForApp(String(j.answer || raw || '').slice(0, 1000));
        confidence = typeof j.confidence === 'number' ? Math.max(0.5, Math.min(0.95, j.confidence)) : null;
        lean = ['YES', 'NO'].includes(j.lean) ? j.lean : 'UNCERTAIN';
      } catch (_) {
        answer = 'The swarm is busy — try again in a moment.';
      }

      res.json({
        ok: true,
        demo: true,
        question,
        answer,
        confidence,
        lean,
        sourcesCount: sources.length,
        sources: sources.map((s) => ({ title: s.title, url: s.url, source: s.source })),
        paid: '$0.00 (demo mode — no x402 payment)',
        note: 'This is a free demo answer. For sub-cent paid answers with on-chain settlement, use the x402 endpoint: curl -H "payment-signature: ..." https://api.pulsmarket.tech/api/lepton/ask?q=...',
      });
    } catch (e) {
      console.error('[lepton] demo error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[lepton] register: /api/lepton/ask (' + LEPTON_PRICE + ' per question) + /api/lepton/demo (free, rate-limited)');
}
