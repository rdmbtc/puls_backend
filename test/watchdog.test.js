import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countStuckTxRefs } from '../lib/agent_duel.js';

const UUID = '8d614039-0000-0000-0000-000000000000';
const HASH = '0x' + 'a'.repeat(64);
const OLD = '2026-08-23T00:00:00Z';
const NEW = '2026-08-24T00:00:00Z';
const CUTOFF = '2026-08-23T12:00:00Z'; // 1h+ before NEW, after OLD

describe('countStuckTxRefs (zombie watchdog v2)', () => {
  test('counts non-0x refs older than the cutoff across both tables', () => {
    const stuck = countStuckTxRefs({
      duelRows: [
        { open_tx: UUID, opened_at: OLD, join_tx: UUID, joined_at: OLD }, // +2
        { open_tx: HASH, opened_at: OLD },                                // settled → skip
      ],
      bondRows: [
        { bond_post_tx: UUID, bond_posted_at: OLD }, // +1
      ],
    }, CUTOFF);
    assert.equal(stuck, 3);
  });

  test('ignores fresh submissions and missing timestamps', () => {
    const stuck = countStuckTxRefs({
      duelRows: [{ open_tx: UUID, opened_at: NEW }],
      bondRows: [{ bond_post_tx: UUID }], // no timestamp → not provably stuck
    }, CUTOFF);
    assert.equal(stuck, 0);
  });
});
