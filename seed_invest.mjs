import { createNeonClient } from './lib/neon_supabase_adapter.js';

const supabase = createNeonClient(process.env.DATABASE_URL);
const TREASURY = '0xd138925168ad03fee0cca73cd949f1077c82c093';
const AMOUNT = 100;

const agents = (await (await fetch('https://api.pulsmarket.tech/api/invest/agents')).json()).agents;
console.log('agents:', agents.length);

for (const a of agents) {
  const paymentId = `seed-treasury-100-${a.id}`;
  const { error } = await supabase
    .from('investments')
    .upsert({
      id: `inv_seed_${a.id}`.slice(0, 63),
      payment_id: paymentId,
      investor_address: TREASURY,
      agent_id: a.id,
      amount_usdc: AMOUNT,
      status: 'active',
    }, { onConflict: 'payment_id' });
  if (error) console.error(`FAIL ${a.id}:`, error.message);
  else console.log(`OK ${a.id} +${AMOUNT} (${a.name})`);
}
process.exit(0);
