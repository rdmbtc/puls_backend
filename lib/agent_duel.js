// ── AgentDuel — the Colosseum ───────────────────────────────────────────────
//
// RAIL CONTRACT: settle() ALWAYS executes treasury-side (admin EOA via viem) —
// the contract pays the winner itself and needs no participant signature.
// Stakes (approve/openDuel/joinDuel) may originate from EITHER rail, decided
// by chooseRail() in lib/agent_rail.js:
//   'sca'          → dev-controlled wallet (circle.createContractExecutionTransaction)
//   'agent-wallet' → Circle Agent Wallet (circleAgent.executeContract via CLI)
//
// Two AI agents stake USDC on OPPOSITE sides of the same market. When the market
// resolves, the loser's stake is paid to the winner — minus an optional protocol
// fee to the treasury. Reputation as capital at risk, settled on Arc.
//
// Same decoupled (non-blocking), best-effort pattern as AgentBond.
// Gated by AGENT_DUEL_ENABLED (default OFF).

import { eventBus, EVENTS } from './events.js';
import * as circleAgent from './circle_agent_wallet.js';
import { initAgentReputation } from './agent_reputation.js';
import { chooseRail } from './agent_rail.js';
import { captureException } from './observability.js';

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

/**
 * Count rail transactions still unresolved ("INITIATED" ≡ non-0x Circle UUID)
 * whose submission timestamp is older than `cutoffIso`. Pure; unit-tested.
 * @param {{duelRows:Array,bondRows:Array}} sources
 * @param {string} cutoffIso
 */
export function countStuckTxRefs({ duelRows = [], bondRows = [] }, cutoffIso) {
  let stuck = 0;
  const isUuid = (v) => v && !String(v).startsWith('0x');
  const old = (ts) => ts && String(ts) < cutoffIso;
  for (const r of duelRows) {
    if (isUuid(r.open_tx) && old(r.opened_at)) stuck++;
    if (isUuid(r.join_tx) && old(r.joined_at)) stuck++;
  }
  for (const r of bondRows) {
    if (isUuid(r.bond_post_tx) && old(r.bond_posted_at)) stuck++;
  }
  return stuck;
}

/**
 * Which Circle rail does a duel participant pay from? Pure/env-driven so tests
 * can exercise it without the reconciler. Returns an Agent Stack descriptor
 * when the agent runs on a Circle Agent Wallet, else null (dev-controlled SCA
 * lookup happens async in the reconciler).
 * @param {string} userId  creator id like 'agent_swarm_vega' or 'house_pulse'
 */
export function agentStackParticipantOf(userId) {
  const key = circleAgent.isEnabledForUser(userId);
  if (!key) return null;
  const address = circleAgent.addressFor(key);
  if (!address) return null;
  return { mode: 'agent-wallet', key, address };
}

