// ── Puls Invest — real USDC sponsorship of AI agents on Arc ──────────────────
//
// Anyone (human or agent) can sponsor a Puls agent with USDC. The investor
// pays via x402/Circle Gateway to the treasury seller wallet; the payment
// settles on Arc and the backend credits a pro-rata share of the agent's
// capital pool. Agent PnL accrues to sponsors (80% to sponsors, 20% platform
// fee on profits, losses shared proportionally). Withdrawal is self-serve:
// the treasury sends USDC back to the investor's address.
//
//   GET  /api/invest/agents            → public agent cards (roster + pnl + pool)
//   GET  /api/invest/:agentId          → x402-paywalled: pay amountUsdc → invest
//   POST /api/invest/:agentId          → authed SCA invest: backend pays from
//                                        the user's Circle SCA wallet (gasless)
//   GET  /api/invest/me?address=       → investor positions + claimable (public)
//   POST /api/invest/withdraw          → authed payout from treasury
//
// Spec: docs/superpowers/specs/2026-08-02-puls-invest-design.md

import { x402Paywall } from './x402.js';
import { computeAgentPnlCached } from './agent_pnl.js';
import * as circleAgent from './circle_agent_wallet.js';
import { encodeFunctionData, keccak256, parseAbiItem, stringToHex, toHex } from 'viem';

const USDC = '0x3600000000000000000000000000000000000000';
const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
const PERFORMANCE_FEE = 0.20; // platform keeps 20% of profits, sponsors keep 80%
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 1000;
// Treasury bootstrap capital per agent (matches AGENT_SWARM_BOOTSTRAP_USDC).
// Counted in the agent's pool so investors share P&L pro-rata over the full
// bankroll (investments + treasury-funded capital), not just their own stake.
const BOOTSTRAP = parseFloat(process.env.AGENT_SWARM_BOOTSTRAP_USDC || '3') || 3;

const usdcTransferAbi = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}];

// Canonical investable agents (ids match creator_user_id used by PnL).
// Balances are enriched live from /api/agents/roster; stats from PnL.
const AGENTS = [
  { id: 'agent_swarm_vega', key: 'vega', name: 'Vega ⚡', glyph: '⚡', role: 'trader',
    strategy: 'Aggressive momentum: hunts high-uncertainty markets, presses winners hard.' },
  { id: 'agent_swarm_cygnus', key: 'cygnus', name: 'Cygnus 🛡️', glyph: '🛡️', role: 'trader',
    strategy: 'Conservative value: fades the crowd when sentiment diverges from fundamentals.' },
  { id: 'agent_swarm_orion', key: 'orion', name: 'Orion 🔭', glyph: '🔭', role: 'trader',
    strategy: 'Macro specialist: rates, CPI, GDP — data-driven convergence trades.' },
  { id: 'agent_swarm_atlas', key: 'atlas', name: 'Atlas 📈', glyph: '📈', role: 'creator',
    strategy: 'Crypto momentum: trades trends, on-chain flows and ETF flows.' },
  { id: 'agent_swarm_nova', key: 'nova', name: 'Nova 🌐', glyph: '🌐', role: 'creator',
    strategy: 'Politics value: mispriced outcomes where polling beats consensus.' },
  { id: 'agent_swarm_striker', key: 'striker', name: 'Striker ⚽', glyph: '⚽', role: 'creator',
    strategy: 'Sports contrarian: fades the public on live odds and form.' },
  { id: 'agent_sage', key: 'sage', name: 'Sage 🔮', glyph: '🔮', role: 'creator',
    strategy: 'Premium signal publisher — highest-conviction calls.' },
  { id: 'house_pulse', key: 'pulse', name: 'Pulse 🤖', glyph: '🤖', role: 'house',
    strategy: 'House agent: researches every market, trades autonomously.' },
];
const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
const AGENT_BY_KEY = new Map(AGENTS.map((a) => [a.key, a]));
const AGENT_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));

