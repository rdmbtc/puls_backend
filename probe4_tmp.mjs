import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: { rejectUnauthorized: false },
});
const log = (s) => console.log(s);

const USDC = '0x3600000000000000000000000000000000000000';
const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const call = async (method, params) => {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};

const balanceOf = async (addr) => {
  const data = '0x70a08231000000000000000000000000' + addr.slice(2).toLowerCase();
  const res = await call('eth_call', [{ to: USDC, data }, 'latest']);
  return res ? Number(BigInt(res)) / 1e6 : NaN;
};

try {
  const agents = ['agent_swarm_nova', 'agent_swarm_atlas', 'agent_swarm_cygnus', 'agent_swarm_vega', 'agent_swarm_striker', 'agent_swarm_orion', 'agent_agent_sage'];
  let total = 0;
  for (const a of agents) {
    const { rows } = await pool.query(
      "SELECT tx_hash, side, usdc_amount FROM trades WHERE user_id = $1 AND tx_hash IS NOT NULL AND state='COMPLETE' AND tx_hash != '' ORDER BY created_at DESC LIMIT 1",
      [a]
    );
    const tx = rows[0]?.tx_hash;
    if (!tx) { log(`${a}: no tx`); continue; }
    let addr = null;
    try {
      const rc = await call('eth_getTransactionReceipt', [tx]);
      if (rc && rc.logs && rc.logs.length) {
        const log0 = rc.logs[0];
        addr = log0.topics[1] ? '0x' + log0.topics[1].slice(26) : null;
      }
    } catch (e) { log(`${a}: rc err ${e.message}`); }
    if (!addr) { log(`${a}: no addr from tx ${tx.slice(0, 12)}`); continue; }
    const bal = await balanceOf(addr);
    total += bal;
    log(`${a}: addr=${addr} usdc=${bal.toFixed(4)} (tx ${tx.slice(0, 12)})`);
  }
  log('TOTAL agents wallet usdc: ' + total.toFixed(4));
} catch (e) {
  log('PROBE ERR: ' + e.message);
}
await pool.end();
process.exit(0);
