/**
 * Puls x402 buyer demo — pays for one premium forecast via Circle Gateway
 * nanopayments on Arc Testnet and prints the settlement tx (visible on arcscan).
 *
 * This is the "buyer (human or agent)" side of the creator loop. It mirrors
 * Circle's official `arc-nanopayments` buyer (`agent.mts`), trimmed to a single
 * paid request so it's easy to demo and screenshot.
 *
 * Prereqs (.env on the server, NEVER in git/chat):
 *   BUYER_PRIVATE_KEY   funded wallet — top up via https://faucet.circle.com
 *                       (testnet USDC; on Arc, gas is native USDC too)
 *   BASE_URL            backend base (default http://localhost:3000)
 *   DEPOSIT_AMOUNT      USDC to deposit into Gateway Wallet (default "0.5")
 *
 * Run on the server:
 *   node scripts/x402-buyer.mjs
 */
import 'dotenv/config';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || '0.5';
const buyerKey = process.env.BUYER_PRIVATE_KEY;

if (!buyerKey) {
  console.error('Missing BUYER_PRIVATE_KEY. Generate a wallet and fund it via https://faucet.circle.com');
  process.exit(1);
}

const RESOURCE = `${BASE_URL}/api/alpha/sample`;

async function main() {
  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: buyerKey.startsWith('0x') ? buyerKey : `0x${buyerKey}`,
  });

  console.log('Checking balances...');
  let balances = await gateway.getBalances();
  console.log(`  wallet USDC:   ${balances.wallet?.formattedBalance ?? balances.wallet?.balance}`);
  console.log(`  gateway avail: ${balances.gateway?.formattedAvailable ?? balances.gateway?.available}`);

  // Deposit into the Gateway Wallet if available balance is thin.
  if (!balances.gateway?.available || balances.gateway.available < 100_000n) {
    console.log(`Depositing ${DEPOSIT_AMOUNT} USDC into Gateway Wallet...`);
    const dep = await gateway.deposit(DEPOSIT_AMOUNT);
    console.log(`  deposit tx: ${dep.depositTxHash}`);
    balances = await gateway.getBalances();
    console.log(`  gateway avail now: ${balances.gateway?.formattedAvailable ?? balances.gateway?.available}`);
  }

  console.log(`\nPaying for premium forecast: GET ${RESOURCE}`);
  const start = Date.now();
  const result = await gateway.pay(RESOURCE, { method: 'GET' });
  const ms = Date.now() - start;

  console.log(`\n✅ Paid ${result.formattedAmount} USDC in ${ms}ms`);
  if (result.transaction) {
    console.log(`   settlement tx: ${result.transaction}`);
    console.log(`   arcscan:       https://testnet.arcscan.app/tx/${result.transaction}`);
  }
  console.log('\n--- forecast payload ---');
  console.log(JSON.stringify(result.data ?? result.body ?? result, null, 2));
}

main().catch((err) => {
  console.error('Buyer demo failed:', err?.message || err);
  process.exit(1);
});
