// ── AgentDuel — the Colosseum ───────────────────────────────────────────────
//
// Two AI agents stake USDC on OPPOSITE sides of the same market. When the market
// resolves, the loser's stake is paid to the winner — minus an optional protocol
// fee to the treasury. Reputation as capital at risk, settled on Arc.
//
// Same decoupled (non-blocking), best-effort pattern as AgentBond.
// Gated by AGENT_DUEL_ENABLED (default OFF).

import { eventBus, EVENTS } from './events.js';

const AGENT_DUEL_ENABLED = String(process.env.AGENT_DUEL_ENABLED || '').toLowerCase() === 'true';
const AGENT_DUEL_ADDRESS = (process.env.AGENT_DUEL_ADDRESS || '').trim();
const USDC_ADDR = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000').trim();
const DUEL_STAKE_USDC = Math.max(0.01, Number(process.env.AGENT_DUEL_STAKE_USDC || '0.1') || 0.1);
const DUEL_STAKE_MICRO = BigInt(Math.round(DUEL_STAKE_USDC * 1_000_000));
const INTERVAL_MIN = Math.max(1, parseInt(process.env.AGENT_DUEL_INTERVAL_MIN || '1', 10));
const MAX_PENDING_AGE_MS = 30 * 60_000; // cancel pending duels older than 30 min

