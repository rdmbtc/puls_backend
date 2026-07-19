import 'dotenv/config';
import crypto from 'crypto';

// Fetch the real public key from Circle
const res = await fetch('https://api.circle.com/v1/w3s/config/entity/publicKey', {
  headers: { 'Authorization': `Bearer ${process.env.CIRCLE_API_KEY}` }
});
const json = await res.json();
const publicKey = json.data.publicKey;
console.log('Public key fetched, length:', publicKey.length);

const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const secretBytes = Buffer.from(entitySecret, 'hex');

const encrypted = crypto.publicEncrypt(
  { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  secretBytes
);

const ciphertext = encrypted.toString('base64');
console.log('\nCiphertext length:', ciphertext.length);
console.log('\nPaste this in Circle Console → Entity Secret → Register:');
console.log(ciphertext);
