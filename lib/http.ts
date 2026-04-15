import { CookieJar } from 'tough-cookie';

interface PostConfig {
  method: 'POST';
  url: string;
  data: Buffer;
  headers: Record<string, string>;
  params: { form: string };
}

export interface AppLogger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

const consoleLogger: AppLogger = { log: console.log, error: console.error };

/**
 * Minimal HTTP client using the Node.js native fetch API with tough-cookie
 * for session cookie management. Replaces axios + axios-cookiejar-support.
 *
 * Handles HTTP→HTTPS redirects automatically (newer Deco firmware enforces
 * HTTPS on the admin interface). Uses a custom undici Agent that skips
 * self-signed certificate validation for local router access.
 */
export class HttpClient {
  private readonly jar: CookieJar;
  private readonly logger: AppLogger;
  // Not readonly — may be upgraded from http:// to https:// on first redirect
  baseURL: string;
  private readonly timeout: number;
  /**
   * When true, doEncryptedPost will always use application/json for the
   * encrypted POST body even over HTTPS. Set automatically when the first
   * auth attempt detects a "no such callback" error, which indicates newer
   * HTTPS firmware that needs JSON rather than form-urlencoded.
   */
  public forceJsonContentType: boolean = false;

  constructor(baseURL: string, timeout = 10000, logger: AppLogger = consoleLogger) {
    this.jar = new CookieJar();
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.logger = logger;
  }

  async request(config: PostConfig): Promise<{ data: any }> {
    const paramStr = `?form=${encodeURIComponent(config.params.form)}`;

    const cookieStr = await this.jar.getCookieString(this.baseURL);
    this.logger.log(
      `http.ts: POST ${config.url}?form=${config.params.form}`,
      `body=${config.data.length}B`,
      cookieStr ? `cookies=yes(${cookieStr.split(';').length})` : 'cookies=none',
    );

    // Up to 2 attempts: first over http, then https if the router redirects.
    // We use redirect:'manual' to prevent undici's httpRedirectFetch from
    // crashing with "detached ArrayBuffer" when re-reading a POST body.
    for (let attempt = 0; attempt < 2; attempt++) {
      const urlStr = `${this.baseURL}${config.url}${paramStr}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      let response: Response;
      try {
        response = await fetch(urlStr, {
          method: 'POST',
          headers: {
            ...config.headers,
            ...(cookieStr ? { Cookie: cookieStr } : {}),
          },
          // Always use a fresh copy so retries after a redirect still have the body.
          body: Buffer.from(config.data),
          signal: controller.signal,
          redirect: 'manual',
        } as RequestInit);
      } catch (e: any) {
        clearTimeout(timer);
        const label = e?.name === 'AbortError' ? 'ETIMEDOUT' : (e?.code ?? e?.message);
        this.logger.error(`http.ts: network error for "${config.url}?form=${config.params.form}": ${label}`);
        throw e;
      }

      clearTimeout(timer);

      // Handle HTTP→HTTPS (or other) redirects manually.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        this.logger.log(`http.ts: redirect ${response.status} → ${location} (upgrading baseURL)`);
        if (location.startsWith('https://')) {
          // Upgrade baseURL so all subsequent requests in this session use HTTPS.
          this.baseURL = this.baseURL.replace(/^http:\/\//, 'https://');
        } else if (location) {
          // Unexpected redirect target — log and abort rather than loop.
          throw Object.assign(new Error(`Unexpected redirect to ${location}`), { httpStatus: response.status });
        }
        // Retry the request with the updated baseURL.
        continue;
      }

      // --- normal response handling ---
      const rawHeaders = response.headers as any;
      const setCookies: string[] =
        typeof rawHeaders.getSetCookie === 'function'
          ? rawHeaders.getSetCookie()
          : [];
      if (setCookies.length > 0) {
        this.logger.log(`http.ts: received ${setCookies.length} Set-Cookie header(s)`);
        for (const cookie of setCookies) {
          await this.jar.setCookie(cookie, this.baseURL).catch(() => {});
        }
      }

      const rawText = await response.text();

      if (!response.ok) {
        this.logger.error(
          `http.ts: HTTP ${response.status} for "${config.url}?form=${config.params.form}"`,
          `body=${rawText.slice(0, 200)}`,
        );
        const err: any = new Error(`HTTP ${response.status}`);
        err.httpStatus = response.status;
        // Attach the raw body so callers that handle encrypted responses
        // (e.g. doEncryptedPost) can attempt decryption to get the real error code.
        err.responseBody = rawText;
        throw err;
      }

      this.logger.log(`http.ts: HTTP ${response.status} for "${config.url}?form=${config.params.form}" body=${rawText.length}B`);

      try {
        return { data: JSON.parse(rawText) };
      } catch (parseErr) {
        this.logger.error(
          `http.ts: JSON parse failed for "${config.url}?form=${config.params.form}" HTTP ${response.status}`,
          `raw=${rawText.slice(0, 300)}`,
        );
        throw parseErr;
      }
    }

    // Should never reach here (loop always returns or throws).
    throw new Error('http.ts: request loop exhausted without response');
  }
}
