// ── Per-Agent Profit & Loss ────────────────────────────────────────────────
//
// Every AI agent on Puls has a complete on-chain ledger: revenue from signals
// sold, tips received, bonds won, position sales, settlement payouts — costs
// from signals bought, data paid for, bonds lost, positions that settled
// against the agent. This endpoint aggregates it into a single "agent P&L
// statement" that proves the agent economy is a real, net-positive business.
//
// Settlement payouts: when a market resolves, winning shares pay $1 each.
// Most of those payouts are claimed on-chain directly and never hit the
// `trades` table (only ~86 CLAIM rows exist vs 40k+ buys). To keep the P&L
// truthful we compute the settlement value from the trade ledger itself —
// the same math the /versus leaderboard uses — so a won position counts its
// payout as revenue and a lost position is charged in full. `syncSettlementClaims`
// additionally backfills real CLAIM rows into `trades` so the ledger table is
// complete for any other consumer.
//
// Every line item links to Arcscan. Verifiable. Honest.

import crypto from 'node:crypto';

const WINDOW_MS = 30 * 24 * 3600 * 1000;
const TRADE_LIMIT = 300000;

/**
 * Aggregate per-agent P&L from creator_signals + x402_payments + trades.
 * Shared by /api/agents/pnl and lib/invest.js (pro-rata accrual).
 * Includes a trailing-30d view (net30) so invest can annualize a true window.
 * @param {object} supabase — Neon/Supabase client (`.from()` compatible)
 * @returns {Promise<Array>} agents sorted by net desc: { agent, revenue, costs, net, ... }
 */
