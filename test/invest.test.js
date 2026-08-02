// Puls Invest — unit tests for the sponsorship share/claimable math.
// Verifies the money-moving rules published on /api/invest:
//   claimable = invested + pro-rata share of agent net
//   positive share → 20% platform fee; losses reduce principal, no fee.
//
//   node --test test/invest.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { claimableFor } = await import('../lib/invest.js');

test('invest: positive net — 80/20 split applied to the profit share', () => {
  // pool 10, invested 5 → 50% share of net 4 → netShare 2, fee 0.4
  const r = claimableFor(5, 10, 4);
  assert.equal(r.share, 0.5);
  assert.equal(r.netShare, 2);
  assert.equal(r.fee, 0.4);
  assert.equal(r.claimable, 6.6); // 5 + 2 - 0.4
});

test('invest: negative net — loss shared proportionally, no fee', () => {
  // pool 10, invested 5 → share of -2 → netShare -1 → claimable 4
  const r = claimableFor(5, 10, -2);
  assert.equal(r.netShare, -1);
  assert.equal(r.fee, 0);
  assert.equal(r.claimable, 4);
});

test('invest: loss cannot push claimable below zero', () => {
  const r = claimableFor(5, 10, -30);
  assert.equal(r.claimable, 0);
});

test('invest: small sponsor shares a big pool pro-rata', () => {
  // pool 1000, invested 1 → share 0.001 of net 50 → netShare 0.05 → fee 0.01
  const r = claimableFor(1, 1000, 50);
  assert.equal(r.share, 0.001);
  assert.ok(Math.abs(r.netShare - 0.05) < 1e-9);
  assert.equal(r.fee, 0.01);
  assert.equal(r.claimable, 1.04);
});

test('invest: zero pool falls back to invested as pool (no division by zero)', () => {
  const r = claimableFor(5, 0, 0);
  assert.equal(r.share, 1);
  assert.equal(r.netShare, 0);
  assert.equal(r.claimable, 5);
});

test('invest: no investment yields zero claimable', () => {
  const r = claimableFor(0, 10, 5);
  assert.equal(r.claimable, 0);
});

test('invest: claimable is rounded to micro-USDC', () => {
  // share of 0.333333 of net 1.0 → netShare 0.333333, fee 0.0666666 → claimable rounds
  const r = claimableFor(3.333333, 10, 1);
  assert.ok(Number.isFinite(r.claimable));
  assert.equal(r.claimable * 1e6, Math.round(r.claimable * 1e6));
});
