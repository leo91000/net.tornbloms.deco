'use strict';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';
import { Driver } from 'homey';
import decoapiwrapper, { AppLogger, DeviceListResponse } from '../../lib/client';

class TplinkDecoDriver extends Driver {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  private api: decoapiwrapper | any;

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // One shared DecoAPIWrapper per master hostname so all device instances
  // use a single session (the Deco only allows one active session at a time).
  private sharedApis = new Map<string, decoapiwrapper>();
  // Serializes concurrent authenticate() calls for the same hostname so
  // multiple devices detecting "session expired" at the same time don't race.
  private authQueue = new Map<string, Promise<boolean>>();
  // Tracks hostnames for which network diagnostics have already been logged
  // this session, so re-auth cycles don't flood the log.
  private diagRan = new Set<string>();

  /**
   * Returns (or lazily creates) the shared API instance for a given hostname.
   * Devices should always call this instead of `new decoapiwrapper(...)`.
   */
  public getOrCreateSharedApi(hostname: string, logger: AppLogger): decoapiwrapper {
    if (!this.sharedApis.has(hostname)) {
      this.sharedApis.set(hostname, new decoapiwrapper(hostname, logger));
    }
    return this.sharedApis.get(hostname)!;
  }

  /**
   * Authenticates the shared API for a hostname.
   * If an auth is already in progress (from another device instance),
   * returns the same promise so only ONE login hits the router.
   */
  public async sharedAuthenticate(hostname: string, password: string, logger: AppLogger): Promise<boolean> {
    const inFlight = this.authQueue.get(hostname);
    if (inFlight) {
      this.log(`sharedAuthenticate: auth already in progress for ${hostname}, waiting`);
      return inFlight;
    }
    if (!this.diagRan.has(hostname)) {
      this.diagRan.add(hostname);
      await this.logNetworkDiagnostics(hostname);
    }
    const api = this.getOrCreateSharedApi(hostname, logger);
    const promise = api.authenticate(password).finally(() => this.authQueue.delete(hostname));
    this.authQueue.set(hostname, promise);
    return promise;
  }

  /**
   * Logs network diagnostics for a given hostname/IP.
   * Call this before any authentication attempt so the data always
   * appears in diagnostics reports, even when the connection fails.
   */
  public async logNetworkDiagnostics(hostname: string): Promise<void> {
    // Homey's own local IPv4 interfaces (address + mask)
    const ifaces = os.networkInterfaces();
    const localIfaces = (Object.values(ifaces) as (os.NetworkInterfaceInfo[] | undefined)[])
      .flat()
      .filter((i): i is os.NetworkInterfaceInfo => !!i && !i.internal && i.family === 'IPv4');

    if (localIfaces.length === 0) {
      this.log(`[diag] Homey local IPs: none found`);
    } else {
      for (const iface of localIfaces) {
        this.log(`[diag] Homey local IP: ${iface.address}  mask: ${iface.netmask}  cidr: ${iface.cidr ?? 'n/a'}`);
      }
    }
    this.log(`[diag] Target hostname: ${hostname}`);

    // DNS resolution — show both IPv4 and IPv6 so address-family issues are obvious
    let resolvedIP: string | null = null;
    try {
      const { address } = await dns.lookup(hostname, { family: 4 });
      resolvedIP = address;
      this.log(`[diag] DNS IPv4: ${hostname} → ${address}`);
    } catch (e: any) {
      this.log(`[diag] DNS IPv4: ${hostname} failed — ${e.message}`);
    }
    try {
      const { address } = await dns.lookup(hostname, { family: 6 });
      this.log(`[diag] DNS IPv6: ${hostname} → ${address}${resolvedIP ? ' (will use IPv4 above)' : ' (no IPv4 — this is the problem!)'}`);
    } catch {
      // no IPv6 record — fine
    }
    if (!resolvedIP) {
      this.log(`[diag] DNS: ${hostname} has no IPv4 address — TCP check skipped`);
      return;
    }

    // Subnet match using each interface's actual netmask (not a hardcoded /24).
    // Converts IP and mask to 32-bit integers and compares network addresses,
    // so a /22 mask (255.255.252.0) spanning e.g. 192.168.68–71.x is handled correctly.
    const ipToInt = (ip: string) =>
      ip.split('.').reduce((acc, o) => ((acc << 8) | parseInt(o, 10)) >>> 0, 0);

    const matched = localIfaces.find((iface) => {
      const m = ipToInt(iface.netmask);
      return (ipToInt(iface.address) & m) === (ipToInt(resolvedIP!) & m);
    });

    if (matched) {
      this.log(`[diag] Subnet: OK — Homey (${matched.address}/${matched.netmask}) and router (${resolvedIP}) are on the same network`);
    } else {
      const homeyList = localIfaces.map((i) => `${i.address}/${i.netmask}`).join(', ');
      this.log(`[diag] Subnet: MISMATCH — Homey [${homeyList}] cannot reach router ${resolvedIP}. Check VLANs / guest network isolation.`);
    }

    // TCP port 80 reachability
    const tcpOk = await this.checkTcpPort(resolvedIP, 80);
    this.log(`[diag] TCP port 80 → ${resolvedIP}: ${tcpOk ? 'reachable' : 'UNREACHABLE'}`);

    // Also try port 443 in case the Deco uses HTTPS
    const tcpOk443 = await this.checkTcpPort(resolvedIP, 443);
    this.log(`[diag] TCP port 443 → ${resolvedIP}: ${tcpOk443 ? 'reachable' : 'UNREACHABLE'}`);
  }

