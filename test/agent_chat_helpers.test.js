// Unit tests for the "My Agent" chat positional resolution helpers.
// Run with: node --test test/agent_chat_helpers.test.js   (or `npm test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePositionalMarket, resolvePositionalSignal } from '../lib/agent_chat_helpers.js';

// A representative feed: deployed-first, then by descending volume (as the
// chat handler sorts it). feed[0] is the "top market".
const FEED = [
  { slug: 'will-btc-hit-100k', question: 'Will BTC close above $100k by 2026-12-31?', deployed: true, deadline: 1899999999 },
  { slug: 'spain-round-of-16', question: 'Will Spain reach the Round of 16 at the 2026 FIFA World Cup?', deployed: true, deadline: 1899999999 },
  { slug: 'fed-cuts-july', question: 'Will the Fed cut rates in July 2026?', deployed: false, deadline: 1899999999 },
];

// ── resolvePositionalMarket ─────────────────────────────────────────────────
test('resolvePositionalMarket: positional refs map to feed[0]', () => {
  for (const ref of ['top market', 'top', 'the top one', 'best market', 'best one', 'first', 'first market', '#1', 'number 1', 'no. 1', '1st', 'most popular', 'biggest', 'hottest', '1']) {
    assert.equal(resolvePositionalMarket(ref, 'buy ' + ref, FEED), FEED[0], `expected feed[0] for ref "${ref}"`);
  }
});

test('resolvePositionalMarket: bare positional message with empty ref → feed[0]', () => {
  assert.equal(resolvePositionalMarket('', 'buy the top market', FEED), FEED[0]);
  assert.equal(resolvePositionalMarket('', 'get me the best prediction', FEED), FEED[0]);
});

test('resolvePositionalMarket: real market names fall through to name matching (null)', () => {
  // These must NOT be treated as positional — they are concrete market refs.
  assert.equal(resolvePositionalMarket('Will BTC close above $100k by 2026-12-31?', 'buy btc market', FEED), null);
  assert.equal(resolvePositionalMarket('spain round of 16', 'buy spain round of 16', FEED), null);
  assert.equal(resolvePositionalMarket('will-btc-hit-100k', 'buy the btc slug', FEED), null);
});

test('resolvePositionalMarket: "any market" still resolves (convenience)', () => {
  // "any market" / "pick one" → top market; a real topic like "btc market" → null.
  assert.equal(resolvePositionalMarket('any market', 'buy any market', FEED), FEED[0]);
  assert.equal(resolvePositionalMarket('btc market', 'buy a btc market', FEED), null);
});

test('resolvePositionalMarket: empty/missing feed → null', () => {
  assert.equal(resolvePositionalMarket('top market', 'buy top market', []), null);
  assert.equal(resolvePositionalMarket('top market', 'buy top market', undefined), null);
});

test('resolvePositionalMarket: undefined ref/message do not throw', () => {
  assert.equal(resolvePositionalMarket(undefined, undefined, FEED), null);
  assert.equal(resolvePositionalMarket('top', undefined, FEED), FEED[0]);
});

// ── resolvePositionalSignal ──────────────────────────────────────────────────
test('resolvePositionalSignal: positional refs normalize to "top"', () => {
  for (const ref of ['top signal', 'top', 'best signal', 'best', 'first signal', '#1', 'number 1', '1']) {
    assert.equal(resolvePositionalSignal(ref, 'buy ' + ref), 'top', `expected "top" for ref "${ref}"`);
  }
});

test('resolvePositionalSignal: bare positional message normalizes to "top"', () => {
  assert.equal(resolvePositionalSignal('', 'buy the top signal'), 'top');
  assert.equal(resolvePositionalSignal('', 'get me the best forecast'), 'top');
});

test('resolvePositionalSignal: real topics are preserved (lowercased, not "top")', () => {
  assert.equal(resolvePositionalSignal('crypto signal', 'buy a crypto signal'), 'crypto signal');
  assert.equal(resolvePositionalSignal('BTC signal', 'buy a btc signal'), 'btc signal');
  assert.equal(resolvePositionalSignal('world cup', 'buy a world cup signal'), 'world cup');
});

test('resolvePositionalSignal: undefined ref/message do not throw', () => {
  assert.equal(resolvePositionalSignal(undefined, undefined), '');
  assert.equal(resolvePositionalSignal('top signal', undefined), 'top');
});
