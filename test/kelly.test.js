import test from 'node:test';
import assert from 'node:assert/strict';
import { computeKellySize } from '../lib/kelly.js';

test('kelly: positive edge on YES scales position with confidence and bankroll', () => {
  const res = computeKellySize({
    confidence: 0.80, // Agent believes 80%
    marketPrice: 0.50, // Market is at 50%
    side: 'YES',
    bankrollUsdc: 20.0,
    fractionalMultiplier: 0.5, // Half-Kelly
    maxFraction: 0.10, // 10% max ($2.00)
  });

  assert.equal(res.shouldTrade, true);
  assert.equal(res.edgePct, 30.0); // +30% edge
  assert.ok(res.amountUsdc > 0);
  assert.ok(res.amountUsdc <= 2.0); // Capped by maxFraction
});

test('kelly: negative edge halts execution (returns shouldTrade = false)', () => {
  const res = computeKellySize({
    confidence: 0.40, // Agent believes 40%
    marketPrice: 0.60, // Market is at 60%
    side: 'YES',
    bankrollUsdc: 20.0,
  });

  assert.equal(res.shouldTrade, false);
  assert.equal(res.amountUsdc, 0);
  assert.ok(res.reason.includes('Negative or negligible'));
});

test('kelly: positive edge on NO calculates inverse probability edge', () => {
  const res = computeKellySize({
    confidence: 0.20, // Agent believes YES is 20%, so NO is 80%
    marketPrice: 0.60, // Market priced YES at 60%, so NO is 40%
    side: 'NO',
    bankrollUsdc: 15.0,
    fractionalMultiplier: 0.5,
  });

  assert.equal(res.shouldTrade, true);
  assert.equal(res.edgePct, 40.0); // 80% - 40% = 40%
  assert.ok(res.amountUsdc >= 0.05);
});
