#!/usr/bin/env node
// One-shot cleanup of the stale-market backlog.
//
// For every deployed market that is past its deadline and not resolved:
//   1. If Polymarket reports a definitive outcome  → resolve it on-chain (legacy
//      direct resolve; these markets predate UMA registration) + update DB.
//   2. Otherwise (slug gone / never resolved / indeterminate) → mark it
//      `archived` in Supabase so it disappears from cache, cron and listings.
//      Markets with open positions are reported and archived too (claims would
//      revert anyway until resolved — archiving touches nothing on-chain).
//
// Usage (from the backend root, .env present):
//   node scripts/cleanup_stale_markets.mjs            # DRY RUN — prints the plan
//   node scripts/cleanup_stale_markets.mjs --execute  # actually resolve + archive
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, createWalletClient, http, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const EXECUTE = process.argv.includes('--execute');
const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicRpcUrl = (process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const rpcTransport = rpcUrl === publicRpcUrl
  ? http(rpcUrl, { timeout: 10000 })
  : fallback([http(rpcUrl, { timeout: 10000 }), http(publicRpcUrl, { timeout: 10000 })], { rank: false, retryCount: 1 });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const publicClient = createPublicClient({ chain: arcTestnet, transport: rpcTransport });
const adminAccount = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`);
const walletClient = createWalletClient({ account: adminAccount, chain: arcTestnet, transport: rpcTransport });

const MARKET_ABI = [
  { name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
    { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
    { name: '_yesOutstanding', type: 'uint256' }, { name: '_noOutstanding', type: 'uint256' } ] },
  { name: 'resolve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_outcome', type: 'bool' }], outputs: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pmLookup(slug) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    if (!res.ok) return { status: 'pm_error' };
    const list = await res.json();
    if (!list || list.length === 0) return { status: 'gone' };
    const m = list[0];
    const closed = m.closed === true || m.resolved === true;
    if (!closed) return { status: 'open' };
    let outcome = null;
    if (m.consensusOutcome === 'YES') outcome = true;
    else if (m.consensusOutcome === 'NO') outcome = false;
    else {
      try {
        const prices = JSON.parse(m.outcomePrices || '[]');
        if (parseFloat(prices[0]) > 0.9) outcome = true;
        else if (parseFloat(prices[1]) > 0.9) outcome = false;
      } catch {}
    }
    return outcome === null ? { status: 'indeterminate' } : { status: 'resolvable', outcome };
  } catch {
    return { status: 'pm_error' };
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const { data, error } = await supabase.from('deployed_markets').select('*')
    .eq('resolved', false).lt('deadline', now);
  if (error) { console.error('Supabase query failed:', error.message); process.exit(1); }
  const rows = (data || []).filter((r) => r.archived !== true);
  console.log(`${rows.length} stale markets (past deadline, unresolved, not archived). Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);

  const summary = { resolved: [], archived: [], withPositions: [], failed: [] };
  for (const row of rows) {
    const pm = await pmLookup(row.slug);
    await sleep(150); // be polite to gamma API
    let positions = 0n;
    try {
      const info = await publicClient.readContract({ address: row.contract_address, abi: MARKET_ABI, functionName: 'getMarketInfo' });
      if (info[2] === true) { // already resolved on-chain, DB just stale
        if (EXECUTE) await supabase.from('deployed_markets').update({ resolved: true, outcome: info[3] }).eq('slug', row.slug);
        summary.resolved.push(`${row.slug} (on-chain already, DB synced)`);
        continue;
      }
      positions = info[4] + info[5];
    } catch { /* unreadable contract — archive below */ }

    if (pm.status === 'resolvable') {
      try {
        if (EXECUTE) {
          const { request } = await publicClient.simulateContract({
            account: adminAccount, address: row.contract_address, abi: MARKET_ABI,
            functionName: 'resolve', args: [pm.outcome] });
          const hash = await walletClient.writeContract(request);
          await publicClient.waitForTransactionReceipt({ hash });
          await supabase.from('deployed_markets').update({ resolved: true, outcome: pm.outcome }).eq('slug', row.slug);
        }
        summary.resolved.push(`${row.slug} → ${pm.outcome ? 'YES' : 'NO'}`);
      } catch (e) {
        summary.failed.push(`${row.slug}: ${e.shortMessage || e.message}`);
      }
    } else {
      if (EXECUTE) {
        const { error: aErr } = await supabase.from('deployed_markets').update({ archived: true }).eq('slug', row.slug);
        if (aErr) { summary.failed.push(`${row.slug}: archive failed — ${aErr.message}`); continue; }
      }
      summary.archived.push(`${row.slug} (${pm.status}${positions > 0n ? `, ${Number(positions) / 1e6} shares outstanding` : ''})`);
      if (positions > 0n) summary.withPositions.push(row.slug);
    }
  }

  console.log(`\n=== SUMMARY (${EXECUTE ? 'applied' : 'dry run — rerun with --execute'}) ===`);
  console.log(`Resolved on-chain: ${summary.resolved.length}`);
  summary.resolved.forEach((s) => console.log(`  ✓ ${s}`));
  console.log(`Archived: ${summary.archived.length}`);
  summary.archived.forEach((s) => console.log(`  ▪ ${s}`));
  if (summary.withPositions.length) console.log(`⚠ Archived WITH open positions (${summary.withPositions.length}): ${summary.withPositions.join(', ')}`);
  console.log(`Failed: ${summary.failed.length}`);
  summary.failed.forEach((s) => console.log(`  ✗ ${s}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
