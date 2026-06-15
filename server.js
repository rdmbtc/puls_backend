import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, createWalletClient, http, decodeEventLog, keccak256, toHex, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { x402Paywall, x402Info } from './lib/x402.js';

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

// Real rate limiters (previously no-ops). Tune via env if needed.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GENERAL || '300', 10),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_STRICT || '30', 10),
  message: { error: 'Too many requests for this action. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
// Trading endpoints get a much more generous limit so rapid/fast-buy flows
// are never blocked at current traffic levels (600/min per IP by default).
// This is only a DoS backstop, not a throttle. Tune via RATE_LIMIT_TRADE.
const tradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_TRADE || '600', 10),
  message: { error: 'Too many trade requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const activateMarketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_ACTIVATE || '10', 10),
  message: { error: 'Too many market activations. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
// Behind a reverse proxy (nginx/caddy on the VPS) — trust the first hop so
// express-rate-limit keys on the real client IP instead of the proxy IP.
app.set('trust proxy', 1);

// CORS: lock down to known origins when ALLOWED_ORIGINS is set (comma-separated).
// Falls back to permissive mode when unset so local dev keeps working.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(allowedOrigins.length ? cors({ origin: allowedOrigins }) : cors());
// Capture the raw request body so we can verify Circle's ECDSA webhook
// signature over the exact bytes Circle signed (re-serializing the parsed JSON
// would change key order/whitespace and break verification).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(generalLimiter); // Apply general rate limit globally

// Supabase JWT Authenticate Middleware
const authenticateUser = async (req, res, next) => {
  try {
    let requestedUserId = req.body?.userId || req.query?.userId;
    
    // Check if the request is for an agent-owned wallet (e.g. agent_supabase_UUID)
    if (requestedUserId && requestedUserId.startsWith('agent_')) {
      requestedUserId = requestedUserId.replace('agent_', '');
    }

    // Web3/MetaMask users sign their own transactions on-chain and only need
    // read access here. They are NOT verified (no JWT, no signature), so mark
    // the request as a web3 guest — endpoints that operate Circle wallets must
    // additionally use `requireVerifiedUser` to reject these requests.
    // TODO: replace this with SIWE (signed-message) verification for full write access.
    if (requestedUserId && (requestedUserId.startsWith('0x') || requestedUserId.startsWith('eth_0x'))) {
      req.isWeb3Guest = true;
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    req.user = user;
    
    const expectedUserId = `supabase_${user.id}`;
    if (requestedUserId && requestedUserId !== expectedUserId) {
      console.warn(`[Auth Warning] UserId mismatch. Authenticated: ${expectedUserId}, Requested: ${requestedUserId}`);
      return res.status(403).json({ error: 'Forbidden: User identity mismatch' });
    }
    
    // Force override query and body parameters to the verified userId to eliminate IDOR
    if (req.body) {
      req.body.userId = expectedUserId;
    }
    if (req.query) {
      req.query.userId = expectedUserId;
    }
    
    next();
  } catch (err) {
    console.error('[Auth Error]', err.message);
    res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
};


// Rejects unverified web3 guests (see authenticateUser). Apply to every endpoint
// that operates a Circle developer-controlled wallet or spends server resources
// on behalf of a user identity. External wallets transact directly on-chain and
// record results via /api/trade/save-external (which verifies the tx sender).
const requireVerifiedUser = (req, res, next) => {
  if (req.isWeb3Guest) {
    return res.status(403).json({
      error: 'This action requires a signed-in account. External wallets transact directly on-chain.',
    });
  }
  next();
};

// Admin allowlist for privileged endpoints (comma-separated userIds, e.g. "supabase_<uuid>").
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const requireAdmin = (req, res, next) => {
  const uid = req.body?.userId || req.query?.userId;
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    return res.status(403).json({ error: 'Forbidden: admin only' });
  }
  next();
};

// Sanitize client-supplied prices used for P&L bookkeeping. On-chain events
// (QuickNode webhook) remain the source of truth and reconcile these values.
const clampPrice = (p, fallback = 0.5) => {
  const v = parseFloat(p);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(0.99, Math.max(0.01, v));
};

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY ? process.env.CIRCLE_API_KEY.trim() : undefined,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET ? process.env.CIRCLE_ENTITY_SECRET.trim() : undefined,
});

const supabase = createClient(
  process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : '',
  process.env.SUPABASE_SERVICE_KEY ? process.env.SUPABASE_SERVICE_KEY.trim() : '' // use service_role key (server-side only)
);

const USDC = '0x3600000000000000000000000000000000000000';
let walletSetId = (process.env.WALLET_SET_ID || '').trim();

// Wallet account type for newly created user wallets.
//   SCA = ERC-4337 smart contract account → eligible for Circle Gas Station
//         (gasless). Arc Testnet has a preconfigured Gas Station policy, so new
//         users transact with ZERO balance and we no longer depend on the
//         admin-treasury USDC drip for gas.
//   EOA = legacy externally-owned account (needs gas/USDC funding to transact).
// Existing wallets keep whatever type they were created with — `get-or-create`
// returns the stored wallet untouched, so this only affects brand-new users.
const WALLET_ACCOUNT_TYPE = (process.env.WALLET_ACCOUNT_TYPE || 'SCA').trim().toUpperCase() === 'EOA' ? 'EOA' : 'SCA';
console.log(`[Wallets] New user wallets will be created as ${WALLET_ACCOUNT_TYPE}${WALLET_ACCOUNT_TYPE === 'SCA' ? ' (gasless via Circle Gas Station)' : ' (legacy, requires gas funding)'}`);

const rpcUrl = (process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network').trim();
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(rpcUrl)
});

const adminPrivateKey = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.trim() : null;
const adminAccount = adminPrivateKey ? privateKeyToAccount(adminPrivateKey.startsWith('0x') ? adminPrivateKey : `0x${adminPrivateKey}`) : null;

const walletClient = adminAccount ? createWalletClient({
  account: adminAccount,
  chain: arcTestnet,
  transport: http(rpcUrl)
}) : null;

// Read the admin/treasury USDC balance (in whole USDC). Used by the funding
// guard, /health/deep and the low-balance monitor. Returns null on failure.
async function getTreasuryUsdcBalance() {
  if (!adminAccount) return null;
  try {
    const raw = await publicClient.readContract({
      address: USDC,
      abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [adminAccount.address],
    });
    return Number(raw) / 1_000_000;
  } catch (e) {
    console.warn('[Treasury] balance read failed:', e.message);
    return null;
  }
}

// ── Low-balance alerting ──────────────────────────────────────────────────────
// When the treasury drops below TREASURY_MIN_USDC we log a loud, actionable
// warning and (if ALERT_WEBHOOK_URL is set) POST a message to a Slack-compatible
// incoming webhook so funding never silently dies mid-demo again.
const TREASURY_MIN_USDC = parseFloat(process.env.TREASURY_MIN_USDC || '10');
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || '').trim();
let lastTreasuryAlertAt = 0;
const TREASURY_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // at most one alert / 30 min

async function sendAlert(text) {
  console.warn(`[ALERT] ${text}`);
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[ALERT] webhook post failed:', e.message);
  }
}

async function checkTreasuryBalance() {
  const bal = await getTreasuryUsdcBalance();
  if (bal == null) return;
  if (bal < TREASURY_MIN_USDC && Date.now() - lastTreasuryAlertAt > TREASURY_ALERT_COOLDOWN_MS) {
    lastTreasuryAlertAt = Date.now();
    await sendAlert(
      `Puls treasury ${adminAccount.address} is low: ${bal.toFixed(2)} USDC (< ${TREASURY_MIN_USDC}). ` +
      `New SCA users are gasless, but agent/principal funding and legacy EOA users still need this wallet topped up. ` +
      `Top up via faucet.circle.com (20 USDC/2h) or the Circle Developer Console.`
    );
  }
}

function normalizeTxHash(txHash) {
  if (!txHash || typeof txHash !== 'string') return txHash;
  let clean = txHash.trim();
  if (!clean.startsWith('0x')) return clean;
  const hexPart = clean.slice(2);
  if (hexPart.length < 64) {
    return '0x' + hexPart.padStart(64, '0');
  }
  return clean;
}

const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS || '').trim();

const FACTORY_ABI = [
  {
    name: 'createMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'slug', type: 'string' },
      { name: 'deadline', type: 'uint256' },
      { name: 'b', type: 'uint256' }
    ],
    outputs: [{ name: 'market', type: 'address' }]
  },
  {
    name: 'allMarkets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }]
  }
];

// ── UMA Optimistic Oracle V2 resolution (PR 3) ───────────────────────────────
// When UMA_RESOLUTION=true, newly deployed markets are owned by the
// UMAResolverAdapter and resolved through UMA's Optimistic Oracle V2:
//   1. cron opens a price request after the deadline (anyone could too),
//   2. cron proposes the Polymarket consensus outcome (posting a USDC bond),
//   3. after the liveness window passes undisputed, cron settles → market resolves.
// Markets NOT registered with the adapter (e.g. created before the flag was
// flipped) automatically fall back to the legacy direct-resolve path.
const UMA_RESOLUTION = (process.env.UMA_RESOLUTION || 'false').toLowerCase() === 'true';
const UMA_ADAPTER_ADDRESS = (process.env.UMA_ADAPTER_ADDRESS || '').trim();
const UMA_OOV2_ADDRESS = (process.env.UMA_OOV2_ADDRESS || '').trim();
// bytes32("YES_OR_NO_QUERY")
const UMA_IDENTIFIER = '0x5945535f4f525f4e4f5f51554552590000000000000000000000000000000000';
const UMA_YES_PRICE = 1000000000000000000n; // 1e18
const UMA_NO_PRICE = 0n;
// OOV2 request states
const UMA_STATE = ['Invalid', 'Requested', 'Proposed', 'Expired', 'Disputed', 'Resolved', 'Settled'];

const UMA_ADAPTER_ABI = [
  { name: 'registerMarket', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }, { name: 'question', type: 'string' }], outputs: [] },
  { name: 'requestResolution', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }], outputs: [] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'market', type: 'address' }], outputs: [] },
  { name: 'getResolution', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'market', type: 'address' }],
    outputs: [
      { name: 'registered', type: 'bool' },
      { name: 'requested', type: 'bool' },
      { name: 'settled', type: 'bool' },
      { name: 'requestTimestamp', type: 'uint256' },
      { name: 'ancillaryData', type: 'bytes' },
      { name: 'oracleState', type: 'uint8' }
    ] },
  { name: 'bond', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'liveness', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }
];

const UMA_OOV2_ABI = [
  { name: 'proposePrice', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'requester', type: 'address' },
      { name: 'identifier', type: 'bytes32' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'ancillaryData', type: 'bytes' },
      { name: 'proposedPrice', type: 'int256' }
    ],
    outputs: [{ name: 'totalBond', type: 'uint256' }] }
];

const MARKET_OWNERSHIP_ABI = [
  { name: 'transferOwnership', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }
];

function umaQuestionForSlug(slug) {
  return `Resolve to YES (p2, 1) if the Polymarket market with slug "${slug}" (https://polymarket.com/market/${slug}) resolved YES, otherwise NO (p1, 0). If the market does not exist on Polymarket, resolve per the market title embedded in the slug.`;
}

// Hand a freshly deployed market to the UMA adapter (2-step ownership) and
// register its resolution question. Failure is non-fatal: an unregistered
// market simply stays on the legacy direct-resolve path.
async function registerMarketWithUma(marketAddress, slug) {
  const txTransfer = await walletClient.writeContract({
    address: marketAddress,
    abi: MARKET_OWNERSHIP_ABI,
    functionName: 'transferOwnership',
    args: [UMA_ADAPTER_ADDRESS]
  });
  await publicClient.waitForTransactionReceipt({ hash: txTransfer });

  const txRegister = await walletClient.writeContract({
    address: UMA_ADAPTER_ADDRESS,
    abi: UMA_ADAPTER_ABI,
    functionName: 'registerMarket',
    args: [marketAddress, umaQuestionForSlug(slug)]
  });
  await publicClient.waitForTransactionReceipt({ hash: txRegister });
  console.log(`[UMA] Market ${marketAddress} (${slug}) registered with UMAResolverAdapter`);
}

async function getUmaResolution(marketAddress) {
  const [registered, requested, settled, requestTimestamp, ancillaryData, oracleState] =
    await publicClient.readContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'getResolution',
      args: [marketAddress]
    });
  return { registered, requested, settled, requestTimestamp, ancillaryData, oracleState };
}

async function ensureOoAllowance(minAmount) {
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }] }],
    functionName: 'allowance',
    args: [adminAccount.address, UMA_OOV2_ADDRESS]
  });
  if (BigInt(allowance) >= minAmount) return;
  const MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }] }],
    functionName: 'approve',
    args: [UMA_OOV2_ADDRESS, MAX]
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log('[UMA] Approved OOV2 to pull proposal bonds');
}

// Drive one market through the UMA state machine. Returns:
//   'fallback' – not registered with the adapter → use legacy direct resolve
//   'pending'  – waiting on a future cron tick (proposal/liveness/dispute)
//   'resolved' – market.resolve() executed on-chain via the adapter
async function processUmaMarket(market, outcome) {
  const res = await getUmaResolution(market.contractAddress);
  if (!res.registered) return 'fallback';

  if (!res.requested) {
    console.log(`[UMA] Requesting resolution for ${market.slug} (${market.contractAddress})`);
    const hash = await walletClient.writeContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'requestResolution',
      args: [market.contractAddress]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'pending';
  }

  const state = UMA_STATE[res.oracleState] || 'Invalid';

  if (state === 'Requested') {
    if (outcome === null) {
      console.log(`[UMA] ${market.slug}: request open, waiting for a determinable outcome to propose`);
      return 'pending';
    }
    const bond = await publicClient.readContract({
      address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'bond'
    });
    await ensureOoAllowance(BigInt(bond) * 2n);
    console.log(`[UMA] Proposing ${outcome ? 'YES' : 'NO'} for ${market.slug} (bond ${bond})`);
    const hash = await walletClient.writeContract({
      address: UMA_OOV2_ADDRESS,
      abi: UMA_OOV2_ABI,
      functionName: 'proposePrice',
      args: [UMA_ADAPTER_ADDRESS, UMA_IDENTIFIER, res.requestTimestamp, res.ancillaryData,
        outcome ? UMA_YES_PRICE : UMA_NO_PRICE]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'pending';
  }

  if (state === 'Proposed') {
    console.log(`[UMA] ${market.slug}: proposal in liveness window, waiting`);
    return 'pending';
  }

  if (state === 'Disputed') {
    console.warn(`[UMA] ${market.slug}: proposal DISPUTED — waiting for DVM/oracle decision`);
    return 'pending';
  }

  if (state === 'Expired' || state === 'Resolved') {
    console.log(`[UMA] Settling ${market.slug} (oracle state: ${state})`);
    const hash = await walletClient.writeContract({
      address: UMA_ADAPTER_ADDRESS,
      abi: UMA_ADAPTER_ABI,
      functionName: 'settle',
      args: [market.contractAddress]
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 'resolved';
  }

  if (state === 'Settled') {
    // Oracle settled but market may have resolved already (or settle() raced).
    return res.settled ? 'resolved' : 'pending';
  }

  return 'pending';
}

// ── Cache of Deployed Markets ────────────────────────────────────────────────
const deployedMarketsCache = new Map(); // slug -> { contractAddress, deadline, resolved, outcome }
const contractToSlugCache = new Map(); // contractAddress -> slug

const MARKET_EVENTS_ABI = [
  {
    anonymous: false,
    name: 'Bought',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'side', type: 'bool' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'shares', type: 'uint256' }
    ]
  },
  {
    anonymous: false,
    name: 'Sold',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'side', type: 'bool' },
      { indexed: false, name: 'shares', type: 'uint256' },
      { indexed: false, name: 'usdcOut', type: 'uint256' }
    ]
  },
  {
    anonymous: false,
    name: 'Resolved',
    type: 'event',
    inputs: [
      { indexed: false, name: 'outcome', type: 'bool' }
    ]
  },
  {
    anonymous: false,
    name: 'Claimed',
    type: 'event',
    inputs: [
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'payout', type: 'uint256' }
    ]
  }
];

// ── Cache of User Wallets ──────────────────────────────────────────────────
const addressToUserIdCache = new Map(); // address (lowercase) -> userId
const userIdToAddressCache = new Map(); // userId -> address (lowercase)

async function loadWalletAddressMapping() {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .select('user_id, wallet_id');
    if (error) {
      console.error('Failed to load wallets for address mapping:', error.message);
      return;
    }
    console.log(`Loading wallet addresses for ${data.length} wallets...`);
    for (const row of data) {
      try {
        const walletId = row.wallet_id;
        const userId = row.user_id;
        
        let address = walletAddressCache.get(walletId);
        if (!address) {
          const walletRes = await circle.getWallet({ id: walletId });
          address = walletRes.data.wallet.address;
          walletAddressCache.set(walletId, address);
        }
        
        const lowerAddress = address.toLowerCase();
        addressToUserIdCache.set(lowerAddress, userId);
        userIdToAddressCache.set(userId, lowerAddress);
      } catch (err) {
        console.error(`Failed to fetch wallet address for user ${row.user_id}:`, err.message);
      }
    }
    console.log(`Loaded ${addressToUserIdCache.size} wallet address mappings.`);
  } catch (e) {
    console.error('loadWalletAddressMapping error:', e.message);
  }
}

async function loadDeployedMarkets() {
  try {
    const { data, error } = await supabase
      .from('deployed_markets')
      .select('*');
    if (error) {
      console.error('Failed to load deployed_markets from Supabase:', error.message);
      return;
    }
    let archivedCount = 0;
    for (const row of (data || [])) {
      if (row.archived === true) { archivedCount++; continue; } // zombies stay out of cache, cron and listings
      const entry = {
        contractAddress: row.contract_address,
        deadline: Number(row.deadline),
        resolved: row.resolved,
        outcome: row.outcome
      };
      deployedMarketsCache.set(row.slug, entry);
      contractToSlugCache.set(row.contract_address.toLowerCase(), row.slug);
    }
    if (archivedCount) console.log(`Skipped ${archivedCount} archived markets.`);
    console.log(`Loaded ${deployedMarketsCache.size} deployed markets into cache.`);
  } catch (e) {
    console.error('loadDeployedMarkets error:', e.message);
  }
}

// Prevent duplicate concurrent deployments
const pendingDeployments = new Map();
let deploymentQueue = Promise.resolve();

