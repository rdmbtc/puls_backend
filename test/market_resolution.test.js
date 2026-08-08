// Puls resolution cron — unit tests for the batched Gamma lookup and the
// feed's "is this market still tradeable" guard.
//
// Background: markets whose event was long over kept showing in the feed, and
// buying one failed instantly with "This market has closed" from
// /api/trade/buy. Two separate causes:
//
//   1. /api/markets computed `ended` / `acceptingOrders` and then returned the
//      market anyway. Nothing downstream consumed those fields.
//   2. The resolution cron that would eventually archive them ran one market at
//      a time, two Gamma round-trips each (with retries), so a backlog of
//      past-deadline markets took tens of minutes per tick.
//
// These tests cover the batched lookup that fixes (2) and the feed predicate
// that fixes (1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchMarketsForResolution } from '../lib/polymarket_client.js';

// ── fetch mock ──────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Installs a fetch stub and records every path it was asked for. */
function stubGamma(handler) {
  const paths = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace('https://gamma-api.polymarket.com', '');
    paths.push(path);
    const body = handler(path);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };
  return paths;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** Slugs carried by a `?slug=a&slug=b` query string. */
function slugsIn(path) {
  return [...path.matchAll(/[?&]slug=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
}

// ── Batched Gamma lookup ────────────────────────────────────────────────────

test('batched lookup: one request covers every closed market', async (t) => {
  const paths = stubGamma((path) => {
    if (!path.includes('closed=true')) return [];
    return slugsIn(path).map((slug) => ({ slug, closed: true }));
  });
  t.after(restoreFetch);

  const found = await fetchMarketsForResolution(['a', 'b', 'c']);

  assert.equal(found.size, 3);
  assert.equal(found.get('b').closed, true);
  // One request for all three, not two per market as the old per-slug path did.
  assert.equal(paths.length, 1);
});

test('batched lookup: falls back to the open query for the rest', async (t) => {
  const paths = stubGamma((path) => {
    const slugs = slugsIn(path);
    if (path.includes('closed=true')) {
      return slugs.filter((s) => s === 'settled').map((slug) => ({ slug, closed: true }));
    }
    return slugs.map((slug) => ({ slug, closed: false }));
  });
  t.after(restoreFetch);

  const found = await fetchMarketsForResolution(['settled', 'running']);

  assert.equal(found.get('settled').closed, true);
  assert.equal(found.get('running').closed, false);
  assert.equal(paths.length, 2);
  // The open query must only ask about what the closed query didn't answer.
  assert.deepEqual(slugsIn(paths[1]), ['running']);
});

test('batched lookup: unrequested slugs mean the filter was ignored, so fall back per-slug', async (t) => {
  // If Gamma ever stops honouring the repeated `slug` parameter it returns the
  // default top-of-book page instead. Trusting that would resolve markets
  // against a completely unrelated market's outcome.
  const paths = stubGamma((path) => {
    const slugs = slugsIn(path);
    if (slugs.length > 1) return [{ slug: 'some-other-market', closed: true }];
    if (!path.includes('closed=true')) return [];
    return slugs.map((slug) => ({ slug, closed: true }));
  });
  t.after(restoreFetch);

  const found = await fetchMarketsForResolution(['a', 'b']);

  assert.equal(found.size, 2);
  assert.equal(found.get('a').slug, 'a');
  assert.equal(found.get('b').slug, 'b');
  assert.ok(!found.has('some-other-market'));
});

test('batched lookup: empty input makes no requests', async (t) => {
  const paths = stubGamma(() => []);
  t.after(restoreFetch);

  const found = await fetchMarketsForResolution([]);

  assert.equal(found.size, 0);
  assert.equal(paths.length, 0);
});

// ── Feed guard ──────────────────────────────────────────────────────────────
// Mirrors the filter applied to /api/markets in server.js and the client-side
// `_isTradeable` in lib/data/polymarket/polymarket_repository.dart. A market
// the feed shows must be one /api/trade/buy would accept.

function isTradeable(j, now = Date.now()) {
  if (j.closed === true) return false;
  if (j.active === false) return false;
  if (j.ended === true) return false;
  if (j.resolved === true) return false;
  if (j.acceptingOrders === false) return false;
  const endRaw = j.endDate || j.endDateIso;
  const end = endRaw ? Date.parse(endRaw) : NaN;
  if (Number.isFinite(end) && end < now) return false;
  return true;
}

test('feed guard: a market whose deadline has passed is not tradeable', () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(isTradeable({ endDate: past }), false);
  // Polymarket leaves plenty of these active:true until UMA settles them.
  assert.equal(isTradeable({ endDate: past, active: true, closed: false }), false);
});

test('feed guard: a live market is tradeable', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(isTradeable({ endDate: future, active: true, closed: false }), true);
});

test('feed guard: ended / resolved / not-accepting are all excluded', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(isTradeable({ endDate: future, ended: true }), false);
  assert.equal(isTradeable({ endDate: future, resolved: true }), false);
  assert.equal(isTradeable({ endDate: future, acceptingOrders: false }), false);
  assert.equal(isTradeable({ endDate: future, closed: true }), false);
  assert.equal(isTradeable({ endDate: future, active: false }), false);
});

test('feed guard: endDateIso is honoured when endDate is absent', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isTradeable({ endDateIso: past }), false);
});

test('feed guard: a market with no end date at all stays visible', () => {
  // No deadline means /api/trade/buy has nothing to reject on either.
  assert.equal(isTradeable({}), true);
});
