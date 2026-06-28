// Puls Streams — autonomous streaming-agent ORCHESTRATOR test.
//   node --test test/streaming_agent_run.test.js
// Drives registerStreamingAgent(...).runSession() with mocked streamsApi /
// Supabase / wallet to prove the full loop: decide -> open -> heartbeat ticks
// -> stop -> log an agent_decision. Also proves the GO/NO-GO restraint path
// (low conviction => it pays nothing and logs a skip).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_AGENT_ENABLED = 'true';
process.env.STREAM_AGENT_MAX_TICKS = '2';   // keep the loop short
process.env.STREAM_AGENT_TICK_SEC = '1';    // min clamp is 1s -> ~2s per run

const { registerStreamingAgent } = await import('../lib/streaming_agent.js');

function harness(confidence) {
  const calls = { opened: null, ticks: 0, stopped: null, decisions: [] };

  const streamsApi = {
    openStream: async (p) => {
      calls.opened = p;
      return { id: 's1', status: 'active', accruedUsdc: 0, settledUsdc: 0, remainingUsdc: p.capUsdc, ratePerSecUsdc: p.ratePerSecUsdc };
    },
    tick: async (id) => {
      calls.ticks += 1;
      return { id, status: 'active', accruedUsdc: 0.001 * calls.ticks, settledUsdc: 0, remainingUsdc: 1 };
    },
    stop: async (id) => {
      calls.stopped = id;
      return { id, status: 'stopped', accruedUsdc: 0.002, settledUsdc: 0.002, settleTx: '0xabc' };
    },
  };

  const supabase = {
    from: (table) => {
      if (table === 'notifications') {
        return { insert: async (row) => { calls.decisions.push(row); return { error: null }; } };
      }
      // creator_signals — the conviction lookup chain
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: { confidence, title: 'BTC to $150k by 2026' }, error: null }),
      };
      return chain;
    },
  };

  const api = registerStreamingAgent({
    streamsApi,
    supabase,
    getWalletId: async (uid) => 'w_' + uid,
    getWalletInfo: async () => ({ usdcBalance: '5.00', address: '0x' + '1'.repeat(40) }),
    // llmComplete intentionally omitted -> the EV model stands alone
    roster: [
      { key: 'vega', name: 'Vega', role: 'trader', user: 'agent_swarm_vega', brain: 'gpt-oss' },
      { key: 'sage', name: 'Sage', role: 'creator', user: 'agent_sage', brain: 'mistral' },
    ],
  });
  return { api, calls };
}

test('runSession (high conviction): decide -> open -> tick -> stop -> log a stream decision', async () => {
  const { api, calls } = harness(0.8);
  await api.runSession();

  // opened a stream from the trader to the creator, with an EV-bounded rate + cap
  assert.ok(calls.opened, 'should have opened a stream');
  assert.equal(calls.opened.payerUserId, 'agent_swarm_vega');
  assert.equal(calls.opened.recipientUserId, 'agent_sage');
  assert.equal(calls.opened.openedBy, 'agent');
  assert.ok(calls.opened.ratePerSecUsdc > 0 && calls.opened.ratePerSecUsdc <= 0.02);
  assert.ok(calls.opened.capUsdc > 0);

  // heartbeated, then stopped
  assert.equal(calls.ticks, 2, `ticked ${calls.ticks} times`);
  assert.equal(calls.stopped, 's1');

  // logged exactly one agent_decision with action 'stream' + the numbers
  assert.equal(calls.decisions.length, 1);
  const d = JSON.parse(calls.decisions[0].message);
  assert.equal(calls.decisions[0].type, 'agent_decision');
  assert.equal(d.action, 'stream');
  assert.equal(d.ratePerSecUsdc, calls.opened.ratePerSecUsdc);
  assert.ok('settledUsdc' in d && 'stopReason' in d);
  assert.ok(typeof d.reasoning === 'string' && d.reasoning.length > 0);
});

test('runSession (low conviction): GO/NO-GO restraint — pays nothing, logs a skip', async () => {
  const { api, calls } = harness(0.1);
  await api.runSession();

  assert.equal(calls.opened, null, 'should NOT open a stream when conviction is low');
  assert.equal(calls.ticks, 0);
  assert.equal(calls.stopped, null);
  assert.equal(calls.decisions.length, 1);
  assert.equal(JSON.parse(calls.decisions[0].message).action, 'stream_skip');
});
