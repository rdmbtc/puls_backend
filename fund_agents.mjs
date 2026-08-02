import { createNeonClient } from './lib/neon_supabase_adapter.js';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const supabase = createNeonClient(process.env.DATABASE_URL);
const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const proxyUrl = 'https://api.pulsmarket.tech/api/rpc-proxy';
const adminKey = process.env.PRIVATE_KEY || process.env.ADMIN_PRIVATE_KEY;
if (!adminKey) { console.error('PRIVATE_KEY not set'); process.exit(1); }
const admin = privateKeyToAccount(adminKey.startsWith('0x') ? adminKey : `0x${adminKey}`);
console.log('admin (treasury):', admin.address);

const walletClient = createWalletClient({ account: admin, chain: arcTestnet, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(proxyUrl) });
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY || undefined,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET || undefined,
});

const USDC = '0x3600000000000000000000000000000000000000';
const usdcAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
const TARGET = 100;

const { data: rows } = await supabase.from('wallets').select('user_id, wallet_id, address').ilike('user_id', 'agent_%');
console.log('agent wallets:', (rows || []).length);

for (const row of rows || []) {
  let address = row.address;
  if (!address && circle) {
    try {
      const w = await circle.getWallet({ id: row.wallet_id });
      address = w.data.wallet.address;
      console.log(`[${row.user_id}] address from Circle: ${address}`);
    } catch (e) { console.error(`[${row.user_id}] circle getWallet failed: ${e.message}`); }
  }
  if (!address) { console.error(`[${row.user_id}] no address — skip`); continue; }

  const bal = Number(await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [address] })) / 1e6;
  const need = TARGET - bal;
  if (need <= 0.01) { console.log(`[${row.user_id}] ${bal.toFixed(2)} USDC (>=${TARGET}) — skip`); continue; }

  const micro = BigInt(Math.round(need * 1e6));
  try {
    const tx = await walletClient.writeContract({ address: USDC, abi: usdcAbi, functionName: 'transfer', args: [address, micro], gas: 100000n });
    await publicClient.waitForTransactionReceipt({ hash: tx, pollingInterval: 3000 });
    const bal2 = Number(await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [address] })) / 1e6;
    console.log(`[${row.user_id}] funded +${need.toFixed(2)} → ${bal2.toFixed(2)} USDC (tx ${tx})`);
  } catch (e) {
    console.error(`[${row.user_id}] funding failed: ${e.message}`);
  }
}

const { error: delErr } = await supabase.from('investments').delete().like('payment_id', 'seed-treasury-100-%');
console.log('seed ledger cleanup:', delErr ? `FAIL ${delErr.message}` : 'OK');
process.exit(0);
