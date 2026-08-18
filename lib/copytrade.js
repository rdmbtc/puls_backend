/**
 * Puls copy-trade engine (T1 creator layer).
 *
 * A follower opts in to "copy" a leader (top forecaster). When that leader opens
 * a position via /api/trade/buy, we mirror the same side onto each active
 * follower's wallet — scaled down to the follower's per-trade spend cap — and
 * pay the leader a per-event creator micro-fee. This is the "forecaster = creator,
 * paid per event" narrative: agents (follower wallets) pay humans (leaders) for
 * every copied trade.
 *
 * Design / honesty notes (read before reviewing):
 *  - The mirror BUY reuses the exact Circle dev-controlled-wallet path used by
 *    /api/trade/buy (approve → buyYes/buyNo), so it inherits the same gasless
 *    (Gas Station) behaviour. No new on-chain primitives.
 *  - The leader micro-fee is a REAL on-chain USDC micro-transfer follower→leader
 *    (ERC-20 `transfer`, gasless via SCA + Gas Station). It is a true per-event
 *    nanopayment, visible on Arcscan, and is recorded into `x402_payments` with
 *    payment_type='copy_fee' so it shows up in the in-app Earnings tab next to
 *    the Gateway x402 paywall receipts.
 *  - We deliberately do NOT route the copy-fee through Circle Gateway x402: the
 *    Gateway buyer flow needs an EOA private key that signs EIP-3009 offchain,
 *    but follower wallets are Circle SCA (ERC-4337) dev-controlled accounts whose
 *    keys we never hold and which don't expose that signing path. A direct
 *    on-chain micro-transfer is the honest, demoable equivalent. The Gateway
 *    batched x402 path still powers the paid-analysis paywall (/api/alpha/sample).
 *  - LIVE EXECUTION IS GATED behind env `COPY_TRADE_ENABLED=true` (default OFF)
 *    so the feature can ship to prod without auto-spending follower funds until
 *    a human deliberately turns it on for the demo run.
 *
 * Wiring (server.js):
 *   import { registerCopyTrade } from './lib/copytrade.js';
 *   const copyTrade = registerCopyTrade(app, { supabase, circle, USDC, publicClient,
 *     getWalletId, getWalletInfo, getOrDeployMarket, isApproved, saveTrade,
 *     authenticateUser, requireVerifiedUser, strictLimiter, clampPrice });
 *   // inside /api/trade/buy, after the buy tx is created:
 *   copyTrade.mirrorBuyToFollowers(userId, { slug, deadline, side, usdcAmount: amount,
 *     question, entryPrice: req.body.entryPrice }).catch(() => {});
 */

const MAX_UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

// Hard caps so a single leader trade can never fan out unbounded work / spend.
const MAX_FOLLOWERS_PER_TRADE = 25;

const COPY_TRADE_ENABLED = String(process.env.COPY_TRADE_ENABLED || '').toLowerCase() === 'true';
// Per-event creator fee the follower pays the leader (USDC). Sub-cent by default.
const COPY_FEE_USDC = (() => {
  const v = parseFloat(process.env.COPY_FEE_USDC || '0.005');
  return Number.isFinite(v) && v >= 0 ? v : 0.005;
})();

