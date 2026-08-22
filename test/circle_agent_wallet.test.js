import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keyFromUser,
  isEnabled,
  isEnabledForUser,
  addressFor,
  ensureSession,
  parseBalanceTable,
} from '../lib/circle_agent_wallet.js';

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

describe('agent key mapping', () => {
  test('keyFromUser extracts the swarm agent key', () => {
    assert.equal(keyFromUser('agent_swarm_vega'), 'vega');
    assert.equal(keyFromUser('vega'), 'vega');
    assert.equal(keyFromUser(''), '');
    assert.equal(keyFromUser(undefined), '');
  });

  test('isEnabled gates on the CIRCLE_AGENT_WALLETS list', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: 'vega, atlas' }, () => {
      assert.equal(isEnabled('vega'), true);
      assert.equal(isEnabled('atlas'), true);
      assert.equal(isEnabled('orion'), false);
      assert.equal(isEnabled(''), false);
      assert.equal(isEnabled(undefined), false);
    });
    withEnv({ CIRCLE_AGENT_WALLETS: '' }, () => {
      assert.equal(isEnabled('vega'), false);
    });
  });

  test('isEnabledForUser returns the key only when enabled', () => {
    withEnv({ CIRCLE_AGENT_WALLETS: 'vega' }, () => {
      assert.equal(isEnabledForUser('agent_swarm_vega'), 'vega');
      assert.equal(isEnabledForUser('agent_swarm_orion'), null);
    });
  });

  test('addressFor reads the per-key env var', () => {
    withEnv({ CIRCLE_AGENT_WALLET_ADDRESS_VEGA: '0xabc' }, () => {
      assert.equal(addressFor('vega'), '0xabc');
      assert.equal(addressFor('orion'), null);
    });
  });
});

describe('ensureSession', () => {
  test('materializes session.json from CIRCLE_AGENT_SESSION_B64', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-cli-test-'));
    withEnv({
      CIRCLE_CLI_HOME: tmp,
      CIRCLE_AGENT_SESSION_B64: Buffer.from(JSON.stringify({ email: 't@x.y', testnet: {} })).toString('base64'),
    }, () => {
      const res = ensureSession({ force: true });
      assert.equal(res.ok, true);
      assert.equal(res.source, 'CIRCLE_AGENT_SESSION_B64');
      const file = path.join(tmp, 'profiles', 'agent', 'session.json');
      assert.ok(fs.existsSync(file));
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(parsed.email, 't@x.y');
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('reports missing session when neither var nor file exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-cli-test-'));
    withEnv({ CIRCLE_CLI_HOME: tmp, CIRCLE_AGENT_SESSION_B64: '' }, () => {
      const res = ensureSession({ force: true });
      assert.equal(res.ok, false);
      assert.ok(res.reason);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('balance table parsing', () => {
  const table = [
    '┌───────┬────────┬────────┬────────┬────────────┐',
    '│ Token │ Symbol │ Amount │ Native │ Address',
    '│ USDC  │ USDC   │ 13.5   │ true   │ -',
    '│ USDC  │ USDC   │ 12.25  │ false  │ 0x3600…',
    '└───────┴────────┴────────┴────────┴────────────┘',
  ].join('\n');

  test('prefers the ERC20 (non-native) USDC row', () => {
    assert.equal(parseBalanceTable(table), 12.25);
  });

  test('falls back to any USDC row and returns NaN when absent', () => {
    const nativeOnly = table.split('\n').slice(0, 3).concat(['└───┘']).join('\n');
    assert.equal(parseBalanceTable(nativeOnly), 13.5);
    assert.ok(Number.isNaN(parseBalanceTable('no table here')));
  });
});
