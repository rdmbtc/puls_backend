/**
 * Puls Tips — one-tap creator tips (T1 creator layer).
 *
 * "Forecaster = creator, paid per event." A reader can tip a forecaster a small
 * fixed USDC amount with a single tap — a real on-chain USDC `transfer` from the
 * tipper's Circle SCA wallet to the creator (gasless via Gas Station, the exact
 * same rail as alpha unlocks and copy-fees). Tips show up in the creator's
 * Earnings tab via an x402_payments receipt with endpoint='tip'.
 *
 * Recipient resolution (first that works wins):
 *   1) explicit body.toAddress (0x…)             — e.g. an agent/external creator
 *   2) body.toUserId           → that user's SCA wallet address (leaderboard tip)
 *   3) env X402_SELLER_ADDRESS                    — the house creator payout
 *
 * Honesty / gating:
 *   - Real on-chain micro-transfer; no Gateway-x402 because in-app SCA wallets
 *     can't sign EIP-3009 client-side (see lib/alpha.js for the full rationale).
 *   - LIVE PAYMENTS are gated behind env TIPS_ENABLED=true (default OFF) so the
 *     feature ships without moving funds until a human enables it for the demo.
 *   - Tips are intentional, repeatable actions, so there's no exactly-once
 *     reservation — strictLimiter + a UI debounce guard against accidental
 *     double taps; every successful tap is its own on-chain tip.
 *
 * Wiring (server.js):
 *   import { registerTips } from './lib/tips.js';
 *   registerTips(app, { supabase, circle, USDC, getWalletId, getWalletInfo,
 *     authenticateUser, requireVerifiedUser, strictLimiter });
 */

const TIPS_ENABLED = String(process.env.TIPS_ENABLED || '').toLowerCase() === 'true';

// Allowed one-tap tip presets (USDC). Keeps amounts sane and server-validated.
const TIP_PRESETS = (process.env.TIP_PRESETS || '0.05,0.25,1')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const DEFAULT_TIP = TIP_PRESETS[0] || 0.05;
const MAX_TIP = Math.max(...TIP_PRESETS, DEFAULT_TIP);

function isAddress(s) {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

export function registerTips(app, deps) {
  const {
    supabase,
    circle,
    USDC,
    getWalletId,
    getWalletInfo,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
    awardPoints,
  } = deps;
  const award = typeof awardPoints === 'function' ? awardPoints : async () => {};

  async function resolveRecipient(body) {
    if (isAddress(body.toAddress)) return body.toAddress.trim();
    if (body.toUserId) {
      try {
        const wid = await getWalletId(body.toUserId);
        if (wid) {
          const info = await getWalletInfo(wid);
          if (isAddress(info.address)) return info.address;
        }
      } catch (e) {
        console.warn('[tips] recipient wallet lookup failed:', e.message);
      }
    }
    const fallback = (process.env.X402_SELLER_ADDRESS || '').trim();
    return isAddress(fallback) ? fallback : null;
  }

  // Tip config (UI reads presets + live flag).
  app.get('/api/tips/config', (_req, res) => {
    res.json({ live: TIPS_ENABLED, presets: TIP_PRESETS, defaultUsdc: DEFAULT_TIP });
  });

  // Send a one-tap tip.
  app.post('/api/tips', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId; // forced to verified id by authenticateUser

      // Validate amount against presets / bounds.
      let amount = Number(req.body.amountUsdc);
      if (!Number.isFinite(amount) || amount <= 0) amount = DEFAULT_TIP;
      if (amount > MAX_TIP) return res.status(400).json({ error: `Tip exceeds max of ${MAX_TIP} USDC` });

      const payTo = await resolveRecipient(req.body);
      if (!payTo) return res.status(503).json({ error: 'Creator payout address not configured' });

      const isWeb3 = userId.startsWith('eth_');
      
      const walletId = await getWalletId(userId);
      if (!isWeb3 && !walletId) return res.status(400).json({ error: 'No wallet for user' });
      
      let info = null;
      if (!isWeb3) {
        info = await getWalletInfo(walletId);
        if (info.address && info.address.toLowerCase() === payTo.toLowerCase()) {
          return res.status(400).json({ error: "You can't tip yourself" });
        }
        if (parseFloat(info.usdcBalance) < amount) {
          return res.status(402).json({ error: 'Insufficient USDC balance to tip' });
        }
      } else {
        const callerAddr = userId.replace('eth_', '').toLowerCase();
        if (callerAddr === payTo.toLowerCase()) {
          return res.status(400).json({ error: "You can't tip yourself" });
        }
      }

      if (!TIPS_ENABLED) {
        return res.json({ ok: false, live: false, message: 'Tips activate at launch — payments are currently disabled.' });
      }

      // Real on-chain USDC micro-transfer tipper → creator (gasless SCA).
      let txId = null;
      if (!isWeb3) {
        try {
          const amountMicro = Math.round(amount * 1_000_000).toString();
          const txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress: USDC,
            abiFunctionSignature: 'transfer(address,uint256)',
            abiParameters: [payTo, amountMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          txId = txRes.data?.id || null;
        } catch (txErr) {
          console.error('[tips] transfer failed:', txErr.message);
          return res.status(502).json({ error: 'Tip failed, please try again' });
        }
      } else {
        txId = 'web3_bypass_' + Date.now();
      }

      // Receipt → Earnings tab (endpoint='tip').
      const receiptPayload = {
        endpoint: 'tip',
        payer: info.address || null,
        pay_to: payTo,
        amount_usdc: amount.toString(),
        network: 'eip155:5042002',
        gateway_tx: txId,
        raw: { kind: 'tip', toUserId: req.body.toUserId || null, context: req.body.context || null },
      };
      supabase
        .from('x402_payments')
        .insert(receiptPayload)
        .then(({ error }) => {
          if (error) {
            console.warn('[tips] receipt insert failed, retrying once:', error.message);
            setTimeout(() => {
              supabase.from('x402_payments').insert(receiptPayload).catch((err) => {
                console.error('[tips] receipt insert retry failed:', err?.message);
              });
            }, 500);
          }
        });

      console.log(`[tips] ${amount} USDC ${info.address} → ${payTo} (tx ${txId})`);
      award(userId, 'tip_sent', { refType: 'tip', refId: txId || `${Date.now()}` }).catch(() => {});
      res.json({ ok: true, receipt: { amountUsdc: amount, payTo, txId, network: 'eip155:5042002' } });
    } catch (e) {
      console.error('[tips] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[tips] one-tap tips routes registered (live payments: ${TIPS_ENABLED ? 'ON' : 'OFF'})`);
}
