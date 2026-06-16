/**
 * Puls Alpha — paid premium analysis (T1 creator layer).
 *
 * "Forecaster = creator, paid per read." A premium forecast (thesis) is sold
 * per-unlock as a sub-cent USDC nanopayment on Arc Testnet. The teaser is free;
 * the full thesis unlocks once the reader pays the creator. Each unlock is a true
 * per-event nanopayment, visible on Arcscan and surfaced in the in-app Earnings
 * tab (endpoint='alpha_unlock') next to copy-fees and Gateway x402 receipts.
 *
 * Honesty / architecture notes (read before reviewing):
 *  - The unlock fee is a REAL on-chain USDC micro-transfer reader→creator
 *    (ERC-20 `transfer`, gasless via the reader's Circle SCA + Gas Station),
 *    the exact same proven rail as the copy-fee in lib/copytrade.js.
 *  - We deliberately do NOT route in-app reader payments through Circle Gateway
 *    x402: the Gateway buyer flow needs an EOA private key signing EIP-3009
 *    off-chain, but in-app wallets are Circle SCA (ERC-4337) dev-controlled
 *    accounts whose keys we never hold. A direct micro-transfer is the honest,
 *    demoable equivalent that works for every real user. The pure Gateway x402
 *    settle stays demonstrated by the agent-buyer (scripts/x402-buyer.mjs against
 *    the paywalled /api/alpha/sample) — that is the "agent pays creator" proof.
 *  - LIVE PAYMENTS ARE GATED behind env `ALPHA_PAID_ENABLED=true` (default OFF)
 *    so the feature ships to prod without moving real funds until a human turns
 *    it on for the demo run. When OFF, /unlock returns { ok:false, live:false }
 *    and the UI honestly shows "activates at launch".
 *
 * Content source:
 *  - Premium forecasts are authored as markdown in ./content/alpha/*.md and
 *    loaded at startup (see loadSignalsFromDisk). This lets the content team
 *    (Mimo) add/edit analyses without touching code. If the directory is empty
 *    or unreadable we fall back to FALLBACK_SIGNALS so the endpoint never 500s.
 *
 * Durable-access / exactly-once payment (the edge-case fix):
 *  - The unlock row is RESERVED as status='pending' BEFORE the on-chain transfer
 *    and flipped to 'confirmed' after. So if the confirm-write ever fails after a
 *    payment, a retry finds the pending row and grants access WITHOUT charging
 *    again — the reader is never double-charged, and access is durable.
 *
 * Wiring (server.js):
 *   import { registerAlpha } from './lib/alpha.js';
 *   registerAlpha(app, { supabase, circle, USDC, getWalletId, getWalletInfo,
 *     authenticateUser, requireVerifiedUser, strictLimiter });
 *   // and label alpha_unlock receipts in /api/x402/payments (see paymentType).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, '../content/alpha');

const DEFAULT_PRICE_USDC = Number(process.env.ALPHA_PRICE_USDC || 0.01);
const DEFAULT_CREATOR = (process.env.ALPHA_CREATOR_HANDLE || 'puls-house').trim();

// ── Markdown parser ───────────────────────────────────────────────────────
// Each ./content/alpha/NN-slug.md is a free-form analysis written by the
// content team. We derive structured metadata from a stable shape:
//   # <question>                              → title / market
//   **Thesis: YES — probability 62%**         → stance + confidence
//   <intro paragraph>                          → free teaser (the hook)
//   **Arguments for YES:** ... **Play:** ...   → paywalled thesis (full body)

function parseAlphaMarkdown(slug, raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;

  // id: drop a leading "NN-" ordering prefix for a clean slug.
  const id = slug.replace(/^\d+[-_]/, '');

  // title: first H1.
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  // stance + confidence from the **Thesis: YES — probability 62%** line.
  const thesisLine = text.match(/\*\*\s*Thesis:\s*(YES|NO)\b[^*]*?(\d{1,3})\s*%/i);
  const stance = thesisLine ? thesisLine[1].toUpperCase() : 'YES';
  let confidence = thesisLine ? Math.min(0.99, Math.max(0.01, Number(thesisLine[2]) / 100)) : 0.55;

  // teaser: the intro paragraph (between the thesis line and the first
  // "**Arguments" block). This is the hook; the structured analysis stays paid.
  let teaser = '';
  const afterThesis = thesisLine ? text.slice((thesisLine.index || 0) + thesisLine[0].length) : text;
  const introMatch = afterThesis.split(/\n\s*\*\*Arguments/i)[0];
  if (introMatch) {
    teaser = introMatch.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  }
  if (!teaser) teaser = `${stance} — our desk's read on "${title}".`;
  if (teaser.length > 320) teaser = `${teaser.slice(0, 317).trimEnd()}…`;

  // horizon: best-effort from the title ("end of 2026", "September 2026", "Q4 2026").
  let horizon = '2026';
  const yr = title.match(/\b(20\d{2})\b/);
  const monthQ = title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Q[1-4])\b/i);
  const endOf = /\bend of\b/i.test(title);
  if (yr) {
    horizon = `${endOf ? 'end of ' : ''}${monthQ ? `${monthQ[1]} ` : ''}${yr[1]}`.trim();
  } else if (monthQ) {
    horizon = monthQ[1];
  }

  // edgeBps: conviction proxy vs a coin-flip line (display only).
  const edgeBps = Math.max(0, Math.round((confidence - 0.5) * 2000));

  return {
    id,
    title,
    market: title,
    stance,
    confidence,
    edgeBps,
    horizon,
    priceUsdc: DEFAULT_PRICE_USDC,
    creatorHandle: DEFAULT_CREATOR,
    teaser,
    // full markdown body = the paid content, minus the redundant H1 (the card
    // already shows the question as its title).
    thesis: text.replace(/^#\s+.+\n+/, '').trim(),
  };
}

function loadSignalsFromDisk() {
  try {
    const files = fs
      .readdirSync(CONTENT_DIR)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
    const signals = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8');
        const sig = parseAlphaMarkdown(f.replace(/\.md$/i, ''), raw);
        if (sig && sig.id) signals.push(sig);
      } catch (e) {
        console.warn(`[alpha] failed to parse ${f}:`, e.message);
      }
    }
    return signals;
  } catch (e) {
    console.warn('[alpha] content dir unreadable, using fallback signals:', e.message);
    return [];
  }
}

// Minimal built-in set used only if ./content/alpha is empty/unreadable.
const FALLBACK_SIGNALS = [
  {
    id: 'arc-mainnet',
    title: 'Arc mainnet live in 2026',
    market: 'Will Circle Arc launch mainnet before 2027?',
    stance: 'YES',
    confidence: 0.7,
    edgeBps: 400,
    horizon: '2026',
    priceUsdc: DEFAULT_PRICE_USDC,
    creatorHandle: DEFAULT_CREATOR,
    teaser: 'Testnet velocity (Gateway nanopayments, USDC-as-gas) signals a credible 2026 mainnet window the line under-prices.',
    thesis:
      'Shipping cadence on Arc testnet — Gateway batched nanopayments, USDC-as-gas, sub-500ms settlement, an '
      + 'active builder program — is consistent with a team on a public mainnet glidepath. Edge ~400bps on YES. '
      + 'Invalidation: a public roadmap slip or a security-audit pause.',
  },
];

const loaded = loadSignalsFromDisk();
const ALPHA_SIGNALS = loaded.length > 0 ? loaded : FALLBACK_SIGNALS;
console.log(`[alpha] loaded ${ALPHA_SIGNALS.length} signal(s) from ${loaded.length ? 'content/alpha' : 'fallback'}`);

const ALPHA_PAID_ENABLED = String(process.env.ALPHA_PAID_ENABLED || '').toLowerCase() === 'true';

function publicSignal(s, unlocked) {
  const base = {
    id: s.id,
    title: s.title,
    market: s.market,
    stance: s.stance,
    confidence: s.confidence,
    edgeBps: s.edgeBps,
    horizon: s.horizon,
    priceUsdc: s.priceUsdc,
    creatorHandle: s.creatorHandle,
    teaser: s.teaser,
    unlocked: Boolean(unlocked),
  };
  if (unlocked) base.thesis = s.thesis;
  return base;
}

export function registerAlpha(app, deps) {
  const {
    supabase,
    circle,
    USDC,
    getWalletId,
    getWalletInfo,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
  } = deps;

  const payToFor = (_signal) => (process.env.X402_SELLER_ADDRESS || '').trim() || null;

  // Fetch a single unlock row (with status). Returns null on miss / error.
  async function getUnlockRow(userId, signalId) {
    if (!userId) return null;
    try {
      const { data, error } = await supabase
        .from('alpha_unlocks')
        .select('signal_id,status')
        .eq('user_id', userId)
        .eq('signal_id', signalId)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) {
      console.warn('[alpha] getUnlockRow failed:', e.message);
      return null;
    }
  }

  // Set of signal_ids the user has durable (confirmed OR recovered-pending) access to.
  async function unlockedIdsFor(userId) {
    if (!userId) return new Set();
    try {
      const { data, error } = await supabase
        .from('alpha_unlocks')
        .select('signal_id')
        .eq('user_id', userId);
      if (error) throw error;
      // Any row (pending or confirmed) grants access — pending means we already
      // submitted a payment for it, so never re-gate / re-charge.
      return new Set((data || []).map((r) => r.signal_id));
    } catch (e) {
      console.warn('[alpha] unlockedIdsFor failed:', e.message);
      return new Set();
    }
  }

  async function markConfirmed(userId, signalId, fields = {}) {
    try {
      await supabase
        .from('alpha_unlocks')
        .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), ...fields })
        .eq('user_id', userId)
        .eq('signal_id', signalId);
    } catch (e) {
      console.warn('[alpha] markConfirmed failed:', e.message);
    }
  }

  // ── List premium forecasts (public). Teaser only; never returns thesis. ──
  // Optional ?userId= annotates which signals the caller has already unlocked.
  app.get('/api/alpha/list', async (req, res) => {
    try {
      const userId = req.query.userId || null;
      const unlocked = await unlockedIdsFor(userId);
      res.json({
        signals: ALPHA_SIGNALS.map((s) => publicSignal(s, unlocked.has(s.id))),
        live: ALPHA_PAID_ENABLED,
        seller: payToFor(null),
      });
    } catch (e) {
      console.error('[alpha] list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Full thesis for one signal (auth). Returns thesis only if the verified
  //    caller has unlocked it; otherwise 402 + teaser. ──
  app.get('/api/alpha/:id', authenticateUser, async (req, res) => {
    try {
      const userId = req.query.userId; // forced to verified id by authenticateUser
      const signal = ALPHA_SIGNALS.find((s) => s.id === req.params.id);
      if (!signal) return res.status(404).json({ error: 'Signal not found' });
      const unlocked = (await unlockedIdsFor(userId)).has(signal.id);
      if (!unlocked) {
        return res.status(402).json({ locked: true, signal: publicSignal(signal, false), live: ALPHA_PAID_ENABLED });
      }
      res.json({ locked: false, signal: publicSignal(signal, true) });
    } catch (e) {
      console.error('[alpha] get error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Unlock a signal (auth). Pays the creator a real per-read USDC micro-fee
  //    from the reader's SCA wallet, then grants access.
  //
  //    Exactly-once semantics (no double charge, durable access):
  //      1) confirmed row exists       → return content, no charge
  //      2) pending row exists         → a prior attempt already paid; just
  //                                      confirm + return content, no re-charge
  //      3) otherwise RESERVE pending  → transfer → confirm. If the confirm
  //                                      write fails after the transfer, the
  //                                      pending row survives so a retry lands
  //                                      in case (2) instead of paying twice.
  app.post('/api/alpha/:id/unlock', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId; // forced to verified id by authenticateUser
      const signal = ALPHA_SIGNALS.find((s) => s.id === req.params.id);
      if (!signal) return res.status(404).json({ error: 'Signal not found' });

      const existing = await getUnlockRow(userId, signal.id);
      if (existing) {
        // (1) confirmed, or (2) pending (payment already submitted) → grant, no charge.
        if (existing.status === 'pending') await markConfirmed(userId, signal.id);
        return res.json({ ok: true, alreadyUnlocked: true, signal: publicSignal(signal, true) });
      }

      // Gated until a human enables live payments for the demo run.
      if (!ALPHA_PAID_ENABLED) {
        return res.json({
          ok: false,
          live: false,
          message: 'Paid analysis activates at launch — payments are currently disabled.',
          signal: publicSignal(signal, false),
        });
      }

      const payTo = payToFor(signal);
      if (!payTo) return res.status(503).json({ error: 'Creator payout address not configured' });

      const walletId = await getWalletId(userId);
      if (!walletId) return res.status(400).json({ error: 'No wallet for user' });
      const info = await getWalletInfo(walletId);

      const price = Number(signal.priceUsdc) || 0;
      if (parseFloat(info.usdcBalance) < price) {
        return res.status(402).json({ error: 'Insufficient USDC balance to unlock' });
      }

      // ── RESERVE access (status='pending') BEFORE moving any funds. ──
      // The unique(user_id,signal_id) constraint makes this the idempotency key.
      const { error: reserveErr } = await supabase
        .from('alpha_unlocks')
        .insert({
          user_id: userId,
          signal_id: signal.id,
          status: 'pending',
          amount_usdc: price,
          created_at: new Date().toISOString(),
        });
      if (reserveErr) {
        // A concurrent request already reserved it → treat as already-unlocked
        // (the other request owns the payment); never charge twice.
        console.warn('[alpha] reserve conflict, treating as unlocked:', reserveErr.message);
        return res.json({ ok: true, alreadyUnlocked: true, signal: publicSignal(signal, true) });
      }

      // ── Real on-chain USDC micro-transfer reader → creator (gasless SCA). ──
      let txId = null;
      try {
        const amountMicro = Math.round(price * 1_000_000).toString();
        const txRes = await circle.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC,
          abiFunctionSignature: 'transfer(address,uint256)',
          abiParameters: [payTo, amountMicro],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        txId = txRes.data?.id || null;
      } catch (txErr) {
        // Payment submission failed → roll back the reservation so the reader
        // can retry and be charged exactly once (no orphaned free unlock).
        await supabase.from('alpha_unlocks').delete().eq('user_id', userId).eq('signal_id', signal.id);
        console.error('[alpha] transfer submit failed, reservation rolled back:', txErr.message);
        return res.status(502).json({ error: 'Payment failed, please try again' });
      }

      // ── Confirm durable access. If this write fails, the pending row remains
      //    and a retry recovers via the case-(2) path (no re-charge). ──
      await markConfirmed(userId, signal.id, { tx_id: txId });

      // Receipt → Earnings tab (endpoint='alpha_unlock').
      supabase
        .from('x402_payments')
        .insert({
          endpoint: 'alpha_unlock',
          payer: info.address || null,
          pay_to: payTo,
          amount_usdc: price.toString(),
          network: 'eip155:5042002',
          gateway_tx: txId,
          raw: { kind: 'alpha_unlock', signalId: signal.id, priceUsdc: price },
        })
        .then(({ error }) => {
          if (error) console.warn('[alpha] receipt insert failed:', error.message);
        });

      console.log(`[alpha] unlock ${signal.id} — ${price} USDC ${info.address} → ${payTo} (tx ${txId})`);

      res.json({
        ok: true,
        signal: publicSignal(signal, true),
        receipt: { amountUsdc: price, payTo, txId, network: 'eip155:5042002' },
      });
    } catch (e) {
      console.error('[alpha] unlock error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[alpha] paid-analysis routes registered (live payments: ${ALPHA_PAID_ENABLED ? 'ON' : 'OFF'})`);

  return { ALPHA_SIGNALS };
}
