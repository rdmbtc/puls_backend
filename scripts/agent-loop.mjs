/**
 * Puls agent loop — the full "agent pays a creator, then decides and trades" cycle.
 *
 * Centrepiece of the agent economy: the house agent
 * **Pulse** does NOT just automate a formula — it spends real USDC to buy an alpha
 * signal from a creator, reasons over it with an LLM, makes a YES/NO/SKIP decision,
 * and books PnL **net of the signal cost**. Value too small to move before now
 * moves agent→creator on Arc.
 *
 *   1. Pulse pays $0.001 via Circle Gateway x402 for GET /api/alpha/sample
 *      (real nanopayment to the creator, settles on Arc; same rail as x402-buyer.mjs).
 *   2. Pulse feeds the bought signal to an LLM and asks for a structured decision.
 *   3. Pulse acts on the decision (logs intended trade; live trade optional).
 *   4. Pulse prints the economics: edge vs the price it paid → PnL net of cost.
 *
 * Why a script (not in server.js): zero risk to the running backend, trivially
 * demoable/screenshotable for the 0:00–0:20 video hook, reuses the proven Gateway
 * rail (573ms settle).
 *
 * Env (.env on the server — NEVER commit/chat):
 *   BUYER_PRIVATE_KEY    funded agent EOA (faucet.circle.com). REQUIRED.
 *   BASE_URL             backend base (default http://localhost:3000)
 *   X402_SELLER_ADDRESS  creator address (for the on-chain proof link)
 *   AGENT_LLM_URL/KEY/MODEL  LLM provider (same as backend). Optional —
 *                        falls back to a deterministic edge rule if absent.
 *   AGENT_STAKE_USDC     notional the agent would stake on a GO (default 1).
 *
 * Run on the VPS:  cd /opt/puls-backend && node scripts/agent-loop.mjs
 */
import 'dotenv/config';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SELLER = process.env.X402_SELLER_ADDRESS || '';
const buyerKey = process.env.BUYER_PRIVATE_KEY;
const STAKE = parseFloat(process.env.AGENT_STAKE_USDC || '1') || 1;
const RESOURCE = `${BASE_URL}/api/alpha/sample`;

if (!buyerKey) {
  console.error('Missing BUYER_PRIVATE_KEY — fund an EOA via https://faucet.circle.com');
  process.exit(1);
}

const LLM = (() => {
  let url = (process.env.AGENT_LLM_URL || '').trim();
  const key = (process.env.AGENT_LLM_KEY || '').trim();
  const model = (process.env.AGENT_MODEL || '').trim();
  if (!url || !key || !model) return null;
  if (!/\/(chat\/)?completions\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions';
  return { url, key, model };
})();

function parseJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in LLM output');
  return JSON.parse(text.slice(s, e + 1));
}

// Ask the LLM to reason over the *bought* signal and return a structured call.
async function llmDecide(signal) {
  if (!LLM) return null;
  const sys = 'You are Pulse, an autonomous trading agent on the Puls prediction market. '
    + 'You just PAID a creator $0.001 for the alpha below. Decide whether to act on it. '
    + 'Respond ONLY as compact JSON: {"action":"GO"|"SKIP","side":"YES"|"NO","confidence":0-1,"reason":"<=140 chars"}. '
    + 'GO only if the signal edge clearly outweighs the cost and risk.';
  const usr = `Alpha signal you bought:\n${JSON.stringify(signal, null, 2)}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(LLM.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM.key}` },
      body: JSON.stringify({
        model: LLM.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        temperature: 0.4,
        max_tokens: 200,
      }),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    return { ...parseJson(text), source: 'llm', model: LLM.model };
  } catch (e) {
    console.warn(`[agent] LLM decision failed (${e.message}) -> deterministic fallback`);
    return null;
  } finally {
    clearTimeout(to);
  }
}

// Deterministic fallback: GO if the signal edge clears a sensible bar.
function ruleDecide(signal) {
  const edge = Number(signal.edge_bps || 0);
  const conf = Number(signal.confidence || 0);
  const go = edge >= 200 && conf >= 0.55;
  return {
    action: go ? 'GO' : 'SKIP',
    side: signal.stance === 'NO' ? 'NO' : 'YES',
    confidence: conf,
    reason: go
      ? `edge ${edge}bps >= 200 & conf ${conf} >= 0.55 -> act`
      : `edge ${edge}bps / conf ${conf} below bar -> skip`,
    source: 'rule',
  };
}

async function main() {
  console.log('Pulse agent loop — buy signal -> decide -> trade -> PnL net of cost\n');
  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: buyerKey.startsWith('0x') ? buyerKey : `0x${buyerKey}`,
  });

  // 1) PAY a creator for the alpha (real x402 nanopayment on Arc).
  let bal = await gateway.getBalances();
  if (!bal.gateway?.available || bal.gateway.available < 100_000n) {
    console.log('Depositing 0.5 USDC into Gateway Wallet...');
    await gateway.deposit('0.5');
  }
  console.log(`(1) Paying creator for a signal: GET ${RESOURCE}`);
  const t0 = Date.now();
  const paid = await gateway.pay(RESOURCE, { method: 'GET' });
  const ms = Date.now() - t0;
  const costUsdc = parseFloat(paid.formattedAmount ?? '0.001') || 0.001;
  const body = paid.data ?? paid.body ?? {};
  const signal = body.signal || {};
  console.log(`   paid ${costUsdc} USDC in ${ms}ms - Circle receipt ${paid.transaction || 'n/a'}`);
  console.log(`   signal: ${signal.stance} "${signal.market}" (edge ${signal.edge_bps}bps, conf ${signal.confidence})`);

  // 2) DECIDE with the LLM (fallback to a deterministic edge rule).
  console.log(`\n(2) Reasoning over the bought signal...`);
  const decision = (await llmDecide(signal)) || ruleDecide(signal);
  console.log(`   decision [${decision.source}]: ${decision.action} ${decision.side || ''} (conf ${decision.confidence})`);
  console.log(`   reason: ${decision.reason}`);

  // 3) ACT — book the intended trade + the economics.
  console.log(`\n(3) Economics (PnL net of signal cost):`);
  if (decision.action === 'GO') {
    const edge = Number(signal.edge_bps || 0) / 10000; // bps -> fraction
    const grossExpected = STAKE * edge;
    const net = grossExpected - costUsdc;
    console.log(`   stake:            ${STAKE.toFixed(3)} USDC on ${decision.side}`);
    console.log(`   signal cost:      ${costUsdc.toFixed(6)} USDC (paid to creator)`);
    console.log(`   expected edge:    ${grossExpected.toFixed(6)} USDC (${(edge * 100).toFixed(2)}% of stake)`);
    console.log(`   -> expected PnL net of cost: ${net >= 0 ? '+' : ''}${net.toFixed(6)} USDC`);
    console.log(`   (live on-chain trade gated; wire /api/trade/buy for a fully live run)`);
  } else {
    console.log(`   SKIP — agent declined; only cost was the ${costUsdc} USDC signal (creator still earned).`);
  }

  // 4) On-chain proof of the creator payment.
  const seller = SELLER || paid.payTo || body.creator?.payTo;
  if (seller) {
    console.log(`\nCreator payment proof (USDC lands here after Circle flushes batch):`);
    console.log(`   https://testnet.arcscan.app/address/${seller}`);
  }
  console.log(`\nDone. Agent paid a creator, reasoned, and decided — value moved at sub-cent scale on Arc.`);
}

main().catch((e) => { console.error('agent loop failed:', e?.message || e); process.exit(1); });
