import 'dotenv/config';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

try {
  // generateEntitySecretCiphertext encrypts your secret with Circle's public key
  const { entitySecretCiphertext } = circle.generateEntitySecretCiphertext();
  console.log('Ciphertext generated, registering...');

  await circle.registerEntitySecretCiphertext({ entitySecretCiphertext });
  console.log('✅ Entity secret registered!');
} catch (e) {
  console.error('Error:', e.message ?? e);
}
