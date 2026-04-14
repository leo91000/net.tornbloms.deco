import { generateRsaKey, encryptRsa } from '././utils/rsa';
import {
  AESKey,
  generateAESKey,
  AES128Encrypt,
  AES128Decrypt,
} from '././utils/aes';
import { HttpClient, AppLogger } from './http';
import { KeyObject } from 'crypto';

// Buffer for the default body used in read operations
const readBody = Buffer.from(JSON.stringify({ operation: 'read' }));

const consoleLogger: AppLogger = { log: console.log, error: console.error };

// Interface for the structure of the password key response
interface PasswordKeyResponse {
  result: {
    username: string;
    password: string[];
  };
  error_code: number;
}

// Interface for the structure of the session key response
interface SessionKeyResponse {
  result: {
    seq: number;
    key: string[];
  };
  error_code: number;
}

// Interface for the structure of the response data
interface ResponseData {
  data: string;
}

// Interface for endpoint arguments
interface EndpointArgs {
  form: string;
}

// Deco class handles encryption, decryption, and communication with the server
export default class Deco {
  private aes: AESKey;
  private hash: string;
  private rsa: KeyObject;
  private sequence: number;
  private c: HttpClient;
  private logger: AppLogger;

  // Constructor initializes the Deco instance with necessary encryption keys and HTTP client
  constructor(
    aes: AESKey,
    hash: string,
    rsa: KeyObject,
    sequence: number,
    httpClient: HttpClient,
    logger: AppLogger = consoleLogger,
  ) {
    this.aes = aes;
    this.hash = hash;
    this.rsa = rsa;
    this.sequence = sequence;
    this.c = httpClient;
    this.logger = logger;
  }

  // Update the encryption context (e.g. after a new session key is obtained)
  public updateContext(
    aes: AESKey,
    hash: string,
    rsa: KeyObject,
    sequence: number,
  ) {
    this.aes = aes;
    this.hash = hash;
    this.rsa = rsa;
    this.sequence = sequence;
  }

  // Static method to generate a new AES key
  public static generateAESKey(): AESKey {
    return generateAESKey();
  }

  // Method to retrieve the password key from the server and generate an RSA key from it
  public async getPasswordKey(): Promise<KeyObject | null> {
    const args: EndpointArgs = { form: 'keys' };
    this.logger.log('deco.ts: getPasswordKey: requesting /login?form=keys');
    try {
      const passKey: PasswordKeyResponse = await this.doPost(
        ';stok=/login',
        args,
        readBody,
      );
      this.logger.log('deco.ts: getPasswordKey: response error_code:', passKey?.error_code);

      if (passKey.error_code !== 0) {
        this.logger.error('deco.ts: getPasswordKey: non-zero error_code, full response:', JSON.stringify(passKey));
        throw new Error(`Error fetching password key: ${passKey.error_code}`);
      }

      const key = generateRsaKey(passKey.result.password);
      if (!key) {
        this.logger.error('deco.ts: getPasswordKey: generateRsaKey returned null for password array:', passKey.result.password);
      }
      return key;
    } catch (e) {
      this.logger.error('deco.ts: getPasswordKey failed:', e);
      return null;
    }
  }

  // Method to retrieve the session key from the server and generate an RSA key from it
  public async getSessionKey(): Promise<{
    key: KeyObject | null;
    seq: number;
  }> {
    const args: EndpointArgs = { form: 'auth' };
    this.logger.log('deco.ts: getSessionKey: requesting /login?form=auth');
    try {
      const passKey: SessionKeyResponse = await this.doPost(
        ';stok=/login',
        args,
        readBody,
      );
      this.logger.log('deco.ts: getSessionKey: response error_code:', passKey?.error_code, 'seq:', passKey?.result?.seq);

      if (passKey.error_code !== 0) {
        this.logger.error('deco.ts: getSessionKey: non-zero error_code, full response:', JSON.stringify(passKey));
        throw new Error(`Error fetching session key: ${passKey.error_code}`);
      }

      const key = generateRsaKey(passKey.result.key);
      if (!key) {
        this.logger.error('deco.ts: getSessionKey: generateRsaKey returned null for key array:', passKey.result.key);
      }
      return { key, seq: passKey.result.seq };
    } catch (e) {
      this.logger.error('deco.ts: getSessionKey failed:', e);
      return { key: null, seq: 0 };
    }
  }

