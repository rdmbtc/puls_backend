import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionExpiry } from '../lib/circle_agent_wallet.js';

const DAY = 86_400_000;
const NOW = 1_789_000_000_000; // fixed epoch ms for deterministic assertions

describe('parseSessionExpiry', () => {
  test('reads testnet.expiresAt from a parsed object (epoch ms)', () => {
    const res = parseSessionExpiry({ testnet: { expiresAt: NOW + 5 * DAY } }, NOW);
    assert.equal(res.expiresAtMs, NOW + 5 * DAY);
    assert.equal(Math.round(res.daysLeft), 5);
  });

  test('accepts a raw JSON string and epoch seconds', () => {
    const raw = JSON.stringify({ testnet: { expiresAt: Math.floor((NOW + 10 * DAY) / 1000) } });
    const res = parseSessionExpiry(raw, NOW);
    assert.equal(res.expiresAtMs, NOW + 10 * DAY);
    assert.equal(Math.round(res.daysLeft), 10);
  });

  test('accepts the base64 CIRCLE_AGENT_SESSION_B64 form', () => {
    const b64 = Buffer.from(JSON.stringify({ email: 'a@b.c', testnet: { expiresAt: NOW + 2 * DAY } })).toString('base64');
    const res = parseSessionExpiry(b64, NOW);
    assert.equal(res.daysLeft, 2);
  });

  test('falls back to the env var when input is omitted', () => {
    process.env.CIRCLE_AGENT_SESSION_B64 = Buffer.from(JSON.stringify({ testnet: { expiresAt: NOW + DAY } })).toString('base64');
    try {
      const res = parseSessionExpiry(undefined, NOW);
      assert.equal(res.expiresAtMs, NOW + DAY);
    } finally {
      delete process.env.CIRCLE_AGENT_SESSION_B64;
    }
  });

  test('flags expired sessions with negative daysLeft', () => {
    const res = parseSessionExpiry({ testnet: { expiresAt: NOW - DAY } }, NOW);
    assert.ok(res.daysLeft < 0);
  });

  test('returns null on absent/garbage input', () => {
    assert.equal(parseSessionExpiry(undefined, NOW), null);
    assert.equal(parseSessionExpiry('', NOW), null);
    assert.equal(parseSessionExpiry('not-base64-json!!!', NOW), null);
    assert.equal(parseSessionExpiry({}, NOW), null); // no expiresAt anywhere
    assert.equal(parseSessionExpiry({ testnet: { expiresAt: 'soon' } }, NOW), null);
    assert.equal(parseSessionExpiry({ testnet: { expiresAt: -5 } }, NOW), null);
  });

  test('tolerates a top-level expiresAt shape', () => {
    const res = parseSessionExpiry({ expiresAt: NOW + 3 * DAY }, NOW);
    assert.equal(res.daysLeft, 3);
  });
});
