// ── One-shot settlement-claim sync (see lib/agent_pnl.js syncSettlementClaims) ──
// Backfills CLAIM rows into `trades` for agent positions on markets that
// resolved in their favour but were claimed on-chain directly (no DB row).
// Idempotent — safe to run repeatedly.
//
//   node scripts/sync_agent_claims.mjs
//
// Env: DATABASE_URL.
import 'dotenv/config';
import { createNeonClient } from '../lib/neon_supabase_adapter.js';
import { syncSettlementClaims } from '../lib/agent_pnl.js';

const supabase = createNeonClient(process.env.DATABASE_URL);
const n = await syncSettlementClaims(supabase);
console.log(`[sync_agent_claims] done — ${n} CLAIM rows inserted`);
process.exit(0);
