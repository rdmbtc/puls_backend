/**
 * Puls Comments — community layer (F1).
 *
 * Lets signed-in users comment on anything (markets, profiles, events, alpha),
 * reply to each other (one level of nesting) and like comments, with an in-app
 * notification to the author on a reply or a like. Stored in Supabase — text is
 * tiny so the free tier is plenty (500MB ≈ ~1.5M comments) and we already run
 * Supabase for everything else.
 *
 * Data model (see supabase-schema.sql):
 *   comments(id, user_id, target_type, target_id, body, parent_id, deleted, created_at)
 *   comment_likes(id, comment_id, user_id, created_at)  unique(comment_id,user_id)
 *
 * Routes:
 *   GET    /api/comments?target_type=&target_id=   threaded list (top + replies),
 *                                                  like_count + liked_by_me + author.
 *   POST   /api/comments                           { target_type, target_id, body, parent_id? }
 *   DELETE /api/comments/:id                       soft-delete, owner only.
 *   POST   /api/comments/:id/like                  toggle like → { liked, like_count }.
 *   GET    /api/comments/config                    { maxLen, targetTypes, live }.
 *
 * Moderation / safety:
 *   - body trimmed, 1..COMMENT_MAX_LEN chars (default 1000); empty/oversized rejected.
 *   - target_type must be in COMMENT_TARGET_TYPES (default market,profile,event,alpha).
 *   - replies are one level deep (a reply to a reply re-parents to its top-level root).
 *   - soft-delete keeps thread shape: a deleted comment with replies shows as
 *     "[deleted]"; a deleted leaf is hidden entirely.
 *   - strictLimiter throttles writes; only verified accounts can write
 *     (web3 guests are read-only, same rule as the rest of the API).
 *   - optional COMMENTS_ENABLED kill-switch (default ON — comments move no funds).
 *
 * Wiring (server.js):
 *   import { registerComments } from './lib/comments.js';
 *   registerComments(app, { supabase, authenticateUser, requireVerifiedUser,
 *     strictLimiter, createNotification });
 */

import { eventBus, EVENTS } from './events.js';

const COMMENTS_ENABLED =
  String(process.env.COMMENTS_ENABLED ?? 'true').toLowerCase() !== 'false';
