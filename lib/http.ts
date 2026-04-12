import { CookieJar } from 'tough-cookie';

interface PostConfig {
  method: 'POST';
  url: string;
  data: Buffer;
  headers: Record<string, string>;
  params: { form: string };
}

/**
 * Minimal HTTP client using the Node.js native fetch API with tough-cookie
 * for session cookie management. Replaces axios + axios-cookiejar-support.
 */
export class HttpClient {
  private readonly jar: CookieJar;
  readonly baseURL: string;
  private readonly timeout: number;

  constructor(baseURL: string, timeout = 10000) {
    this.jar = new CookieJar();
    this.baseURL = baseURL;
    this.timeout = timeout;
  }

  async request(config: PostConfig): Promise<{ data: any }> {
    const paramStr = `?form=${encodeURIComponent(config.params.form)}`;
    const urlStr = `${this.baseURL}${config.url}${paramStr}`;

    const cookieStr = await this.jar.getCookieString(this.baseURL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

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

      // Persist any Set-Cookie headers the router sends back.
      // getSetCookie() returns an array (Node.js 18+); fall back gracefully.
      const rawHeaders = response.headers as any;
      const setCookies: string[] =
        typeof rawHeaders.getSetCookie === 'function'
          ? rawHeaders.getSetCookie()
          : [];
      for (const cookie of setCookies) {
        await this.jar.setCookie(cookie, this.baseURL).catch(() => {});
      }

      const data = await response.json();
      return { data };
    } catch (e: any) {
      const label =
        e?.name === 'AbortError' ? 'ETIMEDOUT' : (e?.code ?? e?.message);
      console.error(
        `http.ts: POST failed for "${config.url}": ${label}`,
      );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
