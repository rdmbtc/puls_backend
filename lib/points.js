/**
 * Points Engine + Onboarding Quests — off-chain XP/reputation that drives
 * activation + retention (Traction). Per PLAN_POINTS_QUESTS_AGENTS.md.
 *
 * Anti-abuse / ToS-safe by design:
 *  • Points are NOT a token and NOT redeemable for money/USDC.
 *  • Every award is server-validated against real data, deduped via
 *    unique(user_id, reason, ref_id), capped per day, and most awards require
 *    a real action so empty-wallet bots earn nothing.
 *
 * Resilient: if the points tables aren't migrated yet, awards no-op quietly and
 * the API returns zeros — never throws into the hot path of a trade/unlock.
 *
 * Tables (migration backend/migrations/2026-06-19-points.sql):
 *   points_ledger(user_id, delta, reason, ref_type, ref_id, season, created_at,
 *                 unique(user_id,reason,ref_id))
 *   user_points(user_id PK, total_points, season, season_points, level,
 *               streak_days, last_active_date, updated_at)
 *   quest_progress(user_id, quest_key, progress, target, status,
 *                  completed_at, claimed_at, primary key(user_id,quest_key))
 */

const SEASON = 's1';

// level = floor(sqrt(total/50)) + 1  → 1:0, 2:50, 3:200, 4:450, 5:800, 6:1250…
function levelFor(total) {
  return Math.floor(Math.sqrt(Math.max(0, total) / 50)) + 1;
}
function nextLevelAt(total) {
  const lvl = levelFor(total);
  return 50 * lvl * lvl; // points needed to reach lvl+1
}

// Earn table — reason → {delta, dailyCap}. dailyCap=null means one-time/per-ref.
const EARN = {
  fund_wallet:        { delta: 50 },
  first_trade:        { delta: 40 },
  trade:              { delta: 5, dailyCap: 5 },
  win:                { delta: 15 },
  publish_signal:     { delta: 25 },
  signal_sold:        { delta: 10 },
  unlock_signal:      { delta: 5 },
  referral_activated: { delta: 60 },
  comment:            { delta: 2, dailyCap: 3 },
  daily_login:        { delta: 5 },
  streak_bonus:       { delta: 0 }, // delta supplied per-milestone by caller
  quest:              { delta: 0 }, // delta supplied by quest config
  tip_sent:           { delta: 5, dailyCap: 5 },
  blog_post:          { delta: 20, dailyCap: 40 },
};

// Onboarding + daily quests. `check(u)` runs against a batched user snapshot.
const QUESTS = [
  { key: 'q_signin',       group: 'onboarding', title: 'Sign in to Puls',                 points: 10, check: () => true },
  { key: 'q_fund',         group: 'onboarding', title: 'Fund your wallet',                points: 50, check: (u) => u.funded },
  { key: 'q_first_trade',  group: 'onboarding', title: 'Make your first prediction',      points: 40, check: (u) => u.tradeCount >= 1 },
  { key: 'q_follow',       group: 'onboarding', title: 'Add a market to your watchlist',  points: 15, check: (u) => u.watchlistCount > 0 },
  { key: 'q_signal',       group: 'onboarding', title: 'Unlock or publish a signal',      points: 25, check: (u) => u.unlockCount > 0 || u.publishedSignals > 0 },
  { key: 'q_daily_predict',group: 'daily',      title: 'Make a prediction today',         points: 10, check: (u) => u.tradedToday },
  { key: 'q_invite',       group: 'social',     title: 'Invite a friend who activates',   points: 60, check: (u) => u.activatedReferrals > 0 },
];

