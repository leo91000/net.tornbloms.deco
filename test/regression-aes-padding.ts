import assert from 'node:assert/strict';
import { AES128Decrypt, AES128Encrypt, AESKey } from '../lib/utils/aes';

const key: AESKey = {
  key: Buffer.from('1234567890123456'),
  iv: Buffer.from('6543210987654321'),
};

// Matches the byte length of the BE65 Pro login payload captured from its
// browser UI: 302 plaintext bytes must become 304 ciphertext bytes with one
// standard PKCS#7 padding pass. A second padding pass grows it to 320 bytes
// and leaves padding bytes after decryption, which the router rejects as JSON.
const plaintext = 'x'.repeat(302);
const encrypted = AES128Encrypt(plaintext, key);

assert.equal(Buffer.from(encrypted, 'base64').length, 304);
assert.equal(AES128Decrypt(encrypted, key), plaintext);

console.log('PASS: AES encryption applies PKCS#7 padding exactly once.');
