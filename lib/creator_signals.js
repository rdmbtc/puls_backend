// ── Creator Signals — premium forecasts, on-chain attested, x402 per-read ─────
//
// The full creator-economy content layer on top of Puls markets:
//
//   • Creators (humans or agents) draft a signal, edit it, then PUBLISH.
//   • Publishing writes an on-chain attestation to the SignalRegistry contract
//     on Arc — keccak256(content) + creator address + price + timestamp — so the
//     authorship and integrity of a piece of alpha are independently verifiable
//     (same trust-minimisation as UMA gives outcomes, here for content).
//   • Readers pay a per-read USDC nanopayment to unlock the full thesis (x402),
//     settled to the creator's SCA wallet — exactly-once via signal_unlocks.
//   • Per-signal + per-creator analytics (views / unlocks / revenue).
//
// Routes:
//   POST   /api/signals                     create a draft           (verified)
//   GET    /api/signals?creatorUserId=      list (mine = full, others = teaser)
//   GET    /api/signals/:id                 one signal (thesis only if unlocked/owner)
//   PATCH  /api/signals/:id                 edit a draft             (owner)
//   POST   /api/signals/:id/publish         on-chain attest + go live (owner, verified)
//   POST   /api/signals/:id/archive         withdraw                 (owner)
//   POST   /api/signals/:id/unlock          pay creator, grant access (verified)
//   GET    /api/signals/:id/analytics       views/unlocks/revenue    (owner)
//
// Wiring (server.js):
//   import { registerCreatorSignals } from './lib/creator_signals.js';
//   registerCreatorSignals(app, {
//     supabase, circle, USDC, getWalletId, getWalletInfo,
//     authenticateUser, requireVerifiedUser, strictLimiter,
//     walletClient, publicClient, keccak256, toHex,
//   });

const SIGNALS_ENABLED =
  String(process.env.SIGNALS_ENABLED ?? 'true').toLowerCase() !== 'false';
// Live per-read payments gate (mirrors ALPHA_PAID_ENABLED). When off, unlock is
// a no-op success so the flow is demoable without spending USDC.
const SIGNALS_PAID_ENABLED =
  String(process.env.SIGNALS_PAID_ENABLED || '').toLowerCase() === 'true';
const SIGNAL_REGISTRY_ADDRESS = (process.env.SIGNAL_REGISTRY_ADDRESS || '').trim();

const TITLE_MAX = 140;
const TEASER_MAX = 280;
const THESIS_MAX = 8000;
const STANCES = ['YES', 'NO'];
const ARC_NETWORK = 'eip155:5042002';
const APP_BASE_URL = (process.env.REFERRAL_BASE_URL || process.env.APP_BASE_URL || 'https://pulsmarket.tech').replace(/\/+$/, '');

// Derive a URL-safe slug from a question when an explicit market slug is absent
// (free-form / legacy signals). ensureMarketBySlug() also resolves by question.
function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// Canonical string hashed on-chain — order matters, keep it stable.
function canonicalContent(s) {
  return [
    s.title || '',
    s.market_question || '',
    s.stance || '',
    String(s.confidence ?? ''),
    String(s.edge_bps ?? ''),
    s.horizon || '',
    s.thesis || '',
  ].join('\n--\n');
}

