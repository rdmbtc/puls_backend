// ── Provision an Agent Wallet on a FRESH Circle account (5-wallet cap) ───────
//
// Circle caps Agent Wallets at 5 PER ACCOUNT. One account = one email = one
// OTP login = 5 slots. When Puls' primary account (ntraid03@gmail.com) is full
// — vega/atlas/nova + 2 retired — provision the next agent on a new email:
//
//   1. `circle wallet login <new-email> --testnet --init`  (paste OTP)
//   2. `circle wallet create --testnet --chain ARC-TESTNET`
//   3. fund from the treasury EOA via viem (PRIVATE_KEY env)
//   4. print ready-to-paste Heroku config lines under a NEW key namespace
//
// Usage:
//   PRIVATE_KEY=<treasury-64-hex> node scripts/provision_agent_wallet.mjs \
//     --email agent2@yourdomain.com --key orion --fund 10 [--skip-login]
//
// The Heroku namespace is per-key (CIRCLE_AGENT_WALLET_ADDRESS_<KEY>), so a
// second account's wallets coexist with the first account's in one app.

import { spawnSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const EMAIL = flag('email');
const KEY = (flag('key') || '').toLowerCase();
const FUND = flag('fund') || '10';
const SKIP_LOGIN = args.includes('--skip-login');

const RPC = process.env.ARC_PUBLIC_RPC_URL || 'https://rpc.testnet.arc.network';
const USDC = '0x3600000000000000000000000000000000000000';

function circle(args_, { timeoutMs = 240_000 } = {}) {
  const bin = process.platform === 'win32'
    ? 'node_modules\\.bin\\circle.cmd'
    : 'node_modules/.bin/circle';
  const res = spawnSync(bin, [...args_, '--output', 'json'], {
    encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32',
    env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1', CIRCLE_CLI_HOME: process.env.CIRCLE_CLI_HOME || undefined },
  });
  const out = (res.stdout || '').trim();
  try { return JSON.parse(out); } catch { return { raw: out, stderr: res.stderr }; }
}

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

if (!KEY || !/^[a-z][a-z0-9_]*$/i.test(KEY)) fail('--key <name> required (becomes CIRCLE_AGENT_WALLET_ADDRESS_<NAME>)');
if (!EMAIL && !SKIP_LOGIN) fail('--email <new-circle-account-email> required (or --skip-login if already logged in)');

// ── Step 1: OTP login on the NEW account ─────────────────────────────────────
if (!SKIP_LOGIN) {
  console.log(`\n── Step 1: login to Circle account ${EMAIL}`);
  console.log('Spawning interactive login — check your inbox for the OTP code.');
  const r = spawnSync(
    process.platform === 'win32' ? 'node_modules\\.bin\\circle.cmd' : 'node_modules/.bin/circle',
    ['wallet', 'login', EMAIL, '--testnet', '--init'],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) fail('login failed — re-run and paste the OTP when prompted');
}

// ── Step 2: create the wallet ────────────────────────────────────────────────
console.log('\n── Step 2: creating Agent Wallet on ARC-TESTNET');
const created = circle(['wallet', 'create', '--testnet', '--chain', 'ARC-TESTNET']);
const address = created?.data?.wallets?.find((w) => w.blockchain === 'ARC-TESTNET')?.address;
if (!address) fail(`wallet create failed: ${JSON.stringify(created).slice(0, 300)}`);
console.log(`✓ wallet ${address}`);

// ── Step 3: fund from treasury ───────────────────────────────────────────────
console.log(`\n── Step 3: funding ${FUND} USDC from treasury`);
const rawKey = (process.env.PRIVATE_KEY || '').trim().replace(/^0x/i, '');
if (!rawKey || rawKey.length < 64) {
  console.warn('⚠ PRIVATE_KEY missing — skip funding here and transfer manually.');
} else {
  const account = privateKeyToAccount(`0x${rawKey}`);
  const client = createPublicClient({ transport: http(RPC, { timeout: 20000 }) });
  const wallet = createWalletClient({ account, transport: http(RPC, { timeout: 20000 }) });
  const hash = await wallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'transfer',
    args: [address, BigInt(Math.round(Number(FUND) * 1_000_000))],
  });
  const rcpt = await client.waitForTransactionReceipt({ hash });
  console.log(`✓ funded (tx ${hash}, status ${rcpt.status})`);
}

// ── Step 4: Heroku config lines ──────────────────────────────────────────────
const K = KEY.toUpperCase();
console.log(`
── Step 4: ready-to-paste Heroku config

  ── CURRENT SCHEME (works today; one shared CLI session) ──

  # add this wallet's address under its own key:
  heroku config:set -a safe-spire-63835 \\
    CIRCLE_AGENT_WALLET_ADDRESS_${K}=${address}

  # then append '${KEY}' to the enabled list (keep existing entries!):
  heroku config:set -a safe-spire-63835 \\
    "CIRCLE_AGENT_WALLETS=vega,atlas,nova,${KEY}"

  ── FUTURE MULTI-ACCOUNT SCHEME (per-key sessions) ──
  // The wrapper will gain per-key session support; print the vars now so
  // this account's material is captured at provisioning time.

  # base64 of THIS account's CLI session (profiles/agent/session.json after
  # step 1) — enables signing for ${EMAIL}'s wallets independently:
  node -e "console.log(require('fs').readFileSync(process.env.USERPROFILE+'/.circle-cli/profiles/agent/session.json').toString('base64'))"
  heroku config:set -a safe-spire-63835 \\
    CIRCLE_AGENT_SESSION_B64_${K}=<paste-base64-above>

  # wallet address under the same per-key namespace:
  heroku config:set -a safe-spire-63835 \\
    CIRCLE_AGENT_WALLET_ADDRESS_${K}=${address}

  Session note: sessions last ~28 days — refresh by re-running step 1 and
  updating CIRCLE_AGENT_SESSION_B64_${K}. See docs/agent-stack.md § Scaling
  past 5 wallets.

Done. Verify with:
  node_modules/.bin/circle wallet balance --address ${address} --chain ARC-TESTNET
`);
