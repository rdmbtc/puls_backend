/**
 * Puls Streams — pay-per-second USDC streaming on Arc (streaming &
 * continuous payments).
 *
 * Streaming payments are a real code gap in the x402 world: x402 settles a
 * *discrete* request, but some value is continuous — a live alpha feed, a data
 * faucet, GPU time, audio per second. Puls Streams turns "value per second"
 * into a first-class primitive on Arc, settled in real USDC.
 *
 * The model:
 *   • Continuous authorization — the payer approves a RATE ($/sec) and a CAP,
 *     not each transaction. One decision authorizes thousands of sub-cent ticks.
 *   • Proof-of-flow — the consumer must keep "ticking" (heartbeat) to advance
 *     the meter. No tick → no charge for time not consumed. If delivery drops
 *     (no heartbeat for STREAM_STALE_SEC), the meter AUTO-PAUSES the instant
 *     flow stops. "You pay for exactly the time you were present."
 *   • Gateway-style batching — every second is sub-cent and uneconomical to
 *     settle alone, so accrual is metered continuously and SETTLED IN BATCHES
 *     (every STREAM_SETTLE_THRESHOLD_USDC) as real on-chain USDC transfers.
 *   • Live split — per-second accrual splits live across contributors (bps),
 *     so a multi-author stream pays every collaborator as it flows.
 *   • Tap to stop — start / pause / resume / stop, settling exactly what flowed.
 *
 * Agent-native: openStream/tick/pause/stop are exported so an agent can open a
 * stream, DECIDE the rate by expected value, keep it flowing while the resource
 * is worth it, and tap stop the moment it isn't — autonomous, per-second spend.
 *
 * Wiring (server.js):
 *   import { registerStreaming } from './lib/streaming.js';
 *   const streams = registerStreaming(app, { supabase, circle, USDC,
 *     getWalletId, getWalletInfo, apiKeyOrAuth, authenticateUser,
 *     requireVerifiedUser, strictLimiter, awardPoints });
 *
 * Migration: migrations/2026-06-28-payment-streams.sql
 */

const STREAMS_ENABLED =
  String(process.env.STREAMS_ENABLED ?? 'true').toLowerCase() !== 'false';
// Live on-chain settlement gate (mirrors SIGNALS_PAID_ENABLED / TIPS_ENABLED).
// OFF → the meter still accrues (fully demoable) but no USDC moves until a human
// flips this on for a live run.
const STREAMS_PAID_ENABLED =
  String(process.env.STREAMS_PAID_ENABLED || '').toLowerCase() === 'true';

const ARC_NETWORK = 'eip155:5042002';
// Settle on-chain once this much USDC has accrued unsettled (batching: many
// sub-cent seconds → one transfer). Sub-cent default so settlements are frequent
// enough to be visible, but each batches ~hundreds of per-second ticks.
const SETTLE_THRESHOLD_USDC = Math.max(0.0001, Number(process.env.STREAM_SETTLE_THRESHOLD_USDC || '0.01') || 0.01);
const SETTLE_THRESHOLD_MICRO = Math.round(SETTLE_THRESHOLD_USDC * 1_000_000);
// Proof-of-flow: no heartbeat for this long → auto-pause the meter.
const STALE_SEC = Math.max(5, parseInt(process.env.STREAM_STALE_SEC || '45', 10));
// Max seconds credited by a single heartbeat (guards against a long gap or a
// clock jump over-billing; also bounds catch-up after a pause).
const MAX_TICK_GAP_SEC = Math.max(1, parseInt(process.env.STREAM_MAX_TICK_GAP_SEC || '30', 10));
const RECONCILE_SEC = Math.max(5, parseInt(process.env.STREAM_RECONCILE_SEC || '20', 10));
// Sanity bounds so a bad client can't authorize an absurd rate/cap.
const MAX_RATE_PER_SEC_USDC = Math.max(0.000001, Number(process.env.STREAM_MAX_RATE_USDC || '1') || 1);
const MAX_CAP_USDC = Math.max(0.01, Number(process.env.STREAM_MAX_CAP_USDC || '100') || 100);

const isAddress = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s.trim());
const microToUsdc = (m) => Number(m || 0) / 1_000_000;
const nowIso = () => new Date().toISOString();

