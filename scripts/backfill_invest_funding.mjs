// ── Backfill: physically fund existing active investments ──────────────────
// Before this fix, invested USDC stayed in the treasury (virtual bookkeeping).
// This script transfers each agent's active invested total from the treasury
// to the agent's wallet (memo invest:<agent>) and marks the rows funded=true.
//
//   node scripts/backfill_invest_funding.mjs
//
// Env: DATABASE_URL, PRIVATE_KEY (treasury signer), ARC_RPC_URL (optional).
import 'dotenv/config';
import { createNeonClient } from '../lib/neon_supabase_adapter.js';
import {
  createPublicClient, createWalletClient, http, fallback,
  encodeFunctionData, keccak256, parseAbiItem, stringToHex, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const USDC = '0x3600000000000000000000000000000000000000';
const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
const ROSTER_URL = process.env.INVEST_ROSTER_URL || 'https://api.pulsmarket.tech/api/agents/roster';

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicRpcUrl = (process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const transport = rpcUrl === publicRpcUrl
  ? http(rpcUrl, { timeout: 10000 })
  : fallback([http(rpcUrl, { timeout: 10000 }), http(publicRpcUrl, { timeout: 10000 })], { rank: false, retryCount: 1 });

const supabase = createNeonClient(process.env.DATABASE_URL);
const account = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`);
const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

const usdcTransferAbi = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}];

async function agentAddresses() {
  const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const data = await res.json();
  const map = new Map();
  for (const a of (data.agents || [])) if (a.key && a.address) map.set(`agent_swarm_${a.key}`, a.address);
  return map;
}

async function transferTo(address, amountUsdc, memoKey) {
  const micro = BigInt(Math.round(amountUsdc * 1_000_000));
  try {
    const innerData = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
      functionName: 'transfer', args: [address, micro],
    });
    return await walletClient.writeContract({
      address: MEMO_CONTRACT,
      abi: [{ name: 'memo', type: 'function', stateMutability: 'nonpayable', inputs: [
        { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
        { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }], outputs: [] }],
      functionName: 'memo',
      args: [USDC, innerData, keccak256(toHex(`invest:${memoKey}`)),
        stringToHex(JSON.stringify({ kind: 'invest', agent: memoKey, usdc: amountUsdc }))],
    });
  } catch (e) {
    console.warn(`  memo failed (${e.message.slice(0, 80)}), falling back to plain transfer`);
    return await walletClient.writeContract({
      address: USDC, abi: usdcTransferAbi, functionName: 'transfer', args: [address, micro],
    });
  }
}

const { rows } = await supabase.pool.query(
  `SELECT agent_id, COUNT(*) n, COALESCE(SUM(amount_usdc),0) AS total
   FROM investments WHERE status='active' AND funded=false GROUP BY agent_id ORDER BY agent_id`);
if (!rows.length) { console.log('Nothing to fund — all active investments already funded.'); process.exit(0); }
const addresses = await agentAddresses();

for (const r of rows) {
  const address = addresses.get(r.agent_id);
  if (!address) { console.log(`${r.agent_id}: NO WALLET ADDRESS in roster — skipped (stays treasury-held)`); continue; }
  const amt = Math.round(Number(r.total) * 1_000_000) / 1_000_000;
  if (amt <= 0) continue;
  console.log(`${r.agent_id}: funding ${amt} USDC (${r.n} investments) → ${address}`);
  const hash = await transferTo(address, amt, r.agent_id);
  console.log(`  tx ${hash}`);
  const { error } = await supabase.pool.query(
    `UPDATE investments SET funded=true WHERE agent_id=$1 AND status='active' AND funded=false`, [r.agent_id]);
  if (error) throw error;
  console.log(`  marked funded=true`);
}
const { rows: left } = await supabase.pool.query(
  `SELECT COALESCE(SUM(amount_usdc),0) AS remaining FROM investments WHERE status='active' AND funded=false`);
console.log(`DONE. Remaining treasury-held: ${Number(left[0].remaining).toFixed(2)} USDC`);
process.exit(0);
