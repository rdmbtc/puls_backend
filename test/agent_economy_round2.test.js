import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { railAddressesFromEnv, keyFromAgentId, railForAgent } from '../lib/agent_pnl.js';
import {
  scoreForDuel, scoreForSignal, reviewKey, feedbackHashOf, candidateUserIds,
} from '../lib/agent_reputation.js';
import { keccak256, toHex } from 'viem';

function withEnv(vars, fn) {
  const saved = { ...vars };
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('rail attribution helpers', () => {
  const ENV = {
    CIRCLE_AGENT_WALLETS: 'vega, atlas, , nova',
    CIRCLE_AGENT_WALLET_ADDRESS_VEGA: '0x' + 'a'.repeat(40),
    CIRCLE_AGENT_WALLET_ADDRESS_ATLAS: '0xB' + 'b'.repeat(39), // mixed case → lowercased
    CIRCLE_AGENT_WALLET_ADDRESS_NOVA: 'not-an-address',        // ignored
  };

  test('railAddressesFromEnv keeps only valid addresses, lowercased', () => {
    withEnv(ENV, () => {
      const m = railAddressesFromEnv();
      assert.equal(m.size, 2);
      assert.equal(m.get('0x' + 'a'.repeat(40)), 'vega');
      assert.equal(m.get('0xb' + 'b'.repeat(39)), 'atlas');
      assert.ok(![...m.values()].includes('nova'));
    });
  });

  test('keyFromAgentId handles every namespace', () => {
    assert.equal(keyFromAgentId('agent_swarm_vega'), 'vega');
    assert.equal(keyFromAgentId('house_pulse'), 'pulse');
    assert.equal(keyFromAgentId('agent_sage'), 'sage');
    assert.equal(keyFromAgentId(''), '');
  });

  test('railForAgent classifies enabled vs SCA agents', () => {
    withEnv(ENV, () => {
      const m = railAddressesFromEnv();
      assert.equal(railForAgent('agent_swarm_vega', m), 'agent-wallet');
      assert.equal(railForAgent('agent_swarm_atlas', m), 'agent-wallet');
      assert.equal(railForAgent('agent_swarm_cygnus', m), 'sca');
      assert.equal(railForAgent('house_pulse', m), 'sca'); // pulse not on Agent Stack here
      assert.equal(railForAgent('agent_swarm_vega', new Map()), 'sca'); // empty map
    });
  });
});

describe('peer reputation pure helpers', () => {
  test('duel scores: win 90 / loss 40', () => {
    assert.equal(scoreForDuel(true), 90);
    assert.equal(scoreForDuel(false), 40);
  });

  test('signal scores clamp 10..95 and accept 0..1 or 0..100 forms', () => {
    assert.equal(scoreForSignal(0.52), 52);
    assert.equal(scoreForSignal(0.999), 95);
    assert.equal(scoreForSignal(85), 85);
    assert.equal(scoreForSignal(0.02), 10);
    assert.equal(scoreForSignal(undefined), 60);
    assert.equal(scoreForSignal('garbage'), 60);
  });

  test('reviewKey is stable across casing of the rater key only', () => {
    assert.equal(reviewKey('Vega', 'agent_swarm_nova', 'sig:1'), reviewKey('vega', 'agent_swarm_nova', 'sig:1'));
    assert.notEqual(reviewKey('vega', 'agent_swarm_nova', 'sig:1'), reviewKey('vega', 'agent_swarm_atlas', 'sig:1'));
    assert.notEqual(reviewKey('vega', 'agent_swarm_nova', 'sig:1'), reviewKey('vega', 'agent_swarm_nova', 'duel:2'));
  });

  test('feedbackHashOf is deterministic and input-sensitive', () => {
    const a = feedbackHashOf(keccak256, toHex, { raterKey: 'nova', targetUserId: 'x', refId: 'r1', score: 90, tag: 'duel-win' });
    const b = feedbackHashOf(keccak256, toHex, { raterKey: 'nova', targetUserId: 'x', refId: 'r1', score: 90, tag: 'duel-win' });
    const c = feedbackHashOf(keccak256, toHex, { raterKey: 'nova', targetUserId: 'x', refId: 'r1', score: 40, tag: 'duel-win' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^0x[0-9a-f]{64}$/);
  });

  test('candidateUserIds covers roster namespaces', () => {
    assert.deepEqual(candidateUserIds('vega'), ['agent_swarm_vega', 'agent_vega']);
  });
});
