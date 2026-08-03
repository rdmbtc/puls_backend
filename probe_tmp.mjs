import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  ssl: { rejectUnauthorized: false },
});
const log = (s) => console.log(s);

const USDC = '0x3600000000000000000000000000000000000000';
const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const circleKey = process.env.CIRCLE_API_KEY || '';

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
  const w = await pool.query("SELECT user_id, wallet_id FROM wallets WHERE user_id LIKE 'agent_%'");
  log('wallets: ' + JSON.stringify(w.rows));

  for (const row of w.rows) {
    let addr = null;
    try {
      const r = await fetch(`https://api.circle.com/v1/wallets/${row.wallet_id}`, {
        headers: { Authorization: `Bearer ${circleKey}` },
      });
      const j = await r.json();
      addr = j?.data?.wallet?.address || null;
    } catch (e) { log(row.user_id + ' circle err: ' + e.message); }
    let bal = NaN;
    if (addr) bal = await balanceOf(addr);
    log(`${row.user_id}: addr=${addr} usdc=${Number.isNaN(bal) ? 'ERR' : bal.toFixed(4)}`);
  }

  if (process.env.PRIVATE_KEY) {
    const { privateKeyToAccount } = await import('viem/accounts');
    const admin = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : '0x' + process.env.PRIVATE_KEY);
    const tb = await balanceOf(admin.address);
    log(`treasury(admin): addr=${admin.address} usdc=${Number.isNaN(tb) ? 'ERR' : tb.toFixed(4)}`);
  }
} catch (e) {
  log('PROBE ERR: ' + e.message);
}
await pool.end();
process.exit(0);
