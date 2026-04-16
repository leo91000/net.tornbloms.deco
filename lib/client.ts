import crypto, { KeyObject } from 'crypto';
import dns from 'dns/promises';
import Deco from './deco';
import { encryptRsa } from '././utils/rsa';
import { AESKey, generateAESKey } from '././utils/aes';
import { HttpClient, AppLogger } from './http';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Agent } = require('undici') as { Agent: new (opts: any) => object };
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export type { AppLogger };

// Define a constant for the username to be used for authentication
const userName = 'admin';

export interface ErrorResponse {
  errorcode: string;
  success: boolean;
}
// Interface to define the structure of the response for client list
export interface ClientListResponse {
  error_code: number;
  result: {
    client_list: Array<{
      access_host: string;
      client_mesh: boolean;
      client_type: string;
      connection_type: string;
      down_speed: number;
      enable_priority: boolean;
      interface: string;
      ip: string;
      mac: string;
      name: string;
      online: boolean;
      owner_id: string;
      remain_time: number;
      space_id: string;
      up_speed: number;
      wire_type: string;
    }>;
  };
}

export interface WLANNetworkResponse {
  error_code: number;
  result: {
    band5_1: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
    is_eg: boolean;
    band2_4: {
      backhaul: {
        channel: number;
      };
      guest: {
        password: string;
        ssid: string;
        vlan_id: number;
        enable: boolean;
        need_set_vlan: boolean;
      };
      host: {
        password: string;
        ssid: string;
        channel: number;
        enable: boolean;
        mode: string;
        channel_width: string;
        enable_hide_ssid: boolean;
      };
    };
  };
}

export interface Band {
  backhaul: {
    channel: number;
  };
  guest: {
    password: string;
    ssid: string;
    vlan_id: number;
    enable: boolean;
    need_set_vlan: boolean;
  };
  host: {
    password: string;
    ssid: string;
    channel: number;
    enable: boolean;
    mode: string;
    channel_width: string;
    enable_hide_ssid: boolean;
  };
}

// Interface to define the structure of the response for WAN
export interface WANResponse {
  error_code: number;
  result: {
    wan: {
      ip_info: {
        mac: string;
        dns1: string;
        dns2: string;
        mask: string;
        gateway: string;
        ip: string;
      };
      dial_type: string;
      info: string;
      enable_auto_dns: boolean;
    };
    lan: {
      ip_info: {
        mac: string;
        mask: string;
        ip: string;
      };
    };
  };
}

// Interface to define the structure of the response for device list
export interface DeviceListResponse {
  error_code: number;
  result: {
    device_list: Array<{
      device_ip: string;
      device_id?: string;
      device_type: string;
      nand_flash: boolean;
      owner_transfer?: boolean;
      previous: string;
      bssid_5g: string;
      bssid_2g: string;
      bssid_sta_5g: string;
      bssid_sta_2g: string;
      parent_device_id?: string;
      software_ver: string;
      role: string;
      product_level: number;
      hardware_ver: string;
      inet_status: string;
      support_plc: boolean;
      mac: string;
      set_gateway_support: boolean;
      inet_error_msg: string;
      connection_type?: string[];
      custom_nickname?: string;
      nickname: string;
      group_status: string;
      oem_id: string;
      signal_level: {
        band2_4: string;
        band5: string;
      };
      device_model: string;
      oversized_firmware: boolean;
      speed_get_support?: boolean;
      hw_id: string;
    }>;
  };
}

export interface InternetResponse {
  error_code: number;
  result: {
    ipv6: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      inet_status: string;
      dial_status: string;
    };
    ipv4: {
      connect_type: string;
      auto_detect_type: string;
      error_code: number;
      dial_status: string;
      inet_status: string;
    };
    link_status: string;
  };
}

// Interface to define the structure of the response for advanced data
export interface AdvancedResponse {
  error_code: number;
  result: {
    support_dfs: boolean;
  };
}

// Interface to define the structure of the response for performance data
export interface PerformanceResponse {
  error_code: number;
  result: {
    cpu_usage: number;
    mem_usage: number;
  };
}

// LTE interface config — data usage for the current billing period.
// Available on Deco models with cellular connectivity (e.g. X50-4G, X50-5G).
// Returned by /admin/network?form=lte_intf_cfg
export interface LteIntfCfgResponse {
  error_code: number;
  result: {
    // Current-period RX bytes (unit varies by firmware — log raw to verify)
    curStatistics?: string | number;
    // Current-period TX bytes
    totalStatistics?: string | number;
    dataLimit?: string | number;
    enableDataLimit?: string | number;
    curRxSpeed?: string | number;
    curTxSpeed?: string | number;
  };
}

