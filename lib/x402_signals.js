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

import { parseAbiItem } from 'viem';

const CACHE_TTL_MS = 30_000;
let _cache = { ts: 0, data: null };

const NETWORK = 'eip155:5042002';
const ASSET = '0x3600000000000000000000000000000000000000';
const TRANSFER_EVT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export function registerX402Signals(app, deps) {
  const { supabase, resolveAddress, resolveAddressSlow, publicClient: viemPublicClient, USDC: usdcAddr } = deps;
  const asset = usdcAddr || ASSET;

  // Lazy payTo resolution for creators missing from the boot-time mapping:
  // wallets-table lookup → Circle getWallet, memoized forever (addresses
  // are immutable per user).
  const _slowCache = new Map();
  async function payToFor(userId) {
    const uid = String(userId || '').toLowerCase();
    const fast = resolveAddress ? resolveAddress(uid) : null;
    if (fast) return fast;
    if (_slowCache.has(uid)) return _slowCache.get(uid);
    if (!resolveAddressSlow) return null;
    try {
      const addr = await resolveAddressSlow(uid);
      _slowCache.set(uid, addr || null);
      return addr;
    } catch {
      return null;
    }
  }

  // ── External-buyer claim flow ─────────────────────────────────────────────
  // 1) POST /api/x402/signals/:id/claim   { payer: "0x…" }
  //    → registers a pending purchase and returns payment instructions.
  // 2) GET  /api/x402/signals/:id/claim?payer=0x…
  //    → scans recent on-chain USDC transfers payer→creator; when a transfer
  //      ≥ price is found (and not already consumed by another claim), the
  //      claim confirms and the FULL thesis is returned.
  //
  // Ledger = existing `signal_unlocks` table (user_id = "ext_<payerAddr>").
  const SCAN_CHUNK = parseInt(process.env.X402_CLAIM_SCAN_BLOCKS || '5000', 10);
  const SCAN_MAX_BLOCKS = parseInt(process.env.X402_CLAIM_MAX_BLOCKS || '30000', 10);

  async function findPaymentTx(payer, creator, priceUsdc, excludeTxIds, minTimeMs = 0) {
    if (!viemPublicClient || !payer || !creator) return null;
    const head = await viemPublicClient.getBlockNumber();
    let fromBlock = head > BigInt(SCAN_MAX_BLOCKS) ? head - BigInt(SCAN_MAX_BLOCKS) : 0n;
    let cursor = head;
    const micro = BigInt(Math.round(priceUsdc * 1_000_000));
    const excl = new Set((excludeTxIds || []).map((x) => String(x).toLowerCase()));
    const tsCache = new Map(); // blockNumber -> timestamp(ms)

    const blockTs = async (bn) => {
      const key = bn.toString();
      if (!tsCache.has(key)) {
        const b = await viemPublicClient.getBlock({ blockNumber: bn });
        tsCache.set(key, Number(b.timestamp) * 1000);
      }
      return tsCache.get(key);
    };

    while (cursor >= fromBlock) {
      const lo = cursor - BigInt(SCAN_CHUNK) < fromBlock ? fromBlock : cursor - BigInt(SCAN_CHUNK);
      try {
        // Whole chunk predates the claim → every older chunk does too.
        const chunkOldestTs = await blockTs(lo).catch(() => 0);
        if (minTimeMs > 0 && chunkOldestTs && chunkOldestTs < minTimeMs) break;

        const logs = await viemPublicClient.getLogs({
          address: asset,
          event: TRANSFER_EVT,
          args: { from: payer, to: creator },
          fromBlock: lo, toBlock: cursor,
        });
        for (const log of logs) {
          const value = log.args?.value ?? 0n;
          const txId = String(log.transactionHash || '').toLowerCase();
          if (!txId || excl.has(txId)) continue;
          if (value < micro) continue;
          if (minTimeMs > 0) {
            const b = await viemPublicClient.getBlock({ blockHash: log.blockHash });
            if (Number(b.timestamp) * 1000 < minTimeMs) continue; // pre-claim transfer
          }
          return { txHash: txId, amountUsdc: Number(value) / 1_000_000 };
        }
      } catch (e) {
        console.warn('[x402/signals] claim scan chunk failed:', e.message);
        break;
      }
      if (lo === fromBlock) break;
      cursor = lo - 1n;
    }
    return null;
  }

  async function loadSignal(id) {
    const { data, error } = await supabase
      .from('creator_signals')
      .select('id, title, market_question, stance, confidence, edge_bps, horizon, teaser, thesis, price_usdc, creator_user_id, created_at')
      .eq('id', String(id || '').trim())
      .eq('status', 'published')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  function publicView(r, payTo, extra = {}) {
    return {
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
        ...extra,
      },
    };
  }

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

      const signals = await Promise.all((rows || []).map(async (r) => ({
        id: r.id,
        title: r.title,
        marketQuestion: r.market_question || null,
        stance: r.stance,
        confidence: r.confidence,
        preview: r.teaser || null, // public teaser — full thesis is the paid content
        priceUsdc: Number(r.price_usdc),
        creator: r.creator_user_id,
        payTo: await payToFor(r.creator_user_id),
        createdAt: r.created_at,
      })));
      for (const s of signals) s.payment = paymentBlock(s.payTo, s.id);

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
      const r = await loadSignal(req.params.id);
      if (!r) return res.status(404).json({ error: 'Signal not found' });
      const payTo = await payToFor(r.creator_user_id);
      res.json(publicView(r, payTo, { thesisIncludedAfterPayment: true }));
    } catch (e) {
      console.error('[x402/signals] detail error:', e.message);
      res.status(500).json({ error: 'Failed to load signal' });
    }
  });

  // Register a pending external purchase. Payer identifies by wallet address.
  app.post('/api/x402/signals/:id/claim', async (req, res) => {
    try {
      const payer = String(req.body?.payer || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(payer)) {
        return res.status(400).json({ error: 'payer must be a 0x address' });
      }
      const r = await loadSignal(req.params.id);
      if (!r) return res.status(404).json({ error: 'Signal not found' });
      const payTo = await payToFor(r.creator_user_id);
      if (!payTo) return res.status(409).json({ error: 'Creator payout address unavailable yet — retry' });

      const userId = `ext_${payer}`;
      const { data: existing } = await supabase
        .from('signal_unlocks')
        .select('*')
        .eq('user_id', userId).eq('signal_id', r.id)
        .maybeSingle();
      if (!existing) {
        await supabase.from('signal_unlocks').insert({
          user_id: userId, signal_id: r.id, status: 'pending',
          amount_usdc: Number(r.price_usdc), tx_id: null,
          created_at: new Date().toISOString(),
        });
      }
      const alreadyConfirmed = existing?.status === 'confirmed';
      res.json({
        ok: true,
        status: alreadyConfirmed ? 'confirmed' : 'pending',
        priceUsdc: Number(r.price_usdc),
        payment: paymentBlock(payTo, r.id),
        checkUrl: `/api/x402/signals/${r.id}/claim?payer=${payer}`,
        note: 'Send exactly the price in USDC from this payer address to payTo, then poll checkUrl. Thesis returns on confirmation.',
      });
    } catch (e) {
      console.error('[x402/signals] claim register error:', e.message);
      res.status(500).json({ error: 'Failed to register claim' });
    }
  });

  // Poll/confirm: scan recent chain transfers payer→creator; on hit confirm
  // the claim and hand over the full thesis.
  app.get('/api/x402/signals/:id/claim', async (req, res) => {
    try {
      const payer = String(req.query.payer || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(payer)) {
        return res.status(400).json({ error: 'payer query param must be a 0x address' });
      }
      const r = await loadSignal(req.params.id);
      if (!r) return res.status(404).json({ error: 'Signal not found' });
      const payTo = await payToFor(r.creator_user_id);
      const userId = `ext_${payer}`;

      const { data: row } = await supabase
        .from('signal_unlocks').select('*')
        .eq('user_id', userId).eq('signal_id', r.id).maybeSingle();

      if (row?.status === 'confirmed') {
        return res.json({ ok: true, status: 'confirmed', txHash: row.tx_id,
          signal: publicView(r, payTo, { thesis: r.thesis || null }).signal });
      }

      // Which txs are already consumed by OTHER confirmed claims for this signal?
      const { data: used } = await supabase
        .from('signal_unlocks').select('tx_id')
        .eq('signal_id', r.id).eq('status', 'confirmed');
      // Only transfers made AFTER the claim was registered count — otherwise
      // any old large transfer from the payer would falsely confirm (seen live:
      // a $0.001 claim matched a 90.97 USDC treasury transfer from hours prior).
      const minTimeMs = row?.created_at ? Date.parse(row.created_at) - 5_000 : 0;
      const hit = await findPaymentTx(payer, payTo, Number(r.price_usdc), (used || []).map((u) => u.tx_id), minTimeMs);

      if (!hit) {
        return res.json({ ok: true, status: row ? 'pending' : 'not_started',
          hint: row ? 'No qualifying transfer found yet — pay then retry.' :
            `POST /api/x402/signals/${r.id}/claim {"payer":"${payer}"} first.` });
      }

      // Confirm: upsert with the concrete tx + bump creator revenue counters.
      await supabase.from('signal_unlocks').upsert({
        user_id: userId, signal_id: r.id, status: 'confirmed',
        amount_usdc: hit.amountUsdc, tx_id: hit.txHash,
        confirmed_at: new Date().toISOString(),
      }, { onConflict: 'user_id,signal_id' });
      supabase.from('creator_signals').select('unlocks_count, revenue_usdc').eq('id', r.id).maybeSingle()
        .then(({ data }) => { if (data) supabase.from('creator_signals').update({
          unlocks_count: (data.unlocks_count ?? 0) + 1, revenue_usdc: Number(data.revenue_usdc ?? 0) + hit.amountUsdc,
        }).eq('id', r.id).then(() => {}).catch(() => {}); })
        .catch(() => {});

      console.log(`[x402/signals] external unlock confirmed: ${userId} bought ${r.id} (${hit.amountUsdc} USDC, tx ${hit.txHash})`);
      res.json({ ok: true, status: 'confirmed', txHash: hit.txHash,
        signal: publicView(r, payTo, { thesis: r.thesis || null }).signal });
    } catch (e) {
      console.error('[x402/signals] claim check error:', e.message);
      res.status(500).json({ error: 'Failed to check claim' });
    }
  });

  console.log('[x402/signals] discovery endpoints registered (/api/x402/signals)');
}

export default { registerX402Signals };