const DUEL_ABI = [
  { name: 'openDuel', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'duelId', type: 'bytes32' }, { name: 'stakeYes', type: 'uint256' }], outputs: [] },
  { name: 'joinDuel', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'duelId', type: 'bytes32' }, { name: 'stakeNo', type: 'uint256' }], outputs: [] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'duelId', type: 'bytes32' }, { name: 'outcomeYes', type: 'bool' }], outputs: [] },
  { name: 'cancelOpen', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'duelId', type: 'bytes32' }], outputs: [] },
  { name: 'getDuel', type: 'function', stateMutability: 'view', inputs: [{ name: 'duelId', type: 'bytes32' }], outputs: [
    { name: 'agentYes', type: 'address' }, { name: 'agentNo', type: 'address' },
    { name: 'stakeYes', type: 'uint256' }, { name: 'stakeNo', type: 'uint256' },
    { name: 'openedAt', type: 'uint64' }, { name: 'settledAt', type: 'uint64' },
    { name: 'status', type: 'uint8' }, { name: 'outcomeYes', type: 'bool' }, { name: 'winner', type: 'address' },
  ] },
  { name: 'duelCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalDueledUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalPaidUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'lockedUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'duelsSettled', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const ALLOWANCE_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export function registerAgentDuel(app, deps) {
  const { supabase, circle, getWalletId, getWalletInfo, walletClient, publicClient, keccak256, toHex, deployedMarketsCache } = deps;
  const ready = Boolean(AGENT_DUEL_ADDRESS && publicClient);

  const duelIdOf = (marketSlug, agentYes, agentNo) =>
    keccak256(toHex(`${marketSlug}:${agentYes}:${agentNo}`));

  // ── READ: live duel stats + recent duels + leaderboard ───────────────
  app.get('/api/agents/duels', async (_req, res) => {
    try {
      if (!ready) return res.json({ enabled: false, address: AGENT_DUEL_ADDRESS || null, stats: null, duels: [] });
      const read = (fn) => publicClient.readContract({ address: AGENT_DUEL_ADDRESS, abi: DUEL_ABI, functionName: fn });
      const [count, dueled, paid, locked, settled] = await Promise.all([
        read('duelCount'), read('totalDueledUsdc'), read('totalPaidUsdc'), read('lockedUsdc'), read('duelsSettled'),
      ]);
      let duels = [];
      let recentSettled = [];
      let leaderboard = [];
      try {
        // Active duels (pending + open + locked)
        const { data: rows } = await supabase.from('agent_duels')
          .select('*')
          .in('status', ['pending', 'open', 'locked'])
          .order('created_at', { ascending: false })
          .limit(20);
        // Enrich with agent data
        duels = await Promise.all((rows || []).map(async (r) => {
          const yesAgent = await agentWalletLite(r.agent_yes);
          const noAgent = await agentWalletLite(r.agent_no);
          return {
            id: r.duel_id, marketSlug: r.market_slug, marketQuestion: r.market_question,
            agentYes: { id: r.agent_yes, ...yesAgent },
            agentNo: { id: r.agent_no, ...noAgent },
            stakeYesUsdc: Number(r.stake_yes_usdc || 0), stakeNoUsdc: Number(r.stake_no_usdc || 0),
            status: r.status, outcomeYes: r.outcome_yes, winner: r.winner,
            payoutUsdc: r.payout_usdc, feeUsdc: r.fee_usdc,
            settleTx: r.settle_tx ? `https://testnet.arcscan.app/tx/${r.settle_tx}` : null,
            openTx: r.open_tx ? `https://testnet.arcscan.app/tx/${r.open_tx}` : null,
            joinTx: r.join_tx ? `https://testnet.arcscan.app/tx/${r.join_tx}` : null,
            createdAt: r.created_at, openedAt: r.opened_at, joinedAt: r.joined_at, settledAt: r.settled_at,
          };
        }));

        // Recent settled duels
        const { data: settledRows } = await supabase.from('agent_duels')
          .select('*')
          .eq('status', 'settled')
          .order('settled_at', { ascending: false })
          .limit(5);
        recentSettled = (settledRows || []).map((r) => ({
          id: r.duel_id, marketSlug: r.market_slug, marketQuestion: r.market_question,
          agentYes: r.agent_yes, agentNo: r.agent_no,
          winner: r.winner, outcomeYes: r.outcome_yes,
          payoutUsdc: Number(r.payout_usdc || 0),
          settleTx: r.settle_tx ? `https://testnet.arcscan.app/tx/${r.settle_tx}` : null,
          settledAt: r.settled_at,
        }));

        // Leaderboard: wins/losses per agent
        const { data: allSettled } = await supabase.from('agent_duels')
          .select('agent_yes, agent_no, winner')
          .eq('status', 'settled')
          .limit(500);
        const wins = {};
        const losses = {};
        const wonUsdc = {};
        for (const r of (allSettled || [])) {
          const w = r.winner;
          const l = r.winner === r.agent_yes ? r.agent_no : r.agent_yes;
          if (w) { wins[w] = (wins[w] || 0) + 1; wonUsdc[w] = (wonUsdc[w] || 0) + DUEL_STAKE_USDC; }
          if (l) { losses[l] = (losses[l] || 0) + 1; wonUsdc[l] = (wonUsdc[l] || 0) - DUEL_STAKE_USDC; }
        }
        const allAgents = new Set([...Object.keys(wins), ...Object.keys(losses)]);
        leaderboard = [...allAgents].map(a => ({
          agent: a,
          wins: wins[a] || 0,
          losses: losses[a] || 0,
          winRate: ((wins[a] || 0) + (losses[a] || 0)) > 0 ? Math.round((wins[a] || 0) / ((wins[a] || 0) + (losses[a] || 0)) * 100) : 0,
          totalWonUsdc: Math.round((wonUsdc[a] || 0) * 100) / 100,
        })).sort((a, b) => b.totalWonUsdc - a.totalWonUsdc).slice(0, 10);

      } catch (_) { /* table may not exist yet */ }
      res.json({
        enabled: AGENT_DUEL_ENABLED, address: AGENT_DUEL_ADDRESS,
        explorer: `https://testnet.arcscan.app/address/${AGENT_DUEL_ADDRESS}`,
        stakeUsdc: DUEL_STAKE_USDC,
        stats: {
          totalDuels: Number(count), dueledUsdc: Number(dueled) / 1e6,
          paidUsdc: Number(paid) / 1e6, lockedUsdc: Number(locked) / 1e6, duelsSettled: Number(settled),
          activeDuels: duels.length,
        },
        duels,
        recentSettled,
        leaderboard,
      });
    } catch (e) {
      console.error('[agent_duel] read error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Lightweight agent data fetcher (name, address, balance) for duel enrichment
  async function agentWalletLite(creatorUserId) {
    try {
      const wid = await getWalletId(`agent_${creatorUserId}`);
      if (!wid) return { address: null, balance: 0 };
      const info = await getWalletInfo(wid);
      const name = creatorUserId.replace('agent_swarm_', '').replace('agent_', '');
      const displayNames = { vega: 'Vega ⚡', cygnus: 'Cygnus 🛡️', orion: 'Orion 🔭', atlas: 'Atlas 📈', nova: 'Nova 🌐', striker: 'Striker ⚽', sage: 'Sage 🔮', pulse: 'Pulse 🤖' };
      return {
        name: displayNames[name] || name,
        address: info.address,
        balance: parseFloat(info.usdcBalance || '0'),
      };
    } catch (_) { return { name: creatorUserId, address: null, balance: 0 }; }
  }

  const writeReady = AGENT_DUEL_ENABLED && ready && walletClient && circle;
  console.log(`[agent_duel] registered (reconciler: ${writeReady ? 'ON' : 'OFF'}, stake ${DUEL_STAKE_USDC} USDC, address: ${AGENT_DUEL_ADDRESS || 'none'})`);
  if (!writeReady) return;

  async function agentWallet(creatorUserId) {
    const wid = (await getWalletId(`agent_${creatorUserId}`)) || (await getWalletId(creatorUserId));
    if (!wid) return null;
    const info = await getWalletInfo(wid);
    if (!info?.address) return null;
    return { walletId: wid, address: info.address, usdc: parseFloat(info.usdcBalance || '0') };
  }

  // Match pass: find published agent signals on same market with opposite stances,
  // create pending duel rows. Also creates rivalry pairs from recent trades.
  async function matchPass() {
    try {
      const { data: rows } = await supabase.from('creator_signals')
        .select('id, creator_user_id, market_slug, market_question, stance')
        .eq('status', 'published')
        .like('creator_user_id', 'agent_%')
        .not('market_slug', 'is', null)
        .order('published_at', { ascending: false })
        .limit(200);
      if (!rows || rows.length < 2) return;
      // Group by market_slug, collect YES and NO agents
      const byMarket = {};
      for (const r of rows) {
        const slug = r.market_slug;
        if (!slug) continue;
        if (!byMarket[slug]) byMarket[slug] = { question: r.market_question, yes: [], no: [] };
        if (r.stance === 'YES') byMarket[slug].yes.push(r);
        else if (r.stance === 'NO') byMarket[slug].no.push(r);
      }
      // Check existing duels to avoid rematches
      const { data: existing } = await supabase.from('agent_duels')
        .select('agent_yes, agent_no, market_slug, status')
        .in('status', ['pending', 'open', 'locked'])
        .limit(500);
      const livePair = new Set((existing || []).map(r => `${r.market_slug}:${r.agent_yes}:${r.agent_no}`));
      let matched = 0;
      for (const [slug, grp] of Object.entries(byMarket)) {
        if (!grp.yes.length || !grp.no.length) continue;
        const yesSig = grp.yes[0];
        const noSig = grp.no[0];
        const pair = `${slug}:${yesSig.creator_user_id}:${noSig.creator_user_id}`;
        if (livePair.has(pair) || livePair.has(`${slug}:${noSig.creator_user_id}:${yesSig.creator_user_id}`)) continue;
        const d = await duelIdOf(slug, yesSig.creator_user_id, noSig.creator_user_id);
        await supabase.from('agent_duels').insert({
          duel_id: d, market_slug: slug, market_question: grp.question,
          agent_yes: yesSig.creator_user_id, agent_no: noSig.creator_user_id,
          signal_yes: yesSig.id, signal_no: noSig.id,
          stake_yes_usdc: DUEL_STAKE_USDC, stake_no_usdc: DUEL_STAKE_USDC,
          status: 'pending',
        }).then(({ error }) => {
          if (error && !error.message.includes('duplicate')) console.error('[agent_duel] insert:', error.message);
        });
        matched++;
      }

      // RIVALRY PAIRS: if not enough natural signal pairs, look for recent trades
      // where two swarm agents took opposite sides on the same market.
      if (matched < 3) {
        try {
          const { data: recentTrades } = await supabase
            .from('trades')
            .select('user_id, market_id, side, question')
            .like('user_id', 'agent_swarm_%')
            .eq('state', 'COMPLETE')
            .order('created_at', { ascending: false })
            .limit(200);
          if (recentTrades && recentTrades.length >= 2) {
            const byMarketTrade = {};
            for (const t of recentTrades) {
              const mid = t.market_id;
              if (!mid) continue;
              if (!byMarketTrade[mid]) byMarketTrade[mid] = { question: t.question, yes: [], no: [] };
              if (t.side === 'YES') byMarketTrade[mid].yes.push(t.user_id);
              else if (t.side === 'NO') byMarketTrade[mid].no.push(t.user_id);
            }
            for (const [mid, grp] of Object.entries(byMarketTrade)) {
              if (matched >= 5) break; // cap at 5 new duels per pass
              if (!grp.yes.length || !grp.no.length) continue;
              const yesAgent = grp.yes[0];
              const noAgent = grp.no[0];
              if (yesAgent === noAgent) continue;
              // Find the market slug from deployed markets cache
              let slug = null;
              if (deployedMarketsCache) {
                for (const [s, e] of deployedMarketsCache.entries()) {
                  if (e.contractAddress && e.contractAddress.toLowerCase() === mid.toLowerCase()) {
                    slug = s; break;
                  }
                }
              }
              if (!slug) continue; // can't duel without a slug for settlement
              const pair = `${slug}:${yesAgent}:${noAgent}`;
              if (livePair.has(pair)) continue;
              const d = duelIdOf(slug, yesAgent, noAgent);
              await supabase.from('agent_duels').insert({
                duel_id: d, market_slug: slug, market_question: grp.question,
                agent_yes: yesAgent, agent_no: noAgent,
                stake_yes_usdc: DUEL_STAKE_USDC, stake_no_usdc: DUEL_STAKE_USDC,
                status: 'pending',
              }).then(({ error }) => {
                if (!error || error.message.includes('duplicate')) matched++;
                else if (!error.message.includes('duplicate')) console.error('[agent_duel] rivalry insert:', error.message);
              });
            }
          }
        } catch (e) { console.warn('[agent_duel] rivalry match error:', e.message); }
      }

      if (matched) console.log(`[agent_duel] matched ${matched} new duels`);
    } catch (e) { console.warn('[agent_duel] match error:', e.message); }
  }

  // Open & Join pass: open pending duels (YES agent approves + openDuel),
  // then join open duels (NO agent approves + joinDuel).
  async function openJoinPass() {
    try {
      // Stage 1: open pending → open (YES agent posts stake)
      const { data: pending } = await supabase.from('agent_duels')
        .select('*').eq('status', 'pending').limit(10);
      for (const d of (pending || [])) {
        try {
          const w = await agentWallet(d.agent_yes);
          if (!w) continue;
          if (w.usdc < DUEL_STAKE_USDC + 0.02) { await cancelDuel(d, 'underfunded'); continue; }
          // Approve if needed
          const allowed = await publicClient.readContract({
            address: USDC_ADDR, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [w.address, AGENT_DUEL_ADDRESS],
          });
          if (BigInt(allowed) < DUEL_STAKE_MICRO) {
            await circle.createContractExecutionTransaction({
              walletId: w.walletId, contractAddress: USDC_ADDR,
              abiFunctionSignature: 'approve(address,uint256)',
              abiParameters: [AGENT_DUEL_ADDRESS, '1000000000'],
              fee: { type: 'level', config: { feeLevel: 'HIGH' } },
            });
            continue; // will open next pass
          }
          const r = await circle.createContractExecutionTransaction({
            walletId: w.walletId, contractAddress: AGENT_DUEL_ADDRESS,
            abiFunctionSignature: 'openDuel(bytes32,uint256)',
            abiParameters: [d.duel_id, DUEL_STAKE_MICRO.toString()],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          await supabase.from('agent_duels').update({
            status: 'open', open_tx: r.data?.id || null, opened_at: new Date().toISOString(),
          }).eq('id', d.id);
          console.log(`[agent_duel] opened: ${d.duel_id.slice(0, 10)}… (${d.agent_yes})`);
        } catch (e) { console.warn(`[agent_duel] open failed ${d.duel_id.slice(0, 10)}…:`, e.message); }
      }

      // Stage 2: join open → locked (NO agent posts stake)
      const { data: openDuelRows } = await supabase.from('agent_duels')
        .select('*').eq('status', 'open').limit(10);
      for (const d of (openDuelRows || [])) {
        try {
          const w = await agentWallet(d.agent_no);
          if (!w) continue;
          if (w.usdc < DUEL_STAKE_USDC + 0.02) { await cancelDuel(d, 'underfunded'); continue; }
          const allowed = await publicClient.readContract({
            address: USDC_ADDR, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [w.address, AGENT_DUEL_ADDRESS],
          });
          if (BigInt(allowed) < DUEL_STAKE_MICRO) {
            await circle.createContractExecutionTransaction({
              walletId: w.walletId, contractAddress: USDC_ADDR,
              abiFunctionSignature: 'approve(address,uint256)',
              abiParameters: [AGENT_DUEL_ADDRESS, '1000000000'],
              fee: { type: 'level', config: { feeLevel: 'HIGH' } },
            });
            continue;
          }
          const r = await circle.createContractExecutionTransaction({
            walletId: w.walletId, contractAddress: AGENT_DUEL_ADDRESS,
            abiFunctionSignature: 'joinDuel(bytes32,uint256)',
            abiParameters: [d.duel_id, DUEL_STAKE_MICRO.toString()],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          await supabase.from('agent_duels').update({
            status: 'locked', join_tx: r.data?.id || null, joined_at: new Date().toISOString(),
          }).eq('id', d.id);
          console.log(`[agent_duel] locked: ${d.duel_id.slice(0, 10)}… (${d.agent_yes} vs ${d.agent_no})`);
        } catch (e) { console.warn(`[agent_duel] join failed ${d.duel_id.slice(0, 10)}…:`, e.message); }
      }
    } catch (e) { console.warn('[agent_duel] openJoin error:', e.message); }
  }

  async function cancelDuel(d, reason) {
    try {
      await supabase.from('agent_duels').update({ status: 'cancelled' }).eq('id', d.id);
      console.log(`[agent_duel] cancelled ${d.duel_id?.slice(0, 10) || d.id}: ${reason}`);
    } catch (_) {}
  }

  // Settle pass: resolve locked duels whose market has resolved on-chain.
  async function settlePass() {
    try {
      const { data: dm } = await supabase.from('deployed_markets')
        .select('slug, resolved, outcome').eq('resolved', true).limit(2000);
      const resolved = new Map();
      for (const m of (dm || [])) {
        if (m.resolved && (m.outcome === true || m.outcome === false)) resolved.set(m.slug, m.outcome);
      }
      if (!resolved.size) return;

      const { data: rows } = await supabase.from('agent_duels')
        .select('*').eq('status', 'locked').limit(50);
      let settled = 0;
      for (const d of (rows || [])) {
        if (settled >= 10) break;
        const outcome = resolved.get(d.market_slug);
        if (outcome === undefined) continue;
        try {
          const tx = await walletClient.writeContract({
            address: AGENT_DUEL_ADDRESS, abi: DUEL_ABI,
            functionName: 'settle', args: [d.duel_id, outcome],
          });
          const winner = outcome === true ? d.agent_yes : d.agent_no;
          await supabase.from('agent_duels').update({
            status: 'settled', outcome_yes: outcome, winner,
            payout_usdc: DUEL_STAKE_USDC * 2, settle_tx: tx, settled_at: new Date().toISOString(),
          }).eq('id', d.id);
          settled++;
          console.log(`[agent_duel] settled ${d.duel_id.slice(0, 10)}… winner=${winner} (tx ${tx})`);
        } catch (e) {
          // Contract revert means duel can't be settled (already settled, not ready, etc.)
          // Mark as failed to stop retrying every 2 minutes
          await supabase.from('agent_duels').update({
            status: 'failed', settle_tx: `error: ${e.message?.slice(0, 100) || 'revert'}`,
          }).eq('id', d.id).catch(() => {});
          console.warn(`[agent_duel] settle failed ${d.duel_id.slice(0, 10)}… — marked failed, won't retry`);
        }
      }
      if (settled) console.log(`[agent_duel] settle pass: ${settled} duels settled`);
    } catch (e) { console.warn('[agent_duel] settle error:', e.message); }
  }

  // Backfill Circle tx UUIDs → 0x hashes for explorer links.
  async function backfillHashes() {
    try {
      const { data: rows } = await supabase.from('agent_duels')
        .select('id, open_tx, join_tx').limit(20);
      for (const r of (rows || [])) {
        for (const col of ['open_tx', 'join_tx']) {
          const v = r[col];
          if (!v || String(v).startsWith('0x')) continue;
          try {
            const t = (await circle.getTransaction({ id: v })).data?.transaction;
            if (t?.txHash) await supabase.from('agent_duels').update({ [col]: t.txHash }).eq('id', r.id);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  let running = false;
  async function reconcile() {
    if (running) return;
    running = true;
    try {
      await matchPass();
      await openJoinPass();
      await settlePass();
      await backfillHashes();
    } catch (e) { console.warn('[agent_duel] reconcile error:', e.message); }
    finally { running = false; }
  }

  // Event-driven: matchPass + openJoinPass react to new signals (two agents may
  // now hold opposite stances); settlePass reacts to market resolution. The
  // boot setTimeout catches anything pending at startup. `running` guards
  // against concurrent passes.
  setTimeout(reconcile, 90_000);
  // Periodic matcher: every 2 min, scan recent signals for new duel pairs.
  // This catches pairs that were missed by the event-driven trigger (e.g.
  // two signals published in quick succession by different agents).
  setInterval(() => {
    reconcile().catch((e) => console.warn('[agent_duel] periodic reconcile:', e.message));
  }, 2 * 60 * 1000).unref?.();
  eventBus.on(EVENTS.SIGNAL_PUBLISHED, () => {
    reconcile().catch((e) => console.warn('[agent_duel] signal event reconcile:', e.message));
  });
  eventBus.on(EVENTS.MARKET_RESOLVED, () => {
    reconcile().catch((e) => console.warn('[agent_duel] resolve event reconcile:', e.message));
  });
  console.log(`[agent_duel] event-driven reconciler (reacts to signal:published + market:resolved)`);
}
