import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } });
const log = (s) => console.log(s);

const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const call = async (method, params) => {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};

const POS_ABI = '0x7b29e7d1'; // placeholder not used; we call via data below

try {
  // A) vega on ks-03-house-seat
  const { rows: ks } = await pool.query(
    "SELECT market_id, side, usdc_amount, created_at FROM trades WHERE user_id='agent_swarm_vega' AND question ILIKE '%ks 03 house seat%' ORDER BY created_at DESC LIMIT 5"
  );
  log('vega ks-03 rows: ' + JSON.stringify(ks));
  if (ks.length) {
    const c = ks[0].market_id;
    const sel = '0x' + '70a08231000000000000000000000000'.slice(0, 10) + 'f1a06f6a' + ''.padEnd(0);
    // getUserPosition((address)) selector = 0x2f2d1e8c? compute properly below instead
    // compute selector keccak("getUserPosition(address)") manually:
    log('contract=' + c);
  }

  // B) resolved stats among markets agents traded on
  const { rows: resolved } = await pool.query(
    "SELECT dm.resolved, dm.outcome, COUNT(DISTINCT t.market_id) AS mkts, COUNT(t.id) AS trades " +
    "FROM deployed_markets dm JOIN trades t ON t.market_id = dm.contract_address " +
    "WHERE t.user_id LIKE 'agent_swarm_%' AND t.state='COMPLETE' GROUP BY dm.resolved, dm.outcome"
  );
  log('deployed_markets resolved stats: ' + JSON.stringify(resolved));

  const { rows: all } = await pool.query(
    "SELECT COUNT(DISTINCT market_id) AS mkts, COUNT(*) AS trades FROM trades WHERE user_id LIKE 'agent_swarm_%' AND state='COMPLETE'"
  );
  log('all agent markets/trades: ' + JSON.stringify(all));

  const { rows: claims } = await pool.query(
    "SELECT side, usdc_amount, created_at FROM trades WHERE user_id LIKE 'agent_%' AND side='CLAIM' ORDER BY created_at DESC"
  );
  log('claims: ' + JSON.stringify(claims));
} catch (e) {
  log('PROBE ERR: ' + e.message);
}
await pool.end();
process.exit(0);