const COMMENT_MAX_LEN = Math.max(
  1,
  parseInt(process.env.COMMENT_MAX_LEN || '1000', 10) || 1000
);
const TARGET_TYPES = (process.env.COMMENT_TARGET_TYPES || 'market,profile,event,alpha,blog')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function shortBody(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

export function registerComments(app, deps) {
  const {
    supabase,
    authenticateUser,
    optionalAuth,
    requireVerifiedUser,
    strictLimiter,
    createNotification,
    awardPoints,
  } = deps;
  const award = typeof awardPoints === 'function' ? awardPoints : async () => {};

  const notify = typeof createNotification === 'function'
    ? createNotification
    : async () => {};

  const AGENT_NAMES = {
    agent_swarm_vega: { name: 'Vega ⚡', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=vega' },
    agent_swarm_atlas: { name: 'Atlas 📈', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=atlas' },
    agent_swarm_orion: { name: 'Orion 🏹', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=orion' },
    agent_swarm_cygnus: { name: 'Cygnus 🛡️', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=cygnus' },
    agent_swarm_lyra: { name: 'Lyra 🎵', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=lyra' },
    agent_swarm_sirius: { name: 'Sirius ⭐', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=sirius' },
    agent_swarm_sage: { name: 'Sage 🧠', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=sage' },
    agent_swarm_striker: { name: 'Striker ⚽', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=striker' },
    house_agent: { name: 'House Agent 🏛️', avatar: 'https://api.dicebear.com/7.x/bottts/png?seed=house' },
  };

  // Resolve display_name + avatar_url for a set of user_ids in one query.
  async function loadAuthors(userIds) {
    const ids = [...new Set(userIds.filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;
    try {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, display_name, avatar_url')
        .in('user_id', ids);
      for (const p of data || []) map.set(p.user_id, p);
    } catch (e) {
      console.warn('[comments] author lookup failed:', e.message);
    }
    const author = (uid) => {
      const p = map.get(uid) || {};
      const agentInfo = AGENT_NAMES[uid];
      const isAgent = Boolean(agentInfo) || String(uid || '').includes('agent');
      return {
        userId: uid,
        displayName: (p.display_name || '').trim() || (agentInfo ? agentInfo.name : (isAgent ? 'Puls Agent' : 'Puls Trader')),
        avatarUrl:
          p.avatar_url ||
          (agentInfo ? agentInfo.avatar : `https://api.dicebear.com/7.x/${isAgent ? 'bottts' : 'identicon'}/png?size=128&seed=${encodeURIComponent(uid)}`),
        isAgent,
      };
    };
    map.author = author;
    return map;
  }

  function extractDuelInfo(body) {
    const isDuel = /⚔️|\[Duel/i.test(body);
    const duelSide = /\bYES\b/i.test(body) ? 'YES' : (/\bNO\b/i.test(body) ? 'NO' : null);
    const matchOpponent = body.match(/vs\s+([a-zA-Z0-9_⚡📈🏹🛡️🎵⭐🧠⚽🤖]+)/i);
    const duelOpponent = matchOpponent ? matchOpponent[1] : null;
    return { isDuel, duelSide, duelOpponent };
  }

  // GET /api/comments?target_type=&target_id= — threaded list for a target (public read).
  const getAuth = typeof optionalAuth === 'function' ? optionalAuth : ((req, _res, next) => next());
  app.get('/api/comments', getAuth, async (req, res) => {
    try {
      const targetType = String(req.query.target_type || '').trim().toLowerCase();
      const rawTargetId = String(req.query.target_id || req.query.target_ids || '').trim();
      const me = req.query.userId || req.user?.id;
      if (!TARGET_TYPES.includes(targetType) || !rawTargetId) {
        return res.status(400).json({ error: 'target_type and target_id are required' });
      }

      const targetIds = rawTargetId.split(',').map((s) => s.trim()).filter(Boolean);
      let query = supabase
        .from('comments')
        .select('id, user_id, target_type, target_id, body, parent_id, deleted, created_at')
        .eq('target_type', targetType);

      if (targetIds.length === 1) {
        query = query.eq('target_id', targetIds[0]);
      } else {
        query = query.in('target_id', targetIds);
      }

      const { data: rows, error } = await query.order('created_at', { ascending: true });
      if (error) throw error;

      const all = rows || [];
      const ids = all.map((c) => c.id);

      // Like counts + which ones the caller liked, in two small queries.
      const likeCount = new Map();
      const likedByMe = new Set();
      if (ids.length) {
        const { data: likes } = await supabase
          .from('comment_likes')
          .select('comment_id, user_id')
          .in('comment_id', ids);
        for (const l of likes || []) {
          likeCount.set(l.comment_id, (likeCount.get(l.comment_id) || 0) + 1);
          if (me && l.user_id === me) likedByMe.add(l.comment_id);
        }
      }

      const authors = await loadAuthors(all.map((c) => c.user_id));
      const shape = (c) => {
        const duel = extractDuelInfo(c.body || '');
        return {
          id: c.id,
          body: c.deleted ? '[deleted]' : c.body,
          deleted: !!c.deleted,
          parentId: c.parent_id,
          createdAt: c.created_at,
          likeCount: likeCount.get(c.id) || 0,
          likedByMe: likedByMe.has(c.id),
          isMine: !!me && c.user_id === me,
          author: authors.author(c.user_id),
          isDuel: duel.isDuel,
          duelSide: duel.duelSide,
          duelOpponent: duel.duelOpponent,
        };
      };

      // Build threads: top-level newest-first, replies oldest-first under each.
      const repliesBy = new Map();
      for (const c of all) {
        if (c.parent_id) {
          if (!repliesBy.has(c.parent_id)) repliesBy.set(c.parent_id, []);
          repliesBy.get(c.parent_id).push(c);
        }
      }
      const tops = all.filter((c) => !c.parent_id);
      const threads = [];
      for (const top of tops) {
        const replies = (repliesBy.get(top.id) || []).map(shape);
        // Hide a deleted leaf with no replies; keep deleted nodes that have children.
        if (top.deleted && replies.length === 0) continue;
        threads.push({ ...shape(top), replies });
      }
      threads.reverse(); // newest top-level first

      const total = all.filter((c) => !c.deleted).length;
      res.json({ ok: true, total, comments: threads });
    } catch (e) {
      console.error('[comments] list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/comments — create a comment or a reply.
  app.post('/api/comments', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!COMMENTS_ENABLED) {
        return res.json({ ok: false, live: false, message: 'Comments are currently disabled.' });
      }
      const userId = req.body.userId; // forced to verified id by authenticateUser
      const targetType = String(req.body.target_type || '').trim().toLowerCase();
      const targetId = String(req.body.target_id || '').trim();
      const body = String(req.body.body || '').trim();
      let parentId = req.body.parent_id ? String(req.body.parent_id).trim() : null;

      if (!TARGET_TYPES.includes(targetType) || !targetId) {
        return res.status(400).json({ error: 'Invalid target_type or target_id' });
      }
      if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });
      if (body.length > COMMENT_MAX_LEN) {
        return res.status(400).json({ error: `Comment exceeds ${COMMENT_MAX_LEN} characters` });
      }

      // Validate parent (same target, not deleted). Flatten to one nesting level:
      // a reply to a reply re-parents to the top-level root.
      let notifyUserId = null;
      if (parentId) {
        const { data: parent, error: pErr } = await supabase
          .from('comments')
          .select('id, user_id, parent_id, target_type, target_id, deleted')
          .eq('id', parentId)
          .single();
        if (pErr || !parent) return res.status(404).json({ error: 'Parent comment not found' });
        if (parent.deleted) return res.status(400).json({ error: 'Cannot reply to a deleted comment' });
        if (parent.target_type !== targetType || parent.target_id !== targetId) {
          return res.status(400).json({ error: 'Parent comment belongs to a different target' });
        }
        if (parent.parent_id) parentId = parent.parent_id; // re-parent to root
        notifyUserId = parent.user_id;
      }

      const { data: inserted, error } = await supabase
        .from('comments')
        .insert({
          user_id: userId,
          target_type: targetType,
          target_id: targetId,
          body,
          parent_id: parentId,
        })
        .select('id, user_id, target_type, target_id, body, parent_id, deleted, created_at')
        .single();
      if (error) throw error;

      // Fan out so the swarm's maybeReplyToComments wakes up to respond.
      eventBus.safeEmit(EVENTS.COMMENT_CREATED, inserted);

      // Notify the parent author about the reply (skip self-replies).
      if (notifyUserId && notifyUserId !== userId) {
        notify(notifyUserId, 'New reply', `Someone replied: "${shortBody(body)}"`, 'comment_reply')
          .catch((e) => console.warn('[comments] reply notif failed:', e.message));
      }

      const authors = await loadAuthors([userId]);
      award(userId, 'comment', { refType: 'comment', refId: inserted.id }).catch(() => {});
      res.json({
        ok: true,
        comment: {
          id: inserted.id,
          body: inserted.body,
          deleted: false,
          parentId: inserted.parent_id,
          createdAt: inserted.created_at,
          likeCount: 0,
          likedByMe: false,
          isMine: true,
          author: authors.author(userId),
          replies: [],
        },
      });
    } catch (e) {
      console.error('[comments] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/comments/:id — owner-only soft-delete.
  app.delete('/api/comments/:id', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId || req.query.userId; // forced to verified id
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Comment id required' });

      const { data: row, error: gErr } = await supabase
        .from('comments')
        .select('id, user_id, deleted')
        .eq('id', id)
        .single();
      if (gErr || !row) return res.status(404).json({ error: 'Comment not found' });
      if (row.user_id !== userId) return res.status(403).json({ error: 'You can only delete your own comment' });

      if (!row.deleted) {
        const { error } = await supabase
          .from('comments')
          .update({ body: '', deleted: true })
          .eq('id', id);
        if (error) throw error;
      }
      res.json({ ok: true, id, deleted: true });
    } catch (e) {
      console.error('[comments] delete error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/comments/:id/like — toggle a like.
  app.post('/api/comments/:id/like', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId; // forced to verified id
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Comment id required' });

      const { data: comment, error: cErr } = await supabase
        .from('comments')
        .select('id, user_id, body, deleted')
        .eq('id', id)
        .single();
      if (cErr || !comment) return res.status(404).json({ error: 'Comment not found' });
      if (comment.deleted) return res.status(400).json({ error: 'Cannot like a deleted comment' });

      const { data: existing } = await supabase
        .from('comment_likes')
        .select('id')
        .eq('comment_id', id)
        .eq('user_id', userId)
        .maybeSingle();

      let liked;
      if (existing) {
        await supabase.from('comment_likes').delete().eq('id', existing.id);
        liked = false;
      } else {
        const { error: insErr } = await supabase
          .from('comment_likes')
          .insert({ comment_id: id, user_id: userId });
        // Ignore unique-violation races (already liked) — treat as liked.
        if (insErr && insErr.code !== '23505') throw insErr;
        liked = true;
        // Notify the comment author about a new like (skip self-likes).
        if (comment.user_id && comment.user_id !== userId) {
          notify(comment.user_id, 'New like', `Someone liked your comment: "${shortBody(comment.body)}"`, 'comment_like')
            .catch((e) => console.warn('[comments] like notif failed:', e.message));
        }
      }

      const { count } = await supabase
        .from('comment_likes')
        .select('id', { count: 'exact', head: true })
        .eq('comment_id', id);

      res.json({ ok: true, id, liked, likeCount: count || 0 });
    } catch (e) {
      console.error('[comments] like error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Config for the UI (length limit, valid targets, live flag).
  app.get('/api/comments/config', (_req, res) => {
    res.json({ live: COMMENTS_ENABLED, maxLen: COMMENT_MAX_LEN, targetTypes: TARGET_TYPES });
  });

  console.log(`[comments] community routes registered (enabled: ${COMMENTS_ENABLED ? 'ON' : 'OFF'}, maxLen: ${COMMENT_MAX_LEN})`);
}
