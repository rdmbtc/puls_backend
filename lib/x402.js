/**
 * Puls x402 creator-monetization layer.
 *
 * Express middleware that turns any route into a paid resource using
 * Circle Gateway batched nanopayments (x402) on Arc Testnet. A forecaster
 * publishes analysis behind this paywall; a buyer (human or agent) pays a
 * sub-cent USDC nanopayment that settles to the seller's Arc wallet.
 *
 * Ported from Circle's official `arc-nanopayments` reference (`lib/x402.ts`),
 * adapted to Express 5 (CommonStyle middleware) + Puls Supabase.
 *
 * Verified Arc Testnet constants (see SKILL refs):
 *   network          eip155:5042002
 *   USDC             0x3600000000000000000000000000000000000000 (6 dp)
 *   Gateway Wallet   0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 */

import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { createClient } from '@supabase/supabase-js';
import { createNeonClient } from './neon_supabase_adapter.js';

// ── Arc Testnet contract addresses (baked into @circle-fin/x402-batching) ──
const ARC_TESTNET_NETWORK = 'eip155:5042002';
const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000';
const ARC_TESTNET_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';

// ── x402 authorization validity windows ────────────────────────────────────
// The buyer's GatewayClient signs `validAfter = now - 600` and
// `validBefore = now + maxTimeoutSeconds`, using the value we ADVERTISE in the
// 402 PAYMENT-REQUIRED header. Circle's Gateway facilitator
// (gateway-api-testnet.circle.com, see getSupported().extra.minValiditySeconds)
// REQUIRES the authorization to stay valid for at least 604800s (7 days), else
// it returns `authorization_validity_too_short`. So maxTimeoutSeconds must be
// >= 604800; we use 8 days for headroom against the verify-time check.
const ADVERTISED_MAX_TIMEOUT = 691200; // 8 days — must exceed Gateway minValiditySeconds (604800 = 7 days)
const VERIFY_MAX_TIMEOUT = 691200;     // same window passed to verify/settle

// Seller wallet that receives the nanopayments. For the hello-world this is a
// dedicated Puls receiver; later each forecaster supplies their own payTo.
export const sellerAddress = (process.env.X402_SELLER_ADDRESS || '').trim();

const facilitator = new BatchFacilitatorClient();

// DB client: Aiven/Neon (DATABASE_URL) when configured, else Supabase.
// Matches server.js — x402 receipts are best-effort and never block serving.
const NEON_DATABASE_URL = (process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '').trim();
const db = NEON_DATABASE_URL
  ? createNeonClient(NEON_DATABASE_URL)
  : (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
      ? createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_KEY.trim())
      : null);

/**
 * Build x402 payment requirements for a given dollar price string ("$0.001").
 * @param {string} price
 * @param {string} [payTo] override receiver (defaults to sellerAddress)
 * @param {number} [maxTimeoutSeconds] validity window (defaults to advertised)
 */
