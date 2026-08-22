/**
 * Circle Agent Stack wallet adapter (pilot: swarm agents on Agent Wallets).
 *
 * Agents listed in CIRCLE_AGENT_WALLETS hold their funds in a Circle Agent
 * Wallet — a user-controlled 2-of-2 MPC wallet operated through the Circle
 * CLI — instead of a developer-controlled SCA. Key shares are never exposed
 * to this server: the CLI authenticates as the wallet's custodian (email
 * OTP, non-interactive flow) and signs via Circle.
 *
 * Environment:
 *   CIRCLE_AGENT_WALLETS=vega            comma-separated agent keys on Agent Stack
 *   CIRCLE_AGENT_WALLET_ADDRESS_VEGA=0x… per-key agent wallet address
 *   CIRCLE_AGENT_CHAIN=ARC-TESTNET       chain for all CLI calls
 *   CIRCLE_AGENT_SESSION_B64=…           base64 of profiles/agent/session.json —
 *                                        materialized to disk at boot so the
 *                                        ephemeral Heroku filesystem works.
 *                                        Sessions last ~28 days; refresh by
 *                                        re-running `circle wallet login --testnet`
 *                                        locally and updating the config var.
 *   CIRCLE_CLI_BIN=/path/to/circle       optional binary override (defaults to
 *                                        node_modules/.bin/circle, then PATH)
 *   CIRCLE_CLI_HOME=~/.circle-cli        CLI state dir (session.json lives here)
 *   X402_MARKETS_URL=https://…           paid market-snapshot endpoint used by
 *                                        buyMarketsSnapshot()
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHAIN = (process.env.CIRCLE_AGENT_CHAIN || 'ARC-TESTNET').trim();

function cliBin() {
  if (process.env.CIRCLE_CLI_BIN) return process.env.CIRCLE_CLI_BIN;
  const local = path.join(
    process.cwd(), 'node_modules', '.bin', `circle${process.platform === 'win32' ? '.cmd' : ''}`
  );
  if (fs.existsSync(local)) return local;
  return 'circle';
}

function cliHome() {
  return process.env.CIRCLE_CLI_HOME || path.join(os.homedir(), '.circle-cli');
}

/** 'agent_swarm_vega' → 'vega'; 'vega' → 'vega'; unknown ids pass through. */
export function keyFromUser(userId) {
  const parts = String(userId || '').split('_').filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}

