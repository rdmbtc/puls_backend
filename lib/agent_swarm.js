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

// Default roster. Override per-agent model via env AGENT_SWARM_MODEL_<KEY>.
// `brain` is a substring matched against the LLM pool model ids (prefer-first,
// still falls back through the whole pool). Personas drive distinct behavior.
const DEFAULT_ROSTER = [
  // ── Trader agents (distinct strategies + brains) ──
  {
    key: 'vega', name: 'Vega ⚡', role: 'trader', brain: 'gpt-oss',
    category: null, minEdge: 0.03, riskMult: 1.4,
    persona: 'an aggressive momentum trader who hunts the biggest mispricings and presses winners hard. Bold, fast, concise.',
  },
  {
    key: 'cygnus', name: 'Cygnus 🛡️', role: 'trader', brain: 'mistral',
    category: null, minEdge: 0.07, riskMult: 0.6,
    persona: 'a conservative value trader who only acts on high-conviction, large edges and sizes small. Skeptical, disciplined.',
  },
  {
    key: 'orion', name: 'Orion 🔭', role: 'trader', brain: 'deepseek',
    category: null, minEdge: 0.05, riskMult: 1.0,
    persona: 'a balanced quant who weighs web sentiment against on-chain price gaps and explains the convergence trade clearly.',
  },
  // ── Creator agents (publish signals, earn from buyers) ──
  {
    key: 'atlas', name: 'Atlas 📈', role: 'creator', brain: 'gemini',
    category: 'crypto', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    persona: 'a crypto/macro forecaster who publishes sharp, falsifiable signals with clear invalidation levels.',
  },
  {
    key: 'nova', name: 'Nova 🌐', role: 'creator', brain: 'mistral',
    category: 'politics', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    persona: 'a world-events analyst who turns live news into calibrated probability calls.',
  },
  {
    key: 'striker', name: 'Striker ⚽', role: 'creator', brain: 'gemini',
    category: 'worldcup', alsoTrades: true, minEdge: 0.05, riskMult: 1.0,
    persona: 'a football analyst for the 2026 FIFA World Cup who turns live Polymarket odds + form/news into sharp, falsifiable calls with clear invalidation — and backs his own calls with small trades.',
  },
];

