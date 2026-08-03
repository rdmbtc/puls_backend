const rpc = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const tx = '0x13fa9bb30b';
const { rows } = await new (await import('pg')).Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  .query("SELECT tx_hash FROM trades WHERE tx_hash LIKE $1 ORDER BY created_at DESC LIMIT 3", [tx + '%']);
console.log('txs:', JSON.stringify(rows));
const r = await fetch(rpc, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [rows[0]?.tx_hash] }),
});
console.log('raw receipt:', JSON.stringify((await r.json())?.result, null, 1).slice(0, 4000));
process.exit(0);
