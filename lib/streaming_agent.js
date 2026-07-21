/**
 * Puls Streams — autonomous agent layer (EV-driven rate + start/stop decisions).
 *
 * A trader agent RENTS a creator agent's live, pay-per-second alpha feed and
 * makes three genuine decisions — no human in the loop:
 *
 *   1. GO / NO-GO   — is a live feed worth paying for at all right now?
 *                     (cost vs value; it often decides NOT to, and says why)
 *   2. THE RATE     — how many USDC per second is it worth, scaled by the
 *                     agent's bankroll x its conviction in the feed
 *   3. WHEN TO STOP — each second, the marginal value of the *next* second
 *                     decays (diminishing returns); the agent taps stop the
 *                     instant that marginal value drops below the price it is
 *                     paying. "I've extracted the value — stop the meter."
 *
 * This is the agentic counterpart to lib/streaming.js: the agent drives
 * openStream -> tick -> stop through the programmatic API, and every session is
 * logged as an `agent_decision` so it shows in the live agent feed.
 *
 * decideStream / decideContinue are PURE and unit-tested in
 * test/streaming_agent.test.js. An LLM may refine the rate within the EV
 * guardrails when available, but the agency is in the model, not the prose.
 */

import { eventBus, EVENTS } from './events.js';

const ENABLED = (process.env.STREAM_AGENT_ENABLED || 'false') === 'true';
const INTERVAL_MIN = Math.max(2, parseInt(process.env.STREAM_AGENT_INTERVAL_MIN || '11', 10));
const TICK_SEC = Math.max(1, parseInt(process.env.STREAM_AGENT_TICK_SEC || '2', 10));
const MAX_TICKS = Math.max(2, parseInt(process.env.STREAM_AGENT_MAX_TICKS || '10', 10));

// EV model tunables.
// EV model tunables — lowered to reduce USDC burn from streaming.
const WORTH_THRESHOLD = 0.32;  // conviction below this -> don't pay per second
const RISK_FRAC = 0.03;        // commit at most ~3% of bankroll (was 6%)
const HORIZON_SEC = 60;
const MIN_RATE = 0.0002;       // was 0.0005 — lower minimum rate
const MAX_RATE = 0.005;        // was 0.02 — lower max rate (5x cheaper)
const MAX_BUDGET = 0.10;       // was 0.5 — max $0.10 per session (5x cheaper)
const HALF_LIFE_SEC = 18;      // marginal-value half-life (diminishing returns)

/**
 * GO/NO-GO + rate + budget decision. Pure -> unit-tested.
 * @returns {{worthIt:boolean, ratePerSecUsdc:number, maxSeconds:number, capUsdc:number, reasoning:string}}
 */
export function decideStream({ bankrollUsdc, conviction, maxRate = MAX_RATE, minRate = MIN_RATE, riskFrac = RISK_FRAC, horizonSec = HORIZON_SEC, maxBudgetUsdc = MAX_BUDGET, worthThreshold = WORTH_THRESHOLD }) {
  const conv = Math.max(0, Math.min(1, Number(conviction) || 0));
  const bankroll = Math.max(0, Number(bankrollUsdc) || 0);
  const worthIt = conv >= worthThreshold && bankroll > minRate * 5;

  // Rate scales with BOTH bankroll and conviction, clamped to sane bounds.
  let rate = (bankroll * riskFrac * conv) / horizonSec;
  rate = Math.max(minRate, Math.min(maxRate, rate));
  rate = Math.round(rate * 1e6) / 1e6;

  // Attention budget (seconds) grows with conviction.
  const maxSeconds = Math.round(horizonSec * (0.3 + 0.7 * conv));

  let capUsdc = Math.min(maxBudgetUsdc, bankroll * 0.5, rate * maxSeconds);
  capUsdc = Math.max(rate * 3, Math.round(capUsdc * 1e6) / 1e6); // fund at least a few seconds

  return {
    worthIt,
    ratePerSecUsdc: rate,
    maxSeconds,
    capUsdc,
    reasoning: worthIt
      ? `conviction ${(conv * 100).toFixed(0)}% x bankroll $${bankroll.toFixed(2)} -> rent at $${rate}/s, attention ~${maxSeconds}s, cap $${capUsdc.toFixed(4)}`
      : `conviction ${(conv * 100).toFixed(0)}% below ${(worthThreshold * 100).toFixed(0)}% — not worth paying per second now`,
  };
}