async function _executeMarketDeployment(slug, deadlineSeconds) {
  let cached = deployedMarketsCache.get(slug);
  if (cached) return cached.contractAddress;

  if (!FACTORY_ADDRESS) throw new Error('FACTORY_ADDRESS not set in backend');
  if (!walletClient || !adminAccount) throw new Error('Admin wallet credentials not configured');

  console.log(`Dynamic deployment triggered for slug: ${slug}, deadline: ${deadlineSeconds}`);
  const b = 10_000_000; // b = 10 USDC
  const initialCost = BigInt(Math.round(b * Math.log(2))); // ~6,931,471

  // Check current allowance first to avoid redundant approvals and race conditions
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{
      name: 'allowance',
      type: 'function',
      stateMutability: 'view',
      inputs: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' }
      ],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'allowance',
    args: [adminAccount.address, FACTORY_ADDRESS]
  });

  if (BigInt(allowance) < initialCost) {
    console.log(`Current factory allowance is ${allowance}, less than required ${initialCost}. Approving MaxUint256...`);
    const MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const approveHash = await walletClient.writeContract({
      address: USDC,
      abi: [{
        name: 'approve',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' }
        ],
        outputs: [{ name: '', type: 'bool' }]
      }],
      functionName: 'approve',
      args: [FACTORY_ADDRESS, MAX]
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`✅ Approved factory for MaxUint256 USDC`);
  }

  // Check deployer USDC balance before attempting deployment
  const deployerBalance = await publicClient.readContract({
    address: USDC,
    abi: [{
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }]
    }],
    functionName: 'balanceOf',
    args: [adminAccount.address]
  });
  if (BigInt(deployerBalance) < initialCost) {
    console.warn(`⚠️  Deployer USDC balance (${deployerBalance}) < required (${initialCost}) — skipping deployment for ${slug}`);
    throw new Error(`Deployer has insufficient USDC (${deployerBalance} < ${initialCost}) to deploy market ${slug}`);
  }

  const { request } = await publicClient.simulateContract({
    account: adminAccount,
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'createMarket',
    args: [slug, BigInt(deadlineSeconds), BigInt(b)]
  });

  const hash = await walletClient.writeContract(request);
  console.log(`Deploy Tx Hash: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash });

  const allM = await publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'allMarkets'
  });
  
  const deployedAddress = allM[allM.length - 1];
  if (!deployedAddress) throw new Error('Failed to retrieve deployed market address from factory');

  console.log(`✅ Successfully deployed LMSRMarket at ${deployedAddress} for slug ${slug}`);

  if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
    try {
      await registerMarketWithUma(deployedAddress, slug);
    } catch (e) {
      // Non-fatal: an unregistered market stays on the legacy direct-resolve path.
      console.error(`[UMA] Failed to register ${slug} with adapter (legacy resolution will apply):`, e.message);
    }
  }

  await supabase.from('deployed_markets').upsert({
    slug,
    contract_address: deployedAddress,
    deadline: deadlineSeconds,
    resolved: false
  });

  const entry = {
    contractAddress: deployedAddress,
    deadline: deadlineSeconds,
    resolved: false,
    outcome: null
  };
  deployedMarketsCache.set(slug, entry);
  contractToSlugCache.set(deployedAddress.toLowerCase(), slug);

  return deployedAddress;
}

async function getOrDeployMarket(slug, deadlineSeconds) {
  if (!slug) throw new Error('slug is required');
  
  let cached = deployedMarketsCache.get(slug);
  if (cached) return cached.contractAddress;

  // Guard: never try to deploy a market whose deadline already passed — the
  // factory reverts with "Deadline in past", wasting an RPC round-trip and
  // spamming the error log. Require at least 5 minutes of remaining lifetime.
  const nowSec = Math.floor(Date.now() / 1000);
  if (!deadlineSeconds || Number(deadlineSeconds) <= nowSec + 300) {
    throw new Error(`Market ${slug} deadline ${deadlineSeconds} is in the past (or <5min away) — skipping deployment`);
  }

  if (pendingDeployments.has(slug)) {
    return pendingDeployments.get(slug);
  }

  const promise = new Promise((resolve, reject) => {
    deploymentQueue = deploymentQueue.then(async () => {
      try {
        const addr = await _executeMarketDeployment(slug, deadlineSeconds);
        resolve(addr);
      } catch (err) {
        reject(err);
      }
    }).catch((err) => {
      console.error(`Queue execution failed:`, err.message);
    });
  });

  pendingDeployments.set(slug, promise);
  
  promise.finally(() => {
    pendingDeployments.delete(slug);
  });

  return promise;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getWalletId(userId) {
  const { data } = await supabase
    .from('wallets')
    .select('wallet_id')
    .eq('user_id', userId)
    .single();
  return data?.wallet_id ?? null;
}

async function saveWallet(userId, walletId) {
  await supabase.from('wallets').upsert({ user_id: userId, wallet_id: walletId });
}

async function isApproved(walletId, contractAddress) {
  try {
    const info = await getWalletInfo(walletId);
    if (!info || !info.address) return false;

    const allowance = await publicClient.readContract({
      address: USDC,
      abi: [{
        name: 'allowance',
        type: 'function',
        stateMutability: 'view',
        inputs: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' }
        ],
        outputs: [{ name: '', type: 'uint256' }]
      }],
      functionName: 'allowance',
      args: [info.address, contractAddress]
    });

    return BigInt(allowance) >= BigInt(1_000_000_000_000);
  } catch (e) {
    console.error('Check allowance failed:', e.message);
    return false;
  }
}

async function saveTrade(userId, trade) {
  const { data } = await supabase.from('trades').insert({ user_id: userId, ...trade }).select().single();
  if (data && data.state === 'COMPLETE') {
    broadcastTrade(data);
  }
}

async function syncCompletedTrade(userId, { marketId, side, amountUsdc, shares, txHash, question, entryPrice }) {
  try {
    txHash = normalizeTxHash(txHash);
    const { data: existing, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('market_id', marketId)
      .eq('side', side)
      .eq('state', 'INITIATED')
      .order('created_at', { ascending: false })
      .limit(1);

    const amount = Math.abs(amountUsdc);

    if (error) {
      console.error('Error fetching existing trade for sync:', error.message);
    }

    if (existing && existing.length > 0) {
      const trade = existing[0];
      const { data: updatedTrade } = await supabase
        .from('trades')
        .update({
          state: 'COMPLETE',
          tx_hash: txHash,
          usdc_amount: amountUsdc,
        })
        .eq('id', trade.id)
        .select()
        .single();
      
      if (updatedTrade) {
        broadcastTrade(updatedTrade);
      }
      
      console.log(`[QuickNode Webhook] Synced initiated trade ID ${trade.id} to COMPLETE`);
      createNotification(
        userId,
        'Trade Confirmed ⚡',
        `Successfully ${amountUsdc > 0 ? 'bought' : 'sold'} $${amount.toFixed(2)} of ${side} shares for "${question}"`,
        'trade'
      ).catch(console.error);
    } else {
      const { data: dup } = await supabase
        .from('trades')
        .select('*')
        .eq('tx_hash', txHash)
        .limit(1);
      
      if (dup && dup.length > 0) {
        const existingTrade = dup[0];
        if (existingTrade.usdc_amount !== amountUsdc) {
          const { data: updatedTrade } = await supabase
            .from('trades')
            .update({ usdc_amount: amountUsdc })
            .eq('id', existingTrade.id)
            .select()
            .single();
          
          if (updatedTrade) {
            broadcastTrade(updatedTrade);
          }
          console.log(`[QuickNode Webhook] Updated existing trade ${existingTrade.id} with correct on-chain usdc_amount: ${amountUsdc}`);
        }
        return;
      }

      const { data: newTrade } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: `ext_${Date.now()}`,
          side,
          usdc_amount: amountUsdc,
          entry_price: entryPrice !== undefined ? entryPrice : (shares !== 0 ? Math.min(0.99, Math.max(0.01, Math.abs(amountUsdc / shares))) : 0.5),
          question: question || 'Prediction Market',
          market_id: marketId,
          state: 'COMPLETE',
          tx_hash: txHash,
        })
        .select()
        .single();
        
      if (newTrade) {
        broadcastTrade(newTrade);
      }
      
      console.log(`[QuickNode Webhook] Inserted new completed trade for tx ${txHash}`);
      createNotification(
        userId,
        'Trade Confirmed ⚡',
        `Successfully ${amountUsdc > 0 ? 'bought' : 'sold'} $${amount.toFixed(2)} of ${side} shares for "${question || 'Prediction Market'}"`,
        'trade'
      ).catch(console.error);
    }
  } catch (err) {
    console.error('Error syncing completed trade:', err.message);
  }
}

async function getTrades(userId) {
  const { data } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  return data ?? [];
}

// ── Wallet ────────────────────────────────────────────────────────────────────

async function ensureWalletSet() {
  if (walletSetId) return walletSetId;
  const res = await circle.createWalletSet({ name: 'Puls Users' });
  walletSetId = res.data.walletSet.id;
  console.log('Created wallet set:', walletSetId);
  return walletSetId;
}

const walletAddressCache = new Map();

async function getWalletInfo(walletId) {
  try {
    let address = walletAddressCache.get(walletId);
    if (!address) {
      const walletRes = await circle.getWallet({ id: walletId });
      address = walletRes.data.wallet.address;
      walletAddressCache.set(walletId, address);
    }

    let balance = '0.00';
    try {
      const balanceRaw = await publicClient.readContract({
        address: USDC,
        abi: [{
          name: 'balanceOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }]
        }],
        functionName: 'balanceOf',
        args: [address]
      });
      balance = (Number(balanceRaw) / 1_000_000).toFixed(2);
    } catch (err) {
      console.warn(`On-chain balance check failed for ${address}:`, err.message);
      try {
        const balRes = await circle.getWalletTokenBalance({ id: walletId });
        const usdcToken = balRes.data.tokenBalances?.find(
          t => t.token?.address?.toLowerCase() === USDC.toLowerCase() || t.token?.symbol === 'USDC'
        );
        balance = parseFloat(usdcToken?.amount ?? '0').toFixed(2);
      } catch (_) {}
    }

    return { walletId, address, usdcBalance: balance };
  } catch (e) {
    console.error('getWalletInfo error:', e.message);
    return { walletId, address: '', usdcBalance: '0.00' };
  }
}

// In-memory RPC cache
const rpcCache = new Map(); // requestHash -> { data, ts }
const RPC_CACHE_TTL = 3000; // 3 seconds TTL

// Allowed RPC methods to prevent open relay abuse
const ALLOWED_RPC_METHODS = [
  'eth_call',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_chainId',
  'net_version'
];

// RPC Proxy rate limiter (max 120 requests per minute per IP)
const rpcProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many RPC requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// POST /api/rpc-proxy
app.post('/api/rpc-proxy', rpcProxyLimiter, async (req, res) => {
  try {
    const { method, params, id, jsonrpc } = req.body;
    if (!method) {
      return res.status(400).json({ error: 'method required' });
    }

    // Method safety check
    if (!ALLOWED_RPC_METHODS.includes(method)) {
      console.warn(`[RPC Proxy Blocked] Unauthorized method: ${method}`);
      return res.status(403).json({ error: `Forbidden RPC method: ${method}` });
    }

    const isCacheable = method === 'eth_call';
    const cacheKey = isCacheable ? JSON.stringify({ method, params }) : null;

    if (isCacheable) {
      const cached = rpcCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < RPC_CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method,
        params,
        id: id || 1,
        jsonrpc: jsonrpc || '2.0',
      }),
    });

    const data = await response.json();

    if (isCacheable && data && !data.error) {
      rpcCache.set(cacheKey, { data, ts: Date.now() });
    }

    res.json(data);
  } catch (err) {
    console.error('RPC Proxy error:', err.message);
    res.status(500).json({ error: 'RPC proxy failed', details: err.message });
  }
});

// POST /api/wallet/get-or-create
app.post('/api/wallet/get-or-create', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const existing = await getWalletId(userId);
    if (existing) return res.json(await getWalletInfo(existing));

    const setId = await ensureWalletSet();
    const createRes = await circle.createWallets({
      accountType: WALLET_ACCOUNT_TYPE, // SCA → gasless via Gas Station (see WALLET_ACCOUNT_TYPE)
      blockchains: ['ARC-TESTNET'],
      count: 1,
      walletSetId: setId,
    });

    const wallet = createRes.data.wallets[0];
    await saveWallet(userId, wallet.id);
    console.log(`Created wallet for ${userId}: ${wallet.address}`);
    
    // Cache the address mapping
    if (wallet.address) {
      const lowerAddress = wallet.address.toLowerCase();
      addressToUserIdCache.set(lowerAddress, userId);
      userIdToAddressCache.set(userId, lowerAddress);
      walletAddressCache.set(wallet.id, wallet.address);
    }
    
    res.json(await getWalletInfo(wallet.id));
  } catch (e) {
    console.error('get-or-create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wallet/balance
app.get('/api/wallet/balance', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    let userAddress = null;
    if (userId.startsWith('0x')) {
      userAddress = userId;
    } else if (userId.startsWith('eth_0x')) {
      userAddress = userId.replace('eth_', '');
    }

    if (userAddress) {
      let balance = '0.00';
      try {
        const balanceRaw = await publicClient.readContract({
          address: USDC,
          abi: [{
            name: 'balanceOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }]
          }],
          functionName: 'balanceOf',
          args: [userAddress]
        });
        balance = (Number(balanceRaw) / 1_000_000).toFixed(2);
      } catch (err) {
        console.warn(`On-chain balance check failed for external wallet ${userAddress}:`, err.message);
      }
      return res.json({ usdcBalance: balance });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(404).json({ error: 'Wallet not found' });
    const info = await getWalletInfo(walletId);
    res.json({ usdcBalance: info.usdcBalance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/wallet/export
app.get('/api/wallet/export', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.query;
    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(404).json({ error: 'Wallet not found' });
    const info = await getWalletInfo(walletId);
    res.json({
      ...info,
      network: 'Arc Testnet',
      chainId: 5042002,
      rpc: rpcUrl,
      explorer: `https://testnet.arcscan.app/address/${info.address}`,
      note: 'Circle MPC wallet. Private key managed by Circle.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/markets ──────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  try {
    const limit = req.query.limit || 50;
    const offset = req.query.offset || 0;
    
    // Fetch custom user-created markets from database
    const { data: dbCustomMarkets, error: customErr } = await supabase
      .from('deployed_markets')
      .select('*')
      .eq('is_user_created', true);

    const customList = [];
    if (!customErr && dbCustomMarkets) {
      for (const row of dbCustomMarkets) {
        if (row.archived === true) continue;
        const slug = row.slug;
        const contractAddress = row.contract_address;
        
        let yesPrice = 0.5, noPrice = 0.5, poolYes = 0, poolNo = 0, totalVolume = 0;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: contractAddress,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          yesPrice = expYes / (expYes + expNo);
          noPrice = expNo / (expYes + expNo);
          totalVolume = poolYes + poolNo;
        } catch (err) {
          console.error(`Error reading custom market ${contractAddress} on-chain:`, err.message);
        }

        customList.push({
          id: slug,
          slug,
          contractAddress,
          question: row.title || slug,
          description: row.description || '',
          category: row.category || 'General',
          yesPrice: parseFloat(yesPrice.toFixed(4)),
          noPrice: parseFloat(noPrice.toFixed(4)),
          poolYes,
          poolNo,
          resolved: row.resolved,
          outcome: row.outcome,
          totalVolume,
          image: row.image_url || `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`,
          endDateIso: new Date(Number(row.deadline) * 1000).toISOString(),
          outcomePrices: JSON.stringify([yesPrice.toString(), noPrice.toString()]),
          featured: false
        });
      }
    }

    const pmUrl = `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false&order=volume&ascending=false&offset=${offset}`;
    const pmRes = await fetch(pmUrl, { headers: { 'Accept': 'application/json' } });
    
    let list = [];
    if (pmRes.ok) {
      list = await pmRes.json();
    } else {
      console.warn('Failed to fetch from Polymarket, returning custom markets only.');
    }
    
    const pmMergedList = await Promise.all(list.map(async (j) => {
      const slug = j.slug;
      const cached = deployedMarketsCache.get(slug);
      
      let contractAddress = null;
      let poolYes = null;
      let poolNo = null;
      let resolved = false;
      let outcome = null;
      let yesPrice = null;
      let noPrice = null;
      let totalVolume = null;

      if (cached) {
        contractAddress = cached.contractAddress;
        resolved = cached.resolved;
        outcome = cached.outcome;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: contractAddress,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          yesPrice = expYes / (expYes + expNo);
          noPrice = expNo / (expYes + expNo);
          totalVolume = poolYes + poolNo;
        } catch (err) {
          console.error(`Error reading on-chain market ${contractAddress}:`, err.message);
        }
      }

      let currentPrices = [0.5, 0.5];
      try {
        const rawPrices = j.outcomePrices || '["0.5","0.5"]';
        currentPrices = JSON.parse(rawPrices).map(p => parseFloat(p) || 0.5);
      } catch {}

      return {
        ...j,
        contractAddress,
        yesPrice: yesPrice !== null ? parseFloat(yesPrice.toFixed(4)) : currentPrices[0],
        noPrice: noPrice !== null ? parseFloat(noPrice.toFixed(4)) : currentPrices[1],
        poolYes,
        poolNo,
        resolved,
        outcome,
        totalVolume
      };
    }));

    const mergedList = [...customList, ...pmMergedList];

    // Sort: deployed (pre-warmed) markets first for instant trades
    mergedList.sort((a, b) => {
      const aDep = a.contractAddress ? 1 : 0;
      const bDep = b.contractAddress ? 1 : 0;
      return bDep - aDep;
    });

    res.json(mergedList);
  } catch (e) {
    console.error('/api/markets error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/activate
app.post('/api/market/activate', activateMarketLimiter, async (req, res) => {
  try {
    const { slug, deadline } = req.body;
    if (!slug || !deadline) {
      return res.status(400).json({ error: 'slug and deadline required' });
    }

    // Verify the slug exists and is active on Polymarket
    try {
      const pmUrl = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
      const pmRes = await fetch(pmUrl, { headers: { 'Accept': 'application/json' } });
      if (!pmRes.ok) {
        console.warn(`[Activate Warning] Polymarket status ${pmRes.status} check failed, skipping verify.`);
      } else {
        const data = await pmRes.json();
        if (!data || data.length === 0) {
          return res.status(400).json({ error: 'Invalid market slug: Not found on Polymarket' });
        }
        const pmMarket = data[0];
        if (pmMarket.closed || pmMarket.resolved) {
          return res.status(400).json({ error: 'Invalid market slug: Market is closed or resolved' });
        }
      }
    } catch (err) {
      console.warn(`[Activate Warning] Polymarket verification failed: ${err.message}. Proceeding anyway.`);
    }

    const contractAddress = await getOrDeployMarket(slug, deadline);
    res.json({ contractAddress });
  } catch (e) {
    console.error('activate market error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/info
app.get('/api/market/info', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    
    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(404).json({ error: 'Market not deployed' });
    const contractAddress = cached.contractAddress;
    
    const [slugOnChain, deadline, resolved, outcome, yesOutstanding, noOutstanding] = await publicClient.readContract({
      address: contractAddress,
      abi: [
        {
          name: 'getMarketInfo',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [
            { name: '_slug', type: 'string' },
            { name: '_deadline', type: 'uint256' },
            { name: '_resolved', type: 'bool' },
            { name: '_outcome', type: 'bool' },
            { name: '_yesOutstanding', type: 'uint256' },
            { name: '_noOutstanding', type: 'uint256' }
          ]
        }
      ],
      functionName: 'getMarketInfo'
    });

    const poolYesVal = Number(yesOutstanding) / 1_000_000;
    const poolNoVal = Number(noOutstanding) / 1_000_000;
    
    const bVal = 10;
    const maxQ = Math.max(poolYesVal, poolNoVal);
    const expYes = Math.exp((poolYesVal - maxQ) / bVal);
    const expNo = Math.exp((poolNoVal - maxQ) / bVal);
    const yesPrice = expYes / (expYes + expNo);
    const noPrice = expNo / (expYes + expNo);
    const totalPool = poolYesVal + poolNoVal;

    res.json({
      contractAddress,
      question: slug,
      deadline: Number(deadline),
      resolved,
      outcome,
      poolYes: poolYesVal,
      poolNo: poolNoVal,
      yesPrice: parseFloat(yesPrice.toFixed(4)),
      noPrice: parseFloat(noPrice.toFixed(4)),
      totalVolume: totalPool
    });
  } catch (e) {
    console.error('getMarketInfo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Resolution transparency (PR 4) ────────────────────────────────────────────
// GET /api/market/resolution-status?slug=...
// Tells the app HOW a market resolves: legacy Polymarket-consensus direct
// resolve, or UMA Optimistic Oracle (with live request state + dispute window).
app.get('/api/market/resolution-status', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(404).json({ error: 'Market not deployed' });

    const base = {
      contractAddress: cached.contractAddress,
      deadline: cached.deadline,
      resolved: !!cached.resolved,
      outcome: cached.outcome ?? null,
      explorerUrl: `https://testnet.arcscan.app/address/${cached.contractAddress}`,
    };

    if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
      try {
        const r = await getUmaResolution(cached.contractAddress);
        if (r.registered) {
          const [bond, liveness] = await Promise.all([
            publicClient.readContract({ address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'bond' }),
            publicClient.readContract({ address: UMA_ADAPTER_ADDRESS, abi: UMA_ADAPTER_ABI, functionName: 'liveness' }),
          ]);
          return res.json({
            ...base,
            mode: 'uma',
            oracle: {
              adapterAddress: UMA_ADAPTER_ADDRESS,
              oracleAddress: UMA_OOV2_ADDRESS,
              identifier: 'YES_OR_NO_QUERY',
              state: UMA_STATE[r.oracleState] || 'Invalid',
              requested: r.requested,
              settled: r.settled,
              requestTimestamp: Number(r.requestTimestamp),
              livenessSeconds: Number(liveness),
              bondUsdc: Number(bond) / 1_000_000,
              adapterExplorerUrl: `https://testnet.arcscan.app/address/${UMA_ADAPTER_ADDRESS}`,
              oracleExplorerUrl: `https://testnet.arcscan.app/address/${UMA_OOV2_ADDRESS}`,
            },
          });
        }
      } catch (e) {
        console.error('resolution-status UMA read failed:', e.message);
      }
    }

    return res.json({ ...base, mode: 'direct' });
  } catch (e) {
    console.error('resolution-status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Price history (PR 4) ─────────────────────────────────────────────────────
// GET /api/market/price-history?slug=...&hours=168
// Returns the YES-price series implied by completed trades on this market
// (entry_price is recorded per trade), oldest first.
app.get('/api/market/price-history', async (req, res) => {
  try {
    const { slug } = req.query;
    const hours = Math.min(Math.max(parseInt(req.query.hours || '168', 10) || 168, 1), 24 * 90);
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(404).json({ error: 'Market not deployed' });

    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('trades')
      .select('side, entry_price, usdc_amount, created_at, state')
      .eq('market_id', cached.contractAddress)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(2000);
    if (error) throw error;

    const points = (data || [])
      .filter((t) => t.state === 'COMPLETE' && t.entry_price != null)
      .map((t) => {
        const p = parseFloat(t.entry_price);
        // entry_price is stored for the traded side; normalize to YES price.
        const yesPrice = t.side === 'NO' ? 1 - p : p;
        return {
          t: Math.floor(new Date(t.created_at).getTime() / 1000),
          yesPrice: Math.min(Math.max(yesPrice, 0), 1),
          volume: parseFloat(t.usdc_amount) || 0,
        };
      });

    res.json({ slug, contractAddress: cached.contractAddress, hours, points });
  } catch (e) {
    console.error('price-history error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Trade ─────────────────────────────────────────────────────────────────────

app.post('/api/trade/buy', authenticateUser, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, side, usdcAmount, question, slug, deadline } = req.body;
    if (!userId || !side || !usdcAmount || !slug || !deadline) return res.status(400).json({ error: 'Missing fields' });

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'No wallet' });

    const contractAddress = await getOrDeployMarket(slug, deadline);

    const isYes = side === 'YES';
    const amount = parseFloat(usdcAmount);
    const amountMicro = Math.round(amount * 1_000_000).toString();

    const info = await getWalletInfo(walletId);
    if (parseFloat(info.usdcBalance) < amount) {
      return res.status(400).json({
        error: `Insufficient USDC. Balance: $${info.usdcBalance}, Need: $${amount.toFixed(2)}.`,
      });
    }

    if (!(await isApproved(walletId, contractAddress))) {
      const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      try {
        const approveRes = await circle.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC,
          abiFunctionSignature: 'approve(address,uint256)',
          abiParameters: [contractAddress, MAX],
          fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        // Poll the approval tx instead of a fixed sleep — slow approvals used
        // to make the follow-up buy revert with "transfer amount exceeds allowance".
        const approveTxId = approveRes.data?.id;
        for (let i = 0; approveTxId && i < 20; i++) {
          const s = (await circle.getTransaction({ id: approveTxId })).data?.transaction?.state;
          if (s === 'COMPLETE' || s === 'CONFIRMED') break;
          if (s === 'FAILED' || s === 'DENIED' || s === 'CANCELLED') {
            throw new Error('USDC approval transaction failed');
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
        console.error('approve error:', e.message);
      }
    }

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: isYes ? 'buyYes(uint256)' : 'buyNo(uint256)',
      abiParameters: [amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = txRes.data.id;

    await saveTrade(userId, {
      tx_id: txId,
      side,
      usdc_amount: amount,
      entry_price: clampPrice(req.body.entryPrice),
      question: question || 'Prediction Market',
      market_id: contractAddress,
      state: 'INITIATED',
    });

    res.json({ txId, state: txRes.data.state, side, balance: info.usdcBalance });
  } catch (e) {
    console.error('trade buy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/sell', authenticateUser, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, side, shares, question, slug, contractAddress: reqContract, owner } = req.body;
    if (!userId || !side || !shares) return res.status(400).json({ error: 'Missing fields' });

    // Agent-bought positions are held by the user's AI-agent wallet, so the sell
    // must execute from that wallet (the user wallet holds none of those shares).
    // The agent wallet is derived from the authenticated userId — no cross-user risk.
    const isAgentPosition = owner === 'agent';
    const walletOwnerId = isAgentPosition ? `agent_${userId}` : userId;
    const walletId = await getWalletId(walletOwnerId);
    if (!walletId) return res.status(400).json({ error: isAgentPosition ? 'No agent wallet' : 'No wallet' });

    // Prefer the position's own contract; fall back to slug -> cache.
    let contractAddress = (reqContract && /^0x[0-9a-fA-F]{40}$/.test(reqContract)) ? reqContract : null;
    if (!contractAddress) {
      const cached = slug ? deployedMarketsCache.get(slug) : null;
      if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
      contractAddress = cached.contractAddress;
    }

    const isYes = side === 'YES';
    const sharesAmount = parseFloat(shares);
    const sharesMicro = Math.round(sharesAmount * 1_000_000).toString();

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: isYes ? 'sellYes(uint256)' : 'sellNo(uint256)',
      abiParameters: [sharesMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = txRes.data.id;

    const estimatedPayout = sharesAmount * clampPrice(req.body.entryPrice);
    await saveTrade(userId, {
      tx_id: txId,
      side,
      usdc_amount: -estimatedPayout,
      entry_price: clampPrice(req.body.entryPrice),
      question: question || 'Prediction Market',
      market_id: contractAddress,
      state: 'INITIATED',
    });

    res.json({ txId, state: txRes.data.state, side });
  } catch (e) {
    console.error('sell trade error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/claim', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, slug, contractAddress: reqContract } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing fields' });

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'No wallet' });

    // Prefer the position's own contract; fall back to slug -> cache.
    let contractAddress = (reqContract && /^0x[0-9a-fA-F]{40}$/.test(reqContract)) ? reqContract : null;
    if (!contractAddress) {
      const cached = slug ? deployedMarketsCache.get(slug) : null;
      if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
      contractAddress = cached.contractAddress;
    }

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: 'claim()',
      abiParameters: [],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    res.json({ txId: txRes.data.id, state: txRes.data.state });
  } catch (e) {
    console.error('claim error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trade/status', async (req, res) => {
  try {
    let { txId } = req.query;
    if (!txId) return res.status(400).json({ error: 'txId required' });

    if (txId.startsWith('0x')) {
      txId = normalizeTxHash(txId);
      // External browser wallet transaction hash
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txId });
        if (receipt) {
          const state = receipt.status === 'success' ? 'COMPLETE' : 'FAILED';
          return res.json({ txId, state, txHash: txId });
        }
      } catch (err) {
        // Receipt not found yet (still pending/mining)
        return res.json({ txId, state: 'INITIATED', txHash: txId });
      }
      return res.json({ txId, state: 'INITIATED', txHash: txId });
    }

    const txRes = await circle.getTransaction({ id: txId });
    const tx = txRes.data.transaction;
    // Persist the latest state to the trades row BEFORE responding, so that the
    // portfolio reload the client fires on COMPLETE already sees the final state
    // (previously the row stayed INITIATED until a later background sync, which
    // made positions show "Pending" until a full page reload).
    if (tx.state && tx.state !== 'INITIATED') {
      try {
        const upd = { state: tx.state };
        if (tx.txHash) upd.tx_hash = tx.txHash;
        await supabase.from('trades').update(upd).eq('tx_id', txId);
      } catch (err) {
        console.error('trade/status row sync failed:', err.message);
      }
    }
    res.json({ txId: txRes.data.id, state: tx.state, txHash: tx.txHash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trade/save-external', tradeLimiter, async (req, res) => {
  try {
    let { userId, side, usdcAmount, entryPrice, question, txHash, marketId } = req.body;
    if (!userId || !side || !usdcAmount || !entryPrice || !question || !txHash) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    txHash = normalizeTxHash(txHash);

    // Verify transaction on-chain
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (!receipt) {
        return res.status(400).json({ error: 'Transaction receipt not found on-chain' });
      }
      if (receipt.status !== 'success') {
        return res.status(400).json({ error: 'Transaction failed on-chain' });
      }

      // Verify transaction sender matches the requested user address
      const expectedAddress = userId.replace('eth_', '').toLowerCase();
      if (receipt.from.toLowerCase() !== expectedAddress) {
        console.warn(`[Save-External Warning] Sender mismatch. Expected: ${expectedAddress}, Got: ${receipt.from}`);
        return res.status(403).json({ error: 'Forbidden: Transaction sender mismatch' });
      }

      // Verify transaction destination/target matches marketId contract address
      if (marketId && receipt.to.toLowerCase() !== marketId.toLowerCase()) {
        console.warn(`[Save-External Warning] Market mismatch. Expected: ${marketId}, Got: ${receipt.to}`);
        return res.status(403).json({ error: 'Forbidden: Market address mismatch' });
      }
    } catch (err) {
      console.error('[Save-External Verification Error]', err.message);
      return res.status(400).json({ error: `On-chain verification failed: ${err.message}` });
    }

    await saveTrade(userId, {
      tx_id: `ext_${Date.now()}`,
      side,
      usdc_amount: parseFloat(usdcAmount),
      entry_price: clampPrice(entryPrice),
      question,
      market_id: marketId,
      state: 'COMPLETE',
      tx_hash: txHash,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trade/recent', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const limitNum = Math.min(100, parseInt(limit) || 20);
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limitNum);

    if (error) {
      console.error('Error fetching recent trades:', error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json(data ?? []);
  } catch (e) {
    console.error('recent trades error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/portfolio ────────────────────────────────────────────────────────
app.get('/api/portfolio', authenticateUser, async (req, res) => {
  try {
    let { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    // Derive or enforce the correct userId from JWT token if user is authenticated
    if (req.user) {
      const expectedUserId = `supabase_${req.user.id}`;
      // In case they tampered with the query param, override/assert it matches
      if (userId !== expectedUserId) {
        return res.status(403).json({ error: 'Forbidden: User identity mismatch' });
      }
      userId = expectedUserId;
    }

    let userAddress = null;
    if (userId && (userId.startsWith('0x') || userId.startsWith('eth_0x'))) {
      userAddress = userId.replace('eth_', '');
    } else {
      const walletId = await getWalletId(userId);
      const info = walletId ? await getWalletInfo(walletId) : null;
      userAddress = info?.address;
    }

    // Also include the user's AI-agent wallet so agent-bought positions appear.
    let agentAddress = null;
    try {
      const agentWalletId = await getWalletId(`agent_${userId}`);
      if (agentWalletId) agentAddress = (await getWalletInfo(agentWalletId)).address;
    } catch (_) {}
    const scanAddresses = [userAddress, agentAddress].filter(Boolean);

    const rows = await getTrades(userId);

    const terminalStates = ['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'];
    const pendingRows = rows.filter(r => !r.state || !terminalStates.includes(r.state.toUpperCase()));
    if (pendingRows.length > 0) {
      // Sync pending rows synchronously (capped) so THIS response already reflects
      // the final tx state instead of requiring a second reload.
      await Promise.allSettled(pendingRows.slice(0, 6).map(async (r) => {
        if (!r.tx_id || r.tx_id.startsWith('ext_')) return;
        try {
          const tx = await circle.getTransaction({ id: r.tx_id });
          const state = tx.data.transaction.state;
          const txHash = tx.data.transaction.txHash ?? r.tx_hash;
          if (state && state !== r.state) {
            r.state = state;          // reflect in this request's position math
            r.tx_hash = txHash;
            await supabase.from('trades').update({ state, tx_hash: txHash }).eq('tx_id', r.tx_id);
          }
        } catch (err) {
          console.error(`Portfolio pending sync failed for tx ${r.tx_id}:`, err.message);
        }
      }));
    }

    let positions = [];
    const uniqueMarkets = [...new Set(rows.map(r => r.market_id).filter(id => id && id.startsWith('0x')))];

    if (scanAddresses.length > 0 && uniqueMarkets.length > 0) {
      await Promise.all(uniqueMarkets.map(async (marketAddress) => {
        try {
          let yesShares = 0, noShares = 0, claimed = false;
          let rpcPositionSuccess = false;
          // Track shares PER holding wallet so each position can be sold from the
          // wallet that actually owns it (user vs. their AI-agent wallet).
          const holders = []; // { owner: 'user'|'agent', address, yesShares, noShares }

          try {
            for (const addr of scanAddresses) {
              const [yesSharesRaw, noSharesRaw, claimedRaw] = await publicClient.readContract({
                address: marketAddress,
                abi: [{
                  name: 'getUserPosition',
                  type: 'function',
                  stateMutability: 'view',
                  inputs: [{ name: 'user', type: 'address' }],
                  outputs: [
                    { name: '_yesShares', type: 'uint256' },
                    { name: '_noShares', type: 'uint256' },
                    { name: '_claimed', type: 'bool' }
                  ]
                }],
                functionName: 'getUserPosition',
                args: [addr]
              });
              const y = Number(yesSharesRaw) / 1_000_000;
              const n = Number(noSharesRaw) / 1_000_000;
              yesShares += y;
              noShares += n;
              if (claimedRaw) claimed = true;
              if (y > 0.0001 || n > 0.0001) {
                holders.push({
                  owner: agentAddress && addr.toLowerCase() === agentAddress.toLowerCase() ? 'agent' : 'user',
                  address: addr,
                  yesShares: y,
                  noShares: n,
                });
              }
            }
            rpcPositionSuccess = true;
          } catch (rpcErr) {
            console.error(`[RPC Fallback] Failed to read position from contract for user ${userAddress} on market ${marketAddress}:`, rpcErr.message);
            // Fallback: estimate positions from trades in database
            const completedTrades = rows.filter(r => r.state === 'COMPLETE' && r.market_id === marketAddress);
            const yesTrades = completedTrades.filter(r => r.side === 'YES');
            const noTrades = completedTrades.filter(r => r.side === 'NO');

            yesTrades.forEach(r => {
              const amt = parseFloat(r.usdc_amount ?? 0);
              const price = parseFloat(r.entry_price ?? 0.5) || 0.5;
              yesShares += amt / price;
            });
            
            noTrades.forEach(r => {
              const amt = parseFloat(r.usdc_amount ?? 0);
              const price = parseFloat(r.entry_price ?? 0.5) || 0.5;
              noShares += amt / price;
            });

            if (yesShares < 0) yesShares = 0;
            if (noShares < 0) noShares = 0;
            
            claimed = completedTrades.some(r => r.side === 'CLAIM');
            // Can't attribute a holder from DB alone → assume user wallet.
            if (yesShares > 0.0001 || noShares > 0.0001) {
              holders.push({ owner: 'user', address: userAddress, yesShares, noShares });
            }
          }

          if (yesShares < 0.0001 && noShares < 0.0001) return;

          const slug = contractToSlugCache.get(marketAddress.toLowerCase()) || '';
          
          let question = 'Prediction Market';
          let resolved = false;
          let outcome = null;
          
          const cached = slug ? deployedMarketsCache.get(slug) : null;
          if (cached && cached.resolved) {
            resolved = true;
            outcome = cached.outcome;
          } else {
            try {
              const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain] = await publicClient.readContract({
                address: marketAddress,
                abi: [{
                  name: 'getMarketInfo',
                  type: 'function',
                  stateMutability: 'view',
                  inputs: [],
                  outputs: [
                    { name: '_slug', type: 'string' },
                    { name: '_deadline', type: 'uint256' },
                    { name: '_resolved', type: 'bool' },
                    { name: '_outcome', type: 'bool' },
                    { name: '_yesOutstanding', type: 'uint256' },
                    { name: '_noOutstanding', type: 'uint256' }
                  ]
                }],
                functionName: 'getMarketInfo'
              });
              resolved = resolvedOnChain;
              outcome = outcomeOnChain;
              
              // Self-heal DB and cache if it resolved on-chain but not in DB
              const slugVal = slug || slugOnChain || '';
              if (slugVal) {
                const cachedEntry = deployedMarketsCache.get(slugVal);
                if (resolved && (!cachedEntry || !cachedEntry.resolved)) {
                  if (cachedEntry) {
                    cachedEntry.resolved = true;
                    cachedEntry.outcome = outcome;
                  } else {
                    deployedMarketsCache.set(slugVal, {
                      contractAddress: marketAddress,
                      deadline: Number(deadlineOnChain),
                      resolved: true,
                      outcome
                    });
                  }
                  supabase
                    .from('deployed_markets')
                    .update({ resolved: true, outcome })
                    .eq('contract_address', marketAddress)
                    .then(({ error }) => {
                      if (error) console.error(`[Self-Heal Error] Failed to update db resolved state for ${slugVal}:`, error.message);
                      else console.log(`[Self-Heal Success] Updated resolved state in DB for ${slugVal}`);
                    });
                }
              }
            } catch (err) {
              console.error(`Failed to read market info from contract for ${marketAddress}:`, err.message);
              // Fallback to cache if contract call fails
              if (cached) {
                resolved = cached.resolved;
                outcome = cached.outcome;
              }
            }
          }

          const tradeForMarket = rows.find(r => r.market_id === marketAddress);
          if (tradeForMarket && tradeForMarket.question) {
            question = tradeForMarket.question;
          }

          const completedTrades = rows.filter(r => r.state === 'COMPLETE' && r.market_id === marketAddress);
          const yesCost = completedTrades.filter(r => r.side === 'YES').reduce((sum, r) => sum + parseFloat(r.usdc_amount ?? 0), 0);
          const noCost = completedTrades.filter(r => r.side === 'NO').reduce((sum, r) => sum + parseFloat(r.usdc_amount ?? 0), 0);

          // Emit one position per holding wallet + side, so each is sellable from
          // the wallet that actually owns the shares (e.g. agent-bought positions).
          const yesEntryPrice = yesCost > 0 ? Math.min(0.99, Math.max(0.01, yesCost / yesShares)) : 0.5;
          const noEntryPrice = noCost > 0 ? Math.min(0.99, Math.max(0.01, noCost / noShares)) : 0.5;
          for (const h of holders) {
            const ownerSuffix = h.owner === 'agent' ? '-AGENT' : '';
            if (h.yesShares > 0.0001) {
              positions.push({
                id: `${userId}-${marketAddress}-YES${ownerSuffix}`,
                side: 'YES',
                owner: h.owner,
                holderAddress: h.address,
                usdcAmount: h.yesShares * yesEntryPrice,
                entryPrice: yesEntryPrice,
                shares: h.yesShares,
                question,
                slug,
                marketId: marketAddress,
                contractAddress: marketAddress,
                state: 'COMPLETE',
                claimed,
                resolved,
                outcome,
                isEstimate: !rpcPositionSuccess,
                txHash: completedTrades.find(r => r.side === 'YES')?.tx_hash || null,
                timestamp: completedTrades.find(r => r.side === 'YES')?.created_at || new Date().toISOString()
              });
            }
            if (h.noShares > 0.0001) {
              positions.push({
                id: `${userId}-${marketAddress}-NO${ownerSuffix}`,
                side: 'NO',
                owner: h.owner,
                holderAddress: h.address,
                usdcAmount: h.noShares * noEntryPrice,
                entryPrice: noEntryPrice,
                shares: h.noShares,
                question,
                slug,
                marketId: marketAddress,
                contractAddress: marketAddress,
                state: 'COMPLETE',
                claimed,
                resolved,
                outcome,
                isEstimate: !rpcPositionSuccess,
                txHash: completedTrades.find(r => r.side === 'NO')?.tx_hash || null,
                timestamp: completedTrades.find(r => r.side === 'NO')?.created_at || new Date().toISOString()
              });
            }
          }
        } catch (err) {
          console.error(`Failed to read position for user ${userAddress} on market ${marketAddress}:`, err.message);
        }
      }));
    }

    const pendingTrades = rows.filter(r => !r.state || !terminalStates.includes(r.state.toUpperCase()));
    for (const r of pendingTrades) {
      positions.push({
        id: r.id,
        side: r.side,
        usdcAmount: parseFloat(r.usdc_amount ?? 0),
        entryPrice: parseFloat(r.entry_price ?? 0),
        question: r.question,
        marketId: r.market_id,
        contractAddress: r.market_id,
        state: r.state || 'INITIATED',
        txHash: r.tx_hash || null,
        timestamp: r.created_at,
        shares: Math.abs(parseFloat(r.usdc_amount ?? 0)) / parseFloat(r.entry_price ?? 0.5)
      });
    }

    const completed = positions.filter(p => p.state === 'COMPLETE');
    const totalSpent = completed.reduce((s, p) => s + p.usdcAmount, 0).toFixed(2);
    
    res.json({ positions, totalSpent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Market Analyst ─────────────────────────────────────────────────────────
// Public, cached, auto-generated market brief: thesis, key factors, lean.
const insightCache = new Map(); // slug -> { data, ts }
const insightInflight = new Map(); // slug -> Promise
const INSIGHT_TTL_MS = 6 * 60 * 60 * 1000;

const insightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function parseLlmJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in LLM output');
  return JSON.parse(t.slice(start, end + 1));
}

async function generateMarketInsight(slug) {
  // Gather market context (Polymarket first, then our own DB for custom markets)
  const ctx = { question: null, description: '', yesPrice: null, endDate: null, volume: null, change24h: null };
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
    if (r.ok) {
      const arr = await r.json();
      const m = Array.isArray(arr) ? arr[0] : null;
      if (m && m.question) {
        ctx.question = m.question;
        ctx.description = (m.description || '').slice(0, 1500);
        try { ctx.yesPrice = parseFloat(JSON.parse(m.outcomePrices || '[]')[0]); } catch {}
        ctx.endDate = m.endDate || null;
        ctx.volume = m.volume24hr ?? m.volume ?? null;
        ctx.change24h = m.oneDayPriceChange ?? null;
      }
    }
  } catch (e) {
    console.error(`[Insight] Polymarket lookup failed for ${slug}:`, e.message);
  }
  if (!ctx.question) {
    const { data } = await supabase.from('deployed_markets').select('*').eq('slug', slug).maybeSingle();
    if (!data) throw new Error('unknown market');
    ctx.question = data.question || slug.replace(/-/g, ' ');
  }

  const sys = `You are the Puls AI Analyst, a sharp prediction-market researcher. Given a market, produce a concise analyst brief.
Respond with STRICT JSON only, no prose, matching exactly:
{"thesis": "<2 sentences: what this market is really about and what the current price implies>", "factors": ["<key factor 1>", "<key factor 2>", "<key factor 3>"], "lean": "YES" | "NO" | "UNCERTAIN", "confidence": "low" | "medium" | "high"}
Rules: factors are short (max 14 words each), concrete and specific to this question. lean reflects which outcome the evidence and current pricing favor; use UNCERTAIN when genuinely unclear. Never give financial advice wording; this is analysis.`;

  const user = [
    `Market question: ${ctx.question}`,
    ctx.description ? `Resolution criteria / description: ${ctx.description}` : null,
    ctx.yesPrice != null && !Number.isNaN(ctx.yesPrice) ? `Current YES price: ${(ctx.yesPrice * 100).toFixed(0)}¢` : null,
    ctx.change24h != null ? `24h price change: ${(ctx.change24h * 100).toFixed(1)}¢` : null,
    ctx.volume != null ? `Volume: $${ctx.volume}` : null,
    ctx.endDate ? `Resolution date: ${ctx.endDate}` : null,
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);
    const parsed = parseLlmJson(raw);
    const lean = ['YES', 'NO', 'UNCERTAIN'].includes(parsed.lean) ? parsed.lean : 'UNCERTAIN';
    const confidence = ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium';
    return {
      slug,
      question: ctx.question,
      thesis: formatForApp(String(parsed.thesis || '').slice(0, 600)),
      factors: (Array.isArray(parsed.factors) ? parsed.factors : []).slice(0, 4).map((f) => String(f).slice(0, 160)),
      lean,
      confidence,
      source: 'llm',
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`[Insight] LLM failed for ${slug}, using quantitative fallback:`, e.message);
    return quantInsight(slug, ctx);
  }
}

// Deterministic, data-driven brief when the LLM is unavailable.
function quantInsight(slug, ctx) {
  const yes = ctx.yesPrice != null && !Number.isNaN(ctx.yesPrice) ? ctx.yesPrice : 0.5;
  const pct = Math.round(yes * 100);
  const change = ctx.change24h != null ? ctx.change24h * 100 : null;
  const daysLeft = ctx.endDate ? Math.max(0, Math.round((new Date(ctx.endDate) - Date.now()) / 86400000)) : null;

  const lean = yes >= 0.6 ? 'YES' : yes <= 0.4 ? 'NO' : 'UNCERTAIN';
  const edge = Math.abs(yes - 0.5);
  const confidence = edge > 0.35 ? 'high' : edge > 0.15 ? 'medium' : 'low';

  const factors = [];
  if (change != null && Math.abs(change) >= 0.5) {
    factors.push(`Price moved ${change > 0 ? '+' : ''}${change.toFixed(1)}¢ in the last 24h — momentum ${change > 0 ? 'toward' : 'away from'} YES`);
  } else {
    factors.push('Price has been stable over the last 24h — no fresh information shifting the odds');
  }
  if (daysLeft != null) {
    factors.push(daysLeft <= 3 ? `Resolves in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — little time left for the picture to change` : `${daysLeft} days until resolution — outcome can still swing on new developments`);
  }
  if (ctx.volume != null && parseFloat(ctx.volume) > 0) {
    factors.push(`$${Math.round(parseFloat(ctx.volume)).toLocaleString('en-US')} in source-market volume backs the current consensus`);
  }
  if (factors.length < 3) {
    factors.push(lean === 'UNCERTAIN' ? 'Market is near a coin flip — traders are genuinely split' : `Crowd consensus currently favors ${lean}`);
  }

  const thesis = lean === 'UNCERTAIN'
    ? `Traders price YES at ${pct}¢, treating this as close to a coin flip. Neither side has conviction yet, so new information is likely to move this market sharply.`
    : `Traders price YES at ${pct}¢, implying roughly a ${lean === 'YES' ? pct : 100 - pct}% chance the market resolves ${lean}. The crowd has taken a clear side; the open question is whether anything before resolution can flip it.`;

  return {
    slug,
    question: ctx.question,
    thesis,
    factors: factors.slice(0, 3),
    lean,
    confidence,
    source: 'quant',
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/market/insight?slug=...
app.get('/api/market/insight', insightLimiter, async (req, res) => {
  try {
    const slug = (req.query.slug || '').toString().trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const cached = insightCache.get(slug);
    if (cached && Date.now() - cached.ts < INSIGHT_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    let p = insightInflight.get(slug);
    if (!p) {
      p = generateMarketInsight(slug)
        .then((data) => {
          // quant fallbacks expire faster so the LLM takes over once available
          const ttlShift = data.source === 'quant' ? INSIGHT_TTL_MS - 10 * 60 * 1000 : 0;
          insightCache.set(slug, { data, ts: Date.now() - ttlShift });
          return data;
        })
        .finally(() => insightInflight.delete(slug));
      insightInflight.set(slug, p);
    }
    res.json(await p);
  } catch (e) {
    console.error('insight error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Protocol Stats ────────────────────────────────────────────────────────────
let statsCache = { data: null, ts: 0 };
const STATS_TTL_MS = 60 * 1000;

// GET /api/stats — public protocol-level numbers for the landing page
app.get('/api/stats', async (req, res) => {
  try {
    if (statsCache.data && Date.now() - statsCache.ts < STATS_TTL_MS) {
      return res.json(statsCache.data);
    }
    const [countRes, marketsRes, resolvedRes] = await Promise.all([
      supabase.from('trades').select('*', { count: 'exact', head: true }).eq('state', 'COMPLETE'),
      supabase.from('deployed_markets').select('*', { count: 'exact', head: true }),
      supabase.from('deployed_markets').select('*', { count: 'exact', head: true }).eq('resolved', true),
    ]);
    const tradeCount = countRes.count ?? 0;
    // Supabase caps responses at 1000 rows — paginate the volume sum
    let volumeUsdc = 0;
    for (let from = 0; from < tradeCount; from += 1000) {
      const { data: page } = await supabase
        .from('trades')
        .select('usdc_amount')
        .eq('state', 'COMPLETE')
        .range(from, from + 999);
      if (!page || page.length === 0) break;
      volumeUsdc += page.reduce((acc, r) => acc + (parseFloat(r.usdc_amount) || 0), 0);
      if (page.length < 1000) break;
    }
    const data = {
      trades: tradeCount,
      volumeUsdc: Math.round(volumeUsdc * 100) / 100,
      marketsDeployed: marketsRes.count ?? 0,
      marketsResolved: resolvedRes.count ?? 0,
      updatedAt: new Date().toISOString(),
    };
    statsCache = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── x402 creator-monetization layer ──────────────────────────────────────────
// "Forecaster = creator, paid per event." A premium forecast is sold per-read
// via Circle Gateway batched nanopayments on Arc Testnet. The buyer (human or
// agent) pays a sub-cent USDC nanopayment that settles to the seller's Arc
// wallet; the tx is visible on arcscan. See lib/x402.js.

// Public config — free. Useful for the buyer agent, demos and judges.
app.get('/api/x402/info', x402Info);

// Paywalled premium forecast ($0.001). First paid endpoint of the creator loop.
app.get('/api/alpha/sample', x402Paywall('$0.001', '/api/alpha/sample', {
  description: 'Puls premium forecast — sample alpha signal',
}), (req, res) => {
  res.json({
    signal: {
      market: 'Will BTC close above $100k by 2026-12-31?',
      stance: 'YES',
      confidence: 0.62,
      thesis:
        'Spot ETF inflows + post-halving supply squeeze outweigh near-term macro drag; '
        + 'order-flow on Puls skews YES while implied prob lags fundamentals.',
      edge_bps: 480,
      horizon: 'Q4 2026',
    },
    creator: { handle: 'puls-house', payTo: req.x402?.payTo },
    payment: req.x402 || null,
    generatedAt: new Date().toISOString(),
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Deep health check for demo-day readiness: pings every external dependency and
// reports the treasury balance in one call. Returns 200 when all checks pass,
// 503 otherwise. Cheap enough to poll, but not behind auth — exposes no secrets.
app.get('/health/deep', async (_req, res) => {
  const checks = {};
  const time = async (fn) => { const t = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, ms: Date.now() - t, error: e.message }; } };

  // RPC reachability
  checks.rpc = await time(async () => { await publicClient.getBlockNumber(); });
  // Supabase reachability (lightweight count)
  checks.supabase = await time(async () => {
    const { error } = await supabase.from('wallets').select('user_id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
  });
  // Circle API reachability (lightweight list call; tolerate SDK method naming).
  checks.circle = await time(async () => {
    if (typeof circle.listWalletSets === 'function') { await circle.listWalletSets({ pageSize: 1 }); }
    else if (typeof circle.getWalletSets === 'function') { await circle.getWalletSets({ pageSize: 1 }); }
    else { throw new Error('Circle client not initialized'); }
  });
  // Treasury balance (informational — does not fail the check on its own)
  const treasury = await getTreasuryUsdcBalance();
  checks.treasury = {
    address: adminAccount?.address || null,
    usdc: treasury,
    ok: treasury == null ? null : treasury >= TREASURY_MIN_USDC,
    min: TREASURY_MIN_USDC,
  };

  const critical = ['rpc', 'supabase'];
  const healthy = critical.every((k) => checks[k].ok);
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    walletAccountType: WALLET_ACCOUNT_TYPE,
    gaslessEnabled: WALLET_ACCOUNT_TYPE === 'SCA',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ── Circle webhook + signature verification ──────────────────────────────────
// Circle signs every webhook with a per-message ECDSA (P-256, SHA-256) key.
// Headers: `X-Circle-Signature` (base64 DER signature) and `X-Circle-Key-Id`
// (UUID of the public key). We fetch + cache the public key by id and verify the
// signature over the RAW request body.
// Docs: https://developers.circle.com/cpn/guides/webhooks/verify-webhook-signatures
//
// Rollout safety: verification is ATTEMPTED on every request, but it is only
// ENFORCED (request rejected on failure/missing signature) when
// CIRCLE_WEBHOOK_ENFORCE=true. Default is off so an unverified-but-legitimate
// webhook can't silently stop trade-state updates during the demo — flip it on
// once you've confirmed signatures verify in the logs.
const CIRCLE_WEBHOOK_ENFORCE = (process.env.CIRCLE_WEBHOOK_ENFORCE || 'false').toLowerCase() === 'true';
const circlePublicKeyCache = new Map(); // keyId -> crypto.KeyObject

async function getCirclePublicKey(keyId) {
  if (circlePublicKeyCache.has(keyId)) return circlePublicKeyCache.get(keyId);
  const apiKey = (process.env.CIRCLE_API_KEY || '').trim();
  // The public-key endpoint path differs across Circle products; try both.
  const urls = [
    `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
    `https://api.circle.com/v2/cpn/notifications/publicKey/${keyId}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) continue;
      const j = await r.json();
      const b64 = j?.data?.publicKey;
      if (!b64) continue;
      const keyObj = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
      circlePublicKeyCache.set(keyId, keyObj);
      return keyObj;
    } catch (_) { /* try next url */ }
  }
  return null;
}

// Verify the signature. Returns true if valid, false if invalid, and null if it
// could not be checked (no headers / key fetch failed) so the caller can decide.
async function verifyCircleWebhook(req) {
  const signature = req.headers['x-circle-signature'];
  const keyId = req.headers['x-circle-key-id'];
  if (!signature || !keyId || !req.rawBody) return null;
  const keyObj = await getCirclePublicKey(keyId);
  if (!keyObj) return null;
  try {
    return crypto.verify('sha256', req.rawBody, keyObj, Buffer.from(signature, 'base64'));
  } catch (e) {
    console.warn('[Circle Webhook] signature verify error:', e.message);
    return false;
  }
}

// Bounded de-dupe set so retried webhooks (Circle retries on non-2xx or timeout)
// are processed at most once. Keyed by Circle's notificationId.
const processedNotifications = new Set();
function markProcessed(id) {
  if (!id) return false;
  if (processedNotifications.has(id)) return true; // already handled
  processedNotifications.add(id);
  if (processedNotifications.size > 5000) {
    // drop oldest ~1000 to cap memory
    const it = processedNotifications.values();
    for (let i = 0; i < 1000; i++) { const n = it.next(); if (n.done) break; processedNotifications.delete(n.value); }
  }
  return false;
}

app.post('/api/webhook/circle', async (req, res) => {
  // Verify BEFORE acting. Ack with 200 only after the security decision so Circle
  // doesn't keep retrying a request we deliberately rejected.
  const verified = await verifyCircleWebhook(req);
  if (verified === false) {
    console.warn('[Circle Webhook] INVALID signature — rejected.');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (verified === null) {
    if (CIRCLE_WEBHOOK_ENFORCE) {
      console.warn('[Circle Webhook] Unsigned/unverifiable request rejected (enforce on).');
      return res.status(401).json({ error: 'Unverified webhook' });
    }
    console.warn('[Circle Webhook] Could not verify signature (enforce off) — processing anyway. Set CIRCLE_WEBHOOK_ENFORCE=true once verification is confirmed.');
  }

  res.sendStatus(200);
  try {
    const notificationId = req.body?.notificationId || req.body?.id;
    if (markProcessed(notificationId)) {
      console.log(`Webhook: duplicate notification ${notificationId} ignored`);
      return;
    }
    const { notificationType, transaction } = req.body;
    if (notificationType !== 'transactions.outbound' || !transaction) return;
    const { id: txId, state, txHash } = transaction;
    if (!txId) return;
    await supabase.from('trades').update({
      state,
      tx_hash: txHash ?? null,
    }).eq('tx_id', txId);
    console.log(`Webhook: tx ${txId} → ${state}`);
  } catch (e) {
    console.error('webhook error:', e.message);
  }
});

// ── QuickNode Webhook ─────────────────────────────────────────────────────────

const processedChainLogs = new Set();
async function handleQuickNodeLog(log) {
  try {
    // Idempotency: a (txHash, logIndex) pair uniquely identifies an on-chain
    // event, so retried/duplicated webhook deliveries are processed once.
    const logKey = `${(log.transactionHash || '').toLowerCase()}:${log.logIndex ?? ''}`;
    if (logKey !== ':' ) {
      if (processedChainLogs.has(logKey)) {
        console.log(`[QuickNode Webhook] Duplicate log ${logKey} ignored`);
        return;
      }
      processedChainLogs.add(logKey);
      if (processedChainLogs.size > 10000) {
        const it = processedChainLogs.values();
        for (let i = 0; i < 2000; i++) { const n = it.next(); if (n.done) break; processedChainLogs.delete(n.value); }
      }
    }
    const contractAddress = log.address.toLowerCase();
    const slug = contractToSlugCache.get(contractAddress);
    if (!slug) {
      console.log(`[QuickNode Webhook] Ignoring log from non-market address: ${contractAddress}`);
      return;
    }

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: MARKET_EVENTS_ABI,
        data: log.data,
        topics: log.topics,
      });
    } catch (err) {
      console.warn(`[QuickNode Webhook] Failed to decode event log at address ${contractAddress}:`, err.message);
      return;
    }

    const { eventName, args } = decoded;
    console.log(`[QuickNode Webhook] Received ${eventName} event on market ${slug} (${contractAddress})`);

    let question = slug.split('-').join(' ');
    if (question.length > 0) {
      question = question.charAt(0).toUpperCase() + question.slice(1);
    }

    if (eventName === 'Bought') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const side = args.side ? 'YES' : 'NO';
      const amountUsdc = Number(args.amount) / 1_000_000;
      const shares = Number(args.shares) / 1_000_000;
      const entryPrice = shares !== 0 ? Math.min(0.99, Math.max(0.01, amountUsdc / shares)) : 0.5;

      await syncCompletedTrade(userId, {
        marketId: contractAddress,
        side,
        amountUsdc,
        shares,
        txHash: log.transactionHash,
        question,
        entryPrice
      });
    } else if (eventName === 'Sold') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const side = args.side ? 'YES' : 'NO';
      const shares = Number(args.shares) / 1_000_000;
      const usdcOut = Number(args.usdcOut) / 1_000_000;
      const amountUsdc = -usdcOut; // Sells are stored as negative USDC payout
      const exitPrice = shares !== 0 ? Math.min(0.99, Math.max(0.01, usdcOut / shares)) : 0.5;

      await syncCompletedTrade(userId, {
        marketId: contractAddress,
        side,
        amountUsdc,
        shares,
        txHash: log.transactionHash,
        question,
        entryPrice: exitPrice
      });
    } else if (eventName === 'Resolved') {
      const outcome = args.outcome;
      console.log(`[QuickNode Webhook] Market ${slug} resolved on-chain to outcome: ${outcome ? 'YES' : 'NO'}`);
      
      const { error } = await supabase
        .from('deployed_markets')
        .update({ resolved: true, outcome })
        .eq('contract_address', contractAddress);
        
      if (error) {
        console.error(`[QuickNode Webhook] Failed to update resolved state in Supabase for ${slug}:`, error.message);
      } else {
        const cached = deployedMarketsCache.get(slug);
        if (cached) {
          cached.resolved = true;
          cached.outcome = outcome;
        }
        console.log(`[QuickNode Webhook] Successfully updated resolved state in DB & cache for ${slug}`);
        
        // Notify traders who participated in this market
        (async () => {
          try {
            const { data: participants } = await supabase
              .from('trades')
              .select('user_id')
              .eq('market_id', contractAddress);
            const uniqueUserIds = [...new Set(participants?.map(p => p.user_id) || [])];
            for (const uId of uniqueUserIds) {
              createNotification(
                uId,
                'Market Resolved 🔮',
                `Market "${question}" has resolved to ${outcome ? 'YES' : 'NO'}. Claim your winnings now!`,
                'resolution'
              ).catch(console.error);
            }
          } catch (err) {
            console.error('Failed to send resolution notifications:', err.message);
          }
        })().catch(console.error);
      }
    } else if (eventName === 'Claimed') {
      const userAddress = args.user.toLowerCase();
      const userId = addressToUserIdCache.get(userAddress) || `eth_${userAddress}`;
      const txHash = log.transactionHash;

      const { data: dup } = await supabase
        .from('trades')
        .select('*')
        .eq('tx_hash', txHash)
        .limit(1);

      if (dup && dup.length > 0) {
        console.log(`[QuickNode Webhook] Claim event for tx ${txHash} already exists, skipping.`);
        return;
      }

      const { error } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: `ext_${Date.now()}`,
          side: 'CLAIM',
          usdc_amount: 0,
          entry_price: 0,
          question: 'Claim Winnings',
          market_id: contractAddress,
          state: 'COMPLETE',
          tx_hash: txHash,
        });

      if (error) {
        console.error(`[QuickNode Webhook] Failed to insert CLAIM trade for user ${userId}:`, error.message);
      } else {
        console.log(`[QuickNode Webhook] Successfully recorded CLAIM trade for user ${userId} and tx ${txHash}`);
      }
    }
  } catch (err) {
    console.error(`[QuickNode Webhook] Error processing single log:`, err.message);
  }
}

app.post('/api/webhook/quicknode', async (req, res) => {
  try {
    const webhookSecret = process.env.QUICKNODE_WEBHOOK_SECRET;
    if (webhookSecret) {
      const headerSecret = req.headers['x-qn-secret'];
      const querySecret = req.query.secret;
      if (headerSecret !== webhookSecret && querySecret !== webhookSecret) {
        console.warn(`[QuickNode Webhook] Unauthorized request received. Secret mismatch.`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    
    if (Array.isArray(payload)) {
      console.log(`[QuickNode Webhook] Received array of ${payload.length} logs.`);
      for (const log of payload) {
        await handleQuickNodeLog(log);
      }
    } else if (payload && typeof payload === 'object') {
      console.log(`[QuickNode Webhook] Received single log payload.`);
      await handleQuickNodeLog(payload);
    } else {
      console.warn(`[QuickNode Webhook] Unknown or empty payload format received.`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[QuickNode Webhook] Error handling request:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Market resolution (owner fallback / manual) ──────────────────────────────
app.post('/api/market/resolve', authenticateUser, requireVerifiedUser, requireAdmin, strictLimiter, async (req, res) => {
  try {
    const { userId, slug, outcome } = req.body; // outcome: true=YES wins, false=NO wins
    if (!userId || !slug || outcome === undefined) return res.status(400).json({ error: 'userId, slug and outcome required' });

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'No wallet' });

    const cached = deployedMarketsCache.get(slug);
    if (!cached) return res.status(400).json({ error: 'Market contract not deployed' });
    const contractAddress = cached.contractAddress;

    // Markets owned by the UMA adapter can only be force-resolved through its
    // admin escape hatch (signed by the admin EOA, not a Circle wallet).
    if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
      try {
        const { registered } = await getUmaResolution(contractAddress);
        if (registered) {
          const hash = await walletClient.writeContract({
            address: UMA_ADAPTER_ADDRESS,
            abi: [{ name: 'adminResolve', type: 'function', stateMutability: 'nonpayable',
              inputs: [{ name: 'market', type: 'address' }, { name: 'outcome', type: 'bool' }], outputs: [] }],
            functionName: 'adminResolve',
            args: [contractAddress, outcome]
          });
          await publicClient.waitForTransactionReceipt({ hash });
          return res.json({ txHash: hash, state: 'COMPLETE', via: 'uma-adapter' });
        }
      } catch (e) {
        console.error('[UMA] adminResolve check failed, falling back to direct resolve:', e.message);
      }
    }

    const txRes = await circle.createContractExecutionTransaction({
      walletId,
      contractAddress: contractAddress,
      abiFunctionSignature: 'resolve(bool)',
      abiParameters: [outcome],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    res.json({ txId: txRes.data.id, state: txRes.data.state });
  } catch (e) {
    console.error('resolve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-Resolution Cron ──────────────────────────────────────────────────────
// ── Stale-market archiving ────────────────────────────────────────────────────
// Markets that are long past their deadline and that Polymarket can no longer
// resolve (slug gone, or never resolves) are "zombies": they clutter the app and
// make every resolution-cron tick slower/noisier. We mark them archived in
// Supabase (column `archived boolean default false`), drop them from the cache,
// and exclude them from listings. Archiving touches nothing on-chain.
const ARCHIVE_AFTER_DAYS = parseFloat(process.env.ARCHIVE_AFTER_DAYS || '3');

async function archiveMarket(slug, reason) {
  try {
    const { error } = await supabase
      .from('deployed_markets')
      .update({ archived: true })
      .eq('slug', slug);
    if (error) {
      if (/archived/.test(error.message)) {
        console.warn(`[Archive] 'archived' column missing — run in Supabase SQL editor: alter table deployed_markets add column if not exists archived boolean default false;`);
      } else {
        console.error(`[Archive] failed for ${slug}:`, error.message);
      }
      return false;
    }
    const entry = deployedMarketsCache.get(slug);
    if (entry) {
      contractToSlugCache.delete((entry.contractAddress || '').toLowerCase());
      deployedMarketsCache.delete(slug);
    }
    console.log(`[Archive] ${slug} archived (${reason})`);
    return true;
  } catch (e) {
    console.error(`[Archive] error for ${slug}:`, e.message);
    return false;
  }
}

async function checkAndResolveMarkets() {
  console.log('Running auto-resolution cron check...');
  const now = Math.floor(Date.now() / 1000);
  const archiveCutoff = now - ARCHIVE_AFTER_DAYS * 24 * 3600;
  
  const marketsToResolve = [];
  for (const [slug, entry] of deployedMarketsCache.entries()) {
    if (entry.deadline < now && !entry.resolved) {
      marketsToResolve.push({ slug, ...entry });
    }
  }

  if (marketsToResolve.length === 0) {
    console.log('No markets need resolution.');
    return;
  }

  console.log(`Found ${marketsToResolve.length} markets to check for resolution.`);

  for (const market of marketsToResolve) {
    try {
      const pmUrl = `https://gamma-api.polymarket.com/markets?slug=${market.slug}`;
      const res = await fetch(pmUrl);
      if (!res.ok) continue;
      
      const list = await res.json();
      if (!list || list.length === 0) {
        // Slug no longer exists on Polymarket → can never auto-resolve.
        if (market.deadline < archiveCutoff) await archiveMarket(market.slug, 'slug gone from Polymarket');
        continue;
      }
      
      const pmMarket = list[0];
      const isResolved = pmMarket.closed === true || pmMarket.resolved === true;
      if (!isResolved) {
        if (market.deadline < archiveCutoff) {
          await archiveMarket(market.slug, `unresolved on Polymarket ${ARCHIVE_AFTER_DAYS}+ days past deadline`);
        } else {
          console.log(`Market ${market.slug} is past deadline but not yet resolved on Polymarket.`);
        }
        continue;
      }
      
      let outcome = null;
      if (pmMarket.consensusOutcome === 'YES') {
        outcome = true;
      } else if (pmMarket.consensusOutcome === 'NO') {
        outcome = false;
      } else {
        try {
          const prices = JSON.parse(pmMarket.outcomePrices || '[]');
          if (parseFloat(prices[0]) > 0.9) outcome = true;
          else if (parseFloat(prices[1]) > 0.9) outcome = false;
        } catch {}
      }

      // ── UMA optimistic oracle path ────────────────────────────────────────
      // The request can be opened before the outcome is known; proposing and
      // settling happen on later cron ticks as the OOV2 state machine advances.
      if (UMA_RESOLUTION && UMA_ADAPTER_ADDRESS) {
        let umaResult = 'fallback';
        try {
          umaResult = await processUmaMarket(market, outcome);
        } catch (e) {
          console.error(`[UMA] processing failed for ${market.slug}:`, e.message);
          continue;
        }
        if (umaResult === 'pending') continue;
        if (umaResult === 'resolved') {
          // Read the final outcome from chain (source of truth after settlement).
          const [, , resolvedOnChain, outcomeOnChain] = await publicClient.readContract({
            address: market.contractAddress,
            abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [],
              outputs: [
                { name: '_slug', type: 'string' },
                { name: '_deadline', type: 'uint256' },
                { name: '_resolved', type: 'bool' },
                { name: '_outcome', type: 'bool' },
                { name: '_yesOutstanding', type: 'uint256' },
                { name: '_noOutstanding', type: 'uint256' }
              ] }],
            functionName: 'getMarketInfo'
          });
          if (resolvedOnChain) {
            await supabase
              .from('deployed_markets')
              .update({ resolved: true, outcome: outcomeOnChain })
              .eq('slug', market.slug);
            const entry = deployedMarketsCache.get(market.slug);
            if (entry) { entry.resolved = true; entry.outcome = outcomeOnChain; }
            console.log(`✅ [UMA] Market ${market.slug} settled via Optimistic Oracle: ${outcomeOnChain ? 'YES' : 'NO'}`);
          }
          continue;
        }
        // umaResult === 'fallback' → market predates UMA registration; resolve directly below.
      }

      if (outcome === null) {
        if (market.deadline < archiveCutoff) {
          await archiveMarket(market.slug, 'Polymarket closed but outcome indeterminate');
        } else {
          console.log(`Could not determine outcome for resolved market ${market.slug}`);
        }
        continue;
      }

      console.log(`Resolving on-chain market ${market.contractAddress} for slug ${market.slug} to outcome: ${outcome ? 'YES' : 'NO'}`);

      const { request } = await publicClient.simulateContract({
        account: adminAccount,
        address: market.contractAddress,
        abi: [
          {
            name: 'resolve',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [{ name: '_outcome', type: 'bool' }],
            outputs: []
          }
        ],
        functionName: 'resolve',
        args: [outcome]
      });

      const hash = await walletClient.writeContract(request);
      console.log(`Resolution Tx Hash: ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash });
      
      await supabase
        .from('deployed_markets')
        .update({ resolved: true, outcome })
        .eq('slug', market.slug);

      market.resolved = true;
      market.outcome = outcome;
      console.log(`✅ Deployed market ${market.slug} resolved successfully.`);
    } catch (e) {
      console.error(`Failed to resolve market ${market.slug}:`, e.message);
    }
  }
}

// Run resolution check every 5 minutes
setInterval(checkAndResolveMarkets, 5 * 60 * 1000);

async function warmupTopMarkets() {
  console.log('Starting eager market warmup for top active markets...');
  try {
    const limit = 20;
    const pmUrl = `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false&order=volume&ascending=false`;
    const pmRes = await fetch(pmUrl, { headers: { 'Accept': 'application/json' } });
    if (!pmRes.ok) {
      console.error('Failed to fetch top markets for warmup:', pmRes.statusText);
      return;
    }
    const list = await pmRes.json();
    console.log(`Fetched ${list.length} top active markets for warmup.`);

    for (const j of list) {
      const slug = j.slug;
      if (!slug) continue;

      if (deployedMarketsCache.has(slug)) {
        // Already deployed
        continue;
      }

      // Parse deadline
      const endRaw = j.endDate || j.endDateIso;
      let deadlineSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // default 30 days
      if (endRaw) {
        const parsedDate = new Date(endRaw);
        if (!isNaN(parsedDate.getTime())) {
          deadlineSeconds = Math.floor(parsedDate.getTime() / 1000);
        }
      }

      console.log(`Warming up market: ${slug} (deadline: ${deadlineSeconds})`);
      try {
        await getOrDeployMarket(slug, deadlineSeconds);
      } catch (err) {
        console.error(`Failed to warm up market ${slug}:`, err.message);
      }
    }
    console.log('Eager market warmup completed.');
  } catch (e) {
    console.error('warmupTopMarkets error:', e.message);
  }
}


// ── Leaderboard & Profiles Service ───────────────────────────────────────────

// In-memory leaderboard stats. The Supabase `leaderboard` table has a legacy
// schema (wallet_address/pet_name/level/xp) we can't migrate via REST, so the
// computed stats live here. Rebuilt at boot + every 10 minutes by the cron.
const leaderboardStats = new Map(); // user_id → { volume, pnl, trades_count, win_rate, updated_at }

async function updateLeaderboard() {
  console.log('Running leaderboard update...');
  try {
    // Supabase caps reads at 1000 rows — paginate so every trader counts
    const trades = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('state', 'COMPLETE')
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error('Failed to fetch trades for leaderboard:', error.message);
        return;
      }
      trades.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    
    // Humans vs agents: house-agent trades live under 'house_pulse'; user-agent
    // trades are saved under the owner's user_id with a '🤖 Agent:' question
    // prefix (and the position is held by the agent_<userId> wallet). Bucket
    // agent activity separately so the leaderboard can rank them side by side.
    const agentOwnerKey = (t) => {
      if (t.user_id === HOUSE_AGENT_USER) return HOUSE_AGENT_USER;
      const isAgentTrade = typeof t.question === 'string' && t.question.startsWith('🤖 Agent:');
      return isAgentTrade ? `agent_${t.user_id}` : t.user_id;
    };

    const userTrades = new Map();
    for (const t of (trades || [])) {
      if (!t.user_id) continue;
      const key = agentOwnerKey(t);
      if (!userTrades.has(key)) {
        userTrades.set(key, []);
      }
      userTrades.get(key).push(t);
    }
    
    for (const [userId, tradesList] of userTrades.entries()) {
      try {
        let totalVolume = 0;
        let tradesCount = 0;
        let totalPnL = 0;
        let resolvedMarketsCount = 0;
        let winningMarketsCount = 0;
        let marketsTradedCount = 0;
        let profitableMarketsCount = 0;
        
        const marketTrades = new Map();
        for (const t of tradesList) {
          if (!t.market_id) continue;
          if (!marketTrades.has(t.market_id)) {
            marketTrades.set(t.market_id, []);
          }
          marketTrades.get(t.market_id).push(t);
        }
        
        for (const [marketAddress, mTrades] of marketTrades.entries()) {
          let totalPaid = 0;
          let totalReceived = 0;
          
          for (const t of mTrades) {
            const amt = parseFloat(t.usdc_amount);
            if (t.side === 'CLAIM') {
              // Claims are handled implicitly by resolved state calculation
            } else if (amt > 0) {
              totalPaid += amt;
              totalVolume += amt;
              tradesCount++;
            } else if (amt < 0) {
              totalReceived += Math.abs(amt);
              totalVolume += Math.abs(amt);
              tradesCount++;
            }
          }
          
          let resolved = false;
          let outcome = null;
          let yesPrice = 0.5;
          let noPrice = 0.5;
          
          const slug = contractToSlugCache.get(marketAddress.toLowerCase());
          const cached = slug ? deployedMarketsCache.get(slug) : null;
          if (cached) {
            resolved = cached.resolved;
            outcome = cached.outcome;
          }
          
          let yesShares = 0;
          let noShares = 0;
          let claimed = false;
          
          try {
            let userAddress = userIdToAddressCache.get(userId);
            // House agent trades under 'house_pulse' but its wallet row is keyed 'agent_house_pulse'
            if (!userAddress && userId === HOUSE_AGENT_USER) userAddress = userIdToAddressCache.get(HOUSE_AGENT_KEY);
            // Resolve addresses not in the wallet cache: eth_-prefixed and raw-address user ids
            if (!userAddress && userId.startsWith('eth_')) userAddress = userId.slice(4);
            if (!userAddress && userId.startsWith('0x') && userId.length === 42) userAddress = userId;
            if (!userAddress) throw new Error('no wallet address for user');
            {
              const [yesSharesRaw, noSharesRaw, claimedRaw] = await publicClient.readContract({
                address: marketAddress,
                abi: [{
                  name: 'getUserPosition',
                  type: 'function',
                  stateMutability: 'view',
                  inputs: [{ name: 'user', type: 'address' }],
                  outputs: [
                    { name: '_yesShares', type: 'uint256' },
                    { name: '_noShares', type: 'uint256' },
                    { name: '_claimed', type: 'bool' }
                  ]
                }],
                functionName: 'getUserPosition',
                args: [userAddress]
              });
              yesShares = Number(yesSharesRaw) / 1_000_000;
              noShares = Number(noSharesRaw) / 1_000_000;
              claimed = claimedRaw;
            }
          } catch (err) {
            const yesBuys = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const yesSells = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const noBuys = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const noSells = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            yesShares = Math.max(0, yesBuys - yesSells);
            noShares = Math.max(0, noBuys - noSells);
          }
          
          let currentVal = 0;
          if (resolved) {
            const yesBuys = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const yesSells = mTrades.filter(t => t.side === 'YES' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const noBuys = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) > 0).reduce((s, t) => s + (parseFloat(t.usdc_amount) / parseFloat(t.entry_price || 0.5)), 0);
            const noSells = mTrades.filter(t => t.side === 'NO' && parseFloat(t.usdc_amount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.usdc_amount)), 0);
            const netYes = Math.max(0, yesBuys - yesSells);
            const netNo = Math.max(0, noBuys - noSells);
            
            currentVal = outcome === true ? netYes : netNo;
            resolvedMarketsCount++;
            
            const marketPnL = (totalReceived + currentVal) - totalPaid;
            if (marketPnL > 0.05) {
              winningMarketsCount++;
            }
          } else {
            if (cached) {
              try {
                const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
                  address: marketAddress,
                  abi: [{
                    name: 'getMarketInfo',
                    type: 'function',
                    stateMutability: 'view',
                    inputs: [],
                    outputs: [
                      { name: '_slug', type: 'string' },
                      { name: '_deadline', type: 'uint256' },
                      { name: '_resolved', type: 'bool' },
                      { name: '_outcome', type: 'bool' },
                      { name: '_yesOutstanding', type: 'uint256' },
                      { name: '_noOutstanding', type: 'uint256' }
                    ]
                  }],
                  functionName: 'getMarketInfo'
                });
                
                const poolYes = Number(yesOutstanding) / 1_000_000;
                const poolNo = Number(noOutstanding) / 1_000_000;
                const bVal = 10;
                const maxQ = Math.max(poolYes, poolNo);
                const expYes = Math.exp((poolYes - maxQ) / bVal);
                const expNo = Math.exp((poolNo - maxQ) / bVal);
                yesPrice = expYes / (expYes + expNo);
                noPrice = expNo / (expYes + expNo);
              } catch (e) {
                // Keep default 0.5
              }
            }
            currentVal = yesShares * yesPrice + noShares * noPrice;
          }
          
          const marketPnL = (totalReceived + currentVal) - totalPaid;
          totalPnL += marketPnL;
          
          // Win rate counts every market the user put money into:
          // a "win" is positive PnL (realized for resolved markets,
          // mark-to-market for open ones). Converges to the realized
          // win rate as markets resolve.
          if (totalPaid > 0.001) {
            marketsTradedCount++;
            if (marketPnL > 0.001) profitableMarketsCount++;
          }
        }
        
        // Prefer realized win rate once enough markets have resolved;
        // fall back to mark-to-market so the leaderboard isn't all 0%.
        const winRate = resolvedMarketsCount >= 3
          ? (winningMarketsCount / resolvedMarketsCount) * 100
          : marketsTradedCount > 0
            ? (profitableMarketsCount / marketsTradedCount) * 100
            : 0;
        
        // Ensure profile exists (gracefully skip if profiles table missing)
        try {
          let displayName = 'Puls Trader';
          let avatarUrl = null;
          
          if (userId.startsWith('supabase_')) {
            try {
              const { data: existingProf } = await supabase
                .from('profiles')
                .select('*')
                .eq('user_id', userId)
                .single();
              if (existingProf) {
                displayName = existingProf.display_name;
                avatarUrl = existingProf.avatar_url;
              } else {
                avatarUrl = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${userId}`;
                await supabase.from('profiles').insert({
                  user_id: userId,
                  display_name: displayName,
                  avatar_url: avatarUrl,
                  bio: 'Trading prediction markets on Arc Testnet.'
                });
              }
            } catch (_) { /* profiles table may not exist yet */ }
          } else if (userId.startsWith('eth_')) {
            const addr = userId.replace('eth_', '');
            displayName = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
            avatarUrl = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
            
            try {
              await supabase.from('profiles').upsert({
                user_id: userId,
                display_name: displayName,
                avatar_url: avatarUrl,
                bio: 'Trading via MetaMask on Arc Testnet.'
              }, { onConflict: 'user_id' });
            } catch (_) { /* profiles table may not exist yet */ }
          }
        } catch (_) { /* profiles table may not exist yet */ }
        
        leaderboardStats.set(userId, {
          user_id: userId,
          is_agent: userId === HOUSE_AGENT_USER || userId.startsWith('agent_'),
          volume: parseFloat(totalVolume.toFixed(2)),
          pnl: parseFloat(totalPnL.toFixed(2)),
          trades_count: tradesCount,
          win_rate: parseFloat(winRate.toFixed(1)),
          updated_at: new Date().toISOString()
        });

        
      } catch (err) {
        console.error(`Error calculating leaderboard stats for user ${userId}:`, err.message);
      }
    }
    leaderboardCache.clear(); // serve fresh stats promptly
    console.log(`Leaderboard updated successfully (${leaderboardStats.size} traders).`);
  } catch (e) {
    console.error('updateLeaderboard error:', e.message);
  }
}

// Run leaderboard update every 10 minutes
setInterval(updateLeaderboard, 10 * 60 * 1000);

// In-memory leaderboard cache (60s TTL) to avoid Supabase rate limits
const leaderboardCache = new Map(); // key: "sort:limit" → { data, ts }
const LEADERBOARD_CACHE_TTL = 60_000; // 60 seconds

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { sort = 'pnl', limit = 50, type = 'all' } = req.query;
    const maxLimit = Math.min(500, parseInt(limit) || 50);
    const kind = ['all', 'humans', 'agents'].includes(type) ? type : 'all';
    const kindFilter = (row) => {
      const isAgent = row.is_agent === true || row.user_id === HOUSE_AGENT_USER || (row.user_id || '').startsWith('agent_');
      return kind === 'all' ? true : kind === 'agents' ? isAgent : !isAgent;
    };
    
    // Check cache first
    const cacheKey = `${sort}:${maxLimit}:${kind}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < LEADERBOARD_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    // Primary source: in-memory stats computed by the leaderboard cron
    // (the Supabase `leaderboard` table has a legacy schema — see updateLeaderboard)
    let leaderboardData = null;
    if (leaderboardStats.size > 0) {
      leaderboardData = Array.from(leaderboardStats.values())
        .filter(kindFilter)
        .sort((a, b) => sort === 'volume' ? b.volume - a.volume : b.pnl - a.pnl)
        .slice(0, maxLimit);
    }
    
    // Fallback (cron hasn't completed yet, e.g. right after boot): quick compute from trades
    if (!leaderboardData || leaderboardData.length === 0) {
      try {
        const { data: allTrades, error: tradesError } = await supabase
          .from('trades')
          .select('user_id, side, usdc_amount, state, question')
          .eq('state', 'COMPLETE')
          .limit(5000);
        
        if (tradesError) {
          console.warn('Leaderboard trades fallback failed:', tradesError.message);
        } else if (allTrades && allTrades.length > 0) {
          const userStats = {};
          for (const t of allTrades) {
            if (!t.user_id) continue;
            // Same humans-vs-agents bucketing as the cron (see updateLeaderboard)
            const isAgentTrade = typeof t.question === 'string' && t.question.startsWith('🤖 Agent:');
            const key = t.user_id === HOUSE_AGENT_USER
              ? HOUSE_AGENT_USER
              : (isAgentTrade ? `agent_${t.user_id}` : t.user_id);
            if (!userStats[key]) {
              userStats[key] = { volume: 0, pnl: 0, trades_count: 0, win_rate: 0 };
            }
            const s = userStats[key];
            s.trades_count++;
            s.volume += Math.abs(parseFloat(t.usdc_amount || 0));
          }
          leaderboardData = Object.entries(userStats)
            .map(([userId, stats]) => ({
              user_id: userId,
              is_agent: userId === HOUSE_AGENT_USER || userId.startsWith('agent_'),
              ...stats,
              volume: parseFloat(stats.volume.toFixed(2))
            }))
            .filter(kindFilter)
            .sort((a, b) => sort === 'volume' ? b.volume - a.volume : b.pnl - a.pnl)
            .slice(0, maxLimit);
        }
      } catch (e) {
        console.warn('Leaderboard trades fallback error:', e.message);
      }
    }
    
    if (!leaderboardData) leaderboardData = [];
    
    // Enrich with actual profile display names and avatars. For user agents
    // (agent_<ownerId>) also fetch the OWNER's profile so the agent can be
    // labelled "<owner>'s Agent".
    let profilesMap = {};
    if (leaderboardData.length > 0) {
      try {
        const userIds = new Set();
        for (const r of leaderboardData) {
          if (!r.user_id) continue;
          userIds.add(r.user_id);
          if (r.user_id.startsWith('agent_')) userIds.add(r.user_id.slice(6));
        }
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, display_name, avatar_url, bio')
          .in('user_id', [...userIds]);
        if (profiles) {
          for (const p of profiles) {
            profilesMap[p.user_id] = p;
          }
        }
      } catch (_) { /* profiles table may not exist */ }
    }
    
    // Format response with real profile data, falling back to defaults
    const formatted = leaderboardData.map(row => {
      const isAgent = row.is_agent === true || row.user_id === HOUSE_AGENT_USER || (row.user_id || '').startsWith('agent_');
      const profile = profilesMap[row.user_id];
      let defaultName = 'Puls Trader';
      let defaultAvatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${row.user_id}`;
      let erc8004Id = null;
      if (row.user_id?.startsWith('eth_')) {
        const addr = row.user_id.replace('eth_', '');
        defaultName = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        defaultAvatar = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
      } else if (row.user_id === HOUSE_AGENT_USER) {
        defaultName = 'Pulse · House Agent';
        defaultAvatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=pulse-house`;
        erc8004Id = agentTokenIds.get(HOUSE_AGENT_KEY) ?? null;
      } else if (row.user_id?.startsWith('agent_')) {
        const ownerProfile = profilesMap[row.user_id.slice(6)];
        const ownerName = ownerProfile?.display_name || 'Puls Trader';
        defaultName = `${ownerName}'s Agent`;
        erc8004Id = agentTokenIds.get(row.user_id) ?? null;
      }
      return {
        userId: row.user_id,
        isAgent,
        erc8004Id,
        volume: parseFloat(row.volume || 0),
        pnl: parseFloat(row.pnl || 0),
        tradesCount: row.trades_count || 0,
        winRate: parseFloat(row.win_rate || 0),
        displayName: profile?.display_name || defaultName,
        avatarUrl: profile?.avatar_url || defaultAvatar,
        bio: profile?.bio || (isAgent ? 'Autonomous AI trading agent with on-chain ERC-8004 identity.' : '')
      };
    });
    
    // Cache the result
    leaderboardCache.set(cacheKey, { data: formatted, ts: Date.now() });
    
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    let profile = null;
    const { data: profData, error: profErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .single();
      
    if (profErr) {
      if (profErr.code === '42P01' || profErr.message?.includes('does not exist')) {
        console.warn(`Profiles table does not exist. Returning default profile for ${userId}`);
      } else if (profErr.code !== 'PGRST116') {
        console.error(`Profile fetch error for user ${userId}:`, profErr.message);
      }
    } else {
      profile = profData;
    }
    
    if (!profile) {
      // Return a default profile if it doesn't exist yet but has trades
      let name = 'Puls Trader';
      let avatar = `https://api.dicebear.com/7.x/bottts/png?size=128&seed=${userId}`;
      if (userId.startsWith('eth_')) {
        const addr = userId.replace('eth_', '');
        name = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
        avatar = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${addr}`;
      }
      profile = {
        user_id: userId,
        display_name: name,
        avatar_url: avatar,
        bio: 'Active trader on PulsMarket.'
      };
    }
    
    // Stats come from the in-memory leaderboard (legacy Supabase table is unusable)
    const stats = leaderboardStats.get(userId) || null;
    
    let trades = [];
    const { data: tradesData, error: tradesErr } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('state', 'COMPLETE')
      .order('created_at', { ascending: false })
      .limit(50);
      
    if (tradesErr) {
      if (tradesErr.code === '42P01' || tradesErr.message?.includes('does not exist')) {
        console.warn(`Trades table does not exist. Using empty trades list for ${userId}`);
      }
    } else {
      trades = tradesData ?? [];
    }
      
    res.json({
      profile,
      stats: stats ? {
        volume: parseFloat(stats.volume),
        pnl: parseFloat(stats.pnl),
        tradesCount: stats.trades_count,
        winRate: parseFloat(stats.win_rate)
      } : { volume: 0, pnl: 0, tradesCount: 0, winRate: 0 },
      trades
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/profile/update', authenticateUser, strictLimiter, async (req, res) => {
  try {
    let { userId, displayName, bio, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    if (req.user) {
      const expectedUserId = `supabase_${req.user.id}`;
      if (userId !== expectedUserId) {
        return res.status(403).json({ error: 'Forbidden: User identity mismatch' });
      }
      userId = expectedUserId;
    }
    
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        user_id: userId,
        display_name: displayName,
        bio: bio,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      
    if (error) {
      // If profiles table doesn't exist yet, return ok with warning
      if (error.message?.includes('schema cache') || error.message?.includes('does not exist')) {
        console.warn('Profile update skipped — profiles table not found.');
        return res.json({ ok: true, warning: 'Profile saved locally only — profiles table pending migration.' });
      }
      throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agentic Economy (ERC-8004 + autonomous trading) ───────────────────────────

// Agent LLM providers: primary + ordered fallbacks. Configure via env —
// AGENT_LLM_URL / AGENT_LLM_KEY / AGENT_MODEL is the primary; numbered suffixes
// _2, _3, … add fallbacks tried in order. A provider is skipped unless it has a
// URL, key AND model. URLs may be a base ("…/v1") — "/chat/completions" is
// appended automatically when missing. All keys live in .env, never in the repo.
function buildLlmProviders() {
  const list = [];
  for (const sfx of ['', '_2', '_3', '_4', '_5']) {
    let url = (process.env[`AGENT_LLM_URL${sfx}`] || '').trim();
    const key = (process.env[`AGENT_LLM_KEY${sfx}`] || '').trim();
    const model = (process.env[`AGENT_MODEL${sfx}`] || '').trim();
    if (!url || !key || !model) continue;
    if (!/\/(chat\/)?completions\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions';
    list.push({ url, key, model });
  }
  return list;
}
const LLM_PROVIDERS = buildLlmProviders();
const LLM_TIMEOUT_MS = parseInt(process.env.AGENT_LLM_TIMEOUT_MS || '60000', 10);
const LLM_RETRIES = Math.max(1, parseInt(process.env.AGENT_LLM_RETRIES || '1', 10)); // attempts per provider
if (LLM_PROVIDERS.length === 0) {
  console.warn('[llm] No agent LLM providers configured (set AGENT_LLM_URL/KEY/MODEL).');
} else {
  console.log(`[llm] ${LLM_PROVIDERS.length} provider(s): ${LLM_PROVIDERS.map(p => p.model).join(' → ')}`);
}
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const AGENT_METADATA_URI = 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei';

async function getAgent(userId) {
  const walletId = await getWalletId(`agent_${userId}`);
  if (!walletId) return null;
  const info = await getWalletInfo(walletId);
  return { walletId, address: info.address, balance: info.usdcBalance };
}

// In-memory guard so we only register each agent on ERC-8004 once per process.
const registeredAgents = new Set();
const agentTokenIds = new Map();   // agentKey -> ERC-8004 token id (string)
const agentRepCount = new Map();   // agentKey -> number of reputation events recorded

// Find an agent's ERC-8004 token id from the IdentityRegistry Transfer (mint) event.
async function resolveAgentTokenId(agentKey, agentAddress) {
  if (agentTokenIds.has(agentKey)) return agentTokenIds.get(agentKey);
  try {
    const latest = await publicClient.getBlockNumber();
    const fromBlock = latest > 9000n ? latest - 9000n : 0n;
    const logs = await publicClient.getLogs({
      address: IDENTITY_REGISTRY,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'),
      args: { to: agentAddress },
      fromBlock,
      toBlock: latest,
    });
    if (logs.length > 0) {
      const id = logs[logs.length - 1].args.tokenId.toString();
      agentTokenIds.set(agentKey, id);
      return id;
    }
  } catch (e) {
    console.error('resolveAgentTokenId error:', e.message);
  }
  return null;
}

// Record ERC-8004 reputation from the ADMIN wallet (an independent validator —
// ERC-8004 forbids an agent owner from rating its own agent). score 0..100.
async function recordAgentReputation(agentKey, agentAddress, score, tag) {
  try {
    if (!walletClient || !adminAccount) return;
    const tokenId = await resolveAgentTokenId(agentKey, agentAddress);
    if (!tokenId) return;
    await walletClient.writeContract({
      address: REPUTATION_REGISTRY,
      abi: [{
        name: 'giveFeedback', type: 'function', stateMutability: 'nonpayable',
        inputs: [
          { name: 'agentId', type: 'uint256' }, { name: 'score', type: 'int128' },
          { name: 'feedbackType', type: 'uint8' }, { name: 'tag', type: 'string' },
          { name: 'metadataURI', type: 'string' }, { name: 'evidenceURI', type: 'string' },
          { name: 'comment', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
        ],
        outputs: [],
      }],
      functionName: 'giveFeedback',
      args: [BigInt(tokenId), BigInt(score), 0, tag, '', '', '', keccak256(toHex(`${tag}-${Date.now()}`))],
    });
    agentRepCount.set(agentKey, (agentRepCount.get(agentKey) || 0) + 1);
  } catch (e) {
    console.error('recordAgentReputation error:', e.shortMessage || e.message);
  }
}

// Streams an OpenAI-compatible SSE chat completion from ONE provider.
async function llmCompleteOne(provider, messages, signal) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages, stream: true }),
    signal,
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const c = j.choices?.[0]?.delta?.content;
        if (c) out += c;
      } catch (_) {}
    }
  }
  return out.trim();
}

// Tries each configured provider in priority order (primary → fallbacks) with a
// per-attempt timeout and optional retries. Returns the first successful result.
async function llmComplete(messages) {
  if (LLM_PROVIDERS.length === 0) throw new Error('Agent LLM key not configured');
  const errors = [];
  for (let i = 0; i < LLM_PROVIDERS.length; i++) {
    const provider = LLM_PROVIDERS[i];
    for (let attempt = 1; attempt <= LLM_RETRIES; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);
      try {
        const out = await llmCompleteOne(provider, messages, ac.signal);
        clearTimeout(timer);
        if (!out) throw new Error('empty completion');
        if (i > 0) console.log(`[llm] served by fallback #${i + 1} (${provider.model})`);
        return out;
      } catch (e) {
        clearTimeout(timer);
        const reason = ac.signal.aborted ? `timeout after ${LLM_TIMEOUT_MS}ms` : (e.message || String(e));
        errors.push(`${provider.model}: ${reason}`);
        console.error(`[llm] provider #${i + 1} (${provider.model}) attempt ${attempt}/${LLM_RETRIES} failed: ${reason}`);
      }
    }
  }
  throw new Error(`All LLM providers failed → ${errors.join(' | ')}`);
}

// The Puls app renders Telegram/Slack-style markdown where a SINGLE asterisk = bold.
// LLMs emit standard markdown (**bold**, ## headings), so normalise their prose to
// the app's flavour before sending it to the client. Idempotent & safe on plain text.
function formatForApp(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // ATX headings (#, ##, ### …) → a bold line
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
    // bold+italic ***x*** → *x*
    .replace(/\*\*\*([^\n*][^\n]*?)\*\*\*/g, '*$1*')
    // bold **x** → *x*
    .replace(/\*\*([^\n*][^\n]*?)\*\*/g, '*$1*')
    // __bold__ → *x*
    .replace(/__([^\n_][^\n]*?)__/g, '*$1*');
}

// Create (or fetch) a separate per-user agent wallet, funded from the user up to budget.
app.post('/api/agent/start', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, budget } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const budgetNum = Math.max(0, parseFloat(budget ?? '0'));
    const agentKey = `agent_${userId}`;

    let agentWalletId = await getWalletId(agentKey);
    let agentAddress;
    if (!agentWalletId) {
      const setId = await ensureWalletSet();
      const createRes = await circle.createWallets({
        accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
      });
      const w = createRes.data.wallets[0];
      agentWalletId = w.id;
      agentAddress = w.address;
      await saveWallet(agentKey, w.id);
    } else {
      agentAddress = (await getWalletInfo(agentWalletId)).address;
    }

    // Fund the agent wallet from the user's wallet up to the requested budget.
    // The agent's USDC balance IS the budget cap — it cannot spend more than it holds.
    const userWalletId = await getWalletId(userId);
    let funded = 0;
    if (userWalletId && budgetNum > 0) {
      const current = parseFloat((await getWalletInfo(agentWalletId)).usdcBalance) || 0;
      const need = budgetNum - current;
      if (need > 0.01) {
        try {
          const tx = await circle.createTransaction({
            walletId: userWalletId,
            tokenAddress: USDC,
            blockchain: 'ARC-TESTNET',
            destinationAddress: agentAddress,
            amount: [need.toFixed(6)],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
          });
          funded = need;
          // Wait for the transfer to settle so the agent balance reflects the funds.
          const txId = tx.data?.id;
          for (let i = 0; txId && i < 20; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const st = await circle.getTransaction({ id: txId });
            const s = st.data?.transaction?.state;
            if (s === 'COMPLETE') break;
            if (s === 'FAILED' || s === 'DENIED') { funded = 0; break; }
          }
        } catch (e) {
          console.error('agent funding error:', e.message);
        }
      }
    }

    // ERC-8004: register the agent's onchain identity once per process.
    let registered = registeredAgents.has(agentKey);
    if (!registered) {
      try {
        await circle.createContractExecutionTransaction({
          walletId: agentWalletId,
          contractAddress: IDENTITY_REGISTRY,
          abiFunctionSignature: 'register(string)',
          abiParameters: [AGENT_METADATA_URI],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });
        registeredAgents.add(agentKey);
        registered = true;
        // Give the mint a moment, then cache the agent's ERC-8004 token id.
        await new Promise(r => setTimeout(r, 3000));
        await resolveAgentTokenId(agentKey, agentAddress);
      } catch (e) {
        console.error('ERC-8004 register error:', e.message);
      }
    } else {
      resolveAgentTokenId(agentKey, agentAddress).catch(() => {});
    }

    const balance = parseFloat((await getWalletInfo(agentWalletId)).usdcBalance) || 0;
    res.json({
      agentAddress,
      budget: balance + funded, // reflects post-funding balance even before settlement
      balance,
      funded,
      registered,
      agentId: agentTokenIds.get(agentKey) ?? null,
      reputation: agentRepCount.get(agentKey) ?? 0,
      identityRegistry: IDENTITY_REGISTRY,
    });
  } catch (e) {
    console.error('agent start error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agent/status', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const agent = await getAgent(req.query.userId);
    if (!agent) return res.json({ exists: false });
    res.json({
      exists: true,
      agentAddress: agent.address,
      balance: agent.balance,
      registered: registeredAgents.has(`agent_${req.query.userId}`),
      agentId: agentTokenIds.get(`agent_${req.query.userId}`) ?? null,
      reputation: agentRepCount.get(`agent_${req.query.userId}`) ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add more USDC from the user's wallet into the agent wallet (top-up after withdraw, etc.).
app.post('/api/agent/deposit', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    const agent = await getAgent(userId);
    if (!agent) return res.status(400).json({ error: 'No agent' });
    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'No user wallet' });

    const tx = await circle.createTransaction({
      walletId: userWalletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: agent.address,
      amount: [amt.toFixed(6)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    // Wait for settle so the returned balance reflects the deposit.
    const txId = tx.data?.id;
    let ok = true;
    for (let i = 0; txId && i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const s = (await circle.getTransaction({ id: txId })).data?.transaction?.state;
      if (s === 'COMPLETE') break;
      if (s === 'FAILED' || s === 'DENIED') { ok = false; break; }
    }
    const balance = parseFloat((await getWalletInfo(agent.walletId)).usdcBalance) || 0;
    res.json({ deposited: ok ? amt : 0, balance });
  } catch (e) {
    console.error('agent deposit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Return the agent's remaining USDC back to the user's wallet.
app.post('/api/agent/withdraw', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const agent = await getAgent(userId);
    if (!agent) return res.status(400).json({ error: 'No agent' });
    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'No user wallet' });
    const userAddress = (await getWalletInfo(userWalletId)).address;
    const balance = parseFloat(agent.balance) || 0;
    if (balance < 0.01) return res.json({ withdrawn: 0, balance: 0 });

    const tx = await circle.createTransaction({
      walletId: agent.walletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: userAddress,
      amount: [balance.toFixed(6)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    res.json({ withdrawn: balance, txId: tx.data?.id });
  } catch (e) {
    console.error('agent withdraw error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat with the agent. The LLM returns a structured intent; the backend validates
// budget + market and executes the buy autonomously from the agent wallet.
app.post('/api/agent/chat', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

    const agent = await getAgent(userId);
    if (!agent) return res.status(400).json({ error: 'Agent not started' });

    // Budget = the agent wallet's own balance (on-chain cap, cannot overspend).
    const remaining = parseFloat(agent.balance) || 0;

    // Pull the live feed (same source as /api/markets) so the agent knows real markets.
    // Mark which are already deployed (instant) and keep their deadline for on-demand deploy.
    let feed = [];
    try {
      const pmRes = await fetch('https://gamma-api.polymarket.com/markets?limit=40&active=true&closed=false&order=volume&ascending=false', { headers: { Accept: 'application/json' } });
      if (pmRes.ok) {
        const list = await pmRes.json();
        const nowSec = Math.floor(Date.now() / 1000);
        feed = list.map(j => {
          const slug = j.slug;
          const cached = deployedMarketsCache.get(slug);
          const endRaw = j.endDate || j.endDateIso;
          const feedDeadline = endRaw ? Math.floor(new Date(endRaw).getTime() / 1000) : nowSec + 30 * 86400;
          // For deployed markets, the contract's deadline (cached at deploy) is authoritative.
          const deadline = cached?.deadline ? Number(cached.deadline) : feedDeadline;
          const resolved = cached?.resolved === true;
          return { slug, question: j.question || slug, deployed: !!cached, deadline, resolved };
        }).filter(m => m.slug && !m.resolved && m.deadline > nowSec + 3600); // exclude expired/resolved
        // Deployed-first so the LLM tends to pick instant, tradeable markets.
        feed.sort((a, b) => (b.deployed ? 1 : 0) - (a.deployed ? 1 : 0));
        feed = feed.slice(0, 25);
      }
    } catch (e) {
      console.error('agent feed fetch error:', e.message);
    }
    const feedBySlug = Object.fromEntries(feed.map(m => [m.slug, m]));

    const marketLines = feed.map(m => `- ${m.slug}: "${m.question}"${m.deployed ? ' [ready]' : ''}`).join('\n');
    const sys = `You are Puls Agent, an autonomous trading agent on Arc Testnet with ${remaining.toFixed(2)} USDC to spend.
These are the live prediction markets you can trade (slug: question):
${marketLines || '(none available)'}
When the user wants you to buy, pick the most relevant market and respond with ONE line of JSON only:
{"action":"buy","slug":"<exact slug from the list>","side":"YES|NO","usdcAmount":<number <= ${remaining.toFixed(2)}>,"reply":"<short explanation of your pick>"}
Otherwise respond: {"action":"none","reply":"<your message>"}
Never exceed your budget. Prefer markets marked [ready]. Output ONLY the JSON object.`;

    let intent = { action: 'none', reply: '' };
    try {
      const raw = await llmComplete([
        { role: 'system', content: sys },
        { role: 'user', content: message },
      ]);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) intent = JSON.parse(m[0]);
      else intent.reply = raw;
    } catch (e) {
      return res.status(502).json({ error: `LLM error: ${e.message}` });
    }

    // Validate + execute autonomously within budget.
    let trade = null;
    let spentNow = 0;
    if (intent.action === 'buy') {
      const slug = intent.slug;
      const amount = parseFloat(intent.usdcAmount);
      const side = intent.side === 'NO' ? 'NO' : 'YES';
      const market = feedBySlug[slug] || (deployedMarketsCache.has(slug) ? { slug, deadline: deployedMarketsCache.get(slug).deadline } : null);
      if (!market) {
        intent.reply = `I can't trade "${slug}" — it isn't in the live feed.`;
      } else if (market.deadline && market.deadline <= Math.floor(Date.now() / 1000)) {
        intent.reply = `I can't trade "${slug}" — that market has already closed. Pick another one.`;
      } else if (!(amount > 0) || amount > remaining) {
        intent.reply = `That would exceed my remaining budget of ${remaining.toFixed(2)} USDC.`;
      } else {
        try {
          // Deploy-on-demand if needed (instant if already deployed).
          const contractAddress = await getOrDeployMarket(slug, market.deadline);

          // Verify the CONTRACT's actual on-chain deadline (cached markets may have a
          // stale/past deadline that differs from the live feed) before attempting a buy.
          try {
            const info = await publicClient.readContract({
              address: contractAddress,
              abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
                { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
                { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
                { name: '_yesOutstanding', type: 'uint256' }, { name: '_noOutstanding', type: 'uint256' } ] }],
              functionName: 'getMarketInfo',
            });
            const onChainDeadline = Number(info[1]);
            const onChainResolved = info[2];
            if (onChainResolved || onChainDeadline <= Math.floor(Date.now() / 1000)) {
              return res.json({ reply: `That market is already closed on-chain. Ask me to pick a different one.`, trade: null, remaining });
            }
          } catch (_) {}

          const amountMicro = Math.round(amount * 1_000_000).toString();
          if (!(await isApproved(agent.walletId, contractAddress))) {
            const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
            await circle.createContractExecutionTransaction({
              walletId: agent.walletId, contractAddress: USDC,
              abiFunctionSignature: 'approve(address,uint256)', abiParameters: [contractAddress, MAX],
              fee: { type: 'level', config: { feeLevel: 'HIGH' } },
            });
            await new Promise(r => setTimeout(r, 4500));
          }
          const txRes = await circle.createContractExecutionTransaction({
            walletId: agent.walletId, contractAddress,
            abiFunctionSignature: side === 'YES' ? 'buyYes(uint256)' : 'buyNo(uint256)',
            abiParameters: [amountMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
          const circleId = txRes.data.id;
          // Poll for the on-chain tx hash + final state (Circle returns a UUID, not a 0x hash).
          let txHash = null, finalState = null;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1500));
            try {
              const st = await circle.getTransaction({ id: circleId });
              const tx = st.data?.transaction;
              if (tx?.txHash) txHash = tx.txHash;
              finalState = tx?.state;
              if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
            } catch (_) {}
          }
          if (['FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) {
            intent.reply = `The trade didn't go through (on-chain ${finalState.toLowerCase()}). Your budget is unchanged — try a different market or amount.`;
          } else {
            await saveTrade(userId, {
              tx_id: circleId, side, usdc_amount: amount, entry_price: 0.5,
              question: `🤖 Agent: ${market.question || slug}`, market_id: contractAddress,
              state: finalState === 'COMPLETE' ? 'COMPLETE' : 'INITIATED', tx_hash: txHash,
            });
            spentNow = amount;
            trade = { slug, side, usdcAmount: amount, txHash, txId: circleId, contractAddress };
            // ERC-8004: an independent validator (admin wallet) attests the agent
            // executed a successful trade. Non-blocking so the chat stays snappy.
            recordAgentReputation(`agent_${userId}`, agent.address, 90, 'successful_trade').catch(() => {});
          }
        } catch (e) {
          intent.reply = `Trade failed: ${e.message}`;
        }
      }
    }

    res.json({ reply: formatForApp(intent.reply) || 'Done.', trade, remaining: Math.max(0, remaining - spentNow), reputation: agentRepCount.get(`agent_${userId}`) ?? 0 });
  } catch (e) {
    console.error('agent chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/copilot/chat
// An interactive AI copilot helping the user analyze a specific prediction market.
app.post('/api/copilot/chat', authenticateUser, strictLimiter, async (req, res) => {
  try {
    const { userId, message, question, slug, currentYesPrice, currentNoPrice } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: 'userId and message are required' });
    }

    const sys = `You are Puls AI Trading Copilot, an expert prediction market analyst.
You are helping the user analyze the following prediction market:
- Question: "${question || 'Unknown Prediction'}"
- Slug: "${slug || 'unknown-slug'}"
- Current YES Price: ${currentYesPrice ? (parseFloat(currentYesPrice) * 100).toFixed(0) + '¢' : '50¢'}
- Current NO Price: ${currentNoPrice ? (parseFloat(currentNoPrice) * 100).toFixed(0) + '¢' : '50¢'}

Your goals:
1. Provide insight on market sentiment, historical context, and potential resolution.
2. Suggest trading strategies (e.g. buying YES vs buying NO depending on news/odds).
3. If they ask for a strategy, you can propose one and end with a structured action recommendation.
4. Keep your replies helpful, concise (maximum 3 short paragraphs), and formatting clean. For bold use a SINGLE asterisk like *this* (never double **), and do not use markdown headings (#).
5. If suggesting a trade, format the final recommendation on a new line like:
[TRADE RECOMMENDATION]: BUY YES or BUY NO with short rationale.`;

    const reply = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: message },
    ]);

    res.json({ reply: formatForApp(reply) });
  } catch (e) {
    console.error('copilot chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Push Notifications & In-App Notifications ─────────────────────────────────

async function createNotification(userId, title, message, type) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        message,
        type,
        read: false
      });
      
    if (error) {
      console.error('[Notification Error] Failed to save in-app notification:', error.message);
    } else {
      console.log(`[Notification] Saved notification for user ${userId}: "${title}"`);
    }

    // Try to retrieve user's FCM token for push delivery
    const { data: tokenRow } = await supabase
      .from('fcm_tokens')
      .select('fcm_token')
      .eq('user_id', userId)
      .single();
      
    if (tokenRow && tokenRow.fcm_token) {
      console.log(`[Notification Push] Simulating push notification to ${tokenRow.fcm_token}: "${title}" - "${message}"`);
    }
  } catch (err) {
    console.error('[Notification Error] Failed to trigger notification:', err.message);
  }
}

// POST /api/notifications/register-token
app.post('/api/notifications/register-token', authenticateUser, strictLimiter, async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;
    if (!userId || !fcmToken) return res.status(400).json({ error: 'userId and fcmToken required' });
    
    const { error } = await supabase
      .from('fcm_tokens')
      .upsert({
        user_id: userId,
        fcm_token: fcmToken,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/notifications
app.get('/api/notifications', authenticateUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
      
    if (error) throw error;
    // Return an object (not a bare array): the Flutter client decodes every
    // response body as a Map and reads res['notifications'], so a bare array
    // makes the cast throw and the bell silently shows nothing.
    res.json({ notifications: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/mark-read
app.post('/api/notifications/mark-read', authenticateUser, async (req, res) => {
  try {
    const { userId, notificationId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    let query = supabase.from('notifications').update({ read: true }).eq('user_id', userId);
    if (notificationId) {
      query = query.eq('id', notificationId);
    }
    
    const { error } = await query;
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── User-Created Markets ─────────────────────────────────────────────────────

app.post('/api/markets/create', authenticateUser, requireVerifiedUser, strictLimiter, async (req, res) => {
  try {
    const { userId, question, description, category, deadline } = req.body;
    if (!userId || !question || !deadline) {
      return res.status(400).json({ error: 'userId, question and deadline required' });
    }

    const userWalletId = await getWalletId(userId);
    if (!userWalletId) return res.status(400).json({ error: 'User wallet not found' });
    const userWalletInfo = await getWalletInfo(userWalletId);
    
    // Check user balance: lockup cost is ~10 USDC initial funding
    const creatorUSDCBalance = parseFloat(userWalletInfo.usdcBalance) || 0;
    if (creatorUSDCBalance < 10) {
      return res.status(400).json({
        error: `Insufficient balance to create a market. Locked initial funding requires 10.00 USDC. Your balance is $${creatorUSDCBalance.toFixed(2)}.`
      });
    }

    // 1. Transfer 10 USDC from user to admin
    console.log(`[Custom Market] Transferring 10 USDC initial funding from creator ${userWalletInfo.address} to admin...`);
    const tx = await circle.createTransaction({
      walletId: userWalletId,
      tokenAddress: USDC,
      blockchain: 'ARC-TESTNET',
      destinationAddress: adminAccount.address,
      amount: ['10.000000'],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    
    const txId = tx.data?.id;
    let transferSuccess = false;
    for (let i = 0; txId && i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const st = await circle.getTransaction({ id: txId });
      if (st.data?.transaction?.state === 'COMPLETE') {
        transferSuccess = true;
        break;
      }
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(st.data?.transaction?.state)) break;
    }
    
    if (!transferSuccess) {
      return res.status(500).json({ error: 'Failed to process initial funding transfer' });
    }

    // 2. Deploy market contract via admin deployer
    const slug = `user-${question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now()}`;
    const deadlineSeconds = Number(deadline);
    
    console.log(`[Custom Market] Deploying on-chain contract for custom market: ${slug}`);
    const contractAddress = await getOrDeployMarket(slug, deadlineSeconds);
    
    // 3. Update database row with custom fields
    await supabase.from('deployed_markets').update({
      is_user_created: true,
      creator_id: userId,
      title: question,
      description: description || '',
      category: category || 'General',
      image_url: `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`
    }).eq('slug', slug);

    // Update local cache manually with new properties
    const cached = deployedMarketsCache.get(slug);
    if (cached) {
      cached.is_user_created = true;
      cached.creator_id = userId;
      cached.title = question;
      cached.description = description || '';
      cached.category = category || 'General';
      cached.image_url = `https://api.dicebear.com/7.x/identicon/png?size=128&seed=${slug}`;
    }

    // Notify user
    createNotification(
      userId,
      'Market Created 🎉',
      `Your custom market "${question}" has been deployed on Arc Testnet!`,
      'system'
    ).catch(console.error);

    res.json({ slug, contractAddress });
  } catch (e) {
    console.error('[Custom Market Error] Failed to create custom market:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Limit Orders Engine ──────────────────────────────────────────────────────

// POST /api/trade/limit-order
app.post('/api/trade/limit-order', authenticateUser, requireVerifiedUser, tradeLimiter, async (req, res) => {
  try {
    const { userId, marketId, slug, side, type, usdcAmount, shares, targetPrice } = req.body;
    if (!userId || !marketId || !slug || !side || !type || targetPrice === undefined) {
      return res.status(400).json({ error: 'Missing required limit order parameters' });
    }

    const walletId = await getWalletId(userId);
    if (!walletId) return res.status(400).json({ error: 'User wallet not found' });
    
    // Enforce balance verification
    const walletInfo = await getWalletInfo(walletId);
    if (type === 'BUY') {
      const amount = parseFloat(usdcAmount);
      const balance = parseFloat(walletInfo.usdcBalance) || 0;
      if (balance < amount) {
        return res.status(400).json({ error: `Insufficient USDC. Balance: $${balance.toFixed(2)}, Need: $${amount.toFixed(2)}.` });
      }
    }
    
    // Write limit order to Supabase
    const { data, error } = await supabase
      .from('limit_orders')
      .insert({
        user_id: userId,
        market_id: marketId,
        slug,
        side, // 'YES' or 'NO'
        type, // 'BUY' or 'SELL'
        usdc_amount: type === 'BUY' ? parseFloat(usdcAmount) : 0,
        shares: type === 'SELL' ? parseFloat(shares) : 0,
        target_price: parseFloat(targetPrice),
        status: 'PENDING'
      })
      .select()
      .single();
      
    if (error) throw error;
    
    createNotification(
      userId,
      'Limit Order Placed 🎯',
      `Placed limit ${type.toLowerCase()} order for ${side} at target price $${parseFloat(targetPrice).toFixed(2)}`,
      'limit_order'
    ).catch(console.error);

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/trade/limit-orders
app.get('/api/trade/limit-orders', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const { data, error } = await supabase
      .from('limit_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    // Object, not bare array: the client reads res['orders'] (decodes body as
    // a Map), so a bare array would throw and the limit-orders list stays empty.
    res.json({ orders: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trade/limit-order/cancel
app.post('/api/trade/limit-order/cancel', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId, orderId } = req.body;
    if (!userId || !orderId) return res.status(400).json({ error: 'userId and orderId required' });
    
    const { data, error } = await supabase
      .from('limit_orders')
      .update({ status: 'CANCELLED' })
      .eq('id', orderId)
      .eq('user_id', userId)
      .select()
      .single();
      
    if (error) throw error;
    
    createNotification(
      userId,
      'Order Cancelled 🚫',
      `Limit order for ${data.side} at target price $${parseFloat(data.target_price).toFixed(2)} was cancelled.`,
      'limit_order'
    ).catch(console.error);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The Limit Orders Execution Engine (monitors and triggers trades on-chain)
let _limitOrdersTableMissing = false;
async function checkAndExecuteLimitOrders() {
  if (_limitOrdersTableMissing) return; // Skip silently if table doesn't exist
  console.log('Running limit orders matching check...');
  try {
    const { data: pendingOrders, error } = await supabase
      .from('limit_orders')
      .select('*')
      .eq('status', 'PENDING');
      
    if (error) {
      if (error.message?.includes('schema cache')) {
        console.warn('Limit orders table not found in schema — disabling cron until restart.');
        _limitOrdersTableMissing = true;
      } else {
        console.error('Failed to load pending limit orders:', error.message);
      }
      return;
    }
    
    if (!pendingOrders || pendingOrders.length === 0) {
      console.log('No pending limit orders to check.');
      return;
    }
    
    console.log(`Checking ${pendingOrders.length} pending limit orders...`);
    
    for (const order of pendingOrders) {
      try {
        const { id: orderId, user_id: userId, market_id: marketId, slug, side, type, usdc_amount: amount, shares, target_price: targetPrice } = order;
        
        let currentPrice = 0.5;
        let poolYes = 0;
        let poolNo = 0;
        
        try {
          const [slugOnChain, deadlineOnChain, resolvedOnChain, outcomeOnChain, yesOutstanding, noOutstanding] = await publicClient.readContract({
            address: marketId,
            abi: [
              {
                name: 'getMarketInfo',
                type: 'function',
                stateMutability: 'view',
                inputs: [],
                outputs: [
                  { name: '_slug', type: 'string' },
                  { name: '_deadline', type: 'uint256' },
                  { name: '_resolved', type: 'bool' },
                  { name: '_outcome', type: 'bool' },
                  { name: '_yesOutstanding', type: 'uint256' },
                  { name: '_noOutstanding', type: 'uint256' }
                ]
              }
            ],
            functionName: 'getMarketInfo'
          });

          poolYes = Number(yesOutstanding) / 1_000_000;
          poolNo = Number(noOutstanding) / 1_000_000;
          
          const bVal = 10;
          const maxQ = Math.max(poolYes, poolNo);
          const expYes = Math.exp((poolYes - maxQ) / bVal);
          const expNo = Math.exp((poolNo - maxQ) / bVal);
          const yesPrice = expYes / (expYes + expNo);
          const noPrice = expNo / (expYes + expNo);
          
          currentPrice = side === 'YES' ? yesPrice : noPrice;
        } catch (err) {
          console.error(`Failed to read current price for limit order ${orderId} on market ${marketId}:`, err.message);
          continue;
        }
        
        const isBuy = type === 'BUY';
        const conditionMet = isBuy ? (currentPrice <= targetPrice) : (currentPrice >= targetPrice);
        
        if (!conditionMet) {
          console.log(`Order ${orderId} condition not met: Current ${side} price is ${currentPrice.toFixed(4)}, Target is ${parseFloat(targetPrice).toFixed(4)}`);
          continue;
        }
        
        console.log(`🔥 Match found for order ${orderId}! Current ${side} price ${currentPrice.toFixed(4)} matches target ${parseFloat(targetPrice).toFixed(4)}.`);
        
        const { error: lockErr } = await supabase
          .from('limit_orders')
          .update({ status: 'EXECUTING' })
          .eq('id', orderId)
          .eq('status', 'PENDING');
          
        if (lockErr) continue; 
        
        const walletId = await getWalletId(userId);
        if (!walletId) {
          await supabase.from('limit_orders').update({ status: 'FAILED' }).eq('id', orderId);
          continue;
        }
        
        const isYes = side === 'YES';
        let txRes;
        
        if (isBuy) {
          const amountMicro = Math.round(parseFloat(amount) * 1_000_000).toString();
          
          if (!(await isApproved(walletId, marketId))) {
            const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
            await circle.createContractExecutionTransaction({
              walletId,
              contractAddress: USDC,
              abiFunctionSignature: 'approve(address,uint256)',
              abiParameters: [marketId, MAX],
              fee: { type: 'level', config: { feeLevel: 'HIGH' } },
            });
            await new Promise(r => setTimeout(r, 4500));
          }
          
          txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress: marketId,
            abiFunctionSignature: isYes ? 'buyYes(uint256)' : 'buyNo(uint256)',
            abiParameters: [amountMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
        } else {
          const sharesMicro = Math.round(parseFloat(shares) * 1_000_000).toString();
          txRes = await circle.createContractExecutionTransaction({
            walletId,
            contractAddress: marketId,
            abiFunctionSignature: isYes ? 'sellYes(uint256)' : 'sellNo(uint256)',
            abiParameters: [sharesMicro],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
          });
        }
        
        const circleId = txRes.data.id;
        
        // ── INITIATE TRADE RECORD FOR LIMIT ORDER IDEMPOTENCY ──
        const estimatedPayout = isBuy ? parseFloat(amount) : (parseFloat(shares) * currentPrice);
        let questionSlug = slug.split('-').join(' ');
        if (questionSlug.length > 0) {
          questionSlug = questionSlug.charAt(0).toUpperCase() + questionSlug.slice(1);
        }
        await saveTrade(userId, {
          tx_id: circleId,
          side,
          usdc_amount: isBuy ? estimatedPayout : -estimatedPayout,
          entry_price: currentPrice,
          question: `🎯 Limit: ${questionSlug}`,
          market_id: marketId,
          state: 'INITIATED',
        });
        
        let txHash = null, finalState = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const st = await circle.getTransaction({ id: circleId });
            txHash = st.data?.transaction?.txHash;
            finalState = st.data?.transaction?.state;
            if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
          } catch (_) {}
        }
        
        if (finalState === 'COMPLETE') {
          await supabase
            .from('limit_orders')
            .update({
              status: 'EXECUTED',
              tx_hash: txHash
            })
            .eq('id', orderId);
            
          const { data: updatedTrade } = await supabase
            .from('trades')
            .update({
              state: 'COMPLETE',
              tx_hash: txHash
            })
            .eq('tx_id', circleId)
            .select()
            .single();
          
          if (updatedTrade) {
            broadcastTrade(updatedTrade);
          }
          
          createNotification(
            userId,
            'Limit Order Triggered! ⚡',
            `Your limit order to ${type.toLowerCase()} ${side} at $${parseFloat(targetPrice).toFixed(2)} was executed successfully on-chain!`,
            'limit_order'
          ).catch(console.error);
        } else {
          await supabase
            .from('limit_orders')
            .update({ status: 'FAILED' })
            .eq('id', orderId);
            
          await supabase
            .from('trades')
            .update({
              state: 'FAILED'
            })
            .eq('tx_id', circleId);
            
          createNotification(
            userId,
            'Limit Order Failed ❌',
            `Your limit order to ${type.toLowerCase()} ${side} at $${parseFloat(targetPrice).toFixed(2)} failed to execute.`,
            'limit_order'
          ).catch(console.error);
        }
      } catch (err) {
        console.error(`Error processing limit order ${order.id}:`, err.message);
        await supabase.from('limit_orders').update({ status: 'PENDING' }).eq('id', order.id);
      }
    }
  } catch (e) {
    console.error('checkAndExecuteLimitOrders error:', e.message);
  }
}

// Run matching engine every 20 seconds
setInterval(checkAndExecuteLimitOrders, 20 * 1000);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`Puls backend :${PORT}`);
  console.log(`[UMA] Optimistic Oracle resolution: ${UMA_RESOLUTION && UMA_ADAPTER_ADDRESS ? `ENABLED (adapter ${UMA_ADAPTER_ADDRESS}, oracle ${UMA_OOV2_ADDRESS})` : 'disabled (legacy direct resolve)'}`);
  console.log(`[Wallets] account type: ${WALLET_ACCOUNT_TYPE}; Circle webhook signature enforce: ${CIRCLE_WEBHOOK_ENFORCE}`);
  await loadDeployedMarkets();
  checkAndResolveMarkets().catch(console.error);
  warmupTopMarkets().catch(console.error);
  // Treasury low-balance monitor (alerts via ALERT_WEBHOOK_URL if configured).
  checkTreasuryBalance().catch(console.error);
  setInterval(() => checkTreasuryBalance().catch(console.error), 5 * 60 * 1000);
  // Leaderboard needs the wallet mapping for on-chain position reads
  loadWalletAddressMapping()
    .catch(console.error)
    .then(() => updateLeaderboard())
    .catch(console.error);
});

// ── WebSocket Server for Live Betting Feed ──
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WebSocket] Client connected. Active clients: ${wsClients.size}`);
  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Active clients: ${wsClients.size}`);
  });
  ws.on('error', (err) => {
    wsClients.delete(ws);
    console.error('[WebSocket] Client error:', err.message);
  });
});

function broadcastTrade(trade) {
  const payload = JSON.stringify(trade);
  console.log(`[WebSocket] Broadcasting trade event: ${trade.id}`);
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      try {
        client.send(payload);
      } catch (err) {
        console.error('[WebSocket] Broadcast failed:', err.message);
      }
    }
  }
}

// ── Agent Strategies Engine (Arbitrage & DCA) ──
const agentStrategies = new Map(); // userId -> strategy string ('NONE', 'ARBITRAGE', 'DCA')

async function getAgentStrategy(userId) {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .select('strategy')
      .eq('user_id', `agent_${userId}`)
      .single();
    if (!error && data && data.strategy) {
      return data.strategy;
    }
  } catch (_) {}
  return agentStrategies.get(userId) ?? 'NONE';
}

async function setAgentStrategy(userId, strategy) {
  agentStrategies.set(userId, strategy);
  try {
    await supabase
      .from('wallets')
      .update({ strategy })
      .eq('user_id', `agent_${userId}`);
  } catch (_) {}
}

app.get('/api/agent/strategy', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const strategy = await getAgentStrategy(userId);
    res.json({ strategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent/strategy', authenticateUser, requireVerifiedUser, async (req, res) => {
  try {
    const { userId, strategy } = req.body;
    if (!userId || !strategy) return res.status(400).json({ error: 'userId and strategy required' });
    await setAgentStrategy(userId, strategy);
    res.json({ strategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runAgentStrategies() {
  console.log('Running autonomous agent strategies loop...');
  try {
    const { data: walletRows, error } = await supabase
      .from('wallets')
      .select('user_id, wallet_id');
      
    if (error || !walletRows) return;
    
    const agentRows = walletRows.filter(r => r.user_id.startsWith('agent_'));
    
    for (const row of agentRows) {
      const agentKey = row.user_id;
      const userId = agentKey.substring(6);
      const agentWalletId = row.wallet_id;
      
      const strategy = await getAgentStrategy(userId);
      if (strategy === 'NONE') continue;
      
      const walletInfo = await getWalletInfo(agentWalletId);
      const balance = parseFloat(walletInfo.usdcBalance) || 0;
      
      if (balance < 1.0) {
        console.log(`Agent ${agentKey} balance is too low ($${balance.toFixed(2)}), skipping.`);
        continue;
      }
      
      // Enforce 2 minutes cooling period
      const { data: lastTrades } = await supabase
        .from('trades')
        .select('created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
        
      if (lastTrades && lastTrades.length > 0) {
        const lastTradeTime = new Date(lastTrades[0].created_at).getTime();
        const timeSinceLastTrade = Date.now() - lastTradeTime;
        if (timeSinceLastTrade < 120 * 1000) {
          console.log(`Agent ${agentKey} traded recently, cooling down.`);
          continue;
        }
      }
      
      if (strategy === 'ARBITRAGE') {
        await executeArbitrageStrategy(userId, agentWalletId, balance);
      } else if (strategy === 'DCA') {
        await executeDCAStrategy(userId, agentWalletId, balance);
      }
    }
  } catch (err) {
    console.error('runAgentStrategies error:', err.message);
  }
}

async function executeArbitrageStrategy(userId, agentWalletId, balance) {
  const activeMarkets = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000));
    
  if (activeMarkets.length === 0) return;
  
  let pmMarkets = [];
  try {
    const pmRes = await fetch('https://gamma-api.polymarket.com/markets?limit=30&active=true&closed=false', { headers: { Accept: 'application/json' } });
    if (pmRes.ok) pmMarkets = await pmRes.json();
  } catch (e) {
    console.error('Arbitrage strategy Polymarket fetch error:', e.message);
    return;
  }
  
  const pmMarketsBySlug = Object.fromEntries(pmMarkets.map(m => [m.slug, m]));
  
  for (const market of activeMarkets) {
    const pmMarket = pmMarketsBySlug[market.slug];
    if (!pmMarket) continue;
    
    const pmYesPrice = parseFloat(pmMarket.outcomePrices?.[0] || pmMarket.yesPrice);
    if (isNaN(pmYesPrice)) continue;
    
    let onChainYesPrice = 0.5;
    try {
      const info = await publicClient.readContract({
        address: market.contractAddress,
        abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
          { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
          { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
          { name: '_yesOutstanding', type: 'uint256' }, { name: '_noOutstanding', type: 'uint256' } ] }],
        functionName: 'getMarketInfo',
      });
      const poolYes = Number(info[4]) / 1_000_000;
      const poolNo = Number(info[5]) / 1_000_000;
      const bVal = 10;
      const maxQ = Math.max(poolYes, poolNo);
      const expYes = Math.exp((poolYes - maxQ) / bVal);
      const expNo = Math.exp((poolNo - maxQ) / bVal);
      onChainYesPrice = expYes / (expYes + expNo);
    } catch (_) {
      continue;
    }
    
    const yesDiff = pmYesPrice - onChainYesPrice;
    const noDiff = (1 - pmYesPrice) - (1 - onChainYesPrice);
    
    let sideToBuy = null;
    let priceDiff = 0;
    
    if (yesDiff > 0.06) {
      sideToBuy = 'YES';
      priceDiff = yesDiff;
    } else if (noDiff > 0.06) {
      sideToBuy = 'NO';
      priceDiff = noDiff;
    }
    
    if (sideToBuy) {
      const buyAmount = 1.0;
      console.log(`Arbitrage Opportunity: ${market.slug} ${sideToBuy} is undervalued on-chain by ${priceDiff.toFixed(2)} (On-chain: ${onChainYesPrice.toFixed(2)}, PM: ${pmYesPrice.toFixed(2)}). Buying $1.`);
      
      const success = await executeAgentTrade(userId, agentWalletId, market.contractAddress, sideToBuy, buyAmount, market.slug);
      if (success) {
        createNotification(
          userId,
          'Arbitrage Executed 🤖📈',
          `Your agent bought $1.00 of ${sideToBuy} on "${pmMarket.question || market.slug}" because on-chain price was ${sideToBuy === 'YES' ? onChainYesPrice.toFixed(2) : (1-onChainYesPrice).toFixed(2)} vs Polymarket ${sideToBuy === 'YES' ? pmYesPrice.toFixed(2) : (1-pmYesPrice).toFixed(2)}.`,
          'trade'
        ).catch(console.error);
        return;
      }
    }
  }
}

async function executeDCAStrategy(userId, agentWalletId, balance) {
  const activeMarkets = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000));
    
  if (activeMarkets.length === 0) return;
  
  const market = activeMarkets[Math.floor(Math.random() * activeMarkets.length)];
  const side = Math.random() > 0.5 ? 'YES' : 'NO';
  const buyAmount = 1.0;
  
  console.log(`DCA Trade: Agent ${userId} investing $1.00 on ${market.slug} ${side}.`);
  const success = await executeAgentTrade(userId, agentWalletId, market.contractAddress, side, buyAmount, market.slug);
  if (success) {
    let question = market.slug.split('-').join(' ');
    if (question.length > 0) {
      question = question.charAt(0).toUpperCase() + question.slice(1);
    }
    createNotification(
      userId,
      'DCA Invested 🤖⏳',
      `Your agent invested a scheduled $1.00 in ${side} shares for "${question}".`,
      'trade'
    ).catch(console.error);
  }
}

async function executeAgentTrade(userId, agentWalletId, contractAddress, side, amount, slug) {
  try {
    const amountMicro = Math.round(amount * 1_000_000).toString();
    if (!(await isApproved(agentWalletId, contractAddress))) {
      const MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      await circle.createContractExecutionTransaction({
        walletId: agentWalletId, contractAddress: USDC,
        abiFunctionSignature: 'approve(address,uint256)', abiParameters: [contractAddress, MAX],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });
      await new Promise(r => setTimeout(r, 4500));
    }
    
    const txRes = await circle.createContractExecutionTransaction({
      walletId: agentWalletId, contractAddress,
      abiFunctionSignature: side === 'YES' ? 'buyYes(uint256)' : 'buyNo(uint256)',
      abiParameters: [amountMicro],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    
    const circleId = txRes.data.id;
    let txHash = null, finalState = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const st = await circle.getTransaction({ id: circleId });
        const tx = st.data?.transaction;
        if (tx?.txHash) txHash = tx.txHash;
        finalState = tx?.state;
        if (['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(finalState)) break;
      } catch (_) {}
    }
    
    if (finalState === 'COMPLETE') {
      let question = slug.split('-').join(' ');
      if (question.length > 0) {
        question = question.charAt(0).toUpperCase() + question.slice(1);
      }
      
      const { data: newTrade } = await supabase
        .from('trades')
        .insert({
          user_id: userId,
          tx_id: circleId,
          side,
          usdc_amount: amount,
          entry_price: 0.5,
          question: `🤖 Agent: ${question}`,
          market_id: contractAddress,
          state: 'COMPLETE',
          tx_hash: txHash,
        })
        .select()
        .single();
        
      if (newTrade) {
        broadcastTrade(newTrade);
      }
      
      const info = await getWalletInfo(agentWalletId);
      recordAgentReputation(`agent_${userId}`, info.address, 90, 'successful_trade').catch(() => {});
      return { ok: true, txHash, tradeId: newTrade?.id ?? null };
    }
    return false;
  } catch (err) {
    console.error(`executeAgentTrade error for ${agentWalletId}:`, err.message);
    return false;
  }
}

// ── House AI Trader Agent ("Pulse") ───────────────────────────────────────────
// A fully autonomous agent with its own Circle dev-controlled wallet and
// ERC-8004 on-chain identity. Every cycle it researches live markets
// (Polymarket consensus vs on-chain LMSR price), reasons about the best
// opportunity, and executes a real USDC trade on Arc — publishing its
// decision, reasoning and Arcscan receipt to a public feed.
const HOUSE_AGENT = (process.env.HOUSE_AGENT || 'true') === 'true';
const HOUSE_AGENT_USER = 'house_pulse';
const HOUSE_AGENT_KEY = `agent_${HOUSE_AGENT_USER}`;
const HOUSE_AGENT_INTERVAL_MIN = Math.max(2, parseInt(process.env.HOUSE_AGENT_INTERVAL_MIN || '10'));
const HOUSE_AGENT_MAX_TRADE = 0.5; // USDC per decision
let houseAgentFundedThisRun = false;
let houseAgentBusy = false;

async function ensureHouseAgentWallet() {
  let walletId = await getWalletId(HOUSE_AGENT_KEY);
  if (!walletId) {
    const setId = await ensureWalletSet();
    const createRes = await circle.createWallets({
      accountType: WALLET_ACCOUNT_TYPE, blockchains: ['ARC-TESTNET'], count: 1, walletSetId: setId,
    });
    const w = createRes.data.wallets[0];
    walletId = w.id;
    await saveWallet(HOUSE_AGENT_KEY, w.id);
    console.log(`[Pulse] Created house agent Circle wallet ${w.address}`);
  }
  const info = await getWalletInfo(walletId);

  // Public profile row (notifications/trades FK to profiles.user_id).
  await supabase.from('profiles').upsert({
    user_id: HOUSE_AGENT_USER,
    display_name: 'Pulse 🤖',
    bio: 'Autonomous house AI trader. Researches every market, reasons about mispricings, and settles trades in USDC on Arc — no human in the loop.',
    avatar_url: 'https://api.dicebear.com/7.x/bottts/png?size=128&seed=pulse',
  }, { onConflict: 'user_id' });

  // Self-funding: top up once per process from the admin treasury (testnet).
  // The house agent still needs USDC *principal* to place its trades (gas itself
  // is sponsored when the wallet is SCA). We pre-check the treasury balance so an
  // empty treasury produces ONE clear warning instead of a stream of reverted
  // `ERC20: transfer amount exceeds balance` transactions (the old 438-error bug).
  let balance = parseFloat(info.usdcBalance) || 0;
  if (balance < 0.6 && !houseAgentFundedThisRun && walletClient && adminAccount) {
    const treasury = await getTreasuryUsdcBalance();
    if (treasury != null && treasury < 5) {
      houseAgentFundedThisRun = true; // don't retry a doomed transfer every run
      await sendAlert(
        `Puls house agent needs 5 USDC but treasury ${adminAccount.address} only holds ${treasury.toFixed(2)} USDC. ` +
        `Skipping funding to avoid a reverting transfer. Top up the treasury to re-enable the house agent.`
      );
    } else {
      try {
        await walletClient.writeContract({
          address: USDC,
          abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable',
            inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
            outputs: [{ type: 'bool' }] }],
          functionName: 'transfer',
          args: [info.address, 5_000_000n], // 5 USDC
        });
        houseAgentFundedThisRun = true;
        console.log(`[Pulse] Funded agent wallet ${info.address} with 5 USDC from treasury`);
        await new Promise(r => setTimeout(r, 3000));
        balance = parseFloat((await getWalletInfo(walletId)).usdcBalance) || 0;
      } catch (e) {
        console.error('[Pulse] funding error:', e.message);
      }
    }
  }

  // ERC-8004 on-chain identity (idempotent: checks for an existing token first).
  if (!registeredAgents.has(HOUSE_AGENT_KEY)) {
    const existing = await resolveAgentTokenId(HOUSE_AGENT_KEY, info.address);
    if (existing) {
      registeredAgents.add(HOUSE_AGENT_KEY);
    } else if (balance >= 0.2) {
      try {
        await circle.createContractExecutionTransaction({
          walletId,
          contractAddress: IDENTITY_REGISTRY,
          abiFunctionSignature: 'register(string)',
          abiParameters: [AGENT_METADATA_URI],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });
        await new Promise(r => setTimeout(r, 4000));
        const id = await resolveAgentTokenId(HOUSE_AGENT_KEY, info.address);
        if (id) registeredAgents.add(HOUSE_AGENT_KEY);
        console.log(`[Pulse] ERC-8004 identity registered (token ${id})`);
      } catch (e) {
        console.error('[Pulse] ERC-8004 register error:', e.message);
      }
    }
  }
  return { walletId, address: info.address, balance };
}

// Research: compare Polymarket consensus to our on-chain LMSR prices and
// return scored candidates (positive edge = that side is cheap on Arc).
async function houseAgentResearch() {
  const active = Array.from(deployedMarketsCache.entries())
    .map(([slug, entry]) => ({ slug, ...entry }))
    .filter(m => !m.resolved && m.deadline > Math.floor(Date.now() / 1000) + 3600);
  if (active.length === 0) return [];

  let pmMarkets = [];
  try {
    const r = await fetch('https://gamma-api.polymarket.com/markets?limit=100&active=true&closed=false&order=volume&ascending=false', { headers: { Accept: 'application/json' } });
    if (r.ok) pmMarkets = await r.json();
  } catch (e) {
    console.error('[Pulse] research fetch error:', e.message);
    return [];
  }
  const bySlug = Object.fromEntries(pmMarkets.map(m => [m.slug, m]));

  const candidates = [];
  for (const m of active) {
    const pm = bySlug[m.slug];
    if (!pm) continue;
    let pmYes;
    try { pmYes = parseFloat(JSON.parse(pm.outcomePrices || '[]')[0]); } catch { continue; }
    if (Number.isNaN(pmYes)) continue;
    let onChainYes;
    try {
      const info = await publicClient.readContract({
        address: m.contractAddress,
        abi: [{ name: 'getMarketInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [
          { name: '_slug', type: 'string' }, { name: '_deadline', type: 'uint256' },
          { name: '_resolved', type: 'bool' }, { name: '_outcome', type: 'bool' },
          { name: '_yesOutstanding', type: 'uint256' }, { name: '_noOutstanding', type: 'uint256' } ] }],
        functionName: 'getMarketInfo',
      });
      const poolYes = Number(info[4]) / 1_000_000;
      const poolNo = Number(info[5]) / 1_000_000;
      const bVal = 10;
      const maxQ = Math.max(poolYes, poolNo);
      const expYes = Math.exp((poolYes - maxQ) / bVal);
      const expNo = Math.exp((poolNo - maxQ) / bVal);
      onChainYes = expYes / (expYes + expNo);
    } catch { continue; }

    const yesEdge = pmYes - onChainYes;          // >0: YES cheap on Arc
    const noEdge = onChainYes - pmYes;           // >0: NO cheap on Arc
    const side = yesEdge >= noEdge ? 'YES' : 'NO';
    const edge = Math.max(yesEdge, noEdge);
    candidates.push({
      slug: m.slug,
      question: pm.question || m.slug.replace(/-/g, ' '),
      contractAddress: m.contractAddress,
      pmYes, onChainYes, side, edge,
    });
    if (candidates.length >= 25) break;
  }
  candidates.sort((a, b) => b.edge - a.edge);
  return candidates;
}

// Decide: LLM picks among the top candidates and explains itself; if the LLM
// is unavailable the agent falls back to deterministic value reasoning.
async function houseAgentDecide(candidates, balance) {
  const top = candidates.slice(0, 5);
  if (top.length === 0 || top[0].edge < 0.02) return null;
  const amount = Math.min(HOUSE_AGENT_MAX_TRADE, Math.max(0.1, Math.floor((balance - 0.1) * 10) / 10));
  if (amount < 0.1) return null;

  try {
    const sys = `You are Pulse, an autonomous value trader on the Puls prediction market (Arc Testnet). You receive mispricing candidates: Polymarket consensus probability vs the on-chain LMSR price on Arc. Pick the single best trade. Respond with STRICT JSON only: {"slug": "...", "side": "YES"|"NO", "reasoning": "<2-3 sentences, cite the concrete prices and why the edge exists>"}`;
    const user = top.map((c, i) =>
      `${i + 1}. ${c.question}\n   slug: ${c.slug} | Polymarket YES: ${(c.pmYes * 100).toFixed(0)}¢ | Arc on-chain YES: ${(c.onChainYes * 100).toFixed(0)}¢ | cheap side on Arc: ${c.side} (edge ${(c.edge * 100).toFixed(1)}¢)`
    ).join('\n');
    const raw = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);
    const parsed = parseLlmJson(raw);
    const chosen = top.find(c => c.slug === parsed.slug) || top[0];
    const side = ['YES', 'NO'].includes(parsed.side) ? parsed.side : chosen.side;
    return { ...chosen, side, amount, reasoning: formatForApp(String(parsed.reasoning || '').slice(0, 500)), brain: 'llm' };
  } catch (e) {
    const c = top[0];
    const cheapPrice = c.side === 'YES' ? c.onChainYes : 1 - c.onChainYes;
    const consensus = c.side === 'YES' ? c.pmYes : 1 - c.pmYes;
    return {
      ...c,
      amount,
      reasoning: `${c.side} trades at ${(cheapPrice * 100).toFixed(0)}¢ on Arc while Polymarket consensus implies ${(consensus * 100).toFixed(0)}¢ — a ${(c.edge * 100).toFixed(1)}¢ edge. Buying ${c.side} captures the convergence as on-chain pricing tracks consensus.`,
      brain: 'quant',
    };
  }
}

async function houseAgentTick() {
  if (!HOUSE_AGENT || houseAgentBusy) return;
  houseAgentBusy = true;
  try {
    // Cooldown based on the last published decision.
    const { data: lastDecision } = await supabase
      .from('notifications')
      .select('created_at')
      .eq('user_id', HOUSE_AGENT_USER)
      .eq('type', 'agent_decision')
      .order('created_at', { ascending: false })
      .limit(1);
    if (lastDecision && lastDecision.length > 0) {
      const since = Date.now() - new Date(lastDecision[0].created_at).getTime();
      if (since < HOUSE_AGENT_INTERVAL_MIN * 60 * 1000) return;
    }

    const agent = await ensureHouseAgentWallet();
    if (agent.balance < 0.2) {
      console.log(`[Pulse] balance too low (${agent.balance}), skipping cycle`);
      return;
    }

    const candidates = await houseAgentResearch();
    const decision = await houseAgentDecide(candidates, agent.balance);
    if (!decision) {
      console.log('[Pulse] no opportunity above threshold this cycle');
      return;
    }

    console.log(`[Pulse] decided: ${decision.side} $${decision.amount} on ${decision.slug} (${decision.brain})`);
    const result = await executeAgentTrade(
      HOUSE_AGENT_USER, agent.walletId, decision.contractAddress,
      decision.side, decision.amount, decision.slug,
    );
    if (!result) {
      console.error('[Pulse] trade execution failed');
      return;
    }

    const { error: insErr } = await supabase.from('notifications').insert({
      user_id: HOUSE_AGENT_USER,
      title: decision.slug,
      type: 'agent_decision',
      read: true,
      message: JSON.stringify({
        question: decision.question,
        side: decision.side,
        amount: decision.amount,
        reasoning: decision.reasoning,
        brain: decision.brain,
        pmYes: decision.pmYes,
        onChainYes: decision.onChainYes,
        edge: decision.edge,
        txHash: result.txHash,
        contractAddress: decision.contractAddress,
      }),
    });
    if (insErr) console.error('[Pulse] decision publish error:', insErr.message);
    else console.log(`[Pulse] published decision, tx ${result.txHash}`);
  } catch (e) {
    console.error('[Pulse] tick error:', e.message);
  } finally {
    houseAgentBusy = false;
  }
}

// Public feed: the agent's identity + its published decisions.
let houseAgentCache = { data: null, ts: 0 };
app.get('/api/agents/house', async (req, res) => {
  try {
    if (houseAgentCache.data && Date.now() - houseAgentCache.ts < 30 * 1000) {
      return res.json(houseAgentCache.data);
    }
    const walletId = await getWalletId(HOUSE_AGENT_KEY);
    let agent = null;
    if (walletId) {
      const info = await getWalletInfo(walletId);
      agent = {
        name: 'Pulse',
        address: info.address,
        balance: parseFloat(info.usdcBalance) || 0,
        erc8004Id: agentTokenIds.get(HOUSE_AGENT_KEY) ?? null,
        reputation: agentRepCount.get(HOUSE_AGENT_KEY) ?? 0,
        enabled: HOUSE_AGENT,
        intervalMinutes: HOUSE_AGENT_INTERVAL_MIN,
      };
    }
    const { data: rows } = await supabase
      .from('notifications')
      .select('message, created_at')
      .eq('user_id', HOUSE_AGENT_USER)
      .eq('type', 'agent_decision')
      .order('created_at', { ascending: false })
      .limit(25);
    const decisions = (rows || []).map((r) => {
      try { return { ...JSON.parse(r.message), at: r.created_at }; }
      catch { return null; }
    }).filter(Boolean);
    const data = { agent, decisions };
    houseAgentCache = { data, ts: Date.now() };
    res.json(data);
  } catch (e) {
    console.error('agents/house error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Economy Explorer — live on-chain USDC feed (Blockscout / Arcscan v2 API).
// Aggregates USDC token-transfers for Puls-owned addresses (treasury + house
// agent) into a verifiable activity feed with proof links. No secrets needed:
// testnet.arcscan.app is a public Blockscout instance. If ARC_EXPLORER_API is
// pointed at api.blockscout.com (multichain gateway), BLOCKSCOUT_API_KEY is
// appended automatically.
// ---------------------------------------------------------------------------
const ARC_EXPLORER_API = (process.env.ARC_EXPLORER_API || 'https://testnet.arcscan.app/api/v2').replace(/\/+$/, '');
const ARC_EXPLORER_TX = (process.env.ARC_EXPLORER_TX || 'https://testnet.arcscan.app/tx').replace(/\/+$/, '');
const ECONOMY_FEED_TTL_MS = parseInt(process.env.ECONOMY_FEED_TTL_MS || '45000', 10);

// Small cache + pacer so we never exceed explorer rate limits (default <4 req/s).
const _explorerCache = new Map(); // path -> { at, data }
let _explorerLastCall = 0;
async function explorerFetch(path, ttlMs = ECONOMY_FEED_TTL_MS) {
  const hit = _explorerCache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const wait = Math.max(0, _explorerLastCall + 260 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  _explorerLastCall = Date.now();
  let url = `${ARC_EXPLORER_API}${path}`;
  if (process.env.BLOCKSCOUT_API_KEY && ARC_EXPLORER_API.includes('api.blockscout.com')) {
    url += `${path.includes('?') ? '&' : '?'}apikey=${process.env.BLOCKSCOUT_API_KEY}`;
  }
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  const data = await r.json();
  _explorerCache.set(path, { at: Date.now(), data });
  return data;
}

// Resolve the house agent wallet address once (cached for process lifetime).
let _houseAgentAddr = null;
async function getHouseAgentAddress() {
  if (_houseAgentAddr !== null) return _houseAgentAddr;
  try {
    const wid = await getWalletId(HOUSE_AGENT_KEY);
    _houseAgentAddr = wid ? ((await getWalletInfo(wid))?.address || '') : '';
  } catch (e) {
    console.warn('[economy] house agent addr resolve failed:', e.message);
    _houseAgentAddr = '';
  }
  return _houseAgentAddr;
}

let _economyFeedCache = { at: 0, data: null };
app.get('/api/economy/feed', generalLimiter, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '30', 10)));
    if (_economyFeedCache.data && Date.now() - _economyFeedCache.at < ECONOMY_FEED_TTL_MS) {
      return res.json({ ..._economyFeedCache.data, feed: _economyFeedCache.data.feed.slice(0, limit), cached: true });
    }

    // Puls-owned addresses we track on-chain.
    const tracked = {}; // lowercased addr -> { label, role }
    const treasury = adminAccount?.address || null;
    if (treasury) tracked[treasury.toLowerCase()] = { label: 'Treasury', role: 'treasury', address: treasury };
    const houseAgent = await getHouseAgentAddress();
    if (houseAgent) tracked[houseAgent.toLowerCase()] = { label: 'Pulse (house agent)', role: 'agent', address: houseAgent };

    const all = [];
    for (const a of Object.keys(tracked)) {
      try {
        const d = await explorerFetch(`/addresses/${a}/token-transfers?type=ERC-20`);
        for (const it of (d.items || [])) all.push(it);
      } catch (e) {
        console.warn('[economy] transfers fetch failed for', a, e.message);
      }
    }

    // Keep USDC only + dedupe by tx_hash:log_index.
    const seen = new Set();
    const usdcItems = [];
    for (const it of all) {
      const tokenAddr = (it.token?.address_hash || it.token?.address || '').toLowerCase();
      const sym = (it.token?.symbol || '').toUpperCase();
      if (!(tokenAddr === USDC.toLowerCase() || sym === 'USDC')) continue;
      const key = `${it.transaction_hash}:${it.log_index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      usdcItems.push(it);
    }
    usdcItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const labelFor = (addr) => {
      if (!addr) return { label: '—', address: null };
      const low = addr.toLowerCase();
      if (tracked[low]) return { label: tracked[low].label, address: addr };
      return { label: `${addr.slice(0, 6)}…${addr.slice(-4)}`, address: addr };
    };

    const feed = usdcItems.slice(0, limit).map((it) => {
      const from = it.from?.hash || '';
      const to = it.to?.hash || '';
      const decimals = parseInt(it.total?.decimals || it.token?.decimals || '6', 10);
      const value = Number(it.total?.value || '0') / Math.pow(10, decimals);
      const fromRole = tracked[from.toLowerCase()]?.role || null;
      const toRole = tracked[to.toLowerCase()]?.role || null;
      const m = (it.method || '').toLowerCase();
      let action;
      if (m.includes('createmarket')) action = 'Market created';
      else if (m.includes('buy')) action = 'Share buy';
      else if (m.includes('sell')) action = 'Share sell';
      else if (m.includes('claim') || m.includes('redeem')) action = 'Winnings claimed';
      else if (fromRole === 'treasury') action = 'Treasury drip (gas/credit)';
      else if (toRole === 'treasury') action = 'Returned to treasury';
      else if (fromRole === 'agent') action = 'Agent payment out';
      else if (toRole === 'agent') action = 'Agent received funds';
      else action = 'USDC transfer';
      return {
        hash: it.transaction_hash,
        explorer_url: `${ARC_EXPLORER_TX}/${it.transaction_hash}`,
        timestamp: it.timestamp,
        block: it.block_number,
        method: it.method || null,
        from: { ...labelFor(from), role: fromRole },
        to: { ...labelFor(to), role: toRole },
        value_usdc: Number(value.toFixed(6)),
        token: 'USDC',
        action,
      };
    });

    const vol = feed.reduce((s, x) => s + x.value_usdc, 0);
    const metrics = {
      tx_count: feed.length,
      total_volume_usdc: Number(vol.toFixed(4)),
      avg_payment_usdc: feed.length ? Number((vol / feed.length).toFixed(6)) : 0,
      tracked_addresses: Object.keys(tracked).length,
    };

    const payload = {
      feed,
      metrics,
      tracked: Object.values(tracked).map((t) => ({ label: t.label, role: t.role, address: t.address })),
      explorer: ARC_EXPLORER_TX,
      updated_at: new Date().toISOString(),
    };
    _economyFeedCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    console.error('[economy/feed] error:', e.message);
    res.status(500).json({ error: 'economy feed failed' });
  }
});

if (HOUSE_AGENT) {
  setTimeout(houseAgentTick, 45 * 1000); // first cycle shortly after boot
  setInterval(houseAgentTick, 5 * 60 * 1000); // cooldown enforces the real cadence
}

// Run strategies check every 60 seconds
setInterval(runAgentStrategies, 60 * 1000);