  // Method to send an encrypted POST request to the server
  public async doEncryptedPost(
    path: string,
    params: EndpointArgs,
    body: Buffer,
    isLogin: boolean,
    key: KeyObject = this.rsa,
    sequence: number = this.sequence,
  ): Promise<any> {
    if (!key) {
      throw new Error('RSA key is missing or undefined.');
    }

    this.logger.log(
      `deco.ts: doEncryptedPost: path=${path} form=${params.form} isLogin=${isLogin}`,
      `aesKeyLen=${String(this.aes.key).length} aesIvLen=${String(this.aes.iv).length}`,
      `seq=${sequence}`,
    );

    try {
      // Encrypt the data using AES
      var encryptedData = AES128Encrypt(body.toString(), this.aes);
      this.logger.log(`deco.ts: doEncryptedPost: AES encryptedData length=${encryptedData.length}`);

      const length = Number(sequence) + encryptedData.length;
      let sign: string;

      // Generate sign data depending on whether it's a login request or not
      if (isLogin) {
        sign = `k=${this.aes.key}&i=${this.aes.iv}&h=${this.hash}&s=${length}`;
      } else {
        sign = `h=${this.hash}&s=${length}`;
      }

      const plainSignLen = sign.length;
      // Encrypt the sign data with RSA, possibly splitting it into two parts
      if (sign.length > 53) {
        this.logger.log(`deco.ts: doEncryptedPost: sign plaintext=${plainSignLen}B (>53, split into 2 RSA blocks)`);
        const first = encryptRsa(sign.substring(0, 53), key);
        const second = encryptRsa(sign.substring(53), key);
        sign = `${first}${second}`;
      } else {
        this.logger.log(`deco.ts: doEncryptedPost: sign plaintext=${plainSignLen}B (single RSA block)`);
        sign = encryptRsa(sign, key);
      }
      this.logger.log(`deco.ts: doEncryptedPost: RSA-encrypted sign length=${sign.length}`);

      // Prepare the final POST data
      const postData = `sign=${encodeURIComponent(
        sign,
      )}&data=${encodeURIComponent(encryptedData)}`;

      const postDataBuffer = Buffer.from(postData);
      this.logger.log(`deco.ts: doEncryptedPost: total POST body=${postDataBuffer.length}B`);

      // Send the POST request with encrypted data.
      // Body is URL-encoded form data (sign=...&data=...); newer HTTPS firmware
      // is strict about Content-Type and returns HTTP 500 if it sees application/json.
      const req: ResponseData = await this.doPost(path, params, postDataBuffer, 'application/x-www-form-urlencoded');

      // Decrypt the response data
      const decoded = AES128Decrypt(req.data, this.aes);
      this.logger.log(`deco.ts: doEncryptedPost: decrypted response length=${decoded.length}B`);

      if (decoded.length === 0) {
        this.logger.log(`deco.ts: doEncryptedPost: empty decrypt for path=${path} form=${params.form} (endpoint not supported by this node)`);
        return { error_code: 0, result: {} };
      }

      const parsed = JSON.parse(decoded);
      if (parsed?.error_code !== undefined && parsed.error_code !== 0) {
        this.logger.error(`deco.ts: doEncryptedPost: response error_code=${parsed.error_code} path=${path} full=`, JSON.stringify(parsed));
      }
      return parsed;
    } catch (e: any) {
      // Some Deco firmware (especially when enforcing HTTPS) returns HTTP 4xx/5xx
      // with an AES-encrypted body containing the real error_code (e.g. -5 = wrong
      // password). Try to decrypt it so the caller gets a meaningful error instead
      // of a generic "network error".
      if (e?.httpStatus && e?.responseBody) {
        try {
          const decoded = AES128Decrypt(e.responseBody, this.aes);
          if (decoded.length > 0) {
            const parsed = JSON.parse(decoded);
            this.logger.log(
              `deco.ts: doEncryptedPost: decrypted HTTP ${e.httpStatus} body:`,
              `error_code=${parsed?.error_code}`,
            );
            return parsed; // let the caller (client.ts) interpret the error_code
          }
        } catch (decryptErr) {
          this.logger.error('deco.ts: doEncryptedPost: could not decrypt HTTP error body:', decryptErr);
        }
      }
      this.logger.error('deco.ts: doEncryptedPost: error:', e);
      throw e;
    }
  }

  // Method to send a POST request to the server
  public async doPost(
    path: string,
    params: EndpointArgs,
    body: Buffer,
    contentType: string = 'application/json',
  ): Promise<any> {
    const config = {
      method: 'POST' as const,
      url: path,
      data: body,
      headers: {
        'Accept-Encoding': 'gzip',
        'Content-Type': contentType,
      },
      params: params,
    };

    try {
      const response = await this.c.request(config);
      return response.data;
    } catch (e: any) {
      const code = e?.code ?? (e?.name === 'AbortError' ? 'ETIMEDOUT' : undefined);
      this.logger.error(`deco.ts: doPost failed for path "${path}":`, code ?? e?.message);
      throw e;
    }
  }
}