function buildPaymentRequirements(price, payTo = sellerAddress, maxTimeoutSeconds = ADVERTISED_MAX_TIMEOUT) {
  const amount = Math.round(parseFloat(String(price).replace('$', '')) * 1_000_000); // USDC atomic (6 dp)
  return {
    scheme: 'exact',
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

/**
 * Express 5 middleware factory. Wrap any route to require an x402 nanopayment.
 *
 *   app.get('/api/alpha/sample', x402Paywall('$0.001', '/api/alpha/sample'), handler)
 *
 * On a request without a payment, replies 402 + base64 `PAYMENT-REQUIRED`
 * header describing what to pay. When a valid `payment-signature` header is
 * present, it is verified + settled via Circle Gateway, the event is recorded
 * to Supabase (`x402_payments`), the settlement is echoed in a base64
 * `PAYMENT-RESPONSE` header, and control passes to the real handler.
 *
 * @param {string} price       dollar price, e.g. "$0.001"
 * @param {string} endpoint    canonical resource path (for descriptors + logs)
 * @param {object} [opts]
 * @param {string} [opts.description]  human description of the resource
 * @param {() => (string|undefined)} [opts.payTo]  optional dynamic receiver
 * @param {(req) => (string|null)} [opts.priceFn]  dynamic price override — must
 *   return a dollar string like "$5.00" or null to signal an invalid request
 *   (responds 400 instead of 402). Takes precedence over `price`.
 * @param {(req) => string} [opts.endpointFn]  dynamic endpoint override
 *   (per-request resource path, e.g. /api/invest/:agentId). Takes precedence
 *   over `endpoint`.
 * @param {(settlement) => Promise<void>} [opts.onSettled]  optional callback
 *   awaited after a successful settle (investment crediting, notifications…).
 *   Receives { endpoint, payer, payTo, amountUsdc, transaction }.
 */
export function x402Paywall(price, endpoint, opts = {}) {
  return async (req, res, next) => {
    if (!sellerAddress) {
      console.error('[x402] X402_SELLER_ADDRESS not configured — paywall disabled');
      return res.status(503).json({ error: 'x402 paywall not configured' });
    }

    // Dynamic pricing (Puls Invest): resolve + validate before building
    // requirements so invalid amounts 400 instead of 402.
    const priceFnResult = opts.priceFn ? opts.priceFn(req) : null;
    if (opts.priceFn && priceFnResult === null) {
      return res.status(400).json({ error: 'Invalid price', reason: req.x402PriceError || 'amount validation failed' });
    }
    const effectivePrice = opts.priceFn ? priceFnResult : price;
    const effectiveEndpoint = opts.endpointFn ? opts.endpointFn(req) : endpoint;

    const payTo = (opts.payTo && opts.payTo(req)) || sellerAddress;
    // Advertised requirements: the buyer signs validBefore = now + ADVERTISED_MAX_TIMEOUT.
    const requirements = buildPaymentRequirements(effectivePrice, payTo, ADVERTISED_MAX_TIMEOUT);
    // Facilitator requirements: slightly shorter window → headroom on the
    // `validBefore >= now + maxTimeoutSeconds` check (avoids validity_too_short).
    const verifyRequirements = buildPaymentRequirements(effectivePrice, payTo, VERIFY_MAX_TIMEOUT);
    const paymentSignature = req.headers['payment-signature'];

    // ── No payment → 402 with Gateway batching payment requirements ──
    if (!paymentSignature) {
      console.log(`[x402] 402 Payment Required: ${effectiveEndpoint}`);
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: effectiveEndpoint,
          description: opts.description || `Paid resource (${effectivePrice} USDC)`,
          mimeType: 'application/json',
        },
        accepts: [requirements],
      };
      return res
        .status(402)
        .set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'))
        .json({});
    }

    // ── Payment present → verify + settle via Circle Gateway ──
    try {
      const paymentPayload = JSON.parse(
        Buffer.from(String(paymentSignature), 'base64').toString('utf-8')
      );

      const verifyResult = await facilitator.verify(paymentPayload, verifyRequirements);
      if (!verifyResult.isValid) {
        console.error('[x402] verify invalid:', JSON.stringify(verifyResult));
        return res
          .status(402)
          .json({ error: 'Payment verification failed', reason: verifyResult.invalidReason });
      }

      const settleResult = await facilitator.settle(paymentPayload, verifyRequirements);
      if (!settleResult.success) {
        console.error(`[x402] Settlement failed for ${effectiveEndpoint}: ${settleResult.errorReason}`);
        return res
          .status(402)
          .json({ error: 'Payment settlement failed', reason: settleResult.errorReason });
      }

      const amountUsdc = (Number(requirements.amount) / 1e6).toString();
      const payer = settleResult.payer ?? verifyResult.payer ?? 'unknown';

      // Record the payment event (best-effort; never blocks serving).
      if (db) {
        db
        .from('x402_payments')
        .insert({
          effectiveEndpoint,
          payer,
          pay_to: payTo,
          amount_usdc: amountUsdc,
          network: requirements.network,
          gateway_tx: settleResult.transaction ?? null,
          raw: { requirements, settleResult },
        })
        .then(({ error }) => {
          if (error) console.error('[x402] Failed to record payment event:', error.message);
        });
      }

      console.log(`[x402] Payment settled: ${effectiveEndpoint} — ${amountUsdc} USDC from ${payer}`);

      // Expose settlement info to the handler + client.
      req.x402 = { payer, payTo, amountUsdc, transaction: settleResult.transaction ?? null };

      // Post-settlement hook (investment crediting, etc.) — awaited so the
      // response reflects it, but a hook failure never fails the payment.
      if (opts.onSettled) {
        try {
          await opts.onSettled({ endpoint: effectiveEndpoint, payer, payTo, amountUsdc, transaction: settleResult.transaction ?? null });
        } catch (e) {
          console.error(`[x402] onSettled hook failed for ${effectiveEndpoint}:`, e.message);
        }
      }

      res.set(
        'PAYMENT-RESPONSE',
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: settleResult.transaction,
            network: requirements.network,
            payer,
          })
        ).toString('base64')
      );

      return next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[x402] Payment processing error:', message);
      return res.status(500).json({ error: 'Payment processing error', message });
    }
  };
}

/** Public, free config endpoint — handy for demos, the buyer agent, and judges. */
export function x402Info(_req, res) {
  return res.json({
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    gatewayWallet: ARC_TESTNET_GATEWAY_WALLET,
    sellerAddress: sellerAddress || null,
    configured: Boolean(sellerAddress),
    paywalledEndpoints: [
      { path: '/api/alpha/sample', price: '$0.001', method: 'GET' },
      { path: '/api/lepton/ask', price: '$0.000001', method: 'GET' },
      { path: '/api/x402/markets', price: '$0.01', method: 'GET' },
    ],
    receiptsEndpoint: '/api/x402/payments',
    explorerAddressUrl: sellerAddress ? `https://testnet.arcscan.app/address/${sellerAddress}` : null,
  });
}
