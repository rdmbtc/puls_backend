// Puls Streams — autonomous agent decision logic tests.
//   node --test test/streaming_agent.test.js
// Verifies the AI's three decisions: GO/NO-GO, the per-second RATE (scaled by
// bankroll x conviction, clamped), and WHEN-TO-STOP (marginal value < price).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStream, decideContinue } from '../lib/streaming_agent.js';

test('GO/NO-GO: low conviction -> does NOT pay (agency includes restraint)', () => {
  const d = decideStream({ bankrollUsdc: 5, conviction: 0.1 });
  assert.equal(d.worthIt, false);
});

test('GO/NO-GO: high conviction + funded -> rents the feed', () => {
  const d = decideStream({ bankrollUsdc: 5, conviction: 0.8 });
  assert.equal(d.worthIt, true);
  assert.ok(d.ratePerSecUsdc >= 0.0005 && d.ratePerSecUsdc <= 0.02, `rate ${d.ratePerSecUsdc}`);
  assert.ok(d.capUsdc > 0 && d.capUsdc <= 0.5);
  assert.ok(d.maxSeconds >= 18 && d.maxSeconds <= 60);
});

test('RATE scales with conviction (more conviction -> willing to pay more)', () => {
  const lo = decideStream({ bankrollUsdc: 5, conviction: 0.4 });
  const hi = decideStream({ bankrollUsdc: 5, conviction: 0.9 });
  assert.ok(hi.ratePerSecUsdc >= lo.ratePerSecUsdc, `${hi.ratePerSecUsdc} >= ${lo.ratePerSecUsdc}`);
});

test('RATE scales with bankroll, clamped to MAX for a whale', () => {
  const small = decideStream({ bankrollUsdc: 2, conviction: 0.7 });
  const whale = decideStream({ bankrollUsdc: 100000, conviction: 0.7 });
  assert.ok(whale.ratePerSecUsdc >= small.ratePerSecUsdc);
  assert.equal(whale.ratePerSecUsdc, 0.005); // clamped to MAX_RATE (reduced from 0.02)
});

test('RATE clamped to MIN for a high-conviction but tiny bankroll', () => {
  const d = decideStream({ bankrollUsdc: 0.5, conviction: 0.9 });
  assert.equal(d.worthIt, true);
  assert.equal(d.ratePerSecUsdc, 0.000225); // clamped to MIN_RATE (reduced)
});

test('WHEN-TO-STOP: keep paying early, stop once marginal value < price', () => {
  const rate = 0.004, conviction = 0.8;
  const t0 = decideContinue({ elapsedSec: 0, ratePerSecUsdc: rate, conviction });
  assert.equal(t0.keep, true);                      // first second is +EV
  assert.ok(t0.marginalValuePerSec >= rate);
  const tLate = decideContinue({ elapsedSec: 60, ratePerSecUsdc: rate, conviction });
  assert.equal(tLate.keep, false);                  // value extracted -> stop
  assert.ok(tLate.marginalValuePerSec < rate);
});

test('WHEN-TO-STOP: marginal value decays monotonically with time', () => {
  const rate = 0.004, conviction = 0.8;
  const a = decideContinue({ elapsedSec: 2, ratePerSecUsdc: rate, conviction }).marginalValuePerSec;
  const b = decideContinue({ elapsedSec: 10, ratePerSecUsdc: rate, conviction }).marginalValuePerSec;
  const c = decideContinue({ elapsedSec: 25, ratePerSecUsdc: rate, conviction }).marginalValuePerSec;
  assert.ok(a > b && b > c, `decay ${a} > ${b} > ${c}`);
});

test('higher conviction -> agent streams longer before stopping', () => {
  const rate = 0.004;
  // find approx stop time by scanning
  const stopTime = (conv) => {
    for (let t = 0; t <= 120; t += 0.5) {
      if (!decideContinue({ elapsedSec: t, ratePerSecUsdc: rate, conviction: conv }).keep) return t;
    }
    return 120;
  };
  assert.ok(stopTime(0.9) > stopTime(0.5), `${stopTime(0.9)} > ${stopTime(0.5)}`);
});
