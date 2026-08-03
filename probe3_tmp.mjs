import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: { rejectUnauthorized: false },
});
const log = (s) => console.log(s);

const USDC = '0x3600000000000000000000000000000000000000';
const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const balanceOf = async (addr) => {
  const data = '0x70a08231000000000000000000000000' + addr.slice(2).toLowerCase();
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }),
  });
  const j = await r.json();
  return j.result ? Number(BigInt(j.result)) / 1e6 : NaN;
};

try {
  const w = await pool.query(
    "SELECT user_id, wallet_id, address FROM wallets WHERE user_id LIKE '%swarm%' OR user_id LIKE '%sage%' OR user_id = 'agent_house_pulse'"
  );
  log('wallet rows: ' + w.rows.length);
  let total = 0;
  for (const row of w.rows) {
    const addr = row.address || null;
    if (!addr) { log(`${row.user_id}: NO ADDRESS in db`); continue; }
    const bal = await balanceOf(addr);
    total += bal;
    log(`${row.user_id}: ${addr} usdc=${bal.toFixed(4)}`);
  }
  log('SWARM+SAGE TOTAL wallet usdc: ' + total.toFixed(4));
} catch (e) {
  log('PROBE ERR: ' + e.message);
}
await pool.end();
process.exit(0);