export function registerCreatorSignals(app, deps) {
  const {
    supabase,
    circle,
    USDC,
    getWalletId,
    getWalletInfo,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
    walletClient,
    publicClient,
    keccak256,
    toHex,
    awardPoints,
  } = deps;
  const award = typeof awardPoints === 'function' ? awardPoints : async () => {};

  // Optional auth for public read endpoints: if a valid Bearer token is present
  // we derive the verified `supabase_<uuid>` id (so the owner view is secure and
  // can't be spoofed via the query string); otherwise we continue anonymously
  // (published teasers only). Never rejects — unlike authenticateUser.
  async function optionalAuth(req, _res, next) {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) {
          req.query.userId = `supabase_${data.user.id}`; // trusted id
        } else {
          delete req.query.userId; // ignore unverified/spoofed ids
        }
      } else {
        delete req.query.userId;
      }
    } catch (_) {
      delete req.query.userId;
    }
    next();
  }

  // Public-safe projection. Includes thesis only when the caller owns it or
  // has unlocked it. The agent's STANCE (YES/NO) and the researched SOURCES are
  // part of the paid alpha too — they stay hidden until unlock so a reader pays
  // first, then learns what the agent picked and the data behind it.
  function publicSignal(row, { withThesis = false, isOwner = false } = {}) {
    const reveal = Boolean(withThesis || isOwner);
    const allSources = Array.isArray(row.sources)
      ? row.sources.filter((x) => x && x.url).slice(0, 4)
      : [];
    const base = {
      id: row.id,
      creatorUserId: row.creator_user_id,
      title: row.title,
      marketQuestion: row.market_question,
      marketSlug: row.market_slug || (row.market_question ? slugify(row.market_question) : null),
      stance: reveal ? row.stance : null, // hidden until unlocked
      confidence: row.confidence,
      edgeBps: row.edge_bps,
      horizon: row.horizon,
      teaser: row.teaser,
      priceUsdc: Number(row.price_usdc),
      status: row.status,
      onchain: row.onchain_tx
        ? {
            tx: row.onchain_tx,
            signalId: row.onchain_signal_id,
            contentHash: row.content_hash,
            explorer: `https://testnet.arcscan.app/tx/${row.onchain_tx}`,
          }
        : null,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      bond: row.bond_status
        ? {
            amountUsdc: Number(row.bond_amount_usdc || 0),
            status: row.bond_status, // active | returned | slashed
            correct: row.bond_correct ?? null,
            tx: row.bond_post_tx || null,
            settleTx: row.bond_settle_tx || null,
            contract: process.env.AGENT_BOND_ADDRESS || null,
            explorer: process.env.AGENT_BOND_ADDRESS
              ? `https://testnet.arcscan.app/address/${process.env.AGENT_BOND_ADDRESS}`
              : null,
          }
        : null,
      unlocked: Boolean(withThesis),
      isOwner,
    };
    if (isOwner) {
      base.analytics = {
        views: row.views ?? 0,
        unlocks: row.unlocks_count ?? 0,
        revenueUsdc: Number(row.revenue_usdc ?? 0),
      };
    }
    if (reveal) base.thesis = row.thesis;
    base.marketLink = base.marketSlug ? `https://app.pulsmarket.tech/?m=${base.marketSlug}` : null;
    // Sources are part of the paid alpha: reveal only after unlock; otherwise
    // just tease the count so the reader knows the call is research-backed.
    base.sourcesCount = allSources.length;
    base.sources = reveal
      ? allSources.map((x) => ({ title: x.title || x.source || x.url, url: x.url, source: x.source || null }))
      : [];
    return base;
  }

  async function hasUnlocked(userId, signalId) {
    if (!userId) return false;
    try {
      const { data } = await supabase
        .from('signal_unlocks')
        .select('signal_id')
        .eq('user_id', userId)
        .eq('signal_id', signalId)
        .maybeSingle();
      return Boolean(data);
    } catch (e) {
      console.warn('[signals] hasUnlocked failed:', e.message);
      return false;
    }
  }

  // Honest creator track record: for each creator, look at their published
  // signals whose linked market has RESOLVED, and count how many called the
  // correct outcome (stance matches deployed_markets.outcome). Returns a map
  // userId -> { resolved, correct, winRate(0..1)|null, published }. Win-rate is
  // null when nothing has resolved yet (so the UI can say "new creator" instead
  // of a fake 0%). Best-effort; never throws.
  async function trackRecordFor(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    try {
      const { data: sigs } = await supabase
        .from('creator_signals')
        .select('creator_user_id, market_slug, stance, status')
        .in('creator_user_id', ids)
        .eq('status', 'published');
      const rows = sigs || [];
      const slugs = [...new Set(rows.map((r) => r.market_slug).filter(Boolean))];
      const resolvedBySlug = new Map();
      if (slugs.length) {
        const { data: dm } = await supabase
          .from('deployed_markets')
          .select('slug, resolved, outcome')
          .in('slug', slugs);
        for (const m of dm || []) {
          if (m.resolved === true && (m.outcome === true || m.outcome === false)) {
            resolvedBySlug.set(m.slug, m.outcome);
          }
        }
      }
      for (const id of ids) out.set(id, { resolved: 0, correct: 0, winRate: null, published: 0 });
      for (const r of rows) {
        const rec = out.get(r.creator_user_id);
        if (!rec) continue;
        rec.published += 1;
        if (r.market_slug && resolvedBySlug.has(r.market_slug)) {
          rec.resolved += 1;
          const outcome = resolvedBySlug.get(r.market_slug); // true = YES won
          const calledYes = String(r.stance).toUpperCase() === 'YES';
          if (outcome === calledYes) rec.correct += 1;
        }
      }
      for (const rec of out.values()) {
        rec.winRate = rec.resolved > 0 ? rec.correct / rec.resolved : null;
      }
    } catch (e) {
      console.warn('[signals] trackRecord failed:', e.message);
    }
    return out;
  }

  // ── Create a draft ──────────────────────────────────────────────────────
  app.post('/api/signals', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!SIGNALS_ENABLED) return res.status(503).json({ error: 'Signals are disabled' });
      const userId = req.body.userId; // forced to verified id by authenticateUser
      const title = String(req.body.title || '').trim();
      const thesis = String(req.body.thesis || '').trim();
      if (!title) return res.status(400).json({ error: 'Title is required' });
      if (title.length > TITLE_MAX) return res.status(400).json({ error: `Title exceeds ${TITLE_MAX} chars` });
      if (!thesis) return res.status(400).json({ error: 'Thesis is required' });
      if (thesis.length > THESIS_MAX) return res.status(400).json({ error: `Thesis exceeds ${THESIS_MAX} chars` });

      const stance = STANCES.includes(String(req.body.stance || '').toUpperCase())
        ? String(req.body.stance).toUpperCase()
        : 'YES';
      const teaser = String(req.body.teaser || '').trim().slice(0, TEASER_MAX);

      const insert = {
        creator_user_id: userId,
        title,
        market_question: String(req.body.marketQuestion || '').trim() || null,
        market_slug: String(req.body.marketSlug || '').trim() || null,
        stance,
        confidence: clampNum(req.body.confidence, 0, 1, 0.6),
        edge_bps: Math.round(clampNum(req.body.edgeBps, 0, 100000, 0)),
        horizon: String(req.body.horizon || '').trim() || null,
        teaser,
        thesis,
        price_usdc: clampNum(req.body.priceUsdc, 0, 1000, 0.001),
        status: 'draft',
      };
      const { data, error } = await supabase
        .from('creator_signals')
        .insert(insert)
        .select('*')
        .single();
      if (error) throw error;
      res.json({ ok: true, signal: publicSignal(data, { isOwner: true }) });
    } catch (e) {
      console.error('[signals] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── List signals ────────────────────────────────────────────────────────
  // ?creatorUserId= → that creator's signals. Owner sees drafts + analytics +
  // thesis; others see only published, teaser-only. No filter → published feed.
  app.get('/api/signals', optionalAuth, async (req, res) => {
    try {
      const me = req.query.userId || null; // forced to verified id if a token was sent
      const creatorUserId = req.query.creatorUserId || null;
      const isOwnerView = creatorUserId && me && creatorUserId === me;

      let q = supabase.from('creator_signals').select('*').order('created_at', { ascending: false }).limit(100);
      if (creatorUserId) q = q.eq('creator_user_id', creatorUserId);
      if (!isOwnerView) q = q.eq('status', 'published'); // non-owners: published only

      const { data, error } = await q;
      if (error) throw error;

      const unlockedSet = new Set();
      if (me && !isOwnerView) {
        const { data: ul } = await supabase
          .from('signal_unlocks').select('signal_id').eq('user_id', me);
        (ul || []).forEach((r) => unlockedSet.add(r.signal_id));
      }

      const signals = (data || []).map((row) =>
        publicSignal(row, {
          isOwner: isOwnerView,
          withThesis: unlockedSet.has(row.id),
        })
      );
      // Attach an honest per-creator track record (resolved win-rate).
      const tr = await trackRecordFor((data || []).map((r) => r.creator_user_id));
      for (const sig of signals) {
        const rec = tr.get(sig.creatorUserId);
        if (rec) {
          sig.creatorTrackRecord = {
            resolved: rec.resolved,
            correct: rec.correct,
            winRate: rec.winRate,
            published: rec.published,
          };
        }
      }
      res.json({ signals, live: SIGNALS_PAID_ENABLED });
    } catch (e) {
      console.error('[signals] list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get one (counts a view; thesis gated) ─────────────────────────────────
  app.get('/api/signals/:id', optionalAuth, async (req, res) => {
    try {
      const me = req.query.userId || null;
      const { data: row, error } = await supabase
        .from('creator_signals').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Signal not found' });

      const isOwner = me && row.creator_user_id === me;
      if (!isOwner && row.status !== 'published') {
        return res.status(404).json({ error: 'Signal not found' });
      }

      // Count a view (best-effort, not for the owner).
      if (!isOwner) {
        supabase.rpc('increment', {}).then(() => {}).catch(() => {});
        supabase.from('creator_signals')
          .update({ views: (row.views ?? 0) + 1 })
          .eq('id', row.id)
          .then(() => {})
          .catch(() => {});
      }

      const unlocked = isOwner || (await hasUnlocked(me, row.id));
      if (!unlocked) {
        return res.status(402).json({
          locked: true,
          signal: publicSignal(row, { withThesis: false }),
          live: SIGNALS_PAID_ENABLED,
        });
      }
      res.json({ locked: false, signal: publicSignal(row, { withThesis: true, isOwner }) });
    } catch (e) {
      console.error('[signals] get error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Edit a draft (owner only, draft only) ─────────────────────────────────
  app.patch('/api/signals/:id', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId;
      const { data: row, error } = await supabase
        .from('creator_signals').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Signal not found' });
      if (row.creator_user_id !== userId) return res.status(403).json({ error: 'Not your signal' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Only drafts can be edited' });

      const patch = { updated_at: new Date().toISOString() };
      if (req.body.title !== undefined) {
        const t = String(req.body.title).trim();
        if (!t || t.length > TITLE_MAX) return res.status(400).json({ error: 'Invalid title' });
        patch.title = t;
      }
      if (req.body.thesis !== undefined) {
        const th = String(req.body.thesis).trim();
        if (!th || th.length > THESIS_MAX) return res.status(400).json({ error: 'Invalid thesis' });
        patch.thesis = th;
      }
      if (req.body.teaser !== undefined) patch.teaser = String(req.body.teaser).trim().slice(0, TEASER_MAX);
      if (req.body.marketQuestion !== undefined) patch.market_question = String(req.body.marketQuestion).trim() || null;
      if (req.body.stance !== undefined && STANCES.includes(String(req.body.stance).toUpperCase())) {
        patch.stance = String(req.body.stance).toUpperCase();
      }
      if (req.body.confidence !== undefined) patch.confidence = clampNum(req.body.confidence, 0, 1, row.confidence);
      if (req.body.edgeBps !== undefined) patch.edge_bps = Math.round(clampNum(req.body.edgeBps, 0, 100000, row.edge_bps));
      if (req.body.horizon !== undefined) patch.horizon = String(req.body.horizon).trim() || null;
      if (req.body.priceUsdc !== undefined) patch.price_usdc = clampNum(req.body.priceUsdc, 0, 1000, row.price_usdc);

      const { data: updated, error: uErr } = await supabase
        .from('creator_signals').update(patch).eq('id', row.id).select('*').single();
      if (uErr) throw uErr;
      res.json({ ok: true, signal: publicSignal(updated, { isOwner: true }) });
    } catch (e) {
      console.error('[signals] edit error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Publish: write on-chain attestation, flip to 'published' ──────────────
  app.post('/api/signals/:id/publish', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId;
      const { data: row, error } = await supabase
        .from('creator_signals').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Signal not found' });
      if (row.creator_user_id !== userId) return res.status(403).json({ error: 'Not your signal' });
      if (row.status === 'published') return res.json({ ok: true, alreadyPublished: true, signal: publicSignal(row, { isOwner: true }) });

      // Deterministic ids/hashes.
      const onchainSignalId = keccak256(toHex(row.id));            // bytes32 from the row UUID
      const contentHash = keccak256(toHex(canonicalContent(row))); // bytes32 of canonical content
      const priceMicro = BigInt(Math.round(Number(row.price_usdc) * 1_000_000));

      let onchainTx = null;
      if (SIGNAL_REGISTRY_ADDRESS && walletClient && publicClient) {
        try {
          onchainTx = await walletClient.writeContract({
            address: SIGNAL_REGISTRY_ADDRESS,
            abi: [{
              name: 'publish', type: 'function', stateMutability: 'nonpayable',
              inputs: [
                { name: 'signalId', type: 'bytes32' },
                { name: 'contentHash', type: 'bytes32' },
                { name: 'priceUsdc', type: 'uint256' },
              ],
              outputs: [],
            }],
            functionName: 'publish',
            args: [onchainSignalId, contentHash, priceMicro],
          });
          // Don't block the response on confirmation; surface the tx hash now.
          publicClient.waitForTransactionReceipt({ hash: onchainTx }).catch((e) =>
            console.warn('[signals] publish receipt wait failed:', e.shortMessage || e.message)
          );
        } catch (txErr) {
          // On-chain attestation is best-effort: a creator can still publish
          // off-chain if the registry isn't deployed / admin key missing.
          console.error('[signals] on-chain publish failed:', txErr.shortMessage || txErr.message);
        }
      }

      const { data: updated, error: uErr } = await supabase
        .from('creator_signals')
        .update({
          status: 'published',
          onchain_signal_id: onchainSignalId,
          content_hash: contentHash,
          onchain_tx: onchainTx,
          published_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .select('*')
        .single();
      if (uErr) throw uErr;

      award(userId, 'publish_signal', { refType: 'signal', refId: String(req.params.id) }).catch(() => {});
      res.json({
        ok: true,
        attested: Boolean(onchainTx),
        signal: publicSignal(updated, { isOwner: true }),
      });
    } catch (e) {
      console.error('[signals] publish error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Archive (withdraw) ────────────────────────────────────────────────────
  app.post('/api/signals/:id/archive', authenticateUser, requireVerifiedUser, async (req, res) => {
    try {
      const userId = req.body.userId;
      const { data: row, error } = await supabase
        .from('creator_signals').select('creator_user_id,status').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Signal not found' });
      if (row.creator_user_id !== userId) return res.status(403).json({ error: 'Not your signal' });

      const { data: updated, error: uErr } = await supabase
        .from('creator_signals')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('id', req.params.id).select('*').single();
      if (uErr) throw uErr;
      res.json({ ok: true, signal: publicSignal(updated, { isOwner: true }) });
    } catch (e) {
      console.error('[signals] archive error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Unlock (pay the creator a per-read USDC micro-fee) ─────────────────────
  // Exactly-once semantics identical to alpha_unlocks: RESERVE pending → pay →
  // confirm. Updates per-signal analytics counters on confirm.
  app.post('/api/signals/:id/unlock', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId;
      const { data: signal, error } = await supabase
        .from('creator_signals').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!signal) return res.status(404).json({ error: 'Signal not found' });
      if (signal.status !== 'published') return res.status(409).json({ error: 'Signal is not published' });
      if (signal.creator_user_id === userId) {
        return res.json({ ok: true, alreadyUnlocked: true, signal: publicSignal(signal, { withThesis: true }) });
      }

      // (1)/(2): already have access (confirmed or pending) → grant, no charge.
      const { data: existing } = await supabase
        .from('signal_unlocks').select('status').eq('user_id', userId).eq('signal_id', signal.id).maybeSingle();
      if (existing) {
        if (existing.status === 'pending') {
          await supabase.from('signal_unlocks')
            .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
            .eq('user_id', userId).eq('signal_id', signal.id);
        }
        return res.json({ ok: true, alreadyUnlocked: true, signal: publicSignal(signal, { withThesis: true }) });
      }

      if (!SIGNALS_PAID_ENABLED) {
        return res.json({
          ok: false, live: false,
          message: 'Paid unlock activates at launch — payments are currently disabled.',
          signal: publicSignal(signal, { withThesis: false }),
        });
      }

      // Resolve creator payout address from their wallet. House/swarm agents
      // store their wallet under `agent_<userId>` (e.g. agent_swarm_striker →
      // wallet key agent_agent_swarm_striker), so try that too.
      let creatorWalletId = await getWalletId(signal.creator_user_id);
      if (!creatorWalletId && /agent/i.test(signal.creator_user_id)) {
        creatorWalletId = await getWalletId(`agent_${signal.creator_user_id}`);
      }
      const creatorInfo = creatorWalletId ? await getWalletInfo(creatorWalletId) : null;
      const payTo = creatorInfo?.address
        || (signal.creator_user_id.startsWith('eth_') ? signal.creator_user_id.replace('eth_', '') : null);
      if (!payTo) return res.status(503).json({ error: 'Creator payout address unavailable' });

      const readerWalletId = await getWalletId(userId);
      if (!readerWalletId) return res.status(400).json({ error: 'No wallet for user' });
      const readerInfo = await getWalletInfo(readerWalletId);

      const price = Number(signal.price_usdc) || 0;
      if (parseFloat(readerInfo.usdcBalance) < price) {
        return res.status(402).json({ error: 'Insufficient USDC balance to unlock' });
      }

      // RESERVE access (unique(user_id,signal_id) = idempotency key) BEFORE paying.
      const { error: reserveErr } = await supabase
        .from('signal_unlocks')
        .insert({ user_id: userId, signal_id: signal.id, status: 'pending', amount_usdc: price });
      if (reserveErr) {
        console.warn('[signals] reserve conflict, treating as unlocked:', reserveErr.message);
        return res.json({ ok: true, alreadyUnlocked: true, signal: publicSignal(signal, { withThesis: true }) });
      }

      // Real on-chain USDC micro-transfer reader → creator (gasless SCA).
      let txId = null;
      try {
        const amountMicro = Math.round(price * 1_000_000).toString();
        const txRes = await circle.createContractExecutionTransaction({
          walletId: readerWalletId,
          contractAddress: USDC,
          abiFunctionSignature: 'transfer(address,uint256)',
          abiParameters: [payTo, amountMicro],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        txId = txRes.data?.id || null;
      } catch (txErr) {
        await supabase.from('signal_unlocks').delete().eq('user_id', userId).eq('signal_id', signal.id);
        console.error('[signals] transfer submit failed, reservation rolled back:', txErr.message);
        return res.status(502).json({ error: 'Payment failed, please try again' });
      }

      // Confirm durable access.
      await supabase.from('signal_unlocks')
        .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), tx_id: txId })
        .eq('user_id', userId).eq('signal_id', signal.id);

      // Bump per-signal analytics counters (best-effort).
      supabase.from('creator_signals')
        .update({
          unlocks_count: (signal.unlocks_count ?? 0) + 1,
          revenue_usdc: Number(signal.revenue_usdc ?? 0) + price,
        })
        .eq('id', signal.id)
        .then(() => {})
        .catch((e) => console.warn('[signals] analytics bump failed:', e.message));

      // Receipt → Earnings tab (endpoint='signal_unlock').
      supabase.from('x402_payments').insert({
        endpoint: 'signal_unlock',
        payer: readerInfo.address || null,
        pay_to: payTo,
        amount_usdc: price.toString(),
        network: ARC_NETWORK,
        gateway_tx: txId,
        raw: { kind: 'signal_unlock', signalId: signal.id, priceUsdc: price },
      }).then(({ error: e }) => { if (e) console.warn('[signals] receipt insert failed:', e.message); });

      console.log(`[signals] unlock ${signal.id} — ${price} USDC ${readerInfo.address} → ${payTo} (tx ${txId})`);
      // Points: reader earns for unlocking; creator earns for the sale.
      award(userId, 'unlock_signal', { refType: 'unlock', refId: signal.id }).catch(() => {});
      if (signal.creator_user_id && signal.creator_user_id !== userId) {
        award(signal.creator_user_id, 'signal_sold', { refType: 'unlock', refId: `${signal.id}-${userId}` }).catch(() => {});
      }
      res.json({
        ok: true,
        signal: publicSignal(signal, { withThesis: true }),
        receipt: { amountUsdc: price, payTo, txId, network: ARC_NETWORK },
      });
    } catch (e) {
      console.error('[signals] unlock error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Analytics (owner only) ────────────────────────────────────────────────
  app.get('/api/signals/:id/analytics', optionalAuth, async (req, res) => {
    try {
      const me = req.query.userId || null;
      const { data: row, error } = await supabase
        .from('creator_signals').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Signal not found' });
      if (!me || row.creator_user_id !== me) return res.status(403).json({ error: 'Not your signal' });

      res.json({
        analytics: {
          views: row.views ?? 0,
          unlocks: row.unlocks_count ?? 0,
          revenueUsdc: Number(row.revenue_usdc ?? 0),
          conversion: (row.views ?? 0) > 0 ? (row.unlocks_count ?? 0) / row.views : 0,
        },
        onchain: row.onchain_tx
          ? { tx: row.onchain_tx, explorer: `https://testnet.arcscan.app/tx/${row.onchain_tx}` }
          : null,
      });
    } catch (e) {
      console.error('[signals] analytics error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(
    `[signals] creator-signals routes registered (enabled: ${SIGNALS_ENABLED}, ` +
    `paid: ${SIGNALS_PAID_ENABLED ? 'ON' : 'OFF'}, registry: ${SIGNAL_REGISTRY_ADDRESS || 'none'})`
  );
}
