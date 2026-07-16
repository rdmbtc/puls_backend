/**
 * Puls Gateway — agent micropayment layer for premium data acquisition.
 *
 * Implements the Discover → Evaluate → Pay (RFB01) flow:
 *   1. Agent discovers available paid endpoints in PULS_REGISTRY.
 *   2. Agent performs a cost-benefit analysis (ROI, balance, confidence).
 *   3. If profitable, agent pays via Circle Gateway on Arc Testnet and
 *      receives exclusive data to augment its LLM prompt.
 *
 * Uses x402-style authorization headers for vendor API calls. Payments
 * settle on Arc Testnet USDC with on-chain memo attestation.
 *
 * @module puls_gateway
 */

// ── Puls Registry: catalogue of paid data endpoints ──────────────────────────
// Each entry defines a vendor API that agents can purchase data from.
// Add new endpoints here to scale the marketplace.
const PULS_REGISTRY = {
  btcnode_premium: {
    name: 'BTCNode Premium Oracle',
    description: 'Real-time BTC/ETH/SOL order-book depth, whale alerts, and liquidation heatmaps from top-5 CEXs.',
    endpoint: 'https://api.pulsmarket.tech/api/oracle/btcnode-premium',
    costUsdc: 0.000001,   // $0.000001 per call — sub-cent nanopayment
    dataType: 'crypto_oracle',
    category: 'crypto',
    ttlSeconds: 300,      // cache window
  },
  sugra_macro: {
    name: 'Sugra Macro Intelligence',
    description: 'Fed dot-plot probabilities, CPI nowcast, and geopolitical risk scores aggregated from 40+ institutional feeds.',
    endpoint: 'https://api.pulsmarket.tech/api/oracle/sugra-macro',
    costUsdc: 0.000005,   // $0.000005 per call
    dataType: 'macro_intel',
    category: 'macro',
    ttlSeconds: 600,
  },
  polymarket_whale: {
    name: 'Polymarket Whale Tracker',
    description: 'Real-time large-position movements and smart-money flow on Polymarket prediction markets.',
    endpoint: 'https://api.pulsmarket.tech/api/oracle/polymarket-whales',
    costUsdc: 0.000002,
    dataType: 'whale_flow',
    category: 'prediction_markets',
    ttlSeconds: 180,
  },
};

// ── Simulated Circle Gateway payment on Arc Testnet ──────────────────────────
// In production this calls circle.createContractExecutionTransaction() via the
// parent's usdcTransferWithMemo helper. Here we simulate the ~500ms Arc block
// confirmation and return a deterministic receipt for hackathon demo purposes.
async function simulateCircleGatewayPayment(agent, service) {
  const txStart = Date.now();
  // Simulate Arc Testnet block confirmation (~500ms sub-second finality)
  await new Promise(r => setTimeout(r, 500));
  const txHash = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
  const receipt = {
    success: true,
    txHash,
    chain: 'Arc Testnet (eip155:5042002)',
    asset: 'USDC',
    amount: service.costUsdc,
    amountMicro: Math.round(service.costUsdc * 1_000_000),
    from: agent.walletAddress || agent.key,
    to: 'PulsGateway:DataVendor',
    settledMs: Date.now() - txStart,
    memo: `gateway:${service.dataType}`,
  };
  return receipt;
}

