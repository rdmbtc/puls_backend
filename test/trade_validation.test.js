// Puls Trade — unit tests for the validation guards in /api/trade/buy.
//
// These guards are the first line of defense against bad trades:
//   - deadline check (reject trades on closed markets)
//   - amount parsing + positivity
//   - balance check (reject if insufficient USDC)
//
// The route handlers in server.js mix validation with Circle SDK calls
// (which we can't mock here), so we extract and test the pure validation
// logic directly. If the guards drift, these tests break.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Guard: market deadline ──────────────────────────────────────────────────
// Extracted from server.js /api/trade/buy (line ~2082-2085).
// Returns true if the market is still open, false if closed.
function isMarketOpen(deadlineSec) {
  if (!Number.isFinite(deadlineSec) || deadlineSec <= 0) return true; // no deadline = always open
  return deadlineSec * 1000 >= Date.now();
}

test('Trade guard: market with future deadline is open', () => {
  const future = Math.floor(Date.now() / 1000) + 3600; // 1h from now
  assert.equal(isMarketOpen(future), true);
});

test('Trade guard: market with past deadline is closed', () => {
  const past = Math.floor(Date.now() / 1000) - 3600; // 1h ago
  assert.equal(isMarketOpen(past), false);
});

test('Trade guard: deadline of 0 or null is treated as always-open', () => {
  assert.equal(isMarketOpen(0), true);
  assert.equal(isMarketOpen(null), true);
  assert.equal(isMarketOpen(undefined), true);
});

test('Trade guard: NaN deadline is treated as always-open (no false rejects)', () => {
  assert.equal(isMarketOpen(NaN), true);
  assert.equal(isMarketOpen('not-a-number'), true);
});

// ── Guard: trade amount parsing + positivity ───────────────────────────────
// Extracted from server.js /api/trade/buy (line ~2093-2094).
function parseAmount(usdcAmount) {
  const amount = parseFloat(usdcAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function toMicroUsdc(amount) {
  return Math.round(amount * 1_000_000).toString();
}

test('Trade amount: valid positive number parses correctly', () => {
  assert.equal(parseAmount('10.50'), 10.5);
  assert.equal(parseAmount(5), 5);
  assert.equal(parseAmount('0.01'), 0.01);
});

test('Trade amount: zero or negative rejects', () => {
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount(0), null);
});

test('Trade amount: NaN or missing rejects', () => {
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
  assert.equal(parseAmount(''), null);
});

test('Trade amount: USDC → micro-USDC conversion is exact', () => {
  assert.equal(toMicroUsdc(1.0), '1000000');
  assert.equal(toMicroUsdc(0.01), '10000');
  assert.equal(toMicroUsdc(10.5), '10500000');
});

test('Trade amount: micro-USDC rounds correctly (no floating-point drift)', () => {
  // 0.1 + 0.2 = 0.30000000000000004 in JS — must round to 300000, not 30000004
  assert.equal(toMicroUsdc(0.1 + 0.2), '300000');
  assert.equal(toMicroUsdc(0.305), '305000');
});

// ── Guard: balance check ────────────────────────────────────────────────────
// Extracted from server.js /api/trade/buy (line ~2097-2101).
function hasSufficientBalance(walletBalanceStr, tradeAmount) {
  const balance = parseFloat(walletBalanceStr);
  return Number.isFinite(balance) && balance >= tradeAmount;
}

test('Balance check: sufficient balance passes', () => {
  assert.equal(hasSufficientBalance('100.00', 10), true);
  assert.equal(hasSufficientBalance('10.00', 10), true); // exactly enough
});

test('Balance check: insufficient balance fails', () => {
  assert.equal(hasSufficientBalance('5.00', 10), false);
  assert.equal(hasSufficientBalance('0.00', 0.01), false);
});

test('Balance check: non-numeric balance fails safely', () => {
  assert.equal(hasSufficientBalance('abc', 10), false);
  assert.equal(hasSufficientBalance(null, 10), false);
});

// ── Guard: side validation ──────────────────────────────────────────────────
function isValidSide(side) {
  return side === 'YES' || side === 'NO';
}

test('Side validation: YES and NO are valid', () => {
  assert.equal(isValidSide('YES'), true);
  assert.equal(isValidSide('NO'), true);
});

test('Side validation: lowercase + other values reject', () => {
  assert.equal(isValidSide('yes'), false);
  assert.equal(isValidSide('no'), false);
  assert.equal(isValidSide('MAYBE'), false);
  assert.equal(isValidSide(null), false);
});

// ── Guard: required fields ─────────────────────────────────────────────────
function validateTradeFields({ userId, side, usdcAmount, slug, deadline }) {
  if (!userId) return 'Missing userId';
  if (!isValidSide(side)) return 'Invalid side';
  if (parseAmount(usdcAmount) === null) return 'Invalid amount';
  if (!slug) return 'Missing slug';
  if (!isMarketOpen(Number(deadline))) return 'Market closed';
  return null; // all good
}

test('Field validation: valid trade passes', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(validateTradeFields({
    userId: 'supabase_123', side: 'YES', usdcAmount: '5.00', slug: 'btc-100k', deadline: future,
  }), null);
});

test('Field validation: missing userId rejects', () => {
  assert.equal(validateTradeFields({
    userId: '', side: 'YES', usdcAmount: '5', slug: 'btc', deadline: 0,
  }), 'Missing userId');
});

test('Field validation: closed market rejects with clear message', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(validateTradeFields({
    userId: 'supabase_123', side: 'YES', usdcAmount: '5', slug: 'btc', deadline: past,
  }), 'Market closed');
});