// Accept either the full creator id ('agent_swarm_striker') or the short key
// ('striker') in the URL — friendlier for humans and the Circle CLI.
const resolveAgentId = (param) => {
  if (!param) return null;
  if (AGENT_BY_ID.has(param)) return param;
  return AGENT_BY_KEY.get(param)?.id || null;
};

const roundUsdc = (v) => Math.round((Number(v) || 0) * 1_000_000) / 1_000_000;

// ── Shared claimable math (used by /me and /withdraw) ──────────────────────
// claimable = invested + pro-rata share of agent net, 20% fee on positive
// share; losses reduce principal proportionally (no fee on losses).
function claimableFor(invested, pool, agentNet) {
  if (invested <= 0) return { share: 0, fee: 0, claimable: 0, netShare: 0 };
  const poolSafe = pool > 0 ? pool : invested;
  const share = invested / poolSafe;
  const netShare = roundUsdc(share * agentNet);
  if (netShare >= 0) {
    const fee = roundUsdc(netShare * PERFORMANCE_FEE);
    return { share, netShare, fee, claimable: roundUsdc(invested + netShare - fee) };
  }
  return { share, netShare, fee: 0, claimable: Math.max(0, roundUsdc(invested + netShare)) };
}

// In-process per (investor,agent) lock so concurrent withdraws can't
// double-pay a claimable balance. Volume is tiny on testnet.
const withdrawLocks = new Map();