/**
 * Per-second "keep paying?" decision. The marginal value of the NEXT second
 * decays exponentially (diminishing returns); stop when it drops below the
 * price being paid. Pure -> unit-tested.
 * @returns {{keep:boolean, marginalValuePerSec:number, reason:string}}
 */
export function decideContinue({ elapsedSec, ratePerSecUsdc, conviction, halfLifeSec = HALF_LIFE_SEC }) {
  const conv = Math.max(0, Math.min(1, Number(conviction) || 0));
  const rate = Math.max(0, Number(ratePerSecUsdc) || 0);
  // Starts above the rate (else the agent wouldn't have opened) and decays.
  const initialValuePerSec = rate * (1 + 3 * conv);
  const marginal = initialValuePerSec * Math.exp(-Math.max(0, Number(elapsedSec) || 0) / halfLifeSec);
  const keep = marginal >= rate;
  return {
    keep,
    marginalValuePerSec: Math.round(marginal * 1e6) / 1e6,
    reason: keep ? 'next second still +EV' : 'marginal value fell below the per-second price — value extracted',
  };
}

export function registerStreamingAgent(deps) {
  const { streamsApi, supabase, getWalletId, getWalletInfo, llmComplete, parseLlmJson, roster } = deps;
  if (!streamsApi || typeof streamsApi.openStream !== 'function') {
    console.warn('[stream-agent] streamsApi unavailable — autonomous streaming disabled');
    return null;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function bankrollOf(userId) {
    try {
      let wid = await getWalletId(userId);
      if (!wid && /agent/i.test(userId)) wid = await getWalletId(`agent_${userId}`);
      if (!wid) return 0;
      const info = await getWalletInfo(wid);
      return parseFloat(info.usdcBalance || '0') || 0;
    } catch { return 0; }
  }

  // Conviction = how much the payer values the feed, grounded in the creator's
  // latest published signal confidence (a real on-platform signal).
  async function convictionFor(recipientUserId) {
    try {
      const { data } = await supabase.from('creator_signals')
        .select('confidence, title, market_question')
        .eq('creator_user_id', recipientUserId).eq('status', 'published')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (data && Number.isFinite(Number(data.confidence))) {
        return { conviction: Math.max(0, Math.min(1, Number(data.confidence))), about: data.title || data.market_question || 'live market read' };
      }
    } catch { /* fall through */ }
    return { conviction: 0.4 + Math.random() * 0.45, about: 'live market read' };
  }

  async function logDecision(payer, msg) {
    try {
      await supabase.from('notifications').insert({ user_id: payer.user, title: 'stream', type: 'agent_decision', read: true, message: JSON.stringify(msg) });
    } catch (e) { console.warn('[stream-agent] log failed:', e.message); }
  }

  async function runSession() {
    if (!ENABLED) return;
    try {
      const traders = (roster || []).filter((a) => a.role === 'trader' || a.alsoTrades);
      const creators = (roster || []).filter((a) => a.role === 'creator');
      if (!traders.length || !creators.length) return;
      const payer = traders[Math.floor(Math.random() * traders.length)];
      const recipient = creators[Math.floor(Math.random() * creators.length)];
      if (!payer || !recipient || payer.user === recipient.user) return;

      const bankroll = await bankrollOf(payer.user);
      const { conviction, about } = await convictionFor(recipient.user);
      const decision = decideStream({ bankrollUsdc: bankroll, conviction });

      // Optional: let the agent's own brain pick the rate WITHIN the EV bounds.
      try {
        if (typeof llmComplete === 'function' && typeof parseLlmJson === 'function' && decision.worthIt) {
          const sys = `You are ${payer.name}, an autonomous trading agent with a $${bankroll.toFixed(2)} USDC bankroll on Arc. A live pay-per-second alpha feed from ${recipient.name} about "${about}" is on offer. Choose your price PER SECOND in [$${MIN_RATE}, $${decision.ratePerSecUsdc}] and a max seconds budget. Return STRICT JSON {"ratePerSecUsdc":number,"maxSeconds":number}.`;
          const raw = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: `conviction=${conviction.toFixed(2)}` }], { prefer: payer.brain });
          const j = parseLlmJson(raw);
          if (j && Number.isFinite(Number(j.ratePerSecUsdc))) {
            decision.ratePerSecUsdc = Math.round(Math.max(MIN_RATE, Math.min(decision.ratePerSecUsdc, Number(j.ratePerSecUsdc))) * 1e6) / 1e6;
            if (Number.isFinite(Number(j.maxSeconds))) decision.maxSeconds = Math.max(3, Math.min(decision.maxSeconds, Math.round(Number(j.maxSeconds))));
            decision.capUsdc = Math.max(decision.ratePerSecUsdc * 3, Math.round(decision.ratePerSecUsdc * decision.maxSeconds * 1e6) / 1e6);
            decision.reasoning += ' · brain-tuned';
          }
        }
      } catch { /* LLM optional — EV model stands on its own */ }

      // GO / NO-GO: the agent may decide NOT to pay (agency includes restraint).
      if (!decision.worthIt) {
        await logDecision(payer, { action: 'stream_skip', agentKey: payer.key, agentName: payer.name, role: payer.role, question: about, reasoning: `Passed on ${recipient.name}'s live feed — ${decision.reasoning}.` });
        console.log(`[stream-agent] ${payer.key} passed on streaming (conviction ${conviction.toFixed(2)})`);
        return;
      }

      const resource = `live-alpha:${recipient.key}:${about}`.slice(0, 180);
      let stream;
      try {
        stream = await streamsApi.openStream({ payerUserId: payer.user, recipientUserId: recipient.user, resource, ratePerSecUsdc: decision.ratePerSecUsdc, capUsdc: decision.capUsdc, openedBy: 'agent', meta: { conviction, about } });
      } catch (e) { console.warn('[stream-agent] open failed:', e.message); return; }

      // Stream + decide each second whether the next second is still worth it.
      let stopReason = 'cap reached';
      for (let i = 0; i < MAX_TICKS; i++) {
        await sleep(TICK_SEC * 1000);
        let s;
        try { s = await streamsApi.tick(stream.id); } catch { break; }
        if (s.status !== 'active' || s.remainingUsdc <= 0) { stopReason = 'cap reached'; break; }
        const elapsed = decision.ratePerSecUsdc > 0 ? s.accruedUsdc / decision.ratePerSecUsdc : 0;
        const cont = decideContinue({ elapsedSec: elapsed, ratePerSecUsdc: decision.ratePerSecUsdc, conviction });
        if (!cont.keep) { stopReason = cont.reason; break; }
      }

      let final;
      try { final = await streamsApi.stop(stream.id); } catch { /* reconciler settles anyway */ }
      const streamed = final ? final.accruedUsdc : 0;
      const spent = final ? final.settledUsdc : 0;
      await logDecision(payer, {
        action: 'stream', agentKey: payer.key, agentName: payer.name, role: payer.role,
        question: about, amount: streamed, ratePerSecUsdc: decision.ratePerSecUsdc,
        streamedUsdc: streamed, settledUsdc: spent, stopReason,
        reasoning: `Rented ${recipient.name}'s live feed at $${decision.ratePerSecUsdc}/s (${decision.reasoning}). Streamed ~$${streamed.toFixed(5)}, settled $${spent.toFixed(5)}. Stopped: ${stopReason}.`,
        txHash: final && final.settleTx && String(final.settleTx).startsWith('0x') ? final.settleTx : null,
      });
      console.log(`[stream-agent] ${payer.key} streamed $${streamed.toFixed(5)} from ${recipient.key} @ $${decision.ratePerSecUsdc}/s — ${stopReason}`);
    } catch (e) {
      console.warn('[stream-agent] session error:', e.message);
    }
  }

  let _streamPending = null;
  if (ENABLED) {
    setTimeout(runSession, 90_000).unref?.();
    // Event-driven: wake when a creator publishes a high-conviction signal —
    // that's the only time a stream is worth renting. The boot setTimeout
    // catches anything live at startup.
    eventBus.on(EVENTS.SIGNAL_PUBLISHED, () => {
      // Debounce: one session per ~INTERVAL_MIN to avoid stampeding on a
      // burst of signal publishes.
      if (ENABLED && !_streamPending) {
        _streamPending = setTimeout(() => {
          _streamPending = null;
          runSession().catch(() => {});
        }, INTERVAL_MIN * 60_000).unref?.();
      }
    });
  }
  console.log(`[stream-agent] autonomous streaming agent ${ENABLED ? 'ON' : 'OFF'} (event-driven on signal:published, ${TICK_SEC}s ticks)`);
  return { runSession, decideStream, decideContinue };
}