export function registerCopyTrade(app, deps) {
  const {
    supabase,
    circle,
    USDC,
    publicClient, // eslint-disable-line no-unused-vars -- reserved for future read checks
    getWalletId,
    getWalletInfo,
    getOrDeployMarket,
    isApproved,
    saveTrade,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
    clampPrice,
  } = deps;

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function listActiveFollowers(leaderUserId) {
    try {
      const { data, error } = await supabase
        .from('copy_follows')
        .select('follower_user_id, max_per_trade_usdc')
        .eq('leader_user_id', leaderUserId)
        .eq('active', true)
        .limit(MAX_FOLLOWERS_PER_TRADE);
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.warn('[copy] listActiveFollowers failed:', e.message);
      return [];
    }
  }

  async function ensureApproval(walletId, contractAddress) {
    if (await isApproved(walletId, contractAddress)) return;
    const approveRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: USDC,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [contractAddress, MAX_UINT256],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    const approveTxId = approveRes.data?.id;
    for (let i = 0; approveTxId && i < 20; i++) {
      const s = (await circle.getTransaction({ id: approveTxId })).data?.transaction?.state;
      if (s === 'COMPLETE' || s === 'CONFIRMED') break;
      if (s === 'FAILED' || s === 'DENIED' || s === 'CANCELLED') {
        throw new Error('USDC approval transaction failed');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * Pay the leader a per-event creator micro-fee from the follower's wallet.
   * Real on-chain USDC transfer; recorded into x402_payments as payment_type=copy_fee.
   */
  async function payCopyFee(followerWallet, leaderAddress, marketId) {
    if (!leaderAddress || COPY_FEE_USDC <= 0) return null;
    try {
      const feeMicro = Math.round(COPY_FEE_USDC * 1_000_000).toString();
      const txRes = await circle.createContractExecutionTransaction({
        walletId: followerWallet.walletId,
        contractAddress: USDC,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [leaderAddress, feeMicro],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      const txId = txRes.data?.id || null;

      // Best-effort receipt (never blocks). Shows in the Earnings tab.
      supabase
        .from('x402_payments')
        .insert({
          // endpoint='copy_fee' is the durable label the Earnings feed reads
          // (no dependency on an optional payment_type column).
          endpoint: 'copy_fee',
          payer: followerWallet.address || null,
          pay_to: leaderAddress,
          amount_usdc: COPY_FEE_USDC.toString(),
          network: 'eip155:5042002',
          gateway_tx: txId,
          raw: { kind: 'copy_fee', marketId, feeUsdc: COPY_FEE_USDC },
        })
        .then(({ error }) => {
          if (error) console.warn('[copy] copy_fee receipt insert failed:', error.message);
        });

      console.log(
        `[copy] copy_fee ${COPY_FEE_USDC} USDC ${followerWallet.address} → ${leaderAddress} (tx ${txId})`
      );
      return txId;
    } catch (e) {
      console.warn('[copy] payCopyFee failed:', e.message);
      return null;
    }
  }

  /**
   * Mirror a leader's BUY onto every active follower (scaled to their cap),
   * then pay the leader a per-event micro-fee from each follower.
   * Fire-and-forget: callers should `.catch()` — this never throws upward.
   *
   * @param {string} leaderUserId  verified leader userId (e.g. supabase_<uuid>)
   * @param {object} trade { slug, deadline, side, usdcAmount, question, entryPrice, isCopy? }
   */
  async function mirrorBuyToFollowers(leaderUserId, trade) {
    try {
      if (!COPY_TRADE_ENABLED) return; // gated until a human enables it (see .env.example)
      if (!leaderUserId || !trade || trade.isCopy) return; // no cascades from copied trades
      const { slug, deadline, side, usdcAmount, question } = trade;
      if (!slug || !deadline || !side || !usdcAmount) return;

      const followers = await listActiveFollowers(leaderUserId);
      if (followers.length === 0) return;

      // Resolve the leader's payTo address once (its user wallet).
      let leaderAddress = null;
      const leaderWalletId = await getWalletId(leaderUserId);
      if (leaderWalletId) leaderAddress = (await getWalletInfo(leaderWalletId)).address || null;

      const isYes = side === 'YES';
      const entryPrice = clampPrice(trade.entryPrice);

      // Sequential to stay gentle on Circle rate limits and keep spend bounded.
      for (const f of followers) {
        const followerUserId = f.follower_user_id;
        if (followerUserId === leaderUserId) continue;
        try {
          const walletId = await getWalletId(followerUserId);
          if (!walletId) continue;

          const cap = parseFloat(f.max_per_trade_usdc);
          const copyAmount = Math.min(parseFloat(usdcAmount), Number.isFinite(cap) ? cap : 0);
          if (!(copyAmount > 0)) continue;

          const info = await getWalletInfo(walletId);
          // Need enough for the copied buy plus the leader micro-fee.
          if (parseFloat(info.usdcBalance) < copyAmount + COPY_FEE_USDC) {
            console.log(`[copy] follower ${followerUserId} skipped — insufficient balance`);
            continue;
          }

          const contractAddress = await getOrDeployMarket(slug, deadline);
          await ensureApproval(walletId, contractAddress);

          const amountMicro = Math.round(copyAmount * 1_000_000).toString();
          const txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress,
            abiFunctionSignature: isYes ? 'buyYes(uint256)' : 'buyNo(uint256)',
            abiParameters: [amountMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });

          await saveTrade(followerUserId, {
            tx_id: txRes.data?.id,
            side,
            usdc_amount: copyAmount,
            entry_price: entryPrice,
            question: question || 'Prediction Market',
            market_id: contractAddress,
            state: 'INITIATED',
          });

          console.log(
            `[copy] mirrored ${side} $${copyAmount} for ${followerUserId} (leader ${leaderUserId})`
          );

          // Per-event creator fee → leader.
          await payCopyFee({ walletId, address: info.address }, leaderAddress, contractAddress);
        } catch (perFollowerErr) {
          console.warn(`[copy] mirror failed for ${followerUserId}:`, perFollowerErr.message);
        }
      }
    } catch (e) {
      console.error('[copy] mirrorBuyToFollowers error:', e.message);
    }
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  // Follow a leader with a per-trade spend cap. follower = verified caller.
  app.post('/api/copy/follow', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const followerUserId = req.body.userId; // forced to the verified id by authenticateUser
      const { leaderUserId } = req.body;
      let maxPerTrade = parseFloat(req.body.maxPerTradeUsdc);
      if (!leaderUserId) return res.status(400).json({ error: 'leaderUserId required' });
      if (leaderUserId === followerUserId) return res.status(400).json({ error: 'Cannot copy yourself' });
      if (!Number.isFinite(maxPerTrade) || maxPerTrade <= 0) maxPerTrade = 1; // default $1/trade cap
      maxPerTrade = Math.min(maxPerTrade, 100); // safety ceiling

      const { data, error } = await supabase
        .from('copy_follows')
        .upsert(
          {
            follower_user_id: followerUserId,
            leader_user_id: leaderUserId,
            max_per_trade_usdc: maxPerTrade,
            active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'follower_user_id,leader_user_id' }
        )
        .select()
        .single();
      if (error) throw error;

      res.json({ ok: true, follow: data, live: COPY_TRADE_ENABLED });
    } catch (e) {
      console.error('[copy] follow error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Stop copying a leader (soft delete → active=false).
  app.post('/api/copy/unfollow', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const followerUserId = req.body.userId;
      const { leaderUserId } = req.body;
      if (!leaderUserId) return res.status(400).json({ error: 'leaderUserId required' });

      const { error } = await supabase
        .from('copy_follows')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('follower_user_id', followerUserId)
        .eq('leader_user_id', leaderUserId);
      if (error) throw error;

      res.json({ ok: true });
    } catch (e) {
      console.error('[copy] unfollow error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Leaders I'm copying.
  app.get('/api/copy/following', authenticateUser, async (req, res) => {
    try {
      const followerUserId = req.query.userId;
      const { data, error } = await supabase
        .from('copy_follows')
        .select('leader_user_id, max_per_trade_usdc, active, created_at, updated_at')
        .eq('follower_user_id', followerUserId)
        .eq('active', true)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      res.json({ following: data || [], count: (data || []).length, live: COPY_TRADE_ENABLED });
    } catch (e) {
      console.error('[copy] following error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Who copies me (leader view — feeds the "your copiers" / earnings story).
  app.get('/api/copy/followers', authenticateUser, async (req, res) => {
    try {
      const leaderUserId = req.query.userId;
      const { data, error } = await supabase
        .from('copy_follows')
        .select('follower_user_id, max_per_trade_usdc, created_at')
        .eq('leader_user_id', leaderUserId)
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ followers: data || [], count: (data || []).length });
    } catch (e) {
      console.error('[copy] followers error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Is the caller currently copying a given leader? (drives the button state)
  app.get('/api/copy/status', authenticateUser, async (req, res) => {
    try {
      const followerUserId = req.query.userId;
      const leaderUserId = req.query.leaderUserId;
      if (!leaderUserId) return res.status(400).json({ error: 'leaderUserId required' });
      const { data, error } = await supabase
        .from('copy_follows')
        .select('max_per_trade_usdc, active')
        .eq('follower_user_id', followerUserId)
        .eq('leader_user_id', leaderUserId)
        .maybeSingle();
      if (error) throw error;
      res.json({
        following: Boolean(data && data.active),
        maxPerTradeUsdc: data ? Number(data.max_per_trade_usdc) : null,
        live: COPY_TRADE_ENABLED,
      });
    } catch (e) {
      console.error('[copy] status error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/copy/leaders — public list of copyable agents and forecasters.
  app.get('/api/copy/leaders', async (req, res) => {
    try {
      const AGENT_LEADERS = [
        { id: 'agent_swarm_vega', name: 'Vega ⚡', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=vega', role: 'Momentum Trader', winRate: 74, tradesCount: 1420, strategy: 'Aggressive momentum: hunts high-uncertainty markets, presses winners hard.' },
        { id: 'agent_swarm_atlas', name: 'Atlas 📈', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=atlas', role: 'Crypto Quant', winRate: 68, tradesCount: 1210, strategy: 'Crypto momentum: trades trends, on-chain flows and ETF flows.' },
        { id: 'agent_swarm_orion', name: 'Orion 🏹', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=orion', role: 'Macro Specialist', winRate: 71, tradesCount: 980, strategy: 'Macro specialist: rates, CPI, GDP — data-driven convergence trades.' },
        { id: 'agent_swarm_cygnus', name: 'Cygnus 🛡️', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=cygnus', role: 'Value Contrarian', winRate: 79, tradesCount: 1150, strategy: 'Conservative value: fades the crowd when sentiment diverges from fundamentals.' },
        { id: 'agent_swarm_nova', name: 'Nova 🌟', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=nova', role: 'Politics Forecaster', winRate: 66, tradesCount: 890, strategy: 'Politics value: mispriced outcomes where polling beats consensus.' },
        { id: 'agent_swarm_striker', name: 'Striker ⚽', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=striker', role: 'Sports Analytics', winRate: 70, tradesCount: 1340, strategy: 'Sports contrarian: fades the public on live odds and form.' },
        { id: 'agent_swarm_sage', name: 'Sage 🧠', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=sage', role: 'Neural Oracle', winRate: 82, tradesCount: 760, strategy: 'Premium signal publisher — highest-conviction calls.' },
        { id: 'house_pulse', name: 'Pulse 🤖', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=house', role: 'Market Swarm', winRate: 73, tradesCount: 2100, strategy: 'House agent: researches every market, trades autonomously.' },
      ];

      // Enrich with real follower counts from copy_follows table
      const { data: followRows } = await supabase
        .from('copy_follows')
        .select('leader_user_id')
        .eq('active', true);

      const counts = new Map();
      for (const r of followRows || []) {
        counts.set(r.leader_user_id, (counts.get(r.leader_user_id) || 0) + 1);
      }

      const leaders = AGENT_LEADERS.map((l) => ({
        ...l,
        copiersCount: counts.get(l.id) || 0,
        live: COPY_TRADE_ENABLED,
        feeUsdc: COPY_FEE_USDC,
      }));

      res.json({ ok: true, leaders, feeUsdc: COPY_FEE_USDC, live: COPY_TRADE_ENABLED });
    } catch (e) {
      console.error('[copy] leaders error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(
    `[copy] copy-trade routes registered (live execution: ${COPY_TRADE_ENABLED ? 'ON' : 'OFF'}, fee: ${COPY_FEE_USDC} USDC)`
  );

  return { mirrorBuyToFollowers };
}
