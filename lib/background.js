/**
 * Opt-in web/worker process split for Heroku.
 *
 * By default EVERYTHING keeps running in the web dyno (current behavior).
 * To move background loops (agent swarm, market resolution, limit orders,
 * leaderboard, treasury checks) off the web dyno:
 *
 *   1. Add to Procfile:      worker: node --max-old-space-size=384 server.js
 *   2. Scale it:             heroku ps:scale worker=1:basic
 *   3. Set WORKER_SPLIT=true on the app.
 *
 * With WORKER_SPLIT=true:
 *   • web.* dynos serve HTTP only (no background loops)
 *   • worker.* dynos run the background loops only
 * Local dev (no DYNO) and any other dyno names always run everything, so
 * one-off jobs and review apps behave exactly as before.
 */
export function backgroundEnabled() {
  const split = String(process.env.WORKER_SPLIT || '').trim().toLowerCase() === 'true';
  if (!split) return true;
  const dyno = String(process.env.DYNO || '');
  if (!dyno) return true; // local dev / CI
  if (dyno.startsWith('worker')) return true;
  return !dyno.startsWith('web');
}

export default { backgroundEnabled };
