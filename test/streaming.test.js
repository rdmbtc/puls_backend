// Puls Streams — unit/e2e test of the streaming-payment core logic.
// Uses an in-memory fake Supabase + Circle so it runs with zero external deps:
//   node --test test/streaming.test.js
//
// Verifies: continuous-authorization accrual, CAP clamping, proof-of-flow
// auto-pause, Gateway-style batched on-chain settlement, and live revenue split.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Module reads gating/tunables from env at import time → set before importing.
process.env.STREAMS_ENABLED = 'true';
process.env.STREAMS_PAID_ENABLED = 'true';      // exercise real (mocked) settlement
process.env.STREAM_SETTLE_THRESHOLD_USDC = '0.001';
process.env.STREAM_STALE_SEC = '1';             // fast proof-of-flow test
process.env.STREAM_MAX_TICK_GAP_SEC = '100000'; // credit our simulated elapsed fully
process.env.STREAM_MAX_RATE_USDC = '1';
process.env.STREAM_MAX_CAP_USDC = '100';

const { registerStreaming } = await import('../lib/streaming.js');

// ── In-memory fake Supabase (supports the exact chains streaming.js uses) ──
function makeSupabase() {
  const tables = { payment_streams: [], x402_payments: [] };
  let idc = 1;
  class B {
    constructor(t) { this.t = t; this.op = null; this.row = null; this.flt = []; this.orexpr = null; this.one = false; }
    insert(r) { this.op = 'insert'; this.row = r; return this; }
    update(r) { this.op = 'update'; this.row = r; return this; }
    select() { if (!this.op) this.op = 'select'; return this; }
    eq(c, v) { this.flt.push(['eq', c, v]); return this; }
    in(c, vs) { this.flt.push(['in', c, vs]); return this; }
    or(e) { this.orexpr = e; return this; }
    not() { return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.one = 'maybe'; return this._run(); }
    single() { this.one = 'single'; return this._run(); }
    then(res, rej) { return this._run().then(res, rej); }
    _match(rows) {
      let out = rows;
      for (const f of this.flt) {
        if (f[0] === 'eq') out = out.filter((r) => String(r[f[1]]) === String(f[2]));
        if (f[0] === 'in') out = out.filter((r) => f[2].includes(r[f[1]]));
      }
      if (this.orexpr) {
        const ors = this.orexpr.split(',').map((s) => { const p = s.split('.'); return [p[0], p[2]]; });
        out = rows.filter((r) => ors.some(([c, v]) => String(r[c]) === String(v)));
      }
      return out;
    }
    async _run() {
      const store = tables[this.t] || (tables[this.t] = []);
      if (this.op === 'insert') {
        const row = { id: this.row.id || ('stream-' + (idc++)), ...this.row };
        store.push(row);
        return this.one ? { data: row, error: null } : { data: [row], error: null };
      }
      if (this.op === 'update') {
        const m = this._match(store);
        m.forEach((r) => Object.assign(r, this.row));
        return { data: m, error: null };
      }
      const m = this._match(store);
      if (this.one === 'maybe') return { data: m[0] || null, error: null };
      if (this.one === 'single') return { data: m[0] || null, error: m.length ? null : { message: 'no rows' } };
      return { data: m, error: null };
    }
  }
  return { from: (t) => new B(t), __tables: tables };
}

// ── Fake Circle (records every USDC transfer) ──
function makeCircle() {
  const transfers = [];
  let n = 1;
  return {
    transfers,
    createContractExecutionTransaction: async ({ walletId, contractAddress, abiParameters }) => {
      transfers.push({ walletId, contractAddress, to: abiParameters[0], amountMicro: Number(abiParameters[1]) });
      return { data: { id: '0xtx' + (n++) } };
    },
  };
}

function harness() {
  const supabase = makeSupabase();
  const circle = makeCircle();
  const noop = () => {};
  const app = { get: noop, post: noop };
  const api = registerStreaming(app, {
    supabase,
    circle,
    USDC: '0x3600000000000000000000000000000000000000',
    getWalletId: async (uid) => 'wallet_' + uid,
    getWalletInfo: async (wid) => ({ walletId: wid, address: '0x' + Buffer.from(wid).toString('hex').slice(0, 40).padEnd(40, '0'), usdcBalance: '100.00' }),
    apiKeyOrAuth: noop, authenticateUser: noop, requireVerifiedUser: noop, strictLimiter: noop,
    awardPoints: async () => {},
  });
  return { supabase, circle, api };
}

const RECIP = '0x' + 'a'.repeat(40);
const RECIP_B = '0x' + 'b'.repeat(40);
const backdate = (supabase, id, secAgo) => {
  const row = supabase.__tables.payment_streams.find((r) => r.id === id);
  row.last_tick_at = new Date(Date.now() - secAgo * 1000).toISOString();
  return row;
};

