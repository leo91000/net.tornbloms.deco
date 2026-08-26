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


  return { key, iv };
}

// Function to encrypt plaintext using AES-128-CBC mode
export function AES128Encrypt(plaintext: string, key: AESKey): string {
  try {

    // Node's cipher applies PKCS#7 padding automatically. Pre-padding here
    // would add a second padding block and leave trailing bytes after the
    // router decrypts the JSON payload.
    const cipher = crypto.createCipheriv('aes-128-cbc', key.key, key.iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const encryptedText = encrypted.toString('base64');

    return encryptedText;
  } catch (e) {
    return '';
  }
}

// Function to decrypt ciphertext using AES-128-CBC mode
export function AES128Decrypt(encrypted: string, key: AESKey): string {
  try {

    const cipherText = Buffer.from(encrypted, 'base64');

    const decipher = crypto.createDecipheriv('aes-128-cbc', key.key, key.iv);
    const decrypted = Buffer.concat([
      decipher.update(cipherText),
      decipher.final(),
    ]);


    const decryptedText = decrypted.toString();

    return decryptedText;
  } catch (e) {
    return '';
  }
}
