const fs = require('fs');
let code = fs.readFileSync('lib/agent_swarm.js', 'utf8');

// 1. Add x402Research function and modify INTERVAL_MIN
code = code.replace(
  "  const INTERVAL_MIN = Math.max(3, parseInt(process.env.AGENT_SWARM_INTERVAL_MIN || '6', 10));",
  `  const INTERVAL_MIN = Math.max(1, parseInt(process.env.AGENT_SWARM_INTERVAL_MIN || '2', 10)); // TURBO MODE

  const X402_RESEARCH_COST_MICRO = 100; // 0.0001 USDC
  async function x402Research(cfg, question, limit = 3) {
    try {
      if (cfg && cfg.walletKey && adminAccount) {
        const walletId = await getWalletId(cfg.walletKey);
        if (walletId) {
          const { txId } = await usdcTransferWithMemo(walletId, adminAccount, X402_RESEARCH_COST_MICRO, 'x402:research', { query: question.slice(0, 50) });
          console.log(\`\\n🟢 [RECEIPT] x402 NANOPAYMENT CLEARED · settled on Arc
┌──────────────────────────────────────────────────────┐
│  $0.0001 USDC                                        │
│  from Agent \${cfg.name} (\${cfg.role})
│    to Puls Data Faucet (Tavily/CMC Bridge)           │
└──────────────────────────────────────────────────────┘
▸ Data unlocked: Web Search & Oracle Prices
⛓ https://testnet.arcscan.app/tx/\${txId || 'pending...'}\\n\`);
        }
      }
    } catch (e) {}
    return await researchQuestion(question, limit);
  }
`
);

// 2. Replace all researchQuestion(...) with x402Research(cfg, ...)
// inside runCreator and runTrader
code = code.replace(/await researchQuestion\(([^,]+),\s*(\d+)\)/g, 'await x402Research(cfg, $1, $2)');
// for the ones without limit
code = code.replace(/await researchQuestion\(([^,)]+)\)/g, 'await x402Research(cfg, $1)');

// The processAgentReply uses deps.researchQuestion, we can replace it to use x402Research but we need cfg.
// cfg can be looked up from ROSTER.
code = code.replace(
  /await deps\.researchQuestion\(([^,]+),\s*(\d+)\)/g,
  'await x402Research(ROSTER.find(a => a.key === agentKey), $1, $2)'
);

fs.writeFileSync('lib/agent_swarm.js', code);
console.log("Patched successfully");
