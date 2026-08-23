// ═══════════════════════════════════════════════════════════════════════════════
// x402 Signals Discovery — free public catalog of purchasable creator signals.
//
// Lets HUMANS and AI AGENTS see which signals are available to buy through
// Circle Pay / x402 nanopayments on Arc Testnet before paying anything:
//
//   GET /api/x402/signals        → catalog (published signals, prices, payTo)
//   GET /api/x402/signals/:id    → detail incl. payment instructions
//
// Payment rails accepted by Puls agents buying each other's signals:
//   • Circle Agent Stack agents: Agent Wallet → Memo(USDC.transfer) via the
//     Circle CLI, memoKey = "signal:<id>"  (see lib/agent_swarm.js buySignal)
//   • Anyone else: plain on-chain USDC transfer to the creator address with
//     the same memo unlocks reconciliation.
//
// The paid THESIS body is NEVER exposed here — only `teaser`, which creators
// publish as the public preview by design.
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 30_000;
let _cache = { ts: 0, data: null };

const NETWORK = 'eip155:5042002';
const ASSET = '0x3600000000000000000000000000000000000000';

export function registerX402Signals(app, deps) {
  const { supabase, resolveAddress, USDC: usdcAddr } = deps;
  const asset = usdcAddr || ASSET;

  function paymentBlock(payTo, signalId) {
    return {
      network: NETWORK,
      asset,
      payTo: payTo || null,
      method: 'usdc-transfer-with-memo',
      memoKey: `signal:${signalId}`,
      note: 'USDC transfer with this memo credits the purchase; Circle Agent Stack agents pay automatically via Agent Wallet.',
    };
  }

  app.get('/api/x402/signals', async (req, res) => {
    try {
      if (_cache.data && Date.now() - _cache.ts < CACHE_TTL_MS) {
        return res.json(_cache.data);
      }
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
      const { data: rows, error } = await supabase
        .from('creator_signals')
        .select('id, title, market_question, stance, confidence, teaser, price_usdc, creator_user_id, created_at')
        .eq('status', 'published')
        .gt('price_usdc', 0)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);

      const signals = (rows || []).map((r) => ({
        id: r.id,
        title: r.title,
        marketQuestion: r.market_question || null,
        stance: r.stance,
        confidence: r.confidence,
        preview: r.teaser || null, // public teaser — full thesis is the paid content
        priceUsdc: Number(r.price_usdc),
        creator: r.creator_user_id,
        payTo: resolveAddress ? resolveAddress(r.creator_user_id) : null,
        createdAt: r.created_at,
        payment: paymentBlock(resolveAddress ? resolveAddress(r.creator_user_id) : null, r.id),
      }));

      const out = {
        ok: true,
        network: NETWORK,
        asset,
        count: signals.length,
        signals,
        note: 'Discovery catalog — free. Buying = USDC transfer with the signal memo key; thesis unlocks after settlement.',
      };
      _cache = { ts: Date.now(), data: out };
      res.json(out);
    } catch (e) {
      console.error('[x402/signals] catalog error:', e.message);
      res.status(500).json({ error: 'Failed to load signals catalog' });
    }
  });

  app.get('/api/x402/signals/:id', async (req, res) => {
    try {
      const { data: r, error } = await supabase
        .from('creator_signals')
        .select('id, title, market_question, stance, confidence, edge_bps, horizon, teaser, price_usdc, creator_user_id, created_at')
        .eq('id', String(req.params.id || '').trim())
        .eq('status', 'published')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!r) return res.status(404).json({ error: 'Signal not found' });

      const payTo = resolveAddress ? resolveAddress(r.creator_user_id) : null;
      res.json({
        ok: true,
        signal: {
          id: r.id,
          title: r.title,
          marketQuestion: r.market_question || null,
          stance: r.stance,
          confidence: r.confidence,
          edgeBps: r.edge_bps,
          horizon: r.horizon || null,
          preview: r.teaser || null,
          priceUsdc: Number(r.price_usdc),
          creator: r.creator_user_id,
          payTo,
          createdAt: r.created_at,
          payment: paymentBlock(payTo, r.id),
          thesisIncludedAfterPayment: true,
        },
      });
    } catch (e) {
      console.error('[x402/signals] detail error:', e.message);
      res.status(500).json({ error: 'Failed to load signal' });
    }
  });

  console.log('[x402/signals] discovery endpoints registered (/api/x402/signals)');
}

export default { registerX402Signals };
