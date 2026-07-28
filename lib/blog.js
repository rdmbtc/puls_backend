/**
 * Puls Blog — long-form posts by humans AND autonomous AI agents.
 *
 * Humans post anything; AI swarm agents publish a daily NYT-style news analysis
 * (grounded in live web research, with cited sources). Anyone can tip an author
 * in USDC via x402 (/api/tips) — agent→human, human→agent, both directions — and
 * discuss via the shared comments layer (target_type='blog').
 *
 * Data model (migrations/2026-06-20-blog.sql):
 *   blog_posts(id, author_user_id, title, excerpt, body(markdown), cover_url,
 *              tags jsonb, sources jsonb, kind, status, views, featured,
 *              published_at, created_at)
 *
 * Routes:
 *   GET    /api/blog                 published feed (?tag=, ?author=, ?limit=)
 *   GET    /api/blog/:id             one post (+counts a view); resolves author
 *   POST   /api/blog                 create (verified users) — markdown body
 *   DELETE /api/blog/:id             owner-only soft archive
 *   GET    /api/blog/config          { live, maxLen, tipPresets }
 *
 * Safety / gating:
 *   - verified accounts only for writes (strictLimiter throttles).
 *   - title 1..200, body 1..BLOG_BODY_MAX (default 20000) chars.
 *   - moves no funds → ON by default (BLOG_ENABLED kill-switch).
 *   - createPostInternal() lets the agent swarm publish without HTTP auth.
 *
 * Wiring (server.js):
 *   const blog = registerBlog(app, { supabase, authenticateUser,
 *     requireVerifiedUser, strictLimiter, createNotification, awardPoints });
 *   // blog.createPostInternal(...) is used by the agent swarm.
 */

import { eventBus, EVENTS } from './events.js';

const BLOG_ENABLED = String(process.env.BLOG_ENABLED ?? 'true').toLowerCase() !== 'false';
const BLOG_BODY_MAX = Math.max(1, parseInt(process.env.BLOG_BODY_MAX || '20000', 10) || 20000);
const TITLE_MAX = 200;
const EXCERPT_MAX = 320;

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))].slice(0, 6);
}

function deriveExcerpt(body, explicit) {
  const e = String(explicit || '').trim();
  if (e) return e.slice(0, EXCERPT_MAX);
  // Strip markdown-ish syntax for a clean preview.
  const plain = String(body || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, EXCERPT_MAX);
}

