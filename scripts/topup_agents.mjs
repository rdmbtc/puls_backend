#!/usr/bin/env node
/**
 * Agent USDC top-up via Circle faucet.
 *
 * WHY: Swarm agents (Vega/Cygnus/Orion/Atlas/Nova/Striker) + house Pulse burn
 * their USDC bankroll on trades. When a balance drops below TOPUP_MIN_USDC the
 * agent logs "[swarm:xxx] balance X too low" and stops trading. This script
 * periodically tops them back up from the Circle testnet faucet so the colony
 * never goes dark.
 *
 * Faucet facts (verified 2026-08-06):
 *   - POST https://api.circle.com/v1/faucet/drips with the backend's
 *     CIRCLE_API_KEY works for ARBITRARY addresses (unlike the CLI's
 *     `circle wallet fund`, which only funds the agent-account's own wallets).
 *  - Each drip sends 20 USDC (usdc:true, native:false) and the faucet allows
 *     ONE request per address per ~2h (per asset+network pairing). Server-side
 *     enforced; a too-frequent call returns an error we log and skip.
 *  - The faucet ALSO rate-limits per API key (429 on everything once the
 *     key's quota is spent). When a drip comes back 429 the script falls back
 *     to sending TOPUP_FALLBACK_USDC (default 20) from the treasury signer
 *     (PRIVATE_KEY) via the memo contract — same path as fund_agents.mjs — so
 *     agents never go dark just because Circle's free faucet is exhausted.
 *
 * Usage:
 *   node scripts/topup_agents.mjs --once          # single pass (Heroku Scheduler / cron)
 *   node scripts/topup_agents.mjs                 # loop, every TOPUP_INTERVAL_MIN
 *   node scripts/topup_agents.mjs --dry-run       # report low agents without dripping
 *
 * Env (all optional unless noted):
 *   DATABASE_URL            # Neon/Supabase Postgres (wallets table lives here)
 *   CIRCLE_API_KEY          # dev-controlled-wallets API key (drip auth)
 *   ARC_PUBLIC_RPC_URL      # Arc RPC for balance reads (default public)
 *   TOPUP_MIN_USDC          # drip when balance < this (default 2.0)
 *   TOPUP_INTERVAL_MIN      # loop mode interval in minutes (default 30)
 *   TOPUP_INCLUDE           # extra user_id prefixes to include (comma list)
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, encodeFunctionData, keccak256, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

const USDC_ADDR = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000').trim();
const RPC_URL = (process.env.ARC_PUBLIC_RPC_URL || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const FAUCET_URL = 'https://api.circle.com/v1/faucet/drips';
const BLOCKCHAIN = 'ARC-TESTNET';
// Memo-contract bankroll sends (same as scripts/fund_agents.mjs) so treasury
// fallback transfers stay on the intended accounting path.
const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';

const MIN_USDC = Math.max(0.5, parseFloat(process.env.TOPUP_MIN_USDC || '2') || 2);
const INTERVAL_MS = Math.max(5, parseInt(process.env.TOPUP_INTERVAL_MIN || '30', 10)) * 60_000;
// How much USDC to send per agent when the faucet is rate-limited and we fall
// back to the treasury signer (PRIVATE_KEY).
const FALLBACK_USDC = Math.max(1, parseFloat(process.env.TOPUP_FALLBACK_USDC || '20') || 20);

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY_RUN = args.includes('--dry-run');

// Agent wallet keys live in the `wallets` table as `agent_agent_swarm_<key>`
// (swarm) and `agent_house_pulse` (Pulse). Only named keys → never touch humans.
const KEY_PATTERNS = ['agent_agent_swarm_%', 'agent_house_pulse'];
const EXTRA = (process.env.TOPUP_INCLUDE || '')
  .split(',').map(s => s.trim()).filter(Boolean);
for (const k of EXTRA) KEY_PATTERNS.push(k.includes('%') ? k : `${k}%`);

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '').trim().split('?')[0],
  max: 5,
  ssl: { rejectUnauthorized: false },
});

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY ? process.env.CIRCLE_API_KEY.trim() : undefined,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET ? process.env.CIRCLE_ENTITY_SECRET.trim() : undefined,
});

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = process.env.PRIVATE_KEY
  ? createWalletClient({
      account: privateKeyToAccount(
        process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`
      ),
      chain: arcTestnet,
      transport: http(RPC_URL),
    })
  : null;

const USDC_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
}];

const _addrCache = new Map(); // wallet_id -> address
async function getAddress(walletId) {
  if (_addrCache.has(walletId)) return _addrCache.get(walletId);
  let address = null;
  try {
    const res = await circle.getWallet({ id: walletId });
    address = res.data?.wallet?.address || null;
  } catch (e) {
    console.warn(`[topup] getWallet(${walletId}) failed: ${e.message}`);
    // Fall back to last_balance row so we don't lose the agent entirely.
    try {
      const { rows } = await pool.query('SELECT address FROM wallets WHERE wallet_id=$1', [walletId]);
      address = rows[0]?.address || null;
    } catch (_) {}
  }
  _addrCache.set(walletId, address);
  return address;
}

async function getBalanceUsdc(address) {
  try {
    const b = await publicClient.readContract({
      address: USDC_ADDR, abi: USDC_ABI, functionName: 'balanceOf', args: [address],
    });
    return Number(b) / 1_000_000;
  } catch (e) {
    console.warn(`[topup] balance read failed for ${address}: ${e.message}`);
    return null;
  }
}

async function drip(address) {
  if (DRY_RUN) return { dry: true };
  const res = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${(process.env.CIRCLE_API_KEY || '').trim()}`,
    },
    body: JSON.stringify({ address, blockchain: BLOCKCHAIN, usdc: true, native: false }),
  });
  if (res.status === 204) return { ok: true, status: 204 };
  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, body: text.slice(0, 300) };
}

/// Faucet exhausted (429) → send USDC straight from the treasury signer via
/// the memo contract, same accounting path as scripts/fund_agents.mjs.
async function treasuryDrip(address, key) {
  if (!walletClient) return { ok: false, status: 'no-PRIVATE_KEY' };
  const micro = BigInt(Math.round(FALLBACK_USDC * 1_000_000));
  try {
    const innerData = encodeFunctionData({
      abi: [parseAbiItem('function transfer(address,uint256) returns (bool)')],
      functionName: 'transfer', args: [address, micro],
    });
    const hash = await walletClient.writeContract({
      address: MEMO_CONTRACT,
      abi: [{ name: 'memo', type: 'function', stateMutability: 'nonpayable', inputs: [
        { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
        { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }], outputs: [] }],
      functionName: 'memo',
      args: [USDC_ADDR, innerData, keccak256(toHex(`bankroll:${key}`)),
        stringToHex(JSON.stringify({ kind: 'bankroll', agent: key, usdc: FALLBACK_USDC }))],
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return rc.status === 'success'
      ? { ok: true, status: 200, body: `treasury ${FALLBACK_USDC} USDC (${hash})` }
      : { ok: false, status: 'tx-failed', body: hash };
  } catch (e) {
    return { ok: false, status: 'treasury-error', body: e.message.slice(0, 200) };
  }
}

async function topUpOnce() {
  const { rows } = await pool.query(
    `SELECT user_id, wallet_id FROM wallets
     WHERE ${KEY_PATTERNS.map((_, i) => `user_id LIKE $${i + 1}`).join(' OR ')}
     ORDER BY user_id`,
    KEY_PATTERNS
  );
  if (!rows.length) {
    console.log('[topup] no agent wallets found in DB');
    return;
  }

  const report = [];
  for (const row of rows) {
    const address = await getAddress(row.wallet_id);
    if (!address) { report.push({ key: row.user_id, status: 'no-address' }); continue; }
    const balance = await getBalanceUsdc(address);
    if (balance == null) { report.push({ key: row.user_id, address, status: 'balance-read-failed' }); continue; }
    if (balance < MIN_USDC) {
      const r = await drip(address);
      let action = r.dry ? 'dry-run' : (r.ok ? 'dripped' : `faucet(${r.status})`);
      let note = r.body || '';
      if (!r.dry && !r.ok) {
        const fb = await treasuryDrip(address, row.user_id.replace(/^agent_/, ''));
        if (fb.ok) { action += '+treasury'; note = fb.body; }
        else { action += '+treasury-failed'; note = `${note} | ${fb.status}: ${fb.body}`; }
      }
      report.push({ key: row.user_id, address, balance: +balance.toFixed(2), action, note });
      console.log(`[topup] ${row.user_id} ${address} bal=${balance.toFixed(2)} < ${MIN_USDC} → ${action}${note ? ' ' + note : ''}`);
    } else {
      console.log(`[topup] ${row.user_id} ${address} bal=${balance.toFixed(2)} OK`);
    }
  }
  return report;
}

async function main() {
  console.log(`[topup] start (min=${MIN_USDC} USDC${DRY_RUN ? ', DRY RUN' : ''}) faucet=${FAUCET_URL} rpc=${RPC_URL}`);
  if (!process.env.CIRCLE_API_KEY) console.warn('[topup] WARNING: CIRCLE_API_KEY not set — drips will 401');
  if (!(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL)) console.warn('[topup] WARNING: DATABASE_URL not set — wallet lookup will fail');

  await topUpOnce();

  if (ONCE) {
    await pool.end();
    process.exit(0);
  }

  setInterval(async () => {
    try { await topUpOnce(); } catch (e) { console.error('[topup] cycle error:', e.message); }
  }, INTERVAL_MS).unref?.();
  console.log(`[topup] loop every ${INTERVAL_MS / 60_000} min`);
}

main().catch((e) => { console.error('[topup] fatal:', e.message); process.exit(1); });
