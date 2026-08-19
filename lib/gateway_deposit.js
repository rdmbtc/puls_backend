/**
 * Circle Gateway & Cross-Chain CCTP On-Ramp
 *
 * Provides cross-chain routing metadata and instant deposit quotes for funding
 * Circle Smart Contract Accounts (SCA) on Arc from Base, Arbitrum, Ethereum, and Solana.
 */

export const SUPPORTED_CHAINS = [
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    cctpDomain: 6,
    icon: '🔵',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    latencyEstimateSec: 2,
    speed: 'Sub-second via Gateway / <20s CCTP',
  },
  {
    id: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    cctpDomain: 3,
    icon: '🔷',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    latencyEstimateSec: 2,
    speed: 'Sub-second via Gateway / <20s CCTP',
  },
  {
    id: 'ethereum',
    name: 'Ethereum Mainnet',
    chainId: 1,
    cctpDomain: 0,
    icon: '⟠',
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    latencyEstimateSec: 15,
    speed: '<15 min CCTP / Instant via Gateway',
  },
  {
    id: 'solana',
    name: 'Solana',
    chainId: 501,
    cctpDomain: 5,
    icon: '🟣',
    usdcAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    latencyEstimateSec: 1,
    speed: 'Sub-second via Gateway',
  },
  {
    id: 'arc',
    name: 'Arc Network',
    chainId: 5042002,
    cctpDomain: 12,
    icon: '⚡',
    usdcAddress: '0x0000000000000000000000000000000000000000', // native gas token
    latencyEstimateSec: 0.5,
    speed: '<500ms Native Finality',
  },
];

/**
 * Calculates a cross-chain deposit quote to Arc.
 */
export function getDepositQuote({ fromChainId, amountUsdc, destinationAddress }) {
  const amount = Number(amountUsdc) || 0;
  if (amount <= 0) throw new Error('Amount must be greater than 0');
  if (!destinationAddress) throw new Error('Destination address is required');

  const sourceChain = SUPPORTED_CHAINS.find(
    (c) => c.id === fromChainId || c.chainId === Number(fromChainId)
  );
  if (!sourceChain) throw new Error(`Unsupported source chain: ${fromChainId}`);

  // Fee model: 0.00 USDC bridge protocol subsidy on Arc testnet
  const bridgeFeeUsdc = 0.0;
  const netReceivedUsdc = amount - bridgeFeeUsdc;

  return {
    sourceChain: sourceChain.name,
    sourceChainId: sourceChain.id,
    cctpDomain: sourceChain.cctpDomain,
    amountSentUsdc: amount,
    bridgeFeeUsdc,
    netReceivedUsdc,
    destinationChain: 'Arc Network',
    destinationAddress,
    estimatedLatencySec: sourceChain.latencyEstimateSec,
    speed: sourceChain.speed,
    expiresAt: new Date(Date.now() + 600 * 1000).toISOString(),
  };
}

/**
 * Registers Express routes for cross-chain Gateway deposits.
 */
export function registerGatewayRoutes(app) {
  app.get('/api/gateway/chains', (req, res) => {
    return res.json({
      ok: true,
      chains: SUPPORTED_CHAINS,
      total: SUPPORTED_CHAINS.length,
    });
  });

  app.post('/api/gateway/quote', (req, res) => {
    try {
      const { fromChainId, amountUsdc, destinationAddress } = req.body || {};
      const quote = getDepositQuote({ fromChainId, amountUsdc, destinationAddress });
      return res.json({ ok: true, quote });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });
}
