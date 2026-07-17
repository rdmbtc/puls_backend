/**
 * Puls Support — in-app ticket support (F5, replaces the region-blocked Tawk.to
 * live-chat). Our own help desk on Supabase: no regional script blocks, and the
 * judges value "real client care" running on our own stack. Structurally this
 * mirrors the comments layer (F1): two small tables, threaded reads, verified-
 * only writes, in-app notifications — reusing the same infra.
 *
 * Data model (see supabase-schema.sql):
 *   support_tickets(id, user_id, subject, status['open'|'answered'|'closed'],
 *                   created_at, updated_at)
 *   support_messages(id, ticket_id, sender['user'|'admin'], body, created_at)
 *
 * Routes:
 *   POST /api/support/tickets               { subject, body }  → opens a ticket
 *   GET  /api/support/tickets                my tickets (admins: ?all=true for the queue)
 *   GET  /api/support/tickets/:id           ticket + full message thread (owner/admin)
 *   POST /api/support/tickets/:id/messages  { body } → reply (user reopens / admin answers)
 *   POST /api/support/tickets/:id/status    { status } → owner closes / admin sets status
 *   GET  /api/support/config                { live, subjectMax, maxLen, statuses }
 *
 * Roles / safety:
 *   - Only verified accounts open tickets or post messages (web3 guests are
 *     read-only, same rule as the rest of the API).
 *   - The ticket owner posts `sender='user'` (a reply reopens the ticket → 'open').
 *   - An admin (userId in ADMIN_USER_IDS) posts `sender='admin'` → status 'answered'
 *     and the owner gets an in-app notification.
 *   - subject 1..SUPPORT_SUBJECT_MAX (200), body 1..SUPPORT_MAX_LEN (4000);
 *     empty/oversized rejected. strictLimiter throttles writes.
 *   - optional SUPPORT_ENABLED kill-switch (default ON — support moves no funds).
 *
 * Wiring (server.js):
 *   import { registerSupport } from './lib/support.js';
 *   registerSupport(app, { supabase, authenticateUser, requireVerifiedUser,
 *     strictLimiter, createNotification });
 */

const SUPPORT_ENABLED =
  String(process.env.SUPPORT_ENABLED ?? 'true').toLowerCase() !== 'false';