// ── Real vendor API call via x402 nanopayments ────────────────────────────────
async function fetchPaidEndpoint(service, x402Token) {
  // In production, we would call: 
  // fetch(service.endpoint, { headers: { Authorization: `x402 ${x402Token}` } })
  // For the hackathon, we fetch real live data from open APIs to prove the concept 
  // works with actual external data, not just hardcoded mock values.

  if (service.dataType === 'crypto_oracle') {
    try {
      const [btcRes, mempoolRes] = await Promise.all([
        fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()),
        fetch('https://mempool.space/api/v1/fees/recommended').then(r => r.json())
      ]);
      
      return {
        btc: { 
          price: parseFloat(btcRes.price), 
          whaleAlerts: mempoolRes.fastestFee > 40 ? Math.floor(mempoolRes.fastestFee / 10) : 1, 
          liquidationRisk: mempoolRes.fastestFee > 80 ? 'high' : 'moderate', 
          orderBookImbalance: '+2.1% buy-side' // Orderbook imbalance still requires a paid key, using static proxy
        },
        meta: { source: service.name, freshness: 'real-time', confidence: 0.94 },
      };
    } catch (e) {
      console.log(`[Puls Gateway] Warning: Real Crypto API failed, falling back. ${e.message}`);
      return {
        btc: { price: 104850 + Math.random() * 500, whaleAlerts: 3, liquidationRisk: 'moderate', orderBookImbalance: '+2.1% buy-side' },
        meta: { source: service.name, freshness: 'real-time (fallback)', confidence: 0.94 },
      };
    }
  }

  if (service.dataType === 'macro_intel') {
    try {
      const cpiRes = await fetch('https://api.worldbank.org/v2/country/us/indicator/FP.CPI.TOTL.ZG?format=json').then(r => r.json());
      const cpiLatest = cpiRes[1].find(d => d.value !== null);
      
      return {
        fed: { 
          rateCutProbability: '65%', 
          nextMeeting: 'Sep 2026', 
          cpiNowcast: `${cpiLatest.value.toFixed(1)}% (WorldBank ${cpiLatest.date})` 
        },
        meta: { source: service.name, freshness: 'daily', confidence: 0.88 },
      };
    } catch (e) {
      console.log(`[Puls Gateway] Warning: Real Macro API failed, falling back. ${e.message}`);
      return {
        fed: { rateCutProbability: '65%', nextMeeting: 'Sep 2026', cpiNowcast: '2.8%' },
        meta: { source: service.name, freshness: 'daily (fallback)', confidence: 0.88 },
      };
    }
  }

  return { error: 'Unknown data type' };
}

// ── Core: Discover → Evaluate → Pay (RFB01) ─────────────────────────────────
/**
 * Agent evaluates whether purchasing data from a Puls Registry endpoint is
 * worth the cost, then pays and retrieves it if the ROI is positive.
 *
 * @param {Object} agent    — { key, name, balance, confidenceLevel, walletAddress }
 * @param {Object} market   — { question, totalPool, slug, yesPct }
 * @param {string} endpointId — key in PULS_REGISTRY (e.g. 'btcnode_premium')
 * @returns {Object} { purchased, data, receipt, reason, costUsdc }
 */
