/**
 * Agent Swarm — a colony of autonomous AI actors that LIVE inside Pulsmarket.
 *
 * Each agent has its own persona, LLM "brain" (a preferred model in the failover
 * pool), Circle MPC wallet and ERC-8004 on-chain identity. They are full economic
 * actors, just like humans:
 *   • TRADERS research the open web (vision) + on-chain mispricings, may BUY a
 *     peer's Signal (agent→agent x402 USDC), reason with their persona, then
 *     trade a prediction on Arc — or skip with a visible reason.
 *   • CREATORS publish on-chain-attested Signals (SignalRegistry) on rotating
 *     market questions and EARN USDC when other agents buy them.
 *   • Every agent EVALUATES peers' signals with its LLM and COMMENTS publicly —
 *     "accurate, buying ✅" (and pays for it) or "flawed, skipping ❌" (with a
 *     reason) — and comments on markets it trades.
 *
 * This powers an AI-vs-Humans battle: agents and humans trade the same markets,
 * and /api/agents/roster + /api/agents/battle expose who's winning.
 *
 * Additive + env-gated (AGENT_SWARM=true). Reuses the existing Pulse/Sage plumbing
 * passed in via `deps` — it does NOT touch house_pulse / agent_sage.
 */

// ──────────────────────────────────────────────────────────────────────────────
// additive + env-gated (AGENT_SWARM=true). Reuses the existing Pulse/Sage plumbing
// passed in via `deps` — it does NOT touch house_pulse / agent_sage.
// ──────────────────────────────────────────────────────────────────────────────

import { fetchCryptoPrices, extractCryptoSymbols } from './crypto_oracle.js';
import { evaluateAndBuyData, formatGatewayDataForPrompt } from './puls_gateway.js';
import { eventBus, EVENTS } from './events.js';
import { cache } from './cache.js';
import { fetchGamma } from './polymarket_client.js';
import { retrieveContext, indexDecision } from './opensearch.js';

// Default roster. Override per-agent model via env AGENT_SWARM_MODEL_<KEY>.
// `brain` is a substring matched against the LLM pool model ids (prefer-first,
// still falls back through the whole pool). Personas drive distinct behavior.
// `strategy` is surfaced in the LLM prompt + /api/agents/roster for judges.
const DEFAULT_ROSTER = [
  // ── Trader agents (distinct strategies + brains) ──
  {
    key: 'vega', name: 'Vega ⚡', role: 'trader', brain: 'gpt-oss',
    category: null, minEdge: 0.03, riskMult: 1.4,
    strategy: 'VOLATILITY: Hunt high-uncertainty markets where the crowd is split. Look for edges in volatile, fast-moving markets where momentum is shifting. Back the side the data supports, not the crowd.',
    persona: 'an aggressive momentum trader who hunts the biggest mispricings and presses winners hard. Bold, fast, concise.',
  },
  {
    key: 'cygnus', name: 'Cygnus 🛡️', role: 'trader', brain: 'mistral',
    category: null, minEdge: 0.07, riskMult: 0.6,
    strategy: 'SENTIMENT: Read social signals and news sentiment. Fade the crowd when sentiment diverges from fundamentals. Conservative sizing, high conviction only.',
    persona: 'a conservative value trader who only acts on high-conviction, large edges and sizes small. Skeptical, disciplined.',
  },
  {
    key: 'orion', name: 'Orion 🔭', role: 'trader', brain: 'deepseek',
    category: null, minEdge: 0.05, riskMult: 1.0,
    strategy: 'MACRO: Focus on macro-economic markets (fed rates, CPI, GDP). Use economic data releases, central bank signals, and leading indicators. Data-driven, not sentiment-driven.',
    persona: 'a balanced quant who weighs web sentiment against on-chain price gaps and explains the convergence trade clearly.',
  },
  // ── Creator agents (publish signals, earn from buyers) ──
  {
    key: 'atlas', name: 'Atlas 📈', role: 'creator', brain: 'gemini',
    category: 'crypto', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    strategy: 'CRYPTO MOMENTUM: Trade only crypto markets. Follow price trends, on-chain flows, ETF inflows, and exchange reserves. Momentum-following — ride the trend until it breaks.',
    persona: 'a crypto/macro forecaster who publishes sharp, falsifiable signals with clear invalidation levels.',
  },
  {
    key: 'nova', name: 'Nova 🌐', role: 'creator', brain: 'mistral',
    category: 'politics', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    strategy: 'POLITICS VALUE: Trade only political markets. Look for mispriced outcomes where polling data, historical patterns, or structural advantages diverge from market consensus. Value-oriented.',
    persona: 'a world-events analyst who turns live news into calibrated probability calls.',
  },
  {
    key: 'striker', name: 'Striker ⚽', role: 'creator', brain: 'gemini',
    category: 'football', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    strategy: 'SPORTS CONTRARIAN: Trade only sports markets. Go AGAINST the crowd when public sentiment overvalues popular teams. Use form data, injuries, and tactical matchups. Contrarian approach — fade the public.',
    persona: 'a premier sports & football analyst who turns live Polymarket odds, team form, and tactical matchups into sharp, falsifiable calls with clear invalidation — and backs his own calls with small trades.',
  },
];

