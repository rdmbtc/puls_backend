import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const { data: markets } = await supabase.from('deployed_markets').select('slug, contract_address');
  const contractToSlug = {};
  for (const m of markets) {
    if (m.contract_address && m.slug) {
      contractToSlug[m.contract_address.toLowerCase()] = m.slug;
    }
  }

  const { data: comments } = await supabase.from('comments').select('id, target_id').eq('target_type', 'market');
  let updated = 0;
  for (const c of comments || []) {
    const target = c.target_id || '';
    if (target.startsWith('0x')) {
      const slug = contractToSlug[target.toLowerCase()];
      if (slug) {
        await supabase.from('comments').update({ target_id: slug }).eq('id', c.id);
        updated++;
      }
    }
  }
  console.log(`Updated ${updated} comments!`);
}
main();