export function registerInvest(app, deps) {
  const {
    supabase, publicClient, walletClient, adminAccount, auth,
    circle, getWalletId, getWalletInfo, authenticateUser, requireVerifiedUser, strictLimiter,
  } = deps;
  const treasury = adminAccount?.address || null;

  const fetchRoster = async (req) => {
    try {
      const host = req.get('host') || '127.0.0.1';
      const base = `${req.protocol || 'http'}://${host}`;
      const res = await fetch(`${base}/api/agents/roster`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        return data.agents || [];
      }
    } catch (e) {
      console.warn('[invest] roster fetch failed:', e.message);
    }
    return [];
  };

  const fetchPnl = async (supabaseClient) => {
    try {
      return await computeAgentPnlCached(supabaseClient, 30_000);
    } catch (e) {
      console.warn('[invest] pnl compute failed:', e.message);
      return [];
    }
  };

  // Active investments per agent + total per investor.
  const loadInvestments = async (agentId) => {
    const { data, error } = await supabase
      .from('investments')
      .select('id, payment_id, investor_address, amount_usdc, status, funded, created_at')
      .eq('agent_id', agentId)
      .eq('status', 'active');
    if (error) throw error;
    return data || [];
  };

  // Invested amounts that have NOT been physically transferred to the agent
  // wallet yet (funded=false). These still count toward the pool (the treasury
  // holds the money) until the transfer lands; once funded they live in the
  // agent's on-chain balance, so they must not be double-counted.
  const unfundedSum = (invs) =>
    invs.filter((i) => !i.funded).reduce((s, i) => s + Number(i.amount_usdc || 0), 0);

  // Full capital at work for an agent: live wallet balance (includes any
  // funded investments + trading P&L) + unfunded investments + treasury
  // bootstrap. Investors share P&L pro-rata over this whole bankroll.
  const poolFor = (balance, invs) => roundUsdc(balance + unfundedSum(invs) + BOOTSTRAP);

  // Resolve an agent's on-chain wallet address (same store the swarm uses).
  const agentWalletAddress = async (agentId) => {
    const walletId = await getWalletId(agentId);
    if (!walletId) return null;
    const info = await getWalletInfo(walletId);
    return info?.address || null;
  };

  // Physically move invested USDC from the treasury into the agent's wallet
  // with an on-chain memo (invest:<agent>) so the capital actually trades.
  // Falls back to a plain transfer; returns false if it can't be done.
  const transferToAgent = async (agentId, amountUsdc) => {
    const address = await agentWalletAddress(agentId);
    if (!address || !walletClient || !adminAccount) return false;
    const micro = BigInt(Math.round(amountUsdc * 1_000_000));
    if (micro <= 0n) return false;
    try {
      const innerData = encodeFunctionData({
        abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
        functionName: 'transfer', args: [address, micro],
      });
      await walletClient.writeContract({
        address: MEMO_CONTRACT,
        abi: [{ name: 'memo', type: 'function', stateMutability: 'nonpayable', inputs: [
          { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
          { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }], outputs: [] }],
        functionName: 'memo',
        args: [USDC, innerData, keccak256(toHex(`invest:${agentId}`)),
          stringToHex(JSON.stringify({ kind: 'invest', agent: agentId, usdc: amountUsdc }))],
      });
    } catch (e) {
      try {
        await walletClient.writeContract({
          address: USDC, abi: usdcTransferAbi, functionName: 'transfer', args: [address, micro],
        });
      } catch (e2) {
        console.warn(`[invest] fund transfer failed for ${agentId}:`, e2.message);
        return false;
      }
    }
    console.log(`[invest] funded ${amountUsdc} USDC → ${agentId} wallet ${address}`);
    return true;
  };

  // Credit + move the money. Returns true when the on-chain transfer landed.
  const creditInvestment = async ({ agentId, investor, amountUsdc, paymentId }) => {
    const id = `inv_${String(paymentId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;
    const { error } = await supabase
      .from('investments')
      .upsert({
        id, payment_id: paymentId,
        investor_address: String(investor || '').toLowerCase(),
        agent_id: agentId, amount_usdc: roundUsdc(amountUsdc), status: 'active',
      }, { onConflict: 'payment_id' });
    if (error) throw error;
    const funded = await transferToAgent(agentId, roundUsdc(amountUsdc));
    if (funded) {
      try {
        await supabase.from('investments').update({ funded: true }).eq('id', id);
      } catch (e) {
        console.warn(`[invest] funded flag update failed for ${id}:`, e.message);
      }
    }
    console.log(`[invest] credited ${amountUsdc} USDC → ${agentId} from ${investor}${funded ? ' (funded on-chain)' : ' (treasury-held)'}`);
  };

  // ── Public agent cards ────────────────────────────────────────────────────
  // Whole-response cache: cards combine live roster balances (Circle API),
  // PnL aggregation and per-agent investment queries. Recomputing all of it on
  // every request took ~2s; 30s of staleness is invisible for cards.
  const agentsCache = { at: 0, data: null };
  const AGENTS_CACHE_TTL = 30_000;

  app.get('/api/invest/agents', async (req, res) => {
    try {
      const now = Date.now();
      if (agentsCache.data && now - agentsCache.at < AGENTS_CACHE_TTL) {
        return res.json(agentsCache.data);
      }
      const [roster, pnl, cards] = await Promise.all([
        fetchRoster(req),
        fetchPnl(supabase),
        Promise.all(
          AGENTS.map(async (a) => {
            const invs = await loadInvestments(a.id);
            const invested = roundUsdc(invs.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
            return { agent: a, invs, invested };
          })
        ),
      ]);
      const rosterByKey = new Map(roster.map((r) => [r.key, r]));
      const pnlByAgent = new Map(pnl.map((p) => [p.agent, p]));

      const payload = {
        ok: true,
        network: 'eip155:5042002',
        asset: USDC,
        payee: treasury,
        performanceFeePct: PERFORMANCE_FEE * 100,
        agents: cards.map(({ agent, invs, invested }) => {
          const r = rosterByKey.get(agent.key);
          const p = pnlByAgent.get(agent.id);
          const balance = Number(r?.balance || 0);
          const pool = poolFor(balance, invs);
          const net = p?.net ?? 0;
          const net30 = p?.net30 ?? net;
          // Trailing-30d annualized estimate — never lifetime (a lifetime figure
          // annualized would be mathematically meaningless). Capped here at ±999
          // so a tiny pool or fresh window can't produce absurd percentages.
          const apy = pool > 0 ? roundUsdc((net30 / pool) * 12 * 100) : 0;
          return {
            id: agent.id,
            key: agent.key,
            name: agent.name,
            glyph: agent.glyph,
            role: agent.role,
            strategy: agent.strategy,
            address: r?.address || null,
            balance,
            invested,
            pool,
            tvlUsdc: pool,
            // Realized PnL (all-time) — the headline number, settlement payouts
            // included (same on-chain semantics as /versus).
            realizedPnlUsdc: roundUsdc(net),
            pnl30dUsdc: roundUsdc(net30),
            roi30dPct: pool > 0 ? roundUsdc((net30 / pool) * 100) : 0,
            netUsdc: roundUsdc(net),
            isProfitable: p?.isProfitable ?? false,
            winRatePct: p?.winRate ?? 0,
            tradesCount: p?.tradesCount ?? 0,
            volumeUsdc: p?.volume ?? 0,
            resolvedCount: p?.resolvedCount ?? 0,
            winsCount: p?.winsCount ?? 0,
            apyEstimatePct: Math.max(-999, Math.min(999, apy)),
          };
        }),
        updatedAt: new Date().toISOString(),
      };
      agentsCache.data = payload;
      agentsCache.at = now;
      res.json(payload);
    } catch (e) {
      console.error('[invest] /agents error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Investor positions (public read) — registered BEFORE /:agentId so the
  // literal path wins over the paywalled param route. ────────────────────────
  app.get('/api/invest/me', async (req, res) => {
    try {
      const address = String(req.query.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return res.status(400).json({ error: 'Invalid address' });
      }
      const pnl = await fetchPnl(supabase);
      const roster = await fetchRoster(req);
      const rosterByKey = new Map(roster.map((r) => [r.key, r]));
      const cards = await Promise.all(
        AGENTS.map(async (a) => {
          const invs = await loadInvestments(a.id);
          const mine = invs.filter((i) => i.investor_address === address);
          if (!mine.length) return null;
          const invested = roundUsdc(mine.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
          const balance = Number(rosterByKey.get(a.key)?.balance || 0);
          const pool = poolFor(balance, invs);
          const net = pnl.find((p) => p.agent === a.id)?.net ?? 0;
          return {
            agentId: a.id,
            agentName: a.name,
            glyph: a.glyph,
            role: a.role,
            invested,
            pool,
            ...claimableFor(invested, pool, net),
            investments: mine.map((i) => ({
              id: i.id,
              amountUsdc: Number(i.amount_usdc),
              status: i.status,
              createdAt: i.created_at,
            })),
          };
        })
      );
      const positions = cards.filter(Boolean);
      res.json({
        ok: true,
        address,
        performanceFeePct: PERFORMANCE_FEE * 100,
        totalInvested: roundUsdc(positions.reduce((s, p) => s + p.invested, 0)),
        totalClaimable: roundUsdc(positions.reduce((s, p) => s + p.claimable, 0)),
        positions,
      });
    } catch (e) {
      console.error('[invest] /me error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Paywalled invest endpoint ─────────────────────────────────────────────
  // GET /api/invest/:agentId?amountUsdc=5 → 402 with payment requirements;
  // with a valid payment-signature → settles, credits the investment, returns
  // the agent card + the investor's position.
  app.get(
    '/api/invest/:agentId',
    x402Paywall(null, '', {
      endpointFn: (req) => `/api/invest/${req.params.agentId}`,
      priceFn: (req) => {
        const agentId = resolveAgentId(req.params.agentId);
        if (!agentId) {
          req.x402PriceError = `Unknown agent '${req.params.agentId}'`;
          return null;
        }
        const amount = Number(req.query.amountUsdc);
        if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
          req.x402PriceError = `amountUsdc must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}`;
          return null;
        }
        if (Math.round(amount * 100) !== Math.round(Number(amount.toFixed(2)) * 100)) {
          req.x402PriceError = 'amountUsdc supports at most 2 decimals';
          return null;
        }
        return `$${amount.toFixed(2)}`;
      },
      payTo: () => treasury || undefined,
      description: 'Sponsor an AI agent with USDC — pro-rata share of the capital pool',
      onSettled: async (settlement) => {
        const m = /^\/api\/invest\/([^/?]+)$/.exec(settlement.endpoint);
        const agentId = m ? resolveAgentId(m[1]) : null;
        if (!agentId) return;
        // payment_id: the x402_payments row id isn't known here (insert is
        // fire-and-forget in x402.js) — derive a stable id from the gateway tx.
        const paymentId = settlement.transaction || `${agentId}:${settlement.payer}:${settlement.amountUsdc}`;
        await creditInvestment({
          agentId,
          investor: settlement.payer,
          amountUsdc: settlement.amountUsdc,
          paymentId,
        });
      },
    }),
    async (req, res) => {
      const agent = AGENT_BY_ID.get(resolveAgentId(req.params.agentId));
      const payer = String(req.x402?.payer || '').toLowerCase();
      const amount = Number(req.x402?.amountUsdc || 0);
      const invs = await loadInvestments(agent.id);
      const roster = await fetchRoster(req);
      const balance = Number(roster.find((r) => r.key === agent.key)?.balance || 0);
      const pool = poolFor(balance, invs);
      const mine = invs.filter((i) => i.investor_address === payer);
      res.json({
        ok: true,
        agent: { id: agent.id, name: agent.name, glyph: agent.glyph, role: agent.role },
        invested: roundUsdc(mine.reduce((s, i) => s + Number(i.amount_usdc || 0), 0)),
        pool,
        payment: req.x402,
        note: `Investment settled. Share accrues pro-rata from ${agent.name}'s PnL (80/20 split).`,
      });
    }
  );

  // ── SCA invest (authed) — backend pays from the user's Circle SCA wallet ──
  // Same protocol as the x402 path (payment lands in the treasury, the
  // investment is credited pro-rata) but the backend signs from the user's
  // gasless SCA wallet — no MetaMask, no Gateway deposit needed.
  app.post('/api/invest/:agentId', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const agentId = resolveAgentId(req.params.agentId);
      if (!agentId) return res.status(400).json({ error: `Unknown agent '${req.params.agentId}'` });
      const amount = Number(req.body.amountUsdc);
      if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
        return res.status(400).json({ error: `amountUsdc must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}` });
      }
      if (Math.round(amount * 100) !== Math.round(Number(amount.toFixed(2)) * 100)) {
        return res.status(400).json({ error: 'amountUsdc supports at most 2 decimals' });
      }
      if (!circle) return res.status(503).json({ error: 'SCA payments not configured' });
      if (!treasury) return res.status(503).json({ error: 'Treasury not configured' });

      const userId = req.body.userId; // forced to verified id by authenticateUser

      // ── Circle Agent Stack deposit ─────────────────────────────────────────
      // The depositor IS an autonomous agent whose funds live in a Circle Agent
      // Wallet (no dev-controlled SCA exists). A deposit is a plain USDC
      // transfer to the same treasury payee, executed through the Circle CLI.
      const awKey = userId ? circleAgent.isEnabledForUser(userId) : null;
      if (awKey) {
        const awAddress = circleAgent.addressFor(awKey);
        if (!awAddress) {
          return res.status(400).json({ error: `CIRCLE_AGENT_WALLET_ADDRESS_${awKey.toUpperCase()} is not set` });
        }
        const balance = await circleAgent.usdcBalance(awAddress).catch(() => 0);
        if (balance < amount) {
          return res.status(402).json({
            error: `Insufficient USDC balance (${balance.toFixed(2)} available)`,
            balanceUsdc: balance,
          });
        }
        const amountMicro = Math.round(amount * 1_000_000).toString();
        const r = await circleAgent.executeContract({
          signature: 'transfer(address,uint256)',
          params: [treasury, amountMicro],
          contract: USDC,
          address: awAddress,
        });
        const investor = String(awAddress).toLowerCase();
        const txId = r.txHash || r.id || null;
        try {
          await creditInvestment({ agentId, investor, amountUsdc: amount, paymentId: txId });
        } catch (e) {
          console.error(`[invest] agent-wallet credit failed for ${agentId}:`, e.message);
          return res.status(500).json({ error: 'Payment sent but investment failed to record' });
        }
        console.log(`[invest] agent-wallet ${amount} USDC → ${agentId} from ${investor} (${txId})`);
        const invsAw = await loadInvestments(agentId);
        const mineAw = invsAw.filter((i) => i.investor_address === investor);
        return res.json({
          ok: true,
          agent: (() => { const a = AGENT_BY_ID.get(agentId); return { id: a.id, name: a.name, glyph: a.glyph, role: a.role }; })(),
          invested: roundUsdc(mineAw.reduce((s, i) => s + Number(i.amount_usdc || 0), 0)),
          payment: { paymentId: txId, amountUsdc: roundUsdc(amount), from: investor, to: treasury, method: 'agent-wallet' },
          note: `Investment settled. Share accrues pro-rata from ${AGENT_BY_ID.get(agentId)?.name || agentId}'s PnL (80/20 split).`,
        });
      }

      const walletId = userId ? await getWalletId(userId) : null;
      if (!walletId) return res.status(400).json({ error: 'No wallet for user' });
      const info = await getWalletInfo(walletId);
      const investor = String(info.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(investor)) {
        return res.status(500).json({ error: 'Wallet address unavailable' });
      }
      const balance = parseFloat(info.usdcBalance || '0');
      if (balance < amount) {
        return res.status(402).json({
          error: `Insufficient USDC balance (${balance.toFixed(2)} available)`,
          balanceUsdc: balance,
        });
      }

      const amountMicro = Math.round(amount * 1_000_000).toString();
      const txRes = await circle.createContractExecutionTransaction({
        walletId,
        contractAddress: USDC,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [treasury, amountMicro],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      const txId = txRes.data?.id || null;
      if (!txId) return res.status(502).json({ error: 'Payment failed, please try again' });

      try {
        await creditInvestment({
          agentId, investor, amountUsdc: amount, paymentId: txId,
        });
      } catch (e) {
        console.error(`[invest] sca credit failed for ${agentId}:`, e.message);
        return res.status(500).json({ error: 'Payment sent but investment failed to record' });
      }
      console.log(`[invest] sca ${amount} USDC → ${agentId} from ${investor} (${txId})`);

      const agent = AGENT_BY_ID.get(agentId);
      const invs = await loadInvestments(agentId);
      const roster = await fetchRoster(req);
      const agentBalance = Number(roster.find((r) => r.key === agent.key)?.balance || 0);
      const pool = poolFor(agentBalance, invs);
      const mine = invs.filter((i) => i.investor_address === investor);
      res.json({
        ok: true,
        agent: { id: agent.id, name: agent.name, glyph: agent.glyph, role: agent.role },
        invested: roundUsdc(mine.reduce((s, i) => s + Number(i.amount_usdc || 0), 0)),
        pool,
        payment: { paymentId: txId, amountUsdc: roundUsdc(amount), from: investor, to: treasury, method: 'sca' },
        note: `Investment settled. Share accrues pro-rata from ${agent.name}'s PnL (80/20 split).`,
      });
    } catch (e) {
      console.error('[invest] sca invest error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Withdraw (authed) — treasury sends USDC to the investor ───────────────
  // Two auth paths: (1) a wallet EIP-191 signature in the body (web — the
  // signer must be the investor), or (2) the existing apiKeyOrAuth middleware
  // for API-key clients.
  const sigOrApiAuth = async (req, res, next) => {
    if (req.body?.signature) return next();
    return auth ? auth(req, res, next) : next();
  };
  app.post('/api/invest/withdraw', sigOrApiAuth, async (req, res) => {
    try {
      const { agentId: rawAgentId, address, signature } = req.body || {};
      const agentId = resolveAgentId(rawAgentId);
      if (!agentId) return res.status(400).json({ error: 'Unknown agent' });
      const investor = String(address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(investor)) return res.status(400).json({ error: 'Invalid address' });
      // SCA path (no signature): bind the payout address to the caller's
      // wallet so an API-key holder can't withdraw on behalf of another user.
      if (!signature && req.body.userId) {
        const wId = await getWalletId(req.body.userId);
        const wInfo = wId ? await getWalletInfo(wId) : null;
        if (wInfo?.address && wInfo.address.toLowerCase() !== investor) {
          return res.status(403).json({ error: 'Address does not match your wallet' });
        }
      }
      if (signature) {
        if (!publicClient) return res.status(503).json({ error: 'Wallet verification unavailable' });
        const message = `puls-invest:withdraw:${agentId}`;
        const valid = await publicClient.verifyMessage({ address: investor, message, signature });
        if (!valid) return res.status(401).json({ error: 'Signature does not match the investor address' });
      }
      if (!walletClient || !treasury) return res.status(503).json({ error: 'Treasury signer not configured' });

      const lockKey = `${investor}:${agentId}`;
      const prev = withdrawLocks.get(lockKey) || Promise.resolve();
      let release;
      const lock = new Promise((r) => (release = r));
      withdrawLocks.set(lockKey, prev.then(() => lock));
      await prev;
      try {
        const invs = await loadInvestments(agentId);
        const mine = invs.filter((i) => i.investor_address === investor);
        if (!mine.length) return res.status(400).json({ error: 'No active investments for this agent' });

        const invested = roundUsdc(mine.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
        const roster = await fetchRoster(req);
        const balance = Number(roster.find((r) => r.key === AGENT_BY_ID.get(agentId)?.key)?.balance || 0);
        const pool = poolFor(balance, invs);
        const [pnl] = await Promise.all([fetchPnl(supabase)]);
        const net = pnl.find((p) => p.agent === agentId)?.net ?? 0;
        const { claimable } = claimableFor(invested, pool, net);
        if (claimable < 0.000001) return res.status(400).json({ error: 'Nothing claimable yet' });

        // Treasury balance sanity check (best-effort — RPC hiccups must not
        // block a legitimate payout; a truly empty treasury fails on-chain).
        let treasuryBalance = null;
        try {
          treasuryBalance = await publicClient.readContract({
            address: USDC,
            abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
            functionName: 'balanceOf',
            args: [treasury],
          });
        } catch (e) {
          console.warn('[invest] balance check failed, skipping:', e.message);
        }
        const claimableMicro = BigInt(Math.round(claimable * 1_000_000));
        if (treasuryBalance !== null && treasuryBalance < claimableMicro) {
          return res.status(400).json({ error: 'Treasury balance too low for payout', balanceUsdc: Number(treasuryBalance) / 1e6 });
        }

        const hash = await walletClient.writeContract({
          address: USDC,
          abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
          functionName: 'transfer',
          args: [investor, claimableMicro],
        });

        // Record payout + mark investments withdrawn.
        const payoutId = `pay_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const { error: pErr } = await supabase
          .from('invest_payouts')
          .insert({ id: payoutId, investor_address: investor, amount_usdc: claimable, tx_hash: hash });
        if (pErr) console.warn('[invest] payout insert failed:', pErr.message);

        for (const i of mine) {
          await supabase.from('investments').update({ status: 'withdrawn' }).eq('id', i.id);
        }

        console.log(`[invest] withdrew ${claimable} USDC → ${investor} (${agentId}) tx ${hash}`);
        res.json({ ok: true, agentId, investor, amountUsdc: claimable, txHash: hash, claimableAfter: 0 });
      } finally {
        release();
        withdrawLocks.delete(lockKey);
      }
    } catch (e) {
      console.error('[invest] withdraw error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[invest] /api/invest registered (${AGENTS.length} agents, payee ${treasury || 'unset'})`);
}

export { AGENTS, AGENT_NAME, claimableFor };
