// Puls Agent P&L — unit tests for the per-agent profit & loss aggregation.
// Verifies the money-moving math that's published publicly on /api/agents/pnl.
//
// Uses an in-memory fake Supabase (same pattern as streaming.test.js) so it
// runs with zero external deps: node --test test/agent_pnl.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerAgentPnl } = await import('../lib/agent_pnl.js');

// ── In-memory fake Supabase ────────────────────────────────────────────────
function makeSupabase({ signals = [], bonds = [], payments = [], trades = [] } = {}) {
  const tables = { creator_signals: signals, x402_payments: payments, trades };
  // Pre-seed bonds into creator_signals (same table, different select columns).
  for (const b of bonds) {
    const existing = tables.creator_signals.find((s) => s.id === b.id);
    if (existing) Object.assign(existing, b);
    else tables.creator_signals.push(b);
  }
  class B {
    constructor(t) { this.t = t; this.op = null; this.row = null; this.flt = []; this.one = false; }
    insert(r) { this.op = 'insert'; this.row = r; return this; }
    update(r) { this.op = 'update'; this.row = r; return this; }
    select() { if (!this.op) this.op = 'select'; return this; }
    eq(c, v) { this.flt.push(['eq', c, v]); return this; }
    like(c, v) { this.flt.push(['like', c, v]); return this; }
    not() { return this; }
    is(c, v) { this.flt.push(['is', c, v]); return this; }
    in(c, vs) { this.flt.push(['in', c, vs]); return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.one = 'single'; return this._run(); }
    maybeSingle() { this.one = 'maybe'; return this._run(); }
    then(res, rej) { return this._run().then(res, rej); }
    _match(rows) {
      let out = rows;
      for (const f of this.flt) {
        if (f[0] === 'eq') out = out.filter((r) => String(r[f[1]]) === String(f[2]));
        if (f[0] === 'like') {
          const pat = f[2].replace(/%/g, '.*');
          out = out.filter((r) => new RegExp(pat).test(String(r[f[1]] || '')));
        }
        if (f[0] === 'is') {
          // null check — `is, null` matches rows where the column is null.
          out = out.filter((r) =>
            f[2] === null ? r[f[1]] == null : r[f[1]] != null
          );
        }
      }
      return out;
    }
    async _run() {
      const store = tables[this.t] || [];
      const m = this._match(store);
      return { data: m, error: null };
    }
  }
  return { from: (t) => new B(t), __tables: tables };
}

function harness({ signals, bonds, payments, trades }) {
  const supabase = makeSupabase({ signals, bonds, payments, trades });
  const noop = () => {};
  const app = { get: noop };
  registerAgentPnl(app, { supabase, circle: {} });
  // The handler is registered as app.get('/api/agents/pnl', ...). Capture it.
  return supabase;
}

// Capture the response from the handler by intercepting res.json.
async function callEndpoint(supabase) {
  const { registerAgentPnl } = await import('../lib/agent_pnl.js');
  let captured = null;
  let status = 200;
  const res = {
    json: (data) => { captured = data; },
    status: (s) => { status = s; return res; },
  };
  const app = {
    get: (_path, handler) => {
      // Immediately invoke the handler with a mock req + res.
      handler({}, res);
    },
  };
  registerAgentPnl(app, { supabase, circle: {} });
  // Wait for the async handler to complete.
  await new Promise((r) => setTimeout(r, 50));
  return { captured, status };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('P&L: agent with signal revenue only', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_vega', revenue_usdc: 5.0, unlocks_count: 3 },
      { id: 's2', creator_user_id: 'agent_vega', revenue_usdc: 2.5, unlocks_count: 1 },
    ],
    bonds: [],
    payments: [],
  });
  const { captured, status } = await callEndpoint(supa);
  assert.equal(status, 200);
  const vega = captured.agents.find((a) => a.agent === 'agent_vega');
  assert.ok(vega, 'vega should be in the report');
  assert.equal(vega.revenue, 7.5);
  assert.equal(vega.unlocks, 4);
  assert.equal(vega.net, 7.5);
  assert.equal(vega.isProfitable, true);
  assert.equal(captured.summary.agentCount, 1);
  assert.equal(captured.summary.profitable, 1);
  assert.equal(captured.summary.totalRevenue, 7.5);
});

test('P&L: bond slash reduces net, bond return increases it', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_sage', revenue_usdc: 1.0, unlocks_count: 1 },
    ],
    bonds: [
      { id: 's1', creator_user_id: 'agent_sage', bond_status: 'slashed', bond_amount_usdc: 0.5, bond_correct: false },
      { id: 's2', creator_user_id: 'agent_sage', bond_status: 'returned', bond_amount_usdc: 0.3, bond_correct: true },
    ],
    payments: [],
  });
  const { captured } = await callEndpoint(supa);
  const sage = captured.agents[0];
  // Revenue: 1.0 (signal) + 0.3 (bond returned) = 1.3
  assert.equal(sage.revenue, 1.3);
  // Costs: 0.5 (slashed)
  assert.equal(sage.costs, 0.5);
  assert.equal(sage.bondSlashes, 0.5);
  assert.equal(sage.bondReturns, 0.3);
  assert.equal(sage.net, +(1.3 - 0.5).toFixed(6));
  assert.equal(sage.isProfitable, true);
});

