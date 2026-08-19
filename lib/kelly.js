/**
 * Kelly Criterion Position Sizing for Autonomous Prediction Market Agents
 *
 * Computes optimal bet sizing based on agent's estimated true probability (confidence)
 * vs market implied probability (price), protecting agent bankroll from overexposure.
 */

/**
 * Calculates position sizing via Fractional Kelly Criterion.
 *
 * @param {Object} params
 * @param {number} params.confidence - Agent's estimated probability (0.01 - 0.99)
 * @param {number} params.marketPrice - Current market probability/price (0.01 - 0.99)
 * @param {'YES'|'NO'} params.side - Trade side
 * @param {number} params.bankrollUsdc - Current agent bankroll in USDC
 * @param {number} [params.fractionalMultiplier=0.5] - Half-Kelly (0.5) or Quarter-Kelly (0.25)
 * @param {number} [params.maxFraction=0.08] - Max fraction of bankroll per single trade (default 8%)
 * @param {number} [params.minBet=0.05] - Minimum bet threshold
 * @param {number} [params.maxBet=10.0] - Hard cap in USDC
 * @returns {{ shouldTrade: boolean, amountUsdc: number, kellyFraction: number, edgePct: number, reason: string }}
 */
export function computeKellySize({
  confidence,
  marketPrice,
  side = 'YES',
  bankrollUsdc = 10.0,
  fractionalMultiplier = 0.5,
  maxFraction = 0.08,
  minBet = 0.05,
  maxBet = 10.0,
}) {
  const p = Math.max(0.01, Math.min(0.99, Number(confidence) || 0.5));
  const P = Math.max(0.01, Math.min(0.99, Number(marketPrice) || 0.5));
  const bankroll = Math.max(0, Number(bankrollUsdc) || 0);

  if (bankroll <= minBet) {
    return {
      shouldTrade: false,
      amountUsdc: 0,
      kellyFraction: 0,
      edgePct: 0,
      reason: 'Insufficient bankroll for minimum bet',
    };
  }

  let edge = 0;
  let fullKelly = 0;

  if (side === 'YES') {
    edge = p - P;
    if (edge <= 0.01) {
      return {
        shouldTrade: false,
        amountUsdc: 0,
        kellyFraction: 0,
        edgePct: Math.round(edge * 1000) / 10,
        reason: 'Negative or negligible expected value for YES (p <= P)',
      };
    }
    // f* = (p - P) / (1 - P)
    fullKelly = (p - P) / (1 - P);
  } else {
    // side === 'NO'
    const probNo = 1 - p;
    const priceNo = 1 - P;
    edge = probNo - priceNo;
    if (edge <= 0.01) {
      return {
        shouldTrade: false,
        amountUsdc: 0,
        kellyFraction: 0,
        edgePct: Math.round(edge * 1000) / 10,
        reason: 'Negative or negligible expected value for NO (q <= Q)',
      };
    }
    // f* = ((1 - p) - (1 - P)) / P = (P - p) / P
    fullKelly = (P - p) / P;
  }

  // Apply fractional multiplier (e.g. Half-Kelly) and ceiling
  const adjFraction = Math.min(fullKelly * fractionalMultiplier, maxFraction);
  if (adjFraction <= 0) {
    return {
      shouldTrade: false,
      amountUsdc: 0,
      kellyFraction: 0,
      edgePct: Math.round(edge * 1000) / 10,
      reason: 'Calculated Kelly fraction is zero',
    };
  }

  let amount = bankroll * adjFraction;
  amount = Math.max(minBet, Math.min(amount, maxBet));
  // Round to 2 decimal places
  amount = Math.round(amount * 100) / 100;

  return {
    shouldTrade: true,
    amountUsdc: amount,
    kellyFraction: Math.round(adjFraction * 1000) / 1000,
    edgePct: Math.round(edge * 1000) / 10,
    reason: `Positive EV: +${(edge * 100).toFixed(1)}% edge -> sized at ${amount} USDC (${(adjFraction * 100).toFixed(1)}% bankroll)`,
  };
}