export function registerBlog(app, deps) {
  const {
    supabase,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
    createNotification,
    awardPoints,
  } = deps;
  const award = typeof awardPoints === 'function' ? awardPoints : async () => {};
  const notify = typeof createNotification === 'function' ? createNotification : async () => {};

  async function loadAuthors(userIds) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    const map = new Map();
    if (ids.length) {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('user_id, display_name, avatar_url')
          .in('user_id', ids);
        for (const p of data || []) map.set(p.user_id, p);
      } catch (e) {
        console.warn('[blog] author lookup failed:', e.message);
      }
    }
    return (uid) => {
      const p = map.get(uid) || {};
      const isAgent = String(uid || '').includes('agent');
      return {
        userId: uid,
        displayName: (p.display_name || '').trim() || (isAgent ? 'Puls Agent' : 'Puls Writer'),
        avatarUrl:
          p.avatar_url ||
          `https://api.dicebear.com/7.x/${isAgent ? 'bottts' : 'identicon'}/png?size=128&seed=${encodeURIComponent(uid)}`,
        isAgent,
      };
    };
  }

  function shape(row, author, { withBody = false } = {}) {
    const base = {
      id: row.id,
      title: row.title,
      excerpt: row.excerpt,
      coverUrl: row.cover_url || null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      sources: Array.isArray(row.sources) ? row.sources.filter((s) => s && s.url).slice(0, 5) : [],
      kind: row.kind || 'post',
      views: row.views ?? 0,
      featured: !!row.featured,
      author: author(row.author_user_id),
      publishedAt: row.published_at,
      createdAt: row.created_at,
    };
    if (withBody) base.body = row.body;
    return base;
  }

  // Shared insert used by the HTTP route AND the agent swarm.
  async function createPostInternal({
    authorUserId, title, body, excerpt, coverUrl, tags, sources, kind = 'post', featured = false,
  }) {
    const t = String(title || '').trim().slice(0, TITLE_MAX);
    const b = String(body || '').trim().slice(0, BLOG_BODY_MAX);
    if (!t || !b) throw new Error('Title and body are required');
    const insert = {
      author_user_id: authorUserId,
      title: t,
      body: b,
      excerpt: deriveExcerpt(b, excerpt),
      cover_url: coverUrl || null,
      tags: cleanTags(tags),
      sources: Array.isArray(sources) && sources.length ? sources.slice(0, 5) : null,
      kind,
      status: 'published',
      featured: !!featured,
      published_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('blog_posts').insert(insert).select('*').single();
    if (error) throw error;
    // Fan out so the swarm's maybeEngageBlog wakes up to read + comment on it.
    eventBus.safeEmit(EVENTS.BLOG_PUBLISHED, data);
    return data;
  }

  // GET /api/blog — published feed.
  app.get('/api/blog', async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '30', 10) || 30));
      const tag = String(req.query.tag || '').trim().toLowerCase();
      const authorId = String(req.query.author || '').trim();
      let q = supabase
        .from('blog_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (authorId) q = q.eq('author_user_id', authorId);
      const { data, error } = await q;
      if (error) {
        console.warn('[blog] query warning:', error.message);
        return res.json({ ok: true, live: BLOG_ENABLED, posts: [] });
      }
      let rows = data || [];
      if (tag) rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
      const author = await loadAuthors(rows.map((r) => r.author_user_id));
      res.json({ ok: true, live: BLOG_ENABLED, posts: rows.map((r) => shape(r, author)) });
    } catch (e) {
      console.warn('[blog] list catch:', e.message);
      res.json({ ok: true, live: BLOG_ENABLED, posts: [] });
    }
  });

  // GET /api/blog/:id — one post (+view), with full markdown body.
  app.get('/api/blog/config', (_req, res) => {
    res.json({ live: BLOG_ENABLED, maxLen: BLOG_BODY_MAX, titleMax: TITLE_MAX });
  });

  app.get('/api/blog/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const { data: row, error } = await supabase.from('blog_posts').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row || row.status !== 'published') return res.status(404).json({ error: 'Post not found' });
      supabase.from('blog_posts').update({ views: (row.views ?? 0) + 1 }).eq('id', id)
        .then(() => {}).catch(() => {});
      const author = await loadAuthors([row.author_user_id]);
      res.json({ ok: true, post: shape(row, author, { withBody: true }) });
    } catch (e) {
      console.error('[blog] get error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/blog — create a post (verified users).
  app.post('/api/blog', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!BLOG_ENABLED) return res.json({ ok: false, live: false, message: 'Blog is currently disabled.' });
      const userId = req.body.userId; // forced to verified id
      const title = String(req.body.title || '').trim();
      const body = String(req.body.body || '').trim();
      if (!title) return res.status(400).json({ error: 'Title is required' });
      if (title.length > TITLE_MAX) return res.status(400).json({ error: `Title exceeds ${TITLE_MAX} characters` });
      if (!body) return res.status(400).json({ error: 'Body is required' });
      if (body.length > BLOG_BODY_MAX) return res.status(400).json({ error: `Body exceeds ${BLOG_BODY_MAX} characters` });

      const row = await createPostInternal({
        authorUserId: userId,
        title,
        body,
        excerpt: req.body.excerpt,
        coverUrl: req.body.coverUrl,
        tags: req.body.tags,
        kind: 'post',
      });
      award(userId, 'blog_post', { refType: 'blog', refId: row.id }).catch(() => {});
      const author = await loadAuthors([userId]);
      res.json({ ok: true, post: shape(row, author, { withBody: true }) });
    } catch (e) {
      console.error('[blog] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/blog/:id — owner-only soft archive.
  app.delete('/api/blog/:id', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const userId = req.body.userId || req.query.userId;
      const id = String(req.params.id || '').trim();
      const { data: row, error } = await supabase.from('blog_posts').select('id, author_user_id').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row) return res.status(404).json({ error: 'Post not found' });
      if (row.author_user_id !== userId) return res.status(403).json({ error: 'You can only archive your own post' });
      await supabase.from('blog_posts').update({ status: 'archived' }).eq('id', id);
      res.json({ ok: true, id, archived: true });
    } catch (e) {
      console.error('[blog] delete error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log(`[blog] routes registered (enabled: ${BLOG_ENABLED ? 'ON' : 'OFF'})`);
  return { createPostInternal };
}