export function registerStreaming(app, deps) {
  const {
    supabase, circle, USDC,
    getWalletId, getWalletInfo,
    apiKeyOrAuth, authenticateUser, requireVerifiedUser, strictLimiter,
    awardPoints,
  } = deps;
  const award = typeof awardPoints === 'function' ? awardPoints : async () => {};
  // Agents authenticate with a pk_live_ API key; humans with a JWT. Accept both.
  const auth = typeof apiKeyOrAuth === 'function' ? apiKeyOrAuth : authenticateUser;

  // House/swarm agents store wallets under agent_<id> (double-prefixed for the
  // swarm) — mirror creator_signals' resolution so an agent can be payer/payee.
  async function walletIdFor(userId) {
    let wid = await getWalletId(userId);
    if (!wid && /agent/i.test(userId)) wid = await getWalletId(`agent_${userId}`);
    return wid;
  }
  async function addressFor(userId) {
    const wid = await walletIdFor(userId);
    if (!wid) return null;
    try { const info = await getWalletInfo(wid); return isAddress(info.address) ? info.address : null; }
    catch { return null; }
  }

  // Resolve the split into concrete [{address, bps}] summing to 10000. Defaults
  // to the single recipient at 100%.
  async function normalizeSplit(recipientAddress, split) {
    if (!Array.isArray(split) || !split.length) return [{ address: recipientAddress, bps: 10000 }];
    const parts = [];
    for (const p of split) {
      let addr = isAddress(p.address) ? p.address.trim() : (p.toUserId ? await addressFor(p.toUserId) : null);
      const bps = Math.max(0, Math.min(10000, Math.round(Number(p.bps) || 0)));
      if (addr && bps > 0) parts.push({ address: addr, bps });
    }
    if (!parts.length) return [{ address: recipientAddress, bps: 10000 }];
    // Re-normalise bps to sum to 10000 (give rounding remainder to the first).
    const total = parts.reduce((a, p) => a + p.bps, 0) || 1;
    let acc = 0;
    parts.forEach((p, i) => {
      p.bps = i === parts.length - 1 ? 10000 - acc : Math.round((p.bps / total) * 10000);
      acc += p.bps;
    });
    return parts;
  }

  // ── Programmatic API (used by routes AND by the agent loop directly) ────────

  async function openStream({ payerUserId, recipientUserId, recipientAddress, resource, ratePerSecUsdc, capUsdc, split, openedBy = 'user', meta = {} }) {
    if (!STREAMS_ENABLED) throw new Error('Streams are disabled');
    if (!payerUserId) throw new Error('payerUserId required');
    const rate = Number(ratePerSecUsdc);
    const cap = Number(capUsdc);
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE_PER_SEC_USDC) throw new Error(`ratePerSecUsdc must be in (0, ${MAX_RATE_PER_SEC_USDC}]`);
    if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_CAP_USDC) throw new Error(`capUsdc must be in (0, ${MAX_CAP_USDC}]`);

    let payTo = isAddress(recipientAddress) ? recipientAddress.trim() : null;
    if (!payTo && recipientUserId) payTo = await addressFor(recipientUserId);
    if (!payTo) throw new Error('Recipient payout address unavailable');

    const payerAddress = await addressFor(payerUserId);
    if (payerAddress && payTo.toLowerCase() === payerAddress.toLowerCase() && (!Array.isArray(split) || !split.length)) {
      throw new Error("Payer and recipient are the same wallet");
    }
    const splitParts = await normalizeSplit(payTo, split);

    const row = {
      payer_user_id: payerUserId,
      payer_address: payerAddress,
      recipient_user_id: recipientUserId || null,
      recipient_address: payTo,
      resource: resource ? String(resource).slice(0, 200) : null,
      rate_per_sec_usdc: rate,
      cap_usdc: cap,
      status: 'active',
      accrued_micro: 0,
      settled_micro: 0,
      split: splitParts,
      opened_by: openedBy === 'agent' ? 'agent' : 'user',
      meta,
      last_tick_at: nowIso(),
      started_at: nowIso(),
      updated_at: nowIso(),
    };
    const { data, error } = await supabase.from('payment_streams').insert(row).select('*').single();
    if (error) throw error;
    console.log(`[streams] open ${data.id} — ${rate}/s cap ${cap} ${payerUserId} → ${payTo}${splitParts.length > 1 ? ` (split ${splitParts.length})` : ''}`);
    return data;
  }

  // Heartbeat / proof-of-flow: advance the meter by the time actually consumed
  // since the last tick (clamped), capped at the authorized CAP.
  async function tickStream(id, { byUserId } = {}) {
    const { data: s, error } = await supabase.from('payment_streams').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!s) throw new Error('Stream not found');
    if (byUserId && s.payer_user_id !== byUserId && s.recipient_user_id !== byUserId) throw new Error('Not your stream');
    if (s.status === 'stopped') return publicStream(s);
    if (s.status === 'paused') { // resume on tick (flow returned)
      await supabase.from('payment_streams').update({ status: 'active', last_tick_at: nowIso(), updated_at: nowIso() }).eq('id', id);
      s.status = 'active'; s.last_tick_at = nowIso();
    }
    const capMicro = Math.round(Number(s.cap_usdc) * 1_000_000);
    const rateMicro = Math.round(Number(s.rate_per_sec_usdc) * 1_000_000);
    let elapsed = Math.max(0, (Date.now() - new Date(s.last_tick_at).getTime()) / 1000);
    elapsed = Math.min(elapsed, MAX_TICK_GAP_SEC);
    const add = Math.floor(elapsed * rateMicro);
    const accrued = Math.min(capMicro, Number(s.accrued_micro) + add);
    const capReached = accrued >= capMicro;
    await supabase.from('payment_streams')
      .update({ accrued_micro: accrued, last_tick_at: nowIso(), updated_at: nowIso() })
      .eq('id', id);
    s.accrued_micro = accrued;
    // Settle eagerly on cap so a finished stream closes promptly.
    if (capReached) settleStream(s, { closeOnCap: true }).catch((e) => console.warn('[streams] cap settle:', e.message));
    return publicStream(s, { capReached });
  }

  async function setStatus(id, status, extra = {}) {
    await supabase.from('payment_streams').update({ status, updated_at: nowIso(), ...extra }).eq('id', id);
  }

  async function pauseStream(id) { await setStatus(id, 'paused'); return getStream(id); }
  async function resumeStream(id) { await setStatus(id, 'active', { last_tick_at: nowIso() }); return getStream(id); }

  async function stopStream(id) {
    const { data: s } = await supabase.from('payment_streams').select('*').eq('id', id).maybeSingle();
    if (!s) throw new Error('Stream not found');
    if (s.status !== 'stopped') {
      await settleStream(s, { force: true }); // settle exactly what flowed
      await setStatus(id, 'stopped', { stopped_at: nowIso() });
    }
    console.log(`[streams] stop ${id} — settled ${microToUsdc(s.settled_micro)} USDC`);
    return getStream(id);
  }

  async function getStream(id) {
    const { data } = await supabase.from('payment_streams').select('*').eq('id', id).maybeSingle();
    return data ? publicStream(data) : null;
  }

  // ── Batched on-chain settlement (the real USDC movement) ───────────────────
  const settling = new Set(); // in-process lock (single node) → no double-settle
  async function settleStream(input, { force = false, closeOnCap = false } = {}) {
    const id = typeof input === 'string' ? input : input.id;
    if (settling.has(id)) return { settled: 0, busy: true };
    settling.add(id);
    try {
      const { data: s } = await supabase.from('payment_streams').select('*').eq('id', id).maybeSingle();
      if (!s) return { settled: 0 };
      const unsettledMicro = Math.max(0, Number(s.accrued_micro) - Number(s.settled_micro));
      if (unsettledMicro <= 0) return { settled: 0 };
      if (!force && unsettledMicro < SETTLE_THRESHOLD_MICRO) return { settled: 0, pending: microToUsdc(unsettledMicro) };
      // Demo mode: meter accrues, but no funds move until a human enables it.
      if (!STREAMS_PAID_ENABLED) return { settled: 0, live: false, pending: microToUsdc(unsettledMicro) };

      const payerWalletId = await walletIdFor(s.payer_user_id);
      if (!payerWalletId) { await setStatus(id, 'paused', { meta: { ...(s.meta || {}), error: 'no payer wallet' } }); return { settled: 0 }; }
      const payerInfo = await getWalletInfo(payerWalletId);
      const balMicro = Math.round(parseFloat(payerInfo.usdcBalance || '0') * 1_000_000);
      let amountMicro = unsettledMicro;
      if (balMicro < amountMicro) {
        amountMicro = balMicro; // settle what the payer can afford, then pause
        if (amountMicro <= 0) { await setStatus(id, 'paused', { meta: { ...(s.meta || {}), error: 'insufficient USDC' } }); return { settled: 0, insufficient: true }; }
      }

      const parts = Array.isArray(s.split) && s.split.length ? s.split : [{ address: s.recipient_address, bps: 10000 }];
      let distributed = 0, lastTx = null, acc = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const share = i === parts.length - 1 ? (amountMicro - acc) : Math.floor((amountMicro * p.bps) / 10000);
        acc += share;
        if (share <= 0 || !isAddress(p.address)) continue;
        try {
          const txRes = await circle.createContractExecutionTransaction({
            walletId: payerWalletId,
            contractAddress: USDC,
            abiFunctionSignature: 'transfer(address,uint256)',
            abiParameters: [p.address, String(share)],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          lastTx = txRes.data?.id || lastTx;
          distributed += share;
          supabase.from('x402_payments').insert({
            endpoint: 'stream_settle',
            payer: payerInfo.address || null,
            pay_to: p.address,
            amount_usdc: microToUsdc(share).toString(),
            network: ARC_NETWORK,
            gateway_tx: lastTx,
            raw: { kind: 'stream_settle', streamId: id, resource: s.resource, ratePerSecUsdc: Number(s.rate_per_sec_usdc), bps: p.bps },
          }).then(({ error }) => { if (error) console.warn('[streams] receipt:', error.message); });
        } catch (txErr) {
          console.warn(`[streams] settle transfer failed for ${id} → ${p.address}:`, txErr.message);
        }
      }
      if (distributed > 0) {
        await supabase.from('payment_streams')
          .update({ settled_micro: Number(s.settled_micro) + distributed, settle_tx: lastTx, updated_at: nowIso(), ...(closeOnCap ? { status: 'stopped', stopped_at: nowIso() } : {}) })
          .eq('id', id);
        console.log(`[streams] settled ${id} — ${microToUsdc(distributed)} USDC (${parts.length} payee${parts.length > 1 ? 's' : ''}) tx ${lastTx}`);
        award(s.payer_user_id, 'stream_settle', { refType: 'stream', refId: id }).catch(() => {});
      }
      return { settled: microToUsdc(distributed), tx: lastTx };
    } finally {
      settling.delete(id);
    }
  }

  function publicStream(s, extra = {}) {
    const capMicro = Math.round(Number(s.cap_usdc) * 1_000_000);
    return {
      id: s.id,
      status: s.status,
      resource: s.resource,
      ratePerSecUsdc: Number(s.rate_per_sec_usdc),
      capUsdc: Number(s.cap_usdc),
      accruedUsdc: microToUsdc(s.accrued_micro),
      settledUsdc: microToUsdc(s.settled_micro),
      pendingUsdc: microToUsdc(Math.max(0, Number(s.accrued_micro) - Number(s.settled_micro))),
      remainingUsdc: microToUsdc(Math.max(0, capMicro - Number(s.accrued_micro))),
      payer: s.payer_user_id,
      recipient: s.recipient_user_id || s.recipient_address,
      split: Array.isArray(s.split) ? s.split : null,
      openedBy: s.opened_by,
      live: STREAMS_PAID_ENABLED,
      startedAt: s.started_at,
      lastTickAt: s.last_tick_at,
      stoppedAt: s.stopped_at,
      settleTx: s.settle_tx || null,
      ...extra,
    };
  }

  // ── Reconciler: auto-pause stale streams + settle batched accrual ──────────
  let reconciling = false;
  async function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      const { data: rows, error } = await supabase
        .from('payment_streams').select('*').in('status', ['active', 'paused']).limit(500);
      if (error) return; // table may not exist yet (migration pending) — stay quiet
      for (const s of rows || []) {
        // Proof-of-flow: an active stream with no heartbeat for STALE_SEC pauses.
        if (s.status === 'active') {
          const idle = (Date.now() - new Date(s.last_tick_at).getTime()) / 1000;
          if (idle > STALE_SEC) { await setStatus(s.id, 'paused'); s.status = 'paused'; }
        }
        const unsettled = Number(s.accrued_micro) - Number(s.settled_micro);
        if (unsettled >= SETTLE_THRESHOLD_MICRO) {
          await settleStream(s, {}).catch((e) => console.warn('[streams] reconcile settle:', e.message));
        }
      }
    } catch (e) {
      console.warn('[streams] reconcile error:', e.message);
    } finally {
      reconciling = false;
    }
  }

  // ── HTTP routes ────────────────────────────────────────────────────────────

  // Public config — handy for the SDK, the agent, and judges clicking around.
  app.get('/api/streams/config', (_req, res) => {
    res.json({
      enabled: STREAMS_ENABLED,
      live: STREAMS_PAID_ENABLED,
      network: ARC_NETWORK,
      asset: USDC,
      settleThresholdUsdc: SETTLE_THRESHOLD_USDC,
      staleSec: STALE_SEC,
      maxRatePerSecUsdc: MAX_RATE_PER_SEC_USDC,
      maxCapUsdc: MAX_CAP_USDC,
      model: 'pay-per-second · continuous authorization (rate+cap) · proof-of-flow auto-pause · Gateway-style batched USDC settlement · live split',
    });
  });

  // Open a stream (authorize a rate + cap). Payer = authenticated caller.
  app.post('/api/streams/open', auth, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!STREAMS_ENABLED) return res.status(503).json({ error: 'Streams are disabled' });
      const stream = await openStream({
        payerUserId: req.body.userId,
        recipientUserId: req.body.recipientUserId,
        recipientAddress: req.body.recipientAddress,
        resource: req.body.resource,
        ratePerSecUsdc: req.body.ratePerSecUsdc,
        capUsdc: req.body.capUsdc,
        split: req.body.split,
        openedBy: req.body.openedBy === 'agent' ? 'agent' : 'user',
        meta: typeof req.body.meta === 'object' && req.body.meta ? req.body.meta : {},
      });
      await award(req.body.userId, 'stream_open', { refType: 'stream', refId: stream.id }).catch(() => {});
      res.json({ ok: true, stream: publicStream(stream) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Heartbeat — advance the meter (proof-of-flow). Idempotent-ish: charges only
  // for elapsed time since the last tick.
  app.post('/api/streams/:id/tick', auth, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const out = await tickStream(req.params.id, { byUserId: req.body.userId });
      res.json({ ok: true, stream: out });
    } catch (e) {
      res.status(e.message === 'Stream not found' ? 404 : 400).json({ error: e.message });
    }
  });

  const ownerGuard = async (req, res, next) => {
    try {
      const { data: s } = await supabase.from('payment_streams').select('payer_user_id,recipient_user_id').eq('id', req.params.id).maybeSingle();
      if (!s) return res.status(404).json({ error: 'Stream not found' });
      if (s.payer_user_id !== req.body.userId && s.recipient_user_id !== req.body.userId) return res.status(403).json({ error: 'Not your stream' });
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };

  app.post('/api/streams/:id/pause', auth, requireVerifiedUser, ownerGuard, async (req, res) => {
    try { res.json({ ok: true, stream: await pauseStream(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/streams/:id/resume', auth, requireVerifiedUser, ownerGuard, async (req, res) => {
    try { res.json({ ok: true, stream: await resumeStream(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/streams/:id/stop', auth, requireVerifiedUser, ownerGuard, async (req, res) => {
    try { res.json({ ok: true, stream: await stopStream(req.params.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/streams/:id', async (req, res) => {
    try {
      const s = await getStream(req.params.id);
      if (!s) return res.status(404).json({ error: 'Stream not found' });
      res.json({ stream: s });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // List a user's streams (as payer or recipient).
  app.get('/api/streams', async (req, res) => {
    try {
      const uid = req.query.userId;
      if (!uid) return res.status(400).json({ error: 'userId required' });
      const { data, error } = await supabase
        .from('payment_streams').select('*')
        .or(`payer_user_id.eq.${uid},recipient_user_id.eq.${uid}`)
        .order('started_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json({ streams: (data || []).map((s) => publicStream(s)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Live network-wide stream stats (for the UI / judges).
  app.get('/api/streams/stats/summary', async (_req, res) => {
    try {
      const { data } = await supabase.from('payment_streams').select('status, accrued_micro, settled_micro, rate_per_sec_usdc');
      const rows = data || [];
      const sum = (f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
      res.json({
        live: STREAMS_PAID_ENABLED,
        totalStreams: rows.length,
        active: rows.filter((r) => r.status === 'active').length,
        streamedUsdc: +microToUsdc(sum('accrued_micro')).toFixed(6),
        settledUsdc: +microToUsdc(sum('settled_micro')).toFixed(6),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  if (STREAMS_ENABLED) {
    setTimeout(reconcile, 30_000).unref?.();
    setInterval(reconcile, RECONCILE_SEC * 1000).unref?.();
  }
  console.log(`[streams] Puls Streams routes registered (enabled: ${STREAMS_ENABLED}, paid: ${STREAMS_PAID_ENABLED ? 'ON' : 'OFF'}, settle@${SETTLE_THRESHOLD_USDC} USDC, stale ${STALE_SEC}s)`);

  // Programmatic API for the agent loop (no HTTP round-trip).
  return { openStream, tick: tickStream, pause: pauseStream, resume: resumeStream, stop: stopStream, settle: settleStream, get: getStream, reconcile };
}