export function buildSwarmRoster() {
  const enabled = (process.env.AGENT_SWARM || 'false') === 'true';
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
    resolveAgentTokenId, recordAgentReputation, agentTokenIds,
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
    if (MEMO_ENABLED) {
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
  const DAILY_CAP = parseFloat(process.env.AGENT_SWARM_DAILY_CAP || '3');
  const INTERVAL_MIN = Math.max(3, parseInt(process.env.AGENT_SWARM_INTERVAL_MIN || '12', 10));
  const ALPHA_PRICE = parseFloat(process.env.AGENT_SWARM_ALPHA_PRICE || '0.001') || 0.001;
  const BOOTSTRAP_USDC = parseFloat(process.env.AGENT_SWARM_BOOTSTRAP_USDC || '1');

  if (ROSTER.length === 0) {
    console.log('[swarm] disabled (set AGENT_SWARM=true to enable)');
    return { tick: async () => {}, roster: [] };
  }
  console.log(`[swarm] ${ROSTER.length} agent(s): ${ROSTER.map(a => `${a.name}(${a.role}/${a.brain})`).join(', ')}`);

  const usdcTransferAbi = [{
    name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }],
  }];

  // ── Lifecycle: wallet + profile + ERC-8004, bootstrap-funded once ──────────
  async function ensureAgent(cfg) {
    const s = st(cfg.key);
    let walletId = await getWalletId(cfg.walletKey);
    if (!walletId) {
      const setId = await ensureWalletSet();
      const createRes = await circle.createWallets({
        accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
      });
      walletId = createRes.data.wallets[0].id;
      await saveWallet(cfg.walletKey, walletId);
      console.log(`[swarm:${cfg.key}] created wallet`);
    }
    let info = await getWalletInfo(walletId);
    let balance = parseFloat(info.usdcBalance) || 0;

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
    }

    // ERC-8004 identity (idempotent; needs a little USDC for gas-as-USDC).
    if (!s.registered) {
      const existing = await resolveAgentTokenId(cfg.walletKey, info.address);
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
    const remainingDaily = Math.max(0, DAILY_CAP - s.spentToday);
    if (remainingDaily < 0.1) return 0;
    const streakMult = s.streak >= 3 ? 1.4 : s.streak === 2 ? 1.2 : s.streak <= -1 ? 0.6 : 1.0;
    let stake = (balance - 0.1) * 0.12 * (cfg.riskMult || 1) * streakMult;
    stake = Math.min(stake, MAX_TRADE, remainingDaily);
    stake = Math.floor(stake * 10) / 10;
    return stake >= 0.1 ? stake : 0;
  }

  // ── Live World Cup 2026 markets (real Polymarket consensus odds) ───────────
  // Used by the football creator to ground signals in real prices, and by
  // traders to comment on real WC predicts. Cached ~5 min.
  let _wcCache = { at: 0, markets: [] };
  async function worldCupMarkets() {
    if (Date.now() - _wcCache.at < 5 * 60 * 1000 && _wcCache.markets.length) return _wcCache.markets;
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
          volume: parseFloat(m.volume || '0') || 0,
        });
      }
    };
    try {
      // All live World Cup events (winner, top scorer, golden boot/ball, goals
      // records, group winners, player goals, etc.) — real Polymarket markets.
      const r = await fetch('https://gamma-api.polymarket.com/events?limit=60&closed=false&active=true&order=volume&ascending=false&tag_slug=world-cup', { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const events = await r.json();
        for (const ev of (events || [])) pushFromEvent(ev);
      }
      // Always include the flagship winner event explicitly (in case the tag
      // page paginated it out).
      if (!out.some(m => m.slug?.includes('win-the-2026-fifa-world-cup'))) {
        const r2 = await fetch('https://gamma-api.polymarket.com/events?slug=world-cup-winner', { headers: { Accept: 'application/json' } });
        if (r2.ok) { const e2 = await r2.json(); if (e2?.[0]) pushFromEvent(e2[0]); }
      }
    } catch (_) {}
    // De-dup by market id, keep liquid/contested ones first.
    const seen = new Set();
    const uniq = out.filter(m => (m.id && !seen.has(m.id)) ? seen.add(m.id) : false);
    uniq.sort((a, b) => b.volume - a.volume);
    if (uniq.length) _wcCache = { at: Date.now(), markets: uniq };
    return uniq;
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
      .limit(8);
    if (!rows || !rows.length) return null;
    return rows[Math.floor(Math.random() * Math.min(rows.length, 4))];
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
      supabase.from('signal_unlocks').insert({
        user_id: cfg.user, signal_id: signal.id, status: 'confirmed',
        amount_usdc: price, tx_id: txId, confirmed_at: new Date().toISOString(),
      }).then(({ error }) => { if (error && !String(error.message).includes('duplicate')) console.warn(`[swarm:${cfg.key}] unlock insert:`, error.message); });
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

  // Post a public comment from the agent (reuses the comments table directly).
  async function postComment(cfg, targetType, targetId, body) {
    try {
      await supabase.from('comments').insert({
        user_id: cfg.user, target_type: targetType, target_id: targetId, body: String(body).slice(0, 500),
      });
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
      try { const r = await researchQuestion(`${m.team} 2026 World Cup form chances`, 2); brief = r?.brief || ''; } catch (_) {}
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
      const since = new Date(Math.max(reactSince, Date.now() - 30 * 60 * 1000)).toISOString();
      const { data: trades } = await supabase
        .from('trades')
        .select('id, user_id, market_id, side, created_at')
        .like('user_id', 'supabase_%')        // real humans (not agent_*/eth_*)
        .eq('state', 'COMPLETE')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20);
      const traders = ROSTER.filter((c) => c.role === 'trader' || c.alsoTrades);
      if (!traders.length) return;
      let done = 0;
      for (const ht of (trades || [])) {
        if (done >= REACT_MAX_PER_CYCLE) break;
        if (!ht.market_id || reactedHumanTrades.has(ht.id)) continue;
        reactedHumanTrades.add(ht.id);
        const { data: dm } = await supabase
          .from('deployed_markets').select('slug, resolved')
          .eq('contract_address', ht.market_id).maybeSingle();
        if (!dm || !dm.slug || dm.resolved) continue;
        const question = dm.slug.replace(/-/g, ' ');
        const humanSide = ht.side === 'NO' ? 'NO' : 'YES';
        const cfg = traders[Math.floor(Math.random() * traders.length)];
        const agent = await ensureAgent(cfg);
        if (!agent || agent.balance < REACT_STAKE + 0.05) continue;

        let mySide = humanSide, comment = '';
        try {
          let brief = '';
          try { const r = await researchQuestion(question, 2); brief = r?.brief || ''; } catch (_) {}
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
  const AGENT_CREATE_MARKETS = (process.env.AGENT_SWARM_CREATE_MARKETS || 'true') !== 'false';
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
      try { const r = await researchQuestion(topic.q, 3); brief = r?.brief || ''; sources = Array.isArray(r?.sources) ? r.sources.slice(0, 4) : []; } catch (_) {}
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
          await postComment(cfg, 'market', String(contract), `Closed my ${side} to ${act} at ${(sideP * 100).toFixed(0)}¢.`);
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

      // Comment in the agent's voice.
      let text;
      try {
        const sys = `You are ${cfg.name}, ${cfg.persona} You just read a blog post on Puls and are leaving ONE sharp, substantive sentence in the comments — agree, push back, or add a fact. Plain text, no preamble.`;
        const u = `Post: "${post.title}"\n${post.excerpt || ''}`;
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
        text = formatForApp(String(raw || '').slice(0, 240));
      } catch (_) {
        text = `Sharp read on "${post.title}" — adds useful signal for anyone trading this.`;
      }
      if (text && text.length > 8) {
        await postComment(cfg, 'blog', post.id, text);
        console.log(`[swarm:${cfg.key}] commented on blog ${post.id}`);
      }

      // Tip the author (agent→human or agent→agent) if we can pay.
      if (agent.balance > BLOG_TIP_USDC + 0.05) {
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

  // ── Trader behavior ────────────────────────────────────────────────────────
  async function runTrader(cfg) {
    const agent = await ensureAgent(cfg);
    if (agent.balance < 0.2) { console.log(`[swarm:${cfg.key}] balance ${agent.balance} too low`); return; }

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
    const top = candidates.slice(0, 5);
    let research = { brief: '', sources: [] };
    try { research = await researchQuestion(top[0].question, 3); } catch (_) {}

    const stake = sizeStake(cfg, agent.balance);
    const bestEdge = top[0].edge;

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
        const sys = `You are ${cfg.name}, ${cfg.persona} You trade on Puls (Arc Testnet). Puls prices mirror the Polymarket consensus 1:1, so you do NOT look for price gaps between venues — you decide whether live web research + the consensus justify backing a side.${signalCtx ? ` You just reviewed a peer agent's signal (below) and decided to ${signalCtx.verdict} it.` : ''}${research.brief ? ' You researched the live web (below).' : ''} Pick the single best trade. STRICT JSON only: {"slug":"...","side":"YES"|"NO","reasoning":"<2 sentences in your voice, cite the consensus probability + your web finding — never compare on-chain vs Polymarket prices>"}`;
        const cText = top.map((c, i) => `${i + 1}. ${c.question}\n   slug: ${c.slug} | consensus ${(c.pmYes * 100).toFixed(0)}¢ YES | conviction ${(c.conviction * 100).toFixed(0)}% (leans ${c.side})`).join('\n');
        const sText = signalCtx ? `\n\nPeer signal you ${signalCtx.verdict}: ${signalCtx.title} — ${signalCtx.stance}. ${signalCtx.thesis}` : '';
        const rText = research.brief ? `\n\nLive web on "${top[0].question}":\n${research.brief}` : '';
        const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: cText + sText + rText }], { prefer: cfg.brain });
        const parsed = parseLlmJson(raw);
        const chosen = top.find(c => c.slug === parsed.slug) || top[0];
        const side = ['YES', 'NO'].includes(parsed.side) ? parsed.side : chosen.side;
        decision = { ...chosen, action: 'go', side, amount: stake, brain: 'AI', reasoning: formatForApp(String(parsed.reasoning || '').slice(0, 400)) };
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
      agentKey: cfg.key, agentName: cfg.name, role: 'trader',
      pmYes: decision.pmYes ?? null, conviction: decision.conviction ?? null, edge: decision.edge ?? null,
      contractAddress: decision.contractAddress ?? null,
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
    await postComment(cfg, 'market', String(decision.contractAddress),
      `Took ${decision.side} here. ${decision.reasoning}`);
    console.log(`[swarm:${cfg.key}] published decision, tx ${result.txHash}`);
    // Then chime in on a live World Cup market (~half the time) so the WC
    // predicts get real AI analysis in their comments.
    if (Math.random() < 0.6) await commentOnWorldCup(cfg);
  }

  // ── Creator behavior: publish/refresh an on-chain-attested signal ──────────
  const CRYPTO_QS = [
    { t: 'BTC stays above $90k this quarter', q: 'Will BTC hold above $90k through the quarter?', s: 'YES', c: 0.6, e: 420, h: 'this quarter' },
    { t: 'ETH outperforms BTC this month', q: 'Will ETH/BTC rise over the next 30 days?', s: 'NO', c: 0.55, e: 300, h: '30 days' },
  ];
  const POLI_QS = [
    { t: 'Incumbent wins the next major election', q: 'Will the incumbent party retain power in the next major election?', s: 'YES', c: 0.57, e: 350, h: 'next cycle' },
    { t: 'A new global ceasefire holds 30 days', q: 'Will the latest ceasefire hold for 30 days?', s: 'NO', c: 0.58, e: 360, h: '30 days' },
  ];

  async function runCreator(cfg) {
    const agent = await ensureAgent(cfg);
    const s = st(cfg.key);

    if (cfg.category === 'worldcup') {
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
      if (existing && ageMs < 6 * 60 * 60 * 1000) { s.signalId = existing.id; s.onchainTx = existing.onchain_tx; return; }
      if (existing) { // retire the old one before publishing fresh
        await supabase.from('creator_signals').update({ status: 'archived' }).eq('id', existing.id);
      }
    }

    const pool = cfg.category === 'politics' ? POLI_QS : CRYPTO_QS;
    let pick;
    let researchBrief = '';
    let researchSources = [];
    if (cfg.category === 'worldcup') {
      // REAL World Cup signal: pick a live Polymarket market + its real odds
      // across event types (winner, top scorer, golden boot, goals records,
      // group winners…), research it, and let the LLM write the call.
      const wc = await worldCupMarkets();
      if (!wc.length) { console.log(`[swarm:${cfg.key}] no WC markets available`); return; }
      // Avoid re-signalling a question we already have live.
      const { data: mine } = await supabase
        .from('creator_signals').select('market_question')
        .eq('creator_user_id', cfg.user).eq('status', 'published');
      const taken = new Set((mine || []).map(r => r.market_question));
      // Pick among the most liquid markets so signals vary + stay real.
      const cand = wc.slice(0, 30).filter(x => !taken.has(x.question));
      if (!cand.length) { console.log(`[swarm:${cfg.key}] all top WC markets already signalled`); return; }
      const m = cand[Math.floor(Math.random() * cand.length)];
      const yesPct = Math.round(m.yesPct * 100);
      // Generic falsifiable stance: side with the higher consensus probability,
      // but lean slightly contrarian on near-coin-flips so it's a real call.
      const stance = m.yesPct >= 0.5 ? 'YES' : 'NO';
      const label = m.eventTitle && !/winner/i.test(m.eventTitle) ? m.eventTitle.replace(/^World Cup:?\s*/i, '') : m.team;
      try {
        const res = await researchQuestion(`${m.question} 2026 FIFA World Cup`, 3);
        researchBrief = res?.brief || '';
        researchSources = Array.isArray(res?.sources) ? res.sources.slice(0, 4) : [];
      } catch (_) {}
      pick = {
        t: `${label} — 2026 World Cup`,
        q: m.question,
        s: stance,
        c: Math.min(0.82, Math.max(0.52, stance === 'YES' ? m.yesPct + 0.03 : (1 - m.yesPct) + 0.03)),
        e: Math.max(150, Math.round(Math.abs(m.yesPct - 0.5) * 600)),
        h: 'July 2026',
        marketId: m.id, marketSlug: m.slug, yesPct,
      };
    } else {
      pick = pool[Math.floor(Math.random() * pool.length)];
    }
    // Let the LLM write the thesis in the creator's voice (best-effort).
    let thesis = `Order-flow and live signals favor ${pick.s} while the implied probability lags. Invalidation: a regime shift against the thesis.`;
    try {
      const sys = cfg.category === 'worldcup'
        ? `You are ${cfg.name}, ${cfg.persona} Polymarket consensus currently prices "${pick.q}" at ${pick.yesPct}% YES.${researchBrief ? ' Live research below.' : ''} Write a sharp 2-sentence falsifiable ${pick.s} thesis with a clear invalidation (form, injuries, or draw). Plain text only.`
        : `You are ${cfg.name}, ${cfg.persona} Write a 2-sentence falsifiable thesis (with an invalidation level) for this prediction. Plain text only.`;
      const u = cfg.category === 'worldcup'
        ? `${pick.t} — ${pick.q} (your stance ${pick.s})${researchBrief ? `\n\nLive research:\n${researchBrief}` : ''}`
        : `${pick.t} — ${pick.q} (stance ${pick.s})`;
      const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: u }], { prefer: cfg.brain });
      if (raw && raw.length > 20) thesis = formatForApp(raw.slice(0, 600));
    } catch (_) {}

    const body = {
      creator_user_id: cfg.user, title: pick.t, market_question: pick.q, stance: pick.s,
      market_slug: pick.marketSlug || null,
      confidence: pick.c, edge_bps: pick.e, horizon: pick.h,
      teaser: `${cfg.name} has a research-backed call on "${pick.t}". Unlock to see the side + the full thesis.`,
      thesis, price_usdc: 0.001, status: 'published', published_at: new Date().toISOString(),
      sources: researchSources.length ? researchSources : null,
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
      // One post per agent per UTC day.
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: today } = await supabase
        .from('blog_posts')
        .select('id')
        .eq('author_user_id', cfg.user)
        .gte('published_at', dayStart.toISOString())
        .limit(1);
      if (today && today.length) return; // already posted today

      const topic = blogTopicFor(cfg);
      let brief = '';
      let sources = [];
      try {
        const res = await researchQuestion(topic.q, 4);
        brief = res?.brief || '';
        sources = Array.isArray(res?.sources) ? res.sources.slice(0, 5) : [];
      } catch (_) {}
      if (!brief) { console.log(`[swarm:${cfg.key}] no research for daily analysis, skipping`); return; }

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
          parsed = parseLlmJson(raw);
          if (parsed && parsed.title && parsed.body) break;
        } catch (e) { console.warn(`[swarm:${cfg.key}] analysis LLM (${heavy ? 'heavy' : 'fast'}) failed: ${e.message}`); }
      }
      if (!parsed || !parsed.title || !parsed.body) { console.log(`[swarm:${cfg.key}] analysis parse failed, skipping`); return; }

      const post = await blog.createPostInternal({
        authorUserId: cfg.user,
        title: String(parsed.title).slice(0, 120),
        body: formatForApp(String(parsed.body).slice(0, 12000)),
        excerpt: parsed.excerpt ? String(parsed.excerpt).slice(0, 300) : undefined,
        coverUrl: blogCoverFor(cfg),
        tags: Array.isArray(parsed.tags) ? parsed.tags : [topic.tag, 'analysis'],
        sources,
        kind: 'analysis',
      });
      console.log(`[swarm:${cfg.key}] published daily analysis "${post.title}" (${post.id})`);
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
        await runCreator(cfg);
        // Creators flagged alsoTrades back their calls with real trades, so they
        // also earn a spot on the Agents-vs-Humans leaderboard.
        if (cfg.alsoTrades) await runTrader(cfg);
      } else {
        await runTrader(cfg);
      }
    } catch (e) {
      console.error(`[swarm:${cfg.key}] tick error:`, e.message);
    } finally { s.busy = false; }
  }

  // Staggered scheduler: spread agents across the interval so they act at
  // different times (feels alive, avoids nonce/rate collisions).
  function start() {
    ROSTER.forEach((cfg, i) => {
      const offsetMs = 60 * 1000 + i * 90 * 1000;            // first run, staggered
      const periodMs = INTERVAL_MIN * 60 * 1000 + i * 17000;  // de-sync periods
      setTimeout(() => { runOne(cfg); setInterval(() => runOne(cfg), periodMs); }, offsetMs);
    });
    // Daily blog analyses: creators each publish one NYT-style post per UTC day.
    // Check ~every 3h (staggered) so a fresh post lands daily and self-heals on
    // restart; maybePublishDailyAnalysis() is idempotent per agent per day.
    const creators = ROSTER.filter((c) => c.role === 'creator');
    creators.forEach((cfg, i) => {
      const firstMs = 3 * 60 * 1000 + i * 45 * 1000;          // shortly after boot
      const everyMs = 3 * 60 * 60 * 1000 + i * 60 * 1000;     // ~3h, de-synced
      setTimeout(() => {
        maybePublishDailyAnalysis(cfg);
        setInterval(() => maybePublishDailyAnalysis(cfg), everyMs);
      }, firstMs);
    });
    // Blog engagement: every agent reads a peer's post, comments, and tips the
    // author via x402 (agent→human + agent→agent). Staggered ~40m.
    ROSTER.forEach((cfg, i) => {
      const firstMs = 6 * 60 * 1000 + i * 70 * 1000;
      const everyMs = 40 * 60 * 1000 + i * 23000;
      setTimeout(() => {
        maybeEngageBlog(cfg);
        setInterval(() => maybeEngageBlog(cfg), everyMs);
      }, firstMs);
    });
    // Autonomous market creation: creator agents open a fresh market from their
    // research (swarm-wide daily cap inside maybeCreateMarket). ~Every 2h.
    creators.forEach((cfg, i) => {
      const firstMs = 8 * 60 * 1000 + i * 90 * 1000;
      const everyMs = 2 * 60 * 60 * 1000 + i * 40000;
      setTimeout(() => {
        maybeCreateMarket(cfg);
        setInterval(() => maybeCreateMarket(cfg), everyMs);
      }, firstMs);
    });
    // Position management: traders review open positions and sell to take profit
    // or cut losses. ~Every 18m, staggered.
    ROSTER.forEach((cfg, i) => {
      const firstMs = 9 * 60 * 1000 + i * 50 * 1000;
      const everyMs = 18 * 60 * 1000 + i * 13000;
      setTimeout(() => {
        maybeExitPosition(cfg);
        setInterval(() => maybeExitPosition(cfg), everyMs);
      }, firstMs);
    });
    // React to humans: notice real human trades and respond (public comment +
    // small confirm/fade position). Swarm-wide, ~every 5m, starts soon after boot.
    setTimeout(() => {
      reactToHumanTrades();
      setInterval(reactToHumanTrades, 5 * 60 * 1000 + 7000);
    }, 2 * 60 * 1000);
    console.log(`[swarm] scheduler started (interval ~${INTERVAL_MIN}m, staggered; daily blog analyses + blog engagement + market creation + position exits + react-to-humans on)`);
  }

  // ── Public API: roster + battle ─────────────────────────────────────────────
  let rosterCache = { data: null, ts: 0 };
  app.get('/api/agents/roster', async (req, res) => {
    try {
      if (rosterCache.data && Date.now() - rosterCache.ts < 20000) return res.json(rosterCache.data);
      const agents = [];
      for (const cfg of ROSTER) {
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
        agents.push({
          key: cfg.key, name: cfg.name, role: cfg.role, brain: 'AI', persona: cfg.persona,
          address, balance, erc8004Id: agentTokenIds.get(cfg.walletKey) ?? null,
          recentDecisions: decisions, signal,
        });
      }
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
      const { data: rows } = await supabase
        .from('notifications').select('user_id, message, created_at')
        .in('user_id', userIds).eq('type', 'agent_decision')
        .order('created_at', { ascending: false }).limit(limit);
      const events = (rows || []).map(r => {
        let m = {}; try { m = JSON.parse(r.message); } catch { return null; }
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

  return { tick: async () => { for (const c of ROSTER) await runOne(c); }, start, roster: ROSTER };
}