test('P&L: agent-to-agent payment is revenue for payee, cost for payer', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_sage', revenue_usdc: 0, unlocks_count: 0 },
      { id: 'x1', creator_user_id: 'agent_vega', revenue_usdc: 0, unlocks_count: 0 },
    ],
    bonds: [],
    payments: [
      // Vega pays Sage 0.05 USDC for a signal (agent_to_agent)
      { payer: 'agent_vega', pay_to: 'agent_sage', amount_usdc: 0.05, endpoint: 'agent_to_agent' },
    ],
  });
  const { captured } = await callEndpoint(supa);
  const sage = captured.agents.find((a) => a.agent === 'agent_sage');
  const vega = captured.agents.find((a) => a.agent === 'agent_vega');
  assert.equal(sage.revenue, 0.05);
  assert.equal(sage.sells, 0.05);
  assert.equal(vega.costs, 0.05);
  assert.equal(vega.buys, 0.05);
  assert.equal(vega.net, -0.05);
  assert.equal(vega.isProfitable, false);
});

test('P&L: tip is classified as tip, not signal sale', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_sage', revenue_usdc: 0, unlocks_count: 0 },
    ],
    bonds: [],
    payments: [
      { payer: 'human_user', pay_to: 'agent_sage', amount_usdc: 1.0, endpoint: 'tip' },
    ],
  });
  const { captured } = await callEndpoint(supa);
  const sage = captured.agents[0];
  assert.equal(sage.tips, 1.0);
  assert.equal(sage.sells, 0); // tips are NOT signal sales
  assert.equal(sage.revenue, 1.0);
});

test('P&L: summary totals are correct across multiple agents', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_a', revenue_usdc: 10, unlocks_count: 5 },
      { id: 's2', creator_user_id: 'agent_b', revenue_usdc: 3, unlocks_count: 2 },
    ],
    bonds: [],
    payments: [],
  });
  const { captured } = await callEndpoint(supa);
  assert.equal(captured.summary.agentCount, 2);
  assert.equal(captured.summary.totalRevenue, 13);
  assert.equal(captured.summary.totalCosts, 0);
  assert.equal(captured.summary.totalNet, 13);
  assert.equal(captured.summary.profitable, 2);
  assert.equal(captured.summary.unprofitable, 0);
});

test('P&L: agents are sorted by net descending', async () => {
  const supa = harness({
    signals: [
      { id: 's1', creator_user_id: 'agent_loser', revenue_usdc: 0.5, unlocks_count: 1 },
      { id: 's2', creator_user_id: 'agent_winner', revenue_usdc: 5.0, unlocks_count: 3 },
    ],
    bonds: [
      { id: 's1', creator_user_id: 'agent_loser', bond_status: 'slashed', bond_amount_usdc: 2.0, bond_correct: false },
    ],
    payments: [],
  });
  const { captured } = await callEndpoint(supa);
  assert.equal(captured.agents[0].agent, 'agent_winner');
  assert.equal(captured.agents[1].agent, 'agent_loser');
  assert.ok(captured.agents[0].net > captured.agents[1].net);
});

test('P&L: trading ledger counts buys as costs, sells/claims as revenue, dedupes tx_hash', async () => {
  const supa = harness({
    signals: [],
    bonds: [],
    payments: [],
    trades: [
      { user_id: 'agent_trader', usdc_amount: 2.0, tx_hash: '0xaaaa', state: 'COMPLETE', side: 'YES' },
      { user_id: 'agent_trader', usdc_amount: 2.0, tx_hash: '0xaaaa', state: 'COMPLETE', side: 'YES' },
      { user_id: 'agent_trader', usdc_amount: -1.5, tx_hash: '0xbbbb', state: 'COMPLETE', side: 'YES' },
      { user_id: 'agent_trader', usdc_amount: 3.0, tx_hash: '0xcccc', state: 'COMPLETE', side: 'CLAIM' },
      { user_id: 'agent_trader', usdc_amount: 0.5, tx_hash: '0xdddd', state: 'COMPLETE', side: 'YES' },
      { user_id: 'agent_trader', usdc_amount: 0.5, tx_hash: '0xdddd', state: 'COMPLETE', side: 'YES' },
      { user_id: 'human1', usdc_amount: -9.0, tx_hash: '0xeeee', state: 'COMPLETE', side: 'NO' },
    ],
  });
  const { captured } = await callEndpoint(supa);
  const trader = captured.agents.find((a) => a.agent === 'agent_trader');
  assert.ok(trader, 'agent_trader should be in the report');
  // Bought 2.0 (deduped) + 0.5 (deduped) = 2.5 cost; sold 1.5 + claimed 3.0 = 4.5 revenue
  assert.equal(trader.tradingBuys, 2.5);
  assert.equal(trader.tradingSells, 4.5);
  assert.equal(trader.costs, 2.5);
  assert.equal(trader.revenue, 4.5);
  assert.equal(trader.net, 2.0);
  assert.equal(trader.isProfitable, true);
  assert.equal(captured.agents.length, 1);
});