test('open authorizes a rate+cap and starts active at zero', async () => {
  const { api } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, resource: 'gpu', ratePerSecUsdc: 0.01, capUsdc: 1 });
  assert.equal(s.status, 'active');
  assert.equal(Number(s.accrued_micro), 0);
  assert.equal(Number(s.rate_per_sec_usdc), 0.01);
});

test('tick accrues by elapsed*rate (proof-of-flow meter)', async () => {
  const { api, supabase } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, resource: 'feed', ratePerSecUsdc: 0.01, capUsdc: 1 });
  backdate(supabase, s.id, 10); // pretend 10s of flow elapsed
  const out = await api.tick(s.id);
  // 10s * $0.01/s = $0.10 (real elapsed is >= simulated, so allow a little drift up)
  assert.ok(out.accruedUsdc >= 0.10 - 1e-9 && out.accruedUsdc <= 0.10 + 0.02, `accrued ${out.accruedUsdc}`);
});

test('accrual is clamped at the authorized CAP', async () => {
  const { api, supabase } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, ratePerSecUsdc: 0.01, capUsdc: 0.05 });
  backdate(supabase, s.id, 100); // would be $1.00, but cap is $0.05
  const out = await api.tick(s.id);
  assert.ok(Math.abs(out.accruedUsdc - 0.05) < 1e-6, `accrued ${out.accruedUsdc}`);
  assert.equal(out.capReached, true);
});

test('batched settle moves real USDC and advances settled', async () => {
  const { api, supabase, circle } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, ratePerSecUsdc: 0.01, capUsdc: 1 });
  backdate(supabase, s.id, 10);
  await api.tick(s.id);             // accrue ~$0.10
  const r = await api.settle(s.id, { force: true });
  assert.ok(r.settled >= 0.10 - 1e-9 && r.settled <= 0.10 + 0.02, `settled ${r.settled}`);
  assert.equal(circle.transfers.length, 1);
  assert.equal(circle.transfers[0].to, RECIP);
  assert.ok(circle.transfers[0].amountMicro >= 100000, `micro ${circle.transfers[0].amountMicro}`);
  const got = await api.get(s.id);
  assert.ok(got.pendingUsdc < 1e-9, `pending ${got.pendingUsdc}`); // fully settled
  assert.ok(Math.abs(got.settledUsdc - r.settled) < 1e-9);
});

test('live split distributes a settlement across recipients by bps', async () => {
  const { api, supabase, circle } = harness();
  const s = await api.openStream({
    payerUserId: 'alice', recipientAddress: RECIP, ratePerSecUsdc: 0.01, capUsdc: 1,
    split: [{ address: RECIP, bps: 5000 }, { address: RECIP_B, bps: 5000 }],
  });
  backdate(supabase, s.id, 10);
  await api.tick(s.id);             // accrue ~$0.10
  await api.settle(s.id, { force: true });
  assert.equal(circle.transfers.length, 2);
  const byTo = Object.fromEntries(circle.transfers.map((t) => [t.to, t.amountMicro]));
  // Equal 50/50 split (within 1 micro of rounding), summing to the accrued total.
  assert.ok(Math.abs(byTo[RECIP] - byTo[RECIP_B]) <= 1, `split ${byTo[RECIP]} vs ${byTo[RECIP_B]}`);
  const got = await api.get(s.id);
  assert.equal(byTo[RECIP] + byTo[RECIP_B], Math.round(got.settledUsdc * 1e6));
});

test('proof-of-flow: reconcile auto-pauses a stale (no-heartbeat) stream', async () => {
  const { api, supabase } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, ratePerSecUsdc: 0.01, capUsdc: 1 });
  backdate(supabase, s.id, 20);     // 20s idle >> STALE_SEC (module clamps min to 5s)
  await api.reconcile();
  const got = await api.get(s.id);
  assert.equal(got.status, 'paused');
});

test('stop performs a final settle and closes the stream', async () => {
  const { api, supabase, circle } = harness();
  const s = await api.openStream({ payerUserId: 'alice', recipientAddress: RECIP, ratePerSecUsdc: 0.02, capUsdc: 1 });
  backdate(supabase, s.id, 5);
  await api.tick(s.id);             // accrue $0.10 (5s * $0.02)
  const got = await api.stop(s.id);
  assert.equal(got.status, 'stopped');
  assert.ok(circle.transfers.length >= 1);
  assert.ok(got.settledUsdc >= 0.10 - 1e-9 && got.settledUsdc <= 0.10 + 0.02, `settled ${got.settledUsdc}`);
});