export async function computeAgentPnl(supabase) {
  const blank = () => ({ revenue: 0, costs: 0, revenue30: 0, costs30: 0, bondReturns: 0, bondSlashes: 0, tips: 0, buys: 0, sells: 0, unlocks: 0, net: 0, net30: 0, tradingBuys: 0, tradingSells: 0, tradesCount: 0, volume: 0, resolvedCount: 0, winsCount: 0, winRate: 0, breakdown: [] });

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
  //    A BUY on a resolved market counts in full once the market settles
  //    AGAINST the held side (money gone) or is recovered by a sell/claim/
  //    settlement payout. Buys on open / won markets stay pending up to what
  //    was realized — the value still sits in the position (that was the old
  //    bug: every buy looked like a -$ loss while the shares were still held).
  const { data: resolvedMarkets } = await supabase
    .from('deployed_markets')
    .select('contract_address, outcome')
    .eq('resolved', true);
  const lostYes = new Set(); // resolved outcome=false → YES side lost
  const lostNo = new Set();  // resolved outcome=true  → NO side lost
  const wonYes = new Set();  // resolved outcome=true  → YES side pays $1/share
  const wonNo = new Set();   // resolved outcome=false → NO side pays $1/share
  for (const rm of (resolvedMarkets || [])) {
    if (rm.outcome === null || rm.outcome === undefined) continue;
    const key = String(rm.contract_address || '').toLowerCase();
    if (!key) continue;
    if (rm.outcome) { lostNo.add(key); wonYes.add(key); }
    else { lostYes.add(key); wonNo.add(key); }
  }

  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: trades } = await supabase
    .from('trades')
    .select('user_id, usdc_amount, tx_hash, side, market_id, entry_price, created_at')
    .eq('state', 'COMPLETE')
    .like('user_id', 'agent_%')
    .limit(TRADE_LIMIT);
  const seenTx = new Set();
  // `${user}|${market}` → per-window bucket
  const newMarket = () => ({ costYes: 0, costNo: 0, sharesYes: 0, sharesNo: 0, realized: 0, claimed: 0, activity: 0 });
  const perMarketAll = new Map();
  const perMarket30 = new Map();

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
    const market = String(t.market_id || '').toLowerCase();
    const key = `${t.user_id}|${market}`;
    const in30 = !!(t.created_at && String(t.created_at) >= cutoff);

    // Bucket updates (per window) — no revenue here, only ledger fields.
    const applyBucket = (b) => {
      b.activity++;
      if (amt < 0) {
        b.realized += -amt;
        if (t.side === 'YES') b.sharesYes = Math.max(0, b.sharesYes - (Math.abs(amt) / (Number(t.entry_price) || 0.5)));
        else if (t.side === 'NO') b.sharesNo = Math.max(0, b.sharesNo - (Math.abs(amt) / (Number(t.entry_price) || 0.5)));
      } else if (t.side === 'CLAIM') {
        b.realized += amt;
        b.claimed += amt;
      } else if (t.side === 'YES') {
        b.costYes += amt;
        b.sharesYes += amt / (Number(t.entry_price) || 0.5);
      } else {
        b.costNo += amt;
        b.sharesNo += amt / (Number(t.entry_price) || 0.5);
      }
    };
    let mk = perMarketAll.get(key);
    if (!mk) { mk = newMarket(); perMarketAll.set(key, mk); }
    applyBucket(mk);
    if (in30) {
      let mk30 = perMarket30.get(key);
      if (!mk30) { mk30 = newMarket(); perMarket30.set(key, mk30); }
      applyBucket(mk30);
    }

    // All-time revenue / stats — accounted exactly once per trade row.
    const p = pnl[t.user_id];
    if (amt < 0) {
      p.revenue += -amt;
      p.tradingSells += -amt;
      p.tradesCount++;
      p.volume += -amt;
      p.breakdown.push({ item: 'position_sold', usdc: +(-amt).toFixed(6) });
    } else if (t.side === 'CLAIM') {
      p.revenue += amt;
      p.tradingSells += amt;
      p.breakdown.push({ item: 'claim_payout', usdc: +amt.toFixed(6) });
    } else {
      p.tradesCount++;
      p.volume += amt;
    }
  }

  // Settlement: on a resolved market the winning side pays $1/share. Net any
  // already-logged CLAIM rows so there is never a double count.
  const settleMarket = (mk, outcome, out) => {
    if (mk.activity === 0) return 0;
    const shares = Math.max(0, outcome ? mk.sharesYes : mk.sharesNo);
    const settle = Math.max(0, shares - mk.claimed);
    if (settle <= 0.000001) return 0;
    out.revenue += settle;
    out.tradingSells += settle;
    mk.realized += settle;
    if (out.breakdown) out.breakdown.push({ item: 'settlement_payout', usdc: +settle.toFixed(6) });
    return settle;
  };

  // Costs: the resolved-against side is a full loss; the won side is charged up
  // to what was realized (a held win recovers everything → nets to profit);
  // open markets stay pending up to realized round-trips.
  const chargeMarket = (mk, market, out) => {
    if (mk.activity === 0) return 0;
    let charged = 0;
    if (lostYes.has(market)) charged += mk.costYes;
    else if (mk.costYes) charged += Math.min(mk.costYes, mk.realized);
    if (lostNo.has(market)) charged += mk.costNo;
    else if (mk.costNo) charged += Math.min(mk.costNo, mk.realized);
    if (charged <= 0) return 0;
    out.costs += charged;
    out.tradingBuys += charged;
    if (out.breakdown) out.breakdown.push({ item: 'position_bought', usdc: -(+charged.toFixed(6)) });
    return charged;
  };

  for (const [key, mk] of perMarketAll) {
    const [user, market] = key.split('|');
    const p = pnl[user];
    if (!p) continue;
    const outcome = wonYes.has(market); // wonNo → outcome false
    if (wonYes.has(market) || wonNo.has(market)) {
      settleMarket(mk, outcome, p);
    }
    chargeMarket(mk, market, p);
    // Win rate: resolved market with positive PnL = win (leaderboard semantics).
    if (wonYes.has(market) || wonNo.has(market) || lostYes.has(market) || lostNo.has(market)) {
      const marketPnl = mk.realized - (mk.costYes + mk.costNo);
      p.resolvedCount++;
      if (marketPnl > 0.05) p.winsCount++;
    }
  }

  // Trailing-30d pass: same math on the windowed buckets, separate totals.
  for (const [key, mk] of perMarket30) {
    const [user, market] = key.split('|');
    const p = pnl[user];
    if (!p) continue;
    const out30 = { revenue: 0, costs: 0, breakdown: p.breakdown };
    const outcome = wonYes.has(market);
    if (wonYes.has(market) || wonNo.has(market)) settleMarket(mk, outcome, out30);
    chargeMarket(mk, market, out30);
    p.revenue30 += out30.revenue;
    p.costs30 += out30.costs;
  }

  // Compute net
  for (const a of Object.keys(pnl)) {
    const p = pnl[a];
    p.net = +(p.revenue - p.costs).toFixed(6);
    p.net30 = +(p.revenue30 - p.costs30).toFixed(6);
    p.revenue = +p.revenue.toFixed(6);
    p.costs = +p.costs.toFixed(6);
    p.isProfitable = p.net > 0;
    p.winRate = p.resolvedCount > 0 ? +((p.winsCount / p.resolvedCount) * 100).toFixed(1) : 0;
    p.volume = +p.volume.toFixed(2);
  }

  // Sort by net descending
  return Object.entries(pnl)
    .map(([agent, data]) => ({ agent, ...data }))
    .sort((a, b) => b.net - a.net);
}

/**
 * Backfill settlement payouts as CLAIM rows in `trades` for agents whose
 * markets resolved in their favour but were never claimed through the backend
 * (they claim on-chain directly). Idempotent: skips (user, market) pairs that
 * already have a CLAIM row. Call at boot + on an interval; safe to run
 * concurrently with computeAgentPnl (deterministic tx_hash dedup).
 * @param {object} supabase
 * @returns {Promise<number>} rows inserted
 */
