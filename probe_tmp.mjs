import { createClient } from '@supabase/supabase-js';

const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

const out = [];
const log = (s) => { out.push(s); console.log(s); };

const { data: trades, error: e1 } = await c.from('trades').select('side,usdc_amount,user_id').like('user_id', 'agent_%');
log('trades err: ' + (e1?.message || 'none'));
const rows = trades || [];
const bySide = {};
let neg = 0, sum = 0;
for (const t of rows) {
  bySide[t.side] = (bySide[t.side] || 0) + 1;
  if (Number(t.usdc_amount) < 0) neg++;
  sum += Number(t.usdc_amount);
}
log('agent trades total: ' + rows.length + ' bySide: ' + JSON.stringify(bySide) + ' neg rows: ' + neg + ' sum usdc: ' + sum.toFixed(4));

const byAgent = {};
for (const t of rows) {
  const b = byAgent[t.user_id] = byAgent[t.user_id] || { n: 0, s: 0 };
  b.n++; b.s += Number(t.usdc_amount);
}
log('perAgent: ' + JSON.stringify(byAgent));

const { data: bonds, error: e2 } = await c.from('agent_bonds').select('agent_key,amount_usdc,status');
log('bonds err: ' + (e2?.message || 'none') + ' count: ' + (bonds?.length || 0));
if (bonds) {
  const agg = {};
  for (const b of bonds) {
    const k = agg[b.agent_key] = agg[b.agent_key] || { total: 0, by: {} };
    k.total += Number(b.amount_usdc || 0);
    k.by[b.status] = (k.by[b.status] || 0) + 1;
  }
  log('bonds: ' + JSON.stringify(agg).slice(0, 1200));
}

const { data: payments, error: e3 } = await c.from('x402_payments').select('payer,pay_to,amount_usdc,endpoint').limit(3000);
log('payments err: ' + (e3?.message || 'none') + ' count: ' + (payments?.length || 0));
if (payments) {
  let agentIn = 0, agentOut = 0;
  for (const p of payments) {
    if (String(p.payer).startsWith('agent_')) agentOut += Number(p.amount_usdc || 0);
    if (String(p.pay_to).startsWith('agent_')) agentIn += Number(p.amount_usdc || 0);
  }
  log('payments: agentOut=' + agentOut.toFixed(3) + ' agentIn=' + agentIn.toFixed(3));
}

process.exit(0);
