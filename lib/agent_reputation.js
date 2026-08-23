// ── Peer-to-peer ERC-8004 reputation (Agent Wallets) ─────────────────────────
//
// When an ENABLED agent (Circle Agent Wallet rail) settles a duel or buys a
// peer's signal, it leaves a signed on-chain review FOR the counterparty via
// the ERC-8004 ReputationRegistry:
//
//   giveFeedback(uint256 agentId, int128 score, uint8 feedbackType,
//                string tag, string metadataURI, string evidenceURI,
//                string comment, bytes32 feedbackHash)
//
// Scores are outcome-based, never self-serving: duel win 90 / loss 40;
// signal buys carry the buyer's post-trade confidence clamped 10..95.
//
// Dedupe: one review per (rater, target, refId) — in-memory Set plus a
// durable marker row in `notifications` (type='peer_review') so restarts
// don't double-post. signal_unlocks / agent_duels rows remain the source of
// truth for WHAT happened; this module only reacts to them.
//
// Wiring (from MY modules — no server.js changes):
//   const reputation = initAgentReputation({ supabase, publicClient,
//     keccak256, toHex, getWalletId, getWalletInfo, resolveAgentTokenId? });
//   await reputation.reviewDuelOutcome(winnerParticipant, winnerUserId,
//                                     loserParticipant, loserUserId, duelRef);
// Signal-buys are swept periodically from signal_unlocks.

import * as circleAgent from './circle_agent_wallet.js';

const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const SWEEP_MIN = Math.max(2, parseInt(process.env.AGENT_REPUTATION_SWEEP_MIN || '5', 10));
const SCAN_CHUNK = 4000n;            // RPC-safe eth_getLogs range on Arc
const SCAN_CHUNKS_MAX = parseInt(process.env.AGENT_REPUTATION_SCAN_CHUNKS || '150', 10);
const SCAN_PARALLEL = 6;             // chunks resolved per batch
const GIVE_FEEDBACK_SIGNATURE =
  'giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)';

const GIVE_FEEDBACK_ABI = [{
  name: 'giveFeedback', type: 'function', stateMutability: 'nonpayable',
  inputs: [
    { name: 'agentId', type: 'uint256' },
    { name: 'score', type: 'int128' },
    { name: 'feedbackType', type: 'uint8' },
    { name: 'tag', type: 'string' },
    { name: 'metadataURI', type: 'string' },
    { name: 'evidenceURI', type: 'string' },
    { name: 'comment', type: 'string' },
    { name: 'feedbackHash', type: 'bytes32' },
  ],
  outputs: [],
}];
const TRANSFER_EVENT = {
  name: 'Transfer', type: 'event', anonymous: false,
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
};

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Outcome score for a settled duel, from the RATER's perspective. */
export function scoreForDuel(raterWon) {
  return raterWon ? 90 : 40;
}

/** Buyer-confidence score for a signal purchase, clamped 10..95. */
export function scoreForSignal(confidence) {
  const raw = Number(confidence);
  const pct = Number.isFinite(raw)
    ? (raw <= 1 ? raw * 100 : raw) // accepts 0..1 and 0..100 forms
    : 60;
  return Math.max(10, Math.min(95, Math.round(pct)));
}

/** Stable dedupe key for one review. */
export function reviewKey(raterKey, targetUserId, refId) {
  return `${String(raterKey).toLowerCase()}|${String(targetUserId)}|${String(refId)}`;
}

/** Canonical bytes32 commitment for a review (deterministic). */
export function feedbackHashOf(hashFn, hexFn, { raterKey, targetUserId, refId, score, tag }) {
  const canonical = [raterKey, targetUserId, refId, score, tag].join('\u0000');
  return hashFn(hexFn(canonical));
}

/**
 * Which roster userIds could belong to an Agent-Stack key?
 * 'vega' → ['agent_swarm_vega', 'agent_vega'] — callers match against
 * whatever id namespace their source table uses.
 */
export function candidateUserIds(key) {
  return [`agent_swarm_${key}`, `agent_${key}`];
}

// ── Module ───────────────────────────────────────────────────────────────────