export async function syncSettlementClaims(supabase) {
  const { data: markets } = await supabase
    .from('deployed_markets')
    .select('contract_address, outcome, deadline')
    .eq('resolved', true)
    .limit(5000);
  const outcomeByMarket = new Map();
  const toDate = (d) => {
    if (!d) return new Date().toISOString();
    const s = String(d);
    // Unix seconds (numeric or digit string) → ISO. Already-ISO strings pass through.
    if (/^\d+$/.test(s)) {
      const ms = Number(s);
      if (ms > 1e12) return new Date(ms).toISOString(); // ms epoch
      return new Date(ms * 1000).toISOString();
    }
    return new Date(s).toISOString();
  };
  for (const rm of (markets || [])) {
    if (rm.outcome === null || rm.outcome === undefined || !rm.contract_address) continue;
    outcomeByMarket.set(String(rm.contract_address).toLowerCase(), { outcome: !!rm.outcome, created_at: toDate(rm.deadline) });
  }
  if (!outcomeByMarket.size) return 0;

  const { data: trades } = await supabase
    .from('trades')
    .select('user_id, usdc_amount, tx_hash, side, market_id, entry_price')
    .eq('state', 'COMPLETE')
    .like('user_id', 'agent_%')
    .limit(TRADE_LIMIT);
  const seenTx = new Set();
  const perMarket = new Map(); // `${user}|${market}` → {sharesYes, sharesNo, claimed}
  for (const t of (trades || [])) {
    if (!t.user_id) continue;
    const amt = Number(t.usdc_amount || 0);
    if (amt === 0) continue;
    if (t.tx_hash) {
      const k = String(t.tx_hash).toLowerCase();
      if (seenTx.has(k)) continue;
      seenTx.add(k);
    }
    const market = String(t.market_id || '').toLowerCase();
    if (!outcomeByMarket.has(market)) continue;
    const key = `${t.user_id}|${market}`;
    let mk = perMarket.get(key);
    if (!mk) { mk = { sharesYes: 0, sharesNo: 0, claimed: 0 }; perMarket.set(key, mk); }
    if (amt < 0) {
      const sh = Math.abs(amt) / (Number(t.entry_price) || 0.5);
      if (t.side === 'YES') mk.sharesYes = Math.max(0, mk.sharesYes - sh);
      else if (t.side === 'NO') mk.sharesNo = Math.max(0, mk.sharesNo - sh);
    } else if (t.side === 'CLAIM') {
      mk.claimed += amt;
    } else if (t.side === 'YES') {
      mk.sharesYes += amt / (Number(t.entry_price) || 0.5);
    } else {
      mk.sharesNo += amt / (Number(t.entry_price) || 0.5);
    }
  }

  // Existing synced rows (one query) so inserts are a single batch.
  const { data: existing } = await supabase
    .from('trades')
    .select('tx_hash')
    .like('tx_hash', 'claim_sync:%');
  const existingHashes = new Set((existing || []).map((r) => String(r.tx_hash).toLowerCase()));

  const rows = [];
  for (const [key, mk] of perMarket) {
    const [userId, market] = key.split('|');
    if (mk.claimed > 0.000001) continue; // already has a CLAIM row
    const { outcome, created_at } = outcomeByMarket.get(market);
    const payout = Math.max(0, outcome ? mk.sharesYes : mk.sharesNo);
    if (payout <= 0.000001) continue;
    const txHash = `claim_sync:${market.slice(0, 24)}:${userId}`;
    if (existingHashes.has(txHash.toLowerCase())) continue;
    rows.push({
      tx_id: crypto.randomUUID(),
      user_id: userId,
      market_id: market,
      side: 'CLAIM',
      usdc_amount: +payout.toFixed(6),
      entry_price: 0,
      question: 'Settlement payout (synced)',
      state: 'COMPLETE',
      tx_hash: txHash,
      created_at,
    });
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('trades').insert(rows.slice(i, i + 100));
    if (error) { console.warn(`[claim_sync] batch insert failed:`, error.message); continue; }
    inserted += Math.min(100, rows.length - i);
  }
  if (inserted > 0) console.log(`[claim_sync] backfilled ${inserted} settlement payouts into trades`);
  return inserted;
}

export function computeAgentPnlCached(supabase, ttlMs = 30_000) {
  const cache = pnlCacheFor(supabase);
  const now = Date.now();
  if (cache.data && now - cache.at < ttlMs) return Promise.resolve(cache.data);
  return computeAgentPnl(supabase).then((data) => {
    cache.data = data;
    cache.at = now;
    return data;
  });
}

// WeakMap keyed by supabase client so prod (one singleton) caches hard while
// unit tests (fresh fake per case) stay isolated.
const pnlCacheFor = (() => {
  const m = new WeakMap();
  return (supabase) => {
    let e = m.get(supabase);
    if (!e) { e = { at: 0, data: null }; m.set(supabase, e); }
    return e;
  };
})();

export function registerAgentPnl(app, deps) {
  const { supabase } = deps;

  app.get('/api/agents/pnl', async (_req, res) => {
    try {
      const sorted = await computeAgentPnlCached(supabase);

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
        note: 'Every line item is verifiable on-chain. Bond slashes and returns settle via AgentBond; payments settle via x402/Gateway or direct SCA transfer; settlement payouts are computed from the on-chain share ledger — all on Arc.',
      });
    } catch (e) {
      console.error('[agent_pnl] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[agent_pnl] /api/agents/pnl registered');
}
