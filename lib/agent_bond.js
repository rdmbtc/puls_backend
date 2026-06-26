// ── Agent skin-in-the-game (AgentBond) ────────────────────────────────────────
//
// AI agents post a USDC bond on the calls they publish (Creator Signals) via the
// on-chain AgentBond contract. When the linked market resolves, a WRONG call is
// slashed to the treasury and a RIGHT one is returned to the agent — reputation
// as capital at risk, settled on Arc. Same signalId as SignalRegistry.
//
// Safe by construction:
//   • Decoupled RECONCILER (not in any hot path) — if it errors, publishing,
//     trading and resolution are completely unaffected.
//   • Gated by AGENT_BOND_ENABLED (default OFF → only the read endpoint runs).
//   • Best-effort/non-blocking everywhere; idempotent via creator_signals bond_*
//     columns; funding-guarded; small fixed stake; per-pass caps.
//
// Wiring (server.js): registerAgentBond(app, { supabase, circle, USDC,
//   getWalletId, getWalletInfo, walletClient, publicClient, keccak256, toHex });

const AGENT_BOND_ENABLED = String(process.env.AGENT_BOND_ENABLED || '').toLowerCase() === 'true';
const AGENT_BOND_ADDRESS = (process.env.AGENT_BOND_ADDRESS || '').trim();
const USDC_ADDR = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000').trim();
const BOND_USDC = Math.max(0.001, Number(process.env.AGENT_BOND_USDC || '0.1') || 0.1);
const BOND_MICRO = BigInt(Math.round(BOND_USDC * 1_000_000));
const INTERVAL_MIN = Math.max(3, parseInt(process.env.AGENT_BOND_INTERVAL_MIN || '5', 10));

