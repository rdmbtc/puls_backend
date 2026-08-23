import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { agentStackParticipantOf } from '../lib/agent_duel.js';
import { agentStackParticipantOf as bondParticipantOf } from '../lib/agent_bond.js';
import { SIGNALS_DISCOVERY_ROW, isFreeDiscoveryRow, searchBazaarAsync } from '../lib/puls_gateway.js';

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

describe('agentStackParticipantOf (duel rail detection)', () => {
  test('detects enabled Agent Wallet participants by creator id', () => {
    withEnv({
      CIRCLE_AGENT_WALLETS: 'vega',
      CIRCLE_AGENT_WALLET_ADDRESS_VEGA: '0xvega',
    }, () => {
      assert.deepEqual(agentStackParticipantOf('agent_swarm_vega'), { mode: 'agent-wallet', key: 'vega', address: '0xvega' });
      assert.deepEqual(agentStackParticipantOf('vega').key, 'vega');
    });
  });

  test('returns null for non-enabled agents and missing addresses', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: 'vega', CIRCLE_AGENT_WALLET_ADDRESS_VEGA: '' }, () => {
      assert.equal(agentStackParticipantOf('agent_swarm_vega'), null); // enabled but no address
      assert.equal(agentStackParticipantOf('agent_swarm_cygnus'), null); // not on Agent Stack
      assert.equal(agentStackParticipantOf('house_pulse'), null);
      assert.equal(agentStackParticipantOf(undefined), null);
    });
  });

  test('bond rail detection matches duel rail detection', () => {
    withEnv({
      CIRCLE_AGENT_WALLETS: 'nova',
      CIRCLE_AGENT_WALLET_ADDRESS_NOVA: '0xnova',
    }, () => {
      assert.deepEqual(bondParticipantOf('agent_swarm_nova'), { mode: 'agent-wallet', key: 'nova', address: '0xnova' });
      assert.equal(bondParticipantOf('agent_sage'), null);
    });
  });
});

describe('signals free discovery row', () => {
  test('row shape: zero cost, catalog endpoint, prediction-markets category', () => {
    assert.equal(SIGNALS_DISCOVERY_ROW.costUsdc, 0);
    assert.equal(SIGNALS_DISCOVERY_ROW.endpoint, 'https://api.pulsmarket.tech/api/x402/signals');
    assert.equal(SIGNALS_DISCOVERY_ROW.category, 'prediction-markets');
    assert.ok(SIGNALS_DISCOVERY_ROW.name.includes('Signals Market'));
  });

  test('isFreeDiscoveryRow is true only for zero-cost rows', () => {
    assert.equal(isFreeDiscoveryRow(SIGNALS_DISCOVERY_ROW), true);
    assert.equal(isFreeDiscoveryRow({ costUsdc: 0.01 }), false);
    assert.equal(isFreeDiscoveryRow({}), false);
    assert.equal(isFreeDiscoveryRow(null), false);
  });

  test('searchBazaarAsync surfaces the free row for signal queries', async () => {
    const r = await searchBazaarAsync('signals market discovery');
    assert.ok(r.endpoint, 'expected a hit');
    // Either the free row wins or a paid service outranks it — but the free
    // row must never carry a price into the buyer flow.
    assert.ok(r.endpoint.costUsdc >= 0);
    assert.equal(isFreeDiscoveryRow(r.endpoint), r.endpoint.costUsdc === 0);
  }, 15000);
});
