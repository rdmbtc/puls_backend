import { createNeonClient } from './lib/neon_supabase_adapter.js';
const supabase = createNeonClient(process.env.DATABASE_URL);
const q1 = await supabase.from('wallets').select('user_id, wallet_id, address').limit(10);
console.log('wallets sample:', JSON.stringify(q1.data, null, 1), 'err:', q1.error?.message);
const q2 = await supabase.from('wallets').select('user_id').like('user_id', 'agent_%');
console.log('like agent_%:', (q2.data || []).length);
const q3 = await supabase.from('wallets').select('user_id').ilike('user_id', '%swarm%');
console.log('ilike %swarm%:', (q3.data || []).length);
process.exit(0);
