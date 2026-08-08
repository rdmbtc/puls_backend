// ── Fund agent wallets from the treasury (bankroll top-up) ─────────────────
// Sends `amount` USDC from the treasury to every roster agent that has a
// wallet (memo "bankroll:<agent>", plain-transfer fallback).
//
//   node scripts/fund_agents.mjs 1000               # 1000 USDC to each agent
//   node scripts/fund_agents.mjs 1000 --only nova   # single agent (test run)
//   node scripts/fund_agents.mjs 1000 --dry-run
//
// Env: PRIVATE_KEY (treasury signer), ARC_RPC_URL (optional).
import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http, fallback,
  encodeFunctionData, keccak256, parseAbiItem, stringToHex, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const USDC = '0x3600000000000000000000000000000000000000';
const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
const ROSTER_URL = process.env.INVEST_ROSTER_URL || 'https://api.pulsmarket.tech/api/agents/roster';

const amount = Number(process.argv[2]);
if (!amount || amount <= 0) { console.error('usage: node scripts/fund_agents.mjs <amount> [--only a,b] [--direct key=address ...] [--dry-run]'); process.exit(1); }
const only = new Set((process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',').filter(Boolean) || []);
const direct = process.argv
  .filter((a) => a.startsWith('--direct='))
  .map((a) => a.split('=').slice(1).join('=').split('='))
  .map(([k, ...rest]) => [k, rest.join('=')])
  .filter(([, addr]) => addr);
const dryRun = process.argv.includes('--dry-run');

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicRpcUrl = (process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const transport = rpcUrl === publicRpcUrl
  ? http(rpcUrl, { timeout: 10000 })
  : fallback([http(rpcUrl, { timeout: 10000 }), http(publicRpcUrl, { timeout: 10000 })], { rank: false, retryCount: 1 });

const publicClient = createPublicClient({ chain: arcTestnet, transport });
const account = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`);
const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

const usdcTransferAbi = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];

async function roster() {
  const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`roster ${res.status}`);
  const data = await res.json();
  return (data.agents || []).filter((a) => a.key && a.address && (only.size === 0 || only.has(a.key)));
}

async function transferTo(address, usdc, memoKey) {
  const micro = BigInt(Math.round(usdc * 1_000_000));
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
      args: [USDC, innerData, keccak256(toHex(`bankroll:${memoKey}`)),
        stringToHex(JSON.stringify({ kind: 'bankroll', agent: memoKey, usdc }))],
    });
  } catch (e) {
    console.warn(`  memo failed (${e.message.slice(0, 80)}), falling back to plain transfer`);
    return await walletClient.writeContract({
      address: USDC, abi: usdcTransferAbi, functionName: 'transfer', args: [address, micro],
    });
  }
}

const agents = await roster();
const extra = direct.map(([k, address]) => ({ key: k, address }));
const targets = [...agents, ...extra];
if (!targets.length) { console.error('no agents matched'); process.exit(1); }
console.log(`sending ${amount} USDC each to ${targets.length} target(s): ${targets.map((a) => a.key).join(', ')}${dryRun ? ' [DRY RUN]' : ''}`);

let sent = 0;
for (const a of targets) {
  if (dryRun) { console.log(`${a.key}: would send ${amount} → ${a.address}`); continue; }
  const hash = await transferTo(a.address, amount, a.key);
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== 'success') throw new Error(`tx failed for ${a.key}: ${hash}`);
  console.log(`${a.key}: ${amount} USDC → ${a.address} (${hash})`);
  sent += amount;
}
if (!dryRun) {
  const abi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
  const bal = await publicClient.readContract({ address: USDC, abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`DONE. Sent ${sent} USDC total. Treasury remaining: ${(Number(bal) / 1e6).toFixed(2)} USDC`);
}
process.exit(0);