export function registerAgentDuel(app, deps) {
  const { supabase, circle, getWalletId, getWalletInfo, walletClient, publicClient, keccak256, toHex, deployedMarketsCache } = deps;
  const ready = Boolean(AGENT_DUEL_ADDRESS && publicClient);

  // Peer-to-peer ERC-8004 reputation: enabled agents review their duel
  // counterparties on-chain after settlement, plus the public read-side
  // /api/agents/reputation. Wired from this module — no server.js changes.
  const reputation = initAgentReputation({ app, supabase, publicClient, keccak256, toHex, getWalletId, getWalletInfo });

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
      const name = creatorUserId.replace('agent_swarm_', '').replace('agent_', '');
      const displayNames = { vega: 'Vega ⚡', cygnus: 'Cygnus 🛡️', orion: 'Orion 🔭', atlas: 'Atlas 📈', nova: 'Nova 🌐', striker: 'Striker ⚽', sage: 'Sage 🔮', pulse: 'Pulse 🤖' };
      // Circle Agent Stack agents hold no dev-controlled wallet — surface the
      // Agent Wallet address so the duel board doesn't show a blank opponent.
      const aw = agentStackParticipantOf(creatorUserId);
      if (aw) return { name: displayNames[name] || name, address: aw.address, balance: 0 };
      const wid = await getWalletId(`agent_${creatorUserId}`);
      if (!wid) return { address: null, balance: 0 };
      const info = await getWalletInfo(wid);
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

  async function duelParticipant(userId) {
    const key = circleAgent.keyFromUser(userId);
    const wid = (await getWalletId(`agent_${userId}`)) || (await getWalletId(userId));
    const rail = chooseRail(wid, key);
    if (rail === 'agent-wallet') {
      const address = circleAgent.addressFor(key);
      if (!address) return null;
      let usdc = 0;
      try { usdc = await circleAgent.usdcBalance(address); } catch (_) { /* treated as 0 */ }
      return { mode: 'agent-wallet', key, address, usdc };
    }
    if (rail === 'sca') {
      const info = await getWalletInfo(wid);
      if (!info?.address) return null;
      return { mode: 'sca', walletId: wid, address: info.address, usdc: parseFloat(info.usdcBalance || '0') };
    }
    return null;
  }

  // Execute a contract write from the participant's rail. Agent Wallet calls
  // are synchronous through the Circle CLI (confirmed on return); SCA calls
  // stay fire-and-continue. Backs off while the Agent Wallet has pending txs.
  async function executeOnRail(participant, contractAddress, abiFunctionSignature, abiParameters) {
    if (participant.mode === 'agent-wallet') {
      const pending = await circleAgent.pendingCount(participant.address).catch(() => -1);
      if (pending > 0) throw new Error(`${pending} pending Circle tx(s) — deferring agent-wallet stake`);
      const r = await circleAgent.executeContract({
        signature: abiFunctionSignature, params: abiParameters,
        contract: contractAddress, address: participant.address,
      });
      console.log(`[agent-wallet:${participant.key}] ${abiFunctionSignature.split('(')[0]} via Circle Agent Stack (${r.txHash || r.id})`);
      return r.txHash || r.id || null;
    }
    const r = await circle.createContractExecutionTransaction({
      walletId: participant.walletId, contractAddress,
      abiFunctionSignature, abiParameters,
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    return r.data?.id || null;
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

  // On-chain truth for a duel row: null when the read fails. Status enum:
  // 0 none, 1 open (YES staked), 2 locked (both staked), 3 settled.
  async function chainDuelStatus(duelId) {
    try {
      const d = await publicClient.readContract({
        address: AGENT_DUEL_ADDRESS, abi: DUEL_ABI, functionName: 'getDuel', args: [duelId],
      });
      return Number(d?.status ?? d?.[6] ?? 0);
    } catch (_) { return null; }
  }

  // Open & Join pass: open pending duels (YES agent approves + openDuel),
  // then join open duels (NO agent approves + joinDuel).
  async function openJoinPass() {
    try {
      // Stage 1: open pending → open (YES agent posts stake).
      // Newest-first: fresh duels must not starve behind hordes of duplicate
      // zombie rows (they converge to healed/locked over passes anyway).
      const seenIds = new Set();
      const { data: pending } = await supabase.from('agent_duels')
        .select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(10);
      for (const d of (pending || [])) {
        try {
          if (seenIds.has(d.duel_id)) continue; // duplicate row of an id already handled this pass
          seenIds.add(d.duel_id);
          // Zombie heal: early-August duels are already open/locked on-chain
          // while their rows stayed 'pending' — re-opening reverts forever
          // (ESTIMATION_ERROR churn). Reconcile instead of transacting.
          const chainStatus = await chainDuelStatus(d.duel_id);
          if (chainStatus === 1 || chainStatus === 2) {
            await supabase.from('agent_duels').update(
              chainStatus === 2
                ? { status: 'locked', joined_at: new Date().toISOString() }
                : { status: 'open', opened_at: new Date().toISOString() }
            ).eq('id', d.id);
            console.log(`[agent_duel] healed ${d.duel_id.slice(0, 10)}…: db pending → chain ${chainStatus === 2 ? 'locked' : 'open'}`);
            continue;
          }
          const w = await duelParticipant(d.agent_yes);
          if (!w) continue;
          if (w.usdc < DUEL_STAKE_USDC + 0.02) { await cancelDuel(d, 'underfunded'); continue; }
          // Approve if needed
          const allowed = await publicClient.readContract({
            address: USDC_ADDR, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [w.address, AGENT_DUEL_ADDRESS],
          });
          if (BigInt(allowed) < DUEL_STAKE_MICRO) {
            const txId = await executeOnRail(w, USDC_ADDR, 'approve(address,uint256)', [AGENT_DUEL_ADDRESS, '1000000000']);
            console.log(`[agent_duel] approve (${w.mode}) submitted for ${d.agent_yes} (tx ${txId}); will open next pass`);
            continue; // will open next pass
          }
          const openTx = await executeOnRail(w, AGENT_DUEL_ADDRESS, 'openDuel(bytes32,uint256)', [d.duel_id, DUEL_STAKE_MICRO.toString()]);
          await supabase.from('agent_duels').update({
            status: 'open', open_tx: openTx || null, opened_at: new Date().toISOString(),
          }).eq('id', d.id);
          console.log(`[agent_duel] opened: ${d.duel_id.slice(0, 10)}… (${d.agent_yes}, rail ${w.mode})`);
        } catch (e) { console.warn(`[agent_duel] open failed ${d.duel_id.slice(0, 10)}…:`, e.message); }
      }

      // Stage 2: join open → locked (NO agent posts stake). Newest-first, same
      // per-pass duel_id dedupe as stage 1.
      const seenJoinIds = new Set();
      const { data: openDuelRows } = await supabase.from('agent_duels')
        .select('*').eq('status', 'open').order('created_at', { ascending: false }).limit(10);
      for (const d of (openDuelRows || [])) {
        try {
          if (seenJoinIds.has(d.duel_id)) continue;
          seenJoinIds.add(d.duel_id);
          const chainStatus = await chainDuelStatus(d.duel_id);
          if (chainStatus === 2 || chainStatus === 3) {
            await supabase.from('agent_duels').update({ status: 'locked', joined_at: new Date().toISOString() }).eq('id', d.id);
            console.log(`[agent_duel] healed ${d.duel_id.slice(0, 10)}…: db open → chain ${chainStatus === 3 ? 'settled(→locked)' : 'locked'}`);
            continue;
          }
          if (chainStatus === 0) {
            // The open tx never actually landed — send back to pending so
            // stage 1 re-opens it on a later pass.
            await supabase.from('agent_duels').update({ status: 'pending', opened_at: null }).eq('id', d.id);
            console.log(`[agent_duel] healed ${d.duel_id.slice(0, 10)}…: db open → pending (open never landed)`);
            continue;
          }
          const w = await duelParticipant(d.agent_no);
          if (!w) continue;
          if (w.usdc < DUEL_STAKE_USDC + 0.02) { await cancelDuel(d, 'underfunded'); continue; }
          const allowed = await publicClient.readContract({
            address: USDC_ADDR, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [w.address, AGENT_DUEL_ADDRESS],
          });
          if (BigInt(allowed) < DUEL_STAKE_MICRO) {
            const txId = await executeOnRail(w, USDC_ADDR, 'approve(address,uint256)', [AGENT_DUEL_ADDRESS, '1000000000']);
            console.log(`[agent_duel] approve (${w.mode}) submitted for ${d.agent_no} (tx ${txId}); will join next pass`);
            continue;
          }
          const joinTx = await executeOnRail(w, AGENT_DUEL_ADDRESS, 'joinDuel(bytes32,uint256)', [d.duel_id, DUEL_STAKE_MICRO.toString()]);
          await supabase.from('agent_duels').update({
            status: 'locked', join_tx: joinTx || null, joined_at: new Date().toISOString(),
          }).eq('id', d.id);
          console.log(`[agent_duel] locked: ${d.duel_id.slice(0, 10)}… (${d.agent_yes} vs ${d.agent_no}, joiner rail ${w.mode})`);
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
  // NOTE: settle() is an admin call from the treasury EOA (the contract pays
  // the winner itself) — it needs no participant signature, so it stays on the
  // direct viem rail for BOTH SCA and Agent-Stack participants.
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
          const loser = outcome === true ? d.agent_no : d.agent_yes;
          await supabase.from('agent_duels').update({
            status: 'settled', outcome_yes: outcome, winner,
            payout_usdc: DUEL_STAKE_USDC * 2, settle_tx: tx, settled_at: new Date().toISOString(),
          }).eq('id', d.id);
          settled++;
          console.log(`[agent_duel] settled ${d.duel_id.slice(0, 10)}… winner=${winner} (tx ${tx})`);
          // Peer reputation: enabled participants review their counterparty.
          if (reputation) {
            reputation.reviewDuelOutcome({ winnerUserId: winner, loserUserId: loser, duelId: d.duel_id })
              .catch((e) => console.warn(`[agent_duel] peer review failed ${d.duel_id.slice(0, 10)}…:`, e.message));
          }
        } catch (e) {
          // Contract revert means duel can't be settled (already settled, not ready, etc.)
          // Mark as failed to stop retrying every 2 minutes
          try {
            await supabase.from('agent_duels').update({
              status: 'failed', settle_tx: `error: ${e.message?.slice(0, 100) || 'revert'}`,
            }).eq('id', d.id);
          } catch (_) { /* ignore DB error on cleanup */ }
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
      await stuckTxWatchdog();
    } catch (e) { console.warn('[agent_duel] reconcile error:', e.message); }
    finally { running = false; }
  }

  // ── Zombie watchdog v2 (hourly) ──────────────────────────────────────────────
  // Early warning for Circle signing-pipeline degradation: count transactions
  // we submitted through the rails that are still unresolved ("INITIATED")
  // more than an hour after submission. Proxy source = DB rows whose tx ref is
  // still a Circle UUID (non-0x) with an old timestamp — zero extra API cost.
  // Fires console.error + Sentry capture when ANY contract has >5 such rows.
  const WATCHDOG_MIN_GAP_MS = 60 * 60_000;
  const WATCHDOG_STUCK_THRESHOLD = 5;
  let lastWatchdogAt = 0;
  async function stuckTxWatchdog(now = Date.now()) {
    if (now - lastWatchdogAt < WATCHDOG_MIN_GAP_MS) return;
    lastWatchdogAt = now;
    try {
      const cutoff = new Date(now - 60 * 60_000).toISOString();
      const weekAgo = new Date(now - 7 * 24 * 3600_000).toISOString();
      const [{ data: duelRows }, { data: bondRows }] = await Promise.all([
        supabase.from('agent_duels').select('open_tx, join_tx, opened_at, joined_at')
          .gte('opened_at', weekAgo).limit(500),
        supabase.from('creator_signals').select('bond_post_tx, bond_posted_at')
          .not('bond_post_tx', 'is', null)
          .gte('bond_posted_at', weekAgo).limit(500),
      ]);
      const stuck = countStuckTxRefs({ duelRows: duelRows || [], bondRows: bondRows || [] }, cutoff);
      if (stuck > WATCHDOG_STUCK_THRESHOLD) {
        const err = new Error(`[rail-watchdog] ${stuck} INITIATED transactions older than 1h across duel/bond contracts — Circle signing-pipeline degradation suspected`);
        console.error(err.message);
        captureException(err, { tags: { component: 'rail-watchdog' }, extra: { stuck } });
      } else if (stuck > 0) {
        console.log(`[rail-watchdog] ${stuck} unresolved rail transaction(s) older than 1h (below alert threshold)`);
      }
    } catch (e) {
      console.warn('[rail-watchdog] sweep failed:', e.message);
    }
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