  private checkTcpPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
  }

  private makeLogger(): AppLogger {
    return {
      log: (...args: any[]) => this.log(...args),
      error: (...args: any[]) => this.error(...args),
    };
  }

  /**
   * Called when the driver is initialized.
   * Checks if API settings are available; if not, waits for user input.
   */
  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');

    // Register condition: client is online
    // Registered once here so multiple device instances don't overwrite each other.
    // Uses the persistent trackedClients store so the condition works even for clients
    // that are currently offline (returns false) but have been seen in the last 30 days.
    const clientIsOnline = this.homey.flow.getConditionCard('client_is_online');
    clientIsOnline.registerRunListener(async (args) => {
      const device = args.device as any;
      const tracked = device?.trackedClients ?? {};
      return tracked[args.client.mac]?.online === true;
    });
    clientIsOnline.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => {
        return this.buildClientAutocomplete(args.device, query);
      },
    );

    // Register autocomplete for client_state_changed trigger
    // Registered once here so multiple device instances don't overwrite each other.
    const clientStateFlow = this.homey.flow.getDeviceTriggerCard('client_state_changed');
    clientStateFlow.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => {
        return this.buildClientAutocomplete(args.device, query);
      },
    );
  }

  /**
   * Builds an autocomplete result list from a device's tracked client history.
   * Shows all clients seen in the last 30 days (online and offline).
   * Online clients are shown first; offline clients show their last-seen date.
   */
  private buildClientAutocomplete(device: any, query: string) {
    const tracked: Record<string, any> = device?.trackedClients ?? {};
    const search = query.toLowerCase();

    return Object.values(tracked)
      .filter(
        (c) =>
          c.mac.toLowerCase().includes(search) ||
          c.name.toLowerCase().includes(search) ||
          (c.ip ?? '').toLowerCase().includes(search),
      )
      .sort((a, b) => {
        // Online clients first, then by lastSeen descending
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      })
      .map((c) => ({
        name: c.name || c.mac,
        mac: c.mac,
        description: c.online
          ? `${c.mac} — online`
          : `${c.mac} — last seen ${new Date(c.lastSeen).toLocaleDateString()}`,
      }));
  }

  /**
   * Handles the pairing process for adding a new TP-Link Deco device.
   * @param session - The pairing session object provided by Homey.
   */
  async onPair(session: any): Promise<void> {
    this.log('Starting pairing process');

    let hostname = '';
    let password = '';

    // Received when a view has changed
    session.setHandler('showView', async (viewId: string) => {
      console.log('View: ' + viewId);
    });

    session.setHandler(
      'login',
      async (data: { username: string; password: string }) => {
        this.log('pair: login');
        hostname = this.normalizeHostname(data.username);
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: [redacted]');
        this.log('creating client');
        await this.logNetworkDiagnostics(hostname);
        try {
          this.api = new decoapiwrapper(hostname, this.makeLogger());
          await this.api.authenticate(password);
          this.log('Successfully connected to TP-Link Deco');
          return true;
        } catch (error: any) {
          const msg: string = error?.message ?? '';
          if (msg.startsWith('NETWORK:')) {
            this.error('pair: network error:', msg);
            throw new Error(msg.replace('NETWORK: ', ''));
          }
          if (msg.startsWith('CREDENTIALS:')) {
            this.error('pair: credentials error:', msg);
            throw new Error(msg.replace('CREDENTIALS: ', ''));
          }
          this.error('pair: unexpected error:', error);
          throw new Error('Connection failed. Check the IP address and password.');
        }
      },
    );

    session.setHandler('list_devices', async () => {
      this.log('pair: list_devices');
      if (!this.api) {
        this.error('No API instance available');
        return [];
      }
      try {
        const deviceList = await this.safeApiCall(
          () =>
            this.api.custom(
              '/admin/device',
              { form: 'device_list' },
              this.readBody,
            ),
          {
            error_code: 1,
            result: {
              device_list: [
                {
                  bssid_2g: '',
                  bssid_5g: '',
                  bssid_sta_2g: '',
                  bssid_sta_5g: '',
                  device_ip: '',
                  device_model: '',
                  device_type: '',
                  group_status: '',
                  hardware_ver: '',
                  hw_id: '',
                  inet_error_msg: '',
                  inet_status: '',
                  mac: '',
                  nand_flash: true,
                  nickname: '',
                  oem_id: '',
                  oversized_firmware: false,
                  product_level: 0,
                  role: '',
                  set_gateway_support: true,
                  signal_level: {
                    band2_4: '',
                    band5: '',
                  },
                  software_ver: '',
                  support_plc: false,
                },
              ],
            },
          },
          'Device Data',
        );
        //const deviceList = (await this.api.deviceList()) as DeviceListResponse;
        if (
          deviceList.error_code === 0 &&
          deviceList.result.device_list.length > 0
        ) {
          // Use the master node's actual IP as the API endpoint for all devices.
          // This avoids relying on DNS (tplinkdeco.net) which can be unreliable,
          // and ensures we always connect through the master regardless of which
          // node the user typed.
          const masterDevice = deviceList.result.device_list.find(
            (d) => d.role?.toLowerCase() === 'master',
          );
          const apiHostname = masterDevice?.device_ip || hostname;
          this.log('pair: using API hostname:', apiHostname);

          const devices = deviceList.result.device_list.map((device) => ({
            name:
              device.device_model +
              ' - ' +
              this.cleanString(this.decodeBase64(device.nickname)),
            data: {
              id: device.mac,
            },
            settings: {
              name:
                device.device_model +
                ' - ' +
                this.cleanString(this.decodeBase64(device.nickname)),
              mac: device.mac,
              hostname: apiHostname,
              password: password,
              model: device.device_model,
              ip: device.device_ip,
              role: device.role,
              hardware_ver: device.hardware_ver,
              software_ver: device.software_ver,
              hw_id: device.hw_id,
              timeoutSeconds: 30,
            },
          }));
          this.log(devices);
          if (this.debugEnabled) {
            this.homey.app.log(
              `driver.ts:onInit() driver: `,
              JSON.stringify(devices, null, 2),
            );
          }
          return devices;
        } else {
          this.error('Failed to retrieve device information');
        }
      } catch (error) {
        this.error('Failed to retrieve device information', error);
      }
    });
  }
  async onRepair(session: any): Promise<void> {
    this.log('Repair process initiated');
    let hostname = '';
    let password = '';

    // Kontrollera att session är korrekt
    if (!session) {
      this.error('No session provided for repair');
      return;
    }

    this.log('Setting up session handler for repair');
    // Logga session för att verifiera dess innehåll
    this.log('Session data before setHandler:', JSON.stringify(session));

    session.setHandler(
      'repair',
      async (data: { username: string; password: string }) => {
        this.log('pair: repairing');
        hostname = this.normalizeHostname(data.username);
        this.log('hostname: ', hostname);
        password = data.password;
        this.log('password: [redacted]');
        this.log('repairing client');
        try {
          const api = new decoapiwrapper(hostname, this.makeLogger());
          await api.authenticate(password);
          this.log('Successfully connected to TP-Link Deco');
          return { success: true };
        } catch (error: any) {
          const msg: string = error?.message ?? '';
          this.error('pair: repair error:', msg);
          if (msg.startsWith('NETWORK:') || msg.startsWith('CREDENTIALS:')) {
            return { success: false, error: msg.replace(/^(NETWORK|CREDENTIALS): /, '') };
          }
          return { success: false, error: 'Connection failed. Check the IP address and password.' };
        }
      },
    );
  }

  // If no error do respond with result
  private decodeBase64(encoded: string | undefined): string {
    if (!encoded) {
      this.error('driver.ts: No string provided for decoding');
      return '';
    }

    // Check if the string is base64 encoded
    const base64Regex =
      /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;
    if (!base64Regex.test(encoded)) {
      this.error('driver.ts: Provided string is not base64 encoded');
      return encoded;
    }

    try {
      return Buffer.from(encoded, 'base64').toString('utf-8');
    } catch (e) {
      this.error(`driver.ts: Failed to decode base64 string: ${encoded}`, e);
      return encoded; // Return the original string if decoding fails
    }
  }

  private cleanString(input: string): string {
    // Regular expression to match escape characters and control characters.
    const escapeCharsRegex = /\\[\'\"\\nrtbfv0x0B\xFF]|[\x00-\x1F\x7F]/g;

    // Remove escape and control characters, and trim leading and trailing spaces in one step.
    return input.replace(escapeCharsRegex, '').trim();
  }

  private normalizeHostname(input: string): string {
    return input.trim().replace(/^https?:\/\//i, '').split('/')[0].trim();
  }

  /**
   * Safely calls an API method and returns a default value if it fails.
   * @param apiMethod - The API method to call.
   * @param defaultValue - The default value to return in case of failure.
   * @param methodName - The name of the API method for logging purposes.
   * @returns The result of the API method or the default value.
   */
  private async safeApiCall<T>(
    apiMethod: () => Promise<T>,
    defaultValue: T,
    methodName: string = 'API method',
  ): Promise<T> {
    try {
      return await apiMethod();
    } catch (e) {
      this.error(`Failed to retrieve ${methodName}`, e);
      return defaultValue;
    }
  }
}

export { TplinkDecoDriver };
module.exports = TplinkDecoDriver;
