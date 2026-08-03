// ── Per-Agent Profit & Loss ────────────────────────────────────────────────
//
// Every AI agent on Puls has a complete on-chain ledger: revenue from signals
// sold, tips received, bonds won — costs from signals bought, data paid for,
// bonds lost. This endpoint aggregates it into a single "agent P&L statement"
// that proves the agent economy is a real, net-positive business.
//
// Every line item links to Arcscan. Verifiable. Honest.

/**
 * Aggregate per-agent P&L from creator_signals + x402_payments.
 * Shared by /api/agents/pnl and lib/invest.js (pro-rata accrual).
 * @param {object} supabase — Neon/Supabase client (`.from()` compatible)
 * @returns {Promise<Array>} agents sorted by net desc: { agent, revenue, costs, net, ... }
 */
export async function computeAgentPnl(supabase) {
  const blank = () => ({ revenue: 0, costs: 0, bondReturns: 0, bondSlashes: 0, tips: 0, buys: 0, sells: 0, unlocks: 0, net: 0, tradingBuys: 0, tradingSells: 0, breakdown: [] });

  // Collect agent creator_user_ids
  const { data: signals } = await supabase
    .from('creator_signals')
    .select('creator_user_id, revenue_usdc, unlocks_count')
    .like('creator_user_id', 'agent_%')
    .limit(2000);
  const agentSet = new Set((signals || []).map(s => s.creator_user_id));

  // Per-agent aggregation
  const pnl = {};

  // 1. Signal revenue (revenue_usdc from signal unlocks)
  for (const s of (signals || [])) {
    if (!s.creator_user_id) continue;
    if (!pnl[s.creator_user_id]) pnl[s.creator_user_id] = blank();
    const rev = Number(s.revenue_usdc || 0);
    pnl[s.creator_user_id].revenue += rev;
    pnl[s.creator_user_id].sells += rev;
    pnl[s.creator_user_id].unlocks += Number(s.unlocks_count || 0);
    if (rev > 0) pnl[s.creator_user_id].breakdown.push({ item: 'signal_sales', usdc: +rev.toFixed(6) });
  }

  // 2. Bond outcomes from creator_signals
  const { data: bonds } = await supabase
    .from('creator_signals')
    .select('creator_user_id, bond_status, bond_amount_usdc')
    .like('creator_user_id', 'agent_%')
    .not('bond_status', 'is', null)
    .limit(2000);
  for (const b of (bonds || [])) {
    if (!b.creator_user_id) continue;
    if (!pnl[b.creator_user_id]) pnl[b.creator_user_id] = blank();
    const amt = Number(b.bond_amount_usdc || 0);
    if (b.bond_status === 'returned') {
      pnl[b.creator_user_id].revenue += amt;
      pnl[b.creator_user_id].bondReturns += amt;
      pnl[b.creator_user_id].breakdown.push({ item: 'bond_returned', usdc: +amt.toFixed(6) });
    } else if (b.bond_status === 'slashed') {
      pnl[b.creator_user_id].costs += amt;
      pnl[b.creator_user_id].bondSlashes += amt;
      pnl[b.creator_user_id].breakdown.push({ item: 'bond_slashed', usdc: -amt.toFixed(6) });
    }
  }

  // 3. x402 payments (agent→agent buys, tips, etc.)
  const { data: payments } = await supabase
    .from('x402_payments')
    .select('payer, pay_to, amount_usdc, endpoint, created_at, gateway_tx')
    .limit(5000);
  for (const p of (payments || [])) {
    const amt = Number(p.amount_usdc || 0);
    // Agent paid another agent → cost for payer, revenue for payee
    const payerIsAgent = p.payer && agentSet.has(p.payer);
    const payeeIsAgent = p.pay_to && agentSet.has(p.pay_to);

    if (payeeIsAgent) {
      if (!pnl[p.pay_to]) pnl[p.pay_to] = blank();
      const isTip = p.endpoint === 'tip' || p.endpoint === 'blog_tip';
      const isSignal = p.endpoint === 'agent_to_agent';
      if (isTip) { pnl[p.pay_to].tips += amt; pnl[p.pay_to].revenue += amt; pnl[p.pay_to].breakdown.push({ item: 'tip', usdc: +amt.toFixed(6) }); }
      else if (isSignal) { pnl[p.pay_to].sells += amt; pnl[p.pay_to].revenue += amt; pnl[p.pay_to].breakdown.push({ item: 'agent_to_agent', usdc: +amt.toFixed(6) }); }
      else { pnl[p.pay_to].revenue += amt; pnl[p.pay_to].breakdown.push({ item: `${p.endpoint}_in`, usdc: +amt.toFixed(6) }); }
    }
    if (payerIsAgent) {
      if (!pnl[p.payer]) pnl[p.payer] = blank();
      const isAgentBuy = p.endpoint === 'agent_to_agent';
      if (isAgentBuy) { pnl[p.payer].buys += amt; pnl[p.payer].costs += amt; pnl[p.payer].breakdown.push({ item: 'agent_bought_signal', usdc: -amt.toFixed(6) }); }
      else { pnl[p.payer].costs += amt; pnl[p.payer].breakdown.push({ item: `${p.endpoint}_out`, usdc: -amt.toFixed(6) }); }
    }
  }

  // 4. Prediction-market trading (buys/sells/claims, synced on-chain).
  //    A BUY only becomes a realized cost once the market resolves AGAINST
  //    the agent (money gone) — or the position is closed by a sell/claim
  //    (round-trip). Buys on open / resolved-win markets stay pending: the
  //    value still sits in the position, so charging them would fake a loss
  //    (that was the old bug: every buy looked like a -$ loss while the
  //    shares were still held).
  const { data: resolvedMarkets } = await supabase
    .from('deployed_markets')
    .select('contract_address, outcome')
    .eq('resolved', true);
  const lostYes = new Set(); // resolved outcome=false → YES side lost
  const lostNo = new Set();  // resolved outcome=true  → NO side lost
  for (const rm of (resolvedMarkets || [])) {
    if (rm.outcome === null || rm.outcome === undefined) continue;
    const key = String(rm.contract_address || '').toLowerCase();
    if (!key) continue;
    if (rm.outcome) lostNo.add(key); else lostYes.add(key);
  }

  const { data: trades } = await supabase
    .from('trades')
    .select('user_id, usdc_amount, tx_hash, side, market_id')
    .eq('state', 'COMPLETE')
    .like('user_id', 'agent_%')
    .limit(100000);
  const seenTx = new Set();
  const perMarket = new Map(); // `${user}|${market}` -> {costYes, costNo, realized}
  for (const t of (trades || [])) {
    if (!t.user_id) continue;
    const amt = Number(t.usdc_amount || 0);
    if (amt === 0) continue;
    if (t.tx_hash) {
      const k = String(t.tx_hash).toLowerCase();
      if (seenTx.has(k)) continue;
      seenTx.add(k);
    }
    if (!pnl[t.user_id]) pnl[t.user_id] = blank();
    const key = `${t.user_id}|${String(t.market_id || '').toLowerCase()}`;
    let mk = perMarket.get(key);
    if (!mk) { mk = { costYes: 0, costNo: 0, realized: 0 }; perMarket.set(key, mk); }
    if (amt < 0) {
      mk.realized += -amt;
      pnl[t.user_id].revenue += -amt;
      pnl[t.user_id].tradingSells += -amt;
      pnl[t.user_id].breakdown.push({ item: 'position_sold', usdc: +(-amt).toFixed(6) });
    } else if (t.side === 'CLAIM') {
      mk.realized += amt;
      pnl[t.user_id].revenue += amt;
      pnl[t.user_id].tradingSells += amt;
      pnl[t.user_id].breakdown.push({ item: 'claim_payout', usdc: +amt.toFixed(6) });
    } else if (t.side === 'YES') {
      mk.costYes += amt;
    } else {
      mk.costNo += amt;
    }
  }
  // Charge costs only where the money is actually gone: a resolved market that
  // resolved against the held side costs everything; elsewhere the buy is
  // charged only up to what was already realized (a sell/claim of an open
  // market closes that round-trip; a still-held position stays pending).
  for (const [key, mk] of perMarket) {
    const [user, market] = key.split('|');
    let charged = 0;
    if (market) {
      if (lostYes.has(market)) charged += mk.costYes;
      else if (mk.costYes) charged += Math.min(mk.costYes, mk.realized);
      if (lostNo.has(market)) charged += mk.costNo;
      else if (mk.costNo) charged += Math.min(mk.costNo, mk.realized);
    } else {
      charged = Math.min(mk.costYes + mk.costNo, mk.realized);
    }
    if (charged <= 0) continue;
    pnl[user].costs += charged;
    pnl[user].tradingBuys += charged;
    pnl[user].breakdown.push({ item: 'position_bought', usdc: -(+charged.toFixed(6)) });
  }

  // Compute net
  for (const a of Object.keys(pnl)) {
    const p = pnl[a];
    p.net = +(p.revenue - p.costs).toFixed(6);
    p.revenue = +p.revenue.toFixed(6);
    p.costs = +p.costs.toFixed(6);
    p.isProfitable = p.net > 0;
  }

  // Sort by net descending
  return Object.entries(pnl)
    .map(([agent, data]) => ({ agent, ...data }))
    .sort((a, b) => b.net - a.net);
}

export function registerAgentPnl(app, deps) {
  const { supabase } = deps;

  app.get('/api/agents/pnl', async (_req, res) => {
    try {
      const sorted = await computeAgentPnl(supabase);

      const totalRevenue = sorted.reduce((s, a) => s + a.revenue, 0);
      const totalCosts = sorted.reduce((s, a) => s + a.costs, 0);
      const profitable = sorted.filter(a => a.isProfitable).length;

      res.json({
        ok: true,
        agents: sorted,
        summary: {
          agentCount: sorted.length,
          profitable,
          unprofitable: sorted.length - profitable,
          totalRevenue: +totalRevenue.toFixed(6),
          totalCosts: +totalCosts.toFixed(6),
          totalNet: +(totalRevenue - totalCosts).toFixed(6),
        },
        note: 'Every line item is verifiable on-chain. Bond slashes and returns settle via AgentBond; payments settle via x402/Gateway or direct SCA transfer — all on Arc.',
      });
    } catch (e) {
      console.error('[agent_pnl] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[agent_pnl] /api/agents/pnl registered');
}