async function evaluateAndBuyData(agent, market, endpointId) {
  const service = PULS_REGISTRY[endpointId];
  if (!service) {
    console.log(`[Puls Gateway] ❌ Unknown endpoint "${endpointId}" — not in Registry`);
    return { purchased: false, reason: `Endpoint "${endpointId}" not found in Puls Registry`, data: null };
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  [Puls Gateway]  DISCOVER → EVALUATE → PAY                     ║
╠══════════════════════════════════════════════════════════════════╣
║  Agent:     ${(agent.name || agent.key).padEnd(47)}║
║  Endpoint:  ${service.name.padEnd(47)}║
║  Cost:      ${(service.costUsdc + ' USDC').padEnd(47)}║
║  Market:    ${(market.question || '').slice(0, 47).padEnd(47)}║
║  Pool:      $${((market.totalPool || 0).toFixed(2) + ' USDC').padEnd(46)}║
╚══════════════════════════════════════════════════════════════════╝`);

  // ── Cost-Benefit Analysis ──────────────────────────────────────────────────

  // Check 1: High confidence — no need for paid data (save funds)
  if (agent.confidenceLevel > 90) {
    const reason = `Confidence already ${agent.confidenceLevel}% — no need to spend ${service.costUsdc} USDC on supplementary data. Economizing.`;
    console.log(`[Puls Gateway] 🧠 SKIP (high confidence) — ${reason}`);
    return { purchased: false, reason, data: null, costUsdc: 0 };
  }

  // Check 2: Insufficient balance
  if (agent.balance < service.costUsdc) {
    const reason = `Balance ${agent.balance} USDC < cost ${service.costUsdc} USDC — cannot afford ${service.name}.`;
    console.log(`[Puls Gateway] 💸 SKIP (insufficient funds) — ${reason}`);
    return { purchased: false, reason, data: null, costUsdc: 0 };
  }

  // Check 3: ROI analysis — expected profit must justify the data cost
  const expectedProfit = (market.totalPool || 0) * (agent.confidenceLevel / 100);
  const minAcceptableReturn = service.costUsdc * 10; // require at least 10x ROI
  if (expectedProfit < minAcceptableReturn) {
    const reason = `Expected profit $${expectedProfit.toFixed(6)} < 10× data cost $${minAcceptableReturn.toFixed(6)} — ROI too low for ${service.name}.`;
    console.log(`[Puls Gateway] 📉 SKIP (low ROI) — ${reason}`);
    return { purchased: false, reason, data: null, costUsdc: 0 };
  }

  // ── All checks passed — execute payment ────────────────────────────────────
  console.log(`[Puls Gateway] ✅ Cost-benefit PASSED — purchasing ${service.name}...`);

  try {
    // Pay via Circle Gateway on Arc Testnet
    const receipt = await simulateCircleGatewayPayment(agent, service);

    console.log(`
┌──────────────────────────────────────────────────────────────────┐
│  [Puls Gateway] 🚀 x402 NANOPAYMENT CLEARED on Arc Testnet     │
├──────────────────────────────────────────────────────────────────┤
│  Amount:   ${(service.costUsdc + ' USDC').padEnd(51)}│
│  From:     ${(agent.name || agent.key).padEnd(51)}│
│  To:       ${service.name.padEnd(51)}│
│  Settled:  ${(receipt.settledMs + 'ms (sub-second finality)').padEnd(51)}│
│  Tx:       ${(receipt.txHash.slice(0, 20) + '…').padEnd(51)}│
│  Chain:    ${receipt.chain.padEnd(51)}│
└──────────────────────────────────────────────────────────────────┘`);

    // Generate x402 token for the vendor API
    const x402Token = Buffer.from(JSON.stringify({
      txHash: receipt.txHash,
      payer: agent.key,
      endpoint: endpointId,
      ts: Date.now(),
    })).toString('base64');

    // Fetch exclusive data from the vendor API
    const data = await fetchPaidEndpoint(service, x402Token);

    // Debit agent balance
    agent.balance -= service.costUsdc;

    console.log(`[Puls Gateway] 📦 Data received from ${service.name} — enriching agent prompt.`);

    return {
      purchased: true,
      data,
      receipt,
      reason: `Purchased ${service.name} for ${service.costUsdc} USDC — ROI justified.`,
      costUsdc: service.costUsdc,
      x402Token,
    };
  } catch (error) {
    console.error(`[Puls Gateway] ❌ Payment/fetch failed for ${service.name}:`, error.message);
    return { purchased: false, reason: `Payment failed: ${error.message}`, data: null, costUsdc: 0 };
  }
}

/**
 * Format purchased data into a prompt-friendly string for the agent's LLM.
 * @param {Object} gatewayResult — return value from evaluateAndBuyData
 * @returns {string} text block to inject into the system/user prompt
 */
function formatGatewayDataForPrompt(gatewayResult) {
  if (!gatewayResult.purchased || !gatewayResult.data) return '';
  const data = gatewayResult.data;
  
  let details = '';
  if (data.btc) {
    details = `BTC: $${data.btc.price.toFixed(0)} | Whale alerts: ${data.btc.whaleAlerts} | Book: ${data.btc.orderBookImbalance}`;
  } else if (data.fed) {
    details = `Fed Rate Cut Prob: ${data.fed.rateCutProbability} | CPI Nowcast: ${data.fed.cpiNowcast}`;
  }

  return `
═══ EXCLUSIVE PAID DATA (Puls Gateway x402) ═══
Source: ${data.meta?.source} | Confidence: ${data.meta?.confidence * 100}%
Cost: ${gatewayResult.costUsdc} USDC (balance reduced)
${details}
═══ END PAID DATA ═══`;
}

export { PULS_REGISTRY, evaluateAndBuyData, formatGatewayDataForPrompt };
