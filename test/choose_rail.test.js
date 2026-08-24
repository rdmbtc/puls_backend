import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRail, RAIL } from '../lib/agent_rail.js';

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

describe('chooseRail — the dual-rail decision', () => {
  test('walletId present → sca (even for enabled keys)', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: 'vega' }, () => {
      assert.equal(chooseRail('w_123', 'vega'), RAIL.SCA);
      assert.equal(chooseRail('w_123', null), RAIL.SCA);
      // truthiness: empty-string walletId is NOT a wallet
      assert.notEqual(chooseRail('', 'vega'), RAIL.SCA);
    });
  });

  test('no walletId + enabled agent key → agent-wallet', () => {
    withEnv({
      CIRCLE_AGENT_WALLETS: 'nova',
      CIRCLE_AGENT_WALLET_ADDRESS_NOVA: '0xnova',
    }, () => {
      assert.equal(chooseRail(null, 'nova'), RAIL.AGENT_WALLET);
      assert.equal(chooseRail(null, 'NOVA'), RAIL.AGENT_WALLET); // case-insensitive
      assert.equal(chooseRail(undefined, 'nova'), RAIL.AGENT_WALLET);
    });
  });

  test('no walletId + unknown key → none', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: 'nova' }, () => {
      assert.equal(chooseRail(null, 'striker'), RAIL.NONE);
      assert.equal(chooseRail(null, ''), RAIL.NONE);
      assert.equal(chooseRail(null, null), RAIL.NONE);
      assert.equal(chooseRail(null, undefined), RAIL.NONE);
    });
  });

  test('empty CIRCLE_AGENT_WALLETS disables the Agent-Stack branch entirely', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: '' }, () => {
      assert.equal(chooseRail(null, 'vega'), RAIL.NONE);
      assert.equal(chooseRail('wid', 'vega'), RAIL.SCA);
    });
  });
});
