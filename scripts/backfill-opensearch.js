import 'dotenv/config';
import { osClient, initIndices, indexMarket, indexSignal, indexDecision } from '../lib/opensearch.js';
import { createClient } from '@supabase/supabase-js';

import { createNeonClient } from '../lib/neon_supabase_adapter.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.DATABASE_URL;

if (!osClient) {
  console.error('[backfill] OPENSEARCH_URL is not set. Exiting.');
  process.exit(1);
}

let supabase = null;
if (dbUrl) {
  console.log('[backfill] using Neon database adapter (Aiven)');
  supabase = createNeonClient(dbUrl);
} else if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.error('[backfill] Neither SUPABASE_URL nor DATABASE_URL is set. Exiting.');
  process.exit(1);
}

async function backfill() {
  console.log('[backfill] initializing OpenSearch indices...');
  await initIndices();

  // 1. Index all deployed markets
  console.log('[backfill] fetching deployed markets from Supabase...');
  const { data: markets, error: mErr } = await supabase
    .from('deployed_markets')
    .select('*');
  if (mErr) {
    console.error('[backfill] failed to fetch markets:', mErr.message);
  } else if (markets) {
    for (const m of markets) {
      await indexMarket(m);
    }
    console.log(`[backfill] indexed ${markets.length} markets into OpenSearch`);
  }

  // 2. Index all creator signals
  console.log('[backfill] fetching creator signals from Supabase...');
  const { data: signals, error: sErr } = await supabase
    .from('creator_signals')
    .select('*');
  if (sErr) {
    console.error('[backfill] failed to fetch signals:', sErr.message);
  } else if (signals) {
    for (const s of signals) {
      await indexSignal(s);
    }
    console.log(`[backfill] indexed ${signals.length} signals into OpenSearch`);
  }

  // 3. Index agent notifications/decisions
  console.log('[backfill] fetching agent decisions from notifications...');
  const { data: notifications, error: nErr } = await supabase
    .from('notifications')
    .select('*')
    .eq('type', 'agent_decision')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (nErr) {
    console.error('[backfill] failed to fetch notifications:', nErr.message);
  } else if (notifications) {
    let count = 0;
    for (const n of notifications) {
      try {
        const payload = typeof n.message === 'string' ? JSON.parse(n.message) : n.message;
        if (payload) {
          await indexDecision(n.user_id, {
            action: 'go',
            question: payload.question || payload.slug || n.title,
            reasoning: payload.reasoning || '',
            side: payload.side || null,
            amount: payload.amount || 0,
            confidence: payload.confidence || null,
            at: n.created_at
          });
          count++;
        }
      } catch (_) {}
    }
    console.log(`[backfill] indexed ${count} agent decisions into OpenSearch`);
  }

  console.log('[backfill] OpenSearch backfill complete!');
}

backfill()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[backfill] error:', err);
    process.exit(1);
  });
