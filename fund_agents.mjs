import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const proxyUrl = 'https://api.pulsmarket.tech/api/rpc-proxy';
const adminKey = process.env.PRIVATE_KEY || process.env.ADMIN_PRIVATE_KEY;
if (!adminKey) { console.error('PRIVATE_KEY not set'); process.exit(1); }
const admin = privateKeyToAccount(adminKey.startsWith('0x') ? adminKey : `0x${adminKey}`);
console.log('admin (treasury):', admin.address);

const walletClient = createWalletClient({ account: admin, chain: arcTestnet, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(proxyUrl) });

const USDC = '0x3600000000000000000000000000000000000000';
const usdcAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const TARGET = 100;

const roster = await (await fetch('https://api.pulsmarket.tech/api/agents/roster')).json();
console.log('roster agents:', roster.agents.length);
const toFund = roster.agents.filter((a) => a.address);
console.log('with address:', toFund.length);

for (const a of toFund) {
  const bal = Number(await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a.address] })) / 1e6;
  const need = TARGET - bal;
  if (need <= 0.01) { console.log(`[${a.key}] ${bal.toFixed(2)} USDC (>=${TARGET}) — skip`); continue; }
  const micro = BigInt(Math.round(need * 1e6));
  try {
    const tx = await walletClient.writeContract({ address: USDC, abi: usdcAbi, functionName: 'transfer', args: [a.address, micro], gas: 100000n });
    await publicClient.waitForTransactionReceipt({ hash: tx, pollingInterval: 3000 });
    const bal2 = Number(await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a.address] })) / 1e6;
    console.log(`[${a.key}] ${a.name}: funded +${need.toFixed(2)} → ${bal2.toFixed(2)} USDC (${tx})`);
  } catch (e) {
    console.error(`[${a.key}] funding failed: ${e.message}`);
  }
}
process.exit(0);
