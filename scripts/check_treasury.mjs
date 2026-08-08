// ── Ops check: treasury + agent USDC balances ──────────────────────────────
//   node scripts/check_treasury.mjs
// Prints the treasury (PRIVATE_KEY) USDC balance and every roster agent's
// USDC balance on ARC-TESTNET. Pure read-only; safe to run anytime.
import 'dotenv/config';
import { createPublicClient, http, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const USDC = '0x3600000000000000000000000000000000000000';
const ROSTER_URL = process.env.INVEST_ROSTER_URL || 'https://api.pulsmarket.tech/api/agents/roster';

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicRpcUrl = (process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const transport = rpcUrl === publicRpcUrl
  ? http(rpcUrl, { timeout: 10000 })
  : fallback([http(rpcUrl, { timeout: 10000 }), http(publicRpcUrl, { timeout: 10000 })], { rank: false, retryCount: 1 });

const publicClient = createPublicClient({ chain: arcTestnet, transport });
const balanceAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];

async function usdc(address) {
  try {
    const b = await publicClient.readContract({ address: USDC, abi: balanceAbi, functionName: 'balanceOf', args: [address] });
    return Number(b) / 1_000_000;
  } catch (e) {
    return `ERR ${e.message.slice(0, 60)}`;
  }
}

const treasury = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`);
console.log(`treasury ${treasury.address} bal=${await usdc(treasury.address)} USDC`);

const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(15000) });
const data = await res.json();
for (const a of (data.agents || [])) {
  console.log(`${a.key} ${a.address} bal=${await usdc(a.address)} USDC`);
}
process.exit(0);
