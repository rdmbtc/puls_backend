/**
 * Dual-rail decision for Puls agent money-movement (pure, unit-tested).
 *
 * Every stake/deposit path resolves its rail through chooseRail():
 *   'sca'          → dev-controlled wallet exists → gasless Circle SCA path
 *                    (circle.createContractExecutionTransaction)
 *   'agent-wallet' → no dev-controlled wallet AND the swarm key is enabled on
 *                    the Circle Agent Stack → sign via the Circle CLI
 *                    (lib/circle_agent_wallet.executeContract)
 *   'none'         → no usable wallet at all → callers skip the row
 *
 * RAIL CONTRACT (applies to duels, bonds and invest):
 *   • Settlement / payouts ALWAYS execute treasury-side (admin EOA via viem).
 *     The contracts pay participants themselves — no participant signature
 *     exists or is needed. Never route settles through either rail above.
 *   • Stakes/deposits may come from EITHER rail; both produce an idempotent
 *     receipt (Circle tx UUID or on-chain 0x hash).
 */

import * as circleAgent from './circle_agent_wallet.js';

export const RAIL = {
  SCA: 'sca',
  AGENT_WALLET: 'agent-wallet',
  NONE: 'none',
};

/**
 * Decide which rail moves this agent's funds.
 * @param {string|null} walletId   dev-controlled wallet id (null on Agent Stack)
 * @param {string|null} agentKey   swarm key ('vega'); falsy disables the Agent-Stack branch
 * @returns {'sca'|'agent-wallet'|'none'}
 */
export function chooseRail(walletId, agentKey) {
  if (walletId) return RAIL.SCA;
  return circleAgent.isEnabled(agentKey) ? RAIL.AGENT_WALLET : RAIL.NONE;
}

export default chooseRail;
