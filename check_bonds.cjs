require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  const { data, error } = await supabase.from('creator_signals').select('id, creator_user_id, bond_amount_usdc, bond_status').not('bond_status', 'is', null).order('bond_posted_at', { ascending: false }).limit(5);
  console.log('Error:', error);
  console.log('Data:', data);
}
check();