const BOND_ABI = [
  { name: 'postBond', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'signalId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'signalId', type: 'bytes32' }, { name: 'correct', type: 'bool' }], outputs: [] },
  { name: 'bondCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBondedUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSlashedUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalReturnedUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'activeBondedUsdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const ALLOWANCE_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export function registerAgentBond(app, deps) {
  const { supabase, circle, getWalletId, getWalletInfo, walletClient, publicClient, keccak256, toHex, contractToSlugCache, deployedMarketsCache } = deps;
  const ready = Boolean(AGENT_BOND_ADDRESS && publicClient);
  const sigIdOf = (uuid) => keccak256(toHex(String(uuid)));

  // ── READ: live contract stats + recent bonds (safe, no writes) ─────────────
  app.get('/api/agents/bonds', async (_req, res) => {
    try {
      if (!ready) return res.json({ enabled: false, address: AGENT_BOND_ADDRESS || null, stats: null, bonds: [] });
      const read = (fn) => publicClient.readContract({ address: AGENT_BOND_ADDRESS, abi: BOND_ABI, functionName: fn });
      const [count, bonded, slashed, returned, active] = await Promise.all([
        read('bondCount'), read('totalBondedUsdc'), read('totalSlashedUsdc'), read('totalReturnedUsdc'), read('activeBondedUsdc'),
      ]);
      let bonds = [];
      try {
        const { data: rows } = await supabase.from('creator_signals')
          .select('id, creator_user_id, title, market_question, stance, bond_amount_usdc, bond_status, bond_post_tx, bond_settle_tx, bond_correct, bond_posted_at')
          .not('bond_status', 'is', null)
          .order('bond_posted_at', { ascending: false })
          .limit(20);
        bonds = (rows || []).map((r) => ({
          signalId: r.id, agent: r.creator_user_id, title: r.title, market: r.market_question, stance: r.stance,
          amountUsdc: Number(r.bond_amount_usdc || 0), status: r.bond_status, correct: r.bond_correct,
          postTx: r.bond_post_tx ? `https://testnet.arcscan.app/tx/${r.bond_post_tx}` : null,
          settleTx: r.bond_settle_tx ? `https://testnet.arcscan.app/tx/${r.bond_settle_tx}` : null,
        }));
      } catch (_) { /* bond_* columns may not exist yet — contract stats still returned */ }
      res.json({
        enabled: AGENT_BOND_ENABLED,
        address: AGENT_BOND_ADDRESS,
        explorer: `https://testnet.arcscan.app/address/${AGENT_BOND_ADDRESS}`,
        stakeUsdc: BOND_USDC,
        stats: {
          count: Number(count),
          bondedUsdc: Number(bonded) / 1e6,
          slashedUsdc: Number(slashed) / 1e6,
          returnedUsdc: Number(returned) / 1e6,
          activeUsdc: Number(active) / 1e6,
        },
        bonds,
      });
    } catch (e) {
      console.error('[agent_bond] read error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── READ: per-agent bond breakdown (active/slashed/returned + accuracy) ─────
  app.get('/api/agents/bonds/report', async (_req, res) => {
    try {
      const { data: rows } = await supabase.from('creator_signals')
        .select('creator_user_id, bond_status, bond_amount_usdc, bond_correct')
        .not('bond_status', 'is', null)
        .limit(2000);
      const agents = {};
      for (const r of (rows || [])) {
        const uid = r.creator_user_id || 'unknown';
        if (!agents[uid]) agents[uid] = { active: 0, slashed: 0, returned: 0, total: 0, correct: 0, usdcActive: 0, usdcSlashed: 0, usdcReturned: 0 };
        const a = agents[uid];
        const amt = Number(r.bond_amount_usdc || 0);
        a.total++;
        if (r.bond_status === 'active')   { a.active++; a.usdcActive += amt; }
        if (r.bond_status === 'slashed')  { a.slashed++; a.usdcSlashed += amt; }
        if (r.bond_status === 'returned') { a.returned++; a.usdcReturned += amt; if (r.bond_correct) a.correct++; }
      }
      const report = Object.entries(agents).map(([agent, s]) => ({
        agent,
        bonds: { active: s.active, slashed: s.slashed, returned: s.returned, total: s.total },
        usdc:  { active: +s.usdcActive.toFixed(4), slashed: +s.usdcSlashed.toFixed(4), returned: +s.usdcReturned.toFixed(4) },
        accuracy: s.slashed + s.returned > 0 ? +((s.returned / (s.slashed + s.returned)) * 100).toFixed(1) : null,
      }));
      res.json({ agents: report, totalBonds: (rows || []).length });
    } catch (e) {
      console.error('[agent_bond] report error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  const writeReady = AGENT_BOND_ENABLED && ready && walletClient && circle;
  console.log(`[agent_bond] registered (reconciler: ${writeReady ? 'ON' : 'OFF'}, stake ${BOND_USDC} USDC, address: ${AGENT_BOND_ADDRESS || 'none'})`);
  if (!writeReady) return; // read endpoint only

  async function agentWallet(creatorUserId) {
    const wid = (await getWalletId(`agent_${creatorUserId}`)) || (await getWalletId(creatorUserId));
    if (!wid) return null;
    const info = await getWalletInfo(wid);
    if (!info?.address) return null;
    return { walletId: wid, address: info.address, usdc: parseFloat(info.usdcBalance || '0') };
  }

  // POST pass: post bonds for published agent signals that don't have one yet.
  async function postPass() {
    const { data: rows } = await supabase.from('creator_signals')
      .select('id, creator_user_id, status, bond_status, confidence')
      .eq('status', 'published')
      .like('creator_user_id', 'agent_%')
      .is('bond_status', null)
      .order('published_at', { ascending: false })
      .limit(3);
    for (const sig of (rows || [])) {
      try {
        // Conviction = capital at risk: the stake scales with the signal's
        // confidence (~0.52..0.85 → ~$0.06..$0.22), so a bolder call carries a
        // bigger bond. Bounded so a wallet is never over-committed.
        const conf = Math.max(0.5, Math.min(0.9, Number(sig.confidence) || 0.6));
        const stakeUsdc = Math.round((0.05 + (conf - 0.5) * 0.5) * 1000) / 1000;
        const stakeMicro = BigInt(Math.round(stakeUsdc * 1_000_000));
        const w = await agentWallet(sig.creator_user_id);
        if (!w) continue;
        if (w.usdc < stakeUsdc + 0.05) { // need stake + a little gas headroom
          console.log(`[agent_bond] ${sig.creator_user_id} underfunded (${w.usdc} USDC) — skipping bond`);
          continue;
        }
        // Ensure allowance; if missing, approve now and post on a later pass
        // (Circle txs settle async, so we stage approve → postBond across passes).
        const allowance = await publicClient.readContract({
          address: USDC_ADDR, abi: ALLOWANCE_ABI, functionName: 'allowance', args: [w.address, AGENT_BOND_ADDRESS],
        });
        if (BigInt(allowance) < stakeMicro) {
          await circle.createContractExecutionTransaction({
            walletId: w.walletId, contractAddress: USDC_ADDR,
            abiFunctionSignature: 'approve(address,uint256)',
            abiParameters: [AGENT_BOND_ADDRESS, '1000000000'], // 1000 USDC allowance, once
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          console.log(`[agent_bond] approve submitted for ${sig.creator_user_id}; will bond next pass`);
          continue;
        }
        const onchainSignalId = sigIdOf(sig.id);
        const r = await circle.createContractExecutionTransaction({
          walletId: w.walletId, contractAddress: AGENT_BOND_ADDRESS,
          abiFunctionSignature: 'postBond(bytes32,uint256)',
          abiParameters: [onchainSignalId, stakeMicro.toString()],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        const txId = r.data?.id || null;
        await supabase.from('creator_signals').update({
          bond_signal_id: onchainSignalId, bond_amount_usdc: stakeUsdc, bond_status: 'active',
          bond_post_tx: txId, bond_posted_at: new Date().toISOString(),
        }).eq('id', sig.id);
        console.log(`[agent_bond] ${sig.creator_user_id} staked ${stakeUsdc} USDC (conf ${conf.toFixed(2)}) on ${sig.id} (tx ${txId})`);
      } catch (e) {
        console.warn(`[agent_bond] post failed for ${sig.id}:`, e.message);
      }
    }
  }

  // SETTLE pass: RESOLVED-MARKET-DRIVEN. Build the resolved-market outcome map,
  // then settle active bonds linked to them — FILTERING IN JS (not a giant .in()).
  // Postgrest .in() with hundreds of slugs silently fails past URL limits, which
  // left the entire backlog unsettled (slashed/returned never moved). With ~350
  // resolved markets and ~700 active bonds, this drains the backlog fast.
  async function settlePass() {
    const { data: dm } = await supabase.from('deployed_markets')
      .select('slug, resolved, outcome').eq('resolved', true).limit(2000);
    const resolved = new Map();
    for (const m of (dm || [])) {
      if (m.resolved === true && (m.outcome === true || m.outcome === false)) resolved.set(m.slug, m.outcome);
    }
    if (!resolved.size) return;
    const { data: rows } = await supabase.from('creator_signals')
      .select('id, creator_user_id, market_slug, stance, bond_status, bond_signal_id, contract_address')
      .eq('bond_status', 'active')
      .limit(1000);
    if (!rows || !rows.length) return;
    let settled = 0;
    for (const sig of rows) {
      if (settled >= 40) break; // cap on-chain settle txs per pass
      // Resolve slug: prefer explicit market_slug, fall back to contract address lookup
      let slug = sig.market_slug;
      if (!slug && sig.contract_address && contractToSlugCache) {
        slug = contractToSlugCache.get(sig.contract_address.toLowerCase()) || null;
      }
      if (!slug) continue; // no way to link this bond to a deployed market
      const outcome = resolved.get(slug); // true = YES won
      if (outcome === undefined) continue;
      try {
        const correct = (String(sig.stance).toUpperCase() === 'YES') === outcome;
        const onchainSignalId = sig.bond_signal_id || sigIdOf(sig.id);
        const tx = await walletClient.writeContract({
          address: AGENT_BOND_ADDRESS, abi: BOND_ABI, functionName: 'settle', args: [onchainSignalId, correct],
        });
        await supabase.from('creator_signals').update({
          bond_status: correct ? 'returned' : 'slashed', bond_correct: correct,
          bond_settle_tx: tx, bond_settled_at: new Date().toISOString(),
        }).eq('id', sig.id);
        settled++;
        console.log(`[agent_bond] settled ${sig.id} → ${correct ? 'RETURN' : 'SLASH'} (tx ${tx})`);
      } catch (e) {
        console.warn(`[agent_bond] settle failed for ${sig.id}:`, e.message);
      }
    }
    if (settled) console.log(`[agent_bond] settle pass: ${settled} bonds settled this pass`);
  }

  // Backfill Circle tx UUIDs → on-chain hashes once confirmed, so per-bond links
  // resolve to real Arc transactions (postBond goes through Circle and returns a
  // UUID; settle is a direct write and is already a 0x hash).
  async function backfillHashes() {
    const { data: rows } = await supabase.from('creator_signals')
      .select('id, bond_post_tx, bond_settle_tx')
      .not('bond_status', 'is', null)
      .limit(40);
    for (const r of (rows || [])) {
      for (const col of ['bond_post_tx', 'bond_settle_tx']) {
        const v = r[col];
        if (!v || String(v).startsWith('0x')) continue; // already a hash / empty
        try {
          const t = (await circle.getTransaction({ id: v })).data?.transaction;
          if (t?.txHash) {
            await supabase.from('creator_signals').update({ [col]: t.txHash }).eq('id', r.id);
          }
        } catch (_) { /* not confirmed yet — try next pass */ }
      }
    }
  }

  let running = false;
  async function reconcile() {
    if (running) return;
    running = true;
    try {
      await postPass();
      await settlePass();
      await backfillHashes();
    } catch (e) {
      console.warn('[agent_bond] reconcile error:', e.message);
    } finally {
      running = false;
    }
  }

  setTimeout(reconcile, 60_000);
  setInterval(reconcile, INTERVAL_MIN * 60_000);
  console.log(`[agent_bond] reconciler scheduled (every ${INTERVAL_MIN}m)`);
}