export function registerPoints(app, deps) {
  const { supabase, authenticateUser, requireVerifiedUser, strictLimiter, generalLimiter } = deps;
  let tablesOk = true; // flips false on first "relation does not exist"

  const today = () => new Date().toISOString().slice(0, 10);
  const isAgent = (uid) => uid === 'house_pulse' || (uid || '').startsWith('agent_');

  // ── Core: award points once (idempotent), update totals. Returns bool. ──────
  async function awardPoints(userId, reason, { delta, refType = null, refId = null } = {}) {
    if (!tablesOk || !userId) return false;
    const cfg = EARN[reason];
    const amount = delta != null ? delta : (cfg ? cfg.delta : 0);
    if (!amount) return false;
    try {
      // Daily-cap reasons use a date-bucketed ref so the unique key enforces the
      // cap window; one-time/per-ref reasons use the supplied refId.
      let key = refId;
      if (cfg && cfg.dailyCap != null) {
        // Count today's awards for this reason; stop at the cap.
        const since = `${today()}T00:00:00Z`;
        const { count } = await supabase
          .from('points_ledger')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId).eq('reason', reason).gte('created_at', since);
        if ((count ?? 0) >= cfg.dailyCap) return false;
        key = refId || `${reason}-${today()}-${(count ?? 0) + 1}`;
      }
      const { error: insErr } = await supabase
        .from('points_ledger')
        .insert({ user_id: userId, delta: amount, reason, ref_type: refType, ref_id: key, season: SEASON });
      if (insErr) {
        if (/relation .* does not exist/i.test(insErr.message)) { tablesOk = false; return false; }
        if (insErr.code === '23505' || /duplicate/i.test(insErr.message)) return false; // already awarded
        return false;
      }
      // Upsert denormalised totals.
      const { data: cur } = await supabase
        .from('user_points').select('total_points, season_points').eq('user_id', userId).maybeSingle();
      const total = (cur?.total_points ?? 0) + amount;
      const seasonPts = (cur?.season_points ?? 0) + amount;
      await supabase.from('user_points').upsert({
        user_id: userId, total_points: total, season: SEASON, season_points: seasonPts,
        level: levelFor(total), updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      return true;
    } catch (e) {
      if (/relation .* does not exist/i.test(e.message)) tablesOk = false;
      return false;
    }
  }

  // ── Streak: call on any authed action. Awards daily_login + milestones. ─────
  async function touchStreak(userId) {
    if (!tablesOk || !userId || isAgent(userId)) return;
    try {
      const { data: cur } = await supabase
        .from('user_points').select('streak_days, last_active_date').eq('user_id', userId).maybeSingle();
      const last = cur?.last_active_date || null;
      const t = today();
      if (last === t) return; // already counted today
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const streak = last === yesterday ? (cur?.streak_days ?? 0) + 1 : 1;
      await supabase.from('user_points').upsert({
        user_id: userId, streak_days: streak, last_active_date: t, season: SEASON,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      await awardPoints(userId, 'daily_login', { refId: `login-${t}` });
      const milestones = { 3: 10, 7: 25, 14: 60, 30: 150 };
      if (milestones[streak]) {
        await awardPoints(userId, 'streak_bonus', { delta: milestones[streak], refId: `streak-${streak}` });
      }
    } catch (_) {}
  }

  // ── Build a per-user snapshot for quest checks (one batched read set). ──────
  async function userSnapshot(userId) {
    const u = { funded: false, tradeCount: 0, tradedToday: false, watchlistCount: 0,
      unlockCount: 0, publishedSignals: 0, activatedReferrals: 0 };
    try {
      const since = `${today()}T00:00:00Z`;
      const [tradesAll, tradesToday, unlocks, pub, wl] = await Promise.all([
        supabase.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('trades').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since),
        supabase.from('signal_unlocks').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        supabase.from('creator_signals').select('id', { count: 'exact', head: true }).eq('creator_user_id', userId).eq('status', 'published'),
        Promise.resolve({ error: null, count: 0 }), // supabase.from('watchlist').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      ]);
      u.tradeCount = tradesAll.count ?? 0;
      u.tradedToday = (tradesToday.count ?? 0) > 0;
      u.unlockCount = unlocks.count ?? 0;
      u.publishedSignals = pub.count ?? 0;
      u.watchlistCount = wl.error ? 0 : (wl.count ?? 0);
      u.funded = u.tradeCount > 0 || u.unlockCount > 0; // proxy: acted on-chain ⇒ funded
    } catch (_) {}
    return u;
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  app.get('/api/points/me', authenticateUser, async (req, res) => {
    try {
      const userId = req.query.userId;
      const { data } = await supabase
        .from('user_points').select('*').eq('user_id', userId).maybeSingle();
      const total = data?.total_points ?? 0;
      const { data: recent } = await supabase
        .from('points_ledger').select('delta, reason, created_at')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
      res.json({
        total, level: levelFor(total), nextLevelAt: nextLevelAt(total),
        season: SEASON, seasonPoints: data?.season_points ?? 0,
        streakDays: data?.streak_days ?? 0, recent: recent || [],
      });
    } catch (e) {
      res.json({ total: 0, level: 1, nextLevelAt: 50, season: SEASON, seasonPoints: 0, streakDays: 0, recent: [] });
    }
  });

  app.get('/api/points/leaderboard', generalLimiter || ((_q,_s,n)=>n()), async (req, res) => {
    try {
      const type = ['humans', 'agents', 'all'].includes(req.query.type) ? req.query.type : 'all';
      const { data } = await supabase
        .from('user_points').select('user_id, total_points, level, season_points')
        .eq('season', SEASON).order('season_points', { ascending: false }).limit(100);
      let rows = (data || []).map(r => ({ ...r, isAgent: isAgent(r.user_id) }));
      if (type === 'humans') rows = rows.filter(r => !r.isAgent);
      if (type === 'agents') rows = rows.filter(r => r.isAgent);
      res.json(rows.slice(0, Math.min(50, parseInt(req.query.limit || '50', 10))));
    } catch (e) { res.json([]); }
  });

  app.get('/api/quests', authenticateUser, async (req, res) => {
    try {
      const userId = req.query.userId;
      const u = await userSnapshot(userId);
      const { data: progress } = await supabase
        .from('quest_progress').select('quest_key, status').eq('user_id', userId);
      const claimed = new Set((progress || []).filter(p => p.status === 'claimed').map(p => p.quest_key));
      const quests = QUESTS.map(q => {
        const done = q.check(u);
        const isClaimed = claimed.has(q.key);
        return {
          key: q.key, group: q.group, title: q.title, points: q.points,
          status: isClaimed ? 'claimed' : (done ? 'completed' : 'in_progress'),
        };
      });
      res.json({ quests, season: SEASON });
    } catch (e) {
      res.json({ quests: [], season: SEASON });
    }
  });

  app.post('/api/quests/claim', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId;
      const key = String(req.body.quest_key || '');
      const quest = QUESTS.find(q => q.key === key);
      if (!quest) return res.status(400).json({ error: 'Unknown quest' });
      // Re-validate server-side (never trust the client).
      const u = await userSnapshot(userId);
      if (!quest.check(u)) return res.status(400).json({ error: 'Quest not complete yet' });
      // Idempotent claim.
      const { data: existing } = await supabase
        .from('quest_progress').select('status').eq('user_id', userId).eq('quest_key', key).maybeSingle();
      if (existing?.status === 'claimed') return res.json({ ok: true, alreadyClaimed: true });
      await supabase.from('quest_progress').upsert({
        user_id: userId, quest_key: key, status: 'claimed', target: 1, progress: 1,
        completed_at: new Date().toISOString(), claimed_at: new Date().toISOString(),
      }, { onConflict: 'user_id,quest_key' });
      const awarded = await awardPoints(userId, 'quest', { delta: quest.points, refType: 'quest', refId: key });
      res.json({ ok: true, awarded, points: quest.points });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[points] routes registered (/api/points/*, /api/quests/*)');
  // Expose the helpers so server.js can hook earns into existing handlers.
  return { awardPoints, touchStreak };
}