// LTE link config — SIM and network-type status.
// Returned by /admin/network?form=lte_link_cfg
export interface LteLinkCfgResponse {
  error_code: number;
  result: {
    connectStatus?: string;
    networkType?: string;
    simStatus?: string;
    roamingStatus?: string;
  };
}

// Interface for the structure of login request
interface LoginRequest {
  params: {
    password: string;
  };
  operation: string;
}

// Interface for generic request parameters
interface RequestParams {
  operation?: string;
  params?: { [key: string]: any };
}

// Class to handle endpoint arguments and query parameters
class EndpointArgs {
  form: string;

  constructor(form: string) {
    this.form = form;
  }

  // Method to create URL search parameters
  queryParams(): URLSearchParams {
    const q = new URLSearchParams();
    q.append('form', this.form);
    return q;
  }
}

const consoleLogger: AppLogger = { log: console.log, error: console.error };

// Main Client class to interact with the API
export default class DecoAPIWraper {
  public c: HttpClient;
  public aes: AESKey | undefined;
  public rsa: KeyObject | null = null;
  public hash: string = '';
  public stok: string = '';
  public sequence: number = 0;
  public host: string;
  public decoInstance: Deco | undefined;
  private logger: AppLogger;

  // Constructor to initialize the client with the target host
  constructor(target: string, logger: AppLogger = consoleLogger) {
    const normalizedTarget = target.trim().replace(/^https?:\/\//i, '').split('/')[0];
    const baseUrl = `http://${normalizedTarget}/cgi-bin/luci/`;
    this.host = normalizedTarget;
    this.logger = logger;
    this.c = new HttpClient(baseUrl, 10000, logger);
  }

  // Method to ping the host — probes the actual API base path so routers that
  // don't serve on the root still respond. Accepts any HTTP status as "alive";
  // only network-level failures (ECONNREFUSED, ETIMEDOUT, …) return false.
  // Also tries HTTPS (with cert verification disabled) if HTTP fails, since
  // newer Deco firmware (BE-series, firmware 1.2.0+) enforces HTTPS-only.
  private async pingHost(host: string): Promise<boolean> {
    for (const scheme of ['http', 'https'] as const) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          await fetch(`${scheme}://${host}/cgi-bin/luci/`, {
            signal: controller.signal,
            ...(scheme === 'https' ? { dispatcher: insecureAgent } : {}),
          } as RequestInit);
        } finally {
          clearTimeout(timer);
        }
        return true;
      } catch (error: any) {
        this.logger.log(`client.ts: pingHost: ${scheme}://${host} not reachable: ${error?.code ?? error?.message}`);
      }
    }
    return false;
  }

  // Private method to ensure the Deco instance is initialized or updated
  private ensureDecoInstance() {
    if (!this.decoInstance) {
      this.decoInstance = new Deco(
        this.aes!,
        this.hash,
        this.rsa!,
        this.sequence,
        this.c,
        this.logger,
      );
    } else {
      this.decoInstance.updateContext(
        this.aes!,
        this.hash,
        this.rsa!,
        this.sequence,
      );
    }
  }

  // Public method to authenticate the client with the given password.
  // Returns true on success.
  // Throws AuthNetworkError when the router cannot be reached.
  // Throws AuthCredentialsError when the password is wrong.
  // Throws Error for other failures.
  public async authenticate(password: string, _retried = false): Promise<boolean> {
    // Resolve hostname to IPv4 before making any HTTP requests.
    // Homey Pro (2023) has IPv6 enabled; tplinkdeco.net resolves to a
    // link-local IPv6 address which causes undici to crash on redirects
    // (detached ArrayBuffer bug). Always use the IPv4 address.
    try {
      const { address } = await dns.lookup(this.host, { family: 4 });
      if (address !== this.host) {
        this.logger.log(`client.ts: authenticate: resolved ${this.host} → ${address} (IPv4 forced)`);
        this.host = address;
        this.c = new HttpClient(`http://${address}/cgi-bin/luci/`, 10000, this.logger);
      }
    } catch (e: any) {
      this.logger.log(`client.ts: authenticate: IPv4 DNS lookup failed for ${this.host} — using hostname as-is: ${e.message}`);
    }

    this.logger.log(`client.ts: authenticate: checking host reachability for ${this.host}`);
    const hostIsAlive = await this.pingHost(this.host);
    if (!hostIsAlive) {
      this.logger.log(`client.ts: authenticate: ping failed for ${this.host} — proceeding with auth anyway (router may block HTTP GET)`);
    } else {
      this.logger.log(`client.ts: authenticate: host ${this.host} is reachable`);
    }

    // Generate AES key for encryption
    this.aes = generateAESKey();
    this.logger.log(
      'client.ts: authenticate: AES generated',
      `keyLen=${String(this.aes.key).length} ivLen=${String(this.aes.iv).length}`,
      '(both must be 16)',
    );

    // Generate MD5 hash using the username and password
    this.hash = crypto
      .createHash('md5')
      .update(`${userName}${password}`)
      .digest('hex');
    this.logger.log('client.ts: authenticate: MD5 hash length:', this.hash.length, '(must be 32)');

    this.ensureDecoInstance();

    // --- password key (network phase) ---
    this.logger.log('client.ts: authenticate: retrieving password key');
    let passwordKey;
    try {
      passwordKey = await this.decoInstance!.getPasswordKey();
    } catch (e: any) {
      this.logger.error('client.ts: authenticate: network error fetching password key:', e);
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { cause: e });
    }
    if (!passwordKey) {
      this.logger.error('client.ts: authenticate: failed to retrieve password key — check device IP and that the Deco web interface is reachable');
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), {});
    }
    this.logger.log('client.ts: authenticate: password key retrieved ok');

    // Encrypt the password using the retrieved password key
    const encryptedPassword = encryptRsa(password, passwordKey);
    if (!encryptedPassword) {
      this.logger.error('client.ts: authenticate: RSA encryption of password returned empty string');
      throw new Error('RSA encryption of password failed.');
    }
    this.logger.log('client.ts: authenticate: encrypted password length:', encryptedPassword.length);

    // --- session key (network phase) ---
    this.logger.log('client.ts: authenticate: retrieving session key');
    let sessionKey, sequence;
    try {
      ({ key: sessionKey, seq: sequence } = await this.decoInstance!.getSessionKey());
    } catch (e: any) {
      this.logger.error('client.ts: authenticate: network error fetching session key:', e);
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { cause: e });
    }
    if (!sessionKey) {
      this.logger.error('client.ts: authenticate: failed to retrieve session key');
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), {});
    }
    this.logger.log('client.ts: authenticate: session key ok, seq:', sequence, '(seq must be > 0)');

    this.rsa = sessionKey;
    this.sequence = sequence;

    // --- login POST (credentials phase) ---
    const loginReq: LoginRequest = {
      params: { password: encryptedPassword },
      operation: 'login',
    };
    const args = new EndpointArgs('login');

    this.logger.log('client.ts: authenticate: sending encrypted login request');
    let result;
    try {
      result = await this.decoInstance!.doEncryptedPost(
        ';stok=/login',
        args,
        Buffer.from(JSON.stringify(loginReq)),
        true,
        sessionKey,
        this.sequence,
      );
    } catch (e: any) {
      if (e?.httpStatus === 403) {
        this.logger.error('client.ts: authenticate: login rejected with 403 — router may limit concurrent sessions. Will retry on next poll.');
        throw Object.assign(new Error('RETRY: Router rejected login (session limit). Will retry automatically.'), { cause: e });
      }
      if (e?.httpStatus === 500) {
        // HTTP 500 on the login POST usually means wrong password.
        // doEncryptedPost already attempted decryption; if it still threw here
        // the body was not decryptable. Surface as a credentials error.
        this.logger.error('client.ts: authenticate: HTTP 500 on login POST — likely wrong password');
        throw new Error('CREDENTIALS: Wrong password. Use the password from the TP-Link Deco app.');
      }
      this.logger.error('client.ts: authenticate: network error during login POST:', e);
      throw Object.assign(new Error(`NETWORK: Cannot reach router at ${this.host}. Check the IP and that Homey is on the same network.`), { cause: e });
    }

    this.logger.log('client.ts: authenticate: login response error_code:', result?.error_code, 'has stok:', !!result?.result?.stok);

    // "no such callback" means the firmware rejected the Content-Type we used.
    // This happens on newer HTTPS firmware that needs application/json even
    // over HTTPS (opposite of older HTTPS firmware that needed form-urlencoded).
    // Flip the flag and retry the full auth sequence once with the other encoding.
    if (result?.error_code === 1 && result?.msg === 'no such callback' && !_retried) {
      this.logger.log(
        'client.ts: authenticate: "no such callback" — firmware rejected current Content-Type;',
        `switching to ${this.c.forceJsonContentType ? 'form-urlencoded' : 'JSON'} and retrying`,
      );
      this.c.forceJsonContentType = !this.c.forceJsonContentType;
      return this.authenticate(password, true);
    }

    // Only update this.stok when we have a confirmed valid token.
    // Assigning before the check would clobber the previous valid stok with
    // undefined on a failed re-auth, causing concurrent devices on the shared
    // client to use stok=undefined in their request paths.
    const newStok = result?.result?.stok;
    if (!newStok) {
      this.logger.error('client.ts: authenticate: login response missing stok — likely wrong password. Full response:', JSON.stringify(result));
      throw new Error('CREDENTIALS: Wrong password. Use the password from the TP-Link Deco app.');
    }
    this.stok = newStok;

    this.logger.log('client.ts: authenticate: login successful');
    return true;
  }

  // Public method to retrieve Wan data
  async getAdvancedSettings(): Promise<AdvancedResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting advanced data...');
    const args = new EndpointArgs('power');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      // this.logger.log('client.ts: ' + 'Advanced request failed:', errorResponse);
      return errorResponse;
    }
    return response;
  }
  // Public method to retrieve Wan data
  async getWLAN(): Promise<WLANNetworkResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wlan');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const response = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/wireless`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      response &&
      typeof response === 'object' &&
      'errorcode' in response &&
      'success' in response
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: response.errorcode,
        success: response.success,
      };
      // this.logger.log('client.ts: ' + 'WLAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    const decodeBase64 = (encoded: string): string => {
      try {
        return Buffer.from(encoded, 'base64').toString('utf-8');
      } catch (e) {
        // this.logger.log('client.ts: ' + `Failed to decode base64 string: ${encoded}`,e,);
        return encoded; // Returnera den ursprungliga strängen om dekodning misslyckas
      }
    };

    // Dekodera band5_1
    response.result.band5_1.guest.ssid = decodeBase64(
      response.result.band5_1.guest.ssid,
    );
    response.result.band5_1.guest.password = decodeBase64(
      response.result.band5_1.guest.password,
    );
    response.result.band5_1.host.ssid = decodeBase64(
      response.result.band5_1.host.ssid,
    );
    response.result.band5_1.host.password = decodeBase64(
      response.result.band5_1.host.password,
    );

    // Dekodera band2_4
    response.result.band2_4.guest.ssid = decodeBase64(
      response.result.band2_4.guest.ssid,
    );
    response.result.band2_4.guest.password = decodeBase64(
      response.result.band2_4.guest.password,
    );
    response.result.band2_4.host.ssid = decodeBase64(
      response.result.band2_4.host.ssid,
    );
    response.result.band2_4.host.password = decodeBase64(
      response.result.band2_4.host.password,
    );

    // this.logger.log( 'client.ts: ' + 'Processed WLAN network response: ',JSON.stringify(response),);

    return response;
  }

  // Public method to retrieve LAN data
  async getLAN(): Promise<any> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('lan_ip');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'LAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve Wan data
  async getWAN(): Promise<WANResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('wan_ipv4');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'WAN request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve Internt data
  async getInternet(): Promise<InternetResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('internet');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Internet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getModel(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('model');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Model request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve enviromet data
  async getEnviroment(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('envar');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/system`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Enviromet request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }
  // Public method to retrieve status data
  async getStatus(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting status data...');
    const args = new EndpointArgs('all');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/status`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Status request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve firmware data
  async firmware(): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting firmware data...');
    const args = new EndpointArgs('upgrade');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/firmware`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as any;

    // Chech if error
    if (
      result &&
      typeof result === 'object' &&
      'errorcode' in result &&
      'success' in result
    ) {
      const errorResponse: ErrorResponse = {
        errorcode: result.errorcode,
        success: result.success,
      };
      // this.logger.log('client.ts: ' + 'Firmware request failed:', errorResponse);
      return errorResponse;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve performance data
  async performance(): Promise<PerformanceResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting performance data...');
    const args = new EndpointArgs('performance');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/network`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as PerformanceResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'Performance request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of devices
  async deviceList(): Promise<DeviceListResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting device list...');
    const args = new EndpointArgs('device_list');
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(JSON.stringify({ operation: 'read' })),
      false,
    )) as DeviceListResponse;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'device list request failed:', result);
      return result;
    }

    // If no error do respond with result
    return result;
  }

  // Public method to retrieve the list of clients
  async clientList(): Promise<ClientListResponse | ErrorResponse> {
    // this.logger.log('client.ts: ' + 'Requesting client list...');
    const args = new EndpointArgs('client_list');
    const request: RequestParams = {
      operation: 'read',
      params: { device_mac: 'default' },
    };

    const jsonRequest = JSON.stringify(request);
    // this.logger.log('client.ts: ' + `Client list request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    let result: ClientListResponse;
    try {
      result = (await decoInstance.doEncryptedPost(
        `;stok=${this.stok}/admin/client`,
        args,
        Buffer.from(jsonRequest),
        false,
      )) as ClientListResponse;
    } catch (error) {
      // this.logger.log('client.ts: ' + 'client list request failed:', error);
      result = { error_code: 1, result: { client_list: [] } }; // Return default values in case of error
    }

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'client list request failed:', result);
      return result;
    }

    // this.logger.log('client.ts: ' + 'Processing client list response...');
    try {
      // Uppdatera client_list med dekodade namn
      result.result.client_list.forEach((client) => {
        try {
          // Försök att dekoda namnet
          const decodedName = Buffer.from(client.name, 'base64').toString(
            'utf-8',
          );
          // this.logger.log('client.ts: ' + `Decoded client name: ${decodedName}`);

          // Sätt det dekodade namnet till klienten
          client.name = decodedName;
        } catch (e) {
          // Logga fel om dekodningen misslyckas
          // this.logger.log('client.ts: ' + `Failed to decode client name: ${client.name}`,e,);
        }
      });
      // this.logger.log('client.ts: ' + 'Processed client list response: ',JSON.stringify(result),);
      // Returnera det uppdaterade resultatet
      return result;
    } catch (e) {
      // this.logger.log('client.ts: ' + 'client list request failed:', e);
      return { error_code: 1, result: { client_list: [] } }; // Return default values in case of error
    }
  }

  // Public method to reboot devices based on their MAC addresses
  async reboot(...macAddrs: string[]): Promise<{ [key: string]: any }> {
    // this.logger.log('client.ts: ' +`Requesting reboot for MAC addresses: ${macAddrs.join(', ')}`,);
    const macList = macAddrs.map((mac) => ({ mac: mac.toUpperCase() }));
    const request: RequestParams = {
      operation: 'reboot',
      params: {
        mac_list: macList,
      },
    };

    const jsonRequest = JSON.stringify(request);
    // this.logger.log('client.ts: ' + `Reboot request JSON: ${jsonRequest}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );

    const args = new EndpointArgs('system');
    return (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}/admin/device`,
      args,
      Buffer.from(jsonRequest),
      false,
    )) as { [key: string]: any };
  }

  // Public method to send a custom request to a specific endpoint
  async custom(
    path: string,
    params: EndpointArgs,
    body: Buffer,
  ): Promise<any | ErrorResponse> {
    // this.logger.log('client.ts: ' + `Sending custom request to path: ${path}`);
    const decoInstance = new Deco(
      this.aes!,
      this.hash,
      this.rsa!,
      this.sequence,
      this.c,
      this.logger,
    );
    const result = (await decoInstance.doEncryptedPost(
      `;stok=${this.stok}${path}`,
      params,
      body,
      false,
    )) as any;

    // Check if result is an error
    if (isErrorResponse(result)) {
      // this.logger.log('client.ts: ' + 'client list request failed:', result);
      return result;
    }
    return result;
  }
}

// Function to extract and print details from an RSA KeyObject
function printKey(keyObject: KeyObject): string {
  // Export the key as a DER-encoded buffer
  const keyBuffer = keyObject.export({ type: 'pkcs1', format: 'der' });

  // The modulus for RSA keys is stored in the first part of the key structure
  // Parse the modulus by skipping the header bytes in the DER-encoded key
  const modulusOffset = 29; // Skip the header bytes (this offset can vary slightly)
  const modulusLength = keyBuffer.readUInt16BE(modulusOffset - 2); // Read the modulus length

  // Extract the modulus
  const modulus = keyBuffer.slice(modulusOffset, modulusOffset + modulusLength);

  return (
    'Modulus (hex): ' +
    modulus.toString('hex') +
    'Exponent: ' +
    keyObject.asymmetricKeyDetails?.publicExponent
  );
}

// Type guard för att kontrollera om ett objekt är av typen ErrorResponse
function isErrorResponse(result: any): result is ErrorResponse {
  return (
    typeof result === 'object' &&
    result !== null &&
    'errorcode' in result &&
    'success' in result &&
    typeof result.errorcode === 'string' &&
    typeof result.success === 'boolean'
  );
}