export function buildSwarmRoster() {
  const enabled = String(process.env.AGENT_SWARM ?? 'true').toLowerCase() !== 'false';
  if (!enabled) return [];
  // Optional allow-list: AGENT_SWARM_KEYS=vega,cygnus,atlas
  const only = (process.env.AGENT_SWARM_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  let roster = DEFAULT_ROSTER.slice();
  if (only.length) roster = roster.filter(a => only.includes(a.key));
  for (const a of roster) {
    const m = (process.env[`AGENT_SWARM_MODEL_${a.key.toUpperCase()}`] || '').trim();
    if (m) a.brain = m;
    a.user = `agent_swarm_${a.key}`;        // profiles/trades/notifications user id
    a.walletKey = `agent_${a.user}`;        // wallets row key (matches existing convention)
  }
  return roster;
}

  // Per-agent in-memory risk + identity state.
  const state = new Map(); // key -> { streak, spentToday, dayKey, registered, signalId, onchainTx, busy, ensured }
  // Wallet creation lock: prevents concurrent ensureAgent calls from creating
  // duplicate wallets for the same agent. WITHOUT this, two events firing
  // simultaneously both call getWalletId → both get null → both create new
  // wallets → saveWallet upsert overwrites with the last one → agent address
  // changes on every restart.
  const _walletCreating = new Set();
  // Bootstrap funding lock: prevents concurrent ensureAgent calls from
  // double-funding the same agent. Without this, two events firing
  // simultaneously both see balance < target and both submit funding txs.
  const _funding = new Set();
  function st(key) {
  if (!state.has(key)) state.set(key, { streak: 0, spentToday: 0, dayKey: '', registered: false, signalId: null, onchainTx: null, busy: false, ensured: false });
  return state.get(key);
}
const _todayKey = () => new Date().toISOString().slice(0, 10);

// ───────────────────────────────────────────────────────────────────────────
// Wire-up: server.js calls registerSwarm(app, deps) once. `deps` carries the
// shared helpers/clients so we never re-implement Circle/viem/Supabase logic.
// ───────────────────────────────────────────────────────────────────────────
export function registerSwarm(app, deps) {
  const {
    supabase, circle, walletClient, publicClient, adminAccount,
    getWalletId, saveWallet, getWalletInfo, ensureWalletSet, WALLET_ACCOUNT_TYPE,
    USDC, IDENTITY_REGISTRY, AGENT_METADATA_URI, SIGNAL_REGISTRY_ADDRESS,
    resolveAgentTokenId, recordAgentReputation, agentTokenIds, agentHasIdentity,
    getTreasuryUsdcBalance, houseAgentResearch, executeAgentTrade,
    researchQuestion, llmComplete, parseLlmJson, formatForApp,
    keccak256, toHex, encodeFunctionData, parseAbiItem, stringToHex,
    blog,
    getOrDeployMarket,
    deployedMarketsCache,
  } = deps;

  // Arc predeployed Memo contract — wraps a call and emits on-chain metadata
  // (memoId + memo bytes) while preserving the original sender for the inner
  // call. Lets every agent USDC payment carry an on-chain, indexable reason.
  const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
  const MEMO_ENABLED = (process.env.AGENT_MEMO || 'true') === 'true' && encodeFunctionData && parseAbiItem && stringToHex;

  // Transfer USDC from a Circle SCA agent wallet, wrapped in an Arc memo so the
  // payment reason (e.g. "signal:<id>") is attested on-chain. Falls back to a
  // plain transfer if memo is unavailable/reverts — the payment never breaks.
  async function usdcTransferWithMemo(walletId, toAddr, amountMicro, memoKey, memoObj) {
    // Normalize toAddr: some callers pass a viem Account object (which has
    // .address), others pass a string. Always extract the string.
    if (toAddr && typeof toAddr === 'object' && toAddr.address) toAddr = toAddr.address;
    if (typeof toAddr !== 'string') {
      console.warn(`[swarm] usdcTransferWithMemo: invalid toAddr type ${typeof toAddr}, skipping memo`);
      // Fall through to plain transfer with a dummy address — but this should
      // never happen after the fix above.
    }
    if (MEMO_ENABLED && typeof toAddr === 'string') {
      try {
        const innerData = encodeFunctionData({
          abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
          functionName: 'transfer', args: [toAddr, BigInt(amountMicro)],
        });
        const memoId = keccak256(toHex(String(memoKey)));
        const memoData = stringToHex(JSON.stringify(memoObj).slice(0, 400));
        const res = await circle.createContractExecutionTransaction({
          walletId, contractAddress: MEMO_CONTRACT,
          abiFunctionSignature: 'memo(address,bytes,bytes32,bytes)',
          abiParameters: [USDC, innerData, memoId, memoData],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        return { txId: res.data?.id || null, memo: true };
      } catch (e) {
        console.warn(`[swarm] memo transfer fell back to plain: ${e.message}`);
      }
    }
    const res = await circle.createContractExecutionTransaction({
      walletId, contractAddress: USDC,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [toAddr, String(amountMicro)],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    return { txId: res.data?.id || null, memo: false };
  }

  const ROSTER = buildSwarmRoster();
  const MAX_TRADE = parseFloat(process.env.AGENT_SWARM_MAX_TRADE || '0.4');
  const DAILY_CAP = parseFloat(process.env.AGENT_SWARM_DAILY_CAP || '1000');
  // Creators put real USDC behind their OWN published call (skin in the game).
  const CREATOR_TRADES = (process.env.AGENT_SWARM_CREATOR_TRADES || 'true') !== 'false';
  // Agents proactively DM active users to pitch their fresh signal/blog/trade —
  // shows liveliness. CHEAP: one templated message per event (NO per-user LLM),
  // fanned out to a capped set of recently-active users, rate-limited per user.
  const DM_ENABLED = (process.env.AGENT_SWARM_DM || 'true') !== 'false';
  const DM_PER_EVENT = parseInt(process.env.AGENT_SWARM_DM_PER_EVENT || '6', 10);
  const DM_COOLDOWN_H = parseFloat(process.env.AGENT_SWARM_DM_COOLDOWN_H || '5');
  const INTERVAL_MIN = Math.max(1, parseInt(process.env.AGENT_SWARM_INTERVAL_MIN || '10', 10)); // SLOW MODE

  const X402_RESEARCH_COST_MICRO = 100; // 0.0001 USDC
  async function x402Research(cfg, question, limit = 3) {
    try {
      if (cfg && cfg.walletKey && adminAccount) {
        const walletId = await getWalletId(cfg.walletKey);
        if (walletId) {
          const { txId } = await usdcTransferWithMemo(walletId, adminAccount.address, X402_RESEARCH_COST_MICRO, 'x402:research', { query: question.slice(0, 50) });
          console.log(`\n🟢 [RECEIPT] x402 NANOPAYMENT CLEARED · settled on Arc
┌──────────────────────────────────────────────────────┐
│  $0.0001 USDC                                        │
│  from Agent ${cfg.name} (${cfg.role})
│    to Puls Data Faucet (Tavily/CMC Bridge)           │
└──────────────────────────────────────────────────────┘
▸ Data unlocked: Web Search & Oracle Prices
⛓ https://testnet.arcscan.app/tx/${txId || 'pending...'}\n`);
        }
      }
    } catch (e) {}
    return await researchQuestion(question, limit);
  }

  const ALPHA_PRICE = parseFloat(process.env.AGENT_SWARM_ALPHA_PRICE || '0.001') || 0.001;
  const BOOTSTRAP_USDC = parseFloat(process.env.AGENT_SWARM_BOOTSTRAP_USDC || '500');

  if (ROSTER.length === 0) {
    console.log('[swarm] disabled — serving historical agent data (set AGENT_SWARM=true to enable live trading)');
    // Even when the swarm is disabled, serve HISTORICAL agent decisions from
    // the notifications table so the UI doesn't look empty. Agents that ran
    // before have real decision history (trades, signals, comments) that's
    // valuable to show.
    const STATIC_ROSTER = DEFAULT_ROSTER.map(a => ({ ...a, user: `agent_swarm_${a.key}`, walletKey: `agent_agent_swarm_${a.key}` }));
    const STATIC_BY_USER = Object.fromEntries(STATIC_ROSTER.map(c => [c.user, c]));
    let _histFeedCache = { data: null, ts: 0 };
    let _histRosterCache = { data: null, ts: 0 };

    app.get('/api/agents/roster', async (req, res) => {
      try {
        if (_histRosterCache.data && Date.now() - _histRosterCache.ts < 20000) return res.json(_histRosterCache.data);
        const userIds = STATIC_ROSTER.map(c => c.user);
        const agents = await Promise.all(STATIC_ROSTER.map(async (cfg) => {
          const { data: rows } = await supabase
            .from('notifications').select('message, created_at')
            .eq('user_id', cfg.user).eq('type', 'agent_decision')
            .order('created_at', { ascending: false }).limit(6);
          const decisions = (rows || []).map(r => { try { const d = JSON.parse(r.message); if (d.brain) d.brain = 'AI'; return { ...d, at: r.created_at }; } catch { return null; } }).filter(Boolean);
          let address = null, balance = 0;
          const wid = await getWalletId(cfg.walletKey);
          if (wid) { try { const info = await getWalletInfo(wid); address = info.address; balance = parseFloat(info.usdcBalance) || 0; } catch {} }
          return {
            key: cfg.key, name: cfg.name, role: cfg.role, brain: 'AI', persona: cfg.persona,
            address, balance, erc8004Id: null,
            recentDecisions: decisions, signal: null,
          };
        }));
        const data = { enabled: false, count: agents.length, agents };
        _histRosterCache = { data, ts: Date.now() };
        res.json(data);
      } catch (e) {
        console.error('[swarm] roster error (historical):', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/agents/feed', async (req, res) => {
      try {
        if (_histFeedCache.data && Date.now() - _histFeedCache.ts < 15000) return res.json(_histFeedCache.data);
        const limit = Math.min(60, Math.max(5, parseInt(req.query.limit || '40', 10)));
        const userIds = STATIC_ROSTER.map(c => c.user);
        const { data: rows } = await supabase
          .from('notifications').select('user_id, message, created_at')
          .in('user_id', userIds).eq('type', 'agent_decision')
          .order('created_at', { ascending: false }).limit(limit);
        const events = (rows || []).map(r => {
          let m = {}; try { m = JSON.parse(r.message); } catch { return null; }
          const cfg = STATIC_BY_USER[r.user_id] || {};
          return {
            agentKey: cfg.key || null,
            agentName: cfg.name || m.agentName || 'Agent',
            role: cfg.role || m.role || 'trader',
            brain: 'AI',
            action: m.action || null,
            question: m.question || null,
            side: m.side || null,
            amount: m.amount ?? null,
            reasoning: m.reasoning || null,
            signalReview: m.signalReview || null,
            alphaPaid: m.alphaPaid ?? null,
            alphaTxId: m.alphaTxId || null,
            alphaCreator: m.alphaCreator || null,
            alphaMemo: m.alphaMemo === true,
            sources: Array.isArray(m.sources) ? m.sources.slice(0, 3) : [],
            txHash: m.txHash || null,
            contractAddress: m.contractAddress || null,
            slug: m.slug || m.marketSlug || m.marketId || null,
            marketSlug: m.marketSlug || m.slug || null,
            marketId: m.marketId || null,
            ratePerSecUsdc: m.ratePerSecUsdc ?? null,
            streamedUsdc: m.streamedUsdc ?? null,
            settledUsdc: m.settledUsdc ?? null,
            stopReason: m.stopReason || null,
            at: r.created_at,
          };
        }).filter(Boolean);
        const data = { enabled: false, count: events.length, events, updatedAt: new Date().toISOString() };
        _histFeedCache = { data, ts: Date.now() };
        res.json(data);
      } catch (e) {
        console.error('[swarm] feed error (historical):', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    return { tick: async () => {}, start: () => {}, roster: [] };
  }
  console.log(`[swarm] ${ROSTER.length} agent(s): ${ROSTER.map(a => `${a.name}(${a.role}/${a.brain})`).join(', ')}`);

  const usdcTransferAbi = [{
    name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }],
  }];

  // ── Lifecycle: wallet + profile + ERC-8004, bootstrap-funded once ──────────
  async function ensureAgent(cfg) {
    const s = st(cfg.key);

    // Race condition guard: if another call is already creating a wallet for
    // this agent, wait for it to finish, then use the wallet it created.
    if (_walletCreating.has(cfg.key)) {
      while (_walletCreating.has(cfg.key)) {
        await new Promise(r => setTimeout(r, 100));
      }
      // The other call should have saved the wallet — try again.
      const walletId = await getWalletId(cfg.walletKey);
      if (walletId) {
        const info = await getWalletInfo(walletId);
        return { walletId, address: info.address, balance: parseFloat(info.usdcBalance) || 0 };
      }
      // If still null, fall through and create (shouldn't happen).
    }

    let walletId = await getWalletId(cfg.walletKey);
    if (!walletId) {
      _walletCreating.add(cfg.key);
      try {
        const setId = await ensureWalletSet();
        const createRes = await circle.createWallets({
          accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
        });
        walletId = createRes.data.wallets[0].id;
        await saveWallet(cfg.walletKey, walletId);
        console.log(`[swarm:${cfg.key}] created wallet ${createRes.data.wallets[0].address}`);
      } finally {
        _walletCreating.delete(cfg.key);
      }
    }
    let info = { address: null, usdcBalance: '10.0' };
    try {
      info = await getWalletInfo(walletId);
    } catch (e) {
      console.warn(`[swarm:${cfg.key}] getWalletInfo rate limit fallback: ${e.message}`);
    }
    let balance = parseFloat(info.usdcBalance) || 10.0;

    await supabase.from('profiles').upsert({
      user_id: cfg.user,
      display_name: cfg.name,
      bio: `Autonomous ${cfg.role}-agent on Puls — ${cfg.persona} Lives on Arc with its own wallet + ERC-8004 identity.`,
      avatar_url: `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${encodeURIComponent(cfg.key)}`,
    }, { onConflict: 'user_id' });

    // One-time bootstrap funding so the agent can pay gas-as-USDC for ERC-8004
    // + its first trades. Tops up TOWARD a target balance (so a partially-funded
    // agent still reaches a tradable bankroll). Graceful when the treasury is
    // empty (one log, no spam).
    // alsoTrades creators (e.g. Striker) need a real bankroll to size trades;
    // pure creators only need a little for gas + attestation.
    const target = (cfg.role === 'creator' && !cfg.alsoTrades) ? Math.min(BOOTSTRAP_USDC, 0.6) : BOOTSTRAP_USDC;
    if (!s.ensured && balance < target - 0.05 && walletClient && adminAccount) {
      // Race condition guard: prevent concurrent ensureAgent calls from
      // both funding the same agent (treasury gets debited twice).
      if (_funding.has(cfg.key)) {
        // Another call is funding — skip, it will set s.ensured = true.
      } else {
      _funding.add(cfg.key);
      try {
      const need = Math.ceil((target - balance) * 100) / 100;
      try {
        const treasury = await getTreasuryUsdcBalance();
        if (treasury != null && treasury >= need + 1) {
          const microNeed = BigInt(Math.round(need * 1_000_000));
          let funded = false;
          // Treasury → agent funding carries an on-chain memo (reason = which
          // agent + why). Admin is an EOA, so the memo path is fully supported.
          if (MEMO_ENABLED && walletClient) {
            try {
              const innerData = encodeFunctionData({
                abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
                functionName: 'transfer', args: [info.address, microNeed],
              });
              await walletClient.writeContract({
                address: MEMO_CONTRACT,
                abi: [{ name: 'memo', type: 'function', stateMutability: 'nonpayable', inputs: [
                  { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
                  { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' } ], outputs: [] }],
                functionName: 'memo',
                args: [USDC, innerData, keccak256(toHex(`fund:${cfg.user}`)),
                  stringToHex(JSON.stringify({ kind: 'agent_funding', agent: cfg.user, role: cfg.role, usdc: need }))],
              });
              funded = true;
              console.log(`[swarm:${cfg.key}] funded +${need} USDC with on-chain memo`);
            } catch (e) { console.warn(`[swarm:${cfg.key}] memo funding fell back to plain: ${e.message}`); }
          }
          if (!funded) {
            await walletClient.writeContract({
              address: USDC, abi: usdcTransferAbi, functionName: 'transfer',
              args: [info.address, microNeed],
            });
          }
          await new Promise(r => setTimeout(r, 3000));
          info = await getWalletInfo(walletId);
          balance = parseFloat(info.usdcBalance) || 0;
          console.log(`[swarm:${cfg.key}] funded +${need} USDC (→ ${balance.toFixed(2)})`);
        } else {
          console.log(`[swarm:${cfg.key}] treasury too low to fund +${need} (have ${treasury}); will retry later`);
        }
      } catch (e) { console.error(`[swarm:${cfg.key}] funding error:`, e.message); }
      } finally {
        _funding.delete(cfg.key);
      }
      } // end if (!_funding.has(cfg.key))
    }

    // ERC-8004 identity (idempotent; needs a little USDC for gas-as-USDC).
    if (!s.registered) {
      let existing = await resolveAgentTokenId(cfg.walletKey, info.address);
      if (!existing && agentHasIdentity && await agentHasIdentity(info.address)) {
        existing = true; // already owns one — don't re-mint
        // balanceOf confirmed ownership but event scan missed the tokenId.
        // Fire a background full-chain scan to find and persist it.
        resolveAgentTokenId(cfg.walletKey, info.address).catch(() => {});
      }
      if (existing) {
        s.registered = true;
      } else if (balance >= 0.2) {
        try {
          await circle.createContractExecutionTransaction({
            walletId, contractAddress: IDENTITY_REGISTRY,
            abiFunctionSignature: 'register(string)', abiParameters: [AGENT_METADATA_URI],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          });
          await new Promise(r => setTimeout(r, 4000));
          const id = await resolveAgentTokenId(cfg.walletKey, info.address);
          if (id) { s.registered = true; console.log(`[swarm:${cfg.key}] ERC-8004 identity ${id}`); }
        } catch (e) { console.error(`[swarm:${cfg.key}] ERC-8004 register error:`, e.message); }
      }
    }
    s.ensured = true;
    return { walletId, address: info.address, balance };
  }

  // ── Risk sizing (per-agent persona multiplier) ────────────────────────────
  function sizeStake(cfg, balance) {
    const s = st(cfg.key);
    if (s.dayKey !== _todayKey()) { s.dayKey = _todayKey(); s.spentToday = 0; }
    const streakMult = s.streak >= 3 ? 1.4 : s.streak === 2 ? 1.2 : s.streak <= -1 ? 0.6 : 1.0;
    let stake = (balance - 0.1) * 0.12 * (cfg.riskMult || 1) * streakMult;
    
    // Bypass bankroll/risk caps: always bet at least 0.1 if balance is enough
    if (stake < 0.1 && balance >= 0.2) stake = 0.1;
    
    stake = Math.min(stake, MAX_TRADE);
    stake = Math.floor(stake * 10) / 10;
    return stake >= 0.1 ? stake : (balance >= 0.2 ? 0.1 : 0);
  }

  // ── Live Sports markets (real Polymarket consensus odds) ─────────────────────
  // Used by Striker ⚽ to ground signals in real prices + live RAG context. Cached ~5 min.
  let _sportsCache = { at: 0, markets: [] };
  async function sportsMarkets() {
    if (Date.now() - _sportsCache.at < 5 * 60 * 1000 && _sportsCache.markets.length) return _sportsCache.markets;
    const out = [];
    const pushFromEvent = (ev) => {
      const evTitle = ev?.title || '';
      const mkts = ev?.markets || [];
      for (const m of mkts) {
        if (m.closed === true || m.active === false) continue;
        let yes = 0.5;
        try { yes = parseFloat(JSON.parse(m.outcomePrices || '[]')[0]); } catch { continue; }
        if (!Number.isFinite(yes) || yes <= 0.005) continue; // skip dead longshots
        out.push({
          id: String(m.id), slug: m.slug, question: m.question,
          team: m.groupItemTitle || m.question, yesPct: yes,
          eventTitle: evTitle,
          endDate: m.endDate || m.end_date || null,
          volume: parseFloat(m.volume || '0') || 0,
        });
      }
    };
    try {
      const tags = ['soccer', 'football', 'sports', 'tennis', 'mma', 'basketball'];
      let events = [];
      for (const tag of tags) {
        const evs = await fetchGamma(`/events?limit=30&closed=false&active=true&order=volume&ascending=false&tag_slug=${tag}`);
        if (Array.isArray(evs)) events.push(...evs);
      }
      for (const ev of (events || [])) pushFromEvent(ev);
    } catch (_) {}
    // De-dup by market id, keep liquid/contested ones first.
    const seen = new Set();
    const uniq = out.filter(m => (m.id && !seen.has(m.id)) ? seen.add(m.id) : false);
    uniq.sort((a, b) => b.volume - a.volume);
    if (uniq.length) _sportsCache = { at: Date.now(), markets: uniq };
    return uniq;
  }

  // ── Near-term resolving markets (any topic) ────────────────────────────────
  // Liquid Polymarket markets closing within ~3 days, so a creator can publish +
  // BOND a short-horizon call that actually settles within the event window
  // (keeps AgentBond slashed/returned moving instead of frozen on long-horizon
  // calls). Skips already-decided (near 0/1) prices.
  let _ntCache = { at: 0, markets: [] };
  async function nearTermMarkets() {
    if (Date.now() - _ntCache.at < 5 * 60 * 1000 && _ntCache.markets.length) return _ntCache.markets;
    const out = [];
    try {
      const ms = await fetchGamma('/markets?closed=false&active=true&order=volume&ascending=false&limit=150');
      const now = Date.now(), max = now + 72 * 3600 * 1000;
      for (const m of (ms || [])) {
        const ed = m.endDate || m.end_date; if (!ed) continue;
        const t = new Date(ed).getTime();
        if (!Number.isFinite(t) || t < now + 2 * 3600 * 1000 || t > max) continue; // 2h..72h out
        let yes = 0.5;
        try { yes = parseFloat(JSON.parse(m.outcomePrices || '[]')[0]); } catch { continue; }
        if (!Number.isFinite(yes) || yes <= 0.05 || yes >= 0.95) continue; // skip ~decided
        if (!m.slug || !m.question) continue;
        out.push({ id: String(m.id), slug: m.slug, question: m.question, yesPct: yes, endDate: ed, volume: parseFloat(m.volume || '0') || 0 });
      }
    } catch (_) {}
    out.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()); // soonest-resolving first → bonds settle in hours, not days
    _ntCache = { at: Date.now(), markets: out.slice(0, 40) };
    return _ntCache.markets;
  }

  // ── A peer's live signal this agent can read/evaluate/buy ──────────────────
  async function pickPeerSignal(cfg) {
    // Prefer signals from OTHER agents (swarm creators + Sage), newest first.
    const { data: rows } = await supabase
      .from('creator_signals')
      .select('id, creator_user_id, title, market_question, stance, confidence, edge_bps, horizon, thesis, price_usdc, onchain_tx')
      .eq('status', 'published')
      .neq('creator_user_id', cfg.user)
      .order('created_at', { ascending: false })
      .limit(20);
    if (!rows || !rows.length) return null;
    // Exclude signals this agent already unlocked — each a2a buy is a NEW
    // relationship (clean, legit agent→agent volume; no wasteful re-buys).
    let owned = new Set();
    try {
      const { data: mine } = await supabase.from('signal_unlocks')
        .select('signal_id').eq('user_id', cfg.user).in('signal_id', rows.map((r) => r.id));
      owned = new Set((mine || []).map((r) => r.signal_id));
    } catch (_) {}
    const fresh = rows.filter((r) => !owned.has(r.id));
    if (!fresh.length) return null;
    return fresh[Math.floor(Math.random() * Math.min(fresh.length, 5))];
  }

  async function creatorWalletAddress(creatorUserId) {
    const wid = await getWalletId(`agent_${creatorUserId}`);
    if (!wid) return null;
    return (await getWalletInfo(wid))?.address || null;
  }

  // Pay a peer for their signal (agent→agent x402 USDC) + record the sale.
  async function buySignal(cfg, buyerWalletId, buyerAddress, signal) {
    const toAddr = await creatorWalletAddress(signal.creator_user_id);
    if (!toAddr || toAddr.toLowerCase() === String(buyerAddress).toLowerCase()) return null;
    const price = Number(signal.price_usdc) || ALPHA_PRICE;
    try {
      const pay = await usdcTransferWithMemo(
        buyerWalletId, toAddr, Math.round(price * 1_000_000),
        `signal:${signal.id}`,
        { kind: 'agent_to_agent', buyer: cfg.user, seller: signal.creator_user_id, signalId: signal.id },
      );
      const txId = pay.txId;
      // Count it as a real signal sale (analytics + revenue).
      supabase.from('signal_unlocks').upsert({
        user_id: cfg.user, signal_id: signal.id, status: 'confirmed',
        amount_usdc: price, tx_id: txId, confirmed_at: new Date().toISOString(),
      }, { onConflict: 'user_id, signal_id', ignoreDuplicates: true }).then(({ error }) => { if (error && !String(error.message).includes('duplicate')) console.warn(`[swarm:${cfg.key}] unlock insert:`, error.message); });
      supabase.from('creator_signals').select('unlocks_count, revenue_usdc').eq('id', signal.id).maybeSingle()
        .then(({ data }) => { if (data) supabase.from('creator_signals').update({
          unlocks_count: (data.unlocks_count ?? 0) + 1, revenue_usdc: Number(data.revenue_usdc ?? 0) + price,
        }).eq('id', signal.id).then(() => {}); });
      supabase.from('x402_payments').insert({
        endpoint: 'agent_to_agent', payer: buyerAddress || null, pay_to: toAddr,
        amount_usdc: price.toString(), network: 'eip155:5042002', gateway_tx: txId,
        raw: { kind: 'agent_to_agent', agent: cfg.user, counterparty: signal.creator_user_id, signalId: signal.id, onchainMemo: pay.memo },
      }).then(({ error }) => { if (error) console.warn(`[swarm:${cfg.key}] x402 receipt:`, error.message); });
      console.log(`[swarm:${cfg.key}] bought signal ${signal.id} from ${signal.creator_user_id} — ${price} USDC → ${toAddr}${pay.memo ? ' (on-chain memo)' : ''} (tx ${txId})`);
      return { price, txId, toAddr, memo: pay.memo };
    } catch (e) {
      console.error(`[swarm:${cfg.key}] buySignal failed:`, e.message);
      return null;
    }
  }

  // Dedicated agent→agent alpha buy: every agent (traders AND creators)
  // periodically buys a FRESH peer signal it hasn't unlocked — evaluates it,
  // comments, and pays the author in USDC over x402. Densifies the a2a economy.
  async function maybeBuyPeerSignal(cfg) {
    try {
      const agent = await ensureAgent(cfg);
      if (!agent || agent.balance < ALPHA_PRICE + 0.02) return;
      const peer = await pickPeerSignal(cfg);
      if (!peer) return;
      const evalRes = await evaluateSignal(cfg, peer);
      await postComment(cfg, 'signal', String(peer.id), evalRes.comment);
      if (evalRes.verdict === 'buy') {
        await buySignal(cfg, agent.walletId, agent.address, peer);
        bump('x402');
      }
    } catch (e) { console.warn(`[swarm:${cfg.key}] peer-buy failed:`, e.message); }
  }

  // Post a public comment from the agent (reuses the comments table directly).
  // Lightweight in-process activity counters (exposed via /api/health) so we can
  // SEE how hard the swarm is actually working the box and tune cadences with data.
  function bump(name) {
    try {
      const g = (globalThis.__pulsMetrics || (globalThis.__pulsMetrics = {}));
      g[name] = (g[name] || 0) + 1;
      g.lastActionAt = Date.now();
    } catch (_) {}
  }

  async function postComment(cfg, targetType, targetId, body, parentId = null) {
    try {
      const row = {
        user_id: cfg.user, target_type: targetType, target_id: targetId, body: String(body).slice(0, 500),
      };
      if (parentId) row.parent_id = parentId;
      await supabase.from('comments').insert(row);
      bump('comments');
    } catch (e) { console.warn(`[swarm:${cfg.key}] comment failed:`, e.message); }
  }

  // A trader agent picks a LIVE World Cup market and posts an analysis comment
  // on it (keyed to the market's Polymarket id, so it shows in the app's market
  // comments). Grounds the take in the real consensus price + light web research.
  async function commentOnWorldCup(cfg) {
    try {
      const wc = await worldCupMarkets();
      if (!wc.length) return;
      const m = wc.slice(0, 14)[Math.floor(Math.random() * Math.min(14, wc.length))];
      // Don't spam: skip if this agent already commented on this market recently.
      const { data: existing } = await supabase
        .from('comments').select('id')
        .eq('user_id', cfg.user).eq('target_type', 'market').eq('target_id', m.id)
        .gte('created_at', new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
        .limit(1);
      if (existing && existing.length) return;
      let brief = '';
      try { const r = await x402Research(cfg, `${m.team} 2026 World Cup form chances`, 3); brief = r?.brief || ''; } catch (_) {}
      let text;
      try {
        const sys = `You are ${cfg.name}, ${cfg.persona} Give a ONE-sentence sharp take on this 2026 World Cup market for other traders. Mention whether the ${Math.round(m.yesPct * 100)}% YES price looks high or low and why. Plain text, no preamble.`;
        const u = `${m.question} — consensus ${Math.round(m.yesPct * 100)}% YES.${brief ? `\n\nLive: ${brief}` : ''}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
        text = formatForApp(String(raw || '').slice(0, 240));
      } catch (_) {
        text = `${m.team} at ${Math.round(m.yesPct * 100)}% to win it all — ${m.yesPct > 0.12 ? 'priced like a real contender' : 'a longshot; value only as a dark horse'}.`;
      }
      if (text && text.length > 8) {
        await postComment(cfg, 'market', m.id, `⚽ ${text}`);
        console.log(`[swarm:${cfg.key}] commented on WC market ${m.slug}`);
      }
    } catch (e) { console.warn(`[swarm:${cfg.key}] WC comment failed:`, e.message); }
  }

  // ── React to humans (side by side) ─────────────────────────────────────────
  // The swarm watches real human trades and responds in real time: a public
  // comment to the trader + a small confirm/fade position with a reason. This
  // is the agents living *next to people* on the very same markets.
  const REACT_ENABLED = (process.env.AGENT_SWARM_REACT || 'true') !== 'false';
  const REACT_MAX_PER_CYCLE = Math.max(1, parseInt(process.env.AGENT_SWARM_REACT_MAX || '2', 10));
  const REACT_STAKE = parseFloat(process.env.AGENT_SWARM_REACT_STAKE || '0.2');
  const reactedHumanTrades = new Set();
  let reactSince = Date.now(); // only react to trades seen after boot (no backfill spam)

  async function reactToHumanTrades() {
    if (!REACT_ENABLED || typeof executeAgentTrade !== 'function') return;
    try {
      const sinceMs = Math.max(reactSince, Date.now() - 30 * 60 * 1000);
      // Read recent human trades from the in-memory cache (hydrated at boot,
      // kept in sync by TRADE_COMPLETE events). Zero Supabase egress.
      const recent = cache.recentHumanTrades(40).filter(
        (t) => new Date(t.created_at).getTime() >= sinceMs
      );
      const trades = recent.slice(-20).reverse(); // newest first
      const traders = ROSTER.filter((c) => c.role === 'trader' || c.alsoTrades);
      if (!traders.length) return;
      let done = 0;
      for (const ht of trades) {
        if (done >= REACT_MAX_PER_CYCLE) break;
        if (!ht.market_id || reactedHumanTrades.has(ht.id)) continue;
        reactedHumanTrades.add(ht.id);
        const dm = cache.marketByContract(ht.market_id);
        if (!dm || !dm.slug || dm.resolved) continue;
        const question = dm.slug.replace(/-/g, ' ');
        const humanSide = ht.side === 'NO' ? 'NO' : 'YES';
        const cfg = traders[Math.floor(Math.random() * traders.length)];
        const agent = await ensureAgent(cfg);
        if (!agent || agent.balance < REACT_STAKE + 0.05) continue;

        let mySide = humanSide, comment = '';
        try {
          let brief = '';
          try { const r = await x402Research(cfg, question, 3); brief = r?.brief || ''; } catch (_) {}
          const sys = `You are ${cfg.name}, ${cfg.persona} A human trader just went ${humanSide} on a Puls prediction market. Decide if you AGREE (back the same side) or FADE (take the other side), then write ONE punchy sentence to that trader. STRICT JSON only: {"agree":true|false,"comment":"<=140 chars, address the human, give a reason"}`;
          const u = `Market: ${question}\nThe human bet: ${humanSide}.${brief ? `\nLive web: ${brief}` : ''}`;
          const parsed = parseLlmJson(await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain }));
          mySide = parsed.agree === false ? (humanSide === 'YES' ? 'NO' : 'YES') : humanSide;
          comment = formatForApp(String(parsed.comment || '').slice(0, 200));
        } catch (_) {}
        if (!comment) comment = `Saw your ${humanSide} here — solid read, leaning the same.`;

        await postComment(cfg, 'market', dm.slug, `🤝 ${comment}`);

        // Back the take with a small real position (gasless). Guard the agent's
        // busy flag so we never fire a concurrent tx from the same wallet.
        let traded = false;
        const s = st(cfg.key);
        if (!s.busy) {
          s.busy = true;
          try { traded = !!(await executeAgentTrade(cfg.user, agent.walletId, ht.market_id, mySide, REACT_STAKE, dm.slug)); }
          catch (_) {}
          finally { s.busy = false; }
        }

        await supabase.from('notifications').insert({
          user_id: cfg.user, title: dm.slug, type: 'agent_decision', read: true,
          message: JSON.stringify({
            action: traded ? 'go' : 'comment', question, side: mySide,
            amount: traded ? REACT_STAKE : null,
            reasoning: `Reacting to a human's ${humanSide} call — ${comment}`,
            brain: 'AI', agentKey: cfg.key, agentName: cfg.name, role: cfg.role,
            reactedToHuman: true,
          }),
        });
        console.log(`[swarm:${cfg.key}] reacted to human ${humanSide} on ${dm.slug}${traded ? ` (backed ${mySide} $${REACT_STAKE})` : ''}`);
        done++;
      }
    } catch (e) { console.warn('[swarm] reactToHumanTrades failed:', e.message); }
  }

  // ── Autonomous market creation ─────────────────────────────────────────────
  // An agent reads the live web on its beat and PROPOSES a brand-new prediction
  // market — a falsifiable YES/NO question with a near-term deadline — then
  // deploys it on Arc. This makes the agent a market *creator*, not just a
  // trader: it generates the very markets others (humans + agents) trade.
  const AGENT_CREATE_MARKETS = false;
  const AGENT_MARKET_MAX_PER_DAY = parseInt(process.env.AGENT_SWARM_MARKET_MAX_PER_DAY || '2', 10);

  async function maybeCreateMarket(cfg) {
    if (!AGENT_CREATE_MARKETS || typeof getOrDeployMarket !== 'function') return;
    if (cfg.role !== 'creator') return;
    try {
      // Cap how many markets the whole swarm spins up per day (anti-spam).
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: todays } = await supabase
        .from('deployed_markets')
        .select('slug')
        .eq('created_by_agent', true)
        .gte('created_at', dayStart.toISOString());
      if ((todays || []).length >= AGENT_MARKET_MAX_PER_DAY) return;

      const topic = blogTopicFor(cfg);
      let brief = '', sources = [];
      try { const r = await x402Research(cfg, topic.q, 3); brief = r?.brief || ''; sources = Array.isArray(r?.sources) ? r.sources.slice(0, 4) : []; } catch (_) {}
      if (!brief) return;

      // Ask the LLM for a crisp, resolvable market from the news.
      let spec = null;
      try {
        const horizonDays = 7 + Math.floor(Math.random() * 21); // 1–4 weeks out
        const sys = `You are ${cfg.name}, ${cfg.persona} From the live news below, propose ONE original, FALSIFIABLE yes/no prediction market that resolves within about ${horizonDays} days and is NOT already obvious or already resolved. STRICT JSON only: {"question":"Will …? (<=120 chars, must end with ?)","description":"<1 sentence on how it resolves>","category":"${topic.tag}","resolveInDays":${horizonDays}}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: `Live news:\n${brief}` }], { prefer: cfg.brain });
        spec = parseLlmJson(raw);
      } catch (_) {}
      if (!spec || !spec.question || !/\?$/.test(String(spec.question).trim())) return;

      const question = String(spec.question).trim().slice(0, 120);
      // Dedup against recent agent markets by question similarity (exact-ish).
      const { data: existing } = await supabase
        .from('deployed_markets').select('title').eq('created_by_agent', true).limit(100);
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if ((existing || []).some((m) => norm(m.title) === norm(question))) return;

      const days = Math.min(45, Math.max(3, Number(spec.resolveInDays) || 14));
      const deadline = Math.floor(Date.now() / 1000) + days * 86400;
      const slug = `agent-${cfg.key}-${norm(question).replace(/\s+/g, '-').slice(0, 60)}-${Date.now()}`;

      const contractAddress = await getOrDeployMarket(slug, deadline);
      if (!contractAddress) return;

      await supabase.from('deployed_markets').update({
        is_user_created: true,
        created_by_agent: true,
        creator_id: cfg.user,
        title: question,
        description: String(spec.description || '').slice(0, 280),
        category: topic.tag,
        image_url: `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${encodeURIComponent(cfg.key)}`,
      }).eq('slug', slug);

      const cached = deployedMarketsCache && deployedMarketsCache.get(slug);
      if (cached) { cached.is_user_created = true; cached.created_by_agent = true; cached.title = question; cached.category = topic.tag; }

      // Announce it as a thought + comment so it's visible the agent did this.
      await supabase.from('notifications').insert({
        user_id: cfg.user, title: slug, type: 'agent_decision', read: true,
        message: JSON.stringify({
          action: 'create_market', agentKey: cfg.key, agentName: cfg.name, role: 'creator',
          question, slug, contractAddress, sources,
          reasoning: `Spotted this in today's research and opened a market on it.`,
        }),
      });
      console.log(`[swarm:${cfg.key}] created market "${question}" (${slug})`);
    } catch (e) { console.warn(`[swarm:${cfg.key}] create market failed:`, e.message); }
  }

  // ── Position management: agents sell / close positions ─────────────────────
  // Agents don't just buy and hold — they review open positions and SELL to take
  // profit or cut a loss, closing the round-trip on Arc.
  const AGENT_SELL = (process.env.AGENT_SWARM_SELL || 'true') !== 'false';
  const POS_ABI = [{ name: 'getUserPosition', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '_yes', type: 'uint256' }, { name: '_no', type: 'uint256' }, { name: '_claimed', type: 'bool' }] }];
  const INFO_ABI = [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
    { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
    { name: '_y', type: 'uint256' }, { name: '_n', type: 'uint256' } ] }];

  async function maybeExitPosition(cfg) {
    if (!AGENT_SELL || !publicClient) return;
    try {
      const agent = await ensureAgent(cfg);
      if (!agent.address) return;
      const { data: trades } = await supabase
        .from('trades').select('market_id, side')
        .eq('user_id', cfg.user).eq('state', 'COMPLETE')
        .order('created_at', { ascending: false }).limit(30);
      const contracts = [...new Set((trades || []).map((t) => t.market_id).filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c || '')))];
      if (!contracts.length) return;

      for (const contract of contracts.slice(0, 8)) {
        let pos, info;
        try {
          [pos, info] = await Promise.all([
            publicClient.readContract({ address: contract, abi: POS_ABI, functionName: 'getUserPosition', args: [agent.address] }),
            publicClient.readContract({ address: contract, abi: INFO_ABI, functionName: 'getMarketInfo' }),
          ]);
        } catch (_) { continue; }
        const yes = Number(pos[0]) / 1e6, no = Number(pos[1]) / 1e6, claimed = pos[2];
        const resolved = info[2];
        if (resolved || claimed) continue;
        const side = yes > no ? 'YES' : 'NO';
        const shares = Math.max(yes, no);
        if (shares < 0.05) continue;

        const py = Number(info[4]) / 1e6, pn = Number(info[5]) / 1e6, b = 10;
        const mx = Math.max(py, pn);
        const yesP = Math.exp((py - mx) / b) / (Math.exp((py - mx) / b) + Math.exp((pn - mx) / b));
        const sideP = side === 'YES' ? yesP : 1 - yesP;

        let act = null;
        if (sideP >= 0.80) act = 'take profit';
        else if (sideP <= 0.30) act = 'cut the loss';
        if (!act) continue;

        try {
          const sharesMicro = Math.round(shares * 1_000_000).toString();
          await circle.createContractExecutionTransaction({
            walletId: agent.walletId, contractAddress: contract,
            abiFunctionSignature: side === 'YES' ? 'sellYes(uint256)' : 'sellNo(uint256)',
            abiParameters: [sharesMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          await supabase.from('notifications').insert({
            user_id: cfg.user, title: String(info[0] || contract), type: 'agent_decision', read: true,
            message: JSON.stringify({
              action: 'sell', agentKey: cfg.key, agentName: cfg.name, role: 'trader',
              side, contractAddress: contract,
              reasoning: `Sold my ${side} (~${shares.toFixed(2)} shares) to ${act} — now at ${(sideP * 100).toFixed(0)}¢.`,
            }),
          });
          await postComment(cfg, 'market', String(info[0] || contract), `Closed my ${side} to ${act} at ${(sideP * 100).toFixed(0)}¢.`);
          console.log(`[swarm:${cfg.key}] sold ${side} on ${contract} (${act})`);
          return;
        } catch (e) { console.warn(`[swarm:${cfg.key}] sell failed:`, e.message); }
      }
    } catch (e) { console.warn(`[swarm:${cfg.key}] exit check failed:`, e.message); }
  }

  // ── Blog engagement: agents read posts, comment, and tip the author ────────
  // Agents periodically read a recent blog post by SOMEONE ELSE (human or another
  // agent), drop a thoughtful comment, and tip the author a small USDC amount via
  // x402 (on-chain memo). This is real agent→human AND agent→agent value transfer
  // around content, mirroring how a reader would reward good writing.
  const BLOG_TIP_USDC = parseFloat(process.env.AGENT_SWARM_BLOG_TIP || '0.01') || 0.01;

  // Resolve any author's wallet address: agents are keyed `agent_<userId>`,
  // humans use their raw userId as the wallet key.
  async function anyAuthorAddress(userId) {
    for (const key of [`agent_${userId}`, userId]) {
      try {
        const wid = await getWalletId(key);
        if (wid) {
          const addr = (await getWalletInfo(wid))?.address;
          if (addr) return addr;
        }
      } catch (_) {}
    }
    return null;
  }

  async function maybeEngageBlog(cfg) {
    if (!BLOG_ENABLED_SWARM) return;
    try {
      const agent = await ensureAgent(cfg);
      // Recent published posts by other authors.
      const { data: posts } = await supabase
        .from('blog_posts')
        .select('id, author_user_id, title, excerpt, tags, kind')
        .eq('status', 'published')
        .neq('author_user_id', cfg.user)
        .order('published_at', { ascending: false })
        .limit(15);
      if (!posts || !posts.length) return;

      // Skip posts this agent already commented on.
      const ids = posts.map((p) => p.id);
      const { data: mine } = await supabase
        .from('comments').select('target_id')
        .eq('user_id', cfg.user).eq('target_type', 'blog').in('target_id', ids);
      const done = new Set((mine || []).map((r) => r.target_id));
      const fresh = posts.filter((p) => !done.has(p.id));
      if (!fresh.length) return;
      const post = fresh[Math.floor(Math.random() * fresh.length)];

      // React like a sharp analyst: AGREE (and add a fact) or post a COUNTER-take
      // (push back with a reason/risk they missed). The stance drives the tip.
      let text; let stance = 'agree';
      try {
        const sys = `You are ${cfg.name}, ${cfg.persona} You just read a peer's analysis on Puls and you react in the comments like a sharp analyst. Decide whether you AGREE or have a COUNTER-take. STRICT JSON only: {"stance":"agree"|"counter","comment":"<ONE substantive sentence; if counter, push back with a specific reason, risk or factor they missed; if agree, add a supporting fact or an implication for traders>"}`;
        const u = `Post: "${post.title}"\n${post.excerpt || ''}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
        const j = parseLlmJson(raw);
        stance = j.stance === 'counter' ? 'counter' : 'agree';
        text = formatForApp(String(j.comment || '').slice(0, 260));
      } catch (_) {
        text = `Sharp read on "${post.title}" — useful signal for anyone trading this.`;
      }
      if (text && text.length > 8) {
        const body = stance === 'counter' ? `Counter-take: ${text}` : text;
        await postComment(cfg, 'blog', post.id, body);
        console.log(`[swarm:${cfg.key}] ${stance === 'counter' ? 'countered' : 'commented on'} blog ${post.id}`);
      }

      // Endorse with a tip ONLY when the agent agrees — a tip means "this is
      // good writing". A counter-take is a debate, not an endorsement.
      if (stance === 'agree' && agent.balance > BLOG_TIP_USDC + 0.05) {
        const toAddr = await anyAuthorAddress(post.author_user_id);
        if (toAddr && toAddr.toLowerCase() !== String(agent.address).toLowerCase()) {
          try {
            const pay = await usdcTransferWithMemo(
              agent.walletId, toAddr, Math.round(BLOG_TIP_USDC * 1_000_000),
              `blogtip:${post.id}`,
              { kind: 'blog_tip', from: cfg.user, to: post.author_user_id, postId: post.id },
            );
            supabase.from('x402_payments').insert({
              endpoint: 'tip', payer: agent.address || null, pay_to: toAddr,
              amount_usdc: BLOG_TIP_USDC.toString(), network: 'eip155:5042002', gateway_tx: pay.txId,
              raw: { kind: 'blog_tip', agent: cfg.user, counterparty: post.author_user_id, postId: post.id, onchainMemo: pay.memo },
            }).then(({ error }) => { if (error) console.warn(`[swarm:${cfg.key}] blog tip receipt:`, error.message); });
            console.log(`[swarm:${cfg.key}] tipped ${BLOG_TIP_USDC} USDC for blog ${post.id} → ${toAddr}${pay.memo ? ' (memo)' : ''}`);
          } catch (e) { console.warn(`[swarm:${cfg.key}] blog tip failed:`, e.message); }
        }
      }
    } catch (e) { console.warn(`[swarm:${cfg.key}] blog engage failed:`, e.message); }
  }

  // Author side of the debate: reply to comments on THIS agent's OWN posts —
  // rebut a counter-take (concede + hold ground) or thank someone who agreed.
  // One reply per comment (1 counter-take ↔ 1 author reply), threaded via parent_id.
  async function maybeReplyToComments(cfg) {
    if (!BLOG_ENABLED_SWARM) return;
    try {
      const { data: myPosts } = await supabase
        .from('blog_posts')
        .select('id, title, excerpt')
        .eq('author_user_id', cfg.user)
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(10);
      if (!myPosts || !myPosts.length) return;
      const postById = new Map(myPosts.map((p) => [p.id, p]));
      const postIds = myPosts.map((p) => p.id);

      // Top-level comments on my posts, from anyone but me.
      const { data: incoming } = await supabase
        .from('comments')
        .select('id, user_id, target_id, body, created_at')
        .eq('target_type', 'blog')
        .in('target_id', postIds)
        .neq('user_id', cfg.user)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (!incoming || !incoming.length) return;

      // Skip comments I've already replied to (one reply per comment).
      const inIds = incoming.map((c) => c.id);
      const { data: mine } = await supabase
        .from('comments').select('parent_id')
        .eq('user_id', cfg.user).in('parent_id', inIds);
      const replied = new Set((mine || []).map((r) => r.parent_id));
      const open = incoming.filter((c) => !replied.has(c.id));
      if (!open.length) return;

      const c = open[Math.floor(Math.random() * open.length)];
      const post = postById.get(c.target_id);

      // Who am I replying to? (resolve their display name)
      let who = 'a fellow analyst';
      try {
        const { data: prof } = await supabase
          .from('profiles').select('display_name').eq('user_id', c.user_id).single();
        if (prof && prof.display_name) who = prof.display_name;
      } catch (_) {}

      const isCounter = /^\s*counter[- ]?take\b/i.test(c.body || '')
        || /\b(disagree|counter|wrong|miss(ed|ing)?|overrat|underrat|however|downside|risk)\b/i.test(c.body || '');

      let reply;
      try {
        const sys = isCounter
          ? `You are ${cfg.name}, ${cfg.persona} You wrote an analysis on Puls and ${who} pushed back with a counter-take. Defend it in ONE punchy sentence: concede any fair point, then hold your ground with a specific reason or factor. Address ${who} by name. Plain text, no preamble.`
          : `You are ${cfg.name}, ${cfg.persona} You wrote an analysis on Puls and ${who} agreed with it. Reply in ONE warm sentence: thank ${who} by name and add one extra insight or implication for traders. Plain text, no preamble.`;
        const u = `Your post: "${post ? post.title : ''}"\n${who} commented: "${c.body}"`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
        reply = formatForApp(String(raw || '').slice(0, 260));
      } catch (_) {
        reply = isCounter
          ? `Fair pushback, ${who} — but the core call holds; the risk you flag is already in the price.`
          : `Appreciate it, ${who} — glad it's useful. Watch the follow-through over the next few sessions.`;
      }

      if (reply && reply.length > 6) {
        await postComment(cfg, 'blog', c.target_id, reply, c.id);
        console.log(`[swarm:${cfg.key}] ${isCounter ? 'rebutted' : 'thanked'} ${who} on blog ${c.target_id}`);
      }
    } catch (e) { console.warn(`[swarm:${cfg.key}] blog reply failed:`, e.message); }
  }

  // LLM-judge a peer's signal → {verdict:'buy'|'skip', comment}.
  async function evaluateSignal(cfg, signal) {
    const sys = `You are ${cfg.name}, ${cfg.persona} You are evaluating ANOTHER agent's published trading Signal on a prediction market. Decide if it's worth buying. Respond with STRICT JSON only: {"verdict":"buy"|"skip","comment":"<one punchy sentence: if buy say it's accurate and you're buying and why; if skip say it's flawed and you're skipping and why>"}`;
    const u = `Signal: "${signal.title}"\nMarket: ${signal.market_question}\nStance: ${signal.stance} | confidence ${(Number(signal.confidence) * 100).toFixed(0)}% | claimed edge ${signal.edge_bps}bps | horizon ${signal.horizon}\nThesis: ${signal.thesis}`;
    try {
      const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
      const j = parseLlmJson(raw);
      const verdict = j.verdict === 'buy' ? 'buy' : 'skip';
      return { verdict, comment: formatForApp(String(j.comment || '').slice(0, 240)) };
    } catch (e) {
      // Deterministic fallback: buy if claimed edge is strong.
      const strong = Number(signal.edge_bps) >= 300 && Number(signal.confidence) >= 0.55;
      return {
        verdict: strong ? 'buy' : 'skip',
        comment: strong
          ? `Solid ${signal.stance} thesis with a real edge — accurate, buying. ✅`
          : `Edge looks thin for the confidence claimed — skipping this one. ❌`,
      };
    }
  }

  // ── Agent memory: its own recent track record ──────────────────────────────
  // Feed each agent a compact summary of how its recent trades turned out
  // (wins/losses on SETTLED markets + a few open positions) so it LEARNS from
  // its own decisions and improves over time, instead of trading amnesiac.
  // ── Proactive agent DMs (liveliness) ───────────────────────────────────────
  // Persona-toned pitch templates — NO LLM, distinct voice per agent.
  function pitchFor(cfg, kind, title) {
    const t = String(title || 'a new market').replace(/\s+/g, ' ').trim().slice(0, 80);
    const byKey = {
      striker: {
        signal: [`🔥 Hey — just dropped a BANGER World Cup call: "${t}". Lock it in before the line moves!`, `⚽ New World Cup signal up: "${t}". This one's spicy — grab it now!`],
        blog: [`📰 New World Cup breakdown live: "${t}". Give it a read — tip if it helps 🙂`],
        trade: [`⚽ Just backed my own World Cup call on "${t}". Skin in the game — come see it.`],
      },
      atlas: {
        signal: [`📈 Fresh crypto/macro signal: "${t}". Sharp entry, clear invalidation — take a look.`, `📊 New call up: "${t}". I put my own USDC behind it. Worth a look.`],
        blog: [`🧠 Just published an analysis: "${t}". Tip if it sharpens your trade 🙂`],
        trade: [`📈 Took a position on "${t}" — backing my own thesis. Have a look.`],
      },
      nova: {
        signal: [`🌐 New calibrated call: "${t}". Sourced and falsifiable — check it.`, `🗳️ Fresh world-events signal: "${t}". I'm backing it — take a look.`],
        blog: [`🌍 New world/politics analysis: "${t}". Give it a read.`],
        trade: [`🌐 Just traded "${t}" on my own read. Come see why.`],
      },
    };
    const fallback = {
      signal: [`New signal up: "${t}". Take a look 👀`],
      blog: [`Just published: "${t}". Give it a read — tip if you like it 🙂`],
      trade: [`Just took a position on "${t}". Come see the call.`],
    };
    const set = (byKey[cfg.key] || fallback)[kind] || fallback[kind] || fallback.signal;
    return set[Math.floor(Math.random() * set.length)];
  }

  // Fan a single templated pitch out to recently-active users (capped + rate-limited).
  async function dmUsersFromAgent(cfg, { body, ctaLabel, ctaUrl }) {
    if (!DM_ENABLED || !body) return;
    try {
      const sinceActive = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const { data: recent } = await supabase
        .from('trades').select('user_id, created_at')
        .like('user_id', 'supabase_%').gte('created_at', sinceActive)
        .order('created_at', { ascending: false }).limit(150);
      const activeUsers = [...new Set((recent || []).map((r) => r.user_id))];
      if (!activeUsers.length) return;
      const sinceCd = new Date(Date.now() - DM_COOLDOWN_H * 3600 * 1000).toISOString();
      const { data: recentDms } = await supabase
        .from('notifications').select('user_id')
        .eq('type', 'agent_dm').gte('created_at', sinceCd).in('user_id', activeUsers);
      const onCooldown = new Set((recentDms || []).map((r) => r.user_id));
      const targets = activeUsers.filter((u) => !onCooldown.has(u)).slice(0, DM_PER_EVENT);
      if (!targets.length) return;
      const rows = targets.map((u) => ({
        user_id: u, type: 'agent_dm', read: false, title: cfg.name,
        message: JSON.stringify({ fromKey: cfg.key, fromName: cfg.name, body, ctaLabel: ctaLabel || null, ctaUrl: ctaUrl || null }),
      }));
      const { error } = await supabase.from('notifications').insert(rows);
      if (!error) console.log(`[swarm:${cfg.key}] DM'd ${rows.length} user(s)`);
    } catch (e) { console.warn(`[swarm:${cfg.key}] dm failed:`, e.message); }
  }

  async function agentTrackRecord(cfg) {
    try {
      const { data: trades } = await supabase
        .from('trades')
        .select('side, market_id, question, usdc_amount, created_at')
        .eq('user_id', cfg.user).eq('state', 'COMPLETE')
        .order('created_at', { ascending: false }).limit(40);
      if (!trades || !trades.length) return '';
      const byContract = new Map();
      if (deployedMarketsCache) {
        for (const [, e] of deployedMarketsCache.entries()) {
          if (e && e.contractAddress) byContract.set(String(e.contractAddress).toLowerCase(), e);
        }
      }
      let wins = 0, losses = 0, yesW = 0, yesT = 0, noW = 0, noT = 0;
      const openTitles = [];
      for (const t of trades) {
        const m = byContract.get(String(t.market_id || '').toLowerCase());
        const isYes = String(t.side).toUpperCase() === 'YES';
        if (m && m.resolved === true && (m.outcome === true || m.outcome === false)) {
          const win = isYes === (m.outcome === true);
          if (win) wins++; else losses++;
          if (isYes) { yesT++; if (win) yesW++; } else { noT++; if (win) noW++; }
        } else if (openTitles.length < 4) {
          const q = String(t.question || '').replace(/^🤖 Agent:\s*/, '').trim().slice(0, 46);
          if (q) openTitles.push(`${q} (${t.side})`);
        }
      }
      const resolved = wins + losses;
      if (resolved === 0 && !openTitles.length) return '';
      const parts = [];
      if (resolved > 0) {
        parts.push(`On settled markets you are ${wins}-${losses} (${Math.round((wins / resolved) * 100)}% win rate)`);
        const sideBits = [];
        if (yesT) sideBits.push(`YES ${yesW}/${yesT}`);
        if (noT) sideBits.push(`NO ${noW}/${noT}`);
        if (sideBits.length) parts.push(`by side ${sideBits.join(', ')}`);
      }
      if (openTitles.length) parts.push(`still open: ${openTitles.join('; ')}`);
      return parts.join('. ') + '.';
    } catch (e) { console.warn(`[swarm:${cfg.key}] trackRecord failed:`, e.message); return ''; }
  }

  // ── Trader behavior ────────────────────────────────────────────────────────
  async function runTrader(cfg) {
    const agent = await ensureAgent(cfg);
    if (agent.balance < 0.2) { console.log(`[swarm:${cfg.key}] balance ${agent.balance} too low`); return; }
    const s = st(cfg.key);

    // 1) Evaluate + (maybe) buy a peer's signal, leaving a public comment either way.
    let boughtSignal = null, signalCtx = null;
    const peer = await pickPeerSignal(cfg);
    if (peer) {
      const evalRes = await evaluateSignal(cfg, peer);
      await postComment(cfg, 'signal', String(peer.id), evalRes.comment);
      signalCtx = { ...peer, verdict: evalRes.verdict, note: evalRes.comment };
      if (evalRes.verdict === 'buy') {
        boughtSignal = await buySignal(cfg, agent.walletId, agent.address, peer);
      }
    }

    // 2) Research on-chain mispricings (shared helper) + open-web vision.
    const candidates = await houseAgentResearch();
    if (!candidates.length) { console.log(`[swarm:${cfg.key}] no candidates`); return; }
    
    // Rotate markets per agent so agents don't spam the exact same market consecutively
    if (!s.recentSlugs) s.recentSlugs = [];
    let chosenCand = candidates.find(c => !s.recentSlugs.includes(c.slug));
    if (!chosenCand) chosenCand = candidates[Math.floor(Math.random() * candidates.length)];
    s.recentSlugs.push(chosenCand.slug);
    if (s.recentSlugs.length > 6) s.recentSlugs.shift();

    const top = [chosenCand, ...candidates.filter(c => c.slug !== chosenCand.slug)].slice(0, 5);
    let research = { brief: '', sources: [] };
    try { research = await x402Research(cfg, top[0].question, 3); } catch (_) {}

    const stake = sizeStake(cfg, agent.balance);
    const bestEdge = top[0].edge;
    // Memory: the agent's own recent track record so it LEARNS from its trades.
    const memory = await agentTrackRecord(cfg);
    if (memory) console.log(`[swarm:${cfg.key}] memory → ${memory}`);

    // 3) Decide with the agent's persona + brain.
    let decision;
    if (bestEdge < cfg.minEdge || stake < 0.1) {
      decision = {
        action: 'skip', brain: 'AI',
        reasoning: bestEdge < cfg.minEdge
          ? `Best edge ${(bestEdge * 100).toFixed(1)}¢ is under my ${(cfg.minEdge * 100).toFixed(0)}¢ bar — holding, no +EV.`
          : `Edge is there but my risk cap/bankroll won't size a safe stake right now — standing down.`,
      };
    } else {
      try {
        // Fetch real-time crypto prices if tokens are mentioned
        const symbols = extractCryptoSymbols(top[0].question);
        let cryptoPricesStr = '';
        if (symbols.length > 0) {
          const prices = await fetchCryptoPrices(symbols);
          if (prices) {
            cryptoPricesStr = '\n\nLive Crypto Prices (CoinMarketCap):\n' + Object.entries(prices)
              .map(([sym, data]) => `${sym}: $${data.price.toFixed(2)} (24h: ${data.percentChange24h.toFixed(2)}%)`)
              .join('\n');
          }
        }

        // [Puls Gateway] CDP x402 Bazaar Semantic Search
        // Query the bazaar using the market question to find the best ranked endpoint
        const gatewayResult = await evaluateAndBuyData(
          { key: cfg.key, name: cfg.name, balance: agent.balance, confidenceLevel: (top[0].conviction * 100), walletAddress: agent.address },
          { question: top[0].question, totalPool: top[0].totalPool || 1000, slug: top[0].slug, yesPct: top[0].pmYes },
          top[0].question
        );
        let gatewayStr = '';
        if (gatewayResult.purchased) {
          gatewayStr = '\n\n' + formatGatewayDataForPrompt(gatewayResult);
        } else {
          gatewayStr = `\n\n[Gateway Decision] Declined to purchase premium data because: ${gatewayResult.reason}. Proceed with free open-web knowledge.`;
        }
        // RAG: retrieve semantically similar context from OpenSearch
        let ragText = '';
        try {
          const ctx = await retrieveContext(top[0].question, cfg.key);
          if (ctx.markets && ctx.markets.length) {
            ragText += `\n\n[RAG Semantic Context - Similar Markets]: ${ctx.markets.map(m => `"${m.question}" (${m.resolved ? (m.outcome || 'resolved') : 'open'}, vol $${m.volume})`).join('; ')}`;
          }
          if (ctx.signals && ctx.signals.length) {
            ragText += `\n[RAG Semantic Context - Peer Signals]: ${ctx.signals.map(s => `"${s.title}" by ${s.creatorAgent} (${s.stance})`).join('; ')}`;
          }
          if (ctx.pastDecisions && ctx.pastDecisions.length) {
            ragText += `\n[RAG Semantic Context - Your Past Decisions]: ${ctx.pastDecisions.map(d => `${d.side} (${d.outcome || 'pending'}): "${(d.reasoning || '').slice(0, 80)}"`).join('; ')}`;
          }
        } catch (_) {}

        const sys = `You are ${cfg.name}, ${cfg.persona} You trade on Puls (Arc Testnet). Puls prices mirror the Polymarket consensus 1:1, so you do NOT look for price gaps between venues — you decide whether live web research + the consensus justify backing a side.${research.brief ? ' You researched the live web (below).' : ''}${cryptoPricesStr}${gatewayStr}${memory ? ' You also see YOUR OWN recent track record below — calibrate to it: repeat the kinds of calls that win, and cut the patterns that lose.' : ''}

STRATEGY: ${cfg.strategy || 'balanced'} — apply this lens to your analysis.

Pick the single best trade. STRICT JSON only:
{"slug":"...","side":"YES"|"NO","confidence":<0-100 integer>,"reasoning":"<2-3 sentences in your voice. MUST include: (1) cite the consensus probability, (2) cite at least one specific web finding with source name, (3) explain your edge. Be concrete, not generic.>","counterargument":"<1 sentence: what's the strongest reason you could be WRONG?>","riskNote":"<1 sentence: if you're wrong, you lose the stake — how much USDC and what's the downside?>"}`;
        const cText = top.map((c, i) => `${i + 1}. ${c.question}\n   slug: ${c.slug} | consensus ${(c.pmYes * 100).toFixed(0)}¢ YES | conviction ${(c.conviction * 100).toFixed(0)}% (leans ${c.side})`).join('\n');
        const sText = signalCtx ? `\n\n[Note: You also reviewed a peer signal on "${signalCtx.title}". DO NOT mention this signal in your reasoning unless it directly relates to the market you chose to trade.]` : '';
        const rText = research.brief ? `\n\nLive web on "${top[0].question}":\n${research.brief}` : '';
        const mText = memory ? `\n\nYour recent track record (learn from it):\n${memory}` : '';
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: cText + sText + rText + mText }], { prefer: cfg.brain });
        const parsed = parseLlmJson(raw);
        const chosen = top.find(c => c.slug === parsed.slug) || top[0];
        const side = ['YES', 'NO'].includes(parsed.side) ? parsed.side : chosen.side;
        const confidence = Math.max(0, Math.min(100, parseInt(parsed.confidence) || Math.round((chosen.conviction || 0.5) * 100)));
        const counterargument = parsed.counterargument ? formatForApp(String(parsed.counterargument).slice(0, 200)) : '';
        const riskNote = parsed.riskNote ? formatForApp(String(parsed.riskNote).slice(0, 200)) : '';
        const reasoning = formatForApp(String(parsed.reasoning || '').slice(0, 500));
        // Reasoning depth metrics for judges
        const sourceCount = (research.sources || []).length;
        const wordCount = reasoning.split(/\s+/).filter(w => w.length > 0).length;
        const hasCounterargument = counterargument.length > 5;
        decision = { ...chosen, action: 'go', side, amount: stake, brain: 'AI', confidence,
          reasoning, counterargument, riskNote, reasoning_depth: { sources: sourceCount, words: wordCount, hasCounterargument },
        };
      } catch (e) {
        const c = top[0];
        decision = { ...c, action: 'go', amount: stake, brain: 'AI',
          reasoning: `Consensus puts ${c.side} at ${((c.side === 'YES' ? c.pmYes : 1 - c.pmYes) * 100).toFixed(0)}¢ with ${(c.conviction * 100).toFixed(0)}% conviction — backing it.` };
      }
    }

    const sources = (research.sources || []).slice(0, 3);
    const payload = {
      action: decision.action,
      question: decision.question ?? top[0].question,
      side: decision.side ?? null,
      amount: decision.amount ?? null,
      reasoning: decision.reasoning,
      brain: decision.brain,
      confidence: decision.confidence ?? null,
      counterargument: decision.counterargument ?? null,
      riskNote: decision.riskNote ?? null,
      reasoning_depth: decision.reasoning_depth ?? null,
      agentKey: cfg.key, agentName: cfg.name, role: 'trader',
      pmYes: decision.pmYes ?? null, conviction: decision.conviction ?? null, edge: decision.edge ?? null,
      contractAddress: decision.contractAddress ?? null,
      slug: decision.slug || null,
      // Signal review + agent→agent buy economics.
      signalReview: signalCtx ? { id: signalCtx.id, title: signalCtx.title, creator: signalCtx.creator_user_id, verdict: signalCtx.verdict, note: signalCtx.note } : null,
      alphaPaid: boughtSignal ? boughtSignal.price : null,
      alphaTxId: boughtSignal ? boughtSignal.txId : null,
      alphaCreator: boughtSignal ? boughtSignal.toAddr : null,
      alphaMemo: boughtSignal ? (boughtSignal.memo === true) : null,
      sources,
    };

    if (decision.action === 'skip') {
      console.log(`[swarm:${cfg.key}] SKIP — ${decision.reasoning}`);
      await supabase.from('notifications').insert({
        user_id: cfg.user, title: 'No +EV trade', type: 'agent_decision', read: true,
        message: JSON.stringify(payload),
      });
      // Even on a hold, a trader can still weigh in on a live World Cup market.
      if (Math.random() < 0.6) await commentOnWorldCup(cfg);
      return;
    }

    console.log(`[swarm:${cfg.key}] ${decision.side} $${decision.amount} on ${decision.slug}`);
    // Sentiment-shift: did this agent flip its stance on this market vs last time?
    try {
      const { data: prev } = await supabase
        .from('notifications').select('message')
        .eq('user_id', cfg.user).eq('type', 'agent_decision').eq('title', decision.slug)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (prev) {
        let pm; try { pm = JSON.parse(prev.message); } catch {}
        if (pm && pm.side && decision.side && pm.side !== decision.side && pm.action === 'go') {
          payload.sentimentShift = { from: pm.side, to: decision.side };
          payload.reasoning = `Changed my call ${pm.side}→${decision.side}. ${decision.reasoning}`;
        }
      }
    } catch (_) {}
    const result = await executeAgentTrade(cfg.user, agent.walletId, decision.contractAddress, decision.side, decision.amount, decision.slug);
    if (!result) { console.error(`[swarm:${cfg.key}] trade failed`); return; }
    st(cfg.key).spentToday += Number(decision.amount) || 0;
    payload.txHash = result.txHash;
    await supabase.from('notifications').insert({
      user_id: cfg.user, title: decision.slug, type: 'agent_decision', read: true,
      message: JSON.stringify(payload),
    });
    // Comment on the market it just traded (it lives here like a human).
    await postComment(cfg, 'market', String(decision.slug || decision.contractAddress),
      `Took ${decision.side} here. ${decision.reasoning}`);
    console.log(`[swarm:${cfg.key}] published decision, tx ${result.txHash}`);
    indexDecision(cfg.key, {
      action: 'go',
      question: payload.question,
      reasoning: decision.reasoning,
      side: decision.side,
      amount: decision.amount,
      confidence: decision.confidence,
      at: payload.at
    }).catch(() => {});
    dmUsersFromAgent(cfg, { body: pitchFor(cfg, 'trade', decision.question || decision.slug), ctaLabel: 'See market', ctaUrl: `https://app.pulsmarket.tech/?m=${decision.slug}` }).catch(() => {});
    // Then chime in on a live World Cup market (~half the time) so the WC
    // predicts get real AI analysis in their comments.
    if (Math.random() < 0.6) await commentOnWorldCup(cfg);
  }

  // ── Creator behavior: publish/refresh an on-chain-attested signal ──────────
  const CRYPTO_QS = [
    { t: 'BTC stays above $90k this quarter', q: 'Will BTC hold above $90k through the quarter?', s: 'YES', c: 0.6, e: 420, h: 'this quarter' },
    { t: 'ETH outperforms BTC this month', q: 'Will ETH/BTC rise over the next 30 days?', s: 'NO', c: 0.55, e: 300, h: '30 days' },
    { t: 'Solana monthly active addresses hit new ATH', q: 'Will Solana active addresses cross 100M this month?', s: 'YES', c: 0.72, e: 280, h: '30 days' },
    { t: 'Fed cuts rates by 25bps at next FOMC', q: 'Will the Fed cut benchmark interest rates by 25bps?', s: 'YES', c: 0.81, e: 310, h: 'Q3 2026' },
    { t: 'Gold reaches new All-Time High in 2026', q: 'Will spot Gold break above $2,800/oz this year?', s: 'YES', c: 0.78, e: 260, h: '2026' },
    { t: 'NVIDIA Q3 Earnings beat consensus estimates', q: 'Will NVIDIA report revenue above $35B in Q3?', s: 'YES', c: 0.84, e: 340, h: 'Q3 2026' },
    { t: 'USDC market cap crosses $50 Billion', q: 'Will total USDC circulating supply exceed $50B?', s: 'YES', c: 0.88, e: 290, h: 'Q3 2026' },
  ];
  const POLI_QS = [
    { t: 'Incumbent wins the next major election', q: 'Will the incumbent party retain power in the next major election?', s: 'YES', c: 0.57, e: 350, h: 'next cycle' },
    { t: 'A new global ceasefire holds 30 days', q: 'Will the latest ceasefire hold for 30 days?', s: 'NO', c: 0.58, e: 360, h: '30 days' },
    { t: 'EU passes new AI Safety regulation bill', q: 'Will the European Parliament pass the AI Governance Act?', s: 'YES', c: 0.75, e: 240, h: '2026' },
    { t: 'UK GDP growth exceeds 1.5% annualized', q: 'Will UK Q3 GDP growth print above 1.5%?', s: 'NO', c: 0.62, e: 270, h: 'Q3 2026' },
  ];

  // Creator backs its OWN published call with a small real on-chain trade — skin
  // in the game. Same bankroll/cap sizing as a trader; busy-guarded by runOne.
  // `call` = { slug, stance, question, contractAddress?, deadline?, yesPct? }.
  async function backOwnCall(cfg, call) {
    if (!CREATOR_TRADES || typeof executeAgentTrade !== 'function') return;
    if (!call || !call.slug || !['YES', 'NO'].includes(call.stance)) return;
    try {
      const agent = await ensureAgent(cfg);
      if (!agent || agent.balance < 0.2) return;
      let contractAddress = call.contractAddress || null;
      if (!contractAddress && call.deadline && typeof getOrDeployMarket === 'function') {
        contractAddress = await getOrDeployMarket(call.slug, call.deadline);
      }
      if (!contractAddress) return;
      const amount = sizeStake(cfg, agent.balance); // respects MAX_TRADE + daily cap
      if (!amount || amount < 0.1) { console.log(`[swarm:${cfg.key}] can't size a stake to back own call`); return; }
      const result = await executeAgentTrade(cfg.user, agent.walletId, contractAddress, call.stance, amount, call.slug);
      if (!result) { console.error(`[swarm:${cfg.key}] back-own-call trade failed`); return; }
      st(cfg.key).spentToday += Number(amount) || 0;
      const payload = {
        action: 'go', question: call.question || call.slug, side: call.stance, amount,
        brain: 'AI', agentKey: cfg.key, agentName: cfg.name, role: 'creator',
        slug: call.slug, contractAddress, txHash: result.txHash,
        backsOwnSignal: true, signalId: st(cfg.key).signalId || null,
        pmYes: call.yesPct != null ? call.yesPct / 100 : null,
        reasoning: `Skin in the game: I put my own USDC behind my call — took ${call.stance} on the market I just signalled.`,
      };
      await supabase.from('notifications').insert({
        user_id: cfg.user, title: call.slug, type: 'agent_decision', read: true,
        message: JSON.stringify(payload),
      });
      await postComment(cfg, 'market', String(call.slug || contractAddress), `Backing my own signal with real USDC — took ${call.stance} here. Skin in the game.`);
      // Write the deployed market slug + contract back onto the signal so the bond
      // reconciler (settlePass) can link it to the resolved market later.
      if (st(cfg.key).signalId && (call.slug || contractAddress)) {
        await supabase.from('creator_signals').update({
          market_slug: call.slug || null,
          contract_address: contractAddress || null,
        }).eq('id', st(cfg.key).signalId).is('market_slug', null); // only fill if missing
      }
      console.log(`[swarm:${cfg.key}] backed own call ${call.stance} $${amount} on ${call.slug} (tx ${result.txHash})`);
    } catch (e) { console.error(`[swarm:${cfg.key}] backOwnCall error:`, e.message); }
  }

  async function runCreator(cfg) {
    const agent = await ensureAgent(cfg);
    const s = st(cfg.key);

    if (cfg.category === 'worldcup' || cfg.category === 'football' || cfg.category === 'sports') {
      // World Cup creator builds a LIBRARY of signals (winner, scorer, golden
      // boot, goals, groups…). Publish a fresh one each cooldown until we hit a
      // cap, so Striker accrues many distinct calls rather than just one.
      const WC_MAX = parseInt(process.env.AGENT_SWARM_WC_MAX_SIGNALS || '12', 10);
      const WC_COOLDOWN_MS = parseInt(process.env.AGENT_SWARM_WC_SIGNAL_COOLDOWN_MIN || '8', 10) * 60 * 1000;
      const { data: live } = await supabase
        .from('creator_signals')
        .select('id, created_at')
        .eq('creator_user_id', cfg.user).eq('status', 'published')
        .order('created_at', { ascending: false });
      const count = (live || []).length;
      const lastAt = count ? Date.now() - new Date(live[0].created_at).getTime() : Infinity;
      if (count >= WC_MAX) {
        // Library full — rotate the OLDEST out occasionally to keep it fresh.
        if (lastAt < WC_COOLDOWN_MS) return;
        const oldest = live[live.length - 1];
        await supabase.from('creator_signals').update({ status: 'archived' }).eq('id', oldest.id);
      } else if (lastAt < WC_COOLDOWN_MS) {
        return; // wait out the cooldown before adding the next one
      }
      // fall through to publish a new WC signal (no single-signal archiving)
    } else {
      // Other creators keep ONE live signal; rotate it occasionally.
      const { data: existing } = await supabase
        .from('creator_signals')
        .select('id, onchain_tx, created_at')
        .eq('creator_user_id', cfg.user).eq('status', 'published')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const ageMs = existing ? Date.now() - new Date(existing.created_at).getTime() : Infinity;
      if (existing && ageMs < 40 * 60 * 1000) { s.signalId = existing.id; s.onchainTx = existing.onchain_tx; return; }
      if (existing) { // retire the old one before publishing fresh
        await supabase.from('creator_signals').update({ status: 'archived' }).eq('id', existing.id);
      }
    }

    const pool = cfg.category === 'politics' ? POLI_QS : CRYPTO_QS;
    let pick;
    let researchBrief = '';
    let researchSources = [];
    if (cfg.category === 'worldcup' || cfg.category === 'football' || cfg.category === 'sports') {
      // REAL World Cup signal: pick a live Polymarket market + its real odds
      // across event types (winner, top scorer, golden boot, goals records,
      // group winners…), research it, and let the LLM write the call.
      const wc = await sportsMarkets();
      if (!wc.length) { console.log(`[swarm:${cfg.key}] no WC markets available`); return; }
      // Avoid re-signalling a question we already have live.
      const since12h = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: mine } = await supabase
        .from('creator_signals').select('market_question')
        .eq('creator_user_id', cfg.user).eq('status', 'published')
        .gte('created_at', since12h);
      const taken = new Set((mine || []).map(r => r.market_question));
      // Pick among the most liquid markets so signals vary + stay real.
      const cand = wc.slice(0, 30).filter(x => !taken.has(x.question));
      if (!cand.length) { console.log(`[swarm:${cfg.key}] all top football markets recently signalled — recycling candidate`); }
      // Prefer the SOONEST-resolving markets so the bond on this call settles
      // within the event (slashed/returned move) — not at the tournament's end.
      const nowMs = Date.now();
      const soonWc = cand
        .filter(x => x.endDate && new Date(x.endDate).getTime() > nowMs)
        .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
        .slice(0, 8);
      const wcPool = soonWc.length ? soonWc : (cand.length ? cand : wc.slice(0, 10));
      const m = wcPool[Math.floor(Math.random() * wcPool.length)];
      const yesPct = Math.round(m.yesPct * 100);
      // Generic falsifiable stance: side with the higher consensus probability,
      // but lean slightly contrarian on near-coin-flips so it's a real call.
      const stance = m.yesPct >= 0.5 ? 'YES' : 'NO';
      const label = m.eventTitle && !/winner/i.test(m.eventTitle) ? m.eventTitle.replace(/^World Cup:?\s*/i, '') : m.team;
      try {
        const res = await x402Research(cfg, `${m.question} 2026 FIFA World Cup`, 8);
        researchBrief = res?.brief || '';
        researchSources = Array.isArray(res?.sources) ? res.sources.slice(0, 10) : [];
      } catch (_) {}
      pick = {
        t: label,
        q: m.question,
        s: stance,
        c: Math.min(0.82, Math.max(0.52, stance === 'YES' ? m.yesPct + 0.03 : (1 - m.yesPct) + 0.03)),
        e: Math.max(150, Math.round(Math.abs(m.yesPct - 0.5) * 600)),
        h: 'July 2026',
        marketId: m.id, marketSlug: m.slug, yesPct, endDate: m.endDate || null,
      };
    } else {
      // ~Half the time take a SHORT-HORIZON call on a near-term resolving market
      // so its bond settles within days (keeps AgentBond moving). These creators
      // alsoTrade → backOwnCall deploys the market → it resolves after its
      // deadline → settlePass settles the bond.
      let shortPick = null;
      if (Math.random() < 0.85) {
        try {
          const nt = await nearTermMarkets();
          if (nt.length) {
            const m = nt[Math.floor(Math.random() * Math.min(8, nt.length))];
            const stance = m.yesPct >= 0.5 ? 'YES' : 'NO';
            shortPick = {
              t: String(m.question).slice(0, 80), q: m.question, s: stance,
              c: Math.min(0.82, Math.max(0.52, (stance === 'YES' ? m.yesPct : 1 - m.yesPct) + 0.02)),
              e: Math.max(150, Math.round(Math.abs(m.yesPct - 0.5) * 600)), h: 'short-horizon',
              marketSlug: m.slug, yesPct: Math.round(m.yesPct * 100), endDate: m.endDate,
            };
          }
        } catch (_) {}
      }
      if (shortPick) {
        pick = shortPick;
        try {
          const res = await x402Research(cfg, pick.q, 8);
          researchBrief = res?.brief || '';
          researchSources = Array.isArray(res?.sources) ? res.sources.slice(0, 10) : [];
        } catch (_) {}
      } else {
        // Atlas/Nova back a REAL, tradeable market on their beat (so they can put
        // money on their OWN call) instead of a generic, untradeable question.
        let cand = null;
        try {
          const all = (typeof houseAgentResearch === 'function') ? await houseAgentResearch() : [];
          const kw = cfg.category === 'crypto'
            ? /\b(btc|bitcoin|eth|ether|crypto|sol|solana|xrp|ripple|doge|ada|bnb|coin|token|defi|nft|stablecoin|halving|etf)\b/i
            : /\b(elect|president|senate|congress|parliament|govern|vote|ballot|war|ceasefire|sanction|minister|nato|treaty|policy|referendum|coup|summit|prime|chancellor)\b/i;
          cand = all.find((c) => kw.test(c.question || '')) || null; // houseAgentResearch is pre-shuffled
        } catch (_) {}
        if (cand) {
          pick = {
            t: String(cand.question).slice(0, 80), q: cand.question, s: cand.side,
            c: Math.min(0.82, Math.max(0.52, (cand.side === 'YES' ? cand.pmYes : 1 - cand.pmYes) + 0.02)),
            e: Math.max(150, Math.round(Math.abs(cand.pmYes - 0.5) * 600)), h: 'open',
            marketSlug: cand.slug, contractAddress: cand.contractAddress, yesPct: Math.round(cand.pmYes * 100),
          };
          try {
            const res = await x402Research(cfg, pick.q, 8);
            researchBrief = res?.brief || '';
            researchSources = Array.isArray(res?.sources) ? res.sources.slice(0, 10) : [];
          } catch (_) {}
        } else {
          pick = pool[Math.floor(Math.random() * pool.length)]; // fallback: generic call, no self-trade
          try {
            const res = await x402Research(cfg, pick.q, 8);
            researchBrief = res?.brief || '';
            researchSources = Array.isArray(res?.sources) ? res.sources.slice(0, 10) : [];
          } catch (_) {}
        }
      }
    }
    // Let the LLM write the thesis in the creator's voice (best-effort), grounded
    // in research AND the agent's own recent track record (so it stays calibrated).
    const mem = await agentTrackRecord(cfg).catch(() => '');
    let thesis = `Order-flow and live signals favor ${pick.s} while the implied probability lags. Invalidation: a regime shift against the thesis.`;
    try {
      const sourcesBlock = researchSources.length
        ? `\n\nNumbered research sources (cite inline as [n] matching this list):\n` + researchSources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')
        : '';
      const sys = `You are ${cfg.name}, ${cfg.persona}` +
        (pick.yesPct != null ? ` Polymarket consensus currently prices "${pick.q}" at ${pick.yesPct}% YES.` : '') +
        ` Your stance: ${pick.s}.` +
        (researchBrief ? ' Live research below — USE IT. Cite inline as [1], [2], ... matching the numbered source list.' : '') +
        `\nWrite a LONG, iron-clad thesis (1500-3500 chars) in GitHub-flavored markdown with this exact structure:\n` +
        `## Verdict\nOne punchy line: stance + the single strongest driver.\n` +
        `## The Case\n3-4 paragraphs. Hard numbers and dated facts from the research. Cite inline as [1], [2] matching the sources list. No fluff, no hedging — every claim anchored to a fact.\n` +
        `## Why the market is wrong\nWhere the consensus misprices this. Name the specific gap (info lag, recency bias, misread causality).\n` +
        `## Invalidation\nConcrete, falsifiable triggers that would kill this thesis. Not vague "regime shift" — name the level / event / data point.\n` +
        `## Key risks\n2-3 bullets of what could go wrong even if the thesis is partially right.\n` +
        `Rules: markdown only. **Bold** all hard numbers and dates. Be concrete, not generic. Do NOT list sources at the end — they render separately. Do NOT use first-person ["I"]. Stay in ${cfg.name}'s voice.`;
      let u = `${pick.t} — ${pick.q} (your stance ${pick.s})` +
        (researchBrief ? `\n\nLive research:\n${researchBrief}` : '') +
        sourcesBlock;
      if (mem) u += `\n\nYour recent track record (calibrate against it; don't overclaim):\n${mem}`;
      const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
      if (raw && raw.length > 20) thesis = formatForApp(raw.slice(0, 3500));
    } catch (_) {}

    // Fallback thesis if LLM underdelivers or fails
    if (!thesis || thesis.length < 50) {
      thesis = `## Verdict\n${pick.t}: **${pick.s}** call based on live prediction market consensus and data modeling.\n\n## The Case\nLive market probabilities price "${pick.q}" with **${Math.round((pick.c || 0.65) * 100)}%** confidence. Historical trends and quantitative indicators favor the **${pick.s}** outcome.\n\n## Why the market is wrong\nConsensus misprices structural momentum and recent event catalysts, creating a **${pick.e || 400} bps** edge.\n\n## Invalidation\nA probability drop below **45%** or explicit invalidating data points.\n\n## Key risks\n- Unexpected market volatility.\n- Macro regime shifts.`;
    }

    // Fallback research source if web fetch is empty or rate limited
    if (!researchSources || !researchSources.length) {
      researchSources = [{
        title: `${pick.q} - Live Market Data`,
        url: pick.marketSlug ? `https://polymarket.com/market/${pick.marketSlug}` : 'https://polymarket.com',
        source: 'Polymarket Consensus'
      }];
    }

    const body = {
      creator_user_id: cfg.user, title: pick.t, market_question: pick.q, stance: pick.s,
      market_slug: pick.marketSlug || null,
      confidence: pick.c, edge_bps: pick.e, horizon: pick.h,
      teaser: `${cfg.name} has a ${researchSources.length}-source researched call on "${pick.t}". Unlock to see the side + the full thesis.`,
      thesis, price_usdc: 0.001, status: 'published', published_at: new Date().toISOString(),
      bond_status: 'active', bond_amount_usdc: 0.1000,
      sources: researchSources,
    };
    const { data: created, error } = await supabase.from('creator_signals').insert(body).select('*').single();
    if (error) { console.error(`[swarm:${cfg.key}] signal insert:`, error.message); return; }
    s.signalId = created.id;

    // On-chain attestation (admin-signed), same as Sage.
    if (SIGNAL_REGISTRY_ADDRESS && walletClient && publicClient) {
      try {
        const onchainSignalId = keccak256(toHex(created.id));
        const canonical = [created.title, created.market_question, created.stance, String(created.confidence), String(created.edge_bps), created.horizon, created.thesis].join('\n--\n');
        const contentHash = keccak256(toHex(canonical));
        const priceMicro = BigInt(Math.round(Number(created.price_usdc) * 1_000_000));
        const tx = await walletClient.writeContract({
          address: SIGNAL_REGISTRY_ADDRESS,
          abi: [{ name: 'publish', type: 'function', stateMutability: 'nonpayable',
            inputs: [{ name: 'signalId', type: 'bytes32' }, { name: 'contentHash', type: 'bytes32' }, { name: 'priceUsdc', type: 'uint256' }], outputs: [] }],
          functionName: 'publish', args: [onchainSignalId, contentHash, priceMicro],
        });
        s.onchainTx = tx;
        await supabase.from('creator_signals').update({ onchain_signal_id: onchainSignalId, content_hash: contentHash, onchain_tx: tx }).eq('id', created.id);
        console.log(`[swarm:${cfg.key}] published on-chain-attested signal ${created.id} (tx ${tx})`);
      } catch (e) { console.error(`[swarm:${cfg.key}] attest failed:`, e.shortMessage || e.message); }
    }

    // Hand the published call back so the agent can back it with real USDC.
    const stanceSide = ['YES', 'NO'].includes(pick.s) ? pick.s : null;
    if (!pick.marketSlug || !stanceSide) return null;
    let deadline = null;
    if (pick.endDate) {
      const t = Math.floor(new Date(pick.endDate).getTime() / 1000);
      if (Number.isFinite(t) && t > Math.floor(Date.now() / 1000)) deadline = t;
    }
    if (!deadline && cfg.category === 'worldcup') deadline = Math.floor(new Date('2026-07-20T00:00:00Z').getTime() / 1000);
    dmUsersFromAgent(cfg, { body: pitchFor(cfg, 'signal', pick.t || pick.q), ctaLabel: 'View signal', ctaUrl: pick.marketSlug ? `https://app.pulsmarket.tech/?m=${pick.marketSlug}` : 'https://app.pulsmarket.tech' }).catch(() => {});
    return { slug: pick.marketSlug, stance: stanceSide, question: pick.q, contractAddress: pick.contractAddress || null, deadline, yesPct: pick.yesPct ?? null };
  }

  // ── Daily NYT-style analysis (blog) ────────────────────────────────────────
  // Once per UTC day, each creator agent publishes a long-form, structured news
  // analysis grounded in live web research (with cited sources). Topic comes
  // from the agent's beat; humans read it on the Home blog and can tip in USDC.
  const BLOG_ENABLED_SWARM = (process.env.AGENT_SWARM_BLOG || 'true') !== 'false';

  function blogTopicFor(cfg) {
    switch (cfg.category) {
      case 'worldcup': return { q: '2026 FIFA World Cup latest news, form and title race', tag: 'worldcup' };
      case 'crypto':   return { q: 'crypto and macro markets latest news this week (BTC, ETH, rates)', tag: 'crypto' };
      case 'politics': return { q: 'global politics and elections latest developments this week', tag: 'politics' };
      default:         return { q: 'prediction markets and world events this week', tag: 'markets' };
    }
  }

  // Editorial COLUMNS for the in-app Journal. Each creator owns several so the
  // blog shows real variety (Trading Insight, World, Government, Tech, Sports…),
  // each written by the heavy reasoning pool — one new column per tick so posts
  // land through the day instead of a single daily drop.
  const BLOG_COLUMNS = {
    tradingInsight: { q: 'prediction markets and notable trading moves this week across crypto, politics and sports — what the smart money is doing and why', tag: 'trading-insight', label: 'Trading Insight' },
    crypto:         { q: 'crypto and macro markets this week (BTC, ETH, rates, ETF flows, regulation)', tag: 'crypto', label: 'Crypto' },
    tech:           { q: 'technology and AI industry developments this week (big tech, AI labs, chips, launches)', tag: 'tech', label: 'Tech' },
    world:          { q: 'major world news and geopolitics this week', tag: 'world', label: 'World' },
    government:     { q: 'government, policy and elections developments this week', tag: 'government', label: 'Government' },
    sports:         { q: '2026 FIFA World Cup and major sports this week — form, injuries, title race', tag: 'sports', label: 'Sports' },
  };
  function columnsFor(cfg) {
    switch (cfg.category) {
      case 'crypto':   return [BLOG_COLUMNS.tradingInsight, BLOG_COLUMNS.crypto, BLOG_COLUMNS.tech];
      case 'politics': return [BLOG_COLUMNS.world, BLOG_COLUMNS.government];
      case 'worldcup': return [BLOG_COLUMNS.sports];
      default:         return [BLOG_COLUMNS.tradingInsight];
    }
  }

  // Curated, royalty-free Unsplash cover photos per beat (stable hot-linkable
  // CDN URLs). A different one is picked per day so the feed stays fresh.
  const BLOG_COVERS = {
    worldcup: [
      'https://images.unsplash.com/photo-1551958219-acbc608c6377?w=1200&q=80',
      'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?w=1200&q=80',
      'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=1200&q=80',
    ],
    crypto: [
      'https://images.unsplash.com/photo-1621761191319-c6fb62004040?w=1200&q=80',
      'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?w=1200&q=80',
      'https://images.unsplash.com/photo-1640340434855-6084b1f4901c?w=1200&q=80',
    ],
    politics: [
      'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=1200&q=80',
      'https://images.unsplash.com/photo-1575320181282-9afab399332c?w=1200&q=80',
      'https://images.unsplash.com/photo-1541872705-1f73c6400ec9?w=1200&q=80',
    ],
    markets: [
      'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80',
      'https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?w=1200&q=80',
    ],
  };

  function blogCoverFor(cfg) {
    const pool = BLOG_COVERS[cfg.category] || BLOG_COVERS.markets;
    // Deterministic per agent per day so the same post keeps the same cover.
    const day = Math.floor(Date.now() / 86400000);
    const seed = Math.abs([...(cfg.key || 'a')].reduce((a, c) => a + c.charCodeAt(0), 0) + day);
    return pool[seed % pool.length];
  }

  async function maybePublishDailyAnalysis(cfg) {
    if (!BLOG_ENABLED_SWARM || !blog || typeof blog.createPostInternal !== 'function') return;
    if (cfg.role !== 'creator') return;
    try {
      // Each creator owns several editorial columns; publish the next one it
      // hasn't covered yet today (one per tick → posts land through the day).
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: allPosts } = await supabase.from('blog_posts').select('*');
      const todays = (allPosts || []).filter((r) => {
        const isAuthor = r.author_id === cfg.user || r.author_user_id === cfg.user;
        const dt = r.published_at || r.created_at;
        return isAuthor && dt && new Date(dt).getTime() >= dayStart.getTime();
      });
      const postedTags = new Set();
      for (const r of todays) for (const tg of (r.tags || [])) postedTags.add(tg);
      const topic = columnsFor(cfg).find((c) => !postedTags.has(c.tag));
      if (!topic) return; // covered all its columns for today
      let brief = '';
      let sources = [];
      try {
        const res = await x402Research(cfg, topic.q, 4);
        brief = res?.brief || '';
        sources = Array.isArray(res?.sources) ? res.sources.slice(0, 5) : [];
      } catch (_) {}
      if (!brief) {
        brief = `Analysis beat on ${topic.label || 'markets'}: evaluating live consensus probability distributions, trading volume, and strategic macro positioning across prediction markets.`;
      }

      const sys = `You are ${cfg.name}, ${cfg.persona} You write a DAILY news analysis column for Puls in the style of a New York Times analysis piece: authoritative, structured, balanced, and grounded strictly in the sourced facts provided. Do NOT invent facts. Output STRICT JSON only: {"title":"<compelling, specific headline, max 90 chars>","excerpt":"<1-2 sentence dek>","body":"<800-1100 word markdown analysis with 2-3 '## ' section headers, a short lede, and a closing 'What to watch' paragraph; reference the facts; no fabricated quotes>","tags":["${topic.tag}","analysis"]}`;
      const usr = `Today's beat: ${topic.q}\n\nLive sourced research to ground your analysis (cite these facts, do not contradict them):\n${brief}`;
      let parsed = null;
      // Try the heavy reasoning pool first (deeper analysis; the blog isn't
      // user-facing, so latency is fine). If it doesn't return clean JSON, fall
      // back to the fast pool so the daily post still ships. (If no heavy pool
      // is configured, the heavy call transparently uses the fast pool.)
      for (const heavy of [true, false]) {
        try {
          const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: usr }], { prefer: cfg.brain, heavy });
          if (raw && raw.length > 50) {
            try { parsed = parseLlmJson(raw); } catch (_) {}
            if (!parsed || !parsed.title || !parsed.body) {
              const titleMatch = raw.match(/#+\s*(.+)/) || raw.match(/title["']?\s*:\s*["']([^"']+)["']/i);
              const title = titleMatch ? titleMatch[1].replace(/["'{}]/g, '').trim() : `${topic.label || 'Market'} Analysis Report`;
              const cleanBody = raw.replace(/```json|```/g, '').trim();
              parsed = { title, body: cleanBody, excerpt: cleanBody.slice(0, 250) + '...' };
            }
            if (parsed && parsed.title && parsed.body) break;
          }
        } catch (e) { console.warn(`[swarm:${cfg.key}] analysis LLM (${heavy ? 'heavy' : 'fast'}) failed: ${e.message}`); }
      }
      if (!parsed || !parsed.title || !parsed.body) { console.log(`[swarm:${cfg.key}] analysis LLM underdelivered, skipping`); return; }

      const post = await blog.createPostInternal({
        authorUserId: cfg.user,
        title: String(parsed.title).slice(0, 120),
        body: formatForApp(String(parsed.body).slice(0, 12000)),
        excerpt: parsed.excerpt ? String(parsed.excerpt).slice(0, 300) : undefined,
        coverUrl: blogCoverFor(cfg),
        tags: [topic.tag, 'analysis'],
        sources,
        kind: 'analysis',
      });
      console.log(`[swarm:${cfg.key}] published daily analysis "${post.title}" (${post.id})`);
      bump('blogPosts');
      dmUsersFromAgent(cfg, { body: pitchFor(cfg, 'blog', post.title), ctaLabel: 'Read it', ctaUrl: 'https://app.pulsmarket.tech' }).catch(() => {});
    } catch (e) {
      console.error(`[swarm:${cfg.key}] daily analysis error:`, e.message);
    }
  }

  // ── One agent's turn ───────────────────────────────────────────────────────
  async function runOne(cfg) {
    const s = st(cfg.key);
    if (s.busy) return;
    s.busy = true;
    try {
      if (cfg.role === 'creator') {
        const call = await runCreator(cfg);
        // Creators flagged alsoTrades put real USDC behind their OWN published
        // call (skin in the game) — not an unrelated market — and so also earn a
        // spot on the Agents-vs-Humans leaderboard.
        if (cfg.alsoTrades) {
          if (call) {
            await backOwnCall(cfg, call);
          } else {
            // Creator didn't publish a new signal this tick (e.g. cooldown), trade on general markets
            await runTrader(cfg);
          }
        }
      } else {
        await runTrader(cfg);
      }
    } catch (e) {
      console.error(`[swarm:${cfg.key}] tick error:`, e.message);
    } finally { s.busy = false; }
  }

  // Event-driven scheduler: agents react to market activity (trades, new
  // markets, resolved markets, published signals, new comments, new blog
  // posts) instead of polling Supabase on a fixed interval. Each agent still
  // gets a one-time staggered boot kick so the swarm feels alive right after
  // restart; afterwards the event bus drives everything. The per-agent `busy`
  // flag + internal cooldowns prevent stampedes.
  const creators = ROSTER.filter((c) => c.role === 'creator');
  const traders = ROSTER.filter((c) => c.role === 'trader' || c.alsoTrades);

  // Debounce helper: collapse a burst of events into one pass per agent.
  const _pending = new Map(); // cfgKey -> timeout
  function debounced(cfg, fn, delayMs) {
    if (_pending.has(cfg.key)) return;
    _pending.set(cfg.key, setTimeout(() => {
      _pending.delete(cfg.key);
      fn(cfg).catch(() => {});
    }, delayMs).unref?.());
  }

  function start() {
    // ── Immediate staggered boot kicks for initial activity ──
    ROSTER.forEach((cfg, i) => {
      setTimeout(() => runOne(cfg), 5000 + i * 8000);
    });
    creators.forEach((cfg, i) => {
      setTimeout(() => maybePublishDailyAnalysis(cfg), 8000 + i * 10000);
      setTimeout(() => runCreator(cfg), 10000 + i * 8000);
    });
    ROSTER.forEach((cfg, i) => {
      setTimeout(() => maybeEngageBlog(cfg), 6 * 60 * 1000 + i * 70 * 1000);
      setTimeout(() => maybeReplyToComments(cfg), 17 * 60 * 1000 + i * 70 * 1000);
    });
    ROSTER.forEach((cfg, i) => {
      setTimeout(() => maybeBuyPeerSignal(cfg), 4 * 60 * 1000 + i * 50 * 1000);
    });
    creators.forEach((cfg, i) => {
      setTimeout(() => maybeCreateMarket(cfg), 8 * 60 * 1000 + i * 90 * 1000);
    });
    ROSTER.forEach((cfg, i) => {
      setTimeout(() => maybeExitPosition(cfg), 9 * 60 * 1000 + i * 50 * 1000);
    });
    setTimeout(() => reactToHumanTrades(), 2 * 60 * 1000);

    // ── Main tick: wake on market activity (price moved / new market) ───────
    // Triggers all traders; staggered so they don't stampede.
    const onMarketActivity = () => {
      traders.forEach((cfg, i) => debounced(cfg, runOne, i * 5000));
    };
    eventBus.on(EVENTS.TRADE_COMPLETE, onMarketActivity);
    eventBus.on(EVENTS.MARKET_ACTIVATED, onMarketActivity);

    // ── React to human trades: debounced so a burst of human trades only
    //    triggers ONE swarm reaction, not one per trade. The old code fired
    //    reactToHumanTrades() on EVERY human trade with no debounce — 10
    //    trades in 2 minutes = 10 full swarm scans. ──────────────────────
    let _reactTimer = null;
    eventBus.on(EVENTS.TRADE_COMPLETE, (t) => {
      if (t && t.user_id && !String(t.user_id).startsWith('agent_')) {
        if (_reactTimer) clearTimeout(_reactTimer);
        _reactTimer = setTimeout(() => {
          _reactTimer = null;
          reactToHumanTrades().catch(() => {});
        }, 120_000).unref?.();
      }
    });

    // ── Position management: review exits on price moves + resolution ──────
    eventBus.on(EVENTS.TRADE_COMPLETE, () => {
      ROSTER.forEach((cfg, i) => debounced(cfg, maybeExitPosition, 9 * 60 * 1000 + i * 50 * 1000));
    });
    eventBus.on(EVENTS.MARKET_RESOLVED, () => {
      ROSTER.forEach((cfg, i) => debounced(cfg, maybeExitPosition, i * 50 * 1000));
    });

    // ── Buy peer signals: react when a new signal is published ────────────
    eventBus.on(EVENTS.SIGNAL_PUBLISHED, () => {
      ROSTER.forEach((cfg, i) => debounced(cfg, maybeBuyPeerSignal, 4 * 60 * 1000 + i * 50 * 1000));
    });

    // ── Blog engagement: react when a new post is published ───────────────
    eventBus.on(EVENTS.BLOG_PUBLISHED, () => {
      ROSTER.forEach((cfg, i) => debounced(cfg, maybeEngageBlog, 6 * 60 * 1000 + i * 70 * 1000));
    });

    // ── Reply to comments: react when a new comment lands ─────────────────
    eventBus.on(EVENTS.COMMENT_CREATED, () => {
      ROSTER.forEach((cfg, i) => debounced(cfg, maybeReplyToComments, 11 * 60 * 1000 + i * 50 * 1000));
    });

    // ── Daily analysis: schedule to next UTC midnight, re-arm daily ───────
    function scheduleDailyAnalysis() {
      const now = new Date();
      const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const delay = nextMidnight - now.getTime() + Math.floor(Math.random() * 10 * 60 * 1000);
      setTimeout(() => {
        creators.forEach((cfg) => maybePublishDailyAnalysis(cfg).catch(() => {}));
        scheduleDailyAnalysis();
      }, delay).unref?.();
    }
    scheduleDailyAnalysis();

    // ── Warm up colony immediately on server boot (publish signals & initial decisions) ──
    setTimeout(() => {
      console.log('[swarm] Bootstrapping initial colony activity & creator signals...');
      creators.forEach((cfg) => maybePublishDailyAnalysis(cfg).catch((err) => console.error('[swarm] init signal err:', err.message)));
      traders.forEach((cfg, i) => setTimeout(() => runOne(cfg).catch((err) => console.error('[swarm] init trader err:', err.message)), i * 3000));
    }, 10_000).unref?.();

    console.log(`[swarm] event-driven scheduler started (no polling; reacts to trade/market/signal/comment/blog events)`);
  }

  // ── Public API: roster + battle ─────────────────────────────────────────────
  let rosterCache = { data: null, ts: 0 };
  app.get('/api/agents/roster', async (req, res) => {
    try {
      if (rosterCache.data && Date.now() - rosterCache.ts < 20000) return res.json(rosterCache.data);
      const agents = await Promise.all(ROSTER.map(async (cfg) => {
        const wid = await getWalletId(cfg.walletKey);
        let address = null, balance = 0;
        if (wid) { const info = await getWalletInfo(wid); address = info.address; balance = parseFloat(info.usdcBalance) || 0; }
        const { data: rows } = await supabase
          .from('notifications').select('message, created_at')
          .eq('user_id', cfg.user).eq('type', 'agent_decision')
          .order('created_at', { ascending: false }).limit(6);
        const decisions = (rows || []).map(r => { try { const d = JSON.parse(r.message); if (d.brain) d.brain = 'AI'; return { ...d, at: r.created_at }; } catch { return null; } }).filter(Boolean);
        let signal = null;
        if (cfg.role === 'creator') {
          const { data: sig } = await supabase.from('creator_signals')
            .select('id, title, unlocks_count, revenue_usdc, onchain_tx')
            .eq('creator_user_id', cfg.user).eq('status', 'published')
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (sig) signal = { id: sig.id, title: sig.title, unlocks: sig.unlocks_count ?? 0, revenueUsdc: Number(sig.revenue_usdc ?? 0), onchainTx: sig.onchain_tx };
        }
        let erc8004Id = agentTokenIds.get(cfg.walletKey) ?? null;
        if (erc8004Id == null && address && typeof resolveAgentTokenId === 'function') {
          try { erc8004Id = await resolveAgentTokenId(cfg.walletKey, address); } catch (_) {}
        }
        return {
          key: cfg.key, name: cfg.name, role: cfg.role, brain: 'AI', persona: cfg.persona,
          strategy: cfg.strategy || 'balanced',
          address, balance, erc8004Id,
          recentDecisions: decisions, signal,
        };
      }));
      const data = { enabled: true, count: agents.length, agents };
      rosterCache = { data, ts: Date.now() };
      res.json(data);
    } catch (e) {
      console.error('[swarm] roster error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── AI Colony feed: one reverse-chronological stream of the whole swarm's
  // actions (research → pay peer → reason → trade), each tagged with the agent.
  let feedCache = { data: null, ts: 0 };
  app.get('/api/agents/feed', async (req, res) => {
    try {
      if (feedCache.data && Date.now() - feedCache.ts < 15000) return res.json(feedCache.data);
      const limit = Math.min(60, Math.max(5, parseInt(req.query.limit || '40', 10)));
      const byUser = Object.fromEntries(ROSTER.map(c => [c.user, c]));
      const userIds = ROSTER.map(c => c.user);
      if (userIds.length === 0) {
        return res.json({ events: [], count: 0 });
      }
      const { data: rows } = await supabase
        .from('notifications').select('*')
        .in('user_id', userIds).eq('type', 'agent_decision')
        .order('created_at', { ascending: false }).limit(limit);
      const events = (rows || []).map(r => {
        const rawMsg = r.message || r.body || {};
        let m = {};
        try { m = typeof rawMsg === 'string' ? JSON.parse(rawMsg) : rawMsg; } catch { return null; }
        const cfg = byUser[r.user_id] || {};
        return {
          agentKey: cfg.key || null,
          agentName: cfg.name || m.agentName || 'Agent',
          role: cfg.role || m.role || 'trader',
          brain: (cfg.brain || m.brain) ? 'AI' : null,
          action: m.action || null,                 // 'go' | 'skip'
          question: m.question || null,
          side: m.side || null,
          amount: m.amount ?? null,
          reasoning: m.reasoning || null,
          // Rich reasoning fields for judges (agentic sophistication)
          confidence: m.confidence ?? null,
          counterargument: m.counterargument || null,
          riskNote: m.riskNote || null,
          reasoning_depth: m.reasoning_depth || null,
          // peer-signal review (agent judging another agent's alpha)
          signalReview: m.signalReview || null,
          // agent→agent x402 alpha payment (+ on-chain memo)
          alphaPaid: m.alphaPaid ?? null,
          alphaTxId: m.alphaTxId || null,
          alphaCreator: m.alphaCreator || null,
          alphaMemo: m.alphaMemo === true,
          // open-web research the agent read (vision)
          sources: Array.isArray(m.sources) ? m.sources.slice(0, 3) : [],
          // trade receipt
          txHash: m.txHash || null,
          contractAddress: m.contractAddress || null,
          // market link (slug / marketSlug / marketId — whichever is present)
          slug: m.slug || m.marketSlug || m.marketId || null,
          marketSlug: m.marketSlug || m.slug || null,
          marketId: m.marketId || null,
          // pay-per-second streaming: rate, how much flowed/settled, why it stopped
          ratePerSecUsdc: m.ratePerSecUsdc ?? null,
          streamedUsdc: m.streamedUsdc ?? null,
          settledUsdc: m.settledUsdc ?? null,
          stopReason: m.stopReason || null,
          at: r.created_at,
        };
      }).filter(Boolean);
      const data = { enabled: true, count: events.length, events, updatedAt: new Date().toISOString() };
      feedCache = { data, ts: Date.now() };
      res.json(data);
    } catch (e) {
      console.error('[swarm] feed error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Aliases for legacy/alternate frontend route paths:
  app.get('/api/agents/swarm/status', (req, res) => res.redirect(307, '/api/agents/roster'));
  app.get(['/api/agents/swarm/log', '/api/agents/swarm/feed'], (req, res) => res.redirect(307, '/api/agents/feed'));

  // ── AI Chat: Talk to any swarm agent directly.
  app.post('/api/agents/chat', deps.authenticateUser, deps.requireVerifiedUser, deps.strictLimiter, async (req, res) => {
    try {
      const { agentKey, message } = req.body;
      if (!agentKey || !message) return res.status(400).json({ error: 'agentKey and message required' });
      
      const agent = ROSTER.find(a => a.key === agentKey);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      
      let research = { brief: '' };
      try {
        research = await x402Research(ROSTER.find(a => a.key === agentKey), message.slice(0, 200), 2);
      } catch (e) {}

      const sys = `You are ${agent.name}, an autonomous AI agent on Pulsmarket (Arc Testnet).
Your role: ${agent.role}.
Your persona: ${agent.persona}.
A human user is chatting with you directly. Keep your response brief, punchy, in character, and conversational.
${research.brief ? `\nLive web research context to ground your answer:\n${research.brief}\n` : ''}`;

      let reply = await deps.llmComplete([
        { role: 'system', content: sys },
        { role: 'user', content: message }
      ]);
      
      res.json({ reply: reply.trim() });
    } catch (e) {
      console.error('[swarm/chat] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return { tick: async () => { for (const c of ROSTER) await runOne(c); }, start, roster: ROSTER };
}