export function initAgentReputation(deps) {
  const {
    supabase, publicClient, keccak256, toHex,
    getWalletId, getWalletInfo,
    resolveAgentTokenId,          // optional fast path (server-provided)
  } = deps;

  const enabled = String(process.env.AGENT_PEER_REPUTATION ?? 'true').toLowerCase() !== 'false';
  const reviewed = new Set();     // reviewKey() values attempted/posted this process
  const tokenIdCache = new Map(); // address → tokenId string | null

  if (!enabled) {
    console.log('[peer-rep] disabled (AGENT_PEER_REPUTATION=false)');
    return null;
  }
  if (!publicClient || !supabase || !keccak256 || !toHex) {
    console.warn('[peer-rep] missing deps (publicClient/supabase/keccak256/toHex) — disabled');
    return null;
  }

  /** Durable dedupe check: notifications row type='peer_review'. */
  async function alreadyReviewed(key) {
    if (reviewed.has(key)) return true;
    try {
      const { data } = await supabase
        .from('notifications')
        .select('id')
        .eq('type', 'peer_review')
        .eq('title', key)
        .limit(1);
      if (data && data.length) { reviewed.add(key); return true; }
    } catch (_) { /* best-effort */ }
    return false;
  }

  async function markReviewed(key, extra = {}) {
    reviewed.add(key);
    try {
      await supabase.from('notifications').insert({
        user_id: `agent_stack_${extra.raterKey || 'system'}`,
        title: key,
        type: 'peer_review',
        read: true,
        message: JSON.stringify(extra),
      });
    } catch (_) { /* best-effort */ }
  }

  /** Resolve a counterparty's ERC-8004 token id (memoized, write-through). */
  async function tokenIdFor(userId, address) {
    if (!address) return null;
    if (tokenIdCache.has(address)) return tokenIdCache.get(address);

    if (typeof resolveAgentTokenId === 'function') {
      try {
        const id = await resolveAgentTokenId(userId.replace(/^agent_/, ''), address);
        if (id) { tokenIdCache.set(address, String(id)); return String(id); }
      } catch (_) { /* fall through to local scan */ }
    }
    try {
      // Persisted cache table first (server writes here too).
      const { data: rows } = await supabase
        .from('agent_identities')
        .select('token_id')
        .ilike('address', address)
        .limit(1);
      if (rows && rows.length && rows[0].token_id != null) {
        tokenIdCache.set(address, String(rows[0].token_id));
        return String(rows[0].token_id);
      }
    } catch (_) { /* table may not exist yet */ }

    // Bounded backward Transfer-log scan, newest-first in parallel batches
    // (mints land here when identities are fresh; older ones rely on the
    // persisted table above). 150 chunks × 4k blocks ≈ last 3.5 days.
    let toBlock = await publicClient.getBlockNumber();
    const startBlock = toBlock > SCAN_CHUNK * BigInt(SCAN_CHUNKS_MAX)
      ? toBlock - SCAN_CHUNK * BigInt(SCAN_CHUNKS_MAX) : 0n;
    outer:
    while (toBlock > startBlock) {
      const batch = [];
      for (let i = 0; i < SCAN_PARALLEL && toBlock > startBlock; i++) {
        const fromBlock = toBlock > SCAN_CHUNK ? toBlock - SCAN_CHUNK : 0n;
        batch.push({ fromBlock, toBlock });
        if (fromBlock === 0n) break;
        toBlock = fromBlock - 1n;
      }
      const results = await Promise.all(batch.map(async ({ fromBlock, toBlock: bTo }) => {
        try {
          return await publicClient.getLogs({
            address: IDENTITY_REGISTRY, event: TRANSFER_EVENT,
            args: { to: address }, fromBlock, toBlock: bTo,
          });
        } catch (_) { return []; }
      }));
      for (const logs of results) {
        for (const l of logs) {
          // newest chunk first — take the latest mint of this address
          const id = String(l.args.tokenId);
          tokenIdCache.set(address, id);
          try {
            await supabase.from('agent_identities').upsert(
              { agent_key: userId, token_id: id, address, updated_at: new Date().toISOString() },
              { onConflict: 'agent_key' }
            );
          } catch (_) { /* write-through is best-effort */ }
          break outer;
        }
      }
    }
    if (!tokenIdCache.has(address)) tokenIdCache.set(address, null);
    return tokenIdCache.get(address);
  }

  /**
   * Post one review FOR a counterparty from an enabled agent's Agent Wallet.
   * @returns {Promise<{posted:boolean, txHash?:string, reason?:string}>}
   */
  async function reviewCounterparty({
    raterKey, targetUserId, refId,
    score, tag, comment, evidenceUrl,
    targetAddress,             // known counterparty address (else resolved)
    targetKey,                 // enabled counterparty key (fast address path)
  }) {
    const key = reviewKey(raterKey, targetUserId, refId);
    if (!raterKey || !targetUserId || !refId) return { posted: false, reason: 'missing rater/target/ref' };
    if (reviewed.has(key)) return { posted: false, reason: 'already-reviewed (memory)' };

    const raterAddress = circleAgent.addressFor(raterKey);
    if (!raterAddress) return { posted: false, reason: `no Agent Wallet for rater ${raterKey}` };
    if (await alreadyReviewed(key)) return { posted: false, reason: 'already-reviewed (db)' };

    const addr = targetAddress
      || (targetKey ? circleAgent.addressFor(targetKey) : null)
      || (await (async () => {
        try {
          const wid = (await getWalletId?.(`agent_${targetUserId}`)) || (await getWalletId?.(targetUserId));
          if (!wid) return null;
          const info = await getWalletInfo?.(wid);
          return info?.address || null;
        } catch (_) { return null; }
      })());
    if (!addr) { await markReviewed(key, { raterKey, targetUserId, refId, skipped: 'no-target-address' }); return { posted: false, reason: 'no target address' }; }
    if (addr.toLowerCase() === raterAddress.toLowerCase()) {
      await markReviewed(key, { raterKey, targetUserId, refId, skipped: 'self-review' });
      return { posted: false, reason: 'self-review' };
    }

    const agentId = await tokenIdFor(targetUserId, addr);
    if (!agentId) {
      console.warn(`[peer-rep] ${raterKey}→${targetUserId}: no ERC-8004 identity resolvable for ${addr.slice(0, 10)}… — skipping`);
      return { posted: false, reason: 'counterparty identity unresolvable' };
    }

    const clamped = Math.max(-128, Math.min(127, Math.round(Number(score) || 0)));
    const safeTag = String(tag || 'interaction').slice(0, 32);
    const fbHash = feedbackHashOf(keccak256, toHex, { raterKey, targetUserId, refId, score: clamped, tag: safeTag });

    await circleAgent.executeContract({
      signature: GIVE_FEEDBACK_SIGNATURE,
      params: [
        agentId, String(clamped), 1, safeTag,
        '', '', String(comment || '').slice(0, 280), fbHash,
      ],
      contract: REPUTATION_REGISTRY,
      address: raterAddress,
    }).then(async (r) => {
      const txHash = r.txHash || r.id || '';
      await markReviewed(key, { raterKey, targetUserId, refId, score: clamped, tag: safeTag, txHash });
      console.log(`[peer-rep] ${raterKey} reviewed ${targetUserId}: score ${clamped} (${safeTag}) ref ${refId} tx ${txHash} https://testnet.arcscan.app/tx/${txHash}`);
      return { posted: true, txHash };
    }, (e) => {
      console.warn(`[peer-rep] giveFeedback failed ${raterKey}→${targetUserId}: ${e.message}`);
      return { posted: false, reason: e.message };
    });
    return { posted: true };
  }

  /**
   * Duel settlement hook (called from agent_duel.settlePass after success).
   * Both participants may review each other; only ENABLED raters post.
   */
  async function reviewDuelOutcome({ winnerUserId, loserUserId, duelId, winnerKey, loserKey }) {
    const jobs = [];
    const wKey = winnerKey || circleAgent.isEnabledForUser(winnerUserId);
    const lKey = loserKey || circleAgent.isEnabledForUser(loserUserId);
    if (wKey) {
      jobs.push(reviewCounterparty({
        raterKey: wKey, targetUserId: loserUserId, refId: `duel:${duelId}`,
        score: scoreForDuel(true), tag: 'duel-win',
        comment: `Fair duel in the Puls Colosseum — won stake ${duelId.slice(0, 10)}…`,
        evidenceUrl: `https://testnet.arcscan.app/address/${REPUTATION_REGISTRY}`,
        targetKey: lKey || undefined,
      }));
    }
    if (lKey) {
      jobs.push(reviewCounterparty({
        raterKey: lKey, targetUserId: winnerUserId, refId: `duel:${duelId}`,
        score: scoreForDuel(false), tag: 'duel-loss',
        comment: `Lost this duel honestly — counterparty played well (${duelId.slice(0, 10)}…)`,
        evidenceUrl: `https://testnet.arcscan.app/address/${REPUTATION_REGISTRY}`,
        targetKey: wKey || undefined,
      }));
    }
    return Promise.all(jobs.map((j) => j.catch(() => {})));
  }

  /**
   * Sweep recent signal_unlocks: when an ENABLED agent bought a peer's
   * signal, review the creator with the buyer's post-trade confidence.
   */
  async function sweepSignalBuys() {
    try {
      const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
      const { data: unlocks } = await supabase
        .from('signal_unlocks')
        .select('user_id, signal_id, amount_usdc, created_at')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(50);
      for (const u of (unlocks || [])) {
        try {
          const raterKey = circleAgent.isEnabledForUser(u.user_id);
          if (!raterKey || !u.signal_id) continue;

          const dupKey = reviewKey(raterKey, 'signal-creator', `sig:${u.signal_id}`);
          // Resolve creator before dedupe-keying (target is part of the key).
          const { data: sig } = await supabase
            .from('creator_signals')
            .select('id, creator_user_id')
            .eq('id', u.signal_id)
            .maybeSingle();
          if (!sig || !sig.creator_user_id) continue;
          if (sig.creator_user_id === u.user_id) continue;
          if (reviewed.has(reviewKey(raterKey, sig.creator_user_id, `sig:${u.signal_id}`))) continue;

          // Buyer's post-trade confidence: their most recent decision on this
          // market (conviction 0..1), else a neutral 0.6.
          let confidence = 0.6;
          try {
            const { data: sigRow } = await supabase
              .from('creator_signals')
              .select('market_slug')
              .eq('id', u.signal_id)
              .maybeSingle();
            if (sigRow?.market_slug) {
              const { data: dec } = await supabase
                .from('notifications')
                .select('message')
                .eq('type', 'agent_decision')
                .eq('user_id', u.user_id)
                .eq('title', sigRow.market_slug)
                .order('created_at', { ascending: false })
                .limit(1);
              const m = dec?.[0] ? JSON.parse(dec[0].message) : null;
              if (m && Number.isFinite(Number(m.conviction))) confidence = Number(m.conviction);
            }
          } catch (_) { /* neutral fallback */ }

          await reviewCounterparty({
            raterKey,
            targetUserId: sig.creator_user_id,
            refId: `sig:${u.signal_id}`,
            score: scoreForSignal(confidence),
            tag: 'signal-purchase',
            comment: `Bought this signal for ${u.amount_usdc ?? '?'} USDC — worth it (confidence ${(confidence * 100).toFixed(0)}%).`,
            evidenceUrl: 'https://pulsmarket.tech/signals',
            targetKey: circleAgent.isEnabledForUser(sig.creator_user_id) || undefined,
          });
        } catch (e) {
          console.warn('[peer-rep] sweep item failed:', e.message);
        }
      }
    } catch (e) {
      console.warn('[peer-rep] sweepSignalBuys error:', e.message);
    }
  }

  // Boot sweep + periodic cadence.
  setTimeout(() => { sweepSignalBuys().catch(() => {}); }, 45_000);
  setInterval(() => { sweepSignalBuys().catch(() => {}); }, SWEEP_MIN * 60_000).unref?.();

  console.log(`[peer-rep] initAgentReputation ready (registry ${REPUTATION_REGISTRY.slice(0, 10)}…, sweeps every ${SWEEP_MIN}min)`);
  return { reviewCounterparty, reviewDuelOutcome, sweepSignalBuys };
}

export default initAgentReputation;
