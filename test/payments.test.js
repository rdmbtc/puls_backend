// Puls Payments — unit tests for the take-rate split math.
//
// Verifies the money-moving math: gross USDC → (net to creator + fee to treasury).
// A bug here means creators get underpaid or the treasury takes too much.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTakeRate, annotatePayment } from '../lib/payments.js';

test('Take-rate: 5% split on $1.00 → $0.95 net + $0.05 fee', () => {
  const split = splitTakeRate(1.0);
  assert.equal(split.netUsdc, 0.95);
  assert.equal(split.treasuryFeeUsdc, 0.05);
  assert.equal(split.netUsdc + split.treasuryFeeUsdc, 1.0);
});

test('Take-rate: 5% split on $0.001 (micro-payment) → correct', () => {
  const split = splitTakeRate(0.001);
  assert.equal(split.treasuryFeeUsdc, 0.00005);
  assert.equal(split.netUsdc, 0.00095);
});

test('Take-rate: 5% split on $10.00 → $9.50 net + $0.50 fee', () => {
  const split = splitTakeRate(10.0);
  assert.equal(split.netUsdc, 9.5);
  assert.equal(split.treasuryFeeUsdc, 0.5);
});

test('Take-rate: net + fee always equals gross (no rounding drift)', () => {
  for (let g = 0.001; g <= 100; g += 0.001) {
    const split = splitTakeRate(g);
    const sum = Math.round((split.netUsdc + split.treasuryFeeUsdc) * 1_000_000) / 1_000_000;
    const gross = Math.round(g * 1_000_000) / 1_000_000;
    assert.equal(sum, gross, `net + fee != gross for ${g}`);
  }
});

test('Take-rate: zero amount → zero split', () => {
  const split = splitTakeRate(0);
  assert.equal(split.netUsdc, 0);
  assert.equal(split.treasuryFeeUsdc, 0);
});

test('Take-rate: negative amount → treated as zero', () => {
  const split = splitTakeRate(-5);
  assert.equal(split.netUsdc, 0);
  assert.equal(split.treasuryFeeUsdc, 0);
});

test('Take-rate: null/undefined amount → treated as zero', () => {
  const split = splitTakeRate(null);
  assert.equal(split.netUsdc, 0);
  assert.equal(split.treasuryFeeUsdc, 0);
});

test('Take-rate: fee is always <= 5% of gross (bounded)', () => {
  for (let g = 0.01; g <= 1000; g += 0.5) {
    const split = splitTakeRate(g);
    const feePct = split.treasuryFeeUsdc / g;
    assert.ok(feePct <= 0.05 + 1e-9, `fee ${feePct} > 5% for ${g}`);
  }
});

test('Take-rate: fee is always >= 0 (never negative)', () => {
  for (let g = 0; g <= 100; g += 0.1) {
    const split = splitTakeRate(g);
    assert.ok(split.treasuryFeeUsdc >= 0, `negative fee for ${g}`);
  }
});

test('Take-rate: creator always gets >= 95% of gross', () => {
  for (let g = 0.01; g <= 1000; g += 0.5) {
    const split = splitTakeRate(g);
    const netPct = split.netUsdc / g;
    assert.ok(netPct >= 0.95 - 1e-9, `net ${netPct} < 95% for ${g}`);
  }
});

test('Take-rate: micro-USDC precision (6 decimal places)', () => {
  // 0.1 + 0.2 = 0.30000000000000004 — must round to 6dp, not 17dp
  const split = splitTakeRate(0.1 + 0.2);
  const netDecimals = (split.netUsdc.toString().split('.')[1] || '').length;
  const feeDecimals = (split.treasuryFeeUsdc.toString().split('.')[1] || '').length;
  assert.ok(netDecimals <= 6, `net has ${netDecimals} decimals`);
  assert.ok(feeDecimals <= 6, `fee has ${feeDecimals} decimals`);
});

test('Take-rate: annotatePayment adds grossUsdc/netUsdc/treasuryFeeUsdc to raw', () => {
  const raw = { kind: 'signal_unlock', signalId: 'abc' };
  const split = { netUsdc: 0.95, treasuryFeeUsdc: 0.05 };
  const annotated = annotatePayment(raw, split);
  assert.equal(annotated.grossUsdc, 1.0);
  assert.equal(annotated.netUsdc, 0.95);
  assert.equal(annotated.treasuryFeeUsdc, 0.05);
  assert.equal(annotated.kind, 'signal_unlock'); // original fields preserved
  assert.equal(annotated.signalId, 'abc');
});

test('Take-rate: annotatePayment handles null raw', () => {
  const annotated = annotatePayment(null, { netUsdc: 0.95, treasuryFeeUsdc: 0.05 });
  assert.equal(annotated.netUsdc, 0.95);
  assert.equal(annotated.treasuryFeeUsdc, 0.05);
});
