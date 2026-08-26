import crypto from 'crypto';

// Interface to define the structure of an AES key and IV
export interface AESKey {
  key: Buffer;
  iv: Buffer;
}

// Function to generate a random AES-128 key and initialization vector (IV).
// Key and IV must be exactly 16 ASCII digit characters (matching the TP-Link
// Deco firmware expectation). We use the range [10^15, 10^16-1] so the decimal
// representation is always exactly 16 digits with no leading zeros.
export function generateAESKey(): AESKey {
  const randomSixteen = () =>
    (Math.floor(Math.random() * 9e15) + 1e15).toString();
  const key = Buffer.from(randomSixteen());
  const iv = Buffer.from(randomSixteen());

  // console.log(`GenerateAESKey: Generated AES Key: ${key.toString('hex')}`);
  // console.log(`GenerateAESKey: Generated AES IV: ${iv.toString('hex')}`);

  return { key, iv };
}

// Function to encrypt plaintext using AES-128-CBC mode
export function AES128Encrypt(plaintext: string, key: AESKey): string {
  try {
    // console.log('AES128Encrypt: Starting AES128 encryption.');
    // console.log(`AES128Encrypt: Plaintext to encrypt: ${plaintext}`);
    // console.log(`AES128Encrypt: Using AES Key: ${key.key.toString('hex')}`);
    // console.log(`AES128Encrypt: Using AES IV: ${key.iv.toString('hex')}`);

    // Node's cipher applies PKCS#7 padding automatically. Pre-padding here
    // would add a second padding block and leave trailing bytes after the
    // router decrypts the JSON payload.
    const cipher = crypto.createCipheriv('aes-128-cbc', key.key, key.iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const encryptedText = encrypted.toString('base64');
    // console.log(`AES128Encrypt: Encrypted text (base64): ${encryptedText}`);

    return encryptedText;
  } catch (e) {
    // console.log(`AES128Encrypt: Error during encryption: ${e}`);
    return '';
  }
}

// Function to decrypt ciphertext using AES-128-CBC mode
export function AES128Decrypt(encrypted: string, key: AESKey): string {
  try {
    // console.log('AES128Decrypt: Starting AES128 decryption.');
    // console.log(`AES128Decrypt: Encrypted text to decrypt: ${encrypted}`);
    // console.log(`AES128Decrypt: Using AES Key: ${key.key.toString('hex')}`);
    // console.log(`AES128Decrypt: Using AES IV: ${key.iv.toString('hex')}`);

    const cipherText = Buffer.from(encrypted, 'base64');
    // console.log(`AES128Decrypt: Ciphertext length: ${cipherText.length}`);

    const decipher = crypto.createDecipheriv('aes-128-cbc', key.key, key.iv);
    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);

    // console.log(`AES128Decrypt: Decrypted buffer length: ${decrypted.length}`);

    const decryptedText = decrypted.toString();
    // console.log(`AES128Decrypt: Decrypted text: ${decryptedText}`);

    return decryptedText;
  } catch (e) {
    // console.log(`AES128Decrypt: Error during decryption: ${e}`);
    return '';
  }
}
