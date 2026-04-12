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
 */
export class HttpClient {
  private readonly jar: CookieJar;
  private readonly logger: AppLogger;
  readonly baseURL: string;
  private readonly timeout: number;

  constructor(baseURL: string, timeout = 10000, logger: AppLogger = consoleLogger) {
    this.jar = new CookieJar();
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.logger = logger;
  }

  async request(config: PostConfig): Promise<{ data: any }> {
    const paramStr = `?form=${encodeURIComponent(config.params.form)}`;
    const urlStr = `${this.baseURL}${config.url}${paramStr}`;

    const cookieStr = await this.jar.getCookieString(this.baseURL);
    this.logger.log(
      `http.ts: POST ${config.url}?form=${config.params.form}`,
      `body=${config.data.length}B`,
      cookieStr ? `cookies=yes(${cookieStr.split(';').length})` : 'cookies=none',
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let responseStatus: number | undefined;
    let rawText: string | undefined;

    try {
      const response = await fetch(urlStr, {
        method: 'POST',
        headers: {
          ...config.headers,
          ...(cookieStr ? { Cookie: cookieStr } : {}),
        },
        body: config.data,
        signal: controller.signal,
      });

      responseStatus = response.status;

      // Persist any Set-Cookie headers the router sends back.
      // getSetCookie() returns an array (Node.js 18+); fall back gracefully.
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

      rawText = await response.text();

      if (!response.ok) {
        this.logger.error(
          `http.ts: HTTP ${responseStatus} for "${config.url}?form=${config.params.form}"`,
          `body=${rawText.slice(0, 200)}`,
        );
      } else {
        this.logger.log(`http.ts: HTTP ${responseStatus} for "${config.url}?form=${config.params.form}" body=${rawText.length}B`);
      }

      try {
        const data = JSON.parse(rawText);
        return { data };
      } catch (parseErr) {
        this.logger.error(
          `http.ts: JSON parse failed for "${config.url}?form=${config.params.form}" HTTP ${responseStatus}`,
          `raw=${rawText.slice(0, 300)}`,
        );
        throw parseErr;
      }
    } catch (e: any) {
      if (responseStatus === undefined) {
        // Network-level failure (no response received)
        const label = e?.name === 'AbortError' ? 'ETIMEDOUT' : (e?.code ?? e?.message);
        this.logger.error(`http.ts: network error for "${config.url}?form=${config.params.form}": ${label}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