export function isEnabled(key) {
  const list = String(process.env.CIRCLE_AGENT_WALLETS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(String(key || '').toLowerCase());
}

/** Returns the agent key when `userId` belongs to an Agent-Stack agent, else null. */
export function isEnabledForUser(userId) {
  const key = keyFromUser(userId);
  return isEnabled(key) ? key : null;
}

export function addressFor(key) {
  if (!key) return null;
  return String(process.env[`CIRCLE_AGENT_WALLET_ADDRESS_${String(key).toUpperCase()}`] || '').trim() || null;
}

let _sessionReady = false;

/**
 * Materialize the CLI login session onto disk. On servers the filesystem is
 * ephemeral, so the real session ships as CIRCLE_AGENT_SESSION_B64; locally
 * an existing on-disk session (~/.circle-cli) is used as-is.
 */
export function ensureSession({ force = false } = {}) {
  if (_sessionReady && !force) return { ok: true, cached: true };
  const file = path.join(cliHome(), 'profiles', 'agent', 'session.json');
  const b64 = process.env.CIRCLE_AGENT_SESSION_B64;
  if (!b64) {
    _sessionReady = fs.existsSync(file);
    return { ok: _sessionReady, source: 'disk', reason: _sessionReady ? undefined : 'no CIRCLE_AGENT_SESSION_B64 and no existing session file' };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'), { mode: 0o600 });
    _sessionReady = true;
    return { ok: true, source: 'CIRCLE_AGENT_SESSION_B64' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function execCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = cliBin();
    let finalArgs = args.map(String);
    let useShell = false;
    if (process.platform === 'win32') {
      // Windows resolves `circle` through a .cmd shim → cmd.exe required,
      // and args must be quoted by us (spawn does not quote with shell:true).
      useShell = true;
      finalArgs = finalArgs.map((a) => `"${String(a).replace(/"/g, '')}"`);
    }
    const child = spawn(bin, finalArgs, {
      shell: useShell,
      windowsHide: true,
      env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1', CIRCLE_CLI_HOME: cliHome() },
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`circle CLI timed out after ${timeoutMs}ms (${args[0]} ${args[1] || ''})`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`circle CLI spawn failed (${bin}): ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const clean = err.split(/\r?\n/)
          .filter((l) => l && !/punycode|trace-deprec/i.test(l))
          .join(' ').trim();
        return reject(new Error(clean || `circle CLI exited with code ${code}`));
      }
      resolve(out);
    });
  });
}

async function execCliJson(args, opts) {
  const out = await execCli([...args, '--output', 'json'], opts);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`circle CLI returned non-JSON output: ${out.slice(0, 200)}`);
  }
}

/**
 * Execute a smart-contract write from an agent wallet. The CLI waits for
 * confirmation and returns the full receipt synchronously.
 * @returns {Promise<{id:string,state:string,txHash:string|null}>}
 */
export async function executeContract({ signature, params = [], contract, address }) {
  ensureSession();
  if (!signature || !contract || !address) throw new Error('executeContract: signature/contract/address are required');
  // The CLI itself waits ~130s for on-chain confirmation before giving up,
  // so the client-side budget must exceed that.
  const parsed = await execCliJson([
    'wallet', 'execute', signature, ...params.map(String),
    '--contract', contract, '--address', address, '--chain', CHAIN,
  ], { timeoutMs: 200_000 });
  const tx = parsed?.data;
  if (!tx?.id) throw new Error(`wallet execute: unexpected output ${JSON.stringify(parsed).slice(0, 200)}`);
  const state = String(tx.state || '').toUpperCase();
  if (state && !['COMPLETE', 'SUCCESS', 'MINED', 'CONFIRMED'].includes(state)) {
    throw new Error(`wallet execute state=${tx.state} (tx ${tx.id})`);
  }
  return { id: tx.id, state: state || 'COMPLETE', txHash: tx.txHash || null };
}

/**
 * Make a paid HTTP request against an x402 service using the agent wallet
 * (Circle Gateway nanopayment under the hood).
 */
export async function payService(url, address) {
  ensureSession();
  if (!url || !address) throw new Error('payService: url and address are required');
  const parsed = await execCliJson(['services', 'pay', url, '--address', address, '--chain', CHAIN]);
  // Some CLI builds wrap the payload: {"data":{"response":{ok,paid,…}}}
  const payload = parsed?.data?.response || parsed;
  if (!payload?.settled && !payload?.ok) {
    throw new Error(`services pay failed: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return payload;
}

/**
 * Number of transactions Circle has accepted but not yet executed for this
 * wallet. While >0 new submissions may queue behind them, so callers should
 * back off instead of piling up more.
 */
export async function pendingCount(address) {
  ensureSession();
  if (!address) return 0;
  try {
    const parsed = await execCliJson(['transaction', 'list', '--address', address, '--chain', CHAIN]);
    const txs = parsed?.data?.transactions || [];
    return txs.filter((t) => String(t.state || '').toUpperCase() === 'INITIATED').length;
  } catch {
    return -1; // unknown — callers decide whether to proceed
  }
}

/** Parse `circle wallet balance` ASCII/Unicode table → ERC20 USDC amount. */
export function parseBalanceTable(text) {
  let best = NaN;
  for (const line of text.split(/\r?\n/)) {
    // The CLI draws box-drawing borders (│), sometimes mixed with ASCII pipes.
    if (!/[|│]/.test(line)) continue;
    const cells = line.split(/[|│]/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4 || cells[0] !== 'USDC') continue;
    const amount = parseFloat(cells[2]);
    if (!Number.isFinite(amount)) continue;
    // Prefer the ERC20 USDC row (contracts pull that asset); native is gas.
    const isNative = cells[3] === 'true';
    best = isNative ? (Number.isFinite(best) ? best : amount) : amount;
  }
  return best;
}

/** ERC20 USDC balance of an agent wallet (NaN-safe number, 0 on failure). */
export async function usdcBalance(address) {
  ensureSession();
  if (!address) return 0;
  try {
    const parsed = await execCliJson(['wallet', 'balance', '--address', address, '--chain', CHAIN]);
    const rows = parsed?.data?.balances || [];
    let erc20 = NaN, any = NaN;
    for (const t of rows) {
      const sym = String(t?.token?.symbol || t?.token?.name || '').toUpperCase();
      if (sym !== 'USDC') continue;
      const amt = parseFloat(t.amount);
      if (!Number.isFinite(amt)) continue;
      any = Number.isFinite(any) ? any : amt;
      if (t?.token?.isNative === false) erc20 = amt; // contracts pull ERC20 USDC
    }
    return Number.isFinite(erc20) ? erc20 : (Number.isFinite(any) ? any : 0);
  } catch {
    const table = await execCli(['wallet', 'balance', '--address', address, '--chain', CHAIN]);
    const v = parseBalanceTable(table);
    return Number.isFinite(v) ? v : 0;
  }
}

// ── Throttled paid market snapshot ───────────────────────────────────────────
const marketsUrl = () => (process.env.X402_MARKETS_URL || 'https://api.pulsmarket.tech/api/x402/markets').trim();
let _lastSnap = { ts: 0, receipt: null };

/**
 * Buy Puls' live market snapshot via Circle Nanopayments — throttled so a fast
 * agent loop doesn't drain the wallet ($0.01/call by default). Returns the
 * cached receipt when called within the throttle window, or null on failure.
 */
export async function buyMarketsSnapshot(address, { minIntervalMs = 30 * 60 * 1000, quiet = false } = {}) {
  try {
    if (Date.now() - _lastSnap.ts < minIntervalMs) return _lastSnap.receipt;
    const receipt = await payService(marketsUrl(), address);
    _lastSnap = { ts: Date.now(), receipt };
    if (!quiet) {
      console.log(`[agent-wallet] x402 paid ${receipt.paid || '?'} for market snapshot (${receipt.count ?? '?'} markets), settled ${receipt.settled?.tx || '?'}`);
    }
    return receipt;
  } catch (e) {
    console.warn(`[agent-wallet] buyMarketsSnapshot failed: ${e.message}`);
    return null;
  }
}

/** Health/telemetry snapshot. */
export function status() {
  const keys = String(process.env.CIRCLE_AGENT_WALLETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    chain: CHAIN,
    agents: keys.map((k) => ({ key: k, address: addressFor(k), enabled: true })),
    session: _sessionReady ? 'ready' : (process.env.CIRCLE_AGENT_SESSION_B64 ? 'pending-materialize' : 'local-disk'),
  };
}

export default {
  keyFromUser, isEnabled, isEnabledForUser, addressFor,
  ensureSession, executeContract, payService, usdcBalance, buyMarketsSnapshot, status,
};
