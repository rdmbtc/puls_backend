/**
 * Puls payment helpers — USDC transfers with platform take-rate.
 *
 * Every nanopayment path (tips, signal unlocks, alpha unlocks, copy fees,
 * agent-to-agent buys, blog tips, director) routes through here instead of
 * calling `circle.createContractExecutionTransaction` directly. This module
 * splits each payment into:
 *
 *   1. Creator/recipient portion: `gross * (1 - takeRate)`
 *   2. Treasury portion:          `gross * takeRate`
 *
 * The take-rate is configurable via `PLATFORM_TAKE_RATE_BPS` (default 500 = 5%).
 * Set to 0 to disable revenue collection.
 *
 * Revenue is tracked in the `x402_payments` table via the `raw` JSONB column
 * (`raw.treasuryFeeUsdc`, `raw.netUsdc`) so /api/stats can aggregate it.
 *
 * Exemptions:
 *   - Director refunds (treasury → user) are NOT routed through here.
 *   - True x402 Gateway settlements (facilitator.settle) can't be split here
 *     — the USDC moves inside Circle's batch client. A post-settle secondary
 *     transfer from the seller address → treasury would be needed for those.
 */
import { eventBus, EVENTS } from './events.js';

const TAKE_RATE_BPS = Math.max(0, Math.min(5000, parseInt(process.env.PLATFORM_TAKE_RATE_BPS || '500', 10)));
const TAKE_RATE_PCT = TAKE_RATE_BPS / 10_000;

/**
 * Split a gross USDC amount into recipient + treasury portions.
 * @param {number} grossUsdc
 * @returns {{ netUsdc: number, treasuryFeeUsdc: number }}
 */
export function splitTakeRate(grossUsdc) {
  const gross = Math.max(0, Number(grossUsdc) || 0);
  if (TAKE_RATE_BPS === 0) {
    return { netUsdc: gross, treasuryFeeUsdc: 0 };
  }
  // Round to 6 decimal places (micro-USDC precision) to avoid drift.
  const treasuryFee = Math.round(gross * TAKE_RATE_PCT * 1_000_000) / 1_000_000;
  const net = Math.round((gross - treasuryFee) * 1_000_000) / 1_000_000;
  return { netUsdc: net, treasuryFeeUsdc: treasuryFee };
}

/**
 * Execute a USDC transfer from a Circle SCA wallet to a recipient, with the
 * platform take-rate automatically routed to the treasury address.
 *
 * Replaces the canonical pattern:
 *   circle.createContractExecutionTransaction({ walletId, contractAddress: USDC,
 *     abiFunctionSignature: 'transfer(address,uint256)', abiParameters: [payTo, amountMicro], ... })
 *
 * @param {object} circle — Circle SDK client
 * @param {string} walletId — payer's Circle wallet ID
 * @param {string} usdcAddress — USDC contract address
 * @param {string} recipientAddress — the creator/seller address (gets net)
 * @param {number} grossUsdc — total amount before take-rate split
 * @param {string} treasuryAddress — platform treasury EOA (gets the fee)
 * @param {object} [opts] — { memoKey, memoObj } for memo-wrapped transfers
 * @returns {Promise<{ txId: string|null, grossUsdc: number, netUsdc: number, treasuryFeeUsdc: number, treasuryTxId: string|null }>}
 */
export async function usdcTransferWithTakeRate(
  circle,
  walletId,
  usdcAddress,
  recipientAddress,
  grossUsdc,
  treasuryAddress,
  opts = {}
) {
  const { netUsdc, treasuryFeeUsdc } = splitTakeRate(grossUsdc);
  const netMicro = BigInt(Math.round(netUsdc * 1_000_000)).toString();
  const feeMicro = BigInt(Math.round(treasuryFeeUsdc * 1_000_000)).toString();

  // 1. Transfer the net amount to the recipient.
  let txId = null;
  if (netMicro !== '0' && netMicro > 0) {
    const res = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: usdcAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [recipientAddress, netMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    txId = res.data?.id || null;
  }

  // 2. Transfer the take-rate to the treasury (best-effort, non-blocking).
  let treasuryTxId = null;
  if (feeMicro !== '0' && feeMicro > 0 && treasuryAddress) {
    try {
      const tres = await circle.createContractExecutionTransaction({
        walletId,
        contractAddress: usdcAddress,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [treasuryAddress, feeMicro],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      treasuryTxId = tres.data?.id || null;
    } catch (e) {
      console.warn('[payments] treasury take-rate transfer failed:', e.message);
    }
  }

  return { txId, grossUsdc, netUsdc, treasuryFeeUsdc, treasuryTxId };
}

/**
 * Annotate an `x402_payments` row's `raw` JSONB with take-rate fields so
 * /api/stats can aggregate protocol revenue.
 *
 * @param {object} raw — the existing raw JSONB object
 * @param {{ netUsdc: number, treasuryFeeUsdc: number }} split — from splitTakeRate
 * @returns {object} — the annotated raw object
 */
export function annotatePayment(raw, split) {
  return {
    ...(raw || {}),
    grossUsdc: split.netUsdc + split.treasuryFeeUsdc,
    netUsdc: split.netUsdc,
    treasuryFeeUsdc: split.treasuryFeeUsdc,
  };
}

export const TAKE_RATE = TAKE_RATE_PCT;
export const TAKE_RATE_BPS_CONST = TAKE_RATE_BPS;
