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
//   GET  /api/invest/me?address=       → investor positions + claimable (public)
//   POST /api/invest/withdraw          → authed payout from treasury
//
// Spec: docs/superpowers/specs/2026-08-02-puls-invest-design.md

import { x402Paywall } from './x402.js';
import { computeAgentPnl } from './agent_pnl.js';

const USDC = '0x3600000000000000000000000000000000000000';
const PERFORMANCE_FEE = 0.20; // platform keeps 20% of profits, sponsors keep 80%
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 1000;

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
  const { supabase, publicClient, walletClient, adminAccount, auth } = deps;
  const treasury = adminAccount?.address || null;

  const fetchRoster = async (req) => {
    try {
      const base = `${req.protocol}://${req.get('host')}`;
      const res = await fetch(`${base}/api/agents/roster`, { signal: AbortSignal.timeout(4000) });
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
      return await computeAgentPnl(supabaseClient);
    } catch (e) {
      console.warn('[invest] pnl compute failed:', e.message);
      return [];
    }
  };

  // Active investments per agent + total per investor.
  const loadInvestments = async (agentId) => {
    const { data, error } = await supabase
      .from('investments')
      .select('id, payment_id, investor_address, amount_usdc, status, created_at')
      .eq('agent_id', agentId)
      .eq('status', 'active');
    if (error) throw error;
    return data || [];
  };

  // ── Public agent cards ────────────────────────────────────────────────────
  app.get('/api/invest/agents', async (req, res) => {
    try {
      const [roster, pnl, cards] = await Promise.all([
        fetchRoster(req),
        fetchPnl(supabase),
        Promise.all(
          AGENTS.map(async (a) => {
            const invs = await loadInvestments(a.id);
            const invested = roundUsdc(invs.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
            return { agent: a, invested };
          })
        ),
      ]);
      const rosterByKey = new Map(roster.map((r) => [r.key, r]));
      const pnlByAgent = new Map(pnl.map((p) => [p.agent, p]));

      res.json({
        ok: true,
        network: 'eip155:5042002',
        asset: USDC,
        payee: treasury,
        performanceFeePct: PERFORMANCE_FEE * 100,
        agents: cards.map(({ agent, invested }) => {
          const r = rosterByKey.get(agent.key);
          const p = pnlByAgent.get(agent.id);
          const balance = Number(r?.balance || 0);
          const pool = roundUsdc(balance + invested);
          const net = p?.net ?? 0;
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
            netUsdc: roundUsdc(net),
            isProfitable: p?.isProfitable ?? false,
            // Honest, labeled estimate: net annualized at 30d against the pool.
            apyEstimatePct: pool > 0 ? roundUsdc(Math.max(0, (net / pool) * 12 * 100)) : 0,
          };
        }),
        updatedAt: new Date().toISOString(),
      });
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
          const pool = roundUsdc(balance + invs.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
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
        const id = `inv_${paymentId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}`;
        const { error } = await supabase
          .from('investments')
          .upsert({
            id,
            payment_id: paymentId,
            investor_address: String(settlement.payer || '').toLowerCase(),
            agent_id: agentId,
            amount_usdc: roundUsdc(settlement.amountUsdc),
            status: 'active',
          }, { onConflict: 'payment_id' });
        if (error) {
          console.error(`[invest] credit failed for ${agentId}:`, error.message);
          throw error;
        }
        console.log(`[invest] credited ${settlement.amountUsdc} USDC → ${agentId} from ${settlement.payer}`);
      },
    }),
    async (req, res) => {
      const agent = AGENT_BY_ID.get(resolveAgentId(req.params.agentId));
      const payer = String(req.x402?.payer || '').toLowerCase();
      const amount = Number(req.x402?.amountUsdc || 0);
      const invs = await loadInvestments(agent.id);
      const roster = await fetchRoster(req);
      const balance = Number(roster.find((r) => r.key === agent.key)?.balance || 0);
      const pool = roundUsdc(balance + invs.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
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

  // ── Withdraw (authed) — treasury sends USDC to the investor ───────────────
  app.post('/api/invest/withdraw', auth || ((_req, _res, next) => next()), async (req, res) => {
    try {
      const { agentId: rawAgentId, address } = req.body || {};
      const agentId = resolveAgentId(rawAgentId);
      if (!agentId) return res.status(400).json({ error: 'Unknown agent' });
      const investor = String(address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(investor)) return res.status(400).json({ error: 'Invalid address' });
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
        const pool = roundUsdc(balance + invs.reduce((s, i) => s + Number(i.amount_usdc || 0), 0));
        const [pnl] = await Promise.all([fetchPnl(supabase)]);
        const net = pnl.find((p) => p.agent === agentId)?.net ?? 0;
        const { claimable } = claimableFor(invested, pool, net);
        if (claimable < 0.000001) return res.status(400).json({ error: 'Nothing claimable yet' });

        // Treasury balance sanity check.
        let treasuryBalance = 0n;
        try {
          treasuryBalance = await publicClient.readContract({
            address: USDC,
            abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
            functionName: 'balanceOf',
            args: [treasury],
          });
        } catch (e) {
          console.warn('[invest] balance check failed:', e.message);
        }
        const claimableMicro = BigInt(Math.round(claimable * 1_000_000));
        if (treasuryBalance < claimableMicro) {
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
