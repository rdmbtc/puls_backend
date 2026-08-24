import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReputations, reputationsToList } from '../lib/agent_reputation.js';

const marker = ({ raterKey, targetUserId, score, txHash = '0x' + 'f'.repeat(64), skipped }) => ({
  title: `${raterKey}|${targetUserId}|ref`,
  message: JSON.stringify({ raterKey, targetUserId, refId: 'ref', score, tag: 'duel-win', txHash, ...(skipped ? { skipped } : {}) }),
});

describe('aggregateReputations (peer-review read side)', () => {
  test('counts given/received and averages received scores', () => {
    const rows = [
      // nova reviewed atlas twice (duel + signal): atlas receives 2, nova gives 2
      marker({ raterKey: 'nova', targetUserId: 'agent_swarm_atlas', score: 90 }),
      marker({ raterKey: 'nova', targetUserId: 'agent_swarm_atlas', score: 60 }),
      // vega reviewed striker once
      marker({ raterKey: 'vega', targetUserId: 'agent_swarm_striker', score: 40 }),
    ];
    const agg = aggregateReputations(rows);
    const nova = agg.get('agent_swarm_nova');
    assert.equal(nova.reviewsGiven, 2);
    assert.equal(nova.reviewsReceived, 0);
    assert.equal(nova.avgScore, null);

    const atlas = agg.get('agent_swarm_atlas');
    assert.equal(atlas.reviewsReceived, 2);
    assert.equal(atlas.avgScore, 75);
    assert.ok(agg.has('agent_swarm_striker'));
  });

  test('skipped (unposted) reviews never count as activity', () => {
    const rows = [marker({ raterKey: 'vega', targetUserId: 'agent_swarm_cygnus', score: 40, txHash: '', skipped: 'no-target-address' })];
    const list = reputationsToList(rows);
    assert.equal(list.length, 0);
  });

  test('malformed rows are ignored without throwing', () => {
    const agg = aggregateReputations([{ title: 'x|y|z', message: 'not-json{[' }, null, {}]);
    assert.equal(agg.size, 0);
  });

  test('reputationsToList sorts by total activity descending', () => {
    const rows = [
      marker({ raterKey: 'vega', targetUserId: 'agent_swarm_a1', score: 90 }),
      marker({ raterKey: 'vega', targetUserId: 'agent_swarm_a2', score: 90 }),
      marker({ raterKey: 'atlas', targetUserId: 'agent_swarm_a1', score: 60 }),
    ];
    const list = reputationsToList(rows);
    // vega: 2 given; a1: 2 received; a2 + atlas: 1 each → sorted desc
    const totals = list.map((a) => a.reviewsGiven + a.reviewsReceived);
    assert.deepEqual(totals, [2, 2, 1, 1]);
  });
});
