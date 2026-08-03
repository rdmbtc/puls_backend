const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const pool = new (await import('pg')).Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query("SELECT tx_hash FROM trades WHERE tx_hash LIKE '0x13fa9bb30b%' ORDER BY created_at DESC LIMIT 1");
const r = await fetch(rpc, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [rows[0]?.tx_hash] }),
});
const res = (await r.json())?.result;
console.log('status=' + res?.status + ' to=' + res?.to + ' logs=' + (res?.logs?.length ?? 0));
for (const [i, l] of (res?.logs || []).entries()) {
  console.log(`log${i} addr=${l.address} topics=${JSON.stringify(l.topics)}`);
}
await pool.end();
process.exit(0);
