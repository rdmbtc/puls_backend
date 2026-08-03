import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: { rejectUnauthorized: false },
});

const log = (s) => console.log(s);

try {
  const t = await pool.query(
    "SELECT side, usdc_amount, user_id FROM trades WHERE user_id LIKE 'agent_%'"
  );
  const rows = t.rows || [];
  const bySide = {};
  let neg = 0, sum = 0;
  for (const r of rows) {
    bySide[r.side] = (bySide[r.side] || 0) + 1;
    if (Number(r.usdc_amount) < 0) neg++;
    sum += Number(r.usdc_amount);
  }
  log('agent trades total: ' + rows.length + ' bySide: ' + JSON.stringify(bySide) + ' neg rows: ' + neg + ' sum: ' + sum.toFixed(4));

  const byAgent = {};
  for (const r of rows) {
    const b = byAgent[r.user_id] = byAgent[r.user_id] || { n: 0, s: 0 };
    b.n++; b.s += Number(r.usdc_amount);
  }
  log('perAgent: ' + JSON.stringify(byAgent));

  const b = await pool.query('SELECT agent_key, amount_usdc, status FROM agent_bonds');
  log('bonds count: ' + b.rows.length);
  const agg = {};
  for (const r of b.rows) {
    const k = agg[r.agent_key] = agg[r.agent_key] || { total: 0, by: {} };
    k.total += Number(r.amount_usdc || 0);
    k.by[r.status] = (k.by[r.status] || 0) + 1;
  }
  log('bonds: ' + JSON.stringify(agg).slice(0, 1200));

  const p = await pool.query('SELECT payer, pay_to, amount_usdc, endpoint FROM x402_payments');
  log('payments count: ' + p.rows.length);
  let agentOut = 0, agentIn = 0;
  for (const r of p.rows) {
    if (String(r.payer).startsWith('agent_')) agentOut += Number(r.amount_usdc || 0);
    if (String(r.pay_to).startsWith('agent_')) agentIn += Number(r.amount_usdc || 0);
  }
  log('payments agentOut=' + agentOut.toFixed(3) + ' agentIn=' + agentIn.toFixed(3));
} catch (e) {
  log('PROBE ERR: ' + e.message);
}
await pool.end();
process.exit(0);