const SUPPORT_MAX_LEN = Math.max(
  1,
  parseInt(process.env.SUPPORT_MAX_LEN || '4000', 10) || 4000
);
const SUPPORT_SUBJECT_MAX = Math.max(
  1,
  parseInt(process.env.SUPPORT_SUBJECT_MAX || '200', 10) || 200
);
const STATUSES = ['open', 'answered', 'closed'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function shortBody(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

export function registerSupport(app, deps) {
  const {
    supabase,
    authenticateUser,
    requireVerifiedUser,
    strictLimiter,
    createNotification,
  } = deps;

  const notify = typeof createNotification === 'function'
    ? createNotification
    : async () => {};
  const isAdmin = (uid) => !!uid && ADMIN_USER_IDS.includes(uid);

  // Identity is derived from the Bearer token via `authenticateUser`, which
  // sets `req.user` (raw Supabase uuid). We rehydrate the `supabase_<uuid>`
  // form stored in `user_id`/`sender` columns — never trust a client-supplied
  // userId from query/body (IDOR risk; the Flutter client intentionally sends
  // only the Authorization header and no ?userId=).
  const verifiedUserId = (req) => {
    const id = req.user?.id;
    return id ? `supabase_${id}` : null;
  };

  // POST /api/support/tickets — open a ticket with its first message.
  app.post('/api/support/tickets', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!SUPPORT_ENABLED) {
        return res.json({ ok: false, live: false, message: 'Support is currently disabled.' });
      }
      const userId = verifiedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Sign in to open a ticket' });
      const subject = String(req.body.subject || '').trim();
      const body = String(req.body.body || '').trim();

      if (!subject) return res.status(400).json({ error: 'Subject is required' });
      if (subject.length > SUPPORT_SUBJECT_MAX) {
        return res.status(400).json({ error: `Subject exceeds ${SUPPORT_SUBJECT_MAX} characters` });
      }
      if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
      if (body.length > SUPPORT_MAX_LEN) {
        return res.status(400).json({ error: `Message exceeds ${SUPPORT_MAX_LEN} characters` });
      }

      const { data: ticket, error: tErr } = await supabase
        .from('support_tickets')
        .insert({ user_id: userId, subject, status: 'open' })
        .select('id, user_id, subject, status, created_at, updated_at')
        .single();
      if (tErr) throw tErr;

      const { data: message, error: mErr } = await supabase
        .from('support_messages')
        .insert({ ticket_id: ticket.id, sender: 'user', body })
        .select('id, ticket_id, sender, body, created_at')
        .single();
      if (mErr) throw mErr;

      // Let any admin know a new ticket is waiting (best-effort, skips if none).
      for (const adminId of ADMIN_USER_IDS) {
        if (adminId === userId) continue;
        notify(adminId, 'New support ticket', `${subject}: "${shortBody(body)}"`, 'support_new')
          .catch((e) => console.warn('[support] new-ticket notif failed:', e.message));
      }

      res.json({ ok: true, ticket: { ...ticket, messages: [message] } });
    } catch (e) {
      console.error('[support] create error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/support/tickets — my tickets (admins: ?all=true for the queue).
  app.get('/api/support/tickets', authenticateUser, async (req, res) => {
    try {
      const me = verifiedUserId(req);
      if (!me) return res.status(401).json({ error: 'Sign in to view your tickets' });
      const wantAll = String(req.query.all || '').toLowerCase() === 'true' && isAdmin(me);

      let q = supabase
        .from('support_tickets')
        .select('id, user_id, subject, status, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (!wantAll) q = q.eq('user_id', me);
      const { data: tickets, error } = await q;
      if (error) throw error;

      const list = tickets || [];
      const ids = list.map((t) => t.id);

      // Attach a last-message preview + message count in two small queries.
      const lastBy = new Map();
      const countBy = new Map();
      if (ids.length) {
        const { data: msgs } = await supabase
          .from('support_messages')
          .select('ticket_id, sender, body, created_at')
          .in('ticket_id', ids)
          .order('created_at', { ascending: true });
        for (const m of msgs || []) {
          countBy.set(m.ticket_id, (countBy.get(m.ticket_id) || 0) + 1);
          lastBy.set(m.ticket_id, m); // ascending → ends on the latest
        }
      }

      const shaped = list.map((t) => {
        const last = lastBy.get(t.id);
        return {
          id: t.id,
          subject: t.subject,
          status: t.status,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          isMine: t.user_id === me,
          messageCount: countBy.get(t.id) || 0,
          lastMessage: last
            ? { sender: last.sender, preview: shortBody(last.body), createdAt: last.created_at }
            : null,
        };
      });
      res.json({ ok: true, total: shaped.length, tickets: shaped });
    } catch (e) {
      console.error('[support] list error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/support/tickets/:id — full thread, owner or admin only.
  app.get('/api/support/tickets/:id', authenticateUser, async (req, res) => {
    try {
      const me = verifiedUserId(req);
      if (!me) return res.status(401).json({ error: 'Sign in to view your tickets' });
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Ticket id required' });

      const { data: ticket, error: tErr } = await supabase
        .from('support_tickets')
        .select('id, user_id, subject, status, created_at, updated_at')
        .eq('id', id)
        .single();
      if (tErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.user_id !== me && !isAdmin(me)) {
        return res.status(403).json({ error: 'You can only view your own tickets' });
      }

      const { data: messages, error: mErr } = await supabase
        .from('support_messages')
        .select('id, ticket_id, sender, body, created_at')
        .eq('ticket_id', id)
        .order('created_at', { ascending: true });
      if (mErr) throw mErr;

      res.json({
        ok: true,
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          status: ticket.status,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at,
          isMine: ticket.user_id === me,
          messages: (messages || []).map((m) => ({
            id: m.id,
            sender: m.sender,
            body: m.body,
            createdAt: m.created_at,
          })),
        },
      });
    } catch (e) {
      console.error('[support] get error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/support/tickets/:id/messages — reply (user reopens / admin answers).
  app.post('/api/support/tickets/:id/messages', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      if (!SUPPORT_ENABLED) {
        return res.json({ ok: false, live: false, message: 'Support is currently disabled.' });
      }
      const me = verifiedUserId(req);
      if (!me) return res.status(401).json({ error: 'Sign in to reply' });
      const id = String(req.params.id || '').trim();
      const body = String(req.body.body || '').trim();
      if (!id) return res.status(400).json({ error: 'Ticket id required' });
      if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
      if (body.length > SUPPORT_MAX_LEN) {
        return res.status(400).json({ error: `Message exceeds ${SUPPORT_MAX_LEN} characters` });
      }

      const { data: ticket, error: tErr } = await supabase
        .from('support_tickets')
        .select('id, user_id, subject, status')
        .eq('id', id)
        .single();
      if (tErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });

      const owner = ticket.user_id === me;
      const admin = isAdmin(me);
      if (!owner && !admin) {
        return res.status(403).json({ error: 'You can only reply to your own tickets' });
      }
      if (ticket.status === 'closed') {
        return res.status(400).json({ error: 'This ticket is closed. Open a new one if you still need help.' });
      }
      // Admin replying on behalf of the desk; owner replying as the user.
      const sender = admin && !owner ? 'admin' : 'user';
      const nextStatus = sender === 'admin' ? 'answered' : 'open';

      const { data: message, error: mErr } = await supabase
        .from('support_messages')
        .insert({ ticket_id: id, sender, body })
        .select('id, ticket_id, sender, body, created_at')
        .single();
      if (mErr) throw mErr;

      await supabase
        .from('support_tickets')
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', id);

      // Notify the user when the desk answers (skip if admin == owner).
      if (sender === 'admin' && ticket.user_id && ticket.user_id !== me) {
        notify(ticket.user_id, 'Support replied', `Re: ${ticket.subject} — "${shortBody(body)}"`, 'support_reply')
          .catch((e) => console.warn('[support] reply notif failed:', e.message));
      }

      res.json({
        ok: true,
        status: nextStatus,
        message: {
          id: message.id,
          sender: message.sender,
          body: message.body,
          createdAt: message.created_at,
        },
      });
    } catch (e) {
      console.error('[support] message error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/support/tickets/:id/status — owner closes / admin sets status.
  app.post('/api/support/tickets/:id/status', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
    try {
      const me = verifiedUserId(req);
      if (!me) return res.status(401).json({ error: 'Sign in to update status' });
      const id = String(req.params.id || '').trim();
      const status = String(req.body.status || '').trim().toLowerCase();
      if (!id) return res.status(400).json({ error: 'Ticket id required' });
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      }

      const { data: ticket, error: tErr } = await supabase
        .from('support_tickets')
        .select('id, user_id, status')
        .eq('id', id)
        .single();
      if (tErr || !ticket) return res.status(404).json({ error: 'Ticket not found' });

      const owner = ticket.user_id === me;
      const admin = isAdmin(me);
      if (!owner && !admin) {
        return res.status(403).json({ error: 'You can only update your own tickets' });
      }
      // The owner may only close their own ticket; admins may set any status.
      if (!admin && status !== 'closed') {
        return res.status(403).json({ error: 'You can only close your ticket' });
      }

      const { error } = await supabase
        .from('support_tickets')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;

      res.json({ ok: true, id, status });
    } catch (e) {
      console.error('[support] status error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Config for the UI (limits, valid statuses, live flag).
  app.get('/api/support/config', (_req, res) => {
    res.json({
      live: SUPPORT_ENABLED,
      subjectMax: SUPPORT_SUBJECT_MAX,
      maxLen: SUPPORT_MAX_LEN,
      statuses: STATUSES,
    });
  });

  console.log(`[support] ticket routes registered (enabled: ${SUPPORT_ENABLED ? 'ON' : 'OFF'}, admins: ${ADMIN_USER_IDS.length})`);
}
